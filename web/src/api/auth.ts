import { storage } from '../storage.js';

const BASE_URL = 'https://clislg.filo.ai/api/v4';

interface AuthResult { token: string; playerId: string; error?: string; message?: string }

export async function login(username: string, password: string): Promise<AuthResult> {
  const resp = await fetch(BASE_URL + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await resp.json() as AuthResult;
  if (data.token) saveAuth(username, password, data.token, data.playerId);
  return data;
}

export async function register(username: string, password: string): Promise<AuthResult> {
  const resp = await fetch(BASE_URL + '/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await resp.json() as AuthResult;
  if (data.token) saveAuth(username, password, data.token, data.playerId);
  return data;
}

function saveAuth(user: string, pass: string, token: string, pid: string) {
  storage.set('username', user);
  storage.set('password', pass);
  storage.set('token', token);
  storage.set('playerId', pid);
}

export function logout() {
  storage.remove('token');
  storage.remove('playerId');
}

export function isLoggedIn(): boolean {
  return !!storage.get('token') && !!storage.get('playerId');
}
