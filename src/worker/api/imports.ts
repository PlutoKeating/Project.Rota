import { Hono } from "hono";
import type { Context } from "hono";
import type {
  CourseMeeting,
  ImportJob,
  ImportJobStatus,
  ImportSourceKind,
  ParsedCourse,
  ParsedMeeting,
  ParsedTimetable,
  Person,
  Period,
  Slot,
  Term,
} from "../../shared/types";
import { expandWeeks, periodSpan } from "../domain/time";
import { parseTimetable } from "../import/parse";
import { parseScreenshot } from "../import/vision";
import type { Env } from "../env";
import {
  HttpError,
  asBool,
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
  optString,
  parseJson,
  ulid,
} from "../lib/core";

/**
 * 课表导入路由。
 *
 * 流程：上传原件到 R2 → import_job(parsing) → 同步解析 → needs_review。
 * 解析结果永远不自动落库，必须由管理员调 apply 确认；apply 时：
 * - 一门课只建一份 course + course_meeting，多人选课只加 enrollment；
 * - occurrence 按 meeting 规则展开到 slot，不复制到人。
 *
 * 注意：数据库 schema 的 import_job 没有 file_name / term_id 列，
 * 文件名从 file_key 末段取，termId 随 parsed_json 一起存（见 StoredParsed）。
 */
export const imports = new Hono<{ Bindings: Env }>();

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const UPLOAD_KINDS = ["excel", "csv", "ics", "screenshot"] as const;
type UploadKind = (typeof UPLOAD_KINDS)[number];

interface ImportJobRow {
  id: string;
  sourceKind: ImportSourceKind;
  fileKey: string | null;
  status: ImportJobStatus;
  parsedJson: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string | null;
}

/** parsed_json 里额外带一份 termId，弥补 import_job 表没有 term_id 的缺口。 */
interface StoredParsed extends ParsedTimetable {
  termId?: string;
}

interface TermContext {
  term: Term;
  periods: Period[];
  slots: Slot[];
}

type Statement = { sql: string; params: (string | number | null)[] };

interface ApplySummary {
  courses: number;
  meetings: number;
  occurrences: number;
  enrollments: number;
}

// ---------------------------------------------------------------------------
// 上传与解析
// ---------------------------------------------------------------------------

imports.post("/", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw badRequest("请求必须是 multipart/form-data");
  }

  // workers-types 把 FormData.get 声明成 string | null，但运行时文件字段返回 File。
  const rawFile = form.get("file") as unknown as File | string | null;
  if (!rawFile || typeof rawFile === "string") throw badRequest("缺少文件字段 file");
  const file = rawFile;
  if (file.size === 0) throw badRequest("文件内容为空");
  if (file.size > MAX_FILE_BYTES) {
    throw new HttpError(413, "payload_too_large", "文件不能超过 5MB");
  }

  // 少数运行时会把文件字段暴露成 Blob（没有 name），留一个兜底。
  const originalName = typeof file.name === "string" && file.name ? file.name : "upload";
  const fileName = safeFileName(originalName, "upload");
  const sourceKind = resolveSourceKind(form.get("sourceKind"), fileName);
  const termId = asString(form.get("termId"), "termId", 100);
  const personId = optString(form.get("personId"), "personId", 100);

  const context = await loadTermContext(c.env.DB, termId);
  const person = personId ? await loadPerson(c.env.DB, personId) : null;

  const bytes = await file.arrayBuffer();
  const contentType = contentTypeFor(sourceKind, file.type, fileName);
  const id = ulid();
  const fileKey = `imports/${id}/${fileName}`;

  await c.env.FILES.put(fileKey, bytes, { httpMetadata: { contentType } });

  try {
    await dbRun(
      c.env.DB,
      "insert into import_job (id, source_kind, file_key, status, raw_text, parsed_json, error, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)",
      id,
      sourceKind,
      fileKey,
      "parsing",
      null,
      null,
      null,
      nowIso(),
      null,
    );
  } catch (error) {
    // 元数据写不进去就把 R2 原件删掉，避免留下孤儿对象。
    try {
      await c.env.FILES.delete(fileKey);
    } catch {
      // 清理失败不覆盖原始错误
    }
    throw error;
  }

  await audit(c, "import.upload", "import_job", id, {
    sourceKind,
    fileName,
    bytes: bytes.byteLength,
    termId,
    personId,
  });

  try {
    const parsed =
      sourceKind === "screenshot"
        ? await parseScreenshot(c.env, {
            bytes,
            mime: contentType,
            term: context.term,
            periods: context.periods,
          })
        : parseTimetable({
            kind: sourceKind,
            bytes,
            fileName,
            term: context.term,
            periods: context.periods,
            slots: context.slots,
          });

    if (person) {
      parsed.personId = person.id;
      parsed.personName = person.fullName;
    }

    const stored: StoredParsed = { ...parsed, termId };
    await dbRun(
      c.env.DB,
      "update import_job set status = ?, parsed_json = ?, error = ?, updated_at = ? where id = ?",
      "needs_review",
      JSON.stringify(stored),
      null,
      nowIso(),
      id,
    );
    await audit(c, "import.parse", "import_job", id, {
      sourceKind,
      courseCount: parsed.courses.length,
      warningCount: parsed.warnings.length,
    });

    const row = await getJobRow(c.env.DB, id);
    if (!row) throw notFound("导入任务不存在");
    return c.json(jobView(row), 201);
  } catch (error) {
    const message = errorMessage(error);
    try {
      await dbRun(
        c.env.DB,
        "update import_job set status = ?, error = ?, updated_at = ? where id = ?",
        "failed",
        message.slice(0, 1000),
        nowIso(),
        id,
      );
      await audit(c, "import.fail", "import_job", id, {
        sourceKind,
        message: message.slice(0, 300),
      });
    } catch {
      // 标记失败的过程中再失败，也不能吞掉真正的解析错误
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, "internal", `解析失败：${message.slice(0, 300)}`);
  }
});

imports.get("/", async (c) => {
  const rows = await dbAll<ImportJobRow>(
    c.env.DB,
    "select id, source_kind, file_key, status, parsed_json, error, created_at, updated_at from import_job order by created_at desc, id desc limit 50",
  );
  return c.json({ items: rows.map(jobView) });
});

imports.get("/:id", async (c) => {
  const row = await getJobRow(c.env.DB, c.req.param("id"));
  if (!row) throw notFound("导入任务不存在");
  return c.json(jobView(row));
});

// ---------------------------------------------------------------------------
// 应用解析结果
// ---------------------------------------------------------------------------

imports.post("/:id/apply", async (c) => {
  const id = c.req.param("id");
  const row = await getJobRow(c.env.DB, id);
  if (!row) throw notFound("导入任务不存在");
  if (row.status === "failed") throw conflict("解析失败的任务不能应用");
  if (row.status === "parsing" || row.status === "uploaded") {
    throw conflict("任务还在解析中，请稍后再试");
  }

  const stored = parseJson<StoredParsed>(row.parsedJson);
  if (!stored || !Array.isArray(stored.courses) || stored.courses.length === 0) {
    throw badRequest("任务没有可应用的课程");
  }

  const payload = await readApplyInput(c);
  const replace = asBool(payload.replace, asBool(payload.overwrite, false));
  // 前端允许在确认页改解析结果，改过的 courses 优先于库里的原始解析
  const edited = payload.parsed as { courses?: unknown } | null | undefined;
  const coursesToApply = Array.isArray(edited?.courses)
    ? (edited.courses as StoredParsed["courses"])
    : stored.courses;
  if (row.status === "applied" && !replace) {
    throw conflict("该导入已应用，如需覆盖请传 replace=true");
  }

  const termId = payload.termId
    ? asString(payload.termId, "termId", 100)
    : stored.termId ?? null;
  if (!termId) {
    throw badRequest("缺少 termId：导入任务没有记录学期，请在 apply 请求里指定");
  }
  const personId = payload.personId
    ? asString(payload.personId, "personId", 100)
    : stored.personId ?? null;
  if (!personId) {
    throw badRequest("缺少 personId：请在 apply 请求里指定选课人");
  }

  const context = await loadTermContext(c.env.DB, termId);
  await loadPerson(c.env.DB, personId);

  const warnings: string[] = [];
  if (stored.termId && stored.termId !== termId) {
    addWarning(warnings, `导入时记录的学期是 ${stored.termId}，本次按 ${termId} 落库`);
  }
  if (stored.personId && stored.personId !== personId) {
    addWarning(warnings, `导入时绑定的人员是 ${stored.personId}，本次按 ${personId} 落库`);
  }

  const slotMap = new Map<string, string>();
  for (const slot of context.slots) {
    slotMap.set(`${slot.weekIndex}:${slot.weekday}:${slot.periodIndex}`, slot.id);
  }

  const summary: ApplySummary = {
    courses: 0,
    meetings: 0,
    occurrences: 0,
    enrollments: 0,
  };

  for (const course of coursesToApply) {
    await applyCourse(c.env.DB, context, slotMap, course, personId, replace, summary, warnings);
  }

  const updatedAt = nowIso();
  await dbRun(
    c.env.DB,
    "update import_job set status = ?, updated_at = ? where id = ?",
    "applied",
    updatedAt,
    id,
  );
  await audit(c, "import.apply", "import_job", id, {
    termId,
    personId,
    replace,
    ...summary,
  });

  const updated = await getJobRow(c.env.DB, id);
  return c.json({
    job: jobView(updated ?? { ...row, status: "applied", updatedAt }),
    summary,
    warnings,
  });
});

imports.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await getJobRow(c.env.DB, id);
  if (!row) throw notFound("导入任务不存在");

  if (row.fileKey) await c.env.FILES.delete(row.fileKey);
  await dbRun(c.env.DB, "delete from import_job where id = ?", id);
  await audit(c, "import.delete", "import_job", id, {
    sourceKind: row.sourceKind,
    fileName: baseName(row.fileKey),
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 落库：course + meeting + enrollment + occurrence
// ---------------------------------------------------------------------------

async function applyCourse(
  db: D1Database,
  context: TermContext,
  slotMap: Map<string, string>,
  parsedCourse: ParsedCourse,
  personId: string,
  replace: boolean,
  summary: ApplySummary,
  warnings: string[],
): Promise<void> {
  const name = (parsedCourse.name ?? "").trim();
  if (!name) return;
  const teacher = parsedCourse.teacher?.trim() || null;
  const meetings = (Array.isArray(parsedCourse.meetings) ? parsedCourse.meetings : [])
    .map(normalizeMeeting)
    .filter(isValidMeeting);

  if (meetings.length === 0) {
    addWarning(warnings, `课程「${name}」没有有效上课时间，已跳过`);
    return;
  }

  const existing = await dbOne<{
    id: string;
    termId: string;
    code: string | null;
    name: string;
    teacher: string | null;
  }>(
    db,
    "select id, term_id, code, name, teacher from course where term_id = ? and name = ? and ifnull(teacher, '') = ? limit 1",
    context.term.id,
    name,
    teacher ?? "",
  );

  let courseId: string;
  let existingMeetings = new Set<string>();
  let enrollment: { id: string; status: string } | null = null;
  let rebuild = false;

  if (existing) {
    if (replace) {
      const other = await dbOne<{ n: number }>(
        db,
        "select count(*) as n from enrollment where course_id = ? and person_id <> ? and status = 'active'",
        existing.id,
        personId,
      );
      if (other && Number(other.n) > 0) {
        throw conflict(`课程「${name}」还有其他人选课，不能用 replace 重建`);
      }
      await deleteCourseData(db, existing.id);
      rebuild = true;
    } else {
      enrollment = await dbOne<{ id: string; status: string }>(
        db,
        "select id, status from enrollment where person_id = ? and course_id = ?",
        personId,
        existing.id,
      );
      if (enrollment?.status === "active") {
        throw conflict(`人员已选修课程「${name}」，如需覆盖请传 replace=true`);
      }
      const rows = await dbAll<CourseMeeting>(
        db,
        "select id, course_id, term_id, weekday, period_from, period_to, pattern_kind, week_ranges, location from course_meeting where course_id = ?",
        existing.id,
      );
      existingMeetings = new Set(rows.map((meeting) => meetingKey(meeting)));
    }
  }

  const isNewCourse = !existing || rebuild;
  if (isNewCourse) {
    courseId = ulid();
    await dbRun(
      db,
      "insert into course (id, term_id, code, name, teacher, created_at) values (?,?,?,?,?,?)",
      courseId,
      context.term.id,
      null,
      name,
      teacher,
      nowIso(),
    );
    summary.courses += 1;
  } else {
    courseId = existing.id;
  }

  if (isNewCourse) {
    await insertEnrollment(db, personId, courseId, context.term.id);
    summary.enrollments += 1;
  } else if (enrollment) {
    // 之前被 dropped 的选课重新激活
    await dbRun(db, "update enrollment set status = 'active' where id = ?", enrollment.id);
    summary.enrollments += 1;
  } else {
    await insertEnrollment(db, personId, courseId, context.term.id);
    summary.enrollments += 1;
  }

  for (const meeting of meetings) {
    const key = meetingKey(meeting);
    if (existingMeetings.has(key)) continue;

    const meetingId = ulid();
    const statements: Statement[] = [
      {
        sql: "insert into course_meeting (id, course_id, term_id, weekday, period_from, period_to, pattern_kind, week_ranges, location) values (?,?,?,?,?,?,?,?,?)",
        params: [
          meetingId,
          courseId,
          context.term.id,
          meeting.weekday,
          meeting.periodFrom,
          meeting.periodTo,
          meeting.patternKind,
          meeting.weekRanges ?? null,
          meeting.location ?? null,
        ],
      },
    ];
    summary.meetings += 1;

    const weeks = expandWeeks(
      meeting.patternKind,
      meeting.weekRanges ?? undefined,
      context.term.weekCount,
    );
    if (weeks.length === 0) {
      addWarning(
        warnings,
        `课程「${name}」的周次规则（${meeting.patternKind} ${meeting.weekRanges ?? ""}）展开为空`,
      );
    }

    for (const week of weeks) {
      for (const periodIndex of periodSpan(meeting.periodFrom, meeting.periodTo)) {
        const slotId = slotMap.get(`${week}:${meeting.weekday}:${periodIndex}`);
        if (!slotId) {
          addWarning(
            warnings,
            `课程「${name}」缺少第 ${week} 周星期 ${meeting.weekday} 第 ${periodIndex} 节的格子，已跳过`,
          );
          continue;
        }
        statements.push({
          sql: "insert into course_occurrence (id, meeting_id, slot_id, status, note) values (?,?,?,?,?)",
          params: [ulid(), meetingId, slotId, "scheduled", null],
        });
        summary.occurrences += 1;
      }
    }

    await runStatements(db, statements);
  }
}

async function insertEnrollment(
  db: D1Database,
  personId: string,
  courseId: string,
  termId: string,
): Promise<void> {
  await dbRun(
    db,
    "insert into enrollment (id, person_id, course_id, term_id, status, created_at) values (?,?,?,?,?,?)",
    ulid(),
    personId,
    courseId,
    termId,
    "active",
    nowIso(),
  );
}

async function deleteCourseData(db: D1Database, courseId: string): Promise<void> {
  const meetings = await dbAll<{ id: string }>(
    db,
    "select id from course_meeting where course_id = ?",
    courseId,
  );
  const statements: Statement[] = meetings.map((meeting) => ({
    sql: "delete from course_occurrence where meeting_id = ?",
    params: [meeting.id],
  }));
  statements.push(
    { sql: "delete from course_meeting where course_id = ?", params: [courseId] },
    { sql: "delete from enrollment where course_id = ?", params: [courseId] },
    { sql: "delete from course where id = ?", params: [courseId] },
  );
  await runStatements(db, statements);
}

/** D1 batch 是单事务，但一次塞几千条不安全，按 90 条分批。 */
async function runStatements(db: D1Database, statements: Statement[]): Promise<void> {
  const chunkSize = 90;
  for (let index = 0; index < statements.length; index += chunkSize) {
    await dbBatch(db, statements.slice(index, index + chunkSize));
  }
}

// ---------------------------------------------------------------------------
// 数据加载与校验
// ---------------------------------------------------------------------------

async function loadTermContext(db: D1Database, termId: string): Promise<TermContext> {
  const term = await dbOne<Term>(
    db,
    "select id, name, start_date, week_count, timezone, status, created_at from term where id = ?",
    termId,
  );
  if (!term) throw notFound("学期不存在");

  const periods = await dbAll<Period>(
    db,
    "select id, term_id, period_index, label, start_time, end_time from class_period where term_id = ? order by period_index",
    termId,
  );
  const slots = await dbAll<Slot>(
    db,
    "select id, term_id, week_index, weekday, period_index, starts_at, ends_at from slot where term_id = ?",
    termId,
  );

  return { term, periods, slots };
}

async function loadPerson(db: D1Database, personId: string): Promise<Person> {
  const person = await dbOne<Person>(
    db,
    "select id, student_no, full_name, email, phone, status, created_at from person where id = ?",
    personId,
  );
  if (!person) throw notFound("人员不存在");
  return person;
}

function normalizeMeeting(meeting: ParsedMeeting): ParsedMeeting {
  return {
    weekday: meeting.weekday,
    periodFrom: Math.min(meeting.periodFrom, meeting.periodTo),
    periodTo: Math.max(meeting.periodFrom, meeting.periodTo),
    patternKind: meeting.patternKind,
    weekRanges: meeting.weekRanges?.trim() || null,
    location: meeting.location?.trim() || null,
  };
}

function isValidMeeting(meeting: ParsedMeeting): boolean {
  return (
    Number.isInteger(meeting.weekday) &&
    meeting.weekday >= 1 &&
    meeting.weekday <= 7 &&
    Number.isInteger(meeting.periodFrom) &&
    meeting.periodFrom >= 1 &&
    Number.isInteger(meeting.periodTo) &&
    meeting.periodTo >= 1 &&
    (meeting.patternKind !== "ranges" || Boolean(meeting.weekRanges))
  );
}

function meetingKey(meeting: {
  weekday: number;
  periodFrom: number;
  periodTo: number;
  patternKind: string;
  weekRanges?: string | null;
  location?: string | null;
}): string {
  return [
    meeting.weekday,
    meeting.periodFrom,
    meeting.periodTo,
    meeting.patternKind,
    meeting.weekRanges ?? "",
    meeting.location ?? "",
  ].join("\u0001");
}

// ---------------------------------------------------------------------------
// 请求体与响应映射
// ---------------------------------------------------------------------------

async function readApplyInput(
  c: Context<{ Bindings: Env }>,
): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

async function getJobRow(db: D1Database, id: string): Promise<ImportJobRow | null> {
  return dbOne<ImportJobRow>(
    db,
    "select id, source_kind, file_key, status, parsed_json, error, created_at, updated_at from import_job where id = ?",
    id,
  );
}

function jobView(row: ImportJobRow): ImportJob {
  const stored = parseJson<StoredParsed>(row.parsedJson);
  return {
    id: row.id,
    sourceKind: row.sourceKind,
    fileName: baseName(row.fileKey),
    status: row.status,
    parsed: stored ? publicParsed(stored) : null,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 对外只暴露 ParsedTimetable 的字段，termId 是内部存储细节。 */
function publicParsed(stored: StoredParsed): ParsedTimetable {
  return {
    personId: stored.personId ?? null,
    personName: stored.personName ?? null,
    courses: Array.isArray(stored.courses) ? stored.courses : [],
    warnings: Array.isArray(stored.warnings) ? stored.warnings : [],
  };
}

function baseName(fileKey: string | null): string | null {
  if (!fileKey) return null;
  const parts = fileKey.split("/");
  return parts[parts.length - 1] ?? fileKey;
}

// ---------------------------------------------------------------------------
// 上传辅助
// ---------------------------------------------------------------------------

function resolveSourceKind(value: unknown, fileName: string): UploadKind {
  if (typeof value === "string" && value.trim()) {
    return oneOf(value.trim(), UPLOAD_KINDS, "sourceKind");
  }

  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["xlsx", "xls", "xlsm", "xlsb"].includes(extension)) return "excel";
  if (["csv", "txt"].includes(extension)) return "csv";
  if (["ics", "ical"].includes(extension)) return "ics";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(extension)) return "screenshot";
  throw badRequest(
    "无法从文件名推断 sourceKind，请显式传入 excel / csv / ics / screenshot 之一",
  );
}

function contentTypeFor(kind: UploadKind, fileType: string, fileName: string): string {
  if (fileType && fileType !== "application/octet-stream") {
    if (kind !== "screenshot" || fileType.startsWith("image/")) return fileType;
  }
  switch (kind) {
    case "csv":
      return "text/csv";
    case "ics":
      return "text/calendar";
    case "excel":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "screenshot":
      return imageMime(fileName);
    default:
      return "application/octet-stream";
  }
}

function imageMime(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "image/png";
}

function safeFileName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? fallback;
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(0, 120);
  return cleaned || fallback;
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

function addWarning(warnings: string[], message: string): void {
  if (warnings.length < 40) {
    warnings.push(message);
  } else if (warnings.length === 40) {
    warnings.push("……警告过多，后续已省略");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function audit(
  c: Context<{ Bindings: Env }>,
  action: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await dbRun(
    c.env.DB,
    "insert into audit_event (id, actor_id, action, target_type, target_id, payload, actor_ip, created_at) values (?,?,?,?,?,?,?,?)",
    ulid(),
    "system",
    action,
    targetType,
    targetId,
    JSON.stringify(payload),
    c.req.header("cf-connecting-ip") ?? null,
    nowIso(),
  );
}
