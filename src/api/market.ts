import { ApiClient } from './client.js';
import { createLogger } from '../logger.js';

const log = createLogger('market');

export async function convertResource(client: ApiClient, from: string, to: string, amount: number): Promise<unknown> {
  log.info(`市场转换: ${amount} ${from} → ${to} (损耗20%)`);
  return client.post('/market/convert', { from, to, amount });
}

export async function purchaseItem(client: ApiClient, itemType: string, amount?: number): Promise<unknown> {
  log.info(`市场购买: ${itemType}${amount ? ` x${amount}` : ''}`);
  return client.post('/market/purchase', { itemType, ...(amount !== undefined && { amount }) });
}
