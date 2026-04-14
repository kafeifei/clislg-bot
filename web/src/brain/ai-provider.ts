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

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
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

    const resp = await fetch('/api/ai-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini', messages, apiKey: key }),
    });

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

    const resp = await fetch('/api/ai-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4-20250514', messages, apiKey: key }),
    });

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
    this.status = '加载 WebLLM 引擎...';
    try {
      const webllm = await import('@mlc-ai/web-llm');
      this.status = `下载模型 ${modelId}...`;
      const engine = await webllm.CreateMLCEngine(modelId, {
        initProgressCallback: (report: { text: string }) => {
          this.status = report.text;
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
  // 自愈：未选 provider 但有模型选择，自动切 webllm
  if ((!providerType || providerType === 'none') && storage.get('webllm_model')) {
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
