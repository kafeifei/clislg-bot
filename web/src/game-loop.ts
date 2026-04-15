import { api, getPlayerId } from './api/client.js';
import { executeDecision } from './api/actions.js';
import { normalizeState, normalizeMap } from '../../src/core/api/state.js';
import { makeDecision, failKey } from '../../src/core/brain/rules.js';
import { observeAsync } from './brain/observer.js';
import type { GameState, MapData, Decision, RawStateResponse, RawMapResponse, LeaderboardData } from '../../src/core/types.js';

const LEADERBOARD_URL = 'https://clislg.filo.ai/api/leaderboard';
const INSTANT_ACTIONS = ['upgrade_resource', 'replenish', 'gacha', 'abandon', 'build', 'market_purchase', 'assign_generals'];

// 状态
let botRunning = false;
let botTimer: ReturnType<typeof setTimeout> | null = null;
let roundCount = 0;
let latestState: GameState | null = null;
let latestMap: MapData | null = null;
let cachedTerritoryCap: number | null = null;
let lastError: string | null = null;
let standingDirectives: string[] = [];
let decisionHistory: { round: number; decision: Decision; timestamp: string }[] = [];
let seenBattleTurns = new Set<number>();
let seenAlertKeys = new Set<string>();
let seenLossKeys = new Set<string>();
// 失败记忆：key 形如 "build:warehouse@4"、"upgrade_resource:rp_123@5"
// level 变化后 key 自动失效，无需人工清理
let attemptedFailures = new Set<string>();

// 回调
type Listener = (event: string, data: unknown) => void;
const listeners: Listener[] = [];
export function onEvent(fn: Listener) { listeners.push(fn); }
function emit(event: string, data: unknown) { listeners.forEach(fn => fn(event, data)); }

// 导出状态
export function getState() { return latestState; }
export function getMap() { return latestMap; }
export function getRound() { return roundCount; }
export function getDecisions() { return decisionHistory; }
export function isRunning() { return botRunning; }
export function addDirective(d: string) { standingDirectives.push(d); }
export function getDirectives() { return [...standingDirectives]; }

export async function gameLoopTick() {
  try {
    roundCount++;
    emit('round', roundCount);

    const [rawState, rawMap] = await Promise.all([
      api<RawStateResponse>('GET', '/state'),
      api<RawMapResponse>('GET', '/map/nearby').catch(() => null),
    ]);

    const state = normalizeState(rawState);
    const map = rawMap ? normalizeMap(rawMap) : undefined;

    // state.recentLosses：被 PvP 夺走的地（leaderboard.battles 不含 PvP）
    const recentLosses = (rawState as unknown as Record<string, unknown>).recentLosses as
      Array<{ attacker_name: string; created_at: string; location: string; point_name: string }> | undefined;
    if (recentLosses) {
      const firstLossScan = seenLossKeys.size === 0;
      for (const l of recentLosses) {
        const key = `${l.created_at}|${l.location}`;
        if (seenLossKeys.has(key)) continue;
        seenLossKeys.add(key);
        if (firstLossScan) continue; // 首轮只记录，避免历史刷屏
        emit('loss', {
          round: roundCount,
          attacker: l.attacker_name,
          location: l.location,
          point: l.point_name,
          timestamp: l.created_at,
        });
      }
    }

    // leaderboard
    const lbRaw = await fetch(LEADERBOARD_URL).then(r => r.json()).catch(() => null) as Record<string, unknown> | null;
    let lb: LeaderboardData | undefined;
    const myId = getPlayerId();
    if (lbRaw) {
      lb = lbRaw as unknown as LeaderboardData;
      const players = (lbRaw.players || []) as Record<string, unknown>[];
      const me = players.find(p => p.id === myId);
      if (me?.territoryCap) cachedTerritoryCap = (me.territoryCap as { max: number }).max;

      // 发现与我相关的新战斗
      const battles = (lbRaw.battles || []) as Array<{ turn: number; attackerId: string; defenderId: string | null; result: string; attackerLosses: number; defenderLosses: number; territoryCaptured?: boolean; cityCaptured?: boolean }>;
      // 首轮只记录，不推送（避免历史战斗一次刷屏）
      const firstScan = seenBattleTurns.size === 0;
      for (const b of battles) {
        if (seenBattleTurns.has(b.turn)) continue;
        seenBattleTurns.add(b.turn);
        if (firstScan) continue;
        if (!myId) continue;
        if (b.attackerId !== myId && b.defenderId !== myId) continue;
        const iAmAttacker = b.attackerId === myId;
        const won = (iAmAttacker && b.result === 'attacker_win') || (!iAmAttacker && b.result === 'defender_win');
        emit('battle', {
          round: roundCount,
          role: iAmAttacker ? 'attacker' : 'defender',
          won,
          myLosses: iAmAttacker ? b.attackerLosses : b.defenderLosses,
          enemyLosses: iAmAttacker ? b.defenderLosses : b.attackerLosses,
          territoryCaptured: !!b.territoryCaptured,
          cityCaptured: !!b.cityCaptured,
          timestamp: new Date().toISOString(),
        });
      }

      // 服务器告警（stuck/intervention 等）
      const myPlayer = (lbRaw.myPlayer || null) as { alerts?: Array<{ level: string; text: string }>; stuckReason?: string } | null;
      const alerts = myPlayer?.alerts || [];
      for (const a of alerts) {
        const key = `${a.level}:${a.text}`;
        if (seenAlertKeys.has(key)) continue;
        seenAlertKeys.add(key);
        emit('alert', { round: roundCount, level: a.level, text: a.text, timestamp: new Date().toISOString() });
      }
    }
    if (cachedTerritoryCap) state.resourcePointLimit = cachedTerritoryCap;

    latestState = state;
    latestMap = map ?? null;
    emit('state', { state, map, round: roundCount, leaderboard: lb });

    if (botRunning) {
      let actionsThisRound = 0;
      while (actionsThisRound < 20) {
        const decision = makeDecision(state, map, { standingDirectives, attemptedFailures });
        lastError = null;

        const entry = { round: roundCount, decision, timestamp: new Date().toISOString() };
        decisionHistory.push(entry);
        if (decisionHistory.length > 200) decisionHistory = decisionHistory.slice(-100);
        emit('decision', entry);

        if (decision.action === 'wait') break;

        try {
          await executeDecision(decision);
          actionsThisRound++;
          if (!INSTANT_ACTIONS.includes(decision.action)) break;
          // 刷新状态
          const refreshed = normalizeState(await api<RawStateResponse>('GET', '/state'));
          Object.assign(state, refreshed);
          latestState = state;
        } catch (e: unknown) {
          const err = e as { data?: { error?: string }; message?: string };
          lastError = err.data?.error || err.message || 'unknown';
          // 永久错误 → 记 (action,target,level,lordLevel)
          // level 或 lordLevel 变化后 key 自动失效，完全自洽
          const fatal = /MAX_LEVEL_REACHED|ALREADY_MAX|BUILDING_CAP_REACHED|INVALID_BUILDING_TYPE|INVALID_TARGET|NOT_FOUND|FORBIDDEN/i.test(lastError);
          if (fatal) {
            if (decision.action === 'build' && decision.params?.buildingType) {
              const bType = String(decision.params.buildingType);
              const slot = decision.params.slot != null ? Number(decision.params.slot) : undefined;
              const b = state.buildings.find(x => x.type === bType && (slot == null || x.slot === slot));
              const key = slot != null ? `${bType}#${slot}` : bType;
              attemptedFailures.add(failKey('build', key, b?.level ?? 0, state.lordLevel));
            } else if (decision.action === 'upgrade_resource' && decision.params?.resourcePointId) {
              const rpId = String(decision.params.resourcePointId);
              const rp = state.ownedResourcePoints.find(x => x.id === rpId);
              attemptedFailures.add(failKey('upgrade_resource', rpId, rp?.level ?? 0, state.lordLevel));
            }
          }
          console.error('执行失败:', decision.action, lastError, fatal ? '(已记)' : '');
          break;
        }
      }
    }

    // 模型观察（每 3 轮，异步不阻塞）
    if (botRunning) {
      const lastDecision = decisionHistory[decisionHistory.length - 1]?.decision ?? null;
      observeAsync(state, map, lb, lastError, lastDecision, roundCount, (text) => {
        emit('observation', { round: roundCount, text, timestamp: new Date().toISOString() });
      });
    }

    // 自适应间隔
    let interval = botRunning ? 15000 : 30000;
    for (const army of state.armies) {
      if (army.status === 'marching' && army.march?.arrivalAt) {
        const eta = new Date(army.march.arrivalAt).getTime() - Date.now();
        if (eta > 0) interval = Math.min(eta + 3000, 120000);
      }
    }
    const armyStam = typeof state.armies[0]?.raw?.stamina === 'number' ? state.armies[0].raw.stamina : state.stamina;
    if (armyStam < 10 && botRunning) interval = 60000;

    botTimer = setTimeout(gameLoopTick, interval);
  } catch (e) {
    console.error('循环异常:', e);
    botTimer = setTimeout(gameLoopTick, 15000);
  }
}

export function startBot() {
  botRunning = true;
  emit('botStatus', true);
  if (!botTimer) gameLoopTick();
}

export function stopBot() {
  botRunning = false;
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  emit('botStatus', false);
}

export function toggleBot() {
  if (botRunning) stopBot(); else startBot();
}

// 首次拉取状态（不启动 bot）
export function fetchOnce() {
  gameLoopTick();
}
