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

  const buildings: Building[] = [];
  if (city) {
    buildings.push({ type: 'warehouse', level: city.warehouse_level });
    buildings.push({ type: 'barracks', level: city.barracks_level });
    buildings.push({ type: 'army_camp', level: city.army_camp_level });
    buildings.push({ type: 'training_ground', level: city.training_ground_level });
    buildings.push({ type: 'market', level: city.market_level });
    buildings.push({ type: 'residence', level: city.residence_level });
    buildings.push({ type: 'conscription_office', level: city.conscription_office_level });
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

  return {
    playerId: ps.player_id, lordLevel: ps.lord_level,
    lordName: city?.name || 'unknown', cityName: city?.name || 'unknown',
    province: city ? `${city.province} ${city.county}` : '',
    prosperity: ps.prosperity,
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
