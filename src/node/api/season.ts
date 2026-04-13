import { ApiClient } from './client.js';
import { createLogger } from '../logger.js';

const log = createLogger('season');

export async function joinSeason(client: ApiClient): Promise<unknown> {
  log.info('加入当前赛季...');
  const result = await client.post('/join-season');
  log.info('赛季加入成功');
  return result;
}

export async function startNextSeason(client: ApiClient): Promise<unknown> {
  log.info('开始新赛季...');
  return client.post('/season/start-next');
}
