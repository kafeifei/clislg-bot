import { ApiClient } from './client.js';
import { createLogger } from '../logger.js';

const log = createLogger('events');

export async function respondToEvent(client: ApiClient, eventId: string, response?: Record<string, unknown>): Promise<unknown> {
  log.info(`响应事件: ${eventId}`);
  return client.post('/events/respond', { eventId, ...response });
}
