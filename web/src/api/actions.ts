import { api } from './client.js';
import type { Decision } from '../../../src/core/types.js';

export async function executeDecision(decision: Decision): Promise<unknown> {
  const p = decision.params || {};
  switch (decision.action) {
    case 'replenish':
      return api('POST', '/army/replenish', p.armySlot != null ? { slot: p.armySlot } : undefined);
    case 'march': {
      const { armySlot, ...rest } = p as Record<string, unknown>;
      return api('POST', '/march/start', { ...rest, ...(armySlot != null && { slot: armySlot }) });
    }
    case 'develop': {
      const result = await api<Record<string, unknown>>('POST', '/march/start', {
        intent: 'develop', resourcePointId: p.resourcePointId, slot: p.slot ?? 1,
      });
      return result;
    }
    case 'build': {
      const body: Record<string, unknown> = { buildingType: p.buildingType };
      if (p.slot != null) body.slot = p.slot;
      return api('POST', '/building/upgrade', body);
    }
    case 'abandon':
      return api('POST', '/resource/abandon', { resourcePointId: p.resourcePointId });
    case 'upgrade_resource':
      return api('POST', '/resource/upgrade', { resourcePointId: p.resourcePointId, targetLevel: p.targetLevel });
    case 'gacha':
      return api('POST', '/gacha/pull');
    case 'market_purchase':
      return api('POST', '/market/purchase', { item: p.item || p.itemType });
    case 'assign_generals':
      return api('POST', '/army/assign', { assignments: p.assignments, slot: p.armySlot });
    case 'wait':
      return null;
    default:
      return null;
  }
}
