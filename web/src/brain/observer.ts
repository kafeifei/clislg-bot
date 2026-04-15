/**
 * 模型观察者——每 3 轮让 AI 军师点评局势（纯展示，不影响决策）
 */
import { createAIProvider } from './ai-provider.js';
import { GAME_RULES } from '../core/brain/game-rules.js';
import type { GameState, MapData, Decision, LeaderboardData } from '../core/types.js';

const recentActions: string[] = [];
const MAX_RECENT = 15;

export function recordAction(round: number, action: string, analysis: string, success: boolean) {
  const mark = success ? '✓' : '✗';
  recentActions.push(`R${round} ${mark} ${action}: ${analysis.slice(0, 50)}`);
  if (recentActions.length > MAX_RECENT) recentActions.shift();
}

let lastObservation = '';
let observing = false;
export function getLastObservation() { return lastObservation; }

/**
 * 异步观察——不阻塞主循环
 */
export async function observeAsync(
  state: GameState,
  _map: MapData | undefined,
  lb: LeaderboardData | undefined,
  lastError: string | null,
  currentDecision: Decision | null,
  round: number,
  onResult: (text: string) => void,
) {
  if (currentDecision) {
    recordAction(round, currentDecision.action, currentDecision.analysis, !lastError);
  }

  // 每 3 轮观察一次；避免重叠调用
  if (round % 3 !== 0 || observing) return;

  const provider = createAIProvider();
  if (provider.name === '无 AI') return;

  observing = true;
  try {
    const r = state.resources;
    const army = state.armies[0];
    const olvs: Record<number, number> = {};
    for (const rp of state.ownedResourcePoints) { olvs[rp.level] = (olvs[rp.level] || 0) + 1; }

    const context: string[] = [
      `Lv${state.lordLevel} 繁荣度${state.prosperity} 体力${state.stamina}/200`,
      `兵${army?.totalTroops || 0}/${army?.totalTroopCap || 0} 军队${army?.status || '?'} 预备兵${state.reserveTroops}`,
      `外城${state.ownedResourcePoints.length}/${state.resourcePointLimit} 等级:${JSON.stringify(olvs)}`,
      `资源: 木${r.wood} 石${r.stone} 铁${r.iron} 粮${r.grain} 铜${r.copper}`,
    ];
    if (lb?.myPlayer) {
      const mp = (lb as unknown as { myPlayer: { topGuideTask?: string; observerStatus?: string; alerts?: { text: string }[] } }).myPlayer;
      if (mp.topGuideTask) context.push(`系统任务: ${mp.topGuideTask}`);
      if (mp.observerStatus && mp.observerStatus !== 'healthy') context.push(`系统状态: ${mp.observerStatus}`);
      if (mp.alerts?.length) context.push(`警报: ${mp.alerts.map(a => a.text).join('; ')}`);
    }
    if (lastError) context.push(`上轮错误: ${lastError.slice(0, 100)}`);
    if (currentDecision) context.push(`本轮决策: ${currentDecision.action} — ${currentDecision.analysis}`);
    if (recentActions.length) context.push(`最近操作:\n${recentActions.join('\n')}`);

    const prompt = `你是 SLG 游戏的军师观察员。审视当前局势和最近操作，给出简短评价（2-3句话）：
- 规则引擎做得对不对？有没有遗漏？
- 当前最大的瓶颈或风险是什么？
- 有什么建议？

${context.join('\n')}`;

    const result = await provider.chat([
      { role: 'system', content: GAME_RULES + '\n你是军师观察员。' },
      { role: 'user', content: prompt },
    ], false);

    const clean = result.reply.trim();
    if (clean) {
      lastObservation = clean;
      onResult(clean);
    }
  } catch {
    // 观察失败不影响运行
  } finally {
    observing = false;
  }
}
