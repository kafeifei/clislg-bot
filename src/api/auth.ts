import { ApiClient, ApiError } from './client.js';
import { createLogger } from '../logger.js';
import type { AuthResult } from '../types.js';

const log = createLogger('auth');

export async function register(client: ApiClient, username: string, password: string): Promise<AuthResult> {
  log.info(`注册新账号: ${username}`);
  const result = await client.post<AuthResult>('/auth/register', { username, password });
  client.setAuth(result.token, result.playerId);
  return result;
}

export async function login(client: ApiClient, username: string, password: string): Promise<AuthResult> {
  log.info(`登录: ${username}`);
  const result = await client.post<AuthResult>('/auth/login', { username, password });
  client.setAuth(result.token, result.playerId);
  return result;
}

export async function ensureAuthenticated(client: ApiClient, username: string, password: string): Promise<void> {
  if (client.isAuthenticated()) return;

  try {
    await login(client, username, password);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 401)) {
      log.info('登录失败，尝试注册新账号...');
      await register(client, username, password);
    } else {
      throw e;
    }
  }
}
