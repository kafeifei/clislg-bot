import { storage } from '../storage.js';

export interface AIMessage { role: string; content: string }

export interface AIProvider {
  name: string;
  chat(messages: AIMessage[]): Promise<string>;
  isAvailable(): boolean;
}

// ===== Google Gemini（直接调用，CORS 支持）=====
class GeminiProvider implements AIProvider {
  name = 'Google Gemini';
  isAvailable() { return !!storage.get('ai_key'); }

  async chat(messages: AIMessage[]): Promise<string> {
    const key = storage.get('ai_key');
    if (!key) throw new Error('No Gemini API key');

    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    // system message → 放到第一个 user message 前面
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
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
}

// ===== OpenAI（通过 Edge Function 代理）=====
class OpenAIProxyProvider implements AIProvider {
  name = 'OpenAI GPT';
  isAvailable() { return !!storage.get('ai_key'); }

  async chat(messages: AIMessage[]): Promise<string> {
    const key = storage.get('ai_key');
    if (!key) throw new Error('No OpenAI API key');

    const resp = await fetch('/api/ai-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini', messages, apiKey: key }),
    });

    const data = await resp.json() as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    if (data.error) throw new Error(data.error.message);
    return data.choices?.[0]?.message?.content || '';
  }
}

// ===== Anthropic Claude（通过 Edge Function 代理）=====
class AnthropicProxyProvider implements AIProvider {
  name = 'Anthropic Claude';
  isAvailable() { return !!storage.get('ai_key'); }

  async chat(messages: AIMessage[]): Promise<string> {
    const key = storage.get('ai_key');
    if (!key) throw new Error('No Anthropic API key');

    const resp = await fetch('/api/ai-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4-20250514', messages, apiKey: key }),
    });

    const data = await resp.json() as { content?: { text?: string }[]; error?: { message?: string } };
    if (data.error) throw new Error(data.error.message);
    return data.content?.[0]?.text || '';
  }
}

// ===== None（不使用 AI）=====
class NoneProvider implements AIProvider {
  name = '无 AI';
  isAvailable() { return false; }
  async chat(): Promise<string> { return ''; }
}

// ===== 工厂 =====
export function createAIProvider(): AIProvider {
  const providerType = storage.get('ai_provider');
  switch (providerType) {
    case 'google': return new GeminiProvider();
    case 'openai': return new OpenAIProxyProvider();
    case 'anthropic': return new AnthropicProxyProvider();
    default: return new NoneProvider();
  }
}
