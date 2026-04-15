/**
 * 纯数据转换——无任何 Node/浏览器依赖
 * Node 版和 Web 版共享这份代码
 */
import type { GameState, MapData, RawStateResponse, RawMapResponse, Army, General, Building, LeaderboardEntry } from '../types.js';

export function normalizeState(raw: RawStateResponse): GameState {
  const ps = raw.playerState;
  const city = raw.cities[0];

  const generals: General[] = (raw.generals || []).map(g => ({
    id: g.id, name: g.name, quality: g.quality, level: g.level,
    might: g.might, intellect: g.intellect, staminaAttr: g.stamina_attr,
    troopType: g.troop_type, troops: g.troops, troopCap: g.troop_cap,
    isDead: g.is_dead, armyId: g.assigned_army_id || g.army_id,
  }));

  const armies: Army[] = (raw.armies || []).map(a => {
    const ag = generals.filter(g => g.armyId === a.id);
    return {
      id: a.id, status: a.status, formation: a.formation,
      totalTroops: ag.reduce((s, g) => s + g.troops, 0),
      totalTroopCap: ag.reduce((s, g) => s + g.troopCap, 0),
      generals: ag,
      march: a.march_target_q != null ? {
        targetQ: a.march_target_q, targetR: a.march_target_r!,
        targetS: a.march_target_s!, arrivalAt: a.march_arrival_at, intent: a.march_intent,
      } : undefined,
      raw: a,
    };
  });

  // 优先用 cityBuildings.details（服务器权威：can_upgrade_now、level_cap、workshop slot 都有）
  // 兜底才从 cities[0] 的扁平字段重构
  const buildings: Building[] = [];
  const cityBuildings = (raw as unknown as Record<string, unknown>).cityBuildings as {
    details?: Array<{
      building_type: string; current_level: number; slot?: number;
      can_upgrade_now?: boolean; prosperity?: number;
    }>;
  } | null;
  const details = cityBuildings?.details;
  if (details && details.length > 0) {
    // workshop 类型在 details 里有多条（slot 1, slot 2），通过 slot 字段或顺序区分
    const slotCounter: Record<string, number> = {};
    for (const d of details) {
      const t = d.building_type;
      const isWorkshop = t.endsWith('_workshop');
      let slot: number | undefined;
      if (isWorkshop) {
        slot = d.slot ?? ((slotCounter[t] = (slotCounter[t] || 0) + 1));
      }
      buildings.push({
        type: t,
        level: d.current_level,
        slot,
        canUpgrade: d.can_upgrade_now,
        prosperity: d.prosperity,
      });
    }
  } else if (city) {
    buildings.push({ type: 'warehouse', level: city.warehouse_level });
    buildings.push({ type: 'army_camp', level: city.army_camp_level });
    buildings.push({ type: 'training_ground', level: city.training_ground_level });
    buildings.push({ type: 'market', level: city.market_level });
    buildings.push({ type: 'residence', level: city.residence_level });
    buildings.push({ type: 'conscription_office', level: city.conscription_office_level });
    // workshop 数组（可能为 [lv1, lv2]）
    const wsTypes = ['wood_workshop', 'stone_workshop', 'iron_workshop', 'grain_workshop'] as const;
    for (const wt of wsTypes) {
      const arr = (city as unknown as Record<string, unknown>)[`${wt}_levels`] as number[] | undefined;
      if (Array.isArray(arr)) {
        arr.forEach((lv, i) => buildings.push({ type: wt, level: lv, slot: i + 1 }));
      }
    }
  }

  const leaderboard: LeaderboardEntry[] = (raw.leaderboard || []).map(e => ({
    playerId: e.player_id, name: e.name, lordLevel: e.lord_level,
    territories: e.territories ?? (e as Record<string, unknown>).occupied_points as number ?? 0,
    troops: e.troops ?? (e as Record<string, unknown>).totalTroops as number ?? 0,
    kills: e.total_kills ?? (e as Record<string, unknown>).total_kills as number ?? 0,
    city: e.city ? { name: e.city.name, hexQ: e.city.hex_q, hexR: e.city.hex_r, hexS: e.city.hex_s } : undefined,
  }));

  const whLevel = city?.warehouse_level || 1;
  const baseCap = 5000 + (whLevel - 1) * 5000;
  const armyStam = (raw.armies?.[0] as Record<string, unknown>)?.stamina;
  const stamina = typeof armyStam === 'number' ? armyStam :
    (armyStam && typeof armyStam === 'object') ? (armyStam as Record<string, number>).current ?? ps.stamina : ps.stamina;

  // 繁荣度：服务器 lordLevelProgress 是权威来源；fallback 到顶层 prosperity
  const llp = (raw as unknown as Record<string, unknown>).lordLevelProgress as Record<string, unknown> | null;
  const prosperity = (llp?.current_prosperity as number | undefined)
    ?? (ps as Record<string, unknown>).prosperity as number | undefined
    ?? (raw as unknown as Record<string, unknown>).prosperity as number | undefined
    ?? 0;
  // 下一级阈值：服务器字段名 next_level_prosperity（确认自探针账号）
  const prosperityNext = llp?.is_max_level
    ? undefined
    : (llp?.next_level_prosperity as number | undefined);

  return {
    playerId: ps.player_id, lordLevel: ps.lord_level,
    lordName: city?.name || 'unknown', cityName: city?.name || 'unknown',
    province: city ? `${city.province} ${city.county}` : '',
    prosperity,
    prosperityNext,
    resources: { wood: ps.wood, stone: ps.stone, iron: ps.iron, grain: ps.grain, copper: ps.copper, gold: ps.gold },
    capacity: { wood: baseCap, stone: baseCap, iron: baseCap, grain: baseCap },
    production: { wood: 0, stone: 0, iron: 0, grain: 0 },
    stamina, maxStamina: 200,
    reserveTroops: ps.reserve_troops, freeRecruits: ps.free_recruits, totalKills: ps.total_kills,
    armies, generals, city, buildings,
    innerResourcePoints: raw.innerResourcePoints || [],
    ownedResourcePoints: raw.ownedResourcePoints || [],
    resourcePointLimit: raw.resourcePointLimit || 10,
    leaderboard,
    marketState: { currentDay: ps.market_state?.current_day || '', purchases: ps.market_state?.purchases || {} },
    gachaState: { freePulls: ps.free_recruits, goldBalance: ps.gold },
    raw,
  };
}

export function normalizeMap(raw: RawMapResponse): MapData {
  return {
    tiles: raw.tiles || [], resourcePoints: raw.resourcePoints || [],
    recommendedTargets: raw.recommended_targets || [],
    scanSummary: {
      bestNeutralTarget: raw.scan_summary?.best_neutral_target ?? undefined,
      bestInvasionTarget: raw.scan_summary?.best_invasion_target ?? undefined,
      actionHint: raw.scan_summary?.action_hint || '',
    },
    seasonPhase: raw.season_phase || '',
  };
}
