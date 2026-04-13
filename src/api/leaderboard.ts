import { createLogger } from '../logger.js';

const log = createLogger('leaderboard');

export interface LeaderboardData {
  world: {
    seasonId: string;
    turn: number;
    status: string;
    phase: string;
    elapsedSeconds: number;
  };
  summary: {
    joinedPlayers: number;
    stalledPlayers: number;
    interventionCandidates: number;
  };
  myPlayer?: {
    topGuideTask: string;
    stuckReason: string;
    interventionHint: string;
    observerStatus: string;
    alerts: { level: string; text: string }[];
    nearby: {
      closestNeutral?: { id: string; type: string; level: number; distance: number };
      closestEnemy?: { id: string; type: string; level: number; distance: number };
      highestNeutral?: { id: string; type: string; level: number; distance: number };
    };
    stamina: { current: number; max: number };
    territoryCap: { used: number; max: number; remaining: number };
  };
  battles: {
    turn: number;
    attackerId: string;
    result: string;
    attackerLosses: number;
    defenderLosses: number;
  }[];
}

export async function fetchLeaderboard(playerId: string): Promise<LeaderboardData> {
  const resp = await fetch('https://clislg.filo.ai/api/leaderboard');
  if (!resp.ok) throw new Error(`leaderboard API error ${resp.status}`);
  const data = await resp.json() as Record<string, unknown>;

  const players = data.players as Record<string, unknown>[];
  const myPlayer = players?.find((p: Record<string, unknown>) => p.id === playerId) as Record<string, unknown> | undefined;

  const result: LeaderboardData = {
    world: data.world as LeaderboardData['world'],
    summary: data.summary as LeaderboardData['summary'],
    battles: ((data.battles as unknown[]) || []).slice(0, 5) as LeaderboardData['battles'],
  };

  if (myPlayer) {
    result.myPlayer = {
      topGuideTask: (myPlayer.topGuideTask as string) || '',
      stuckReason: (myPlayer.stuckReason as string) || '',
      interventionHint: (myPlayer.interventionHint as string) || '',
      observerStatus: (myPlayer.observerStatus as string) || '',
      alerts: (myPlayer.alerts as { level: string; text: string }[]) || [],
      nearby: myPlayer.nearby as NonNullable<LeaderboardData['myPlayer']>['nearby'],
      stamina: (myPlayer.stamina as { current: number; max: number }) || { current: 0, max: 200 },
      territoryCap: (myPlayer.territoryCap as { used: number; max: number; remaining: number }) || { used: 0, max: 10, remaining: 10 },
    };
    log.debug(`系统建议: ${result.myPlayer.topGuideTask}`);
  }

  return result;
}
