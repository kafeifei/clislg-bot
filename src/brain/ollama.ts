import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('ollama');

interface OllamaResponse {
  model: string;
  response: string;
  done: boolean;
}

export async function chat(prompt: string, timeoutMs = 60000): Promise<string> {
  const url = `${config.ollamaUrl}/api/chat`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    log.debug('发送请求到 Ollama...');
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        messages: [
          { role: 'system', content: 'You are a strategy game advisor. You MUST respond with ONLY a JSON object, nothing else. No thinking, no analysis text, no markdown. Just raw JSON starting with { and ending with }.' },
          { role: 'user', content: prompt },
        ],
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 1024,
        },
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Ollama 错误 ${resp.status}: ${text}`);
    }

    const data = await resp.json() as {
      message?: { content: string; thinking?: string };
      response?: string;
    };
    log.debug('Ollama 响应完成');
    // qwen3.5 把内容放在 thinking 字段，content 为空
    const content = data.message?.content || '';
    const thinking = data.message?.thinking || '';
    const result = content || thinking || data.response || '';
    return result;
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      log.warn(`Ollama 请求超时 (${timeoutMs}ms)`);
      throw new Error('Ollama 请求超时');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function isAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${config.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
