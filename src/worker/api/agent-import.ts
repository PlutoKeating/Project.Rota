import { reviewArtifactSchema } from "../../shared/agent-import/review-artifact";
import { Hono } from "hono";
import type { Env } from "../env";
import { HttpError } from "../lib/core";
import {
  applyChanges,
  canonical,
  changeSchema,
  entities,
  materialize,
  relations,
  tables,
  validateTransition,
  type Change,
  type Row,
  type Snapshot,
  type Table,
} from "../../shared/agent-import/model";
import { agentTurn, AgentTurnError } from "../llm/agent";
import { z } from "zod";
const app = new Hono<{ Bindings: Env }>();
const fail = (message: string, status = 400): never => {
  throw new HttpError(
    status,
    status === 409 ? "conflict" : "bad_request",
    message,
  );
};
async function snapshot(db: D1Database) {
  const result = await db.batch([
    db.prepare("SELECT version FROM agent_revision WHERE id=1"),
    ...tables.map((t) => db.prepare(`SELECT * FROM "${t}" ORDER BY id`)),
  ]);
  return {
    version: Number((result[0].results[0] as { version: number }).version),
    data: Object.fromEntries(
      tables.map((t, i) => [t, result[i + 1].results]),
    ) as Snapshot,
  };
}
const statement = (
  db: D1Database,
  sql: string,
  params: (string | number | null)[] = [],
) => db.prepare(sql).bind(...params);
async function batchOwner(db: D1Database, id: string, actor: string) {
  const row = await db
    .prepare("SELECT * FROM agent_batch WHERE id=? AND actor_id=?")
    .bind(id, actor)
    .first<{ status: string; digest: string | null }>();
  if (!row) fail("导入批次不存在", 404);
  return row!;
}
const requestSchema = z.object({
  changes: z.array(changeSchema).max(10000),
  summary: z.string().max(4000).default(""),
  review: reviewArtifactSchema.optional(),
});
async function readRequest(c: { req: { json: () => Promise<unknown> } }) {
  return requestSchema.parse(await c.req.json());
}
export function resources(changes: Change[], data: Snapshot): string[] {
  const set = new Set<string>();
  for (const c of changes) {
    set.add(c.entity + ":" + c.id);
    for (const row of [c.before, c.after])
      if (row)
        for (const [key, target] of Object.entries(relations[c.entity] ?? {}))
          if (row[key]) set.add(target + ":" + row[key]);
  }
  // Lock descendants as well: shared course/term changes affect existing dependants.
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of entities)
      for (const row of data[t])
        if (
          Object.entries(relations[t] ?? {}).some(
            ([key, target]) => row[key] && set.has(target + ":" + row[key]),
          ) &&
          !set.has(t + ":" + row.id)
        ) {
          set.add(t + ":" + row.id);
          grew = true;
        }
  }
  return [...set];
}
function assert(
  db: D1Database,
  id: string,
  condition: string,
  params: (string | number | null)[],
) {
  return statement(
    db,
    `INSERT INTO agent_assertion(id,ok) SELECT ?,CASE WHEN ${condition} THEN 1 ELSE 0 END`,
    [id, ...params],
  );
}
/** SQL twin of the timetable_event expansion in materialize(); kept equal by test. */
export const GENERATE_EVENTS = `INSERT INTO "timetable_event" ("id","entry_id","person_id","term_id","week_index","weekday","period_index","starts_at","ends_at")
SELECT 'event:' || e.id || ':' || w.value || ':' || json_extract(p.value,'$.index'), e.id, e.person_id, e.term_id, w.value, e.weekday, json_extract(p.value,'$.index'),
  date(t.start_date, printf('%+d days', (w.value - 1) * 7 + e.weekday - 1)) || 'T' || json_extract(p.value,'$.start') || ':00+08:00',
  date(t.start_date, printf('%+d days', (w.value - 1) * 7 + e.weekday - 1)) || 'T' || json_extract(p.value,'$.end') || ':00+08:00'
FROM json_each(?) ids
JOIN "timetable_entry" e ON e.id = ids.value
JOIN "term" t ON t.id = e.term_id
JOIN "timetable_profile" pr ON pr.id = e.profile_id
JOIN json_each(e.weeks) w
JOIN json_each(pr.periods) p
WHERE json_extract(p.value,'$.index') >= e.period_from AND json_extract(p.value,'$.index') <= e.period_to`;
function rowWrites(db: D1Database, before: Snapshot, after: Snapshot) {
  const deletes: D1PreparedStatement[] = [],
    writes: D1PreparedStatement[] = [];
  const order: Table[] = [
    "organization",
    "person",
    "term",
    "skill",
    "class_period",
    "role",
    "timetable_profile",
    "course",
    "unavailability",
    "preference",
    "person_skill",
    "task",
    "membership",
    "course_meeting",
    "enrollment",
    "shift_pattern",
    "shift",
    "slot",
    "timetable_entry",
    "timetable_event",
    "course_occurrence",
    "assignment",
    "fairness_stat",
  ];
  const depth = (r: Row, rows: Row[]) => {
    let n = 0,
      p = r.parent_id;
    while (p && n < 100) {
      n++;
      p = rows.find((x) => x.id === p)?.parent_id ?? null;
    }
    return n;
  };
  for (const t of order) {
    const old = new Map(before[t].map((r) => [r.id, r])),
      next = new Map(after[t].map((r) => [r.id, r]));
    const removed = before[t].filter((r) => !next.has(r.id));
    if (t === "organization")
      removed.sort((a, b) => depth(a, before[t]) - depth(b, before[t]));
    for (const r of removed)
      deletes.unshift(statement(db, `DELETE FROM "${t}" WHERE id=?`, [r.id]));
    const pending = after[t].filter(
      (r) => canonical(r) !== canonical(old.get(r.id)),
    );
    if (t === "organization")
      pending.sort((a, b) => depth(a, after[t]) - depth(b, after[t]));
    const inserted: Row[] = [];
    for (const r of pending) {
      const keys = Object.keys(r);
      if (old.has(r.id))
        writes.push(
          statement(
            db,
            `UPDATE "${t}" SET ${keys
              .filter((k) => k !== "id")
              .map((k) => `"${k}"=?`)
              .join(",")} WHERE id=?`,
            [...keys.filter((k) => k !== "id").map((k) => r[k]), r.id],
          ),
        );
      else inserted.push(r);
    }
    if (t === "timetable_event") {
      // A full batch expands to >10k events (several MB). Entries whose events are all
      // new are expanded by the database from the rows written earlier in this same
      // transaction, so only entry ids cross the network; the result matches materialize().
      const total = new Map<unknown, number>(),
        fresh = new Map<unknown, number>();
      for (const r of after.timetable_event)
        total.set(r.entry_id, (total.get(r.entry_id) ?? 0) + 1);
      for (const r of inserted)
        fresh.set(r.entry_id, (fresh.get(r.entry_id) ?? 0) + 1);
      const generated = [...fresh].filter(([id, n]) => total.get(id) === n).map(([id]) => String(id));
      const ids = new Set(generated);
      for (let i = 0; i < generated.length; i += 500)
        writes.push(statement(db, GENERATE_EVENTS, [JSON.stringify(generated.slice(i, i + 500))]));
      inserted.splice(0, inserted.length, ...inserted.filter((r) => !ids.has(String(r.entry_id))));
    }
    // Bound SQL statement count without sacrificing the single database transaction.
    for (let i = 0; i < inserted.length; i += 300) {
      const rows = inserted.slice(i, i + 300),
        keys = Object.keys(rows[0]);
      writes.push(
        statement(
          db,
          `INSERT INTO "${t}" (${keys.map((k) => `"${k}"`).join(",")}) SELECT ${keys.map((k) => `json_extract(value,'$.${k}')`).join(",")} FROM json_each(?)`,
          [JSON.stringify(rows)],
        ),
      );
    }
  }
  return [...deletes, ...writes];
}
app.get("/snapshot", async (c) => c.json(await snapshot(c.env.DB)));
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id,summary,applied_at FROM agent_batch WHERE actor_id=? AND status='applied' ORDER BY applied_at DESC LIMIT 20",
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ items: rows.results });
});
app.post("/", async (c) => {
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO agent_batch(id,actor_id,status,created_at) VALUES(?,?,?,?)",
  )
    .bind(id, c.get("user").id, "draft", new Date().toISOString())
    .run();
  return c.json({ id });
});
app.get("/:id", async (c) =>
  c.json(await batchOwner(c.env.DB, c.req.param("id"), c.get("user").id)),
);
app.get("/:id/report", async (c) => {
  const id = c.req.param("id");
  await batchOwner(c.env.DB, id, c.get("user").id);
  const row = await c.env.DB.prepare(
    "SELECT payload FROM audit_event WHERE action='agent_import.apply' AND target_type='agent_batch' AND target_id=? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(id)
    .first<{ payload: string }>();
  return c.json({
    review: row ? (JSON.parse(row.payload).review ?? null) : null,
  });
});
app.post("/:id/turn", async (c) => {
  const row = await batchOwner(c.env.DB, c.req.param("id"), c.get("user").id);
  if (row.status !== "draft") fail("批次已结束", 409);
  // Reject oversized turns before parsing: several multi-MB bodies parsed and
  // re-serialized at once exhaust the isolate's 128 MB and fail every request in it.
  if (Number(c.req.header("content-length") ?? 0) > 16 * 1024 * 1024)
    fail("本轮上下文过大，请缩小图片或整理上下文", 413);
  try {
    return c.json(
      await agentTurn(
        c.env,
        await c.req.json(),
        c.req.param("id"),
        c.req.raw.signal,
      ),
    );
  } catch (e) {
    if (e instanceof AgentTurnError)
      return c.json(
        { error: { code: e.code, message: e.message }, metrics: e.metrics },
        502,
      );
    throw e;
  }
});
app.post("/:id/lease", async (c) => {
  const db = c.env.DB,
    id = c.req.param("id");
  const row = await batchOwner(db, id, c.get("user").id);
  if (row.status !== "draft") fail("批次已结束", 409);
  const raw = (await c.req.json()) as { changes?: unknown };
  // Keep-alive: extend the locks already held without re-uploading the change set
  // (hundreds of KB for a full batch; slow uplinks hit Cloudflare's 408).
  if (raw?.changes === undefined) {
    const expires = Math.floor(Date.now() / 1000) + 180;
    const result = await db
      .prepare(
        "UPDATE agent_lock SET expires_at=? WHERE batch_id=? AND expires_at>unixepoch()",
      )
      .bind(expires, id)
      .run();
    if (!result.meta.changes) fail("相关数据锁已过期，需要重新取得", 409);
    return c.json({ expiresAt: expires * 1000 });
  }
  const body = requestSchema.parse(raw);
  const current = await snapshot(db);
  let final: Snapshot;
  try {
    final = applyChanges(current.data, body.changes as Change[]);
  } catch (e) {
    fail((e as Error).message, 409);
  }
  const keys = resources(body.changes as Change[], final!);
  const expires = Math.floor(Date.now() / 1000) + 180;
  const aid = crypto.randomUUID();
  try {
    await db.batch([
      assert(db, aid, "(SELECT version FROM agent_revision WHERE id=1)=?", [
        current.version,
      ]),
      statement(
        db,
        "DELETE FROM agent_lock WHERE expires_at<=unixepoch() OR batch_id=?",
        [id],
      ),
      ...keys.map((key) =>
        statement(
          db,
          "INSERT INTO agent_lock(resource,batch_id,expires_at) VALUES(?,?,?)",
          [key, id, expires],
        ),
      ),
      statement(db, "DELETE FROM agent_assertion WHERE id=?", [aid]),
    ]);
  } catch {
    fail("相关数据正在被其他导入使用或已经变化，请稍后重试", 409);
  }
  return c.json({ expiresAt: expires * 1000 });
});
app.post("/:id/apply", async (c) => {
  const db = c.env.DB,
    id = c.req.param("id"),
    actor = c.get("user").id;
  const row = await batchOwner(db, id, actor);
  const body = await readRequest(c);
  const changes = body.changes as Change[];
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          canonical(body.review ? { changes, review: body.review } : changes),
        ),
      ),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  if (row.status === "applied") {
    if (row.digest !== digest) fail("此批次已提交另一版本", 409);
    return c.json({ ok: true, id });
  }
  if (row.status !== "draft") fail("批次已取消", 409);
  if (!changes.length) fail("没有需要导入的变更");
  const current = await snapshot(db);
  let next: Snapshot;
  try {
    next = materialize(applyChanges(current.data, changes), current.data);
  } catch (e) {
    fail((e as Error).message, 409);
  }
  const problems = validateTransition(current.data, next!);
  if (problems.length)
    fail(
      problems
        .slice(0, 10)
        .map((x) => x.message)
        .join("；"),
    );
  const keys = resources(changes, next!);
  const aid = crypto.randomUUID();
  const writes = rowWrites(db, current.data, next!);
  if (writes.length > 18000) fail("本批次展开后过大，请按人员分批提交");
  try {
    await db.batch([
      assert(
        db,
        aid,
        "(SELECT version FROM agent_revision WHERE id=1)=? AND (SELECT status FROM agent_batch WHERE id=?)='draft' AND NOT EXISTS (SELECT value FROM json_each(?) k WHERE NOT EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource=k.value AND l.batch_id=? AND l.expires_at>unixepoch()))",
        [current.version, id, JSON.stringify(keys), id],
      ),
      statement(db, "INSERT INTO agent_commit_context VALUES(1,?)", [id]),
      ...writes,
      statement(
        db,
        "UPDATE agent_batch SET status='applied',digest=?,summary=?,applied_at=? WHERE id=?",
        [digest, body.summary, new Date().toISOString(), id],
      ),
      ...changes.map((x) =>
        statement(db, "INSERT INTO agent_batch_item VALUES(?,?,?,?)", [
          id,
          x.entity,
          x.id,
          x.after ? (x.before ? "update" : "create") : "delete",
        ]),
      ),
      statement(db, "DELETE FROM agent_lock WHERE batch_id=?", [id]),
      statement(db, "DELETE FROM agent_commit_context WHERE id=1"),
      statement(db, "DELETE FROM agent_assertion WHERE id=?", [aid]),
      statement(
        db,
        "INSERT INTO audit_event(id,actor_id,action,target_type,target_id,payload,created_at) VALUES(?,?,?,?,?,?,?)",
        [
          crypto.randomUUID(),
          actor,
          "agent_import.apply",
          "agent_batch",
          id,
          JSON.stringify({ count: changes.length, review: body.review }),
          new Date().toISOString(),
        ],
      ),
    ]);
  } catch (e) {
    // The database's own reason (constraint name, limit) is what makes a rollback diagnosable.
    const cause = String((e as Error)?.message ?? "").slice(0, 200);
    fail(
      "提交已回滚：数据变化、锁已过期或数据库约束冲突。请重新校验后重试" +
        (cause ? "（" + cause + "）" : ""),
      409,
    );
  }
  return c.json({ ok: true, id });
});
app.post("/:id/release", async (c) => {
  await batchOwner(c.env.DB, c.req.param("id"), c.get("user").id);
  await c.env.DB.prepare("DELETE FROM agent_lock WHERE batch_id=?")
    .bind(c.req.param("id"))
    .run();
  return c.json({ ok: true });
});
app.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  await batchOwner(c.env.DB, id, c.get("user").id);
  await c.env.DB.batch([
    statement(
      c.env.DB,
      "UPDATE agent_batch SET status='cancelled' WHERE id=? AND status='draft'",
      [id],
    ),
    statement(c.env.DB, "DELETE FROM agent_lock WHERE batch_id=?", [id]),
  ]);
  return c.json({ ok: true });
});
app.onError((e, c) =>
  c.json(
    {
      error: {
        code: e instanceof HttpError ? e.code : "bad_request",
        message: e instanceof z.ZodError ? "导入数据格式不合法" : e.message,
      },
    },
    (e instanceof HttpError ? e.status : 400) as 400,
  ),
);
export { app as agentImports };
