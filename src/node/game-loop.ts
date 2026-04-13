import { ApiClient, AuthError, RateLimitError } from './api/client.js';
import { ensureAuthenticated } from './api/auth.js';
import { joinSeason } from './api/season.js';
import { getState, getEvents } from './api/state.js';
import { getMapData } from './api/state.js';
import { replenishTroops, startMarch, setFormation, assignGenerals } from './api/army.js';
import { upgradeBuilding, upgradeResource, abandonResource } from './api/building.js';
import { convertResource, purchaseItem } from './api/market.js';
import { pullGacha } from './api/gacha.js';
import { respondToEvent } from './api/events.js';
import { getLastThinking } from './brain/ollama.js';
import { fetchLeaderboard } from './api/leaderboard.js';
import { makeDecision, getLastObservation, observeAsync } from './brain/strategist.js';
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
let lastError: string | null = null; // 上一轮执行失败的信息
let cachedTerritoryCap: number | null = null; // 缓存真实领地上限

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
      return startMarch(client, {
        targetQ: p.targetQ as number,
        targetR: p.targetR as number,
        targetS: p.targetS as number,
        intent: (p.intent as string) || 'occupy',
        confirmed: p.confirmed as boolean | undefined,
        armySlot: p.armySlot as number | undefined,
      });

    case 'develop': {
      // develop 不带 confirmed——如果 API 返回 blocked 说明打不过，不强行出征
      const devResult = await client.post<Record<string, unknown>>('/march/start', {
        intent: 'develop',
        resourcePointId: p.resourcePointId,
        slot: p.slot ?? 1,
      });
      if (devResult.blocked) {
        log.warn(`develop 被拦截: 守军${devResult.guard_troops} vs 我方${devResult.my_troops}，放弃`);
        return { skipped: true, reason: 'blocked', ...devResult };
      }
      return devResult;
    }

    case 'abandon':
      return abandonResource(client, (p.resourcePointId || p.slot || p.id) as string);

    case 'build':
      return upgradeBuilding(client, p.buildingType as string);

    case 'gacha':
      return pullGacha(client);

    case 'assign_generals':
      return assignGenerals(client, p.assignments as { generalId: string; position: number }[], p.armySlot as number | undefined);

    case 'market_convert':
      return convertResource(client, p.from as string, p.to as string, p.amount as number);

    case 'market_purchase':
      return purchaseItem(client, (p.item || p.itemType) as string, p.amount as number | undefined);

    case 'upgrade_resource':
      return client.post('/resource/upgrade', {
        resourcePointId: p.resourcePointId || p.slot,
        targetLevel: p.targetLevel,
      });

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

  // 体力不足时等久一点（体力恢复慢）
  if (state.stamina < 10) return 60000; // 1分钟

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
      let [state, events, map] = await Promise.all([
        getState(client),
        getEvents(client).catch(() => [] as GameEvent[]),
        getMapData(client).catch(() => null as MapData | null),
      ]);
      // 每轮查 leaderboard（系统建议是重要决策参考）
      const lb = await fetchLeaderboard(client.getPlayerId()!).catch(() => undefined);

      // 用 leaderboard 的真实上限覆盖默认值（并缓存）
      if (lb?.myPlayer?.territoryCap) {
        cachedTerritoryCap = lb.myPlayer.territoryCap.max;
      }
      if (cachedTerritoryCap) {
        state.resourcePointLimit = cachedTerritoryCap;
      }

      latestState = state;
      latestMap = map;

      // 状态摘要
      const r = state.resources;
      const army = state.armies[0];
      const troopStr = army ? `兵${army.totalTroops}/${army.totalTroopCap} 体力${state.stamina}` : '无军队';
      log.info(`Lv${state.lordLevel} | 木${r.wood} 石${r.stone} 铁${r.iron} 粮${r.grain} 铜${r.copper} | ${troopStr} | 领地${state.ownedResourcePoints.length}/${state.resourcePointLimit}`);
      if (lb?.myPlayer) {
        const mp = lb.myPlayer;
        const status = mp.observerStatus !== 'healthy' ? ` [${mp.observerStatus}]` : '';
        log.info(`系统: ${mp.topGuideTask || '无'}${status} ${mp.alerts.map(a => a.text).join('; ')}`);
      }
      if (lastError) {
        log.warn(`上轮失败: ${lastError}`);
      }

      // 广播状态
      broadcast('state', { state, map, round: roundCount });

      // 循环决策+执行（瞬间操作可以连续执行多个）
      let actionsThisRound = 0;
      const maxActions = 20; // 防止无限循环
      while (actionsThisRound < maxActions) {
        const decision = await makeDecision(state, events, map ?? undefined, lb, lastError, roundCount);
        lastError = null;

        // 记录决策（附带观察）
        const observation = getLastObservation();
        const entry = { round: roundCount, decision, timestamp: new Date().toISOString(), observation: observation || undefined };
        decisionHistory.push(entry);
        if (decisionHistory.length > 200) decisionHistory = decisionHistory.slice(-100);
        broadcast('decision', entry);

        // wait 或需要等待的操作 → 退出循环
        if (decision.action === 'wait') break;

        try {
          const result = await executeDecision(client, decision);
          log.info(`执行结果:`, result);
          lastError = null;
          actionsThisRound++;

          // 瞬间操作（upgrade_resource, replenish, gacha, abandon）可以继续
          const instantActions = ['upgrade_resource', 'replenish', 'gacha', 'abandon', 'build', 'market_purchase', 'market_convert', 'assign_generals'];
          if (!instantActions.includes(decision.action)) break; // march/develop 等需要等待

          // 刷新状态再继续
          state = await getState(client);
          latestState = state;
        } catch (e) {
          const errMsg = (e as Error).message;
          log.error(`执行失败: ${decision.action}`, errMsg);
          lastError = `执行 ${decision.action} 失败: ${errMsg.slice(0, 200)}`;
          break; // 失败就停
        }
      }
      if (actionsThisRound > 1) log.info(`本轮连续执行 ${actionsThisRound} 个操作`);

      // 模型观察（每轮只调一次，异步不阻塞）
      observeAsync(state, map ?? undefined, lb, lastError, decisionHistory[decisionHistory.length - 1]?.decision ?? null, roundCount);

      // 自适应等待
      const interval = computeInterval(state, { action: actionsThisRound > 0 ? 'done' : 'wait', analysis: '', params: {}, reasoning: '' });
      log.info(`下一轮: ${Math.round(interval / 1000)}秒后`);
      await new Promise(r => setTimeout(r, interval));

    } catch (e) {
      if (e instanceof AuthError) {
        log.warn('认证过期，重新登录...');
        client.clearAuth();
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
