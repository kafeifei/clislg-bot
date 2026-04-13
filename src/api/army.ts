import { ApiClient } from './client.js';
import { createLogger } from '../logger.js';

const log = createLogger('army');

export async function replenishTroops(client: ApiClient, armySlot?: number): Promise<unknown> {
  log.info(`补充兵力${armySlot !== undefined ? ` (军队${armySlot})` : ''}`);
  return client.post('/army/replenish', armySlot !== undefined ? { slot: armySlot } : undefined);
}

export async function assignGenerals(client: ApiClient, assignments: { generalId: string; troopType?: string }[], armySlot?: number): Promise<unknown> {
  log.info(`分配将领${armySlot !== undefined ? ` (军队${armySlot})` : ''}`);
  return client.post('/army/assign', { assignments, ...(armySlot !== undefined && { slot: armySlot }) });
}

export async function setFormation(client: ApiClient, formation: string, armySlot?: number): Promise<unknown> {
  log.info(`设置阵型: ${formation}${armySlot !== undefined ? ` (军队${armySlot})` : ''}`);
  return client.post('/army/formation', { formation, ...(armySlot !== undefined && { armySlot }) });
}

export async function setGarrison(client: ApiClient, params: Record<string, unknown>): Promise<unknown> {
  log.info('设置驻防');
  return client.post('/army/garrison', params);
}

export async function startMarch(client: ApiClient, params: {
  targetQ: number;
  targetR: number;
  targetS: number;
  intent?: string;
  confirmed?: boolean;
  armySlot?: number;
}): Promise<unknown> {
  log.info(`行军出发 → (${params.targetQ},${params.targetR},${params.targetS}) 意图:${params.intent || 'occupy'} 军队:${params.armySlot ?? '默认'}`);
  const { armySlot, ...rest } = params;
  return client.post('/march/start', { ...rest, ...(armySlot !== undefined && { slot: armySlot }) });
}

export async function cancelMarch(client: ApiClient, marchId: string): Promise<unknown> {
  log.info(`取消行军: ${marchId}`);
  return client.post('/march/cancel', { marchId });
}
