import type { GameState, MapData, RawRecommendedTarget } from '../types.js';

/**
 * 将游戏状态格式化为模型可读的中文文本
 */
export function formatGameState(state: GameState, map?: MapData): string {
  const sections: string[] = [];

  // 基本信息
  sections.push(`【领主信息】
等级: Lv${state.lordLevel} | 城池: ${state.cityName} (${state.province})
繁荣度: ${state.prosperity}`);

  // 资源
  const r = state.resources;
  const c = state.capacity;
  sections.push(`【资源状况】
木材: ${r.wood}/${c.wood} | 石材: ${r.stone}/${c.stone}
铁矿: ${r.iron}/${c.iron} | 粮食: ${r.grain}/${c.grain}
铜币: ${r.copper} | 金币: ${r.gold}
预备兵: ${state.reserveTroops} | 体力: ${state.stamina}/${state.maxStamina}`);

  // 军队
  for (const army of state.armies) {
    const troopPct = army.totalTroopCap > 0 ? Math.round(army.totalTroops / army.totalTroopCap * 100) : 0;
    let marchInfo = '';
    if (army.march) {
      marchInfo = ` | 行军目标: (${army.march.targetQ},${army.march.targetR},${army.march.targetS})`;
      if (army.march.arrivalAt) marchInfo += ` 预计到达: ${army.march.arrivalAt}`;
    }
    const generals = army.generals.map(g =>
      `${g.name}(${g.quality} 武${g.might}/智${g.intellect}/体${g.staminaAttr} ${g.troopType} 兵${g.troops}/${g.troopCap})`
    ).join(', ');
    sections.push(`【军队 ${army.id.slice(-6)}】
状态: ${translateStatus(army.status)} | 阵型: ${army.formation || '未设置'}
兵力: ${army.totalTroops}/${army.totalTroopCap} (${troopPct}%)
将领: ${generals || '无'}${marchInfo}`);
  }

  // 建筑
  const buildings = state.buildings
    .filter(b => b.level > 0)
    .map(b => `${translateBuilding(b.type)}Lv${b.level}`)
    .join(' | ');
  sections.push(`【建筑】${buildings}`);

  // 领地（含ID用于放弃操作）
  if (state.ownedResourcePoints.length > 0) {
    const overLimit = state.ownedResourcePoints.length > state.resourcePointLimit;
    const rpList = state.ownedResourcePoints.map(rp => {
      const dist = Math.abs(rp.hex_q - (state.raw?.playerState?.hex_q ?? 0)) +
                   Math.abs(rp.hex_r - (state.raw?.playerState?.hex_r ?? 0));
      return `  ${translateResource(rp.resource_type)}Lv${rp.level} (${rp.hex_q},${rp.hex_r},${rp.hex_s}) id:${rp.id} 距离${Math.round(dist/2)}格`;
    }).join('\n');
    const hint = overLimit ? ` [超出上限! 应放弃远处低级地]` : '';
    sections.push(`【领地】${state.ownedResourcePoints.length}/${state.resourcePointLimit}${hint}\n${rpList}`);
  } else {
    sections.push(`【领地】0/${state.resourcePointLimit} 无外城资源点`);
  }

  // 排行榜
  if (state.leaderboard.length > 0) {
    const lb = state.leaderboard.slice(0, 8).map((e, i) => {
      const isMe = e.playerId === state.playerId ? ' ★' : '';
      return `  ${i + 1}. ${e.name}${isMe} Lv${e.lordLevel} 领地${e.territories} 兵${e.troops} 击杀${e.kills}`;
    }).join('\n');
    sections.push(`【排行榜】\n${lb}`);
  }

  // 抽卡
  sections.push(`【抽卡】免费次数: ${state.gachaState.freePulls} | 金币: ${state.gachaState.goldBalance}`);

  // 地图推荐目标
  if (map && map.recommendedTargets.length > 0) {
    const targetStr = map.recommendedTargets.slice(0, 8).map(t => formatTarget(t)).join('\n');
    sections.push(`【推荐目标】(系统推荐)\n${targetStr}`);
    if (map.scanSummary.actionHint) {
      sections.push(`【系统建议】${map.scanSummary.actionHint}`);
    }
  }

  // 敌方资源点
  if (map) {
    const enemyPoints = map.resourcePoints
      .filter(t => t.owner_id && t.owner_id !== state.playerId)
      .slice(0, 5);
    if (enemyPoints.length > 0) {
      const enemyStr = enemyPoints.map(t =>
        `  ${translateResource(t.resource_type)}Lv${t.level} (${t.hex_q},${t.hex_r},${t.hex_s})`
      ).join('\n');
      sections.push(`【敌方资源点】\n${enemyStr}`);
    }
  }

  return sections.join('\n\n');
}

function formatTarget(t: RawRecommendedTarget): string {
  return `  ${translateResource(t.resource_type)}Lv${t.level} (${t.hex_q},${t.hex_r},${t.hex_s}) 距离${t.distance}格 ${t.travel_seconds}秒 预测:${translatePrediction(t.prediction)} ${t.reason || ''}`;
}

function translateStatus(s: string): string {
  const map: Record<string, string> = {
    idle: '空闲', marching: '行军中', garrisoned: '驻防中', in_combat: '战斗中',
    stationed: '驻扎', returning: '返回中',
  };
  return map[s] || s;
}

function translateBuilding(t: string): string {
  const map: Record<string, string> = {
    warehouse: '仓库', barracks: '兵营', army_camp: '军营',
    training_ground: '校场', market: '市场', residence: '民居',
    conscription_office: '征兵处',
  };
  return map[t] || t;
}

function translateResource(t: string): string {
  const map: Record<string, string> = {
    wood: '木材', stone: '石材', iron: '铁矿', grain: '粮食',
  };
  return map[t] || t;
}

function translatePrediction(p?: string): string {
  if (!p) return '未知';
  const map: Record<string, string> = {
    advantage: '优势', balanced: '均势', danger: '危险',
  };
  return map[p] || p;
}
