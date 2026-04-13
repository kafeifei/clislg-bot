import { api, getPlayerId } from './api/client.js';
import { executeDecision } from './api/actions.js';
import { normalizeState, normalizeMap } from '../../src/core/api/state.js';
import { makeDecision } from '../../src/core/brain/rules.js';
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

    // leaderboard
    const lbRaw = await fetch(LEADERBOARD_URL).then(r => r.json()).catch(() => null) as Record<string, unknown> | null;
    let lb: LeaderboardData | undefined;
    if (lbRaw) {
      lb = lbRaw as unknown as LeaderboardData;
      const players = (lbRaw.players || []) as Record<string, unknown>[];
      const me = players.find(p => p.id === getPlayerId());
      if (me?.territoryCap) cachedTerritoryCap = (me.territoryCap as { max: number }).max;
    }
    if (cachedTerritoryCap) state.resourcePointLimit = cachedTerritoryCap;

    latestState = state;
    latestMap = map ?? null;
    emit('state', { state, map, round: roundCount, leaderboard: lb });

    if (botRunning) {
      let actionsThisRound = 0;
      while (actionsThisRound < 20) {
        const decision = makeDecision(state, map, { standingDirectives });
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
          console.error('执行失败:', decision.action, lastError);
          break;
        }
      }
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
