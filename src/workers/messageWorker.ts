import { boss, QUEUE_NAME } from '../queue';
import { MessageJobData, ChatMessage, GhlChannel } from '../types';
import type { Opportunity } from '../services/ghl';
import { getClaudeResponse, splitMessage, AttachmentBlock } from '../services/claude';
import {
  sendMessage,
  fetchAsBase64,
  findContactOpportunity,
  createOpportunity,
  moveOpportunityToStage,
  updateContactName,
  updateContactCustomField,
  createNote,
  getContact,
  getContactTags,
  seedCustomFields,
} from '../services/ghl';
import {
  getFreeSlots,
  createAppointment,
  getCalendarAssignedUser,
  getContactAppointments,
  buscarCitasDelContacto,
  cancelarCita,
  addTagsToContact,
  FreeSlot,
  CitaFutura,
} from '../services/ghl-calendar';
import { transcribirAudio } from '../services/whisper';
import { db } from '../db/client';
import { getConfig } from '../config';
import { dentroDeHorario, fechaLocalDelSlot } from '../services/horario';
import {
  scheduleFollowUps,
  detectAttendanceConfirmation,
  cancelarFollowUpsPendientes,
} from '../services/follow-up';
import { contactoBloqueadoAsync } from '../blocklist';
import { pareceNombreReal } from '../nombres';

/**
 * Estado compartido entre las tools de UN mismo turno (un job del worker).
 *
 * Existe por el reagendamiento: `cancelar_cita` no recibe el id de la cita
 * (a propósito — el modelo podría inventarlo), así que necesita saber cuál
 * de las citas futuras del contacto acaba de crear `agendar_cita` en este
 * mismo turno para NO cancelar esa. Deducirlo por fecha de creación sería
 * frágil; el turno lo sabe con certeza.
 */
interface TurnContext {
  /** Cita creada por agendar_cita en este turno (reagendamiento en curso). */
  citaCreada?: { id: string; nombre: string };
  /**
   * Se prende cuando agendar_cita corrió con `es_reagendamiento: true` y se
   * apaga cuando cancelar_cita cancela la anterior. Si al terminar el turno
   * sigue prendida, el modelo prometió cancelar y no lo hizo: el código lo
   * ejecuta por él (ver enforceReagendamiento y la lección 30 de la skill).
   */
  reagendamientoPendiente?: { citaNuevaId: string; nombre: string };
  /**
   * Cómo se llama la tarjeta del pipeline si hay que CREARLA en este turno
   * (ver findOrCreateOpportunity). El nombre real del contacto o, si no se
   * sabe, su teléfono: con un literal tipo "Nuevo lead" el pipeline queda
   * lleno de tarjetas idénticas que hay que abrir una por una para saber
   * quién es quién.
   */
  leadLabel: string;
}

/**
 * Devuelve las opportunities del contacto en el pipeline y, si no tiene
 * ninguna, **crea una** en la etapa destino.
 *
 * GHL no las crea solo porque alguien escriba por WhatsApp (ver
 * createOpportunity): quien le escribe directo al número, en vez de entrar
 * por el Workflow del anuncio, no tiene tarjeta. Antes de esto el bot daba
 * por hecho que existía y todas las tools del pipeline fallaban con
 * `no_opportunity` para esos contactos.
 *
 * Best-effort: si la creación falla, devuelve lista vacía y el llamador
 * sigue su camino — mover de etapa nunca debe romper la conversación.
 */
async function findOrCreateOpportunity(
  contactId: string,
  pipelineId: string,
  targetStageId: string,
  locationId: string,
  leadLabel: string
): Promise<Opportunity[]> {
  const existing = await findContactOpportunity(contactId, pipelineId, locationId);
  if (existing.length > 0) return existing;

  try {
    const created = await createOpportunity({
      contactId,
      pipelineId,
      pipelineStageId: targetStageId,
      locationId,
      name: leadLabel,
    });
    console.log(
      `[pipeline] opportunity creada automáticamente | contact=${contactId} opp=${created.id} stage=${targetStageId}`
    );
    return [created];
  } catch (err) {
    console.warn(`[pipeline] createOpportunity falló | contact=${contactId}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Handler de tools — recibe el nombre de la tool que Claude llamó y el
 * contactId del mensaje en proceso (pasado via closure). Devuelve un string
 * (típicamente JSON) que Claude verá como tool_result.
 *
 * Por contrato: este handler NUNCA debe lanzar. Si algo falla, retorna un
 * JSON con `error` y un `message` legible para que el modelo decida cómo
 * reaccionar (típicamente "continúa la conversación normalmente").
 */
async function handleTool(
  name: string,
  input: Record<string, unknown>,
  contactId: string,
  turn: TurnContext
): Promise<string> {
  switch (name) {
    case 'mover_a_etapa':
      return handleMoverAEtapa(input, contactId, turn);
    case 'consultar_disponibilidad':
      return handleConsultarDisponibilidad(input, contactId);
    case 'agendar_cita':
      return handleAgendarCita(input, contactId, turn);
    case 'cliente_frecuente':
      return handleClienteFrecuente(contactId);
    case 'cancelar_cita':
      return handleCancelarCita(input, contactId, turn);
    case 'escalar_a_humano':
      return handleEscalarAHumano(input, contactId, turn);
    case 'actualizar_campo':
      return handleActualizarCampo(input, contactId);
  }
  console.warn(`[tool] No implementada: ${name} input=${JSON.stringify(input)}`);
  return JSON.stringify({ error: 'tool_not_implemented', tool: name });
}

/**
 * Mueve automáticamente la opportunity del contacto a la etapa indicada por
 * NOMBRE (buscada en bot.config.yaml). Llamada desde los handlers cuando
 * ocurre un evento que dispara movimiento (cita agendada, escalación, etc).
 *
 * Best-effort: si falla, sólo loguea — no rompe el flujo del bot.
 */
async function autoMoveStage(contactId: string, stageName: string, leadLabel: string): Promise<void> {
  const cfg = getConfig();
  if (!cfg.pipeline) return;

  const stage = cfg.pipeline.stages.find((s) => s.name === stageName);
  if (!stage) {
    console.warn(`[pipeline:auto] stage no configurada: "${stageName}"`);
    return;
  }

  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) return;

  try {
    const opps = await findOrCreateOpportunity(contactId, cfg.pipeline.id, stage.id, locationId, leadLabel);
    if (opps.length === 0) {
      console.warn(`[pipeline:auto] sin opportunity | contact=${contactId} → "${stageName}" (saltado)`);
      return;
    }
    const chosen = opps.length > 1
      ? [...opps].sort((a, b) => {
          const ka = a.updatedAt ?? a.createdAt ?? '';
          const kb = b.updatedAt ?? b.createdAt ?? '';
          return kb.localeCompare(ka);
        })[0]
      : opps[0];

    if (chosen.pipelineStageId === stage.id) {
      console.log(`[pipeline:auto] ya en "${stageName}" | contact=${contactId}`);
      return;
    }
    await moveOpportunityToStage(chosen.id, stage.id);
    console.log(`[pipeline:auto] movido | contact=${contactId} opp=${chosen.id} → "${stageName}"`);
  } catch (err) {
    console.warn(`[pipeline:auto] error | contact=${contactId} → "${stageName}": ${(err as Error).message}`);
  }
}

// ─── Calendar tools ──────────────────────────────────────────────────────────

/**
 * Determina qué agenda(s) consultar según el motivo y la preferencia explícita.
 * - agenda="any" o ausente → aplica routing por palabras clave del motivo,
 *   luego el default del routing.
 * - agenda="<key>" → solo esa.
 */
function resolveAgendas(motivo: string, agendaParam?: string): string[] {
  const cfg = getConfig();
  if (!cfg.calendars) return [];
  const allKeys = Object.keys(cfg.calendars.agendas);
  const validate = (keys: string[]): string[] =>
    keys.filter((k) => cfg.calendars!.agendas[k]);
  const fromRoute = (route: string | string[]): string[] => {
    if (Array.isArray(route)) return validate(route);
    if (route === 'any') return allKeys;
    return validate([route]);
  };

  if (agendaParam && agendaParam !== 'any' && cfg.calendars.agendas[agendaParam]) {
    return [agendaParam];
  }

  const lower = motivo.toLowerCase();
  for (const [keyword, route] of Object.entries(cfg.calendars.routing)) {
    if (keyword === 'default') continue;
    if (lower.includes(keyword)) {
      const resolved = fromRoute(route);
      if (resolved.length > 0) return resolved;
    }
  }

  const defaultRoute = cfg.calendars.routing.default ?? 'any';
  const resolved = fromRoute(defaultRoute);
  return resolved.length > 0 ? resolved : allKeys;
}

function extractHour(iso: string): number {
  const m = iso.match(/T(\d{2}):/);
  return m ? parseInt(m[1], 10) : -1;
}

function formatSlotHuman(iso: string, timezone: string): { fecha: string; hora: string } {
  const d = new Date(iso);
  const fecha = new Intl.DateTimeFormat('es', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(d);
  const hora = new Intl.DateTimeFormat('es', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
  return { fecha, hora };
}

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function resolveDuration(motivo: string): number {
  const cfg = getConfig();
  if (!cfg.calendars) return 30;
  const { durations, duration_minutes } = cfg.calendars;
  if (!durations) return duration_minutes;

  const motivoNorm = normalizar(motivo);
  const match = Object.keys(durations)
    .filter((k) => motivoNorm.includes(normalizar(k)))
    .sort((a, b) => b.length - a.length)[0];

  if (!match) return duration_minutes;
  console.log(`[duracion] motivo="${motivo}" → "${match}" = ${durations[match]} min`);
  return durations[match];
}

async function handleConsultarDisponibilidad(
  input: Record<string, unknown>,
  contactId: string
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.calendars) {
    return JSON.stringify({ error: 'calendars_not_configured' });
  }

  const motivo = typeof input.motivo === 'string' ? input.motivo : '';
  const agenda = typeof input.agenda === 'string' ? input.agenda : undefined;
  const desdeFecha = typeof input.desde_fecha === 'string' ? input.desde_fecha : undefined;
  const horario = typeof input.horario_preferido === 'string' ? input.horario_preferido : 'cualquiera';
  const cantidad = typeof input.cantidad === 'number' && input.cantidad > 0
    ? Math.min(input.cantidad, 10)
    : 4;

  const agendaKeys = resolveAgendas(motivo, agenda);
  if (agendaKeys.length === 0) {
    return JSON.stringify({ error: 'no_agendas_resolved', motivo });
  }

  // Rango: 7 días desde desdeFecha (o ahora). En timestamps ms para GHL.
  const start = desdeFecha
    ? new Date(`${desdeFecha}T00:00:00`)
    : new Date();
  if (isNaN(start.getTime())) {
    return JSON.stringify({ error: 'invalid_date', desde_fecha: desdeFecha });
  }
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Consulta en paralelo todos los calendarios resueltos.
  const allSlots: (FreeSlot & { agenda: string })[] = [];
  await Promise.all(
    agendaKeys.map(async (key) => {
      const ag = cfg.calendars!.agendas[key];
      try {
        const slots = await getFreeSlots(
          ag.calendar_id,
          start.getTime(),
          end.getTime(),
          cfg.calendars!.timezone
        );
        for (const s of slots) allSlots.push({ ...s, agenda: key });
      } catch (err) {
        console.warn(`[tool:consultar_disponibilidad] ${key} error: ${(err as Error).message}`);
      }
    })
  );

  // Filtro 1: horario REAL de atención del negocio (calendars.business_hours).
  // Va antes que cualquier otra cosa — un slot fuera de horario no existe,
  // aunque GHL lo devuelva libre. Se pasa la duración del tipo de cita para
  // que no se ofrezca un hueco donde la cita no cabe completa (un check up de
  // 45 min a las 12:30 termina 13:15, y a la 13:00 se cierra).
  const duracion = resolveDuration(motivo);
  const enHorario = allSlots.filter((s) => dentroDeHorario(s.iso, cfg.calendars!, duracion));
  const descartados = allSlots.length - enHorario.length;
  if (descartados > 0) {
    console.log(
      `[tool:consultar_disponibilidad] ${descartados} slot(s) descartados: fuera de business_hours ` +
        `o sin espacio para ${duracion} min`
    );
  }

  // Filtro 2: nunca ofrecer un día ANTERIOR al que pidió el modelo.
  //
  // El rango que se le manda a GHL se arma con `new Date("YYYY-MM-DDT00:00:00")`,
  // que JavaScript interpreta en la zona del SERVIDOR. En Railway eso es UTC,
  // o sea las 5 de la tarde del día anterior en Ensenada — y GHL devolvía
  // slots de esa tarde. Si el contacto pidió "a partir del martes", verse
  // ofrecer el lunes en la tarde se lee como que no se le entendió.
  const antesDeFecha = desdeFecha
    ? enHorario.filter((s) => {
        const fecha = fechaLocalDelSlot(s.iso, cfg.calendars!.timezone);
        return fecha !== null && fecha < desdeFecha;
      }).length
    : 0;
  const desdeElDiaPedido = desdeFecha
    ? enHorario.filter((s) => {
        const fecha = fechaLocalDelSlot(s.iso, cfg.calendars!.timezone);
        return fecha !== null && fecha >= desdeFecha;
      })
    : enHorario;
  if (antesDeFecha > 0) {
    console.log(
      `[tool:consultar_disponibilidad] ${antesDeFecha} slot(s) descartados por ser anteriores a ${desdeFecha}`
    );
  }

  // Filtro 3: horario_preferido (mañana < 12, tarde >= 14, cualquiera = todo).
  const filtered = desdeElDiaPedido.filter((s) => {
    const h = extractHour(s.iso);
    if (horario === 'mañana') return h < 12;
    if (horario === 'tarde') return h >= 14;
    return true;
  });

  // Orden cronológico + dedup por iso (por si dos agendas comparten un slot).
  const seen = new Set<string>();
  const unique = filtered
    .sort((a, b) => a.iso.localeCompare(b.iso))
    .filter((s) => {
      if (seen.has(s.iso)) return false;
      seen.add(s.iso);
      return true;
    })
    .slice(0, cantidad);

  if (unique.length === 0) {
    return JSON.stringify({
      ok: true,
      slots: [],
      message: 'No hay disponibilidad en el rango consultado. Sugiere otro día o pregunta por otra preferencia.',
    });
  }

  const formatted = unique.map((s) => {
    const human = formatSlotHuman(s.iso, cfg.calendars!.timezone);
    const ag = cfg.calendars!.agendas[s.agenda];
    return {
      slot_iso: s.iso,
      agenda: s.agenda,
      agenda_nombre: ag.name,
      fecha: human.fecha,
      hora: human.hora,
    };
  });

  console.log(`[tool:consultar_disponibilidad] motivo="${motivo}" agendas=[${agendaKeys.join(',')}] returned=${formatted.length}`);
  return JSON.stringify({ ok: true, slots: formatted, ...(await citasPropiasDelContacto(contactId)) });
}

/**
 * Bloque que se anexa a TODA respuesta de consultar_disponibilidad: las citas
 * que este mismo contacto ya tiene apartadas.
 *
 * Es el guard de auto-conflicto. Sin esto, el horario que el bot acaba de
 * apartarle a un contacto deja de aparecer en `slots` (porque está ocupado)
 * y el modelo concluye que "ya no está disponible" — y se lo retracta al
 * contacto que ya lo tenía confirmado. Pasó el 14/09/2026 a las 22:05: la
 * contacto tenía las 10:00am desde las 20:46 y el bot se las quitó porque
 * él mismo las había ocupado.
 *
 * Best-effort: si GHL falla, se devuelve {} y la disponibilidad sale igual.
 */
async function citasPropiasDelContacto(
  contactId: string
): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  if (!cfg.calendars) return {};

  try {
    const calendarIds = Object.values(cfg.calendars.agendas).map((a) => a.calendar_id);
    const propias = await buscarCitasDelContacto(contactId, calendarIds);
    if (propias.length === 0) return {};

    return {
      citas_que_este_contacto_YA_tiene: propias.map((c) => {
        const h = formatSlotHuman(c.startTime, cfg.calendars!.timezone);
        return { fecha: h.fecha, hora: h.hora, a_nombre_de: nombreDelTitulo(c.title) };
      }),
      aviso_importante:
        'Estos horarios NO aparecen en `slots` precisamente porque ya están ocupados ' +
        'POR ESTE MISMO CONTACTO — los apartaste tú. Son suyos. NUNCA le digas que su ' +
        'horario "ya no está disponible" ni le ofrezcas moverse de hora: solo cambia su ' +
        'cita si él lo pide explícitamente. Si el horario que ibas a confirmarle es uno ' +
        'de estos, confírmaselo con toda normalidad.',
    };
  } catch (err) {
    console.warn(`[tool:consultar_disponibilidad] citas propias falló: ${(err as Error).message}`);
    return {};
  }
}

async function handleAgendarCita(
  input: Record<string, unknown>,
  contactId: string,
  turn: TurnContext
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.calendars) {
    return JSON.stringify({ error: 'calendars_not_configured' });
  }

  const slotIso = typeof input.slot_iso === 'string' ? input.slot_iso : '';
  const agenda = typeof input.agenda === 'string' ? input.agenda : '';
  const nombreCompleto = typeof input.nombre_completo === 'string' ? input.nombre_completo.trim() : '';
  const motivo = typeof input.motivo === 'string' ? input.motivo : 'Cita';
  const esReagendamiento = input.es_reagendamiento === true;

  if (!slotIso || !agenda || !nombreCompleto) {
    return JSON.stringify({
      error: 'missing_params',
      message: 'Faltan datos obligatorios: slot_iso, agenda o nombre_completo.',
    });
  }

  const ag = cfg.calendars.agendas[agenda];
  if (!ag) {
    return JSON.stringify({ error: 'invalid_agenda', agenda });
  }

  // Límite de negocio OPCIONAL (calendars.max_active_appointments): si está
  // configurado, la 2da+ cita debe ser a nombre de una persona distinta a la
  // anterior (ej. un familiar agendando desde el mismo número).
  const maxConfigurado = cfg.calendars.max_active_appointments;
  let activas: Awaited<ReturnType<typeof getContactAppointments>> = [];
  if (maxConfigurado) {
    const existentes = await getContactAppointments(contactId);
    const now = Date.now();
    activas = existentes.filter((a) => {
      const t = new Date(a.startTime).getTime();
      const cancelada = (a.appointmentStatus ?? '').toLowerCase().includes('cancel');
      return !isNaN(t) && t > now && !cancelada;
    });

    // En un reagendamiento la cita vieja sigue viva unos segundos (se cancela
    // justo después con cancelar_cita), así que se tolera una cita activa de más.
    const maxActivas = esReagendamiento ? maxConfigurado + 1 : maxConfigurado;
    if (activas.length >= maxActivas) {
      return JSON.stringify({
        error: 'limite_de_citas',
        message:
          `Este contacto ya tiene ${maxConfigurado} cita(s) activa(s) agendada(s) — es el máximo permitido por este medio. ` +
          'Explícale con calidez que ya tiene el máximo de citas apartadas, y que si necesita una adicional debe ' +
          'contactar directamente al negocio.',
      });
    }

    // El guard de nombre duplicado existe para que un contacto no agende dos
    // veces a la misma persona sin darse cuenta. En un reagendamiento SÍ queremos
    // la segunda cita con el mismo nombre (es la misma persona moviéndose de día),
    // así que ahí se salta — sin esto el reagendamiento sería imposible.
    if (activas.length >= 1 && !esReagendamiento) {
      const nombreExistente = (activas[activas.length - 1].title ?? '').split(' - ')[0].trim().toLowerCase();
      if (nombreExistente && nombreExistente === nombreCompleto.toLowerCase()) {
        return JSON.stringify({
          error: 'nombre_duplicado',
          message:
            `Este contacto ya tiene una cita agendada a nombre de "${activas[activas.length - 1].title?.split(' - ')[0]}". ` +
            'Si esta nueva cita es para la MISMA persona, dile que ya tiene una cita agendada y pregúntale ' +
            'si prefiere reagendar esa en vez de crear otra. Si es para una persona DISTINTA (ej. un ' +
            'familiar), pídele el nombre completo de esa otra persona y vuelve a llamar agendar_cita con ese nombre.',
        });
      }
    }
  }

  // endTime = startTime + la duración que corresponda al tipo de cita
  const start = new Date(slotIso);
  if (isNaN(start.getTime())) {
    return JSON.stringify({ error: 'invalid_slot_iso', slot_iso: slotIso });
  }

  // Última red de seguridad: aunque consultar_disponibilidad ya filtra por
  // business_hours, el modelo podría llegar aquí con un horario viejo o
  // inventado. Una cita fuera del horario de atención no se crea nunca, y
  // tampoco una que empiece dentro pero termine después del cierre.
  const duracionMinutos = resolveDuration(motivo);
  if (!dentroDeHorario(slotIso, cfg.calendars, duracionMinutos)) {
    const humanFuera = formatSlotHuman(slotIso, cfg.calendars.timezone);
    console.warn(
      `[tool:agendar_cita] BLOQUEADA por business_hours | contact=${contactId} slot=${slotIso}`
    );
    return JSON.stringify({
      error: 'fuera_de_horario',
      message:
        `${humanFuera.fecha} a las ${humanFuera.hora} no sirve para una cita de ${duracionMinutos} minutos: ` +
        'o está fuera del horario de atención, o la cita terminaría después del cierre. ' +
        'No le digas al contacto que el horario "ya se ocupó" (nunca existió): llama consultar_disponibilidad y ' +
        'ofrécele dos horarios reales de los que te devuelva.',
    });
  }

  const end = new Date(start.getTime() + duracionMinutos * 60 * 1000);

  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) {
    return JSON.stringify({ error: 'config_error', message: 'GHL_LOCATION_ID no configurado' });
  }

  // Actualiza el nombre del contacto si todavía no tiene uno, o si el que
  // tiene no es un nombre de verdad (ver pareceNombreReal: típicamente los
  // emojis que WhatsApp copia del perfil). Cuando YA hay un nombre humano no
  // se toca, para no pisar la identidad original si una 2da cita es de otra
  // persona (ej. un familiar agendado desde el mismo número de WhatsApp).
  //
  // El guard anterior era `if (!contacto?.firstName)` y NUNCA entraba: GHL
  // llena ese campo con el nombre de perfil de WhatsApp para todos los leads
  // que entran por ahí, así que el nombre real que el contacto dio en la
  // conversación no llegaba jamás a la ficha — ni a las plantillas que la
  // leen.
  try {
    const contacto = await getContact(contactId);
    if (!pareceNombreReal(contacto?.firstName)) {
      await updateContactName(contactId, nombreCompleto);
    }
  } catch (err) {
    console.warn(`[tool:agendar_cita] getContact/updateContactName failed: ${(err as Error).message}`);
  }

  try {
    // GHL exige a quién se asigna la cita cuando se crea con
    // ignoreFreeSlotValidation (ver createAppointment). Se toma del yaml si
    // está, y si no se deduce del propio calendario una sola vez.
    const assignedUserId =
      ag.assigned_user_id ?? (await getCalendarAssignedUser(ag.calendar_id)) ?? undefined;

    const created = await createAppointment({
      calendarId: ag.calendar_id,
      locationId,
      contactId,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      title: `${nombreCompleto} - ${motivo}`,
      assignedUserId,
    });

    const human = formatSlotHuman(slotIso, cfg.calendars.timezone);

    // Nota informativa para el equipo, con los datos completos de la cita.
    await createNote(
      contactId,
      `📅 Nueva cita agendada por ${cfg.bot.name}\n` +
        `Contacto: ${nombreCompleto}\n` +
        `Motivo: ${motivo}\n` +
        `Agenda: ${ag.name}\n` +
        `Fecha: ${human.fecha} ${human.hora}`
    ).catch((err) => console.warn(`[tool:agendar_cita] note failed: ${(err as Error).message}`));

    // Si hay detail_field_id configurado: campo con el detalle completo,
    // listo para insertar como merge field en un Workflow de notificación
    // al equipo (ej. WhatsApp/push al dueño del negocio).
    if (cfg.calendars.detail_field_id) {
      await updateContactCustomField(
        contactId,
        cfg.calendars.detail_field_id,
        `Contacto: ${nombreCompleto} | Motivo: ${motivo} | Agenda: ${ag.name} | Fecha: ${human.fecha} ${human.hora}`
      ).catch((err) => console.warn(`[tool:agendar_cita] detail_field_id failed: ${(err as Error).message}`));
    }

    // Si hay reminder_date_field_id configurado: SOLO la fecha legible
    // ("martes 8 de septiembre a las 4:00 p. m."), para el merge field de la
    // plantilla de recordatorio que le llega al CONTACTO.
    //
    // Existe porque el Workflow de recordatorio suele dispararse por tag, y en
    // ese contexto los tokens {{appointment.*}} de GHL vienen vacíos: a
    // contactos reales les llegó "te recordamos tu cita mañana  a las .". Este
    // campo no depende del trigger, así que la plantilla siempre tiene la fecha.
    if (cfg.calendars.reminder_date_field_id) {
      await updateContactCustomField(
        contactId,
        cfg.calendars.reminder_date_field_id,
        `${human.fecha.replace(/,/g, '')} a las ${human.hora}`
      ).catch((err) =>
        console.warn(`[tool:agendar_cita] reminder_date_field_id failed: ${(err as Error).message}`)
      );
    }

    // Si hay notify_tag configurado: tag para que un Workflow de GHL
    // notifique al equipo (Internal Notification, no SMS).
    if (cfg.calendars.notify_tag) {
      await addTagsToContact(contactId, [cfg.calendars.notify_tag]).catch((err) =>
        console.warn(`[tool:agendar_cita] notify_tag failed: ${(err as Error).message}`)
      );
    }

    // Auto-mueve la opportunity a la etapa configurada (best-effort).
    if (cfg.calendars.booked_stage) {
      autoMoveStage(contactId, cfg.calendars.booked_stage, turn.leadLabel).catch(() => {});
    }

    // Ya tiene cita — cancela cualquier follow-up/marca-perdido que hubiera
    // quedado pendiente de antes de agendar.
    cancelarFollowUpsPendientes(contactId).catch(() => {});

    // Deja rastro para cancelar_cita en este mismo turno: sin esto no sabría
    // cuál de las citas futuras es la recién creada (y podría cancelarla).
    turn.citaCreada = { id: created.id, nombre: nombreCompleto };

    // El modelo pidió saltarse el guard de nombre duplicado prometiendo que
    // iba a cancelar la cita anterior. Queda anotado: si al cerrar el turno
    // no lo hizo, enforceReagendamiento la cancela por él.
    if (esReagendamiento) {
      turn.reagendamientoPendiente = { citaNuevaId: created.id, nombre: nombreCompleto };
    }

    console.log(
      `[tool:agendar_cita] OK | contact=${contactId} appt=${created.id} agenda=${agenda} ` +
        `${slotIso}${esReagendamiento ? ' (reagendamiento)' : ''}`
    );
    return JSON.stringify({
      ok: true,
      appointment_id: created.id,
      agenda: ag.name,
      fecha_humana: human.fecha,
      hora_humana: human.hora,
    });
  } catch (err) {
    // Aquí NO se le ofrece otro horario, y esa es la lección más cara de
    // este bot.
    //
    // Si la creación falla, la causa casi nunca es ese horario en
    // particular: la disponibilidad ya se verificó dos veces antes de llegar
    // aquí (dentroDeHorario y bloqueLibre contra los free-slots reales). Lo
    // que falla es la creación EN SÍ, y eso va a volver a fallar con el
    // horario siguiente, y con el siguiente.
    //
    // Fue exactamente lo que pasó: GHL rechazaba toda cita de 45 o 60
    // minutos, el bot lo leía como "se ocupó" y ofrecía otro horario. Seis
    // veces seguidas con la misma paciente, que ya había pagado el anticipo.
    // Cero citas creadas en toda la cuenta.
    //
    // Así que un fallo al crear pasa la conversación a una persona, en
    // código y sin depender del criterio del modelo.
    console.error(
      `[tool:agendar_cita] FALLO AL CREAR — se escala | contact=${contactId} slot=${slotIso} ` +
        `duracion=${duracionMinutos} motivo="${motivo}": ${(err as Error).message}`
    );

    await handleEscalarAHumano(
      {
        motivo_escalacion:
          `No se pudo crear la cita de ${nombreCompleto} (${motivo}) para el ` +
          `${formatSlotHuman(slotIso, cfg.calendars.timezone).fecha} a las ` +
          `${formatSlotHuman(slotIso, cfg.calendars.timezone).hora}. Hay que agendarla a mano y ` +
          `confirmarle al contacto.`,
      },
      contactId,
      turn
    ).catch(() => {});

    return JSON.stringify({
      error: 'no_se_pudo_agendar',
      message:
        'No se pudo crear la cita y el equipo ya quedó avisado para agendarla a mano. ' +
        'NO le ofrezcas otro horario, NO vuelvas a llamar consultar_disponibilidad y NO le digas ' +
        'que ese espacio se ocupó: el horario que eligió sigue siendo el suyo. ' +
        'Contéstale UNA sola frase cálida diciéndole que su cita queda apartada para ese día y esa ' +
        'hora, y que en un momento una persona del consultorio se la confirma por aquí. ' +
        'Nunca menciones un problema técnico ni que algo falló.',
    });
  }
}

/**
 * Hace cumplir la promesa de `es_reagendamiento: true`.
 *
 * `agendar_cita` deja crear una 2da cita con el mismo nombre SOLO porque el
 * modelo se comprometió a cancelar la anterior de inmediato con cancelar_cita.
 * Si el turno termina y no lo hizo, esa promesa la ejecuta el código: el
 * contacto no puede quedarse con dos citas el mismo día porque el modelo se
 * distrajo (bug del 14/09/2026).
 *
 * Solo cancela cuando NO hay ambigüedad (una sola cita anterior candidata).
 * Si hay varias, no adivina: deja nota en GHL para que el equipo lo resuelva.
 */
async function enforceReagendamiento(contactId: string, turn: TurnContext): Promise<void> {
  const pendiente = turn.reagendamientoPendiente;
  if (!pendiente) return;

  const cfg = getConfig();
  if (!cfg.calendars) return;

  try {
    const calendarIds = Object.values(cfg.calendars.agendas).map((a) => a.calendar_id);
    const futuras = await buscarCitasDelContacto(contactId, calendarIds);
    const anteriores = futuras.filter((c) => c.id !== pendiente.citaNuevaId);

    if (anteriores.length === 0) {
      console.log(`[reagendamiento] nada que cancelar | contact=${contactId}`);
      return;
    }

    // Misma preferencia que handleCancelarCita: las del mismo nombre primero.
    const mismoNombre = anteriores.filter(
      (c) => nombreDelTitulo(c.title) === pendiente.nombre.toLowerCase()
    );
    const candidatas = mismoNombre.length > 0 ? mismoNombre : anteriores;

    if (candidatas.length > 1) {
      console.error(
        `[reagendamiento] INCUMPLIDO y ambiguo (${candidatas.length} citas) | contact=${contactId} — no se cancela nada`
      );
      await createNote(
        contactId,
        `⚠️ Reagendamiento sin cerrar\n` +
          `${cfg.bot.name} agendó una cita nueva como reagendamiento pero no canceló la anterior, ` +
          `y hay ${candidatas.length} citas candidatas. Revisen cuál sobra:\n` +
          candidatas
            .map((c) => {
              const h = formatSlotHuman(c.startTime, cfg.calendars!.timezone);
              return `- ${h.fecha} ${h.hora} (${c.title ?? 'sin título'})`;
            })
            .join('\n')
      ).catch(() => {});
      return;
    }

    const target = candidatas[0];
    await cancelarCita(target.id);
    const h = formatSlotHuman(target.startTime, cfg.calendars.timezone);
    console.warn(
      `[reagendamiento] el modelo no llamó cancelar_cita — cancelada por código | ` +
        `contact=${contactId} appt=${target.id} ${target.startTime}`
    );
    await createNote(
      contactId,
      `❌ Cita anterior cancelada automáticamente\n` +
        `Cita: ${h.fecha} ${h.hora}\n` +
        `Motivo: reagendamiento — ${cfg.bot.name} creó la cita nueva y no cerró la anterior.`
    ).catch(() => {});
  } catch (err) {
    console.error(`[reagendamiento] enforce falló | contact=${contactId}: ${(err as Error).message}`);
  } finally {
    turn.reagendamientoPendiente = undefined;
  }
}

async function handleClienteFrecuente(contactId: string): Promise<string> {
  const appts = await getContactAppointments(contactId);

  // Solo cuentan appointments pasadas (no futuras ni slots bloqueados).
  const now = Date.now();
  const past = appts.filter((a) => {
    const t = new Date(a.startTime).getTime();
    return !isNaN(t) && t < now;
  });

  const lastDate = past
    .map((a) => a.startTime)
    .sort()
    .reverse()[0];

  return JSON.stringify({
    ok: true,
    es_recurrente: past.length > 0,
    total_citas_pasadas: past.length,
    ultima_cita: lastDate ?? null,
  });
}

/** Fecha local (YYYY-MM-DD) de un instante ISO en la timezone del negocio. */
function fechaLocal(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** Nombre del contacto tal como lo guarda agendar_cita en el título ("Nombre - motivo"). */
function nombreDelTitulo(title?: string): string {
  return (title ?? '').split(' - ')[0].trim().toLowerCase();
}

function describirCita(c: CitaFutura, timezone: string) {
  const human = formatSlotHuman(c.startTime, timezone);
  return {
    fecha: human.fecha,
    hora: human.hora,
    fecha_cita: fechaLocal(c.startTime, timezone),
    a_nombre_de: c.title?.split(' - ')[0]?.trim() ?? null,
  };
}

/**
 * Cancela una cita futura del contacto — cambio de status a "cancelled" en
 * GHL, nunca borrado del evento (ver `cancelarCita` en ghl-calendar.ts).
 *
 * El modelo NO elige el appointment_id (podría inventarlo). El handler lo
 * resuelve así:
 *
 *   - Sin citas futuras → no_upcoming_appointment.
 *   - REAGENDAMIENTO (agendar_cita corrió en este mismo turno): se excluye la
 *     cita recién creada y se cancela la anterior. Si hay más de una anterior,
 *     se prefiere la que está a nombre de la misma persona que la nueva — el
 *     bot permite 2 citas activas de personas DISTINTAS (ej. un familiar
 *     agendando desde el mismo WhatsApp), y cancelar "la más próxima" a ciegas
 *     le tumbaría la cita al otro contacto.
 *   - CANCELACIÓN SIMPLE con 1 cita futura → esa.
 *   - CANCELACIÓN SIMPLE con 2+ → NO adivina: devuelve la lista con fechas
 *     para que el modelo le pregunte al contacto cuál y vuelva a llamar con
 *     `fecha_cita`.
 *
 * Nunca lanza: todo error sale como JSON con `error` + `message`.
 */
export async function handleCancelarCita(  // exportada solo para pruebas
  input: Record<string, unknown>,
  contactId: string,
  turn: TurnContext
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.calendars) {
    return JSON.stringify({ error: 'calendar_not_configured' });
  }

  const timezone = cfg.calendars.timezone;
  const motivo = typeof input.motivo === 'string' ? input.motivo.trim() : '';
  const fechaCita = typeof input.fecha_cita === 'string' ? input.fecha_cita.trim() : '';

  // Solo los calendarios que este bot administra — nunca tocamos citas de
  // otros calendarios de la location.
  const calendarIds = Object.values(cfg.calendars.agendas).map((a) => a.calendar_id);

  const futuras = await buscarCitasDelContacto(contactId, calendarIds);

  if (futuras.length === 0) {
    console.log(`[tool:cancelar_cita] sin citas futuras | contact=${contactId}`);
    return JSON.stringify({
      error: 'no_upcoming_appointment',
      message:
        'El contacto no tiene citas próximas. Díselo con calidez y ofrece agendarle una.',
    });
  }

  let candidatas = futuras;
  let creada: CitaFutura | undefined;

  if (turn.citaCreada) {
    // Reagendamiento: la cita nueva de este turno es intocable.
    creada = futuras.find((c) => c.id === turn.citaCreada!.id);
    const anteriores = futuras.filter((c) => c.id !== turn.citaCreada!.id);

    if (anteriores.length === 0) {
      console.log(`[tool:cancelar_cita] solo existe la cita nueva | contact=${contactId}`);
      return JSON.stringify({
        error: 'no_previous_appointment',
        message:
          'El contacto no tenía otra cita futura además de la que acabas de agendarle, ' +
          'así que no hay nada que cancelar. Confírmale su nueva cita normalmente.',
      });
    }

    const mismoNombre = anteriores.filter(
      (c) => nombreDelTitulo(c.title) === turn.citaCreada!.nombre.toLowerCase()
    );
    candidatas = mismoNombre.length > 0 ? mismoNombre : anteriores;
  }

  // Desambiguación explícita del modelo (segunda pasada, después de preguntarle
  // al contacto). Una fecha equivocada no cancela nada — no puede alucinar un id.
  if (fechaCita) {
    const porFecha = candidatas.filter((c) => fechaLocal(c.startTime, timezone) === fechaCita);
    if (porFecha.length === 0) {
      return JSON.stringify({
        error: 'no_match',
        message: `Ninguna cita próxima del contacto cae en ${fechaCita}. Revisa las opciones y vuelve a intentar.`,
        citas: candidatas.map((c) => describirCita(c, timezone)),
      });
    }
    candidatas = porFecha;
  }

  if (candidatas.length > 1) {
    console.log(
      `[tool:cancelar_cita] ambigua (${candidatas.length} citas) | contact=${contactId}`
    );
    return JSON.stringify({
      error: 'multiple_appointments',
      message:
        'El contacto tiene más de una cita próxima y no queda claro cuál cancelar. ' +
        'Pregúntale con calidez cuál de estas quiere cancelar y vuelve a llamar ' +
        'cancelar_cita con el fecha_cita correspondiente. No canceles ninguna por tu cuenta.',
      citas: candidatas.map((c) => describirCita(c, timezone)),
    });
  }

  const target = candidatas[0];
  const desc = describirCita(target, timezone);

  try {
    await cancelarCita(target.id);
    // Promesa cumplida: ya no hace falta que el código cancele nada.
    turn.reagendamientoPendiente = undefined;
  } catch (err) {
    console.error(`[tool:cancelar_cita] API error: ${(err as Error).message}`);
    return JSON.stringify({
      error: 'api_error',
      message:
        'No se pudo cancelar. Dile al contacto que el equipo lo hará manualmente y no se preocupe.',
    });
  }

  // Si NO fue reagendamiento, la fecha del recordatorio ya no aplica: se limpia
  // para que ninguna plantilla salga con una cita que ya no existe. En un
  // reagendamiento no se toca — agendar_cita ya escribió la fecha nueva.
  if (!creada && cfg.calendars?.reminder_date_field_id) {
    await updateContactCustomField(contactId, cfg.calendars.reminder_date_field_id, '').catch((err) =>
      console.warn(`[tool:cancelar_cita] reminder_date_field_id failed: ${(err as Error).message}`)
    );
  }

  // Nota para el equipo (best-effort — que falle no invalida la cancelación).
  await createNote(
    contactId,
    `❌ Cita cancelada por ${cfg.bot.name}\n` +
      `Cita: ${desc.fecha} ${desc.hora}${desc.a_nombre_de ? ` (${desc.a_nombre_de})` : ''}\n` +
      `Motivo: ${motivo || 'no especificado'}` +
      (creada
        ? `\nReagendada a: ${formatSlotHuman(creada.startTime, timezone).fecha} ` +
          `${formatSlotHuman(creada.startTime, timezone).hora}`
        : '')
  ).catch((err) => console.warn(`[tool:cancelar_cita] note failed: ${(err as Error).message}`));

  console.log(
    `[tool:cancelar_cita] OK | contact=${contactId} appt=${target.id} ${target.startTime}` +
      (creada ? ` (reagendada a ${creada.startTime})` : '')
  );

  const kept = creada ?? null;
  return JSON.stringify({
    ok: true,
    cancelled_start: target.startTime,
    cancelled_fecha: desc.fecha,
    cancelled_hora: desc.hora,
    ...(kept
      ? {
          kept_start: kept.startTime,
          kept_fecha: formatSlotHuman(kept.startTime, timezone).fecha,
          kept_hora: formatSlotHuman(kept.startTime, timezone).hora,
        }
      : {}),
    message: kept
      ? 'Cita anterior cancelada. Confírmale al contacto en UN solo mensaje la nueva fecha y que la anterior quedó cancelada.'
      : 'Cita cancelada. Confírmaselo con calidez y déjale la puerta abierta para retomarla.',
  });
}

async function handleEscalarAHumano(
  input: Record<string, unknown>,
  contactId: string,
  turn: TurnContext
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.escalation) {
    return JSON.stringify({ error: 'escalation_not_configured' });
  }

  const motivoEscalacion = typeof input.motivo_escalacion === 'string'
    ? input.motivo_escalacion
    : 'sin motivo especificado';

  // Tag extra por categoría (escalation.category_tags). Una categoría fuera
  // del enum no debería llegar (el SDK valida), pero si llega no se inventa
  // un tag: se escala solo con el general.
  const categoria = typeof input.categoria === 'string' ? input.categoria : undefined;
  const tagCategoria = categoria ? cfg.escalation.category_tags?.[categoria] : undefined;
  const tags = tagCategoria ? [cfg.escalation.tag, tagCategoria] : [cfg.escalation.tag];

  try {
    await addTagsToContact(contactId, tags);
    await createNote(
      contactId,
      `[ESCALACIÓN AUTOMÁTICA] El bot identificó que este contacto necesita atención humana. ` +
        `${categoria ? `Categoría: ${categoria}. ` : ''}Motivo: ${motivoEscalacion}`
    );
    // Auto-mueve la opportunity a la etapa configurada (best-effort).
    const etapaEscalacion =
      (categoria ? cfg.escalation.category_stages?.[categoria] : undefined) ?? cfg.escalation.stage;
    if (etapaEscalacion) {
      autoMoveStage(contactId, etapaEscalacion, turn.leadLabel).catch(() => {});
    }
    // Ya lo tiene un humano — cancela follow-ups/marca-perdido pendientes.
    cancelarFollowUpsPendientes(contactId).catch(() => {});
    console.log(`[tool:escalar_a_humano] OK | contact=${contactId} tags=[${tags.join(',')}] motivo="${motivoEscalacion}"`);
    return JSON.stringify({ ok: true });
  } catch (err) {
    console.error(`[tool:escalar_a_humano] error: ${(err as Error).message}`);
    return JSON.stringify({
      error: 'api_error',
      message: 'No se pudo notificar al equipo automáticamente. Continúa la conversación con calidez.',
    });
  }
}

/**
 * Guarda un valor en un campo personalizado del contacto.
 *
 * Defensas:
 *   - El SDK ya validó que `campo` está en el enum del input_schema.
 *   - Re-validamos contra el yaml por si cambió en runtime.
 *   - Best-effort: si la API de GHL falla, el modelo recibe un error string
 *     y sigue conversando sin mencionarlo.
 */
async function handleActualizarCampo(
  input: Record<string, unknown>,
  contactId: string
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.custom_fields) {
    // Defensa: la tool no debería estar registrada si no hay custom_fields.
    return JSON.stringify({ error: 'custom_fields_not_configured' });
  }

  const campo = typeof input.campo === 'string' ? input.campo : '';
  const valor = typeof input.valor === 'string' ? input.valor.trim() : '';

  const field = cfg.custom_fields.fields.find((f) => f.name === campo);
  if (!field) {
    console.warn(`[tool:actualizar_campo] campo inválido: "${campo}"`);
    return JSON.stringify({
      error: 'invalid_field',
      message: `Campo "${campo}" no existe. Válidos: ${cfg.custom_fields.fields.map((f) => f.name).join(', ')}`,
    });
  }
  if (!valor) {
    return JSON.stringify({ error: 'empty_value', message: 'El valor no puede estar vacío.' });
  }

  try {
    await updateContactCustomField(contactId, field.id, valor);
    console.log(`[tool:actualizar_campo] OK | contact=${contactId} campo="${campo}" valor="${valor.slice(0, 60)}"`);
    return JSON.stringify({ ok: true, campo, valor });
  } catch (err) {
    console.error(`[tool:actualizar_campo] API error: ${(err as Error).message}`);
    return JSON.stringify({
      error: 'api_error',
      message: 'No se pudo guardar el campo. Continúa la conversación normalmente.',
    });
  }
}

/**
 * Mueve la opportunity activa del contacto a la etapa que pidió el modelo.
 *
 * Defensas:
 *   - El SDK ya validó que `etapa` está en el enum del input_schema.
 *   - Re-validamos contra el yaml por si el yaml cambió en runtime.
 *   - Si no hay opportunity en el pipeline, devolvemos un error que le dice
 *     al modelo que siga conversando sin mencionarlo.
 *   - Idempotencia: si la opp ya está en la etapa target, no llamamos PUT.
 *   - Si hay múltiples opportunities en el pipeline (raro), movemos la más
 *     reciente y logueamos warning con todos los IDs.
 */
async function handleMoverAEtapa(
  input: Record<string, unknown>,
  contactId: string,
  turn: TurnContext
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.pipeline) {
    // Defensa: la tool no debería estar registrada si no hay pipeline.
    return JSON.stringify({ error: 'pipeline_not_configured' });
  }

  const etapa = typeof input.etapa === 'string' ? input.etapa : '';
  const target = cfg.pipeline.stages.find((s) => s.name === etapa);
  if (!target) {
    console.warn(`[tool:mover_a_etapa] etapa inválida: "${etapa}"`);
    return JSON.stringify({
      error: 'invalid_stage',
      message: `Etapa "${etapa}" no existe. Válidas: ${cfg.pipeline.stages.map((s) => s.name).join(', ')}`,
    });
  }

  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) {
    console.error('[tool:mover_a_etapa] falta GHL_LOCATION_ID en env');
    return JSON.stringify({ error: 'config_error', message: 'GHL_LOCATION_ID no configurado' });
  }

  const opps = await findOrCreateOpportunity(contactId, cfg.pipeline.id, target.id, locationId, turn.leadLabel);

  if (opps.length === 0) {
    console.warn(`[tool:mover_a_etapa] sin opportunity | contact=${contactId} pipeline=${cfg.pipeline.id}`);
    return JSON.stringify({
      error: 'no_opportunity',
      message:
        `El contacto no tiene oportunidad activa en el pipeline "${cfg.pipeline.name}". ` +
        `Continúa la conversación normalmente sin mencionar este error.`,
    });
  }

  let chosen = opps[0];
  if (opps.length > 1) {
    chosen = [...opps].sort((a, b) => {
      const ka = a.updatedAt ?? a.createdAt ?? '';
      const kb = b.updatedAt ?? b.createdAt ?? '';
      return kb.localeCompare(ka);
    })[0];
    console.warn(
      `[tool:mover_a_etapa] múltiples opps (${opps.length}) | contact=${contactId} ` +
        `ids=[${opps.map((o) => o.id).join(',')}] usando más reciente=${chosen.id}`
    );
  }

  if (chosen.pipelineStageId === target.id) {
    console.log(`[tool:mover_a_etapa] ya en "${target.name}" | opp=${chosen.id}`);
    return JSON.stringify({ ok: true, already_in_stage: true, stage: target.name });
  }

  // Nunca mover hacia atrás a una etapa MANUAL (las que el modelo puede
  // elegir libremente) a un contacto que ya está en una etapa AUTO (las que
  // solo mueve el código, ej. al agendar o escalar — `when: "AUTO: ..."` en
  // bot.config.yaml). Evita que el bot "retroceda" el pipeline solo porque
  // el contacto le sigue escribiendo después de haber cerrado el ciclo.
  const etapaActual = cfg.pipeline.stages.find((s) => s.id === chosen.pipelineStageId);
  const esAuto = (s?: { when: string }) => s?.when.trim().toUpperCase().startsWith('AUTO');
  if (esAuto(etapaActual) && !esAuto(target)) {
    console.log(
      `[tool:mover_a_etapa] bloqueado regreso a etapa manual | contact=${contactId} etapa_actual="${etapaActual!.name}" target="${target.name}"`
    );
    return JSON.stringify({
      ok: true,
      blocked: true,
      message: `El contacto ya está en "${etapaActual!.name}" (etapa automática), no se mueve hacia atrás a "${target.name}". Continúa la conversación normalmente sin mencionar esto.`,
    });
  }

  try {
    await moveOpportunityToStage(chosen.id, target.id);
    console.log(
      `[tool:mover_a_etapa] OK | contact=${contactId} opp=${chosen.id} ` +
        `from=${chosen.pipelineStageId} to=${target.id} (${target.name})`
    );
    return JSON.stringify({ ok: true, moved_to: target.name });
  } catch (err) {
    console.error(`[tool:mover_a_etapa] API error: ${(err as Error).message}`);
    return JSON.stringify({
      error: 'api_error',
      message: 'No se pudo mover la oportunidad. Continúa la conversación normalmente.',
    });
  }
}

export async function startMessageWorker(concurrency = 5) {
  await boss.work<MessageJobData>(
    QUEUE_NAME,
    { teamSize: concurrency, teamConcurrency: concurrency },
    async (job) => {
      if (!job) return;
      const { contactId, phone, contactName, message, channel } = job.data;

      // Blocklist (ver src/blocklist.ts). El webhook ya filtra el entrante,
      // pero un job pudo quedar encolado antes del bloqueo: se descarta aquí,
      // limpiando el pendiente para que no lo reviva un reintento.
      if (await contactoBloqueadoAsync(contactId, phone)) {
        await db.query(
          `UPDATE conversations
           SET pending_message = NULL, pending_at = NULL, pending_attachments = '[]'::jsonb
           WHERE contact_id = $1`,
          [contactId]
        ).catch(() => {});
        await cancelarFollowUpsPendientes(contactId).catch(() => {});
        console.log(`[worker] Bloqueado — contacto en blocklist | contact=${contactId}`);
        return;
      }

      console.log(`[worker] Processing | contact=${contactId} channel=${channel ?? 'unknown'}`);

      // 1. Claim atómico del mensaje pendiente — previene race condition
      // entre reintentos. Usa CTE para capturar el valor antes de limpiarlo.
      const claimResult = await db.query(
        `WITH claimed AS (
           SELECT id, messages, pending_message, pending_attachments, metadata
           FROM conversations WHERE contact_id = $1
         )
         UPDATE conversations c
         SET pending_message = NULL, pending_at = NULL,
             pending_attachments = '[]'::jsonb
         FROM claimed
         WHERE c.id = claimed.id
         RETURNING claimed.id, claimed.messages, claimed.pending_message,
                   claimed.pending_attachments, claimed.metadata`,
        [contactId]
      );

      let conversation = claimResult.rows[0];

      if (!conversation) {
        const inserted = await db.query(
          `INSERT INTO conversations (contact_id, phone, contact_name, messages)
           VALUES ($1, $2, $3, '[]'::jsonb)
           RETURNING id, messages, pending_message, metadata`,
          [contactId, phone, contactName ?? null]
        );
        conversation = inserted.rows[0];

        // Conversación nueva: se siembran los campos personalizados que el
        // contacto no tenga, para que las notificaciones internas y las
        // plantillas de GHL nunca salgan con el merge field en crudo si el
        // contacto no alcanzó a contestar ese dato (ver seedCustomFields).
        const campos = getConfig().custom_fields?.fields.map((f) => f.id) ?? [];
        await seedCustomFields(contactId, campos);
      }

      const messageToProcess = conversation.pending_message ?? message;
      if (!messageToProcess) {
        console.log(`[worker] Skipped duplicate | contact=${contactId}`);
        return;
      }

      const history: ChatMessage[] = conversation.messages ?? [];

      // 2. Procesar attachments pendientes
      // - Imágenes y PDFs van como bloques a Claude Vision
      // - Audios se transcriben con Whisper y reemplazan el placeholder
      const pendingAttachments = (conversation.pending_attachments ?? []) as Array<{ url: string; kind: string }>;
      const attachmentBlocks: AttachmentBlock[] = [];
      let messageForClaude = messageToProcess;

      for (const att of pendingAttachments) {
        const data = await fetchAsBase64(att.url);
        if (!data) continue;

        if (att.kind === 'image' || att.kind === 'pdf') {
          attachmentBlocks.push({
            kind: att.kind,
            base64: data.base64,
            mimeType: data.mimeType,
          });
        } else if (att.kind === 'audio') {
          const ext = att.url.split('?')[0].split('.').pop()?.toLowerCase() ?? 'ogg';
          const transcripcion = await transcribirAudio({
            base64: data.base64,
            mimeType: data.mimeType,
            ext,
          });
          if (transcripcion) {
            const placeholder = '[el contacto envió un audio]';
            const replacement = `[audio transcrito]: ${transcripcion}`;
            if (messageForClaude.includes(placeholder)) {
              messageForClaude = messageForClaude.replace(placeholder, replacement);
            } else {
              messageForClaude += `\n${replacement}`;
            }
            console.log(`[whisper] transcrito (${transcripcion.length} chars): ${transcripcion.slice(0, 80)}`);
          } else {
            console.warn('[worker] No se pudo transcribir audio');
          }
        }
      }

      // 3. Llamar a Claude
      // El contactId se pasa al handler via closure — lo necesitan las tools
      // para saber a qué contacto pertenece la opportunity/cita.
      //
      // El canal del entrante viene del job; si falta (jobs viejos), cae al
      // metadata.channel persistido por el webhook, y por último a WhatsApp.
      //
      // Si Claude falla (ej. error de red), restauramos el pending_message
      // que ya habíamos claimeado y propagamos el error para que pg-boss
      // reintente el job — así el mensaje NO se pierde.
      const metaChannel =
        (conversation.metadata as { channel?: string } | null)?.channel as GhlChannel | undefined;
      const inboundChannel: GhlChannel = channel ?? metaChannel ?? 'WhatsApp';

      let replyText: string;
      let toolCalls: Array<{ toolName: string; output: string }>;
      // Estado compartido entre las tools de este turno (ver TurnContext).
      // El label es para la tarjeta del pipeline si hay que crearla: nombre
      // real del contacto, si no el teléfono. Nunca un literal fijo.
      const turn: TurnContext = { leadLabel: contactName || phone || contactId };

      // Tarjeta del pipeline desde el primer mensaje (pipeline.stage_on_first_message).
      // findOrCreate no mueve a nadie que ya tenga tarjeta. Best-effort: si GHL
      // falla, la conversación sigue.
      const cfgPipe = getConfig().pipeline;
      if (cfgPipe?.stage_on_first_message && process.env.GHL_LOCATION_ID) {
        const entrada = cfgPipe.stages.find((s) => s.name === cfgPipe.stage_on_first_message);
        if (entrada) {
          await findOrCreateOpportunity(
            contactId, cfgPipe.id, entrada.id, process.env.GHL_LOCATION_ID, turn.leadLabel
          ).catch(() => []);
        }
      }

      // Tags del CRM que el modelo necesita ver (context_tags del yaml) y que
      // también suprimen follow-ups (follow_ups.skip_if_tags). Una sola
      // lectura por turno. Si GHL falla, al modelo no se le dice nada (mejor
      // sin dato que con uno falso) y el follow-up se decide sin tags.
      const cfgTurn = getConfig();
      const necesitaTags =
        cfgTurn.context_tags.length > 0 || (cfgTurn.follow_ups?.skip_if_tags.length ?? 0) > 0;
      const tagsContacto = necesitaTags ? await getContactTags(contactId) : null;
      const contextTagsSet = new Set(cfgTurn.context_tags.map((t) => t.toLowerCase()));
      const tagsParaModelo =
        cfgTurn.context_tags.length > 0 && tagsContacto
          ? tagsContacto.filter((t) => contextTagsSet.has(t))
          : undefined;

      try {
        const result = await getClaudeResponse(
          history,
          messageForClaude,
          async (toolName, input) => handleTool(toolName, input, contactId, turn),
          inboundChannel,
          attachmentBlocks,
          tagsParaModelo
        );
        replyText = result.text;
        toolCalls = result.toolCalls;

        // E118: un `stop_reason` que no sea end_turn ni tool_use significa que
        // la generación se cortó A MEDIAS — `max_tokens` si el mensaje se pasó
        // de largo, `refusal` si un clasificador la frenó en vuelo. El texto
        // que quedó es medio mensaje, y medio mensaje le hace más daño al
        // contacto que el silencio: a una paciente real le llegó la frase del
        // anticipo cortada justo antes de los datos de pago, y no hubo una
        // sola línea en los logs.
        //
        // El pedazo se tira y el caso pasa a una persona. No se reintenta la
        // generación a propósito: volver a llamar al modelo re-ejecutaría las
        // tools que ya corrieron en este turno.
        if (result.stopReason !== 'end_turn' && result.stopReason !== 'tool_use') {
          console.warn(
            `[worker] respuesta truncada (stop=${result.stopReason}), se descarta y se escala | ` +
              `contact=${contactId} | fragmento=${JSON.stringify(replyText.slice(0, 160))}`
          );
          replyText = 'Déjame pasar tu caso con una persona del equipo para que lo vea directo contigo.';
          if (getConfig().escalation) {
            try {
              await handleTool(
                'escalar_a_humano',
                { motivo: `respuesta truncada del modelo (stop=${result.stopReason}), el contacto no recibió la respuesta completa` },
                contactId,
                turn
              );
            } catch (e) {
              console.error(`[worker] escalación por truncado falló | contact=${contactId}: ${(e as Error).message}`);
            }
          }
        }
      } catch (err) {
        console.error(`[worker] Claude falló, restaurando pending y reintentando | contact=${contactId}: ${(err as Error).message}`);
        await db.query(
          `UPDATE conversations
           SET pending_message = CASE
                 WHEN pending_message IS NULL OR pending_message = '' THEN $2
                 ELSE $2 || E'\\n' || pending_message
               END,
               pending_at = now()
           WHERE id = $1`,
          [conversation.id, messageToProcess]
        ).catch((e) => console.error(`[worker] restore pending falló: ${e.message}`));
        throw err; // pg-boss reintenta (retryLimit)
      }

      // 3.5 Hacer cumplir la promesa de es_reagendamiento antes de contestar:
      // si el modelo creó la cita nueva y no canceló la anterior, se cancela
      // acá. Va antes del envío para que el contacto nunca vea confirmada una
      // cita que dejó dos horarios ocupados.
      await enforceReagendamiento(contactId, turn);

      // 4. Guardar historial (máx 100 entradas)
      const MAX_STORED_MESSAGES = 100;
      const now = new Date().toISOString();
      const newMessages: ChatMessage[] = [
        ...history,
        { role: 'user' as const, content: messageForClaude, ts: now },
        { role: 'assistant' as const, content: replyText, ts: now },
      ].slice(-MAX_STORED_MESSAGES);

      const hasReply = !!replyText && replyText.trim().length > 0;

      await db.query(
        `UPDATE conversations
         SET messages = $1::jsonb,
             last_activity = now(),
             last_bot_message_at = CASE WHEN $3::boolean THEN now() ELSE last_bot_message_at END,
             follow_ups_sent = CASE WHEN $3::boolean THEN 0 ELSE follow_ups_sent END
         WHERE id = $2`,
        [JSON.stringify(newMessages), conversation.id, hasReply]
      );

      // 5. Enviar respuesta por el mismo canal del entrante
      if (hasReply) {
        const parts = splitMessage(replyText);
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 800));
          await sendMessage(contactId, parts[i], inboundChannel);
        }

        // 6. Programar follow-ups (solo si hay bloque follow_ups: en el yaml).
        // Se suprimen cuando la conversación ya "cerró":
        //  - agendó cita en ESTE turno, o ya tiene una cita activa de un turno anterior
        //  - escaló a humano en ESTE turno, o ya está en la etapa de escalation.stage
        //  - confirmó asistencia a una plantilla de recordatorio ("Sí asistiré")
        //
        // Importante: la cita/escalación de turnos ANTERIORES se revisa contra el
        // estado real (GHL), no solo contra las tools usadas en este turno — si no,
        // un simple "gracias" después de agendar reprograma follow-ups innecesarios
        // para alguien que ya tiene su cita apartada.
        if (getConfig().follow_ups) {
          const usedTools = new Set(toolCalls.map((t) => t.toolName));
          // OJO: `mover_a_etapa` NO va en esta lista, aunque parezca que sí.
          // Las etapas de cierre van marcadas `AUTO:` en el yaml y por eso
          // buildTools() (services/claude.ts) las esconde del enum que ve el
          // modelo — o sea que esa tool SOLO puede mover a etapas manuales,
          // que son las de conversación EN CURSO. Meterla aquí invierte su
          // significado: cada turno en que el modelo mueve a la etapa de
          // entrada apagaba el seguimiento completo. Incidente real (bot Dr.
          // Romero): 36 de 36 turnos salieron "no programado", cero
          // follow-ups enviados y cero leads movidos a la etapa de perdido
          // durante semanas, sin un solo error en los logs. El cierre real de
          // turnos anteriores ya se verifica abajo contra el estado vivo de
          // GHL — esa es la comprobación correcta.
          // `cancelar_cita` SIN `agendar_cita` = el contacto canceló y no quiso
          // mover la cita a otro día. Eso también cierra el ciclo: perseguirlo
          // con follow-ups 3h después de que pidió cancelar es justo lo que el
          // prompt le manda NO hacer. Con `agendar_cita` es un reagendamiento y
          // ya lo cubre la primera condición.
          //
          // Se exige que la cancelación haya SALIDO BIEN, no solo que el modelo
          // llamara la tool: `cancelar_cita` devuelve `multiple_appointments`
          // cuando hay varias citas y toca preguntarle al contacto cuál — ahí la
          // conversación está más viva que nunca y apagarle el seguimiento sería
          // exactamente el bug de la lección 13 otra vez.
          const cancelacionExitosa = toolCalls.some(
            (t) => t.toolName === 'cancelar_cita' && t.output.includes('"ok":true')
          );
          let yaCerrado =
            usedTools.has('agendar_cita') ||
            usedTools.has('escalar_a_humano') ||
            cancelacionExitosa;

          // Tags que cierran el ciclo aunque no haya pipeline para verificarlo:
          // una escalación de un turno anterior, o algo que marcó una persona
          // del equipo (ej. "boleto-pagado"). Leídos arriba, una vez por turno.
          const skipTags = new Set(getConfig().follow_ups!.skip_if_tags.map((t) => t.toLowerCase()));
          if (!yaCerrado && tagsContacto && tagsContacto.some((t) => skipTags.has(t))) {
            yaCerrado = true;
          }

          if (!yaCerrado && getConfig().calendars) {
            try {
              const citas = await getContactAppointments(contactId);
              const now = Date.now();
              yaCerrado = citas.some((a) => {
                const t = new Date(a.startTime).getTime();
                const cancelada = (a.appointmentStatus ?? '').toLowerCase().includes('cancel');
                return !isNaN(t) && t > now && !cancelada;
              });
            } catch (e) {
              console.warn(`[follow-up] check citas falló: ${(e as Error).message}`);
            }
          }

          // Todas las etapas de escalación: la general y las de cada categoría.
          const esc = getConfig().escalation;
          const escalationStageNames = new Set(
            [esc?.stage, ...Object.values(esc?.category_stages ?? {})].filter((n): n is string => !!n)
          );
          if (!yaCerrado && getConfig().pipeline && escalationStageNames.size > 0) {
            const locationId = process.env.GHL_LOCATION_ID;
            if (locationId) {
              try {
                const opps = await findContactOpportunity(contactId, getConfig().pipeline!.id, locationId);
                const escaladaIds = new Set(
                  getConfig().pipeline!.stages.filter((s) => escalationStageNames.has(s.name)).map((s) => s.id)
                );
                yaCerrado = opps.some((o) => escaladaIds.has(o.pipelineStageId));
              } catch (e) {
                console.warn(`[follow-up] check escalacion falló: ${(e as Error).message}`);
              }
            }
          }

          const confirmType = detectAttendanceConfirmation(messageToProcess);
          const suppressFollowUp = yaCerrado || confirmType === 'yes';

          if (suppressFollowUp) {
            console.log(
              `[follow-up] no programado (conversación cerrada) | contact=${contactId} ` +
                `tools=[${[...usedTools].join(',')}] confirm=${confirmType ?? '-'}`
            );
          } else {
            scheduleFollowUps(contactId).catch((e) =>
              console.warn(`[follow-up] schedule failed: ${e.message}`)
            );
          }
        }
      } else {
        console.warn(`[worker] Empty reply | contact=${contactId}`);
      }

      console.log(
        `[worker] Done | contact=${contactId} tools=[${toolCalls.map((t) => t.toolName).join(',')}]`
      );
    }
  );

  console.log(`[worker] Started | concurrency=${concurrency}`);
}
