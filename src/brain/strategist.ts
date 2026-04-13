import { chat, isAvailable } from './ollama.js';
import { selectPrinciples, formatPrinciples } from './sunzi-principles.js';
import { formatGameState } from './state-formatter.js';
import { createLogger } from '../logger.js';
import type { GameState, MapData, Decision, GameEvent } from '../types.js';
import type { LeaderboardData } from '../api/leaderboard.js';

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
  const stateText = formatGameState(state, map);
  const principles = selectPrinciples(state, map);

  const prompt = `你是一位精通《孙子兵法》的军师，正在辅佐主公指挥一个策略游戏。
请用军师的口吻回答主公的问题，引用兵法原则分析。回答简洁有力，不超过200字。

【当前兵法参考】
${formatPrinciples(principles)}

【当前局势】
${stateText}

【主公说】${message}

请回答主公：`;

  try {
    const response = await chat(prompt);
    // 检查是否包含指令性内容
    if (containsDirective(message)) {
      const persistent = message.includes('一直') || message.includes('从现在开始') ||
                         message.includes('持续') || message.includes('优先');
      issueDirective(message, persistent);
    }
    return response;
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
  leaderboard?: LeaderboardData
): Promise<Decision> {
  // 检查 Ollama 是否可用
  const available = await isAvailable();
  if (!available) {
    log.warn('Ollama 不可用，使用规则兜底决策');
    return fallbackDecision(state, map);
  }

  const principles = selectPrinciples(state, map);
  const stateText = formatGameState(state, map);

  // 系统建议（来自 leaderboard API）
  let systemHint = '';
  if (leaderboard?.myPlayer) {
    const mp = leaderboard.myPlayer;
    const parts: string[] = [];
    if (mp.topGuideTask) parts.push(`当前任务: ${mp.topGuideTask}`);
    if (mp.interventionHint) parts.push(`建议: ${mp.interventionHint}`);
    if (mp.stuckReason) parts.push(`卡住原因: ${mp.stuckReason}`);
    if (mp.alerts.length > 0) parts.push(`警报: ${mp.alerts.map(a => a.text).join('; ')}`);
    if (mp.nearby?.closestNeutral) {
      const cn = mp.nearby.closestNeutral;
      parts.push(`最近中立地: ${cn.type}Lv${cn.level} 距离${cn.distance}格 id:${cn.id}`);
    }
    if (parts.length > 0) systemHint = `\n\n【系统建议】（重要参考）\n${parts.join('\n')}`;
  }

  // 构建精简 prompt
  const directivesPart = standingDirectives.length > 0
    ? `\n主公命令: ${standingDirectives.join('; ')}`
    : '';
  const oneTimePart = oneTimeDirective ? `\n主公本轮指令(最高优先): ${oneTimeDirective}` : '';

  let prompt = `你是军师，精通孙子兵法，指挥策略游戏。分析局势后选一个行动。

兵法: ${principles.map(p => p.maxim).join('；')}

${stateText}${systemHint}${directivesPart}${oneTimePart}

可选行动:
- march: 行军攻占 {"targetQ":数字,"targetR":数字,"targetS":数字,"intent":"occupy"}
- develop: 发展已占资源地升级 {"targetQ":数字,"targetR":数字,"targetS":数字,"intent":"develop"}
- abandon: 放弃低级/远距离资源地 {"slot":"资源点id"}
- replenish: 补兵 {}
- build: 升级建筑 {"buildingType":"warehouse"或"barracks"等}
- gacha: 抽卡 {}
- wait: 等待 {"reason":"原因"}

规则: 兵力<30%不进攻; 体力<10不行军; 预测危险则避开
领地策略: 超上限时放弃远处低级地; Lv1地应发展升级; 注意资源类型平衡

只返回JSON，不要其他内容:
{"analysis":"一句话分析","action":"行动类型","params":{参数},"reasoning":"理由"}`;

  try {
    const raw = await chat(prompt, 120000);
    log.debug('模型原始输出:', raw.slice(0, 500));
    const decision = parseDecision(raw);

    // 消费一次性指令
    if (oneTimeDirective) {
      oneTimeDirective = null;
    }

    log.info(`\n${'═'.repeat(50)}`);
    log.info(`军师分析: ${decision.analysis}`);
    log.info(`决策行动: ${decision.action}`);
    log.info(`决策理由: ${decision.reasoning}`);
    log.info('═'.repeat(50));

    return decision;
  } catch (e) {
    log.error('决策失败，使用兜底策略', (e as Error).message);
    return fallbackDecision(state, map);
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
