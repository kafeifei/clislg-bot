import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), '.env');
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {}
}

loadEnv();

export const config = Object.freeze({
  username: process.env.USERNAME || 'sunzi_bot',
  password: process.env.PASSWORD || 'changeme123',
  baseUrl: process.env.BASE_URL || 'https://clislg.filo.ai/api/v4',
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen3.5:latest',
  webPort: parseInt(process.env.WEB_PORT || '3000', 10),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '15000', 10),
  logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
});
