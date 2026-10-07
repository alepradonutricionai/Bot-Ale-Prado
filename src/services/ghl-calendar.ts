/**
 * Cliente para GHL Calendars API — free-slots y creación de citas.
 *
 * La capacidad por hora, el horario de atención y los bloqueos los maneja
 * GHL en la configuración de cada calendario, no este código. El bot solo
 * consulta disponibilidad y agenda.
 */

const GHL_API_BASE = 'https://services.leadconnectorhq.com';

function getApiKey(): string {
  const key = process.env.GHL_API_KEY;
  if (!key) throw new Error('GHL_API_KEY is required');
  return key;
}

async function ghlFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${GHL_API_BASE}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(10_000),
    headers: {
      'Authorization': `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GHL API error ${res.status} on ${path}: ${body}`);
  }

  return res.json();
}

export interface FreeSlot {
  iso: string;
  calendarId: string;
}

/**
 * Consulta slots libres en un calendario entre dos fechas (timestamps en ms).
 * GHL devuelve un objeto agrupado por día con la lista de slots ISO.
 *
 * Si el calendario está mal configurado o el rango no tiene slots, devuelve [].
 */
export async function getFreeSlots(
  calendarId: string,
  startDateMs: number,
  endDateMs: number,
  timezone = 'America/Bogota'
): Promise<FreeSlot[]> {
  const path =
    `/calendars/${encodeURIComponent(calendarId)}/free-slots` +
    `?startDate=${startDateMs}&endDate=${endDateMs}&timezone=${encodeURIComponent(timezone)}`;

  const data = (await ghlFetch(path)) as Record<string, { slots?: string[] } | undefined> & {
    traceId?: string;
  };

  const slots: FreeSlot[] = [];
  for (const key of Object.keys(data)) {
    if (key === 'traceId') continue;
    const day = data[key];
    if (day && Array.isArray(day.slots)) {
      for (const iso of day.slots) {
        slots.push({ iso, calendarId });
      }
    }
  }
  // GHL ya los devuelve en orden cronológico, pero por si acaso lo aseguramos.
  slots.sort((a, b) => a.iso.localeCompare(b.iso));
  return slots;
}

export interface CreateAppointmentParams {
  calendarId: string;
  locationId: string;
  contactId: string;
  startTime: string;
  endTime: string;
  title: string;
  appointmentStatus?: 'new' | 'confirmed' | 'showed' | 'cancelled';
  /** Usuario de GHL al que se asigna la cita. Obligatorio en la práctica
   *  (ver createAppointment); si no viene, se deduce del calendario. */
  assignedUserId?: string;
}

/**
 * Team member principal de un calendario, cacheado por proceso.
 *
 * Se necesita para crear citas (ver createAppointment) y no cambia casi
 * nunca, así que se pregunta una vez por calendario y se guarda. Si la API
 * falla, devuelve null y el caller decide — no se cachea el fallo, para que
 * el siguiente intento lo vuelva a preguntar.
 */
const usuarioPorCalendario = new Map<string, string>();

export async function getCalendarAssignedUser(calendarId: string): Promise<string | null> {
  const cacheado = usuarioPorCalendario.get(calendarId);
  if (cacheado) return cacheado;

  try {
    const data = (await ghlFetch(`/calendars/${encodeURIComponent(calendarId)}`)) as {
      calendar?: { teamMembers?: Array<{ userId?: string; isPrimary?: boolean; selected?: boolean }> };
    };
    const miembros = data.calendar?.teamMembers ?? [];
    const elegido =
      miembros.find((m) => m.isPrimary && m.userId) ??
      miembros.find((m) => m.selected && m.userId) ??
      miembros.find((m) => m.userId);
    const userId = elegido?.userId;
    if (!userId) {
      console.error(
        `[GHL] El calendario ${calendarId} no tiene team members. Sin eso NO se pueden crear citas: ` +
          'asígnale un usuario en GHL (Calendars → el calendario → Team members).'
      );
      return null;
    }
    usuarioPorCalendario.set(calendarId, userId);
    console.log(`[GHL] Calendario ${calendarId} → se asignan las citas a ${userId}`);
    return userId;
  } catch (err) {
    console.error(`[GHL] No se pudo leer el calendario ${calendarId}: ${(err as Error).message}`);
    return null;
  }
}

export interface CreatedAppointment {
  id: string;
  startTime: string;
  endTime: string;
  calendarId: string;
}

/**
 * Crea una appointment en el calendario indicado. GHL la sincroniza
 * automáticamente con Google Calendar si el calendario está conectado.
 */

export interface CreatedAppointment {
  id: string;
  startTime: string;
  endTime: string;
  calendarId: string;
}

/**
 * Crea una appointment en el calendario indicado. GHL la sincroniza
 * automáticamente con Google Calendar si el calendario está conectado.
 */
export async function createAppointment(
  params: CreateAppointmentParams
): Promise<CreatedAppointment> {
  const body = {
    calendarId: params.calendarId,
    locationId: params.locationId,
    contactId: params.contactId,
    startTime: params.startTime,
    endTime: params.endTime,
    title: params.title,
    appointmentStatus: params.appointmentStatus ?? 'confirmed',
    // Los dos van JUNTOS o no va ninguno: sin `assignedUserId`, activar
    // `ignoreFreeSlotValidation` hace que GHL responda 422 y la cita NO se
    // crea — o sea que el "arreglo" rompería un bot al que hoy sí le
    // coinciden las duraciones. Si no se pudo averiguar el usuario, se manda
    // la petición como antes: funciona mientras la duración coincida con la
    // casilla, que es exactamente donde estábamos.
    ...(params.assignedUserId
      ? { ignoreFreeSlotValidation: true, assignedUserId: params.assignedUserId }
      : {}),
  };

  if (!params.assignedUserId) {
    console.warn(
      '[GHL] Sin assignedUserId: la cita se crea SIN ignoreFreeSlotValidation. ' +
        'Si su duración no coincide con la casilla del calendario, GHL la va a rechazar. ' +
        'Revisa que el calendario tenga team members asignados.'
    );
  }

  const data = (await ghlFetch('/calendars/events/appointments', {
    method: 'POST',
    body: JSON.stringify(body),
  })) as { id: string; startTime: string; endTime: string; calendarId: string };

  return {
    id: data.id,
    startTime: data.startTime,
    endTime: data.endTime,
    calendarId: data.calendarId,
  };
}

export interface ContactAppointment {
  id: string;
  title?: string;
  startTime: string;
  endTime: string;
  appointmentStatus: string;
  calendarId: string;
}

/**
 * Lista las citas de un contacto. Útil para detectar si es cliente recurrente.
 * Si GHL devuelve error, retorna [] (no lanza — el caller decide).
 */
export async function getContactAppointments(
  contactId: string
): Promise<ContactAppointment[]> {
  try {
    const data = (await ghlFetch(
      `/contacts/${encodeURIComponent(contactId)}/appointments`
    )) as { events?: ContactAppointment[] };
    return data.events ?? [];
  } catch (err) {
    console.warn(`[GHL] getContactAppointments failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Agrega tags al contacto. Útil para escalación a humano y para que el equipo
 * tenga workflows GHL que detecten esos tags.
 */
export async function addTagsToContact(
  contactId: string,
  tags: string[]
): Promise<void> {
  await ghlFetch(`/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: 'POST',
    body: JSON.stringify({ tags }),
  });
}

/**
 * Cita FUTURA y viva de un contacto (lo que devuelve buscarCitasDelContacto).
 */
export interface CitaFutura {
  id: string;
  title?: string;
  startTime: string;
  endTime: string;
  status: string;
  calendarId: string;
}

/**
 * Devuelve las citas FUTURAS y vivas del contacto, de la más próxima a la
 * más lejana.
 *
 * Endpoint: el mismo `GET /contacts/{contactId}/appointments` que ya usa
 * `getContactAppointments` (API 2021-04-15) — es el único de la API 2021 de
 * LeadConnector que lista citas POR CONTACTO. `GET /calendars/events` filtra
 * por calendario + rango de fechas y por usuario asignado, no por contacto,
 * así que obligaría a barrer todos los calendarios y filtrar a mano.
 *
 * `calendarId` (opcional) restringe el resultado a uno o varios calendarios —
 * el caller pasa los calendar_id de las agendas del yaml para que el bot
 * nunca toque citas de calendarios que no administra.
 *
 * Filtra las canceladas / noshow / invalid: una cita cancelada sigue viva en
 * el listado de GHL con su status cambiado, y volver a "cancelarla" no tiene
 * sentido.
 *
 * Nunca lanza: cualquier error de API se traduce en [] (getContactAppointments
 * ya lo hace).
 */
export async function buscarCitasDelContacto(
  contactId: string,
  calendarId?: string | string[]
): Promise<CitaFutura[]> {
  const appts = await getContactAppointments(contactId);

  const permitidos =
    calendarId === undefined
      ? null
      : new Set(Array.isArray(calendarId) ? calendarId : [calendarId]);

  const ahora = Date.now();

  return appts
    .filter((a) => {
      if (permitidos && !permitidos.has(a.calendarId)) return false;
      const t = new Date(a.startTime).getTime();
      if (isNaN(t) || t <= ahora) return false;
      const status = (a.appointmentStatus ?? '').toLowerCase();
      return (
        !status.includes('cancel') &&
        !status.includes('noshow') &&
        !status.includes('invalid')
      );
    })
    .map((a) => ({
      id: a.id,
      title: a.title,
      startTime: a.startTime,
      endTime: a.endTime,
      status: a.appointmentStatus,
      calendarId: a.calendarId,
    }))
    // Por instante real, no por string: los startTime de GHL vienen con
    // offset ("...T14:00:00-06:00") y comparar texto se rompe en el cambio
    // de horario de verano.
    .sort((x, y) => new Date(x.startTime).getTime() - new Date(y.startTime).getTime());
}

/**
 * Cancela una cita CAMBIANDO SU STATUS a "cancelled" (PUT sobre el
 * appointment), no borrando el evento.
 *
 * Es a propósito: GHL solo dispara los workflows con trigger
 * "Appointment Status → Cancelled" (limpieza de recordatorios de 24h/2h,
 * avisos al equipo) cuando ve el cambio de estado. Un
 * `DELETE /calendars/events/{id}` haría desaparecer el evento del calendario
 * sin disparar nada, y los recordatorios ya programados le seguirían
 * llegando al contacto de una cita que ya no existe.
 *
 * Mismo endpoint que createAppointment pero en PUT y con el id del evento.
 * Lanza si la API falla — el caller decide qué decirle al modelo.
 */
export async function cancelarCita(appointmentId: string): Promise<void> {
  await ghlFetch(`/calendars/events/appointments/${encodeURIComponent(appointmentId)}`, {
    method: 'PUT',
    body: JSON.stringify({ appointmentStatus: 'cancelled' }),
  });
  console.log(`[GHL] Cita cancelada (status → cancelled) | appt=${appointmentId}`);
}
