import { ApiClient } from './api/client.js';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { runGameLoop } from './game-loop.js';
import { startWebServer } from './web/server.js';
import { isAvailable } from './brain/ollama.js';
import { runSetup } from './setup.js';

const log = createLogger('main');

async function main() {
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║     CLISLG 助手  v1.0               ║');
  console.log('  ║     "知己知彼，百战不殆"             ║');
  console.log('  ╚══════════════════════════════════════╝\n');

  // 首次启动引导 / 账号确认
  const { username, password } = await runSetup();

  log.info(`势力: ${username}`);
  log.info(`API: ${config.baseUrl}`);
  log.info(`Ollama: ${config.ollamaUrl} (${config.ollamaModel})`);

  // 检查 Ollama
  const ollamaOk = await isAvailable();
  if (ollamaOk) {
    log.info('Ollama 军师就位');
  } else {
    log.warn('Ollama 不可用！将使用规则兜底决策。请运行: ollama serve');
  }

  // 启动 Web 观战面板
  startWebServer();
  log.info(`观战面板: http://localhost:${config.webPort}`);

  // 创建 API 客户端，用引导得到的凭证覆盖
  const client = new ApiClient(config.baseUrl);

  // 启动游戏循环（传入实际凭证）
  await runGameLoop(client, username, password);
}

main().catch((err) => {
  log.error('致命错误', err);
  process.exit(1);
});
