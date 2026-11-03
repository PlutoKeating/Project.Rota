import { expect, it } from 'vitest';
// @ts-expect-error Native Node service is intentionally JavaScript.
import { openDatabase, createDataServer } from '../../storage/server.mjs';
import { remoteData } from '../../src/worker/remote-data';
import app from '../../src/worker/index';
import type { Env } from '../../src/worker/env';

it('routes Worker business, authentication and settings queries to the HTTP SQLite service', async () => {
  const db = openDatabase(':memory:');
  const authorization = 'Bearer local-integration-test-only';
  const server = createDataServer({ db, authorization, files: '/unused' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { APP_ENV: 'development', AUTH_DEV_BYPASS: 'true', DATA_SERVICE_URL: `http://127.0.0.1:${server.address().port}`, DATA_SERVICE_AUTHORIZATION: authorization } as Env;
  try {
    const health = await app.request('/api/health', {}, env);
    expect(health.status).toBe(200);
    const data = remoteData(env);
    await data.CONFIG.put('settings', '{"cooldownDays":2}');
    expect(await data.CONFIG.get('settings')).toBe('{"cooldownDays":2}');
    const response = await app.request('/api/orgs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Remote committee', kind: 'department' }) }, env);
    expect(response.status).toBe(200);
    const list = await app.request('/api/orgs', {}, env);
    expect((await list.json() as {items: unknown[]}).items).toHaveLength(1);
    await expect(data.DB.batch([
      data.DB.prepare('INSERT INTO app_kv VALUES (?,?)').bind('rollback', 'a'),
      data.DB.prepare('INSERT INTO app_kv VALUES (?,?)').bind('rollback', 'b'),
    ])).rejects.toThrow();
    expect(await data.CONFIG.get('rollback')).toBeNull();
    const production = { ...env, APP_ENV: 'production' };
    expect(() => remoteData(production)).toThrow('HTTPS');
  } finally { await new Promise<void>(resolve => server.close(resolve)); db.close(); }
});
