/**
 * 课程与课表：课程、选课、上课规则、格子占用。
 *
 * 关键设计：规则（course_meeting）与占用（course_occurrence）都挂在课程上，
 * 不按人复制。30 个人选同一门课只存一份规则、一份 occurrence；
 * 某个人的占用 = 他 enrollment 的课程的 occurrence。
 *
 * 挂载方式：主入口按 `app.route("/api", courses)` 挂载，本文件路径都是
 * `/courses`、`/meetings`、`/terms` 这样的全路径，不带 `/api` 前缀。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type {
  Course,
  CourseMeetingView,
  Enrollment,
  Term,
  WeekPatternKind,
} from "../../shared/types";
import { expandWeeks, periodSpan } from "../domain/time";
import type { Env } from "../env";
import {
  asInt,
  asString,
  badRequest,
  dbAll,
  dbBatch,
  dbOne,
  dbRun,
  notFound,
  nowIso,
  oneOf,
  optString,
  readJson,
  ulid,
} from "../lib/core";

export const courses = new Hono<{ Bindings: Env }>();

type CoursesContext = Context<{ Bindings: Env }>;
type BindValue = string | number | null;

interface Statement {
  sql: string;
  params?: BindValue[];
}

/** D1 batch 单批上限 100 条语句，留出余量按 90 条切。 */
const BATCH_SIZE = 90;
/** D1 单条 SQL 的绑定参数上限 100，IN 查询按 90 个一批。 */
const IN_CHUNK = 90;

const WEEK_PATTERN_KINDS = ["all", "odd", "even", "ranges"] as const;

const TERM_COLUMNS = "id, name, start_date, week_count, timezone, status, created_at";
const COURSE_SELECT = "select c.id, c.term_id, c.code, c.name, c.teacher from course c";
const ENROLLMENT_COLUMNS = "id, person_id, course_id, term_id, status";

interface MeetingInput {
  weekday: number;
  periodFrom: number;
  periodTo: number;
  patternKind: WeekPatternKind;
  weekRanges: string | null;
  location: string | null;
}

interface MeetingForExpansion extends MeetingInput {
  id: string;
  courseId: string;
  termId: string;
}

interface CourseDetail {
  course: Course;
  meetings: CourseMeetingView[];
}

interface MeetingDetailRow {
  id: string;
  courseId: string | null;
  termId: string;
  weekday: number;
  periodFrom: number;
  periodTo: number;
  patternKind: WeekPatternKind;
  weekRanges: string | null;
  location: string | null;
  courseName: string;
  occurrenceCount: number;
}

/** 重算时读回的规则行：表里这些列允许 NULL，读回来统一做防御。 */
interface MeetingRow {
  id: string;
  courseId: string | null;
  termId: string;
  weekday: number | null;
  periodFrom: number | null;
  periodTo: number | null;
  patternKind: WeekPatternKind;
  weekRanges: string | null;
  location: string | null;
}

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
  await dbRun(
    db,
    "insert into audit_event (id, actor_id, action, target_type, target_id, payload, created_at) values (?, ?, ?, ?, ?, ?, ?)",
    ulid(),
    actor,
    action,
    targetType,
    targetId,
    JSON.stringify(payload),
    nowIso(),
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** 分批执行；单批是事务，跨批不是（D1 没有跨批事务）。 */
async function runBatches(db: D1Database, statements: Statement[]): Promise<void> {
  for (const part of chunk(statements, BATCH_SIZE)) {
    await dbBatch(db, part);
  }
}

async function readBody(c: CoursesContext): Promise<Record<string, unknown>> {
  const body = await readJson<unknown>(c);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

/** Hono 的 param() 类型是 `string | undefined`，这里收敛成非空字符串。 */
function pathParam(c: CoursesContext, name: string): string {
  return c.req.param(name) ?? "";
}

function parseIdList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest(`${field} 必须是字符串数组`);
  const ids: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "string" || item.trim() === "") {
      throw badRequest(`${field} 里必须是非空字符串`);
    }
    ids.push(item.trim());
  }
  return [...new Set(ids)];
}

/** 校验一条上课规则；periodFrom / periodTo 允许倒序，展开时按区间处理。 */
function parseMeetingInput(value: unknown, field: string): MeetingInput {
  if (typeof value !== "object" || value === null) throw badRequest(`${field} 必须是对象`);
  const raw = value as Record<string, unknown>;
  const weekday = asInt(raw.weekday, `${field}.weekday`, 1);
  if (weekday > 7) throw badRequest(`${field}.weekday 必须在 1..7`);
  const periodFrom = asInt(raw.periodFrom, `${field}.periodFrom`, 1);
  const periodTo = asInt(raw.periodTo, `${field}.periodTo`, 1);
  const patternKind = oneOf(raw.patternKind, WEEK_PATTERN_KINDS, `${field}.patternKind`);
  const weekRanges = optString(raw.weekRanges, `${field}.weekRanges`, 200);
  if (patternKind === "ranges" && weekRanges === null) {
    throw badRequest(`${field}.weekRanges 在 ranges 模式下必填`);
  }
  const location = optString(raw.location, `${field}.location`, 200);
  return { weekday, periodFrom, periodTo, patternKind, weekRanges, location };
}

async function loadTerm(db: D1Database, id: string): Promise<Term | null> {
  return dbOne<Term>(db, `select ${TERM_COLUMNS} from term where id = ?`, id);
}

async function loadCourse(db: D1Database, id: string): Promise<Course | null> {
  return dbOne<Course>(db, `${COURSE_SELECT} where c.id = ?`, id);
}

async function assertPersonsExist(db: D1Database, personIds: string[]): Promise<void> {
  const known = new Set<string>();
  for (const ids of chunk(personIds, IN_CHUNK)) {
    const rows = await dbAll<{ id: string }>(
      db,
      `select id from person where id in (${placeholders(ids.length)})`,
      ...ids,
    );
    for (const row of rows) known.add(row.id);
  }
  const missing = personIds.filter((id) => !known.has(id));
  if (missing.length > 0) throw notFound(`人员不存在：${missing.join("、")}`);
}

const slotKey = (week: number, weekday: number, period: number): string =>
  `${week}-${weekday}-${period}`;

/** 整学期的 slot 查表：`周-天-节` → slotId。 */
async function loadSlotMap(db: D1Database, termId: string): Promise<Map<string, string>> {
  const rows = await dbAll<{
    id: string;
    weekIndex: number;
    weekday: number;
    periodIndex: number;
  }>(
    db,
    "select id, week_index, weekday, period_index from slot where term_id = ? order by week_index, weekday, period_index",
    termId,
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(slotKey(row.weekIndex, row.weekday, row.periodIndex), row.id);
  }
  return map;
}

/**
 * 把一条上课规则展开成 occurrence。
 *
 * 同一门课同一 slot 只留一条（schema 里没有唯一索引，只能在内存里去重，
 * `seen` 的键是 `courseId:slotId`，跨规则共享）。
 * 学期里没有对应格子的节次（节次表没定义）直接跳过。
 */
function occurrenceStatements(
  meeting: MeetingForExpansion,
  weekCount: number,
  slotsByKey: Map<string, string>,
  seen: Set<string>,
): Statement[] {
  const statements: Statement[] = [];
  const weeks = expandWeeks(meeting.patternKind, meeting.weekRanges ?? undefined, weekCount);
  const periods = periodSpan(meeting.periodFrom, meeting.periodTo);
  for (const week of weeks) {
    for (const period of periods) {
      const slotId = slotsByKey.get(slotKey(week, meeting.weekday, period));
      if (slotId === undefined) continue;
      const dedupeKey = `${meeting.courseId}:${slotId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      statements.push({
        sql: "insert into course_occurrence (id, meeting_id, slot_id, status, note) values (?, ?, ?, ?, ?)",
        params: [ulid(), meeting.id, slotId, "scheduled", null],
      });
    }
  }
  return statements;
}

async function loadCourseDetail(db: D1Database, courseId: string): Promise<CourseDetail> {
  const course = await loadCourse(db, courseId);
  if (!course) throw notFound("课程不存在");

  const rows = await dbAll<MeetingDetailRow>(
    db,
    `select m.id, m.course_id, m.term_id, m.weekday, m.period_from, m.period_to,
            m.pattern_kind, m.week_ranges, m.location,
            coalesce(c.name, '') as course_name,
            (select count(*) from course_occurrence o where o.meeting_id = m.id) as occurrence_count
       from course_meeting m
       left join course c on c.id = m.course_id
      where m.course_id = ?
      order by m.weekday, m.period_from, m.id`,
    courseId,
  );

  const meetings: CourseMeetingView[] = rows.map((row) => ({
    id: row.id,
    courseId: row.courseId ?? courseId,
    termId: row.termId,
    weekday: row.weekday,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    patternKind: row.patternKind,
    weekRanges: row.weekRanges,
    location: row.location,
    courseName: row.courseName,
    occurrenceCount: row.occurrenceCount,
  }));
  return { course, meetings };
}

/**
 * 建课跨多个 batch 时无法整体回滚；失败后按 courseId 清掉半成品。
 */
async function cleanupFailedCourse(db: D1Database, courseId: string): Promise<void> {
  try {
    await dbBatch(db, [
      {
        sql: "delete from course_occurrence where meeting_id in (select id from course_meeting where course_id = ?)",
        params: [courseId],
      },
      { sql: "delete from course_meeting where course_id = ?", params: [courseId] },
      { sql: "delete from enrollment where course_id = ?", params: [courseId] },
      { sql: "delete from course where id = ?", params: [courseId] },
    ]);
  } catch {
    // 清理失败就不再掩盖原始错误。
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const listCourses = async (c: CoursesContext) => {
  const db = c.env.DB;
  const termId = optString(c.req.query("termId"), "termId", 64);
  const personId = optString(c.req.query("personId"), "personId", 64);

  const conditions: string[] = [];
  const params: BindValue[] = [];
  if (termId) {
    conditions.push("c.term_id = ?");
    params.push(termId);
  }
  if (personId) {
    conditions.push(
      "exists (select 1 from enrollment e where e.course_id = c.id and e.person_id = ? and e.status = 'active')",
    );
    params.push(personId);
  }
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const items = await dbAll<Course>(db, `${COURSE_SELECT} ${where} order by c.name, c.id`, ...params);
  return c.json({ items });
};

const createCourse = async (c: CoursesContext) => {
  const db = c.env.DB;
  const body = await readBody(c);

  const termId = asString(body.termId, "termId", 64);
  const name = asString(body.name, "name", 150);
  const code = optString(body.code, "code", 50);
  const teacher = optString(body.teacher, "teacher", 100);
  const term = await loadTerm(db, termId);
  if (!term) throw notFound("学期不存在");

  const personIds = parseIdList(body.personIds, "personIds");
  const rawMeetings = body.meetings;
  if (rawMeetings !== undefined && !Array.isArray(rawMeetings)) {
    throw badRequest("meetings 必须是数组");
  }
  const meetings = ((rawMeetings as unknown[] | undefined) ?? []).map((item, index) =>
    parseMeetingInput(item, `meetings[${index}]`),
  );
  if (personIds.length > 0) await assertPersonsExist(db, personIds);

  const courseId = ulid();
  const createdAt = nowIso();
  const slotsByKey = await loadSlotMap(db, termId);
  const seen = new Set<string>();
  const meetingRows: MeetingForExpansion[] = meetings.map((meeting) => ({
    id: ulid(),
    courseId,
    termId,
    ...meeting,
  }));

  const statements: Statement[] = [
    {
      sql: "insert into course (id, term_id, code, name, teacher, created_at) values (?, ?, ?, ?, ?, ?)",
      params: [courseId, termId, code, name, teacher, createdAt],
    },
  ];
  for (const personId of personIds) {
    statements.push({
      sql: "insert into enrollment (id, person_id, course_id, term_id, status, created_at) values (?, ?, ?, ?, 'active', ?)",
      params: [ulid(), personId, courseId, termId, createdAt],
    });
  }
  for (const meeting of meetingRows) {
    statements.push({
      sql: "insert into course_meeting (id, course_id, term_id, weekday, period_from, period_to, pattern_kind, week_ranges, location) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: [
        meeting.id,
        courseId,
        termId,
        meeting.weekday,
        meeting.periodFrom,
        meeting.periodTo,
        meeting.patternKind,
        meeting.weekRanges,
        meeting.location,
      ],
    });
  }
  for (const meeting of meetingRows) {
    statements.push(...occurrenceStatements(meeting, term.weekCount, slotsByKey, seen));
  }

  try {
    await runBatches(db, statements);
  } catch (error) {
    await cleanupFailedCourse(db, courseId);
    throw error;
  }

  await writeAudit(db, c.get("user").id, "course.create", "course", courseId, {
    termId,
    name,
    code,
    teacher,
    persons: personIds.length,
    meetings: meetings.length,
    occurrences: seen.size,
  });
  return c.json(await loadCourseDetail(db, courseId));
};

const getCourse = async (c: CoursesContext) => {
  return c.json(await loadCourseDetail(c.env.DB, pathParam(c, "id")));
};

const deleteCourse = async (c: CoursesContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  const course = await loadCourse(db, id);
  if (!course) throw notFound("课程不存在");

  await dbBatch(db, [
    {
      sql: "delete from course_occurrence where meeting_id in (select id from course_meeting where course_id = ?)",
      params: [id],
    },
    { sql: "delete from course_meeting where course_id = ?", params: [id] },
    { sql: "delete from enrollment where course_id = ?", params: [id] },
    { sql: "delete from course where id = ?", params: [id] },
    auditStatement(c.get("user").id, "course.delete", "course", id, { name: course.name }),
  ]);
  return c.json({ ok: true });
};

const enrollCourse = async (c: CoursesContext) => {
  const db = c.env.DB;
  const courseId = pathParam(c, "id");
  const course = await loadCourse(db, courseId);
  if (!course) throw notFound("课程不存在");

  const body = await readBody(c);
  const personIds = parseIdList(body.personIds, "personIds");
  if (personIds.length === 0) throw badRequest("personIds 不能为空");
  await assertPersonsExist(db, personIds);

  const enrolled = new Set(
    (
      await dbAll<{ personId: string }>(
        db,
        "select person_id from enrollment where course_id = ?",
        courseId,
      )
    ).map((row) => row.personId),
  );
  const added = personIds.filter((personId) => !enrolled.has(personId));

  if (added.length > 0) {
    const createdAt = nowIso();
    const statements: Statement[] = added.map((personId) => ({
      sql: "insert into enrollment (id, person_id, course_id, term_id, status, created_at) values (?, ?, ?, ?, 'active', ?)",
      params: [ulid(), personId, courseId, course.termId, createdAt],
    }));
    await runBatches(db, statements);
  }
  await writeAudit(db, c.get("user").id, "course.enroll", "course", courseId, {
    requested: personIds.length,
    added,
  });

  const items = await dbAll<Enrollment>(
    db,
    `select ${ENROLLMENT_COLUMNS} from enrollment where course_id = ? order by created_at, id`,
    courseId,
  );
  return c.json({ items });
};

const addMeeting = async (c: CoursesContext) => {
  const db = c.env.DB;
  const courseId = pathParam(c, "id");
  const course = await loadCourse(db, courseId);
  if (!course) throw notFound("课程不存在");

  const term = await loadTerm(db, course.termId);
  if (!term) throw notFound("学期不存在");

  const body = await readBody(c);
  const meeting = parseMeetingInput(body, "meeting");
  const meetingId = ulid();
  const row: MeetingForExpansion = { id: meetingId, courseId, termId: course.termId, ...meeting };

  const slotsByKey = await loadSlotMap(db, course.termId);
  const existing = await dbAll<{ slotId: string }>(
    db,
    `select o.slot_id
       from course_occurrence o
       join course_meeting m on m.id = o.meeting_id
      where m.course_id = ?`,
    courseId,
  );
  const seen = new Set(existing.map((item) => `${courseId}:${item.slotId}`));

  const statements: Statement[] = [
    {
      sql: "insert into course_meeting (id, course_id, term_id, weekday, period_from, period_to, pattern_kind, week_ranges, location) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: [
        meetingId,
        courseId,
        course.termId,
        meeting.weekday,
        meeting.periodFrom,
        meeting.periodTo,
        meeting.patternKind,
        meeting.weekRanges,
        meeting.location,
      ],
    },
    ...occurrenceStatements(row, term.weekCount, slotsByKey, seen),
  ];
  await runBatches(db, statements);
  await writeAudit(db, c.get("user").id, "course.meeting.create", "course_meeting", meetingId, {
    courseId,
    weekday: meeting.weekday,
    periodFrom: meeting.periodFrom,
    periodTo: meeting.periodTo,
    patternKind: meeting.patternKind,
  });

  const view: CourseMeetingView = {
    id: meetingId,
    courseId,
    termId: course.termId,
    weekday: meeting.weekday,
    periodFrom: meeting.periodFrom,
    periodTo: meeting.periodTo,
    patternKind: meeting.patternKind,
    weekRanges: meeting.weekRanges,
    location: meeting.location,
    courseName: course.name,
    occurrenceCount: statements.length - 1,
  };
  return c.json(view);
};

const deleteMeeting = async (c: CoursesContext) => {
  const db = c.env.DB;
  const id = pathParam(c, "id");
  const meeting = await dbOne<{ id: string; courseId: string | null }>(
    db,
    "select id, course_id from course_meeting where id = ?",
    id,
  );
  if (!meeting) throw notFound("上课规则不存在");

  await dbBatch(db, [
    { sql: "delete from course_occurrence where meeting_id = ?", params: [id] },
    { sql: "delete from course_meeting where id = ?", params: [id] },
    auditStatement(c.get("user").id, "course.meeting.delete", "course_meeting", id, { courseId: meeting.courseId }),
  ]);
  return c.json({ ok: true });
};

/** 全量重算：清空该学期 occurrence 后按所有规则重建，幂等。 */
const recomputeOccurrences = async (c: CoursesContext) => {
  const db = c.env.DB;
  const termId = pathParam(c, "id");
  const term = await loadTerm(db, termId);
  if (!term) throw notFound("学期不存在");

  const meetings = await dbAll<MeetingRow>(
    db,
    `select id, course_id, term_id, weekday, period_from, period_to, pattern_kind, week_ranges, location
       from course_meeting
      where term_id = ?
      order by id`,
    termId,
  );
  const slotsByKey = await loadSlotMap(db, termId);
  const seen = new Set<string>();
  const statements: Statement[] = [];

  for (const meeting of meetings) {
    if (
      meeting.courseId === null ||
      meeting.weekday === null ||
      meeting.periodFrom === null ||
      meeting.periodTo === null
    ) {
      // 脏数据（规则缺列）无法展开，跳过而不是整批失败。
      continue;
    }
    statements.push(
      ...occurrenceStatements(
        {
          id: meeting.id,
          courseId: meeting.courseId,
          termId: meeting.termId,
          weekday: meeting.weekday,
          periodFrom: meeting.periodFrom,
          periodTo: meeting.periodTo,
          patternKind: meeting.patternKind,
          weekRanges: meeting.weekRanges,
          location: meeting.location,
        },
        term.weekCount,
        slotsByKey,
        seen,
      ),
    );
  }

  await dbBatch(db, [
    {
      sql: "delete from course_occurrence where meeting_id in (select id from course_meeting where term_id = ?)",
      params: [termId],
    },
  ]);
  await runBatches(db, statements);
  await writeAudit(db, c.get("user").id, "term.recompute_occurrences", "term", termId, {
    meetings: meetings.length,
    occurrences: statements.length,
  });

  return c.json({ termId, meetings: meetings.length, occurrences: statements.length });
};

courses.get("/courses", listCourses);
courses.post("/courses", createCourse);
courses.get("/courses/:id", getCourse);
courses.delete("/courses/:id", deleteCourse);
courses.post("/courses/:id/enroll", enrollCourse);
courses.post("/courses/:id/meetings", addMeeting);
courses.delete("/meetings/:id", deleteMeeting);
courses.post("/terms/:id/recompute-occurrences", recomputeOccurrences);


courses.get("/courses/:id/occurrences", async c => {
  const id = c.req.param("id");
  if (!(await loadCourse(c.env.DB, id))) throw notFound("课程不存在");
  return c.json({ items: await dbAll(c.env.DB, `select o.id, o.meeting_id, o.slot_id, o.status, o.note,
    s.week_index, s.weekday, s.period_index, s.starts_at, s.ends_at
    from course_occurrence o join course_meeting m on m.id=o.meeting_id join slot s on s.id=o.slot_id
    where m.course_id=? order by s.starts_at`, id) });
});

courses.patch("/occurrences/:id", async c => {
  const id = c.req.param("id");
  const existing = await dbOne<{ termId: string; slotId: string }>(c.env.DB,
    "select m.term_id,o.slot_id from course_occurrence o join course_meeting m on m.id=o.meeting_id where o.id=?", id);
  if (!existing) throw notFound("课程时段不存在");
  const body = await readJson<Record<string, unknown>>(c);
  const slotId = typeof body.slotId === "string" ? body.slotId : existing.slotId;
  const slot = await dbOne<{ termId: string }>(c.env.DB, "select term_id from slot where id=?", slotId);
  if (!slot || slot.termId !== existing.termId) throw badRequest("只能调到同一学期内的节次");
  const status = oneOf(body.status ?? (slotId === existing.slotId ? "scheduled" : "moved"), ["scheduled", "cancelled", "moved"] as const, "status");
  const note = optString(body.note, "note", 500);
  await dbBatch(c.env.DB, [
    { sql: "update course_occurrence set slot_id=?,status=?,note=? where id=?", params: [slotId,status,note,id] },
    auditStatement(c.get("user").id, "course.occurrence.update", "course_occurrence", id, { slotId, status, note }),
  ]);
  return c.json({ ok: true });
});

export default courses;
