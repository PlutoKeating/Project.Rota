import { Hono } from "hono";
import type { ShiftView, Task, TaskKind, TaskStatus } from "../../shared/types";
import { addDays, expandWeeks, localDateTime, periodSpan } from "../domain/time";
import type { Env } from "../env";
import {
  asInt,
  asString,
  badRequest,
  conflict,
  dbAll,
  dbBatch,
  dbOne,
  dbRun,
  nowIso,
  oneOf,
  optString,
  readJson,
  ulid,
} from "../lib/core";

const tasks = new Hono<{ Bindings: Env }>();

const TASK_KINDS: readonly TaskKind[] = ["oneoff", "recurring", "project"];
const TASK_STATUSES: readonly TaskStatus[] = ["draft", "open", "scheduled", "done", "cancelled"];
const PATTERN_KINDS = ["all", "odd", "even", "ranges"] as const;

tasks.get("/tasks", async (c) => {
  const orgId = optString(c.req.query("orgId"), "orgId");
  const rows = await dbAll<Task>(
    c.env.DB,
    `select * from task
      where (? is null or org_id = ?)
      order by created_at desc
      limit 200`,
    orgId,
    orgId,
  );
  return c.json({ items: rows });
});

tasks.post("/tasks", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const title = asString(body.title, "title", 120);
  const kind = oneOf(body.kind ?? "oneoff", TASK_KINDS, "kind");
  const orgId = optString(body.orgId, "orgId");
  const description = optString(body.description, "description", 2000);
  const windowStart = optString(body.windowStart, "windowStart", 40);
  const windowEnd = optString(body.windowEnd, "windowEnd", 40);

  const id = ulid();
  await dbRun(
    c.env.DB,
    `insert into task (id, org_id, title, description, kind, status, window_start, window_end, created_at, updated_at)
     values (?, ?, ?, ?, ?, 'open', ?, ?, ?, null)`,
    id, orgId, title, description, kind, windowStart, windowEnd, nowIso(),
  );
  await dbRun(
    c.env.DB,
    `insert into audit_event (id, actor_id, action, target_type, target_id, payload, created_at)
     values (?, ?, 'task.create', 'task', ?, ?, ?)`,
    ulid(), c.get("user").id, id, JSON.stringify({ title, kind }), nowIso(),
  );

  const created = await dbOne<Task>(c.env.DB, "select * from task where id = ?", id);
  return c.json(created);
});

tasks.patch("/tasks/:id", async (c) => {
  const id = asString(c.req.param("id"), "id");
  const body = await readJson<Record<string, unknown>>(c);
  const existing = await dbOne<Task>(c.env.DB, "select * from task where id = ?", id);
  if (!existing) throw conflict("任务不存在");

  const title = body.title === undefined ? existing.title : asString(body.title, "title", 120);
  const status = body.status === undefined ? existing.status : oneOf(body.status, TASK_STATUSES, "status");
  const description = body.description === undefined ? existing.description : optString(body.description, "description", 2000);

  await dbRun(
    c.env.DB,
    "update task set title = ?, status = ?, description = ?, updated_at = ? where id = ?",
    title, status, description, nowIso(), id,
  );
  return c.json(await dbOne<Task>(c.env.DB, "select * from task where id = ?", id));
});

tasks.delete("/tasks/:id", async (c) => {
  const id = asString(c.req.param("id"), "id");
  const shifts = await dbOne<{ c: number }>(c.env.DB, "select count(*) as c from shift where task_id = ?", id);
  if ((shifts?.c ?? 0) > 0) throw conflict("任务下还有班次，先删班次");
  await dbRun(c.env.DB, "delete from task where id = ?", id);
  return c.json({ ok: true });
});

tasks.get("/tasks/:id/shifts", async (c) => {
  const id = asString(c.req.param("id"), "id");
  const rows = await dbAll<ShiftView>(
    c.env.DB,
    `select s.*, t.title as task_title, t.org_id
       from shift s join task t on t.id = s.task_id
      where s.task_id = ?
      order by s.starts_at`,
    id,
  );
  if (rows.length === 0) return c.json({ items: [] });

  const assignments = await dbAll<{
    id: string;
    shiftId: string;
    personId: string;
    status: string;
    score: number | null;
    reason: string | null;
    assignedAt: string | null;
    assignedBy: string | null;
    personName: string;
  }>(
    c.env.DB,
    `select a.id, a.shift_id, a.person_id, a.status, a.score, a.reason,
            a.assigned_at, a.assigned_by, p.full_name as person_name
       from assignment a join person p on p.id = a.person_id
      where a.shift_id in (${rows.map(() => "?").join(",")})
      order by a.assigned_at`,
    ...rows.map((row) => row.id),
  );

  const byShift = new Map<string, typeof assignments>();
  for (const item of assignments) {
    const list = byShift.get(item.shiftId) ?? [];
    list.push(item);
    byShift.set(item.shiftId, list);
  }

  return c.json({ items: rows.map((row) => ({ ...row, assignments: byShift.get(row.id) ?? [] })) });
});

tasks.post("/tasks/:id/shifts", async (c) => {
  const taskId = asString(c.req.param("id"), "id");
  const body = await readJson<Record<string, unknown>>(c);
  const startsAt = asString(body.startsAt, "startsAt", 40);
  const endsAt = asString(body.endsAt, "endsAt", 40);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) throw badRequest("结束时间必须晚于开始时间");
  const headcount = body.requiredHeadcount === undefined ? 1 : asInt(body.requiredHeadcount, "requiredHeadcount", 1);

  const id = ulid();
  await dbRun(
    c.env.DB,
    `insert into shift
       (id, task_id, starts_at, ends_at, required_headcount, required_role_id, required_skill_id, location, status, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    id,
    taskId,
    startsAt,
    endsAt,
    headcount,
    optString(body.requiredRoleId, "requiredRoleId"),
    optString(body.requiredSkillId, "requiredSkillId"),
    optString(body.location, "location", 200),
    nowIso(),
  );

  return c.json(await dbOne(c.env.DB, "select * from shift where id = ?", id));
});

tasks.post("/tasks/:id/shifts/generate", async (c) => {
  const taskId = asString(c.req.param("id"), "id");
  const body = await readJson<Record<string, unknown>>(c);
  const task = await dbOne<Task>(c.env.DB, "select * from task where id = ?", taskId);
  if (!task) throw conflict("任务不存在");

  const weekday = asInt(body.weekday, "weekday", 1);
  if (weekday > 7) throw badRequest("weekday 必须在 1..7");
  const periodFrom = asInt(body.periodFrom, "periodFrom", 1);
  const periodTo = asInt(body.periodTo, "periodTo", 1);
  const patternKind = oneOf(body.patternKind ?? "all", PATTERN_KINDS, "patternKind");
  const weekRanges = optString(body.weekRanges, "weekRanges", 200);
  if (patternKind === "ranges" && !weekRanges) throw badRequest("ranges 模式必须提供 weekRanges");
  const headcount = body.requiredHeadcount === undefined ? 1 : asInt(body.requiredHeadcount, "requiredHeadcount", 1);
  const location = optString(body.location, "location", 200);

  const date = (task.windowStart ?? nowIso()).slice(0, 10);
  const term = await dbOne<{ id: string; name: string; startDate: string; weekCount: number }>(
    c.env.DB,
    `select * from term
      where start_date <= ? and ? < date(start_date, '+' || (week_count * 7) || ' days')
      order by start_date desc limit 1`,
    date,
    date,
  );
  if (!term) throw badRequest("任务时间不在任何学期内，无法按周生成");

  const periods = await dbAll<{ periodIndex: number; startTime: string; endTime: string }>(
    c.env.DB,
    "select * from class_period where term_id = ? order by period_index",
    term.id,
  );
  const from = periods.find((p) => p.periodIndex === periodFrom);
  const to = periods.find((p) => p.periodIndex === periodTo);
  if (!from || !to) throw badRequest("节次不在该学期的作息表里");

  for (const index of periodSpan(periodFrom, periodTo)) {
    if (!periods.some((p) => p.periodIndex === index)) throw badRequest(`缺少第 ${index} 节`);
  }

  const weeks = expandWeeks(patternKind, weekRanges ?? undefined, term.weekCount);
  const existing = await dbAll<{ startsAt: string }>(
    c.env.DB,
    "select starts_at from shift where task_id = ?",
    taskId,
  );
  const existingSet = new Set(existing.map((row) => row.startsAt));

  const statements: { sql: string; params: (string | number | null)[] }[] = [];
  let created = 0;
  for (const week of weeks) {
    const dayIso = addDays(term.startDate, (week - 1) * 7 + (weekday - 1));
    const startsAt = localDateTime(dayIso, from.startTime);
    if (existingSet.has(startsAt)) continue;
    existingSet.add(startsAt);
    statements.push({
      sql: `insert into shift
              (id, task_id, starts_at, ends_at, required_headcount, required_role_id, required_skill_id, location, status, created_at)
            values (?, ?, ?, ?, ?, NULL, NULL, ?, 'open', ?)`,
      params: [
        ulid(),
        taskId,
        startsAt,
        localDateTime(dayIso, to.endTime),
        headcount,
        location,
        nowIso(),
      ],
    });
    created += 1;
  }

  for (let i = 0; i < statements.length; i += 80) {
    await dbBatch(c.env.DB, statements.slice(i, i + 80));
  }

  return c.json({ created, skipped: weeks.length - created });
});

tasks.delete("/shifts/:id", async (c) => {
  const id = asString(c.req.param("id"), "id");
  const used = await dbOne<{ c: number }>(c.env.DB, "select count(*) as c from assignment where shift_id = ?", id);
  if ((used?.c ?? 0) > 0) throw conflict("该班次已排人，先撤销分配");
  await dbRun(c.env.DB, "delete from shift where id = ?", id);
  return c.json({ ok: true });
});

export { tasks };
