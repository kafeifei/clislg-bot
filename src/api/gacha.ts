import { ApiClient } from './client.js';
import { createLogger } from '../logger.js';

const log = createLogger('gacha');

export async function pullGacha(client: ApiClient): Promise<unknown> {
  log.info('抽卡招募将领...');
  const result = await client.post('/gacha/pull');
  log.info('抽卡完成', result);
  return result;
}
