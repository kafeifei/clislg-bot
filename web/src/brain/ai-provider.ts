import { storage } from '../storage.js';

export interface AIMessage { role: string; content: string }

export interface AIProvider {
  name: string;
  chat(messages: AIMessage[], thinking?: boolean): Promise<{ reply: string; think?: string }>;
  isAvailable(): boolean;
  isLoading(): boolean;
  getStatus(): string;
}

// ===== WebLLM 模型列表 =====
export interface WebLLMModel {
  id: string;
  label: string;
  size: string;
  zhLevel: number; // 1-5 中文能力
  thinkType: 'deep' | 'think' | 'none'; // 深度思考 / 思考 / 无
  group: string;
}

export const WEBLLM_MODELS: WebLLMModel[] = [
  // Qwen（按大小排序）
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 0.5B', size: '945MB', zhLevel: 1, thinkType: 'none', group: 'Qwen' },
  { id: 'Qwen3-0.6B-q4f16_1-MLC', label: 'Qwen3 0.6B', size: '1.4GB', zhLevel: 2, thinkType: 'think', group: 'Qwen' },
  { id: 'Qwen3-1.7B-q4f16_1-MLC', label: 'Qwen3 1.7B', size: '2.0GB', zhLevel: 3, thinkType: 'think', group: 'Qwen' },
  { id: 'Qwen3-4B-q4f16_1-MLC', label: 'Qwen3 4B', size: '3.4GB', zhLevel: 4, thinkType: 'think', group: 'Qwen' },
  { id: 'Qwen3-8B-q4f16_1-MLC', label: 'Qwen3 8B', size: '5.7GB', zhLevel: 5, thinkType: 'think', group: 'Qwen' },
  // DeepSeek
  { id: 'DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC', label: 'DeepSeek-R1 7B', size: '5.1GB', zhLevel: 5, thinkType: 'deep', group: 'DeepSeek' },
  { id: 'DeepSeek-R1-Distill-Llama-8B-q4f16_1-MLC', label: 'DeepSeek-R1 Llama 8B', size: '5.0GB', zhLevel: 3, thinkType: 'deep', group: 'DeepSeek' },
  // Llama
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B', size: '879MB', zhLevel: 1, thinkType: 'none', group: 'Llama' },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B', size: '2.3GB', zhLevel: 2, thinkType: 'none', group: 'Llama' },
  { id: 'Llama-3.1-8B-Instruct-q4f16_1-MLC', label: 'Llama 3.1 8B', size: '5.0GB', zhLevel: 3, thinkType: 'none', group: 'Llama' },
];

export function getSelectedModel(): WebLLMModel {
  const id = storage.get('webllm_model') || 'Qwen3-1.7B-q4f16_1-MLC';
  return WEBLLM_MODELS.find(m => m.id === id) || WEBLLM_MODELS[1];
}

// ===== 云端模型列表 =====
export interface CloudModel { id: string; label: string; hint?: string }

// 推荐模型（硬编码 fallback，按 2026 年 4 月最新） —— 实际列表会从 API 拉
const OPENAI_RECOMMENDED: CloudModel[] = [
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', hint: '推荐 · 便宜快速' },
  { id: 'gpt-5.4', label: 'GPT-5.4', hint: '旗舰' },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', hint: '最便宜' },
  { id: 'gpt-5.4-pro', label: 'GPT-5.4 pro', hint: '最强' },
];
const ANTHROPIC_RECOMMENDED: CloudModel[] = [
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', hint: '推荐 · 最新' },
  { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', hint: '最强' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: '快' },
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
];
const GOOGLE_RECOMMENDED: CloudModel[] = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', hint: '推荐 · 免费额度' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', hint: '旗舰' },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
];

const RECOMMENDED: Record<string, CloudModel[]> = {
  openai: OPENAI_RECOMMENDED,
  anthropic: ANTHROPIC_RECOMMENDED,
  google: GOOGLE_RECOMMENDED,
};

// 缓存的动态模型列表
const liveModelsCache = new Map<string, CloudModel[]>();

/**
 * 从 provider API 拉真实可用的模型列表，失败则返回推荐列表
 */
export async function fetchLiveCloudModels(provider: string): Promise<CloudModel[]> {
  if (liveModelsCache.has(provider)) return liveModelsCache.get(provider)!;

  const key = storage.get('ai_key');
  if (!key) return RECOMMENDED[provider] || [];

  try {
    if (provider === 'openai') {
      const resp = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${key}` },
      });
      if (!resp.ok) throw new Error(`${resp.status}`);
      const data = await resp.json() as { data: { id: string }[] };
      const ids = data.data.map(m => m.id);
      const chatModels = ids.filter(id =>
        /^gpt-5\.4/i.test(id) &&          // 只要 gpt-5.4 系列
        !/(audio|whisper|tts|embed|dall|image|moderation|search|realtime|codex|chat-latest)/i.test(id) &&
        !/^ft:/i.test(id) &&
        !/\d{4}-\d{2}-\d{2}$/.test(id)
      ).sort((a, b) => a.localeCompare(b));
      const result = chatModels.map(id => ({ id, label: id }));
      if (result.length) {
        liveModelsCache.set(provider, result);
        return result;
      }
    } else if (provider === 'anthropic') {
      const resp = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      });
      if (!resp.ok) throw new Error(`${resp.status}`);
      const data = await resp.json() as { data: { id: string; display_name?: string }[] };
      const result = data.data.map(m => ({ id: m.id, label: m.display_name || m.id }));
      if (result.length) {
        liveModelsCache.set(provider, result);
        return result;
      }
    } else if (provider === 'google') {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      if (!resp.ok) throw new Error(`${resp.status}`);
      const data = await resp.json() as { models: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
      const result = data.models
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => ({
          id: m.name.replace(/^models\//, ''),
          label: m.displayName || m.name.replace(/^models\//, ''),
        }));
      if (result.length) {
        liveModelsCache.set(provider, result);
        return result;
      }
    }
  } catch (e) {
    console.warn(`拉取 ${provider} 模型列表失败:`, (e as Error).message);
  }
  return RECOMMENDED[provider] || [];
}

export function getCloudModels(provider: string): CloudModel[] {
  // 同步版本，返回缓存或推荐
  return liveModelsCache.get(provider) || RECOMMENDED[provider] || [];
}
export function getCloudModelId(provider: string): string {
  const saved = storage.get(`${provider}_model`);
  if (saved) return saved;
  const list = getCloudModels(provider);
  return list[0]?.id || '';
}
export function clearLiveModelsCache(provider?: string) {
  if (provider) liveModelsCache.delete(provider);
  else liveModelsCache.clear();
}

// ===== Google Gemini =====
class GeminiProvider implements AIProvider {
  name = 'Google Gemini';
  isAvailable() { return !!storage.get('ai_key'); }
  isLoading() { return false; }
  getStatus() { return this.isAvailable() ? '就绪' : '需要 API Key'; }

  async chat(messages: AIMessage[]): Promise<{ reply: string }> {
    const key = storage.get('ai_key');
    if (!key) throw new Error('No Gemini API key');

    const sysMsg = messages.find(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const model = getCloudModelId('google');
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: chatMsgs,
          systemInstruction: sysMsg ? { parts: [{ text: sysMsg.content }] } : undefined,
          generationConfig: { maxOutputTokens: 1024 },
        }),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Gemini error ${resp.status}: ${err}`);
    }

    const data = await resp.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return { reply: data.candidates?.[0]?.content?.parts?.[0]?.text || '' };
  }
}

// ===== OpenAI =====
class OpenAIProxyProvider implements AIProvider {
  name = 'OpenAI GPT';
  isAvailable() { return !!storage.get('ai_key'); }
  isLoading() { return false; }
  getStatus() { return this.isAvailable() ? '就绪' : '需要 API Key'; }

  async chat(messages: AIMessage[]): Promise<{ reply: string }> {
    const key = storage.get('ai_key');
    if (!key) throw new Error('No OpenAI API key');

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: getCloudModelId('openai'),
        messages,
        max_completion_tokens: 1024, // gpt-5+ 要求这个参数，旧模型也兼容
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI ${resp.status}: ${err.slice(0, 200)}`);
    }
    const data = await resp.json() as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    if (data.error) throw new Error(data.error.message);
    return { reply: data.choices?.[0]?.message?.content || '' };
  }
}

// ===== Anthropic =====
class AnthropicProxyProvider implements AIProvider {
  name = 'Anthropic Claude';
  isAvailable() { return !!storage.get('ai_key'); }
  isLoading() { return false; }
  getStatus() { return this.isAvailable() ? '就绪' : '需要 API Key'; }

  async chat(messages: AIMessage[]): Promise<{ reply: string }> {
    const key = storage.get('ai_key');
    if (!key) throw new Error('No Anthropic API key');

    // Anthropic 浏览器直连必须加此 header
    const sysMsg = messages.find(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: getCloudModelId('anthropic'),
        max_tokens: 1024,
        system: sysMsg?.content,
        messages: chatMsgs,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Anthropic ${resp.status}: ${err.slice(0, 200)}`);
    }
    const data = await resp.json() as { content?: { text?: string }[]; error?: { message?: string } };
    if (data.error) throw new Error(data.error.message);
    return { reply: data.content?.[0]?.text || '' };
  }
}

// ===== WebLLM =====
class WebLLMProvider implements AIProvider {
  name = '浏览器本地 (WebLLM)';
  private engine: unknown = null;
  private loading = false;
  private status = '未初始化';
  private initPromise: Promise<void> | null = null;
  private currentModelId: string | null = null;

  isAvailable() { return !!this.engine; }
  isLoading() { return this.loading; }
  getStatus() { return this.status; }

  async ensureLoaded(): Promise<void> {
    const model = getSelectedModel();
    // 如果模型变了，重新加载
    if (this.engine && this.currentModelId !== model.id) {
      this.engine = null;
      this.initPromise = null;
    }
    if (this.engine) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._load(model.id);
    return this.initPromise;
  }

  private async _load(modelId: string): Promise<void> {
    this.loading = true;
    this.status = '初始化 WebLLM...';
    try {
      const webllm = await import('@mlc-ai/web-llm');
      const cached = await webllm.hasModelInCache(modelId).catch(() => false);
      this.status = cached ? `加载已缓存模型...` : `首次下载模型（仅需一次）...`;
      const engine = await webllm.CreateMLCEngine(modelId, {
        initProgressCallback: (report: { text: string; progress?: number }) => {
          // WebLLM 的 text 格式：
          //   未缓存:    "Fetching param cache[x/y]: NMB fetched. N% completed"
          //   已缓存载入: "Loading model from cache[x/y]" 或类似
          const raw = report.text || '';
          const isFetching = /fetching|downloading/i.test(raw);
          const isLoading = /loading|caching/i.test(raw);
          const prefix = isFetching ? '⬇ 下载中' : isLoading ? '⏳ 加载中' : '';
          // 抽出百分比或片段计数
          const pct = raw.match(/(\d+)%/);
          const seg = raw.match(/\[(\d+)\/(\d+)\]/);
          const detail = pct ? `${pct[1]}%` : seg ? `${seg[1]}/${seg[2]}` : raw.slice(0, 60);
          this.status = prefix ? `${prefix} ${detail}` : raw.slice(0, 80);
        },
      });
      this.engine = engine;
      this.currentModelId = modelId;
      this.loading = false;
      this.status = '就绪';
    } catch (e) {
      this.loading = false;
      this.status = `加载失败: ${(e as Error).message}`;
      this.initPromise = null;
      throw e;
    }
  }

  async chat(messages: AIMessage[], thinking = false): Promise<{ reply: string; think?: string }> {
    await this.ensureLoaded();
    const model = getSelectedModel();
    const engine = this.engine as { chat: { completions: { create: (opts: unknown) => Promise<{ choices: { message: { content: string } }[] }> } } };

    // 如果不支持思考或关闭思考，在 system 里加 /nothink
    const processedMsgs = messages.map(m => {
      if (m.role === 'system' && model.thinkType !== 'none' && !thinking) {
        return { role: m.role, content: m.content + '\n/nothink' };
      }
      return { role: m.role, content: m.content };
    });

    const resp = await engine.chat.completions.create({
      messages: processedMsgs,
      max_tokens: 1024,
      temperature: 0.7,
    });
    const raw = resp.choices[0]?.message?.content || '';

    // 提取思考内容和回复
    const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/);
    const thinkContent = thinkMatch ? thinkMatch[1].trim() : undefined;
    const reply = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    return { reply, think: thinkContent };
  }
}

// ===== None =====
class NoneProvider implements AIProvider {
  name = '无 AI';
  isAvailable() { return false; }
  isLoading() { return false; }
  getStatus() { return '纯规则引擎模式'; }
  async chat(): Promise<{ reply: string }> { return { reply: '' }; }
}

// ===== 单例 + 工厂 =====
let currentProvider: AIProvider | null = null;

export function createAIProvider(): AIProvider {
  if (currentProvider) return currentProvider;
  let providerType = storage.get('ai_provider');
  // 自愈：从未选过 provider 但选过 webllm 模型 → 默认 webllm
  // 显式选了 'none'/'openai'/'anthropic'/'google' 就尊重用户选择
  if (!providerType && storage.get('webllm_model')) {
    providerType = 'webllm';
    storage.set('ai_provider', 'webllm');
  }
  switch (providerType) {
    case 'google': currentProvider = new GeminiProvider(); break;
    case 'openai': currentProvider = new OpenAIProxyProvider(); break;
    case 'anthropic': currentProvider = new AnthropicProxyProvider(); break;
    case 'webllm': currentProvider = new WebLLMProvider(); break;
    default: currentProvider = new NoneProvider();
  }
  return currentProvider;
}

export function resetProvider() { currentProvider = null; }
