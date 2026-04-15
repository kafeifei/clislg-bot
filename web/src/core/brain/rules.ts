/**
 * 规则引擎——纯逻辑，无任何 Node/浏览器依赖
 * Node 版和 Web 版共享这份代码
 */
import type { GameState, MapData, Decision, Army, Building, RawRecommendedTarget } from '../types.js';

export interface RuleContext {
  standingDirectives: string[];
  // 服务器已报永久错误的决策。
  // key 包含所有"解除封锁需要改变"的变量：action + target + 当前 level + lordLevel
  // 举例：
  //   "build:warehouse@3:lv4"      MAX_LEVEL_REACHED（警告：level 从 3 升到 4 就换 key 了，自动解锁）
  //   "build:residence@10:lv4"     BUILDING_CAP_REACHED（警告：lord 从 4 升到 5 就换 key 了，自动解锁）
  // 这样代码不需要人工监听"升级事件"清缓存 —— state 变化自然让 key 失效
  attemptedFailures?: Set<string>;
}

export function failKey(action: string, target: string, level: number | string, lordLevel: number): string {
  return `${action}:${target}@${level}:lv${lordLevel}`;
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
    const marketBuilt = state.buildings.some(b => b.type === 'market' && b.level > 0);
    // 检查日限（服务器字段：marketState.purchases.reserve_troops / limits.reserve_troops）
    const marketRaw = (state.raw as unknown as Record<string, unknown>).marketState as
      { purchases?: Record<string, number>; limits?: Record<string, number> } | undefined;
    const reserveBought = marketRaw?.purchases?.reserve_troops ?? state.marketState.purchases?.reserve_troops ?? 0;
    const reserveLimit = marketRaw?.limits?.reserve_troops ?? 5;  // 兜底 5
    const marketHasQuota = reserveBought < reserveLimit;
    if (r.copper >= 100 && marketBuilt && marketHasQuota) {
      return { analysis: `预备兵耗尽，购买(${reserveBought}/${reserveLimit})`, action: 'market_purchase', params: { item: 'reserve_troops' }, reasoning: '买预备兵' };
    }
  }

  const armyStamina = typeof army.raw?.stamina === 'number' ? army.raw.stamina : state.stamina;

  // 扩张（领地未满 + 有目标）
  // 兵力阈值：高等级有 cap 时要求 ratio > 0.5（残兵出征 = 送死）；
  // 冷启动 cap 为 0 才用绝对值 > 1000 兜底
  const troopsReady = army.totalTroopCap > 0
    ? (army.totalTroops / army.totalTroopCap > 0.5)
    : army.totalTroops > 1000;
  // 距离上限：recommended_targets 距离单位应 ≤ 20（服务器推荐本来就会限制，但兜底也设一个）
  const MAX_MARCH_DISTANCE = 20;
  if (!armyBusy && armyStamina >= 10 && map && state.ownedResourcePoints.length < state.resourcePointLimit && troopsReady) {
    let targets = (map.recommendedTargets || [])
      .filter((t: RawRecommendedTarget) => t.prediction !== 'danger' && t.recommendation !== 'skip' && t.distance <= MAX_MARCH_DISTANCE)
      .sort((a: RawRecommendedTarget, b: RawRecommendedTarget) => a.distance - b.distance);
    // 降级：recommendedTargets 空 → 用 scan_summary 的 best_neutral（也要距离校验）
    if (targets.length === 0) {
      const best = map.scanSummary?.bestNeutralTarget;
      if (best && best.prediction !== 'danger' && best.distance <= MAX_MARCH_DISTANCE) targets = [best];
    }
    // 二次降级：服务器把低级地全标 'skip'（高领主看不上 Lv1-3），但我们有空槽就值得占
    // 直接扫 map.resourcePoints 找无主点，走 develop 管道 Lv1→Lv8
    if (targets.length === 0) {
      const aq = army.raw?.hex_q as number | undefined;
      const ar = army.raw?.hex_r as number | undefined;
      const as_ = army.raw?.hex_s as number | undefined;
      if (aq != null && ar != null && as_ != null) {
        const neutrals = (map.resourcePoints || [])
          .filter(p => !p.owner_id)
          .map(p => ({ p, d: (Math.abs(p.hex_q - aq) + Math.abs(p.hex_r - ar) + Math.abs(p.hex_s - as_)) / 2 }))
          .filter(x => x.d <= MAX_MARCH_DISTANCE)
          .sort((a, b) => a.d - b.d);
        if (neutrals.length > 0) {
          const t = neutrals[0].p;
          return {
            analysis: `扩张 ${t.resource_type}Lv${t.level}(${neutrals[0].d}格, 兜底)`,
            action: 'march',
            params: { targetQ: t.hex_q, targetR: t.hex_r, targetS: t.hex_s, intent: 'occupy', armySlot: army.raw?.slot },
            reasoning: '服务器标 skip 但有空槽，抓来走 develop',
          };
        }
      }
    }
    if (targets.length > 0) {
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

  // develop（Lv2-5 → Lv7/8）—— 兵力 > 0.5 就够
  const troopsDevelopReady = (army.totalTroopCap > 0 && army.totalTroops / army.totalTroopCap > 0.5) || army.totalTroops > 500;
  if (!armyBusy && armyStamina >= 10 && troopsDevelopReady) {
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
  // 首选数据源：服务器 canUpgrade 标志（cityBuildings.details.can_upgrade_now）
  // 兜底：failKey 记忆（旧流程）
  const failures = ctx.attemptedFailures || new Set<string>();
  const isTried = (bType: string, lv: number, slot?: number) => {
    const key = slot != null ? `${bType}#${slot}` : bType;
    return failures.has(failKey('build', key, lv, state.lordLevel));
  };

  // 市场先到 Lv1（解锁 market_purchase 救命稻草）
  const market = state.buildings.find(x => x.type === 'market');
  if (market && market.level === 0 && market.canUpgrade !== false && !isTried('market', 0)) {
    return { analysis: '建 market Lv0→1', action: 'build', params: { buildingType: 'market' }, reasoning: '解锁预备兵购买' };
  }

  // 按 prosperity（贡献大优先，升级 delta 也更大）/ level 升序兜底
  // canUpgrade 只认 === true（服务器权威），如果服务器没给就靠 failKey 兜底
  const upgradeCandidates = state.buildings
    .filter(b => b.canUpgrade === true)
    .filter(b => !isTried(b.type, b.level, b.slot))
    .sort((a, b) => (b.prosperity ?? 0) - (a.prosperity ?? 0) || a.level - b.level);
  if (upgradeCandidates.length > 0) {
    const b = upgradeCandidates[0];
    const label = b.slot != null ? `${b.type}#${b.slot}` : b.type;
    const params: Record<string, unknown> = { buildingType: b.type };
    if (b.slot != null) params.slot = b.slot;
    return { analysis: `升级 ${label} Lv${b.level}→${b.level + 1}`, action: 'build', params, reasoning: '建筑升级（服务器确认可升）' };
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
      if (failures.has(failKey('upgrade_resource', rp.id, rp.level, state.lordLevel))) return false;
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
  // 开局服务器可能只送 2 个将领；硬卡 3 会死锁。有几个分几个，至少 1 个就上。
  if (unassigned.length < 1) return null;
  const toAssign = unassigned.slice(0, Math.min(3, unassigned.length));
  return {
    analysis: `分配 ${toAssign.length} 将领到军队${emptyArmy.raw?.slot}`,
    action: 'assign_generals',
    params: { assignments: toAssign.map(g => ({ generalId: g.id, troopType: g.troopType || 'infantry' })), armySlot: emptyArmy.raw?.slot },
    reasoning: toAssign.length < 3 ? `开局只有 ${toAssign.length} 个将领，先启动循环` : '双军队',
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
