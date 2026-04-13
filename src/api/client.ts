import { createLogger } from '../logger.js';

const log = createLogger('api');

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API error ${status}: ${JSON.stringify(body)}`);
    this.name = 'ApiError';
  }
}

export class AuthError extends ApiError {
  constructor(body: unknown) {
    super(401, body);
    this.name = 'AuthError';
  }
}

export class RateLimitError extends ApiError {
  public retryAfter: number;
  constructor(body: unknown, retryAfter = 60) {
    super(429, body);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class ApiClient {
  private token: string | null = null;
  private playerId: string | null = null;

  constructor(public baseUrl: string) {}

  setAuth(token: string, playerId: string) {
    this.token = token;
    this.playerId = playerId;
    log.info(`认证成功: playerId=${playerId}`);
  }

  getPlayerId(): string | null {
    return this.playerId;
  }

  isAuthenticated(): boolean {
    return this.token !== null;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, retries = 3): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        log.debug(`${method} ${path}`, body);
        const resp = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });

        const text = await resp.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }

        if (resp.ok) {
          log.debug(`${method} ${path} => ${resp.status}`);
          return data as T;
        }

        if (resp.status === 401) {
          throw new AuthError(data);
        }
        if (resp.status === 429) {
          const retryAfter = parseInt(resp.headers.get('retry-after') || '60', 10);
          throw new RateLimitError(data, retryAfter);
        }
        if (resp.status >= 500 && attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
          log.warn(`服务器错误 ${resp.status}，${delay}ms 后重试 (${attempt}/${retries})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new ApiError(resp.status, data);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        if (attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
          log.warn(`网络错误，${delay}ms 后重试 (${attempt}/${retries})`, (e as Error).message);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw e;
      }
    }
    throw new Error('unreachable');
  }

  get<T = unknown>(path: string) {
    return this.request<T>('GET', path);
  }

  post<T = unknown>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body);
  }
}
