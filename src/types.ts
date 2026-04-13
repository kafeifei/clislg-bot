// ========== 认证 ==========
export interface AuthResult {
  token: string;
  playerId: string;
  expiresAt?: string;
}

// ========== 原始 API 响应（snake_case） ==========

export interface RawPlayerState {
  player_id: string;
  season_id: string;
  lord_level: number;
  prosperity: number;
  wood: number;
  stone: number;
  iron: number;
  grain: number;
  copper: number;
  gold: number;
  jade: number;
  reserve_troops: number;
  free_recruits: number;
  total_kills: number;
  pvp_wins: number;
  hex_q: number;
  hex_r: number;
  hex_s: number;
  stamina: number;
  market_state: {
    current_day: string;
    purchases: Record<string, number>;
  };
  [key: string]: unknown;
}

export interface RawCity {
  id: string;
  owner_id: string;
  name: string;
  county: string;
  province: string;
  hex_q: number;
  hex_r: number;
  hex_s: number;
  level: number;
  warehouse_level: number;
  barracks_level: number;
  army_camp_level: number;
  training_ground_level: number;
  market_level: number;
  residence_level: number;
  conscription_office_level: number;
  wood_workshop_levels: number[];
  stone_workshop_levels: number[];
  iron_workshop_levels: number[];
  grain_workshop_levels: number[];
  build_queue: unknown;
  garrison_army_id: string;
  [key: string]: unknown;
}

export interface RawGeneral {
  id: string;
  owner_id: string;
  army_id: string;
  preset_id: string;
  name: string;
  quality: string;
  level: number;
  exp: number;
  might: number;
  intellect: number;
  stamina_attr: number;
  troop_type: string;
  troops: number;
  troop_cap: number;
  star_level: number;
  is_dead: boolean;
  assigned_army_id: string;
  [key: string]: unknown;
}

export interface RawArmy {
  id: string;
  owner_id: string;
  status: string;
  formation: string;
  total_troops: number;
  total_troop_cap: number;
  general_ids: string[];
  march_target_q?: number;
  march_target_r?: number;
  march_target_s?: number;
  march_arrival_at?: string;
  march_intent?: string;
  [key: string]: unknown;
}

export interface RawTile {
  hex_q: number;
  hex_r: number;
  hex_s: number;
  terrain: string;
  owner_id: string | null;
  resource_type: string;
  resource_level: number;
  [key: string]: unknown;
}

export interface RawRecommendedTarget {
  target_id: string;
  target_type: string;
  resource_type: string;
  level: number;
  hex_q: number;
  hex_r: number;
  hex_s: number;
  distance: number;
  travel_seconds: number;
  recommendation: string;
  priority_band: string;
  reason: string;
  prediction: string;
  guard_power?: number;
  guard_troops?: number;
  troop_ratio?: number;
  [key: string]: unknown;
}

export interface RawResourcePoint {
  id: string;
  hex_q: number;
  hex_r: number;
  hex_s: number;
  resource_type: string;
  level: number;
  owner_id: string | null;
  output_per_hour: number;
  zone: string;
  garrison_army_id?: string;
  [key: string]: unknown;
}

export interface RawStateResponse {
  playerState: RawPlayerState;
  cities: RawCity[];
  generals: RawGeneral[];
  armies: RawArmy[];
  prosperity: number;
  leaderboard?: RawLeaderboardEntry[];
  innerResourcePoints?: RawResourcePoint[];
  ownedResourcePoints?: RawResourcePoint[];
  resourcePointLimit?: number;
  [key: string]: unknown;
}

export interface RawMapResponse {
  tiles: RawTile[];
  resourcePoints: RawResourcePoint[];
  recommended_targets: RawRecommendedTarget[];
  scan_summary: {
    best_neutral_target?: RawRecommendedTarget;
    best_invasion_target?: RawRecommendedTarget;
    action_hint: string;
  };
  season_phase: string;
  tiles_radius: number;
  [key: string]: unknown;
}

export interface RawLeaderboardEntry {
  player_id: string;
  name: string;
  lord_level: number;
  territories: number;
  territory_sum?: number;
  troops: number;
  total_kills: number;
  city?: {
    name: string;
    hex_q: number;
    hex_r: number;
    hex_s: number;
  };
  [key: string]: unknown;
}

// ========== 标准化后的类型 ==========

export interface GameState {
  playerId: string;
  lordLevel: number;
  lordName: string;
  cityName: string;
  province: string;
  prosperity: number;
  resources: {
    wood: number; stone: number; iron: number; grain: number;
    copper: number; gold: number;
  };
  capacity: {
    wood: number; stone: number; iron: number; grain: number;
  };
  production: {
    wood: number; stone: number; iron: number; grain: number;
  };
  stamina: number;
  maxStamina: number;
  reserveTroops: number;
  freeRecruits: number;
  totalKills: number;
  armies: Army[];
  generals: General[];
  city: RawCity;
  buildings: Building[];
  innerResourcePoints: RawResourcePoint[];
  ownedResourcePoints: RawResourcePoint[];
  resourcePointLimit: number;
  leaderboard: LeaderboardEntry[];
  marketState: {
    currentDay: string;
    purchases: Record<string, number>;
  };
  gachaState: {
    freePulls: number;
    goldBalance: number;
  };
  turn?: number;
  seasonPhase?: string;
  raw: RawStateResponse; // 保留原始数据供调试
}

export interface Army {
  id: string;
  status: string;
  formation: string;
  totalTroops: number;
  totalTroopCap: number;
  generals: General[];
  march?: {
    targetQ: number;
    targetR: number;
    targetS: number;
    arrivalAt?: string;
    intent?: string;
  };
  raw: RawArmy;
}

export interface General {
  id: string;
  name: string;
  quality: string;
  level: number;
  might: number;
  intellect: number;
  staminaAttr: number;
  troopType: string;
  troops: number;
  troopCap: number;
  isDead: boolean;
  armyId: string;
}

export interface Building {
  type: string;
  level: number;
}

export interface LeaderboardEntry {
  playerId: string;
  name: string;
  lordLevel: number;
  territories: number;
  troops: number;
  kills: number;
  city?: { name: string; hexQ: number; hexR: number; hexS: number };
}

// ========== 地图 ==========
export interface MapData {
  tiles: RawTile[];
  resourcePoints: RawResourcePoint[];
  recommendedTargets: RawRecommendedTarget[];
  scanSummary: {
    bestNeutralTarget?: RawRecommendedTarget;
    bestInvasionTarget?: RawRecommendedTarget;
    actionHint: string;
  };
  seasonPhase: string;
}

// ========== 事件 ==========
export interface GameEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  timestamp?: string;
  requiresResponse?: boolean;
}

// ========== 决策 ==========
export interface Decision {
  analysis: string;
  action: string;
  params: Record<string, unknown>;
  reasoning: string;
}

// ========== Web 推送 ==========
export interface BroadcastMessage {
  type: 'state' | 'decision' | 'log' | 'battle' | 'chat_response' | 'directive_update' | 'history';
  data: unknown;
  timestamp: string;
}
