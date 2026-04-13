import { ApiClient } from './client.js';
import { createLogger } from '../logger.js';

const log = createLogger('building');

export async function upgradeBuilding(client: ApiClient, buildingType: string): Promise<unknown> {
  log.info(`升级建筑: ${buildingType}`);
  return client.post('/building/upgrade', { buildingType });
}

export async function upgradeResource(client: ApiClient, slot: string): Promise<unknown> {
  log.info(`升级资源点: ${slot}`);
  return client.post('/resource/upgrade', { slot });
}

export async function abandonResource(client: ApiClient, slot: string): Promise<unknown> {
  log.info(`放弃资源点: ${slot}`);
  return client.post('/resource/abandon', { slot });
}
