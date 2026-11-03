/**
 * 校历：学期、节次与格子。
 *
 * 一个学期建好后，`slot`（周 × 星期 × 节次）一次性物化；之后所有"有没有空"的判断
 * 都只是查这张表，不在 SQL 里展开重复规则。
 *
 * 挂载方式：与 index.ts 一致，按 `app.route("/api", terms)` 挂载，
 * 因此本文件路径都写成 `/terms`、`/terms/:id` 这样的全路径。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { Period, PeriodInput, Slot, Term, TermDetail } from "../../shared/types";
import { generateTermSlots } from "../domain/time";
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
  notFound,
  nowIso,
  oneOf,
  optInt,
  optString,
  readJson,
  ulid,
} from "../lib/core";

export const terms = new Hono<{ Bindings: Env }>();

type TermContext = Context<{ Bindings: Env }>;

type BindValue = string | number | null;

interface Statement {
  sql: string;
  params?: BindValue[];
}

const TIMEZONE = "Asia/Shanghai";
const MAX_WEEK_COUNT = 30;
const MAX_PERIODS = 32;
/** D1 batch 单批上限 100 条语句，留出余量按 90 条切。 */
const BATCH_SIZE = 90;

const TERM_STATUSES = ["planned", "active", "archived"] as const;

const TERM_COLUMNS = "id, name, start_date, week_count, timezone, status, created_at";
const PERIOD_COLUMNS = "id, term_id, period_index, label, start_time, end_time";
const SLOT_COLUMNS = "id, term_id, week_index, weekday, period_index, starts_at, ends_at";

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function auditStatement(
  actor: string,
  action: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown>,
): Statement {
  return {
    sql: "insert into audit_event (id, actor_id, action, target_type, target_id, payload, created_at) values (?, ?, ?, ?, ?, ?, ?)",
    params: [ulid(), actor, action, targetType, targetId, JSON.stringify(payload), nowIso()],
  };
}

async function writeAudit(
  db: D1Database,
  actor: string,
  action: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const statement = auditStatement(actor, action, targetType, targetId, payload);
  await dbRun(db, statement.sql, ...(statement.params ?? []));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 分批执行；单批是事务，跨批不是（D1 没有跨批事务）。 */
async function runBatches(db: D1Database, statements: Statement[]): Promise<void> {
  for (const part of chunk(statements, BATCH_SIZE)) {
    await dbBatch(db, part);
  }
}

async function readBody(c: TermContext): Promise<Record<string, unknown>> {
  const body = await readJson<unknown>(c);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

/** Hono 的 param() 类型是 `string | undefined`，这里收敛成非空字符串。 */
function pathParam(c: TermContext, name: string): string {
  return c.req.param(name) ?? "";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function requireIsoDate(value: unknown, field: string): string {
  const raw = asString(value, field, 10);
  if (!DATE_RE.test(raw)) throw badRequest(`${field} 必须是 YYYY-MM-DD`);
  const [year, month, day] = raw.split("-").map((part) => Number.parseInt(part, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw badRequest(`${field} 不是合法日期`);
  }
  return raw;
}

function requireHhmm(value: unknown, field: string): string {
  const raw = asString(value, field, 5);
  if (!TIME_RE.test(raw)) throw badRequest(`${field} 必须是 HH:mm 格式`);
  return raw;
}

/** 解析并校验节次；periodIndex 必须唯一，开始时间必须早于结束时间。 */
function parsePeriodsInput(value: unknown): PeriodInput[] {
  if (!Array.isArray(value) || value.length === 0) throw badRequest("periods 不能为空");
  const list = value as unknown[];
  if (list.length > MAX_PERIODS) throw badRequest(`periods 最多 ${MAX_PERIODS} 条`);
  const seen = new Set<number>();
  const periods = list.map((item, index) => {
    if (typeof item !== "object" || item === null) throw badRequest(`periods[${index}] 必须是对象`);
    const raw = item as Record<string, unknown>;
    const periodIndex = asInt(raw.periodIndex, `periods[${index}].periodIndex`, 1);
    if (seen.has(periodIndex)) throw badRequest(`periods 里节次序号重复：${periodIndex}`);
    seen.add(periodIndex);
    const startTime = requireHhmm(raw.startTime, `periods[${index}].startTime`);
    const endTime = requireHhmm(raw.endTime, `periods[${index}].endTime`);
    if (startTime >= endTime) throw badRequest(`periods[${index}] 开始时间必须早于结束时间`);
    const label = optString(raw.label, `periods[${index}].label`, 50);
    const period: PeriodInput = { periodIndex, startTime, endTime };
    if (label !== null) period.label = label;
    return period;
  });
  return periods.sort((a, b) => a.periodIndex - b.periodIndex);
}

async function loadTerm(db: D1Database, id: string): Promise<Term | null> {
  return dbOne<Term>(db, `select ${TERM_COLUMNS} from term where id = ?`, id);
}

async function countRows(db: D1Database, sql: string, ...params: BindValue[]): Promise<number> {
  const row = await dbOne<{ n: number }>(db, sql, ...params);
  return row?.n ?? 0;
}

async function loadTermDetail(db: D1Database, termId: string): Promise<TermDetail> {
  const term = await loadTerm(db, termId);
  if (!term) throw notFound("学期不存在");
  const periods = await dbAll<Period>(
    db,
    `select ${PERIOD_COLUMNS} from class_period where term_id = ? order by period_index`,
    termId,
  );
  // persons / memberships / tasks 没有直连学期，按全局口径统计（简化）。
  const counts = {
    persons: await countRows(db, "select count(*) as n from person"),
    courses: await countRows(db, "select count(*) as n from course where term_id = ?", termId),
    memberships: await countRows(db, "select count(*) as n from membership"),
    tasks: await countRows(db, "select count(*) as n from task"),
    slots: await countRows(db, "select count(*) as n from slot where term_id = ?", termId),
  };
  return { term, periods, counts };
}

/**
 * 建学期跨了多个 batch，失败时 D1 无法整体回滚。
 * 这里按 term_id 清掉半成品，避免留下"有空学期但没格子"的脏数据。
 */
async function cleanupFailedTerm(db: D1Database, termId: string): Promise<void> {
  try {
    await dbBatch(db, [
      { sql: "delete from slot where term_id = ?", params: [termId] },
      { sql: "delete from class_period where term_id = ?", params: [termId] },
      { sql: "delete from term where id = ?", params: [termId] },
    ]);
  } catch {
    // 清理本身失败只能放弃：原始错误更重要，直接往上抛。
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const listTerms = async (c: TermContext) => {
  const items = await dbAll<Term>(
    c.env.DB,
    `select ${TERM_COLUMNS} from term order by start_date desc, created_at desc`,
  );
  return c.json({ items });
};

const createTerm = async (c: TermContext) => {
  const db = c.env.DB;
  const body = await readBody(c);

  const name = asString(body.name, "name", 100);
  const startDate = requireIsoDate(body.startDate, "startDate");
  const weekCount = asInt(body.weekCount, "weekCount", 1);
  if (weekCount > MAX_WEEK_COUNT) throw badRequest(`weekCount 不能大于 ${MAX_WEEK_COUNT}`);
  const periods = parsePeriodsInput(body.periods);

  const duplicated = await dbOne<{ id: string }>(db, "select id from term where name = ?", name);
  if (duplicated) throw conflict("学期名称已存在");

  const termId = ulid();
  const createdAt = nowIso();

  const head: Statement[] = [
    {
      sql: "insert into term (id, name, start_date, week_count, timezone, status, created_at) values (?, ?, ?, ?, ?, ?, ?)",
      params: [termId, name, startDate, weekCount, TIMEZONE, "planned", createdAt],
    },
  ];
  for (const period of periods) {
    head.push({
      sql: "insert into class_period (id, term_id, period_index, label, start_time, end_time) values (?, ?, ?, ?, ?, ?)",
      params: [ulid(), termId, period.periodIndex, period.label ?? null, period.startTime, period.endTime],
    });
  }

  const slots = generateTermSlots({ termId, startDate, weekCount, periods, offsetMinutes: 480 });
  const slotStatements: Statement[] = slots.map((slot) => ({
    sql: "insert into slot (id, term_id, week_index, weekday, period_index, starts_at, ends_at) values (?, ?, ?, ?, ?, ?, ?)",
    params: [ulid(), slot.termId, slot.weekIndex, slot.weekday, slot.periodIndex, slot.startsAt, slot.endsAt],
  }));

  try {
    await runBatches(db, [...head, ...slotStatements]);
  } catch (error) {
    await cleanupFailedTerm(db, termId);
    throw error;
  }

  await writeAudit(db, c.get("user").id, "term.create", "term", termId, {
    name,
    startDate,
    weekCount,
    periods: periods.length,
    slots: slots.length,
  });
  return c.json(await loadTermDetail(db, termId));
};

const getTerm = async (c: TermContext) => {
  return c.json(await loadTermDetail(c.env.DB, pathParam(c, "id")));
};

const updateTerm = async (c: TermContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  const term = await loadTerm(db, id);
  if (!term) throw notFound("学期不存在");

  const body = await readBody(c);
  const sets: string[] = [];
  const params: BindValue[] = [];
  const changes: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = asString(body.name, "name", 100);
    if (name !== term.name) {
      const duplicated = await dbOne<{ id: string }>(
        db,
        "select id from term where name = ? and id != ?",
        name,
        id,
      );
      if (duplicated) throw conflict("学期名称已存在");
    }
    sets.push("name = ?");
    params.push(name);
    changes.name = name;
  }

  if (body.status !== undefined) {
    const status = oneOf(body.status, TERM_STATUSES, "status");
    sets.push("status = ?");
    params.push(status);
    changes.status = status;
  }

  if (sets.length === 0) throw badRequest("没有需要修改的字段");
  sets.push("updated_at = ?");
  params.push(nowIso());

  await dbBatch(db, [
    { sql: `update term set ${sets.join(", ")} where id = ?`, params: [...params, id] },
    auditStatement(c.get("user").id, "term.update", "term", id, changes),
  ]);
  return c.json(await loadTermDetail(db, id));
};

const deleteTerm = async (c: TermContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  const term = await loadTerm(db, id);
  if (!term) throw notFound("学期不存在");

  // 任务窗口与学期重叠的检查先简化为：只拦课程。
  const courseCount = await countRows(db, "select count(*) as n from course where term_id = ?", id);
  if (courseCount > 0) throw conflict("该学期还有课程，无法删除");

  await dbBatch(db, [
    // 兜底：正常情况下课程已拦住，不该有残留 rules/occurrence。
    {
      sql: "delete from course_occurrence where meeting_id in (select id from course_meeting where term_id = ?)",
      params: [id],
    },
    { sql: "delete from course_meeting where term_id = ?", params: [id] },
    { sql: "delete from slot where term_id = ?", params: [id] },
    { sql: "delete from class_period where term_id = ?", params: [id] },
    { sql: "delete from term where id = ?", params: [id] },
    auditStatement(c.get("user").id, "term.delete", "term", id, { name: term.name }),
  ]);
  return c.json({ ok: true });
};

const listPeriods = async (c: TermContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  if (!(await loadTerm(db, id))) throw notFound("学期不存在");
  const items = await dbAll<Period>(
    db,
    `select ${PERIOD_COLUMNS} from class_period where term_id = ? order by period_index`,
    id,
  );
  return c.json({ items });
};

const listSlots = async (c: TermContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  const term = await loadTerm(db, id);
  if (!term) throw notFound("学期不存在");

  const week = optInt(c.req.query("week"), "week");
  const weekday = optInt(c.req.query("weekday"), "weekday");
  if (week !== null && (week < 1 || week > term.weekCount)) {
    throw badRequest(`week 必须在 1..${term.weekCount}`);
  }
  if (weekday !== null && (weekday < 1 || weekday > 7)) throw badRequest("weekday 必须在 1..7");

  const conditions = ["term_id = ?"];
  const params: BindValue[] = [id];
  if (week !== null) {
    conditions.push("week_index = ?");
    params.push(week);
  }
  if (weekday !== null) {
    conditions.push("weekday = ?");
    params.push(weekday);
  }

  const items = await dbAll<Slot>(
    db,
    `select ${SLOT_COLUMNS} from slot where ${conditions.join(" and ")} order by week_index, weekday, period_index`,
    ...params,
  );
  return c.json({ items });
};

// 注意：主入口把所有子路由都挂在 `/api` 下，这里必须写全 `/terms` 前缀。
// 不能注册根路径 `/:id`——那会抢走 `/api/persons` 这类其它路由。
terms.get("/terms", listTerms);
terms.post("/terms", createTerm);
terms.get("/terms/:id", getTerm);
terms.patch("/terms/:id", updateTerm);
terms.delete("/terms/:id", deleteTerm);
terms.get("/terms/:id/periods", listPeriods);
terms.get("/terms/:id/slots", listSlots);

export default terms;
