/**
 * 规则引擎——纯逻辑，无任何 Node/浏览器依赖
 * Node 版和 Web 版共享这份代码
 */
import type { GameState, MapData, Decision, Army, RawRecommendedTarget } from '../types.js';

export interface RuleContext {
  standingDirectives: string[];
}

export function routineDecision(state: GameState, army: Army | undefined, map: MapData | undefined, ctx: RuleContext): Decision | null {
  if (!army) return waitDec('没有可用军队');
  const r = state.resources;
  const armyBusy = army.status !== 'idle';

  // 补兵
  const cityQ = state.raw?.playerState?.hex_q ?? 0;
  const cityR = state.raw?.playerState?.hex_r ?? 0;
  const armyQ = army.raw?.hex_q as number | undefined;
  const armyR = army.raw?.hex_r as number | undefined;
  const inCity = !armyBusy && armyQ === cityQ && armyR === cityR;
  if (!armyBusy && army.totalTroops < army.totalTroopCap && inCity) {
    if (state.reserveTroops > 0) {
      return { analysis: `兵力${army.totalTroops}/${army.totalTroopCap}，补充(预备兵${state.reserveTroops})`, action: 'replenish', params: { armySlot: army.raw?.slot }, reasoning: '补兵不耗体力，优先补满' };
    }
    if (r.copper >= 100) {
      return { analysis: '预备兵耗尽，购买', action: 'market_purchase', params: { item: 'reserve_troops' }, reasoning: '买预备兵' };
    }
  }

  const armyStamina = typeof army.raw?.stamina === 'number' ? army.raw.stamina : state.stamina;

  // 扩张（领地未满 + 有目标）
  if (!armyBusy && armyStamina >= 10 && map && state.ownedResourcePoints.length < state.resourcePointLimit) {
    const targets = (map.recommendedTargets || [])
      .filter((t: RawRecommendedTarget) => t.prediction !== 'danger' && t.recommendation !== 'skip')
      .sort((a: RawRecommendedTarget, b: RawRecommendedTarget) => a.distance - b.distance);
    if (targets.length > 0 && army.totalTroops / army.totalTroopCap > 0.5) {
      const shortage = (['wood', 'stone', 'iron', 'grain'] as ('wood'|'stone'|'iron'|'grain')[]).sort((a, b) => (r[a] || 0) - (r[b] || 0))[0];
      const sorted = [...targets].sort((a, b) =>
        ((a.resource_type === shortage ? -1000 : 0) + a.distance) - ((b.resource_type === shortage ? -1000 : 0) + b.distance)
      );
      const t = sorted[0];
      const isShortage = t.resource_type === shortage;
      return {
        analysis: `扩张 ${t.resource_type}Lv${t.level}(${t.distance}格)${isShortage ? ' [补短板]' : ''}`,
        action: 'march',
        params: { targetQ: t.hex_q, targetR: t.hex_r, targetS: t.hex_s, intent: 'occupy', armySlot: army.raw?.slot },
        reasoning: isShortage ? `${shortage}最短缺` : '最近可用目标',
      };
    }
  }

  // develop（Lv2-5 → Lv7/8）
  if (!armyBusy && armyStamina >= 10 && army.totalTroops / army.totalTroopCap > 0.8) {
    const outerDev = state.ownedResourcePoints.find(rp => rp.level >= 2 && rp.level <= 5 && rp.zone !== 'corridor');
    const innerDev = state.innerResourcePoints.find(rp => rp.level >= 1 && rp.level <= 4);
    const canDevelop = outerDev || innerDev;
    if (canDevelop) {
      const targetLv = 8;
      return {
        analysis: `develop ${canDevelop.resource_type}Lv${canDevelop.level}→Lv${targetLv}`,
        action: 'develop',
        params: { resourcePointId: canDevelop.id, slot: army.raw?.slot },
        reasoning: 'develop跳级',
      };
    }
  }

  // 建筑升级
  const buildPriority = ['warehouse', 'army_camp', 'training_ground', 'barracks', 'conscription_office', 'residence'];
  for (const bType of buildPriority) {
    const b = state.buildings.find(x => x.type === bType);
    if (b && b.level < state.lordLevel) {
      return { analysis: `升级 ${bType} Lv${b.level}→${b.level + 1}`, action: 'build', params: { buildingType: bType }, reasoning: `领主Lv${state.lordLevel}允许` };
    }
  }

  // 弃死地（Lv6/7 不可 develop）
  if (state.ownedResourcePoints.length >= state.resourcePointLimit) {
    const deadLands = state.ownedResourcePoints.filter(rp => rp.level >= 6 && rp.level <= 7).sort((a, b) => a.level - b.level);
    if (deadLands.length > 0) {
      return { analysis: `弃${deadLands[0].resource_type}Lv${deadLands[0].level}(死地)`, action: 'abandon', params: { resourcePointId: deadLands[0].id }, reasoning: '弃死地换Lv8' };
    }
  }

  // resource/upgrade
  const upgradeCosts: Record<number, [number, number, number]> = { 1: [100, 100, 100], 2: [150, 150, 100], 3: [300, 300, 200], 4: [500, 500, 300] };
  const shortageType = (['wood', 'stone', 'iron', 'grain'] as ('wood'|'stone'|'iron'|'grain')[]).sort((a, b) => (r[a] || 0) - (r[b] || 0))[0];
  const upgradeable = state.ownedResourcePoints
    .filter(rp => {
      if (rp.level >= 5 || rp.zone === 'corridor') return false;
      const cost = upgradeCosts[rp.level] || [500, 500, 300];
      return r.wood >= cost[0] && r.stone >= cost[1] && r.iron >= cost[2];
    })
    .sort((a, b) => (a.resource_type === shortageType ? -1 : 0) - (b.resource_type === shortageType ? -1 : 0) || a.level - b.level);
  if (upgradeable.length > 0) {
    const u = upgradeable[0];
    return { analysis: `升级 ${u.resource_type}Lv${u.level}→${u.level + 1}`, action: 'upgrade_resource', params: { resourcePointId: u.id, targetLevel: u.level + 1 }, reasoning: `花资源升级，优先${shortageType}` };
  }

  // 抽卡
  if (state.gachaState.freePulls > 0 || state.gachaState.goldBalance >= 40) {
    return { analysis: '抽卡', action: 'gacha', params: {}, reasoning: '招募将领' };
  }

  // 军队忙
  if (armyBusy) return waitDec(`军队${army.status}中`);

  return null;
}

export function selectBestArmy(armies: Army[]): Army | undefined {
  return [...armies].sort((a, b) => {
    const aI = a.status === 'idle' ? 1 : 0, bI = b.status === 'idle' ? 1 : 0;
    if (aI !== bI) return bI - aI;
    const aS = typeof a.raw?.stamina === 'number' ? a.raw.stamina : 0;
    const bS = typeof b.raw?.stamina === 'number' ? b.raw.stamina : 0;
    const aR = (aS >= 10 && a.totalTroops > 0) ? 1 : 0;
    const bR = (bS >= 10 && b.totalTroops > 0) ? 1 : 0;
    if (aR !== bR) return bR - aR;
    return bS - aS;
  })[0];
}

export function checkEmptyArmy(state: GameState): Decision | null {
  const emptyArmy = state.armies.find(a => a.totalTroopCap === 0 && a.status === 'idle');
  if (!emptyArmy) return null;
  const assignedIds = new Set(state.armies.flatMap(a => a.generals.map(g => g.id)));
  const unassigned = state.generals.filter(g => !assignedIds.has(g.id));
  if (unassigned.length < 3) return null;
  const toAssign = unassigned.slice(0, 3);
  return {
    analysis: `分配将领到军队${emptyArmy.raw?.slot}`,
    action: 'assign_generals',
    params: { assignments: toAssign.map(g => ({ generalId: g.id, troopType: g.troopType || 'infantry' })), armySlot: emptyArmy.raw?.slot },
    reasoning: '双军队',
  };
}

export function makeDecision(state: GameState, map: MapData | undefined, ctx: RuleContext): Decision {
  const assignDec = checkEmptyArmy(state);
  if (assignDec) return assignDec;

  const army = selectBestArmy(state.armies);
  const routine = routineDecision(state, army, map, ctx);
  if (routine) return routine;
  return waitDec('无可用操作');
}

export function waitDec(reason: string): Decision {
  return { analysis: reason, action: 'wait', params: { reason }, reasoning: '等待' };
}
