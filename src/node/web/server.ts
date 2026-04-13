import { createServer } from 'http';
import { readFileSync, watchFile } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config.js';
import { createLogger, onLog } from '../logger.js';
import { onBroadcast, getLatestState, getLatestMap, getRound, getDecisionHistory } from '../game-loop.js';
import { chatWithLord, issueDirective, removeDirective, getDirectives } from '../brain/strategist.js';
import type { GameState, MapData } from '../types.js';

const log = createLogger('web');
const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedHtml: string | null = null;

function getHtml(): string {
  if (!cachedHtml) {
    cachedHtml = readFileSync(resolve(__dirname, 'index.html'), 'utf-8');
  }
  return cachedHtml;
}

export function startWebServer() {
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      // 开发时不缓存
      cachedHtml = null;
      res.end(getHtml());
    } else if (req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        state: getLatestState(),
        map: getLatestMap(),
        round: getRound(),
        decisions: getDecisionHistory(),
        directives: getDirectives(),
      }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  const wss = new WebSocketServer({ server });
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    log.info(`观战者连接 (当前${clients.size}人)`);

    // 发送当前状态
    const state = getLatestState();
    if (state) {
      ws.send(JSON.stringify({
        type: 'state',
        data: { state, map: getLatestMap(), round: getRound() },
        timestamp: new Date().toISOString(),
      }));
    }
    // 发送历史决策
    const history = getDecisionHistory();
    if (history.length > 0) {
      ws.send(JSON.stringify({
        type: 'history',
        data: history,
        timestamp: new Date().toISOString(),
      }));
    }
    // 发送当前指令
    ws.send(JSON.stringify({
      type: 'directive_update',
      data: getDirectives(),
      timestamp: new Date().toISOString(),
    }));

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'chat') {
          // 主公对话
          const state = getLatestState();
          const map = getLatestMap();
          if (state) {
            const reply = await chatWithLord(msg.message, state, map ?? undefined);
            ws.send(JSON.stringify({
              type: 'chat_response',
              data: { message: msg.message, reply },
              timestamp: new Date().toISOString(),
            }));
          }
        } else if (msg.type === 'directive') {
          // 下达指令
          issueDirective(msg.message, msg.persistent !== false);
          broadcast({
            type: 'directive_update',
            data: getDirectives(),
            timestamp: new Date().toISOString(),
          });
        } else if (msg.type === 'remove_directive') {
          removeDirective(msg.index);
          broadcast({
            type: 'directive_update',
            data: getDirectives(),
            timestamp: new Date().toISOString(),
          });
        }
      } catch (e) {
        log.error('处理 WebSocket 消息失败', (e as Error).message);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      log.info(`观战者断开 (当前${clients.size}人)`);
    });
  });

  function broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  // 订阅游戏循环广播
  onBroadcast((msg) => broadcast(msg));

  // 订阅日志
  onLog((entry) => {
    broadcast({
      type: 'log',
      data: entry,
      timestamp: new Date().toISOString(),
    });
  });

  // 监听 index.html 变化，通知浏览器刷新
  const htmlPath = resolve(__dirname, 'index.html');
  watchFile(htmlPath, { interval: 1000 }, () => {
    cachedHtml = null;
    log.info('index.html 已更新，通知浏览器刷新');
    broadcast({ type: 'reload', data: null, timestamp: new Date().toISOString() });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = config.webPort + 1;
      log.warn(`端口 ${config.webPort} 被占用，尝试 ${nextPort}...`);
      server.listen(nextPort, () => {
        log.info(`观战面板已启动: http://localhost:${nextPort}`);
      });
    } else {
      log.error('Web 服务启动失败', err.message);
    }
  });

  server.listen(config.webPort, () => {
    log.info(`观战面板已启动: http://localhost:${config.webPort}`);
  });
}
