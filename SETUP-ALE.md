# Bot de Ale Prado: setup y pendientes

Agente de campaña del workshop **Sobrevive a la Oficina** (sáb 17 oct, 11:00 am CDMX).
Un solo objetivo: que el interesado reciba el link de pago y mande su comprobante.
Plantilla: `SKILLS/bot-ghl-template` + 3 ajustes propios (abajo).

## Pendientes antes de deployar

| # | Qué | Quién | Dónde se cambia |
|---|---|---|---|
| 1 | ~~Link de Mercado Pago~~ ✅ 08/10: https://mpago.la/2h8BBdK | Ale | `oferta.link_pago` |
| 2 | ~~Nombre del bot~~ ✅ 07/10: sin nombre, "asistente virtual de Ale Prado" | Jorge | — |
| 3 | **Si alguien compra y no puede ir el 17**: hoy el bot dice lo que ya es público (grabación y sorteo solo para quien está en vivo) y escala. Si Ale decide algo distinto, se cambia un párrafo | Ale | `prompt.md` → objeción "Y si ese día no puedo?" |
| 4 | **Link de acceso a la sesión**: el bot no lo tiene y escala. Confirmar que va en los recordatorios del Workflow | Jorge | Workflow de GHL |
| 5 | **Formas de pago, factura, grupos, cómo se cobra la garantía**: el bot escala todo eso. Si Ale lo define, se agrega a `<business_knowledge>` | Ale | `prompt.md` |
| 6 | **Link de compra de "Entrena Duro Come Mejor"** ($970): el bot no lo tiene y escala. `M104985323Y` es el de la Guía de Suplementación | Ale | agregar `oferta.link_curso_entrena` + una línea en el prompt |

Precio ($470) y hora (11:00 am) se tomaron de las decisiones cerradas el 20/09
(`CLIENTES/ALE PRADO/CLAUDE.md`), ya publicadas en la landing.

## Setup en GHL

1. **PIT** con los scopes de la skill `crear-bot-ghl` (Paso 1.1) y el **Location ID**.
2. **Tags**: `requiere-humano`, `comprobante-recibido`, `quiere-consulta`, `paciente-actual`,
   `revisar-equipo`, `boleto-pagado`.
3. **Workflow de webhook**: trigger "Customer Replied" (solo inbound), canal WhatsApp →
   POST `https://<app>.up.railway.app/webhook/ghl/whatsapp` con header `x-webhook-secret`.
4. **Workflow de aviso al equipo**: Tag Added = `requiere-humano` → Internal Notification.
   La nota del contacto trae la categoría y el motivo.
5. **Confirmación de pago (manual)**: una persona revisa el comprobante en Mercado Pago y
   agrega `boleto-pagado`. Ese tag dispara el Workflow de show-up (3 días / 1 día / 1 hora),
   que ya está diseñado fuera del bot.
   - Redacta esos recordatorios **autocontenidos** ("Te escribimos del equipo de Ale Prado,
     tu workshop es mañana a las 11"). El bot no los ve, solo ve la respuesta.

Sin pipeline ni calendario en v1: el bot no agenda consultas (escala) y el funnel se sigue por tags.

## Ajustes al código vs. la plantilla

1. **`oferta:` en el yaml**: precio, fecha y links como placeholders `{{oferta.x}}`. Si
   algún valor dice `PENDIENTE`, el bot no arranca (`checkPendientes` en `src/config.ts`).
   Para pruebas locales: `PERMITIR_PENDIENTES=1`.
2. **`escalation.category_tags`**: `escalar_a_humano` recibe `categoria` y agrega el tag de
   esa categoría además de `requiere-humano` (ej. comprobante → `comprobante-recibido`).
3. **Tags del CRM**: `context_tags` hace que el modelo vea en cada turno si el contacto trae
   `boleto-pagado` / `comprobante-recibido` / `requiere-humano`. `follow_ups.skip_if_tags`
   suprime los seguimientos con esos tags, tanto al programarlos como al enviarlos (el tag
   `boleto-pagado` lo pone una persona horas después).

## Pruebas

- `npm run build && npm run test:razonamiento`: pasa.
- `PERMITIR_PENDIENTES=1 npm run test:modelo claude-sonnet-4-6 claude-haiku-4-5`: 29
  conversaciones de la campaña en `pruebas/conversaciones.js`. **Todavía no se corre**:
  gasta crédito de Anthropic y necesita `ANTHROPIC_API_KEY` en `.env`.
- En vivo: mandar "OFICINA", mandar una foto de comprobante (debe escalar con
  `comprobante-recibido` y NO confirmar), preguntar por embarazo (debe ir a consulta),
  y agregar `boleto-pagado` a mano para confirmar que se cortan los follow-ups
  (`[follow-up] omitido — contacto con tag "boleto-pagado"` en logs).
