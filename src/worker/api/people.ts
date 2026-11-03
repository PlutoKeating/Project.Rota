/**
 * 人员与组织：人员、请假、组织、角色、成员关系。
 *
 * 可用性计算的原则：**批量取数、内存里算**。列表接口一次取回整学期的 slot、
 * 这些人的课程占用 / 请假 / 已排班，再逐人做集合运算；绝不按人循环查库。
 * 单人的课表与可用性才走 domain/availability 的 loadAvailability。
 *
 * 挂载方式：主入口按 `app.route("/api", people)` 挂载，本文件路径都是 `/persons`
 * 这样的全路径，不带 `/api` 前缀。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type {
  MembershipStatus,
  MembershipView,
  Org,
  OrgKind,
  OrgStatus,
  Person,
  PersonStatus,
  PersonView,
  RequestStatus,
  Role,
  Slot,
  Term,
  TimetableWeek,
  Unavailability,
  UnavailabilityKind,
} from "../../shared/types";
import type { BusyInfo, BusyReason } from "../domain/availability";
import {
  freeMinutes,
  loadAvailability,
  toTimetableCells,
} from "../domain/availability";
import { weekIndexOf } from "../domain/time";
import type { Env } from "../env";
import {
  asBool,
  asString,
  badRequest,
  conflict,
  dbAll,
  dbBatch,
  dbOne,
  escapeLike,
  notFound,
  nowIso,
  oneOf,
  optInt,
  optString,
  readJson,
  toBool,
  ulid,
} from "../lib/core";

export const people = new Hono<{ Bindings: Env }>();

people.post("/persons/import", async (c) => {
  const body = await readJson<{
    items: Record<string, unknown>[];
    orgId?: string;
  }>(c);
  if (
    !Array.isArray(body.items) ||
    body.items.length < 1 ||
    body.items.length > 300
  )
    throw badRequest("每次导入 1–300 人");
  const orgId = optString(body.orgId, "orgId");
  if (
    orgId &&
    !(await dbOne(c.env.DB, "select id from organization where id = ?", orgId))
  )
    throw badRequest("部门不存在");
  const seen = new Set<string>();
  const statements: { sql: string; params: (string | number | null)[] }[] = [];
  for (const row of body.items) {
    const name = asString(row.fullName, "姓名", 100),
      number = asString(row.studentNo, "学号", 100);
    if (
      seen.has(number) ||
      (await dbOne(
        c.env.DB,
        "select id from person where student_no = ?",
        number,
      ))
    )
      throw conflict(`学号 ${number} 重复，未导入任何人员`);
    seen.add(number);
    const id = ulid(),
      at = nowIso();
    statements.push({
      sql: "insert into person (id,full_name,student_no,status,created_at) values (?,?,?,'active',?)",
      params: [id, name, number, at],
    });
    if (orgId)
      statements.push({
        sql: "insert into membership (id,person_id,org_id,status,is_primary,created_at) values (?,?,?,'active',1,?)",
        params: [ulid(), id, orgId, at],
      });
  }
  statements.push({
    sql: "insert into audit_event (id,actor_id,action,target_type,payload,created_at) values (?,?,'person.import','person',?,?)",
    params: [
      ulid(),
      c.get("user").id,
      JSON.stringify({ count: body.items.length, orgId }),
      nowIso(),
    ],
  });
  await dbBatch(c.env.DB, statements);
  return c.json({ created: body.items.length }, 201);
});

type PeopleContext = Context<{ Bindings: Env }>;
type BindValue = string | number | null;

interface Statement {
  sql: string;
  params?: BindValue[];
}

/** D1 单条 SQL 的绑定参数上限 100，IN 查询按 90 个一批。 */
const IN_CHUNK = 90;

const PERSON_STATUSES = ["active", "leave", "graduated"] as const;
const ORG_KINDS = ["school", "college", "department", "club", "team"] as const;
const ORG_STATUSES = ["active", "archived"] as const;
const MEMBERSHIP_STATUSES = ["active", "suspended", "ended"] as const;
const REQUEST_STATUSES = ["pending", "approved", "rejected"] as const;
const UNAVAILABILITY_KINDS = ["leave", "blacklist", "other"] as const;

const PERSON_COLUMNS =
  "id, student_no, full_name, email, phone, status, created_at";
const ORG_COLUMNS = "id, code, name, parent_id, kind, status";
const ROLE_COLUMNS = "id, code, name, org_id, description";
const TERM_COLUMNS =
  "id, name, start_date, week_count, timezone, status, created_at";
const SLOT_COLUMNS =
  "id, term_id, week_index, weekday, period_index, starts_at, ends_at";
const UNAVAILABILITY_COLUMNS =
  "id, person_id, starts_at, ends_at, kind, status, reason";

/** 成员关系视图：org / role 名称用 left join 带出来。 */
const MEMBERSHIP_SELECT = `
  select m.id, m.person_id, m.org_id, m.role_id, m.status, m.valid_from, m.valid_to, m.is_primary,
         coalesce(o.name, '') as org_name, r.name as role_name
    from membership m
    left join organization o on o.id = m.org_id
    left join role r on r.id = m.role_id`;

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
    params: [
      ulid(),
      actor,
      action,
      targetType,
      targetId,
      JSON.stringify(payload),
      nowIso(),
    ],
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

async function readBody(c: PeopleContext): Promise<Record<string, unknown>> {
  const body = await readJson<unknown>(c);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

/** Hono 的 param() 类型是 `string | undefined`，这里收敛成非空字符串。 */
function pathParam(c: PeopleContext, name: string): string {
  return c.req.param(name) ?? "";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireIsoDate(value: unknown, field: string): string {
  const raw = asString(value, field, 10);
  if (!DATE_RE.test(raw)) throw badRequest(`${field} 必须是 YYYY-MM-DD`);
  const [year, month, day] = raw
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== raw
  ) {
    throw badRequest(`${field} 不是合法日期`);
  }
  return raw;
}

function optIsoDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requireIsoDate(value, field);
}

function requireDateTime(value: unknown, field: string): string {
  const raw = asString(value, field, 40);
  if (!DATETIME_RE.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw badRequest(`${field} 必须是 ISO 8601 时间`);
  }
  return raw;
}

function optEmail(value: unknown, field: string): string | null {
  const raw = optString(value, field, 200);
  if (raw === null) return null;
  if (!EMAIL_RE.test(raw)) throw badRequest(`${field} 格式不正确`);
  return raw;
}

async function loadPerson(db: D1Database, id: string): Promise<Person | null> {
  return dbOne<Person>(
    db,
    `select ${PERSON_COLUMNS} from person where id = ?`,
    id,
  );
}

async function countRows(
  db: D1Database,
  sql: string,
  ...params: BindValue[]
): Promise<number> {
  const row = await dbOne<{ n: number }>(db, sql, ...params);
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// 成员关系视图
// ---------------------------------------------------------------------------

interface MembershipRow {
  id: string;
  personId: string;
  orgId: string | null;
  roleId: string | null;
  status: MembershipStatus;
  validFrom: string | null;
  validTo: string | null;
  isPrimary: number | null;
  orgName: string;
  roleName: string | null;
}

function toMembershipView(row: MembershipRow): MembershipView {
  return {
    id: row.id,
    personId: row.personId,
    orgId: row.orgId ?? "",
    roleId: row.roleId,
    status: row.status,
    validFrom: row.validFrom,
    validTo: row.validTo,
    isPrimary: toBool(row.isPrimary),
    orgName: row.orgName,
    roleName: row.roleName,
  };
}

/** 一次取回这些人的全部成员关系（含已结束，历史要能看见）。 */
async function loadMembershipViews(
  db: D1Database,
  personIds: string[],
): Promise<Map<string, MembershipView[]>> {
  const map = new Map<string, MembershipView[]>();
  for (const ids of chunk(personIds, IN_CHUNK)) {
    const rows = await dbAll<MembershipRow>(
      db,
      `${MEMBERSHIP_SELECT}
        where m.person_id in (${placeholders(ids.length)})
        order by m.created_at, m.id`,
      ...ids,
    );
    for (const row of rows) {
      const view = toMembershipView(row);
      const list = map.get(view.personId);
      if (list) list.push(view);
      else map.set(view.personId, [view]);
    }
  }
  return map;
}

async function loadMembershipView(
  db: D1Database,
  id: string,
): Promise<MembershipView> {
  const row = await dbOne<MembershipRow>(
    db,
    `${MEMBERSHIP_SELECT} where m.id = ?`,
    id,
  );
  if (!row) throw notFound("成员关系不存在");
  return toMembershipView(row);
}

// ---------------------------------------------------------------------------
// 学期与周次
// ---------------------------------------------------------------------------

async function resolveTerm(
  db: D1Database,
  termId: string | null,
): Promise<Term> {
  if (termId) {
    const term = await dbOne<Term>(
      db,
      `select ${TERM_COLUMNS} from term where id = ?`,
      termId,
    );
    if (!term) throw notFound("学期不存在");
    return term;
  }
  const active = await dbOne<Term>(
    db,
    `select ${TERM_COLUMNS} from term where status = 'active' order by start_date desc limit 1`,
  );
  if (active) return active;
  const latest = await dbOne<Term>(
    db,
    `select ${TERM_COLUMNS} from term order by start_date desc limit 1`,
  );
  if (!latest) throw notFound("还没有学期，请先创建学期");
  return latest;
}

/** 周次：显式传入时校验范围，否则取当前自然周（不在学期内则退到第 1 周）。 */
function resolveWeek(raw: string | null, term: Term): number {
  const parsed = optInt(raw, "week");
  if (parsed !== null) {
    if (parsed < 1 || parsed > term.weekCount) {
      throw badRequest(`week 必须在 1..${term.weekCount}`);
    }
    return parsed;
  }
  if (!term.startDate) throw badRequest("学期缺少开学日期");
  const current = weekIndexOf(
    new Date().toISOString().slice(0, 10),
    term.startDate,
    term.weekCount,
  );
  return current ?? 1;
}

// ---------------------------------------------------------------------------
// 空闲时长：批量算法（列表接口用，避免 N+1）
// ---------------------------------------------------------------------------

interface IntervalRow {
  startsAt: string | null;
  endsAt: string | null;
}

/**
 * 一次取回整学期的 slot、这些人的课程占用、请假与已排班，再逐人算空闲分钟。
 * 与 loadAvailability 的占用口径保持一致：课程、审批通过的请假/黑名单、已排班。
 */
async function computeFreeMinutesBatch(
  db: D1Database,
  termId: string,
  personIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (personIds.length === 0) return result;

  const slots = await dbAll<Slot>(
    db,
    `select ${SLOT_COLUMNS} from slot where term_id = ? order by week_index, weekday, period_index`,
    termId,
  );
  for (const personId of personIds) result.set(personId, 0);
  if (slots.length === 0) return result;

  const occurrenceSlots = new Map<string, Set<string>>();
  const leaves = new Map<string, IntervalRow[]>();
  const assignments = new Map<string, IntervalRow[]>();

  for (const ids of chunk(personIds, IN_CHUNK)) {
    const inClause = placeholders(ids.length);

    const occurrences = await dbAll<{ personId: string; slotId: string }>(
      db,
      `select e.person_id, o.slot_id
         from enrollment e
         join course_meeting m on m.course_id = e.course_id
         join course_occurrence o on o.meeting_id = m.id
        where e.term_id = ? and e.status = 'active' and o.status != 'cancelled'
          and e.person_id in (${inClause})`,
      termId,
      ...ids,
    );
    for (const row of occurrences) {
      const set = occurrenceSlots.get(row.personId);
      if (set) set.add(row.slotId);
      else occurrenceSlots.set(row.personId, new Set([row.slotId]));
    }

    const leaveRows = await dbAll<{
      personId: string;
      startsAt: string | null;
      endsAt: string | null;
    }>(
      db,
      `select person_id, starts_at, ends_at
         from unavailability
        where status = 'approved' and person_id in (${inClause})`,
      ...ids,
    );
    for (const row of leaveRows) {
      const list = leaves.get(row.personId);
      const interval = { startsAt: row.startsAt, endsAt: row.endsAt };
      if (list) list.push(interval);
      else leaves.set(row.personId, [interval]);
    }

    const assignedRows = await dbAll<{
      personId: string;
      startsAt: string | null;
      endsAt: string | null;
    }>(
      db,
      `select a.person_id, s.starts_at, s.ends_at
         from assignment a
         join shift s on s.id = a.shift_id
        where a.status in ('proposed', 'confirmed', 'completed')
          and a.person_id in (${inClause})`,
      ...ids,
    );
    for (const row of assignedRows) {
      const list = assignments.get(row.personId);
      const interval = { startsAt: row.startsAt, endsAt: row.endsAt };
      if (list) list.push(interval);
      else assignments.set(row.personId, [interval]);
    }
  }

  for (const personId of personIds) {
    const busy = new Map<string, BusyInfo>();
    for (const slotId of occurrenceSlots.get(personId) ?? []) {
      busy.set(slotId, { reason: "course" });
    }
    const personLeaves = leaves.get(personId) ?? [];
    const personAssignments = assignments.get(personId) ?? [];
    if (personLeaves.length > 0 || personAssignments.length > 0) {
      for (const slot of slots) {
        if (busy.has(slot.id)) continue;
        const start = Date.parse(slot.startsAt);
        const end = Date.parse(slot.endsAt);
        if (overlaps(personLeaves, start, end)) {
          busy.set(slot.id, { reason: "leave" });
          continue;
        }
        if (overlaps(personAssignments, start, end)) {
          busy.set(slot.id, { reason: "cross_org" });
        }
      }
    }
    result.set(personId, freeMinutes(slots, busy));
  }
  return result;
}

function overlaps(
  intervals: IntervalRow[],
  start: number,
  end: number,
): boolean {
  for (const interval of intervals) {
    if (interval.startsAt === null || interval.endsAt === null) continue;
    if (
      Date.parse(interval.startsAt) < end &&
      Date.parse(interval.endsAt) > start
    )
      return true;
  }
  return false;
}

function toPersonView(
  person: Person,
  memberships: MembershipView[],
  minutes: number | null,
): PersonView {
  return { ...person, memberships, freeMinutes: minutes };
}

// ---------------------------------------------------------------------------
// 人员
// ---------------------------------------------------------------------------

const listPersons = async (c: PeopleContext) => {
  const db = c.env.DB;
  const q = optString(c.req.query("q"), "q", 100);
  const orgId = optString(c.req.query("orgId"), "orgId", 64);
  const termId = optString(c.req.query("termId"), "termId", 64);

  const conditions: string[] = [];
  const params: BindValue[] = [];
  if (q) {
    const like = `%${escapeLike(q)}%`;
    conditions.push(
      "(full_name like ? escape '\\' or student_no like ? escape '\\' or email like ? escape '\\')",
    );
    params.push(like, like, like);
  }
  if (orgId) {
    conditions.push(
      "exists (select 1 from membership m where m.person_id = person.id and m.org_id = ? and m.status = 'active')",
    );
    params.push(orgId);
  }

  const where =
    conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const persons = await dbAll<Person>(
    db,
    `select ${PERSON_COLUMNS} from person ${where} order by full_name, id`,
    ...params,
  );

  const personIds = persons.map((person) => person.id);
  const membershipMap = await loadMembershipViews(db, personIds);
  const minutesMap = termId
    ? await computeFreeMinutesBatch(db, termId, personIds)
    : null;

  const items = persons.map((person) =>
    toPersonView(
      person,
      membershipMap.get(person.id) ?? [],
      minutesMap ? (minutesMap.get(person.id) ?? 0) : null,
    ),
  );
  return c.json({ items });
};

const createPerson = async (c: PeopleContext) => {
  const db = c.env.DB;
  const body = await readBody(c);

  const fullName = asString(body.fullName, "fullName", 100);
  const studentNo = optString(body.studentNo, "studentNo", 50);
  const email = optEmail(body.email, "email");
  const phone = optString(body.phone, "phone", 40);
  const status: PersonStatus =
    body.status === undefined
      ? "active"
      : oneOf(body.status, PERSON_STATUSES, "status");

  if (studentNo !== null) {
    const duplicated = await dbOne<{ id: string }>(
      db,
      "select id from person where student_no = ?",
      studentNo,
    );
    if (duplicated) throw conflict("学号已存在");
  }

  const id = ulid();
  const createdAt = nowIso();
  await dbBatch(db, [
    {
      sql: "insert into person (id, student_no, full_name, email, phone, status, created_at) values (?, ?, ?, ?, ?, ?, ?)",
      params: [id, studentNo, fullName, email, phone, status, createdAt],
    },
    auditStatement(c.get("user").id, "person.create", "person", id, {
      fullName,
      studentNo,
      email,
      status,
    }),
  ]);

  const person: Person = {
    id,
    studentNo,
    fullName,
    email,
    phone,
    status,
    createdAt,
  };
  return c.json(toPersonView(person, [], null));
};

const getPerson = async (c: PeopleContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  const person = await loadPerson(db, id);
  if (!person) throw notFound("人员不存在");

  const termId = optString(c.req.query("termId"), "termId", 64);
  const memberships = (await loadMembershipViews(db, [id])).get(id) ?? [];
  let minutes: number | null = null;
  if (termId) {
    const availability = await loadAvailability(db, id, termId);
    minutes = freeMinutes(availability.slots, availability.busy);
  }
  return c.json(toPersonView(person, memberships, minutes));
};

const updatePerson = async (c: PeopleContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  const person = await loadPerson(db, id);
  if (!person) throw notFound("人员不存在");

  const body = await readBody(c);
  const sets: string[] = [];
  const params: BindValue[] = [];
  const changes: Record<string, unknown> = {};

  if (body.fullName !== undefined) {
    const fullName = asString(body.fullName, "fullName", 100);
    sets.push("full_name = ?");
    params.push(fullName);
    changes.fullName = fullName;
  }
  if (body.studentNo !== undefined) {
    const studentNo = optString(body.studentNo, "studentNo", 50);
    if (studentNo !== null) {
      const duplicated = await dbOne<{ id: string }>(
        db,
        "select id from person where student_no = ? and id != ?",
        studentNo,
        id,
      );
      if (duplicated) throw conflict("学号已存在");
    }
    sets.push("student_no = ?");
    params.push(studentNo);
    changes.studentNo = studentNo;
  }
  if (body.email !== undefined) {
    const email = optEmail(body.email, "email");
    sets.push("email = ?");
    params.push(email);
    changes.email = email;
  }
  if (body.phone !== undefined) {
    const phone = optString(body.phone, "phone", 40);
    sets.push("phone = ?");
    params.push(phone);
    changes.phone = phone;
  }
  if (body.status !== undefined) {
    const status = oneOf(body.status, PERSON_STATUSES, "status");
    sets.push("status = ?");
    params.push(status);
    changes.status = status;
  }

  if (sets.length === 0) throw badRequest("没有需要修改的字段");
  sets.push("updated_at = ?");
  params.push(nowIso());

  await dbBatch(db, [
    {
      sql: `update person set ${sets.join(", ")} where id = ?`,
      params: [...params, id],
    },
    auditStatement(c.get("user").id, "person.update", "person", id, changes),
  ]);

  const updated = await loadPerson(db, id);
  if (!updated) throw notFound("人员不存在");
  const memberships = (await loadMembershipViews(db, [id])).get(id) ?? [];
  return c.json(toPersonView(updated, memberships, null));
};

const deletePerson = async (c: PeopleContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  const person = await loadPerson(db, id);
  if (!person) throw notFound("人员不存在");

  const assignments = await countRows(
    db,
    "select count(*) as n from assignment where person_id = ?",
    id,
  );
  if (assignments > 0) throw conflict("该人员已有排班记录，无法删除");

  // 人员是很多表的被引用方：先把从属数据一并清掉，否则外键会拦住删除。
  await dbBatch(db, [
    { sql: "delete from unavailability where person_id = ?", params: [id] },
    { sql: "delete from enrollment where person_id = ?", params: [id] },
    { sql: "delete from preference where person_id = ?", params: [id] },
    { sql: "delete from person_skill where person_id = ?", params: [id] },
    { sql: "delete from fairness_stat where person_id = ?", params: [id] },
    { sql: "delete from membership where person_id = ?", params: [id] },
    { sql: "delete from person where id = ?", params: [id] },
    auditStatement(c.get("user").id, "person.delete", "person", id, {
      fullName: person.fullName,
    }),
  ]);
  return c.json({ ok: true });
};

const getTimetable = async (c: PeopleContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  if (!(await loadPerson(db, id))) throw notFound("人员不存在");

  const term = await resolveTerm(
    db,
    optString(c.req.query("termId"), "termId", 64),
  );
  const week = resolveWeek(optString(c.req.query("week"), "week", 10), term);
  const { slots, busy } = await loadAvailability(db, id, term.id, { week });

  // coursesBySlot 只取这个人已选课程的 occurrence，字段与 TimetableCell 对齐。
  const rows = await dbAll<{
    slotId: string;
    courseId: string;
    courseName: string;
    location: string | null;
  }>(
    db,
    `select o.slot_id, c.id as course_id, c.name as course_name, m.location
       from enrollment e
       join course c on c.id = e.course_id
       join course_meeting m on m.course_id = c.id
       join course_occurrence o on o.meeting_id = m.id
      where e.person_id = ? and e.term_id = ? and e.status = 'active' and o.status != 'cancelled'`,
    id,
    term.id,
  );

  const coursesBySlot = new Map<
    string,
    { courseId: string; courseName: string; location: string | null }[]
  >();
  for (const row of rows) {
    const item = {
      courseId: row.courseId,
      courseName: row.courseName,
      location: row.location,
    };
    const list = coursesBySlot.get(row.slotId);
    if (list) list.push(item);
    else coursesBySlot.set(row.slotId, [item]);
  }

  const body: TimetableWeek = {
    termId: term.id,
    personId: id,
    weekIndex: week,
    cells: toTimetableCells(slots, busy, coursesBySlot),
  };
  return c.json(body);
};

/** 可用性格子。shared/types 里没有对应类型，这里按接口契约补一个局部定义。 */
export interface AvailabilityCell {
  slotId: string;
  weekIndex: number;
  weekday: number;
  periodIndex: number;
  startsAt: string;
  endsAt: string;
  free: boolean;
  reason: BusyReason | null;
  label: string | null;
}

export interface PersonAvailability {
  termId: string;
  personId: string;
  cells: AvailabilityCell[];
}

const getAvailability = async (c: PeopleContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  if (!(await loadPerson(db, id))) throw notFound("人员不存在");

  const term = await resolveTerm(
    db,
    optString(c.req.query("termId"), "termId", 64),
  );
  const rawWeek = optString(c.req.query("week"), "week", 10);
  // 不传 week 就返回整学期，前端切周时再过滤。
  const week = rawWeek === null ? null : resolveWeek(rawWeek, term);
  const { slots, busy } = await loadAvailability(db, id, term.id, { week });

  const body: PersonAvailability = {
    termId: term.id,
    personId: id,
    cells: slots.map((slot) => {
      const info = busy.get(slot.id);
      return {
        slotId: slot.id,
        weekIndex: slot.weekIndex,
        weekday: slot.weekday,
        periodIndex: slot.periodIndex,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        free: info === undefined,
        reason: info?.reason ?? null,
        label: info?.label ?? null,
      };
    }),
  };
  return c.json(body);
};

const listUnavailability = async (c: PeopleContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  if (!(await loadPerson(db, id))) throw notFound("人员不存在");
  const items = await dbAll<Unavailability>(
    db,
    `select ${UNAVAILABILITY_COLUMNS} from unavailability where person_id = ? order by starts_at desc, id desc`,
    id,
  );
  return c.json({ items });
};

const createUnavailability = async (c: PeopleContext) => {
  const db = c.env.DB;
  const personId = pathParam(c, "id");
  if (!(await loadPerson(db, personId))) throw notFound("人员不存在");

  const body = await readBody(c);
  const startsAt = requireDateTime(body.startsAt, "startsAt");
  const endsAt = requireDateTime(body.endsAt, "endsAt");
  if (Date.parse(startsAt) >= Date.parse(endsAt))
    throw badRequest("startsAt 必须早于 endsAt");

  const kind: UnavailabilityKind =
    body.kind === undefined
      ? "leave"
      : oneOf(body.kind, UNAVAILABILITY_KINDS, "kind");
  // 接口契约：不传 status 时直接生效。
  const status: RequestStatus =
    body.status === undefined
      ? "approved"
      : oneOf(body.status, REQUEST_STATUSES, "status");
  const reason = optString(body.reason, "reason", 500);

  const id = ulid();
  await dbBatch(db, [
    {
      sql: "insert into unavailability (id, person_id, starts_at, ends_at, kind, status, reason, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      params: [id, personId, startsAt, endsAt, kind, status, reason, nowIso()],
    },
    auditStatement(
      c.get("user").id,
      "unavailability.create",
      "unavailability",
      id,
      {
        personId,
        startsAt,
        endsAt,
        kind,
        status,
      },
    ),
  ]);

  const item: Unavailability = {
    id,
    personId,
    startsAt,
    endsAt,
    kind,
    status,
    reason,
  };
  return c.json(item);
};

const deleteUnavailability = async (c: PeopleContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  const row = await dbOne<Unavailability>(
    db,
    `select ${UNAVAILABILITY_COLUMNS} from unavailability where id = ?`,
    id,
  );
  if (!row) throw notFound("请假记录不存在");

  await dbBatch(db, [
    { sql: "delete from unavailability where id = ?", params: [id] },
    auditStatement(
      c.get("user").id,
      "unavailability.delete",
      "unavailability",
      id,
      { personId: row.personId },
    ),
  ]);
  return c.json({ ok: true });
};

// ---------------------------------------------------------------------------
// 组织
// ---------------------------------------------------------------------------

const listOrgs = async (c: PeopleContext) => {
  const items = await dbAll<Org>(
    c.env.DB,
    `select ${ORG_COLUMNS} from organization order by name, id`,
  );
  return c.json({ items });
};

const createOrg = async (c: PeopleContext) => {
  const db = c.env.DB;
  const body = await readBody(c);

  const name = asString(body.name, "name", 100);
  const code = optString(body.code, "code", 50);
  const kind: OrgKind =
    body.kind === undefined
      ? "department"
      : oneOf(body.kind, ORG_KINDS, "kind");
  const status: OrgStatus =
    body.status === undefined
      ? "active"
      : oneOf(body.status, ORG_STATUSES, "status");
  const parentId = optString(body.parentId, "parentId", 64);

  if (parentId !== null) {
    const parent = await dbOne<{ id: string }>(
      db,
      "select id from organization where id = ?",
      parentId,
    );
    if (!parent) throw badRequest("父级组织不存在");
  }
  if (code !== null) {
    const duplicated = await dbOne<{ id: string }>(
      db,
      "select id from organization where code = ?",
      code,
    );
    if (duplicated) throw conflict("组织代码已存在");
  }

  const id = ulid();
  await dbBatch(db, [
    {
      sql: "insert into organization (id, code, name, parent_id, kind, status, created_at) values (?, ?, ?, ?, ?, ?, ?)",
      params: [id, code, name, parentId, kind, status, nowIso()],
    },
    auditStatement(c.get("user").id, "org.create", "organization", id, {
      name,
      code,
      parentId,
      kind,
      status,
    }),
  ]);

  const org: Org = { id, code, name, parentId, kind, status };
  return c.json(org);
};

const updateOrg = async (c: PeopleContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  const existing = await dbOne<Org>(
    db,
    `select ${ORG_COLUMNS} from organization where id = ?`,
    id,
  );
  if (!existing) throw notFound("组织不存在");

  const body = await readBody(c);
  const sets: string[] = [];
  const params: BindValue[] = [];
  const changes: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = asString(body.name, "name", 100);
    sets.push("name = ?");
    params.push(name);
    changes.name = name;
  }
  if (body.code !== undefined) {
    const code = optString(body.code, "code", 50);
    if (code !== null) {
      const duplicated = await dbOne<{ id: string }>(
        db,
        "select id from organization where code = ? and id != ?",
        code,
        id,
      );
      if (duplicated) throw conflict("组织代码已存在");
    }
    sets.push("code = ?");
    params.push(code);
    changes.code = code;
  }
  if (body.parentId !== undefined) {
    const parentId = optString(body.parentId, "parentId", 64);
    if (parentId === id) throw badRequest("组织不能以自己为父级");
    if (parentId !== null) {
      const parent = await dbOne<{ id: string }>(
        db,
        "select id from organization where id = ?",
        parentId,
      );
      if (!parent) throw badRequest("父级组织不存在");
    }
    // 只挡自环；多级环需要递归 CTE，v1 先不处理。
    sets.push("parent_id = ?");
    params.push(parentId);
    changes.parentId = parentId;
  }
  if (body.kind !== undefined) {
    const kind = oneOf(body.kind, ORG_KINDS, "kind");
    sets.push("kind = ?");
    params.push(kind);
    changes.kind = kind;
  }
  if (body.status !== undefined) {
    const status = oneOf(body.status, ORG_STATUSES, "status");
    sets.push("status = ?");
    params.push(status);
    changes.status = status;
  }

  if (sets.length === 0) throw badRequest("没有需要修改的字段");
  sets.push("updated_at = ?");
  params.push(nowIso());

  await dbBatch(db, [
    {
      sql: `update organization set ${sets.join(", ")} where id = ?`,
      params: [...params, id],
    },
    auditStatement(c.get("user").id, "org.update", "organization", id, changes),
  ]);

  const updated = await dbOne<Org>(
    db,
    `select ${ORG_COLUMNS} from organization where id = ?`,
    id,
  );
  if (!updated) throw notFound("组织不存在");
  return c.json(updated);
};

const deleteOrg = async (c: PeopleContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  const org = await dbOne<Org>(
    db,
    `select ${ORG_COLUMNS} from organization where id = ?`,
    id,
  );
  if (!org) throw notFound("组织不存在");

  const activeMembers = await countRows(
    db,
    "select count(*) as n from membership where org_id = ? and status = 'active'",
    id,
  );
  if (activeMembers > 0) throw conflict("该组织还有在职成员，无法删除");

  // 组织被 role / task / fairness / 子组织引用，删除前逐项解绑；
  // 非在职的成员关系随组织一起删除（历史保留需要软删，v1 先硬删）。
  await dbBatch(db, [
    {
      sql: "update organization set parent_id = null where parent_id = ?",
      params: [id],
    },
    { sql: "update task set org_id = null where org_id = ?", params: [id] },
    {
      sql: "update fairness_stat set org_id = null where org_id = ?",
      params: [id],
    },
    {
      sql: "update membership set role_id = null where org_id = ?",
      params: [id],
    },
    {
      sql: "update shift set required_role_id = null where required_role_id in (select id from role where org_id = ?)",
      params: [id],
    },
    {
      sql: "update shift_pattern set required_role_id = null where required_role_id in (select id from role where org_id = ?)",
      params: [id],
    },
    { sql: "delete from role where org_id = ?", params: [id] },
    { sql: "delete from membership where org_id = ?", params: [id] },
    { sql: "delete from organization where id = ?", params: [id] },
    auditStatement(c.get("user").id, "org.delete", "organization", id, {
      name: org.name,
    }),
  ]);
  return c.json({ ok: true });
};

// ---------------------------------------------------------------------------
// 角色
// ---------------------------------------------------------------------------

const listRoles = async (c: PeopleContext) => {
  const db = c.env.DB;
  const orgId = optString(c.req.query("orgId"), "orgId", 64);
  const items = orgId
    ? await dbAll<Role>(
        db,
        `select ${ROLE_COLUMNS} from role where org_id = ? order by name, id`,
        orgId,
      )
    : await dbAll<Role>(
        db,
        `select ${ROLE_COLUMNS} from role order by name, id`,
      );
  return c.json({ items });
};

const createRole = async (c: PeopleContext) => {
  const db = c.env.DB;
  const body = await readBody(c);

  const name = asString(body.name, "name", 100);
  const code = optString(body.code, "code", 50);
  const orgId = optString(body.orgId, "orgId", 64);
  const description = optString(body.description, "description", 500);

  if (orgId !== null) {
    const org = await dbOne<{ id: string }>(
      db,
      "select id from organization where id = ?",
      orgId,
    );
    if (!org) throw notFound("组织不存在");
  }

  const id = ulid();
  await dbBatch(db, [
    {
      sql: "insert into role (id, code, name, org_id, description) values (?, ?, ?, ?, ?)",
      params: [id, code, name, orgId, description],
    },
    auditStatement(c.get("user").id, "role.create", "role", id, {
      name,
      code,
      orgId,
    }),
  ]);

  const role: Role = { id, code, name, orgId, description };
  return c.json(role);
};

// ---------------------------------------------------------------------------
// 成员关系
// ---------------------------------------------------------------------------

const listMemberships = async (c: PeopleContext) => {
  const db = c.env.DB;
  const orgId = optString(c.req.query("orgId"), "orgId", 64);
  const personId = optString(c.req.query("personId"), "personId", 64);

  const conditions: string[] = [];
  const params: BindValue[] = [];
  if (orgId) {
    conditions.push("m.org_id = ?");
    params.push(orgId);
  }
  if (personId) {
    conditions.push("m.person_id = ?");
    params.push(personId);
  }
  const where =
    conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const rows = await dbAll<MembershipRow>(
    db,
    `${MEMBERSHIP_SELECT} ${where} order by coalesce(o.name, ''), m.created_at, m.id`,
    ...params,
  );
  const items = rows.map(toMembershipView);
  return c.json({ items });
};

const createMembership = async (c: PeopleContext) => {
  const db = c.env.DB;
  const body = await readBody(c);

  const personId = asString(body.personId, "personId", 64);
  const orgId = asString(body.orgId, "orgId", 64);
  const roleId = optString(body.roleId, "roleId", 64);
  const status: MembershipStatus =
    body.status === undefined
      ? "active"
      : oneOf(body.status, MEMBERSHIP_STATUSES, "status");
  const validFrom = optIsoDate(body.validFrom, "validFrom");
  const validTo = optIsoDate(body.validTo, "validTo");
  const isPrimary = asBool(body.isPrimary, false);

  if (validFrom !== null && validTo !== null && validFrom > validTo) {
    throw badRequest("validFrom 不能晚于 validTo");
  }
  if (!(await loadPerson(db, personId))) throw notFound("人员不存在");
  const org = await dbOne<{ id: string }>(
    db,
    "select id from organization where id = ?",
    orgId,
  );
  if (!org) throw notFound("组织不存在");
  if (roleId !== null) {
    const role = await dbOne<{ id: string }>(
      db,
      "select id from role where id = ?",
      roleId,
    );
    if (!role) throw notFound("角色不存在");
  }

  if (status === "active") {
    const active = await dbOne<{ id: string }>(
      db,
      "select id from membership where person_id = ? and org_id = ? and status = 'active'",
      personId,
      orgId,
    );
    if (active) throw conflict("该人员在此组织中已有生效的成员关系");
  }

  const id = ulid();
  await dbBatch(db, [
    {
      sql: "insert into membership (id, person_id, org_id, role_id, status, valid_from, valid_to, is_primary, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: [
        id,
        personId,
        orgId,
        roleId,
        status,
        validFrom,
        validTo,
        isPrimary ? 1 : 0,
        nowIso(),
      ],
    },
    auditStatement(c.get("user").id, "membership.create", "membership", id, {
      personId,
      orgId,
      roleId,
      status,
    }),
  ]);
  return c.json(await loadMembershipView(db, id));
};

const updateMembership = async (c: PeopleContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  const existing = await dbOne<MembershipRow>(
    db,
    `${MEMBERSHIP_SELECT} where m.id = ?`,
    id,
  );
  if (!existing) throw notFound("成员关系不存在");

  const body = await readBody(c);
  const sets: string[] = [];
  const params: BindValue[] = [];
  const changes: Record<string, unknown> = {};

  if (body.roleId !== undefined) {
    const roleId = optString(body.roleId, "roleId", 64);
    if (roleId !== null) {
      const role = await dbOne<{ id: string }>(
        db,
        "select id from role where id = ?",
        roleId,
      );
      if (!role) throw notFound("角色不存在");
    }
    sets.push("role_id = ?");
    params.push(roleId);
    changes.roleId = roleId;
  }
  if (body.status !== undefined) {
    const status = oneOf(body.status, MEMBERSHIP_STATUSES, "status");
    if (status === "active") {
      const active = await dbOne<{ id: string }>(
        db,
        "select id from membership where person_id = ? and org_id = ? and status = 'active' and id != ?",
        existing.personId,
        existing.orgId,
        id,
      );
      if (active) throw conflict("该人员在此组织中已有生效的成员关系");
    }
    sets.push("status = ?");
    params.push(status);
    changes.status = status;
  }
  if (body.validFrom !== undefined) {
    const validFrom = optIsoDate(body.validFrom, "validFrom");
    sets.push("valid_from = ?");
    params.push(validFrom);
    changes.validFrom = validFrom;
  }
  if (body.validTo !== undefined) {
    const validTo = optIsoDate(body.validTo, "validTo");
    sets.push("valid_to = ?");
    params.push(validTo);
    changes.validTo = validTo;
  }
  if (body.isPrimary !== undefined) {
    const isPrimary = asBool(body.isPrimary, false);
    sets.push("is_primary = ?");
    params.push(isPrimary ? 1 : 0);
    changes.isPrimary = isPrimary;
  }

  if (sets.length === 0) throw badRequest("没有需要修改的字段");

  await dbBatch(db, [
    {
      sql: `update membership set ${sets.join(", ")} where id = ?`,
      params: [...params, id],
    },
    auditStatement(
      c.get("user").id,
      "membership.update",
      "membership",
      id,
      changes,
    ),
  ]);
  return c.json(await loadMembershipView(db, id));
};

const deleteMembership = async (c: PeopleContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  const existing = await dbOne<{ id: string; personId: string }>(
    db,
    "select id, person_id from membership where id = ?",
    id,
  );
  if (!existing) throw notFound("成员关系不存在");

  // 软删：把状态置为 ended，保留任期历史。
  await dbBatch(db, [
    {
      sql: "update membership set status = 'ended' where id = ?",
      params: [id],
    },
    auditStatement(c.get("user").id, "membership.ended", "membership", id, {
      personId: existing.personId,
    }),
  ]);
  return c.json(await loadMembershipView(db, id));
};

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

people.get("/persons", listPersons);
people.post("/persons", createPerson);
people.get("/persons/:id", getPerson);
people.patch("/persons/:id", updatePerson);
people.delete("/persons/:id", deletePerson);
people.get("/persons/:id/timetable", getTimetable);
people.get("/persons/:id/availability", getAvailability);
people.get("/persons/:id/unavailability", listUnavailability);
people.post("/persons/:id/unavailability", createUnavailability);
people.delete("/unavailability/:id", deleteUnavailability);

people.get("/orgs", listOrgs);
people.post("/orgs", createOrg);
people.patch("/orgs/:id", updateOrg);
people.delete("/orgs/:id", deleteOrg);

people.get("/roles", listRoles);
people.post("/roles", createRole);

people.get("/memberships", listMemberships);
people.post("/memberships", createMembership);
people.patch("/memberships/:id", updateMembership);
people.delete("/memberships/:id", deleteMembership);

export default people;
