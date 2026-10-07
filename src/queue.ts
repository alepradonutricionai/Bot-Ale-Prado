import PgBoss from 'pg-boss';
import { MessageJobData } from './types';
import { getConfig } from './config';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

export const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

const QUEUE_NAME = 'messages';

/**
 * Encola un mensaje con debounce por contacto.
 * singletonKey garantiza un solo job pendiente por contacto, así
 * cuando alguien manda 5 mensajes seguidos solo se procesa una vez.
 *
 * El debounce se lee de configuracion/bot.config.yaml en cada llamada para
 * que cambios al yaml apliquen sin reiniciar (getConfig cachea la primera
 * lectura, así que el costo es trivial).
 */
export async function enqueueMessage(data: MessageJobData): Promise<void> {
  const debounceSeconds = getConfig().behavior.message_debounce_seconds;

  await boss.send(
    QUEUE_NAME,
    {
      contactId: data.contactId,
      phone: data.phone,
      contactName: data.contactName,
      message: data.message,
      channel: data.channel,
    },
    {
      singletonKey: data.contactId,
      startAfter: debounceSeconds,
      // Reintentos moderados con backoff (10s, 20s, 40s). Muchos reintentos
      // agresivos amplifican el volumen contra el edge de Anthropic y pueden
      // disparar rate-limiting de la IP de salida del hosting.
      retryLimit: 3,
      retryDelay: 10,
      retryBackoff: true,
    }
  );
}

export { QUEUE_NAME };
