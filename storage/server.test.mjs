import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openDatabase, createDataServer } from './server.mjs';

test('authenticated persistent SQLite, atomic batches, KV and files', async () => {
  const dir = await mkdtemp(tmpdir() + '/rota-data-test-');
  let db = openDatabase(dir + '/db.sqlite');
  const authorization = 'Bearer local-integration-test-only';
  const server = createDataServer({ db, authorization, files: dir, basePath: '/data' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/data`;
  const call = (path, method = 'GET', body) => fetch(url + path, { method, body, headers: { authorization } });
  const query = statements => call('/query', 'POST', JSON.stringify({ statements }));
  try {
    assert.equal((await fetch(url + '/health')).status, 401);
    assert.equal((await call('/health')).status, 200);
    await call('/kv/settings', 'PUT', '{"cooldownDays":4}');
    assert.equal((await (await call('/kv/settings')).json()).value, '{"cooldownDays":4}');
    let r = await query([{ sql: "INSERT INTO app_kv VALUES (?,?)", params: ['atomic', 'first'] }, { sql: "INSERT INTO app_kv VALUES (?,?)", params: ['atomic', 'duplicate'] }]);
    assert.equal(r.status, 409);
    assert.equal((await (await call('/kv/atomic')).json()).value, null);
    r = await query([{ sql: "DELETE FROM app_kv WHERE key=? RETURNING value", params: ['settings'] }]);
    assert.equal((await r.json())[0].results[0].value, '{"cooldownDays":4}');
    // Parent/child edits are atomic; references must be valid when the transaction commits.
    r = await query([
      { sql: "INSERT INTO organization(id,name,parent_id,kind,status,created_at) VALUES('child','child','parent','team','active','2026-01-01')", params: [] },
      { sql: "INSERT INTO organization(id,name,kind,status,created_at) VALUES('parent','parent','team','active','2026-01-01')", params: [] },
    ]);
    assert.equal(r.status, 200);
    r = await query([{ sql: "DELETE FROM organization WHERE id='parent'", params: [] }]);
    assert.equal(r.status, 409);
    assert.equal(db.prepare("SELECT count(*) AS n FROM organization WHERE id='parent'").get().n, 1);
    await call('/kv/persist', 'PUT', 'yes');
    assert.equal((await call('/imports/job/schedule.csv', 'PUT', 'a,b')).status, 201);
    assert.equal(await (await call('/imports/job/schedule.csv')).text(), 'a,b');
    assert.equal((await call('/imports/job/%2fetc', 'PUT', 'bad')).status, 400);
    assert.equal((await call('/imports/job/huge', 'PUT', Buffer.alloc(5 * 1024 * 1024 + 1))).status, 413);
    await call('/imports/job/schedule.csv', 'DELETE');
    assert.equal((await call('/imports/job/schedule.csv')).status, 404);
    db.close(); db = openDatabase(dir + '/db.sqlite');
    assert.equal(db.prepare('SELECT value FROM app_kv WHERE key=?').get('persist').value, 'yes');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    await new Promise(resolve => server.close(resolve)); db.close(); await rm(dir, { recursive: true });
  }
});
