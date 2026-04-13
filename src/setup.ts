import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createInterface } from 'readline';
import { createLogger } from './logger.js';
import { config } from './config.js';

const log = createLogger('setup');

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * 检查 .env 是否已配置好，否则引导用户设置
 */
export async function runSetup(): Promise<{ username: string; password: string }> {
  const envPath = resolve(process.cwd(), '.env');
  const isDefault = config.username === 'sunzi_bot' && config.password === 'changeme123';

  if (!isDefault) {
    // 已有配置，非交互模式直接使用
    log.info(`当前账号: ${config.username}`);
    if (!process.stdin.isTTY) {
      // 非交互环境（如 Preview），直接用已有配置
      return { username: config.username, password: config.password };
    }
    const choice = await ask(`\n检测到已有账号「${config.username}」，是否继续使用？(Y/n) `);
    if (choice.toLowerCase() === 'n') {
      return await setupNewAccount(envPath);
    }
    return { username: config.username, password: config.password };
  }

  // 首次启动引导
  console.log('\n' + '═'.repeat(50));
  console.log('  CLISLG 助手 — 首次启动设置');
  console.log('═'.repeat(50));
  console.log('\n欢迎，主公！在进入战场之前，需要一些准备。\n');

  return await setupNewAccount(envPath);
}

async function setupNewAccount(envPath: string): Promise<{ username: string; password: string }> {
  // 起名（不做格式校验，让服务器决定）
  let username = '';
  while (!username) {
    username = await ask('请为你的势力命名（游戏用户名）: ');
    if (!username) console.log('名字不能为空！');
  }

  // 密码
  let password = '';
  while (!password) {
    password = await ask('设置密码: ');
    if (!password) console.log('密码不能为空！');
  }

  // 写入 .env
  let envContent = '';
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, 'utf-8');
    // 替换 USERNAME 和 PASSWORD
    envContent = envContent.replace(/^USERNAME=.*$/m, `USERNAME=${username}`);
    envContent = envContent.replace(/^PASSWORD=.*$/m, `PASSWORD=${password}`);
  } else {
    envContent = `USERNAME=${username}
PASSWORD=${password}
BASE_URL=https://clislg.filo.ai/api/v4
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen3.5:latest
WEB_PORT=3000
POLL_INTERVAL_MS=15000
LOG_LEVEL=info
`;
  }
  writeFileSync(envPath, envContent, 'utf-8');

  console.log(`\n配置已保存！你的势力名: ${username}`);
  console.log('下次启动将自动使用此账号。\n');

  return { username, password };
}
