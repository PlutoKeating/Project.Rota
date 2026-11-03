import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function openDatabase(path, migrations = new URL('../migrations/', import.meta.url)) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS service_migrations (name TEXT PRIMARY KEY);');
  for (const name of readdirSync(migrations).filter(n => n.endsWith('.sql')).sort()) {
    if (db.prepare('SELECT 1 FROM service_migrations WHERE name=?').get(name)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(readFileSync(new URL(name, migrations), 'utf8'));
      db.prepare('INSERT INTO service_migrations VALUES (?)').run(name);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  db.exec('CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  return db;
}

export function createDataServer({ db, authorization, files, basePath = '' }) {
  if (!authorization || authorization.length < 24) throw new Error('A strong authorization value is required');
  const expected = Buffer.from(authorization);
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const body = async (req, limit) => {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('too_large'), { status: 413 }); chunks.push(chunk); }
    return Buffer.concat(chunks);
  };
  return createServer(async (req, res) => {
    try {
      const supplied = Buffer.from(req.headers.authorization ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(res, 401, { error: 'unauthorized' });
      const pathname = (req.url ?? '').split('?')[0];
      if (!pathname.startsWith(basePath + '/')) return json(res, 404, { error: 'not_found' });
      const path = pathname.slice(basePath.length);
      if (path === '/health' && req.method === 'GET') { db.prepare('SELECT 1').get(); return json(res, 200, { ok: true }); }
      if (path === '/query' && req.method === 'POST') {
        const { statements } = JSON.parse((await body(req, 16 * 1024 * 1024)).toString());
        if (!Array.isArray(statements) || !statements.length || statements.length > 20000 || statements.some(s => typeof s.sql !== 'string' || !Array.isArray(s.params))) return json(res, 400, { error: 'invalid_query' });
        db.exec('BEGIN IMMEDIATE');
        try {
          const results = statements.map(({ sql, params }) => {
            // Only the trusted Worker may submit business statements, never connection/transaction control.
            if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) throw new Error('invalid_sql');
            const stmt = db.prepare(sql);
            if (stmt.columns().length) return { success: true, results: stmt.all(...params), meta: {} };
            const result = stmt.run(...params);
            return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
          });
          db.exec('COMMIT'); return json(res, 200, results);
        } catch (e) {
          db.exec('ROLLBACK');
          // Only return constraint markers needed by the API; never expose SQL or bound values.
          const marker = String(e.message).match(/(shift_closed|shift_full|person_overlap|last_owner|UNIQUE constraint failed|FOREIGN KEY constraint failed)/)?.[0];
          return json(res, 409, { error: marker ?? 'database_operation_failed' });
        }
      }
      if (path.startsWith('/kv/')) {
        const key = decodeURIComponent(path.slice(4));
        if (!key || key.length > 512) return json(res, 400, { error: 'invalid_key' });
        if (req.method === 'GET') return json(res, 200, { value: db.prepare('SELECT value FROM app_kv WHERE key=?').get(key)?.value ?? null });
        if (req.method === 'PUT') { const value = (await body(req, 1024 * 1024)).toString(); db.prepare('INSERT INTO app_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); return json(res, 200, { ok: true }); }
      }
      if (path.startsWith('/imports/') && ['PUT', 'DELETE', 'GET'].includes(req.method)) {
        const parts = path.slice(1).split('/').map(decodeURIComponent);
        if (parts.length !== 3 || parts.some(p => !p || p === '.' || p === '..' || /[\\/\x00-\x1f]/.test(p))) return json(res, 400, { error: 'invalid_path' });
        const target = resolve(files, ...parts);
        if (req.method === 'PUT') {
          const data = await body(req, 5 * 1024 * 1024);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          const tmp = target + '.' + randomUUID() + '.tmp';
          try { await writeFile(tmp, data, { mode: 0o600, flag: 'wx' }); await rename(tmp, target); }
          finally { await unlink(tmp).catch(() => {}); }
          return json(res, 201, { ok: true });
        }
        if (req.method === 'DELETE') { await unlink(target).catch(e => { if (e.code !== 'ENOENT') throw e; }); return json(res, 200, { ok: true }); }
        const data = await readFile(target); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(data);
      }
      json(res, 404, { error: 'not_found' });
    } catch (e) { json(res, e.code === 'ENOENT' ? 404 : (e.status ?? 400), { error: e.status === 413 ? 'too_large' : 'request_failed' }); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const data = process.env.DATA_DIR ?? './.data';
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const db = openDatabase(resolve(data, 'rota.sqlite'));
  const server = createDataServer({ db, authorization: process.env.DATA_AUTHORIZATION, files: resolve(data, 'rota'), basePath: process.env.BASE_PATH ?? '' });
  server.requestTimeout = 30_000;
  server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '0.0.0.0');
  process.on('SIGTERM', () => server.close(() => { db.close(); process.exit(0); }));
}
