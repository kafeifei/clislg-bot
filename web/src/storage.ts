const PREFIX = 'clislg_';

export const storage = {
  get(k: string): string | null { return localStorage.getItem(PREFIX + k); },
  set(k: string, v: string) { localStorage.setItem(PREFIX + k, v); },
  remove(k: string) { localStorage.removeItem(PREFIX + k); },
  getJSON<T>(k: string): T | null { try { return JSON.parse(this.get(k)!); } catch { return null; } },
  setJSON(k: string, v: unknown) { this.set(k, JSON.stringify(v)); },
};
