import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { GAME_RULES } from './game-rules.js';

const log = createLogger('ollama');

// 最近一次模型的 thinking 过程
let lastThinking = '';
export function getLastThinking(): string { return lastThinking; }

/**
 * 向模型发送带游戏规则上下文的请求
 * systemOverride: 覆盖默认 system prompt（用于对话等非决策场景）
 */
export async function chat(prompt: string, timeoutMs = 60000, systemOverride?: string): Promise<string> {
  const url = `${config.ollamaUrl}/api/chat`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const systemPrompt = systemOverride || GAME_RULES;

  try {
    log.debug('发送请求到 Ollama...');
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        stream: false,
        think: true,
        options: {
          temperature: 0.7,
          num_predict: 8192,
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
    const content = data.message?.content || '';
    const thinking = data.message?.thinking || '';

    // 保存最近一次 thinking 供 Web 展示
    lastThinking = thinking;

    // content 是最终输出，thinking 只是推理过程
    // 如果 content 为空（模型没输出结论），才 fallback 到 thinking
    return content || data.response || '';
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
