import { ApiClient, AuthError, RateLimitError } from './api/client.js';
import { ensureAuthenticated } from './api/auth.js';
import { joinSeason } from './api/season.js';
import { getState, getEvents } from './api/state.js';
import { getMapData } from './api/state.js';
import { replenishTroops, startMarch, setFormation } from './api/army.js';
import { upgradeBuilding, upgradeResource, abandonResource } from './api/building.js';
import { convertResource, purchaseItem } from './api/market.js';
import { pullGacha } from './api/gacha.js';
import { respondToEvent } from './api/events.js';
import { fetchLeaderboard } from './api/leaderboard.js';
import { makeDecision } from './brain/strategist.js';
import { config } from './config.js';
import { createLogger } from './logger.js';
import type { GameState, MapData, Decision, GameEvent, BroadcastMessage } from './types.js';

const log = createLogger('loop');

// 广播订阅者（Web 面板用）
const broadcastSubs: ((msg: BroadcastMessage) => void)[] = [];
export function onBroadcast(fn: (msg: BroadcastMessage) => void) {
  broadcastSubs.push(fn);
  return () => {
    const idx = broadcastSubs.indexOf(fn);
    if (idx >= 0) broadcastSubs.splice(idx, 1);
  };
}

function broadcast(type: BroadcastMessage['type'], data: unknown) {
  const msg: BroadcastMessage = { type, data, timestamp: new Date().toISOString() };
  broadcastSubs.forEach(fn => fn(msg));
}

// 最新状态缓存（供 Web 面板查询）
let latestState: GameState | null = null;
let latestMap: MapData | null = null;
let roundCount = 0;
let decisionHistory: { round: number; decision: Decision; timestamp: string }[] = [];

export function getLatestState() { return latestState; }
export function getLatestMap() { return latestMap; }
export function getRound() { return roundCount; }
export function getDecisionHistory() { return decisionHistory.slice(-50); }

/**
 * 执行决策对应的 API 操作
 */
async function executeDecision(client: ApiClient, decision: Decision): Promise<unknown> {
  const p = decision.params as Record<string, unknown>;

  switch (decision.action) {
    case 'replenish':
      return replenishTroops(client, p.armySlot as number | undefined);

    case 'march':
    case 'develop':
      return startMarch(client, {
        targetQ: p.targetQ as number,
        targetR: p.targetR as number,
        targetS: p.targetS as number,
        intent: (p.intent as string) || (decision.action === 'develop' ? 'develop' : 'occupy'),
        confirmed: p.confirmed as boolean | undefined,
        armySlot: p.armySlot as number | undefined,
      });

    case 'abandon':
      return abandonResource(client, p.slot as string);

    case 'build':
      return upgradeBuilding(client, p.buildingType as string);

    case 'gacha':
      return pullGacha(client);

    case 'market_convert':
      return convertResource(client, p.from as string, p.to as string, p.amount as number);

    case 'market_purchase':
      return purchaseItem(client, p.itemType as string, p.amount as number | undefined);

    case 'upgrade_resource':
      return upgradeResource(client, p.slot as string);

    case 'formation':
      return setFormation(client, p.formation as string, p.armySlot as number | undefined);

    case 'respond_event':
      return respondToEvent(client, p.eventId as string, p as Record<string, unknown>);

    case 'wait':
      log.info(`按兵不动: ${p.reason || '等待时机'}`);
      return null;

    default:
      log.warn(`未知行动类型: ${decision.action}`);
      return null;
  }
}

/**
 * 计算自适应等待时间
 */
function computeInterval(state: GameState, decision: Decision): number {
  // 行军中：等到预计到达时间
  for (const army of state.armies) {
    if (army.status === 'marching' && army.march?.arrivalAt) {
      const eta = new Date(army.march.arrivalAt).getTime() - Date.now();
      if (eta > 0) {
        return Math.min(eta + 3000, 120000); // 到达后3秒再查
      }
    }
  }

  // 刚执行了操作：快速复查
  if (decision.action !== 'wait') return 5000;

  // 默认间隔
  return config.pollIntervalMs;
}

/**
 * 主游戏循环
 */
export async function runGameLoop(client: ApiClient, username?: string, password?: string): Promise<never> {
  const user = username || config.username;
  const pass = password || config.password;

  // 认证
  await ensureAuthenticated(client, user, pass);

  // 加入赛季
  try {
    await joinSeason(client);
  } catch (e) {
    log.warn('加入赛季失败（可能已加入）', (e as Error).message);
  }

  log.info('游戏循环启动！');

  while (true) {
    try {
      roundCount++;
      log.info(`\n${'═'.repeat(20)} 第 ${roundCount} 轮 ${'═'.repeat(20)}`);

      // 确保认证
      await ensureAuthenticated(client, user, pass);

      // 并行获取状态
      const [state, events, map] = await Promise.all([
        getState(client),
        getEvents(client).catch(() => [] as GameEvent[]),
        getMapData(client).catch(() => null as MapData | null),
      ]);
      // 每5轮查一次 leaderboard（避免频繁请求）
      const lb = (roundCount % 5 === 1)
        ? await fetchLeaderboard(client.getPlayerId()!).catch(() => undefined)
        : undefined;

      latestState = state;
      latestMap = map;

      // 状态摘要
      const r = state.resources;
      const army = state.armies[0];
      const troopStr = army ? `兵${army.totalTroops}/${army.totalTroopCap} 体力${state.stamina}` : '无军队';
      log.info(`Lv${state.lordLevel} | 木${r.wood} 石${r.stone} 铁${r.iron} 粮${r.grain} 铜${r.copper} | ${troopStr} | 领地${state.ownedResourcePoints.length}/${state.resourcePointLimit}`);
      if (lb?.myPlayer?.topGuideTask) {
        log.info(`系统建议: ${lb.myPlayer.topGuideTask}`);
      }

      // 广播状态
      broadcast('state', { state, map, round: roundCount });

      // 决策
      const decision = await makeDecision(state, events, map ?? undefined, lb);

      // 记录决策
      const entry = { round: roundCount, decision, timestamp: new Date().toISOString() };
      decisionHistory.push(entry);
      if (decisionHistory.length > 200) decisionHistory = decisionHistory.slice(-100);

      broadcast('decision', entry);

      // 执行
      if (decision.action !== 'wait') {
        try {
          const result = await executeDecision(client, decision);
          log.info(`执行结果:`, result);
        } catch (e) {
          log.error(`执行失败: ${decision.action}`, (e as Error).message);
        }
      }

      // 自适应等待
      const interval = computeInterval(state, decision);
      log.info(`下一轮: ${Math.round(interval / 1000)}秒后`);
      await new Promise(r => setTimeout(r, interval));

    } catch (e) {
      if (e instanceof AuthError) {
        log.warn('认证过期，重新登录...');
        client.setAuth('', ''); // 清除让 ensureAuthenticated 重新登录
        await new Promise(r => setTimeout(r, 3000));
      } else if (e instanceof RateLimitError) {
        log.warn(`被限流，等待 ${e.retryAfter}秒...`);
        await new Promise(r => setTimeout(r, e.retryAfter * 1000));
      } else {
        log.error('循环异常', (e as Error).message);
        await new Promise(r => setTimeout(r, config.pollIntervalMs));
      }
    }
  }
}
