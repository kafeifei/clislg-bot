/**
 * Vercel Edge Function — 代理 OpenAI / Anthropic API
 * Google Gemini 从浏览器直接调用（CORS 支持），不需要代理
 * API Key 从请求体传入，不在服务器存储
 */
export const config = { runtime: 'edge' };

interface ProxyRequest {
  provider: 'openai' | 'anthropic';
  model: string;
  messages: { role: string; content: string }[];
  apiKey: string;
  maxTokens?: number;
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const body = await req.json() as ProxyRequest;
    const { provider, model, messages, apiKey, maxTokens = 1024 } = body;

    if (!provider || !apiKey || !messages) {
      return new Response(JSON.stringify({ error: 'Missing fields: provider, apiKey, messages' }), { status: 400 });
    }

    let upstreamUrl: string;
    let headers: Record<string, string>;
    let upstreamBody: unknown;

    if (provider === 'openai') {
      upstreamUrl = 'https://api.openai.com/v1/chat/completions';
      headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      upstreamBody = { model: model || 'gpt-4o-mini', messages, max_tokens: maxTokens };
    } else if (provider === 'anthropic') {
      upstreamUrl = 'https://api.anthropic.com/v1/messages';
      headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
      // Anthropic 格式：system 单独，messages 只有 user/assistant
      const systemMsg = messages.find(m => m.role === 'system');
      const chatMsgs = messages.filter(m => m.role !== 'system');
      upstreamBody = {
        model: model || 'claude-sonnet-4-20250514',
        system: systemMsg?.content || '',
        messages: chatMsgs,
        max_tokens: maxTokens,
      };
    } else {
      return new Response(JSON.stringify({ error: 'Unknown provider' }), { status: 400 });
    }

    const resp = await fetch(upstreamUrl, {
      method: 'POST', headers,
      body: JSON.stringify(upstreamBody),
    });

    const data = await resp.text();

    return new Response(data, {
      status: resp.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
