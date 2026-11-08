import type { Env } from './env';

/** D1-shaped interface preserves domain transaction boundaries over private HTTPS SQLite. */
export function remoteData(env: Env) {
  const base = new URL(env.DATA_SERVICE_URL!);
  const local = env.APP_ENV === 'development' && ['localhost', '127.0.0.1'].includes(base.hostname);
  if (base.protocol !== 'https:' && !local) throw new Error('Data service requires HTTPS');
  if (!env.DATA_SERVICE_AUTHORIZATION) throw new Error('Data service credentials missing');
  async function request(path: string, method: string, body?: string) {
    const response = await fetch(base.href.replace(/\/$/, '') + path, {
      method, body, redirect: 'manual',
      // Large commits cross a slow tunnel; allow ~50 KB/s on top of the base budget.
      signal: AbortSignal.timeout(30_000 + Math.min(90_000, Math.round((body?.length ?? 0) / 50))),
      headers: { Authorization: env.DATA_SERVICE_AUTHORIZATION!, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(failure.error ?? 'Data service unavailable');
    }
    return response.json() as Promise<any>;
  }
  class Statement {
    constructor(readonly sql: string, readonly params: unknown[] = []) {}
    bind(...params: unknown[]) { return new Statement(this.sql, params); }
    async all() { return (await query([this]))[0]; }
    async run() { return this.all(); }
    async first(column?: string) { const row = (await this.all()).results[0]; return row ? (column ? row[column] : row) : null; }
  }
  function query(statements: Statement[]) { return request('/query', 'POST', JSON.stringify({ statements })); }
  return {
    DB: { prepare: (sql: string) => new Statement(sql), batch: query } as unknown as D1Database,
    CONFIG: {
      async get(key: string) { return (await request('/kv/' + encodeURIComponent(key), 'GET')).value; },
      async put(key: string, value: string) { await request('/kv/' + encodeURIComponent(key), 'PUT', value); },
    } as unknown as KVNamespace,
  };
}
