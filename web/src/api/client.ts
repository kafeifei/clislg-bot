import { storage } from '../storage.js';

const BASE_URL = 'https://clislg.filo.ai/api/v4';

export function getToken(): string | null { return storage.get('token'); }
export function getPlayerId(): string | null { return storage.get('playerId'); }

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const resp = await fetch(BASE_URL + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }

  if (resp.ok) return data as T;

  // 401: 自动重新登录
  if (resp.status === 401) {
    const user = storage.get('username'), pass = storage.get('password');
    if (user && pass) {
      const reauth = await fetch(BASE_URL + '/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      });
      if (reauth.ok) {
        const d = await reauth.json() as { token: string; playerId: string };
        storage.set('token', d.token);
        storage.set('playerId', d.playerId);
        return api(method, path, body); // 重试
      }
    }
  }

  throw { status: resp.status, data };
}
