import type { GameState, MapData } from '../types.js';

export interface Principle {
  id: string;
  chapter: string;   // 篇名
  maxim: string;     // 原文
  meaning: string;   // 释义
  condition: (state: GameState, map?: MapData) => boolean; // 适用条件
}

export const PRINCIPLES: Principle[] = [
  // ===== 始计篇 — 庙算 =====
  {
    id: 'miaosuan',
    chapter: '始计篇',
    maxim: '夫未战而庙算胜者，得算多也',
    meaning: '开战前充分谋划，胜算越多越好。每轮先全面评估局势再行动。',
    condition: () => true, // 始终适用
  },
  // ===== 作战篇 — 速战 =====
  {
    id: 'bingguishenshu',
    chapter: '作战篇',
    maxim: '兵贵胜，不贵久',
    meaning: '用兵贵在速胜。优先攻击近距离目标，减少行军时间和体力消耗。',
    condition: (state) => {
      const idleArmy = state.armies.find(a => a.status === 'idle');
      return !!idleArmy && idleArmy.totalTroops / idleArmy.totalTroopCap > 0.5;
    },
  },
  // ===== 谋攻篇 — 知己知彼 =====
  {
    id: 'zhijizhibi',
    chapter: '谋攻篇',
    maxim: '知彼知己，百战不殆',
    meaning: '了解敌我双方实力，才能百战百胜。攻击前必须侦察对比实力。',
    condition: () => true,
  },
  {
    id: 'buzhanqu',
    chapter: '谋攻篇',
    maxim: '不战而屈人之兵，善之善者也',
    meaning: '不战就能让敌人屈服是最高策略。能用经济碾压就不硬打。',
    condition: (state) => {
      const myRank = state.leaderboard.findIndex(e => e.playerId === state.playerId);
      return myRank <= 2; // 排名靠前时适用
    },
  },
  // ===== 军形篇 — 先胜后战 =====
  {
    id: 'xianweibukesheng',
    chapter: '军形篇',
    maxim: '先为不可胜，以待敌之可胜',
    meaning: '先确保自己不败，再等待战胜敌人的机会。先稳固防守再谋进攻。',
    condition: (state) => {
      const army = state.armies[0];
      return !!army && army.totalTroops / army.totalTroopCap < 0.5;
    },
  },
  {
    id: 'shengbingxiansheng',
    chapter: '军形篇',
    maxim: '胜兵先胜而后求战，败兵先战而后求胜',
    meaning: '胜利之师先有胜算才开战。只在预测"优势"时发起进攻。',
    condition: (state) => {
      return state.armies.some(a => a.status === 'idle' && a.totalTroops / a.totalTroopCap > 0.6);
    },
  },
  // ===== 兵势篇 — 奇正 =====
  {
    id: 'yizhengheqisheng',
    chapter: '兵势篇',
    maxim: '凡战者，以正合，以奇胜',
    meaning: '正面交锋用正兵，出奇制胜用奇兵。主力推进同时伺机攻击薄弱点。',
    condition: (state) => state.armies.length >= 2,
  },
  // ===== 虚实篇 — 避实击虚 =====
  {
    id: 'bishijixu',
    chapter: '虚实篇',
    maxim: '兵之形，避实而击虚',
    meaning: '用兵之道在于避开强处攻击弱处。选择防守薄弱的资源点进攻。',
    condition: (_state, map) => {
      if (!map) return false;
      return map.recommendedTargets.some(t => t.prediction === 'advantage');
    },
  },
  {
    id: 'yindibianhua',
    chapter: '虚实篇',
    maxim: '因敌变化而取胜者，谓之神',
    meaning: '根据敌人变化灵活调整策略。对手的行动应影响我方决策。',
    condition: (state) => {
      return state.leaderboard.some(e => e.playerId !== state.playerId && e.territories > 0);
    },
  },
  // ===== 军争篇 — 以逸待劳 =====
  {
    id: 'yiyidailao',
    chapter: '军争篇',
    maxim: '以近待远，以逸待劳，以饱待饥',
    meaning: '用近战对远征之敌，用休整好的军队对疲劳之敌。管理体力，等对手消耗后出击。',
    condition: (state) => {
      const army = state.armies[0];
      return !!army && state.stamina < state.maxStamina * 0.3;
    },
  },
  // ===== 九变篇 — 灵活 =====
  {
    id: 'jiubian',
    chapter: '九变篇',
    maxim: '将在外，君命有所不受',
    meaning: '将领在外作战，可以不听从命令。全自动决策，不等人工干预。',
    condition: () => true,
  },
  // ===== 地形篇 — 知天知地 =====
  {
    id: 'zhitiandi',
    chapter: '地形篇',
    maxim: '知天知地，胜乃不穷',
    meaning: '了解天时地利，胜利无穷。利用地图距离和地形优势选择目标。',
    condition: (_state, map) => !!map && map.resourcePoints.length > 0,
  },
  // ===== 火攻篇 — 慎战 =====
  {
    id: 'shenzhan',
    chapter: '火攻篇',
    maxim: '主不可以怒而兴师，将不可以愠而致战',
    meaning: '不可因愤怒而出兵。每次攻击都要理性分析，避免冲动作战。',
    condition: (state) => {
      const army = state.armies[0];
      return !!army && army.totalTroops / army.totalTroopCap < 0.3;
    },
  },
  // ===== 用间篇 — 情报 =====
  {
    id: 'yongjian',
    chapter: '用间篇',
    maxim: '知己知彼之情者，必取于人',
    meaning: '掌握敌情必须靠情报。通过侦察和排行榜收集对手信息。',
    condition: (state) => {
      return state.leaderboard.length > 1;
    },
  },
  // ===== 因粮于敌 =====
  {
    id: 'yinliangyudi',
    chapter: '作战篇',
    maxim: '因粮于敌，故军食可足也',
    meaning: '从敌人那里获取粮草。优先抢占粮食资源点补充产量。',
    condition: (state) => {
      const grainPoints = state.ownedResourcePoints.filter(p => p.type === 'grain');
      return grainPoints.length === 0 || state.resources.grain < 500;
    },
  },
];

/**
 * 根据当前局势选取最相关的兵法原则（最多5条）
 */
export function selectPrinciples(state: GameState, map?: MapData): Principle[] {
  // 始终包含的原则
  const always = PRINCIPLES.filter(p => p.id === 'miaosuan' || p.id === 'zhijizhibi');
  // 条件匹配的原则
  const conditional = PRINCIPLES.filter(p =>
    p.id !== 'miaosuan' && p.id !== 'zhijizhibi' && p.condition(state, map)
  );
  // 合并，最多5条
  const selected = [...always, ...conditional];
  return selected.slice(0, 5);
}

/**
 * 将原则格式化为 prompt 文本
 */
export function formatPrinciples(principles: Principle[]): string {
  return principles.map(p =>
    `【${p.chapter}】${p.maxim}\n  释义: ${p.meaning}`
  ).join('\n\n');
}
