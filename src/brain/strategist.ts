import { chat, isAvailable } from './ollama.js';
import { formatGameState } from './state-formatter.js';
import { createLogger } from '../logger.js';
import type { GameState, MapData, Decision, GameEvent, Army, RawRecommendedTarget } from '../types.js';
import type { LeaderboardData } from '../api/leaderboard.js';

/**
 * 规则引擎：处理所有日常行为，不调模型
 * 返回 null 表示需要模型判断
 */
function routineDecision(state: GameState, army: Army | undefined, map?: MapData): Decision | null {
  if (!army) return wait('没有可用军队');

  const r = state.resources;
  // 1. 军队不空闲 → 但还能做不需要军队的操作（build, upgrade, gacha, abandon）
  const armyBusy = army.status !== 'idle';

  // 2. 补兵（需要军队在城内）
  const cityQ = state.raw?.playerState?.hex_q ?? 0;
  const cityR = state.raw?.playerState?.hex_r ?? 0;
  const armyQ = army.raw?.hex_q as number | undefined;
  const armyR = army.raw?.hex_r as number | undefined;
  const inCity = !armyBusy && armyQ === cityQ && armyR === cityR;
  if (!armyBusy && army.totalTroops < army.totalTroopCap && inCity) {
    if (state.reserveTroops > 0) {
      return {
        analysis: `兵力${army.totalTroops}/${army.totalTroopCap}，补充(预备兵${state.reserveTroops})`,
        action: 'replenish',
        params: { armySlot: army.raw?.slot },
        reasoning: '补兵不耗体力，优先补满',
      };
    }
    // 预备兵耗尽，尝试市场购买
    if (r.copper >= 100) {
      return {
        analysis: `预备兵耗尽，用铜币购买(铜${r.copper})`,
        action: 'market_purchase',
        params: { itemType: 'reserve_troops', amount: 1 },
        reasoning: '预备兵为0无法补兵，从市场购买',
      };
    }
    // 铜币也不够，跳过补兵继续其他操作
  }

  // 当前军队的体力（每支军队独立）
  const armyStamina = typeof army.raw?.stamina === 'number' ? army.raw.stamina : state.stamina;

  // === 先花体力（march/develop），再 build/upgrade ===

  // 3. 有体力 + 军队空闲 + 领地未满 → 扩张领地
  if (!armyBusy && armyStamina >= 10 && map && state.ownedResourcePoints.length < state.resourcePointLimit) {
    const targets = (map.recommendedTargets || [])
      .filter((t: RawRecommendedTarget) => t.prediction !== 'danger' && t.recommendation !== 'skip');

    if (targets.length > 0 && army.totalTroops / army.totalTroopCap > 0.5) {
      // 找出最短缺的资源类型
      const resTypes = ['wood', 'stone', 'iron', 'grain'] as const;
      const resCounts = resTypes.map(rt => ({
        type: rt,
        amount: r[rt] || 0,
      })).sort((a, b) => a.amount - b.amount);
      const shortage = resCounts[0].type; // 最少的资源

      // 优先选短缺类型 + 近距离的目标
      const sorted = [...targets].sort((a, b) => {
        const aMatch = a.resource_type === shortage ? -1000 : 0;
        const bMatch = b.resource_type === shortage ? -1000 : 0;
        return (aMatch + a.distance) - (bMatch + b.distance);
      });

      const t = sorted[0];
      const isShortage = t.resource_type === shortage;
      return {
        analysis: `扩张 ${t.resource_type}Lv${t.level}(${t.distance}格)${isShortage ? ' [补短板]' : ''}`,
        action: 'march',
        params: { targetQ: t.hex_q, targetR: t.hex_r, targetS: t.hex_s, intent: 'occupy', armySlot: army.raw?.slot },
        reasoning: isShortage ? `${shortage}最短缺(${resCounts[0].amount})，优先补` : '最近可用目标',
      };
    }
  }

  // 4. 有体力 + 军队空闲 + 兵力>80% → develop
  if (!armyBusy && armyStamina >= 10 && army.totalTroops / army.totalTroopCap > 0.8) {
    // 外城 Lv2-5 可 develop（跳到 Lv7/Lv8），内城 Lv1-4 可 develop（逐级到 Lv5）
    const outerDev = state.ownedResourcePoints.find(rp =>
      rp.level >= 2 && rp.level <= 5 && rp.zone !== 'corridor'
    );
    const innerDev = state.innerResourcePoints.find(rp => rp.level >= 1 && rp.level <= 4);
    const canDevelop = outerDev || innerDev;
    if (canDevelop) {
      const targetLv = 8; // develop 最终目标都是 Lv8
      return {
        analysis: `develop ${canDevelop.resource_type}Lv${canDevelop.level}→Lv${targetLv}(战斗跳级)`,
        action: 'develop',
        params: { resourcePointId: canDevelop.id, slot: army.raw?.slot },
        reasoning: `先花体力develop，API会拦截打不过的`,
      };
    }
  }

  // 5. 升级建筑（不需要军队不需要体力，一次性提升，优先于 upgrade）
  const buildPriority = ['warehouse', 'army_camp', 'training_ground', 'barracks', 'conscription_office', 'residence'];
  for (const bType of buildPriority) {
    const b = state.buildings.find(x => x.type === bType);
    if (b && b.level < state.lordLevel) {
      return {
        analysis: `升级建筑 ${bType} Lv${b.level}→Lv${b.level + 1}`,
        action: 'build',
        params: { buildingType: bType },
        reasoning: `领主Lv${state.lordLevel}允许建筑升到Lv${state.lordLevel}`,
      };
    }
  }

  // 5.5 领地满 + 有 Lv6/7 地（不可 develop 的死地）→ 放弃最低级的，腾空间
  if (state.ownedResourcePoints.length >= state.resourcePointLimit) {
    const deadLands = state.ownedResourcePoints
      .filter(rp => rp.level >= 6 && rp.level <= 7)
      .sort((a, b) => a.level - b.level); // 最低级的先弃
    if (deadLands.length > 0) {
      const target = deadLands[0];
      return {
        analysis: `弃${target.resource_type}Lv${target.level}(不可develop的死地)，腾空间换Lv8`,
        action: 'abandon',
        params: { resourcePointId: target.id },
        reasoning: 'Lv6/7地不能develop也不能upgrade，弃掉换新地升到Lv8',
      };
    }
  }

  // 6. resource/upgrade（花资源升级涨繁荣度）
  const upgradeCosts: Record<number, [number,number,number]> = { 1:[100,100,100], 2:[150,150,100], 3:[300,300,200], 4:[500,500,300] };
  const r2 = state.resources;
  const resAmounts = { wood: r2.wood, stone: r2.stone, iron: r2.iron, grain: r2.grain };
  const shortageType = (Object.entries(resAmounts) as [string,number][]).sort((a,b) => a[1] - b[1])[0][0];
  const upgradeable = state.ownedResourcePoints
    .filter(rp => {
      if (rp.level >= 5 || rp.zone === 'corridor') return false;
      const cost = upgradeCosts[rp.level] || [500,500,300];
      return r2.wood >= cost[0] && r2.stone >= cost[1] && r2.iron >= cost[2];
    })
    .sort((a, b) => {
      const aMatch = a.resource_type === shortageType ? -1 : 0;
      const bMatch = b.resource_type === shortageType ? -1 : 0;
      return aMatch - bMatch || a.level - b.level;
    });
  const outerCanUpgrade = upgradeable[0];
  if (outerCanUpgrade) {
    return {
      analysis: `升级 ${outerCanUpgrade.resource_type}Lv${outerCanUpgrade.level}→Lv${outerCanUpgrade.level + 1}`,
      action: 'upgrade_resource',
      params: { resourcePointId: outerCanUpgrade.id, targetLevel: outerCanUpgrade.level + 1 },
      reasoning: `花资源升级涨繁荣度，优先补${shortageType}`,
    };
  }

  // 7. 抽卡
  if (state.gachaState.freePulls > 0 || state.gachaState.goldBalance >= 40) {
    return {
      analysis: `抽卡(免费${state.gachaState.freePulls}/金${state.gachaState.goldBalance})`,
      action: 'gacha',
      params: {},
      reasoning: '招募将领',
    };
  }

  // 军队在外且没有其他可做的 → wait
  if (armyBusy) {
    return wait(`军队${army.status}中，无其他操作可做`);
  }

  // 以上都不满足 → 交给模型
  return null;
}

function wait(reason: string): Decision {
  return {
    analysis: reason,
    action: 'wait',
    params: { reason },
    reasoning: '以逸待劳',
  };
}

const log = createLogger('军师');

// 主公持续性指令
let standingDirectives: string[] = [];
// 主公一次性指令（用完即删）
let oneTimeDirective: string | null = null;

/**
 * 主公下达指令
 */
export function issueDirective(directive: string, persistent: boolean) {
  if (persistent) {
    standingDirectives.push(directive);
    log.info(`收到持续性指令: ${directive}`);
  } else {
    oneTimeDirective = directive;
    log.info(`收到一次性指令: ${directive}`);
  }
}

/**
 * 移除持续性指令
 */
export function removeDirective(index: number) {
  if (index >= 0 && index < standingDirectives.length) {
    const removed = standingDirectives.splice(index, 1);
    log.info(`移除指令: ${removed[0]}`);
  }
}

export function getDirectives(): string[] {
  return [...standingDirectives];
}

/**
 * 与主公对话（非决策场景）
 */
export async function chatWithLord(message: string, state: GameState, map?: MapData): Promise<string> {
  const r = state.resources;
  const army = state.armies[0];

  // 构建有意义的局势描述
  const parts: string[] = [];
  parts.push(`领主Lv${state.lordLevel} 繁荣度${state.prosperity}(升Lv2需3000)`);
  parts.push(`资源: 木${r.wood} 石${r.stone} 铁${r.iron} 粮${r.grain} 铜${r.copper} (仓库上限5000)`);
  if (army) {
    parts.push(`军队: ${army.status} 兵${army.totalTroops}/${army.totalTroopCap} 体力${state.stamina}/200`);
    parts.push(`将领: ${army.generals.map(g => `${g.name}Lv${g.level}`).join(' ')}`);
  }
  parts.push(`领地: ${state.ownedResourcePoints.length}/${state.resourcePointLimit}`);
  parts.push(`排行: ${state.leaderboard.map((e,i) => `${i+1}.${e.name}(Lv${e.lordLevel}领地${e.territories})`).join(' ')}`);

  if (standingDirectives.length > 0) {
    parts.push(`当前执行中的命令: ${standingDirectives.join('; ')}`);
  }

  const prompt = `当前局势:
${parts.join('\n')}

主公说: "${message}"

用中文简洁回答。如果主公在下命令，回答"遵命"并说明你会怎么做。不要反驳主公。不超过150字。`;

  try {
    const response = await chat(prompt, 30000);
    // 检查是否包含指令性内容
    if (containsDirective(message)) {
      const persistent = message.includes('一直') || message.includes('从现在开始') ||
                         message.includes('持续') || message.includes('优先');
      issueDirective(message, persistent);
    }
    // 清理 thinking 标签
    let clean = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!clean) {
      const thinkMatch = response.match(/<think>([\s\S]*?)<\/think>/);
      clean = thinkMatch ? thinkMatch[1].trim().split('\n').pop() || '遵命。' : '遵命，主公。';
    }
    return clean;
  } catch (e) {
    log.error('与主公对话失败', (e as Error).message);
    return '军师思考中断，请稍后再试。';
  }
}

function containsDirective(msg: string): boolean {
  const keywords = ['先', '别', '不要', '停止', '集中', '攻击', '防守', '发展', '优先', '转为', '切换'];
  return keywords.some(k => msg.includes(k));
}

/**
 * 核心决策：分析局势并返回行动
 */
export async function makeDecision(
  state: GameState,
  events: GameEvent[],
  map?: MapData,
  leaderboard?: LeaderboardData,
  lastError?: string | null,
  round?: number
): Promise<Decision> {
  // 选最佳军队：优先 idle + 体力够 + 有兵的
  const army = [...state.armies]
    .sort((a, b) => {
      const aIdle = a.status === 'idle' ? 1 : 0;
      const bIdle = b.status === 'idle' ? 1 : 0;
      if (aIdle !== bIdle) return bIdle - aIdle;
      // 体力够的优先
      const aStam = typeof a.raw?.stamina === 'number' ? a.raw.stamina : 0;
      const bStam = typeof b.raw?.stamina === 'number' ? b.raw.stamina : 0;
      const aReady = (aStam >= 10 && a.totalTroops > 0) ? 1 : 0;
      const bReady = (bStam >= 10 && b.totalTroops > 0) ? 1 : 0;
      if (aReady !== bReady) return bReady - aReady;
      // 体力多的优先
      return bStam - aStam;
    })[0];

  // 第二军队空的（0将领）→ 需要先分配将领
  const emptyArmy = state.armies.find(a => a.totalTroopCap === 0 && a.status === 'idle');
  if (emptyArmy) {
    // 找未分配的将领
    const assignedIds = new Set(state.armies.flatMap(a => a.generals.map(g => g.id)));
    const unassigned = state.generals.filter(g => !assignedIds.has(g.id));
    if (unassigned.length >= 3) {
      const toAssign = unassigned.slice(0, 3);
      log.info(`分配将领到第二军队: ${toAssign.map(g => g.name).join(', ')}`);
      return {
        analysis: `第二军队空闲无将领，分配${toAssign.map(g => g.name).join('/')}`,
        action: 'assign_generals',
        params: {
          assignments: toAssign.map(g => ({ generalId: g.id, troopType: g.troopType || 'infantry' })),
          armySlot: emptyArmy.raw?.slot,
        },
        reasoning: '双军队同时行动效率翻倍',
      };
    }
  }

  // ===== 规则引擎始终做决策 =====
  const routine = routineDecision(state, army, map);

  // ===== 模型观察（每轮只调一次，由 game-loop 控制）=====
  // observeAsync 改为手动调用，不在这里自动触发

  if (routine) {
    log.info(`规则引擎: ${routine.action} — ${routine.analysis}`);
    return routine;
  }

  // 规则引擎无法决策时 fallback
  return fallbackDecision(state, map);
}

// 操作历史（给模型上下文）
const recentActions: string[] = [];

function recordAction(round: number, action: string, analysis: string, success: boolean) {
  recentActions.push(`轮${round}: ${action} ${success ? '✓' : '✗'} ${analysis}`);
  if (recentActions.length > 10) recentActions.shift();
}

// 最新模型观察（供 Web 面板展示）
let lastObservation = '';
export function getLastObservation(): string { return lastObservation; }

/**
 * 模型异步观察——不阻塞决策，每轮评估局势
 */
export async function observeAsync(
  state: GameState, map: MapData | undefined,
  leaderboard: LeaderboardData | undefined,
  lastError: string | null | undefined,
  currentDecision: Decision | null,
  round?: number
) {
  // 记录本轮操作到历史
  if (currentDecision && round) {
    recordAction(round, currentDecision.action, currentDecision.analysis, !lastError);
  }

  // 每 3 轮让模型观察一次
  if (!round || round % 3 !== 0) return;

  const available = await isAvailable();
  if (!available) return;

  const r = state.resources;
  const army = state.armies[0];
  const olvs: Record<number, number> = {};
  for (const rp of state.ownedResourcePoints) { olvs[rp.level] = (olvs[rp.level] || 0) + 1; }

  const context = [
    `Lv${state.lordLevel} 繁荣度${state.prosperity} 体力${state.stamina}/200`,
    `兵${army?.totalTroops || 0}/${army?.totalTroopCap || 0} 军队${army?.status || '?'} 预备兵${state.reserveTroops}`,
    `外城${state.ownedResourcePoints.length}/${state.resourcePointLimit} 等级:${JSON.stringify(olvs)}`,
    `资源: 木${r.wood} 石${r.stone} 铁${r.iron} 粮${r.grain} 铜${r.copper}`,
    `排行: ${state.leaderboard.map((e,i) => `${i+1}.${e.name}Lv${e.lordLevel}`).join(' ')}`,
  ];

  if (leaderboard?.myPlayer) {
    const mp = leaderboard.myPlayer;
    if (mp.topGuideTask) context.push(`系统任务: ${mp.topGuideTask}`);
    if (mp.observerStatus !== 'healthy') context.push(`系统状态: ${mp.observerStatus}`);
    if (mp.alerts.length) context.push(`警报: ${mp.alerts.map(a => a.text).join('; ')}`);
  }
  if (lastError) context.push(`上轮错误: ${lastError.slice(0, 100)}`);
  if (currentDecision) context.push(`本轮规则引擎决策: ${currentDecision.action} — ${currentDecision.analysis}`);
  if (recentActions.length) context.push(`最近操作:\n${recentActions.join('\n')}`);

  const prompt = `你是 SLG 游戏的军师观察员。审视当前局势和最近操作，给出简短评价（2-3句话）：
- 规则引擎做得对不对？有没有遗漏？
- 当前最大的瓶颈或风险是什么？
- 有什么建议？

${context.join('\n')}`;

  try {
    const obs = await chat(prompt, 30000);
    const clean = obs.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (clean) {
      lastObservation = clean;
      log.info(`军师观察: ${clean.slice(0, 200)}`);
    }
  } catch {
    // 观察失败不影响运行
  }
}

/**
 * 解析模型输出为 Decision
 */
function parseDecision(raw: string): Decision {
  // 尝试提取 JSON（模型可能输出了额外文本）
  let jsonStr = raw.trim();

  // 如果有 think 标签，先尝试从 think 内容里提取 JSON
  const thinkMatch = jsonStr.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    const afterThink = jsonStr.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    // 如果 think 外面有内容，用外面的；否则从 think 里找 JSON
    if (afterThink) {
      jsonStr = afterThink;
    } else {
      jsonStr = thinkMatch[1];
    }
  }

  // 尝试直接解析
  try {
    return JSON.parse(jsonStr) as Decision;
  } catch {}

  // 尝试从文本中提取 JSON 块
  const jsonMatch = jsonStr.match(/\{[\s\S]*"action"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]) as Decision;
    } catch {}
  }

  // 尝试去掉 markdown 代码块
  const codeBlock = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try {
      return JSON.parse(codeBlock[1]) as Decision;
    } catch {}
  }

  log.warn('无法解析模型输出，返回等待决策');
  log.debug('模型原始输出:', raw.slice(0, 1000));
  return {
    analysis: '模型输出无法解析',
    action: 'wait',
    params: { reason: '模型输出格式错误，等待下一轮' },
    reasoning: raw.slice(0, 200),
  };
}

/**
 * Ollama 不可用时的规则兜底决策
 */
function fallbackDecision(state: GameState, map?: MapData): Decision {
  const army = state.armies[0];
  if (!army) {
    return { analysis: '无军队', action: 'wait', params: { reason: '没有可用军队' }, reasoning: '兜底' };
  }

  const troopPct = army.totalTroops / army.totalTroopCap;

  // 补兵优先
  if (troopPct < 0.8 && army.status === 'idle') {
    return {
      analysis: '兵力不足，需要补充',
      action: 'replenish',
      params: { armySlot: 0 },
      reasoning: '兜底规则：兵力低于80%自动补充',
    };
  }

  // 抽卡
  if (state.gachaState && (state.gachaState.freePulls > 0 || state.gachaState.goldBalance >= 40)) {
    return {
      analysis: '有抽卡机会',
      action: 'gacha',
      params: {},
      reasoning: '兜底规则：有免费抽卡或足够金币',
    };
  }

  // 攻击优势目标
  if (army.status === 'idle' && troopPct > 0.6 && map) {
    const targets = map.recommendedTargets
      .filter(t => t.prediction === 'advantage');
    if (targets.length > 0) {
      const target = targets[0];
      return {
        analysis: `发现优势目标: ${target.resource_type}Lv${target.level}`,
        action: 'march',
        params: {
          targetQ: target.hex_q,
          targetR: target.hex_r,
          targetS: target.hex_s,
          intent: 'occupy',
          armySlot: 0,
        },
        reasoning: '兜底规则：攻击最近的优势目标',
      };
    }
  }

  return {
    analysis: '当前无紧急行动',
    action: 'wait',
    params: { reason: '等待时机' },
    reasoning: '兜底规则：按兵不动',
  };
}
