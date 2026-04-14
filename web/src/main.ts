import { storage } from './storage.js';
import { login, register, logout, isLoggedIn } from './api/auth.js';
import { api } from './api/client.js';
import { onEvent, startBot, stopBot, toggleBot, fetchOnce, isRunning, addDirective, getDirectives, getRound, getState } from './game-loop.js';
import { createAIProvider, resetProvider, WEBLLM_MODELS, getSelectedModel } from './brain/ai-provider.js';
import { GAME_RULES } from '../../src/core/brain/game-rules.js';
import type { GameState, MapData, Decision } from '../../src/core/types.js';
import type { AIMessage } from './brain/ai-provider.js';

// WebLLM 缓存管理
let webllmModule: typeof import('@mlc-ai/web-llm') | null = null;
async function getWebLLM() {
  if (!webllmModule) webllmModule = await import('@mlc-ai/web-llm');
  return webllmModule;
}
const modelCacheStatus = new Map<string, 'cached' | 'downloading' | 'none'>();
async function refreshCacheStatus() {
  try {
    const wl = await getWebLLM();
    await Promise.all(WEBLLM_MODELS.map(async m => {
      const cached = await wl.hasModelInCache(m.id);
      if (modelCacheStatus.get(m.id) !== 'downloading') {
        modelCacheStatus.set(m.id, cached ? 'cached' : 'none');
      }
    }));
  } catch { /* ignore */ }
}

// ===== DOM =====
const $ = (id: string) => document.getElementById(id)!;
const hide = (el: HTMLElement) => el.classList.add('hidden');
const show = (el: HTMLElement) => el.classList.remove('hidden');

// ===== 设置向导 =====
let selectedAI = storage.get('ai_provider') || 'webllm';

const aiOptions = [
  { id: 'webllm', name: '浏览器本地 AI', desc: '无需 Key，即开即用', primary: true },
  { id: 'google', name: 'Google Gemini', desc: '免费额度大', primary: false },
  { id: 'openai', name: 'OpenAI GPT', desc: '需要 API Key', primary: false },
  { id: 'anthropic', name: 'Anthropic Claude', desc: '需要 API Key', primary: false },
  { id: 'none', name: '不使用 AI', desc: '纯规则引擎', primary: false },
];

function renderSetup() {
  const container = $('ai-options');
  container.innerHTML = aiOptions.map(o =>
    `<div class="option ${o.id === selectedAI ? 'selected' : ''} ${o.primary ? 'option-primary' : 'option-secondary'}" data-provider="${o.id}">
      <div class="name">${o.name}</div><div class="desc">${o.desc}</div>
    </div>`
  ).join('');
  // 默认选 webllm 时展开模型列表
  if (selectedAI === 'webllm') {
    show($('webllm-model-section'));
    renderWebLLMModelList();
  }
  container.querySelectorAll('.option').forEach(el => {
    el.addEventListener('click', () => {
      selectedAI = (el as HTMLElement).dataset.provider!;
      container.querySelectorAll('.option').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      const keySection = $('api-key-section');
      const modelSection = $('webllm-model-section');
      if (['openai', 'anthropic', 'google'].includes(selectedAI)) {
        show(keySection); hide(modelSection);
        const labels: Record<string, string> = { openai: 'OpenAI API Key', anthropic: 'Anthropic API Key', google: 'Google AI API Key' };
        const ph: Record<string, string> = { openai: 'sk-...', anthropic: 'sk-ant-...', google: 'AIza...' };
        $('api-key-label').textContent = labels[selectedAI];
        ($('api-key-input') as HTMLInputElement).placeholder = ph[selectedAI];
      } else if (selectedAI === 'webllm') {
        hide(keySection); show(modelSection);
        renderWebLLMModelList();
      } else { hide(keySection); hide(modelSection); }
    });
  });
}

$('setup-next').addEventListener('click', () => {
  storage.set('ai_provider', selectedAI);
  const key = ($('api-key-input') as HTMLInputElement).value.trim();
  if (key) storage.set('ai_key', key);
  resetProvider();
  if (isLoggedIn()) enterGame();
  else { hide($('setup-overlay')); show($('login-overlay')); }
});
$('setup-skip').addEventListener('click', () => {
  // 已登录时跳过不改配置，首次跳过设为 none
  if (!isLoggedIn()) storage.set('ai_provider', 'none');
  else if (!storage.get('ai_provider')) storage.set('ai_provider', 'none');
  resetProvider();
  if (isLoggedIn()) enterGame();
  else { hide($('setup-overlay')); show($('login-overlay')); }
});

// WebLLM 模型列表（设置向导）
let selectedWebLLMModel = storage.get('webllm_model') || 'Qwen3-1.7B-q4f16_1-MLC';

function buildModelListHTML(currentId: string, showCacheActions: boolean) {
  const groups: Record<string, typeof WEBLLM_MODELS> = {};
  for (const m of WEBLLM_MODELS) {
    if (!groups[m.group]) groups[m.group] = [];
    groups[m.group].push(m);
  }
  let html = '';
  for (const [group, models] of Object.entries(groups)) {
    html += `<div class="popup-group-label">${group}</div>`;
    for (const m of models) {
      const starColors = ['', '#ef4444', '#ef4444', '#facc15', '#4ade80', '#4ade80'];
      const starColor = starColors[m.zhLevel];
      const stars = '<span style="color:' + starColor + '">' + '\u2605'.repeat(m.zhLevel) + '</span>' +
                    '<span style="color:#333">' + '\u2605'.repeat(5 - m.zhLevel) + '</span>';
      const thinkMap: Record<string, string> = {
        deep: '<span class="pm-think think-deep">深度</span>',
        think: '<span class="pm-think think-normal">思考</span>',
        none: '<span class="pm-think think-none">思考</span>',
      };
      const cache = modelCacheStatus.get(m.id);
      let cacheHTML = '';
      if (showCacheActions) {
        const cls = !cache ? 'pm-tick-unknown' : cache === 'cached' ? 'pm-tick-cached' : cache === 'downloading' ? 'pm-tick-downloading' : 'pm-tick-none';
        cacheHTML = `<span class="pm-tick ${cls}" data-tick="${m.id}">✓</span>`;
      }
      html += `<div class="popup-model ${m.id === currentId ? 'selected' : ''}" data-model="${m.id}">
        <span class="pm-name">${m.label}</span>
        <span class="pm-stars">${stars}</span>
        ${thinkMap[m.thinkType]}
        <span class="pm-size">${m.size}</span>
        ${cacheHTML}
      </div>`;
    }
  }
  return html;
}

function renderWebLLMModelList() {
  const container = $('webllm-model-list');
  container.innerHTML = buildModelListHTML(selectedWebLLMModel, false);
  container.querySelectorAll('.popup-model').forEach(el => {
    el.addEventListener('click', () => {
      selectedWebLLMModel = (el as HTMLElement).dataset.model!;
      storage.set('webllm_model', selectedWebLLMModel);
      container.querySelectorAll('.popup-model').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
    });
  });
}

// 聊天工具栏（模型选择 + 思考开关）
let thinkingEnabled = storage.get('ai_thinking') === 'true';

function initChatToolbar() {
  const btn = $('chat-model-btn');
  show(btn);

  const popup = $('chat-model-popup');
  btn.textContent = '\u{1F9E0}';

  // 渲染模型列表
  renderModelPopup();

  // 点击按钮弹出/关闭
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    popup.classList.toggle('hidden');
    if (!popup.classList.contains('hidden')) {
      refreshCacheStatus().then(updateTickStyles);
    }
  });
  document.addEventListener('click', () => popup.classList.add('hidden'));
  popup.addEventListener('click', (e) => e.stopPropagation());

  // 思考开关
  const thinkCheck = $('chat-think-check') as HTMLInputElement;
  thinkCheck.checked = thinkingEnabled;
  updateThinkUI();

  thinkCheck.addEventListener('change', () => {
    thinkingEnabled = thinkCheck.checked;
    storage.set('ai_thinking', thinkingEnabled ? 'true' : 'false');
  });

  // 配置入口
  $('popup-config-btn').addEventListener('click', () => {
    popup.classList.add('hidden');
    stopBot();
    hide($('app'));
    show($('setup-overlay'));
    renderSetup();
  });
}

function renderModelPopup() {
  const list = $('chat-model-popup-list');
  const currentId = storage.get('webllm_model') || 'Qwen3-1.7B-q4f16_1-MLC';

  // 渲染一次，不再重建
  list.innerHTML = buildModelListHTML(currentId, true);
  bindModelPopupEvents();

  // 异步刷新缓存状态，只更新小钩样式
  refreshCacheStatus().then(updateTickStyles);
}

function updateTickStyles() {
  const list = $('chat-model-popup-list');
  list.querySelectorAll<HTMLElement>('.pm-tick').forEach(el => {
    const id = el.dataset.tick!;
    const cache = modelCacheStatus.get(id);
    el.className = 'pm-tick ' + (!cache ? 'pm-tick-unknown' : cache === 'cached' ? 'pm-tick-cached' : cache === 'downloading' ? 'pm-tick-downloading' : 'pm-tick-none');
  });
}

function bindModelPopupEvents() {
  const list = $('chat-model-popup-list');

  // 选择模型
  list.querySelectorAll('.popup-model').forEach(el => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.pm-tick')) return;
      const id = (el as HTMLElement).dataset.model!;
      storage.set('webllm_model', id);
      storage.set('ai_provider', 'webllm');
      resetProvider();
      list.querySelectorAll('.popup-model').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      updateThinkUI();
      $('chat-model-popup').classList.add('hidden');
    });
  });

  // 小钩点击
  list.querySelectorAll<HTMLElement>('.pm-tick').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const modelId = el.dataset.tick!;
      const cache = modelCacheStatus.get(modelId);

      if (!cache) return; // 未知状态，不可点

      if (cache === 'cached') {
        // 绿色 → 确认删除
        if (!confirm('删除已下载的模型缓存？')) return;
        try {
          const wl = await getWebLLM();
          await wl.deleteModelAllInfoInCache(modelId);
          modelCacheStatus.set(modelId, 'none');
        } catch { /* ignore */ }
        updateTickStyles();
      } else if (cache === 'none') {
        // 白色 → 选中模型 + 切换到 webllm + 关闭弹窗 + 发消息触发下载
        storage.set('webllm_model', modelId);
        storage.set('ai_provider', 'webllm');
        resetProvider();
        list.querySelectorAll('.popup-model').forEach(e => e.classList.remove('selected'));
        list.querySelector(`.popup-model[data-model="${modelId}"]`)?.classList.add('selected');
        updateThinkUI();
        $('chat-model-popup').classList.add('hidden');
        // 自动发一条消息触发下载
        const input = $('chat-input') as HTMLInputElement;
        input.value = '军师何在？';
        $('chat-send').click();
      }
    });
  });
}

function updateThinkUI() {
  const model = getSelectedModel();
  const thinkCheck = $('chat-think-check') as HTMLInputElement;
  const hint = $('chat-think-hint');
  if (model.thinkType !== 'none') {
    thinkCheck.disabled = false;
    hint.textContent = '模型先推理再回答，更准但更慢';
  } else {
    thinkCheck.disabled = true;
    thinkCheck.checked = false;
    thinkingEnabled = false;
    hint.textContent = '该模型不支持思考';
  }
}

// ===== 登录（自动注册）=====
async function handleLogin() {
  const user = ($('login-user') as HTMLInputElement).value.trim();
  const pass = ($('login-pass') as HTMLInputElement).value.trim();
  if (!user || !pass) return showError('请输入用户名和密码');
  const btn = $('login-btn') as HTMLButtonElement;
  btn.disabled = true; btn.textContent = '登录中...';
  try {
    let d = await login(user, pass);
    if (!d.token) {
      // 登录失败，尝试注册
      btn.textContent = '创建势力...';
      d = await register(user, pass);
      if (d.token) await api('POST', '/join-season').catch(() => {});
    }
    if (d.token) {
      // 已配置过 AI 则直接进游戏，否则显示设置向导
      if (storage.get('ai_provider')) {
        enterGame();
      } else {
        hide($('login-overlay'));
        show($('setup-overlay'));
      }
    } else {
      showError(d.error || d.message || '登录失败');
    }
  } catch { showError('网络错误'); }
  btn.disabled = false; btn.textContent = '进入战场';
}

function showError(msg: string) {
  const el = $('login-error'); el.textContent = msg; show(el);
}

$('login-btn').addEventListener('click', handleLogin);
$('login-pass').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') handleLogin(); });

function enterGame() {
  hide($('setup-overlay')); hide($('login-overlay')); show($('app'));
  // 自愈：有模型选择但 provider 不对，自动修正
  if (storage.get('webllm_model') && storage.get('ai_provider') !== 'webllm') {
    storage.set('ai_provider', 'webllm');
    resetProvider();
  }
  refreshCacheStatus(); // 预加载缓存状态
  initChatToolbar();
  startBot();
}

// ===== 登出 =====
$('logout-btn').addEventListener('click', () => { stopBot(); logout(); hide($('app')); hide($('setup-overlay')); show($('login-overlay')); });

// ===== Bot 控制 =====
$('bot-toggle').addEventListener('click', toggleBot);

// ===== 地图 =====
const HEX_SIZE = 18;
const RES_COLORS: Record<string, string> = { wood: '#6b8e23', stone: '#888c8d', iron: '#8b6914', grain: '#daa520' };
const PLAYER_COLORS = ['#40c860', '#e84040', '#4090e8', '#e88840', '#a040e8', '#40c8c8'];
const playerColorMap: Record<string, string> = {};
let colorIdx = 0;
let myPlayerId: string | null = null;
let mapOffsetX = 0, mapOffsetY = 0, mapScale = 0.6;
let isDragging = false, dragStartX = 0, dragStartY = 0;

function getPlayerColor(pid: string) {
  if (pid === myPlayerId) return PLAYER_COLORS[0];
  if (!playerColorMap[pid]) { colorIdx++; playerColorMap[pid] = PLAYER_COLORS[colorIdx % PLAYER_COLORS.length]; }
  return playerColorMap[pid];
}
function hexToPixel(q: number, r: number) { return { x: HEX_SIZE * (3/2 * q), y: HEX_SIZE * (Math.sqrt(3)/2 * q + Math.sqrt(3) * r) }; }
function hexPoints(cx: number, cy: number, size: number) {
  const pts = [];
  for (let i = 0; i < 6; i++) { const a = Math.PI/180*(60*i-30); pts.push(`${cx+size*Math.cos(a)},${cy+size*Math.sin(a)}`); }
  return pts.join(' ');
}

function renderMap(state: GameState, map: MapData | null) {
  if (!map) return;
  const svg = $('map-svg');
  const rect = svg.getBoundingClientRect();
  const cx = rect.width/2, cy = rect.height/2;
  let centerQ = 0, centerR = 0;
  const me = state.leaderboard?.find(e => e.playerId === myPlayerId);
  if (me?.city) { centerQ = me.city.hexQ || 0; centerR = me.city.hexR || 0; }

  const knownTiles = new Map<string, Record<string, unknown>>();
  for (const t of (map.resourcePoints || [])) {
    const raw = t as unknown as Record<string, unknown>;
    if (raw.hex_q == null || Math.abs(raw.hex_q as number) > 1000) continue;
    knownTiles.set(`${raw.hex_q},${raw.hex_r}`, raw);
  }
  for (const t of (map.tiles || [])) {
    const raw = t as unknown as Record<string, unknown>;
    if (raw.hex_q == null || Math.abs(raw.hex_q as number) > 1000) continue;
    const key = `${raw.hex_q},${raw.hex_r}`;
    if (!knownTiles.has(key)) knownTiles.set(key, raw);
  }

  const playerCities = (state.leaderboard || []).filter(p => p.city).map(p => ({ id: p.playerId, name: p.name, q: p.city!.hexQ, r: p.city!.hexR }));

  let html = `<g transform="translate(${cx+mapOffsetX},${cy+mapOffsetY}) scale(${mapScale})">`;
  for (const tile of knownTiles.values()) {
    const q = (tile.hex_q as number) - centerQ, r = (tile.hex_r as number) - centerR;
    const {x, y} = hexToPixel(q, r);
    const resType = (tile.resource_type || tile.type || '') as string;
    const ownerId = (tile.owner_id || null) as string | null;
    const level = (tile.resource_level || tile.level || 0) as number;
    if (tile.terrain === 'city') { html += `<polygon points="${hexPoints(x,y,HEX_SIZE-1)}" fill="#1a1a10" stroke="#555" stroke-width="1.5" />`; continue; }
    const color = RES_COLORS[resType] || '#334';
    const isCorridor = tile.zone === 'corridor';
    html += `<polygon points="${hexPoints(x,y,HEX_SIZE-1)}" fill="${color}" fill-opacity="${isCorridor?0.85:0.6}" stroke="${isCorridor?'#997':'#253025'}" stroke-width="${isCorridor?1:0.5}" />`;
    if (ownerId) { const pc = getPlayerColor(ownerId); html += `<polygon points="${hexPoints(x,y,HEX_SIZE-1)}" fill="${pc}" fill-opacity="0.3" stroke="${pc}" stroke-width="1.5" pointer-events="none" />`; }
    if (level) { const fs = level >= 7 ? 12 : level >= 4 ? 10 : 8; html += `<text x="${x}" y="${y+fs/3}" text-anchor="middle" fill="white" font-size="${fs}" font-weight="bold" pointer-events="none">${level}</text>`; }
  }
  for (const p of playerCities) {
    const cq = p.q - centerQ, cr = p.r - centerR;
    const {x, y} = hexToPixel(cq, cr);
    const pc = getPlayerColor(p.id);
    const isMe = p.id === myPlayerId;
    html += `<polygon points="${hexPoints(x,y,HEX_SIZE+4)}" fill="${pc}" fill-opacity="0.12" stroke="${pc}" stroke-width="${isMe?3:2}" pointer-events="none" />`;
    html += `<text x="${x}" y="${y-HEX_SIZE-6}" text-anchor="middle" fill="${pc}" font-size="${isMe?12:10}" font-weight="bold" pointer-events="none">${isMe?'* ':''}${p.name}</text>`;
  }
  html += '</g>';
  svg.innerHTML = html;
}

// 地图拖拽（鼠标+触屏）
const mapPanel = $('map-panel');
const pointers = new Map<number, PointerEvent>();
let lastPinchDist = 0;

mapPanel.addEventListener('pointerdown', (e: PointerEvent) => {
  pointers.set(e.pointerId, e);
  if (pointers.size === 1) { isDragging = true; dragStartX = e.clientX - mapOffsetX; dragStartY = e.clientY - mapOffsetY; }
});
mapPanel.addEventListener('pointermove', (e: PointerEvent) => {
  pointers.set(e.pointerId, e);
  if (pointers.size === 1 && isDragging) {
    mapOffsetX = e.clientX - dragStartX; mapOffsetY = e.clientY - dragStartY;
    if (currentState) renderMap(currentState, currentMap);
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (lastPinchDist > 0) {
      const scale = dist / lastPinchDist;
      mapScale = Math.max(0.2, Math.min(5, mapScale * scale));
      if (currentState) renderMap(currentState, currentMap);
    }
    lastPinchDist = dist;
  }
});
mapPanel.addEventListener('pointerup', (e: PointerEvent) => { pointers.delete(e.pointerId); isDragging = false; lastPinchDist = 0; });
mapPanel.addEventListener('pointercancel', (e: PointerEvent) => { pointers.delete(e.pointerId); isDragging = false; lastPinchDist = 0; });
mapPanel.addEventListener('wheel', (e: WheelEvent) => {
  e.preventDefault();
  const rect = mapPanel.getBoundingClientRect();
  const mx = e.clientX - rect.left - rect.width/2, my = e.clientY - rect.top - rect.height/2;
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const ns = Math.max(0.2, Math.min(5, mapScale * delta));
  mapOffsetX = mx - (mx - mapOffsetX) * (ns / mapScale);
  mapOffsetY = my - (my - mapOffsetY) * (ns / mapScale);
  mapScale = ns;
  if (currentState) renderMap(currentState, currentMap);
}, { passive: false });

$('zoom-in').addEventListener('click', () => { mapScale = Math.min(5, mapScale * 1.3); if (currentState) renderMap(currentState, currentMap); });
$('zoom-out').addEventListener('click', () => { mapScale = Math.max(0.2, mapScale * 0.77); if (currentState) renderMap(currentState, currentMap); });
$('zoom-reset').addEventListener('click', () => { mapOffsetX = 0; mapOffsetY = 0; mapScale = 0.6; if (currentState) renderMap(currentState, currentMap); });

// ===== UI 渲染 =====
let currentState: GameState | null = null;
let currentMap: MapData | null = null;

function renderTopBar(state: GameState) {
  const me = state.leaderboard?.find(e => e.playerId === myPlayerId);
  const username = me?.name || storage.get('username') || '';
  $('lord-info').textContent = `${username} · ${state.cityName} Lv${state.lordLevel}`;
  $('round-info').textContent = `第 ${getRound()} 轮`;

  const r = state.resources, c = state.capacity;
  $('resource-bar').innerHTML = [
    resHTML('wood','木',r.wood,c.wood), resHTML('stone','石',r.stone,c.stone),
    resHTML('iron','铁',r.iron,c.iron), resHTML('grain','粮',r.grain,c.grain),
    resHTML('copper','铜',r.copper),
  ].join('');

  const army = state.armies[0];
  if (army) {
    const tPct = Math.round(army.totalTroops / army.totalTroopCap * 100) || 0;
    const stam = typeof army.raw?.stamina === 'number' ? army.raw.stamina : state.stamina;
    const sPct = Math.round(stam / 200 * 100);
    $('army-info').innerHTML = `兵${army.totalTroops}/${army.totalTroopCap} <div class="bar-bg"><div class="bar-fill bar-troop" style="width:${tPct}%"></div></div> 体力${stam} <div class="bar-bg"><div class="bar-fill bar-stamina" style="width:${sPct}%"></div></div>`;
  }
}

function resHTML(type: string, label: string, val: number, cap?: number) {
  const warn = cap && val > cap * 0.8 ? 'color:var(--red)' : '';
  return `<span class="res-item res-${type}"><span class="res-dot"></span>${label} <b style="${warn}">${val||0}</b>${cap?`/${cap}`:''}</span>`;
}

function renderLeaderboard(state: GameState) {
  $('lb-list').innerHTML = state.leaderboard.map((e, i) => {
    const isMe = e.playerId === myPlayerId;
    return `<div class="lb-row ${isMe?'is-me':''}"><span class="lb-rank">${i+1}.</span><span class="lb-name">${isMe?'* ':''}${e.name}</span><span class="lb-detail">Lv${e.lordLevel} 领地${e.territories}</span></div>`;
  }).join('');
}

function renderBottomBar(state: GameState) {
  const bNames: Record<string, string> = { warehouse:'仓库', barracks:'兵营', army_camp:'军营', training_ground:'校场', residence:'民居', conscription_office:'征兵所' };
  $('buildings-info').innerHTML = state.buildings.filter(b => b.level > 0).map(b => `${bNames[b.type]||b.type}Lv${b.level}`).join(' | ');
  $('territory-info').textContent = `领地 ${state.ownedResourcePoints.length}/${state.resourcePointLimit}`;
}

let lastDecisionKey = '';
let lastDecisionCount = 0;

function addDecisionCard(round: number, decision: Decision) {
  const list = $('decision-list');
  const actionClass: Record<string, string> = { march:'action-march', replenish:'action-replenish', build:'action-build', gacha:'action-gacha', wait:'action-wait', develop:'action-march', upgrade_resource:'action-build' };
  const actionNames: Record<string, string> = { march:'行军', replenish:'补兵', build:'建造', gacha:'抽卡', wait:'等待', develop:'开发', upgrade_resource:'升级', abandon:'放弃', assign_generals:'分配', market_purchase:'购买' };

  // 合并连续相同的等待决策
  const key = `${decision.action}:${decision.analysis}`;
  if (decision.action === 'wait' && key === lastDecisionKey && list.firstChild) {
    lastDecisionCount++;
    const existing = list.firstChild as HTMLElement;
    const roundEl = existing.querySelector('.decision-round');
    if (roundEl) roundEl.textContent = `第 ${round} 轮 | ${new Date().toLocaleTimeString('zh-CN')} (×${lastDecisionCount})`;
    return;
  }
  lastDecisionKey = key;
  lastDecisionCount = 1;

  const card = document.createElement('div');
  card.className = 'decision-card';
  card.innerHTML = `<div class="decision-round">第 ${round} 轮 | ${new Date().toLocaleTimeString('zh-CN')}</div><div class="decision-analysis">${decision.analysis}</div><span class="decision-action ${actionClass[decision.action]||'action-default'}">${actionNames[decision.action]||decision.action}</span><div class="decision-reasoning">${decision.reasoning}</div>`;
  list.prepend(card);
  while (list.children.length > 50) list.removeChild(list.lastChild!);
}

// 手机 Tab 也需要渲染
function renderMobileStatus(state: GameState) {
  const r = state.resources;
  $('m-resources').innerHTML = `<div class="m-card"><h4>资源</h4><div class="m-grid">
    <div>木 ${r.wood}/${state.capacity.wood}</div><div>石 ${r.stone}/${state.capacity.stone}</div>
    <div>铁 ${r.iron}/${state.capacity.iron}</div><div>粮 ${r.grain}/${state.capacity.grain}</div>
    <div>铜 ${r.copper}</div><div>金 ${r.gold}</div>
  </div></div>`;

  $('m-armies').innerHTML = state.armies.map((a, i) => {
    const stam = typeof a.raw?.stamina === 'number' ? a.raw.stamina : state.stamina;
    const gens = a.generals.map(g => g.name).join(', ') || '无将领';
    return `<div class="m-card"><h4>军队${i+1}</h4><div>状态: ${a.status} | 兵 ${a.totalTroops}/${a.totalTroopCap} | 体力 ${stam}/200</div><div style="color:var(--text2);font-size:11px">${gens}</div></div>`;
  }).join('');

  const bNames: Record<string, string> = { warehouse:'仓库', barracks:'兵营', army_camp:'军营', training_ground:'校场', residence:'民居', conscription_office:'征兵所' };
  $('m-buildings').innerHTML = `<div class="m-card"><h4>建筑</h4><div>${state.buildings.filter(b=>b.level>0).map(b=>`${bNames[b.type]||b.type} Lv${b.level}`).join(' | ')}</div></div>`;

  $('m-leaderboard').innerHTML = `<div class="m-card"><h4>排行榜</h4>${state.leaderboard.map((e,i) => {
    const isMe = e.playerId === myPlayerId;
    return `<div style="${isMe?'color:var(--gold);font-weight:bold':''}">${i+1}. ${e.name} Lv${e.lordLevel} 领地${e.territories}</div>`;
  }).join('')}</div>`;
}

function renderMobileSettings() {
  $('m-settings').innerHTML = `<div class="m-card">
    <h4>Bot 控制</h4>
    <button class="btn ${isRunning()?'btn-danger':'btn-primary'}" onclick="document.getElementById('bot-toggle').click()">${isRunning()?'暂停机器人':'启动机器人'}</button>
    <h4 style="margin-top:16px">AI 配置</h4>
    <div>当前: ${storage.get('ai_provider') || '无'}</div>
    <h4 style="margin-top:16px">账号</h4>
    <div>用户: ${storage.get('username') || '?'}</div>
    <button class="btn btn-secondary" onclick="document.getElementById('logout-btn').click()" style="margin-top:8px">登出</button>
    <h4 style="margin-top:16px">指令</h4>
    <div>${getDirectives().map(d => `<span class="directive-tag">${d}</span>`).join('') || '无'}</div>
  </div>`;
}

// ===== 对话 =====
$('chat-send').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') sendChat(); });

const chatHistory: AIMessage[] = [];

async function sendChat() {
  const input = $('chat-input') as HTMLInputElement;
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  addChatMsg('主公', msg, 'user');
  addDirective(msg);

  const provider = createAIProvider();
  if (provider.name === '无 AI') {
    addChatMsg('军师', `已记录指令。点击左侧 🧠 选择 AI 模型后可与军师对话。`, 'bot');
    return;
  }

  // 构建上下文
  const state = getState();
  let stateDesc = '';
  if (state) {
    const r = state.resources;
    const army = state.armies[0];
    const stam = army ? (typeof army.raw?.stamina === 'number' ? army.raw.stamina : state.stamina) : 0;
    stateDesc = `\n当前状态: 领主Lv${state.lordLevel} ${state.cityName} | 木${r.wood} 石${r.stone} 铁${r.iron} 粮${r.grain} 铜${r.copper} | 兵${army?.totalTroops||0}/${army?.totalTroopCap||0} 体力${stam} | 领地${state.ownedResourcePoints.length}/${state.resourcePointLimit} | 军队状态:${army?.status||'无'}`;
  }

  if (chatHistory.length === 0) {
    chatHistory.push({ role: 'system', content: GAME_RULES + '\n你是这个游戏的 AI 军师，用简洁的中文回答。' + stateDesc });
  } else {
    // 更新 system 里的状态
    chatHistory[0].content = GAME_RULES + '\n你是这个游戏的 AI 军师，用简洁的中文回答。' + stateDesc;
  }
  chatHistory.push({ role: 'user', content: msg });

  // 显示加载
  const loadingId = addChatMsg('军师', '思考中...', 'bot loading');

  try {
    // WebLLM 需要先加载
    if ('ensureLoaded' in provider) {
      const webllm = provider as { ensureLoaded(): Promise<void>; getStatus(): string };
      const statusEl = document.getElementById(loadingId);
      const updateStatus = () => {
        if (statusEl) {
          const s = webllm.getStatus();
          statusEl.querySelector('.msg-text')!.textContent = s;
        }
      };
      const interval = setInterval(updateStatus, 500);
      await webllm.ensureLoaded();
      clearInterval(interval);
      if (statusEl) statusEl.querySelector('.msg-text')!.textContent = '思考中...';
    }

    const result = await provider.chat(chatHistory, thinkingEnabled);
    chatHistory.push({ role: 'assistant', content: result.reply });
    // 限制历史长度
    while (chatHistory.length > 20) chatHistory.splice(1, 2);
    // 显示思考 + 回复
    let html = '';
    if (result.think) {
      html += `<div class="think-block">💭 ${escapeHtml(result.think)}</div>`;
    }
    html += escapeHtml(result.reply);
    updateChatMsgHtml(loadingId, html, 'bot');
  } catch (e) {
    updateChatMsg(loadingId, `错误: ${(e as Error).message}`, 'bot error');
  }
}

let chatMsgId = 0;
function addChatMsg(sender: string, text: string, cls: string): string {
  const id = `chat-msg-${++chatMsgId}`;
  const container = $('chat-messages');
  const div = document.createElement('div');
  div.id = id;
  div.className = 'chat-msg ' + cls;
  div.innerHTML = `<span class="sender">${sender}:</span> <span class="msg-text">${text}</span>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return id;
}

function updateChatMsg(id: string, text: string, cls: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'chat-msg ' + cls;
  const msgText = el.querySelector('.msg-text');
  if (msgText) msgText.textContent = text;
}

function updateChatMsgHtml(id: string, html: string, cls: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'chat-msg ' + cls;
  const msgText = el.querySelector('.msg-text');
  if (msgText) msgText.innerHTML = html;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ===== Tab 栏 =====
document.querySelectorAll('#tab-bar .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#tab-bar .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const target = (tab as HTMLElement).dataset.tab!;
    $(target).classList.add('active');
    // 切到地图 tab 时，把 map-panel 移到 tab 里
    if (target === 'tab-map') {
      $('tab-map').appendChild($('map-panel'));
    }
  });
});

// ===== 事件监听 =====
onEvent((event, data) => {
  if (event === 'state') {
    const { state, map } = data as { state: GameState; map: MapData | null };
    myPlayerId = state.playerId;
    currentState = state;
    currentMap = map;
    renderTopBar(state);
    renderLeaderboard(state);
    renderMap(state, map);
    renderBottomBar(state);
    renderMobileStatus(state);
    renderMobileSettings();
  } else if (event === 'decision') {
    const { round, decision } = data as { round: number; decision: Decision };
    addDecisionCard(round, decision);
    // 手机端也加
    const mDec = $('m-decisions');
    if (mDec) {
      const card = document.createElement('div');
      card.className = 'decision-card';
      card.innerHTML = `<div class="decision-round">第 ${round} 轮</div><div class="decision-analysis">${decision.analysis}</div><span class="decision-action action-default">${decision.action}</span>`;
      mDec.prepend(card);
      while (mDec.children.length > 30) mDec.removeChild(mDec.lastChild!);
    }
  } else if (event === 'botStatus') {
    const running = data as boolean;
    const el = $('bot-status');
    const btn = $('bot-toggle');
    el.className = running ? 'bot-status running' : 'bot-status stopped';
    el.textContent = running ? '运行中' : '已停止';
    btn.textContent = running ? '暂停' : '启动';
  }
});

// ===== 初始化 =====
renderSetup();
if (isLoggedIn()) {
  hide($('login-overlay'));
  enterGame();
} else {
  show($('login-overlay'));
  hide($('setup-overlay'));
}
