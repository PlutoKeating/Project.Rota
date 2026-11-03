import type {
  ParsedCourse,
  ParsedMeeting,
  ParsedTimetable,
  Period,
  Term,
  WeekPatternKind,
} from "../../shared/types";
import type { Env } from "../env";
import { complete, type ChatMessage } from "../llm/gateway";
import { HttpError, parseJson } from "../lib/core";

/**
 * 截图课表识别：图片 → base64 → 强约束 JSON 提示词 → ParsedTimetable。
 *
 * 视觉模型输出不可信，这里做三件事：
 * 1. 提示词把字段、星期编号、节次编号、单双周表达写死；
 * 2. 输出允许带 markdown 代码块，解析前剥离；
 * 3. 解析失败重试一次（温度 0），仍失败抛 422，由导入任务落 failed。
 */

export interface ParseScreenshotInput {
  bytes: ArrayBuffer;
  mime: string;
  term: Term;
  periods: Period[];
}

const PATTERN_KINDS: WeekPatternKind[] = ["all", "odd", "even", "ranges"];
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export async function parseScreenshot(
  env: Env,
  input: ParseScreenshotInput,
): Promise<ParsedTimetable> {
  if (input.bytes.byteLength === 0) {
    throw new HttpError(422, "parse_failed", "图片内容为空");
  }

  const providerId = await resolveImportProviderId(env);
  const base64 = bytesToBase64(input.bytes);
  const image = { mime: normalizeImageMime(input.mime), base64 };
  let lastError = "";
  const sessionId = crypto.randomUUID();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages = buildMessages(input.term, input.periods, attempt > 0);
    try {
      const text = await complete(env, {
        providerId,
        sessionId,        messages,
        json: true,
        temperature: attempt === 0 ? 0.1 : 0,
        images: [image],
      });
      const payload = parseModelJson(text);
      if (!payload) {
        lastError = "模型输出不是合法 JSON";
        continue;
      }
      const parsed = sanitizeModelOutput(payload, input);
      const proposed = asRecord(payload)?.courses;
      if (Array.isArray(proposed) && proposed.length > 0 && parsed.courses.length === 0) {
        lastError = parsed.warnings.join("；") || "识别结果中的时段均无效";
        continue;
      }
      return parsed;
    } catch (error) {
      // 422 / 502 值得重试；配置或鉴权错误重试也没用，直接抛。
      if (error instanceof HttpError && error.status !== 422 && error.status !== 502) {
        throw error;
      }
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new HttpError(422, "parse_failed", `截图解析失败：${truncate(lastError, 300)}`);
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

function buildMessages(term: Term, periods: Period[], retry: boolean): ChatMessage[] {
  const periodLines = periods
    .slice()
    .sort((a, b) => a.periodIndex - b.periodIndex)
    .map((period) => `${period.periodIndex}: ${period.startTime}-${period.endTime}`)
    .join("；");

  const system = [
    "你是一个严谨的课表 OCR 助手。",
    "你只输出一个 JSON 对象，不输出 markdown 代码块、解释、前后缀或任何多余文字。",
    "看不清的内容宁可不输出，绝不编造。",
  ].join("");

  const user = [
    "请识别这张课表截图，并转换成下面的 JSON。",
    `学期：${term.name}，共 ${term.weekCount} 周，开学日期 ${term.startDate}。`,
    `课表节次（编号: 起止时间）：${periodLines || "未配置，按图片中的数字节次填写"}`,
    "",
    "输出结构必须严格如下：",
    '{"courses":[{"name":"课程名","teacher":"教师或null","meetings":[{"weekday":1,"periodFrom":1,"periodTo":1,"patternKind":"all","weekRanges":null,"location":"教室或null"}]}]}',
    "",
    "字段约束：",
    "- weekday 是 1-7 的整数，1=周一、2=周二、3=周三、4=周四、5=周五、6=周六、7=周日。",
    "- periodFrom / periodTo 是上面列出的节次编号（整数）；单节课必须让两者相等（例如第 1 节写 1 和 1），只有图片明确标明连续两节时才写 1 和 2；不要从示例推断节次，不要写时间。",
    "- patternKind 只能是 all、odd、even、ranges 之一。",
    "- 每周都上写 all；单周写 odd；双周写 even；指定周段写 ranges。",
    "- patternKind=ranges 时，weekRanges 写紧凑周段字符串，如 \"1-8,10-16\"；其它情况 weekRanges 为 null。",
    "- 同一门课有多个上课时间时，放在同一个 courses 元素的 meetings 数组里。",
    "- teacher、location 没有就写 null，不要写空字符串。",
    "- 不要输出学期外的时间，不要猜测看不清的课程。",
    retry ? "上一次输出无法解析或时段无效。请重新核对图片与允许的节次编号，严格区分单节和连续节次，只输出合法 JSON，不要使用 ``` 代码块。" : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function resolveImportProviderId(env: Env): Promise<string | null> {
  try {
    const raw = await env.CONFIG.get("settings");
    const settings = parseJson<{ importProviderId?: unknown }>(raw);
    const value = settings?.importProviderId;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 输出清洗
// ---------------------------------------------------------------------------

function sanitizeModelOutput(
  payload: unknown,
  input: ParseScreenshotInput,
): ParsedTimetable {
  const root = asRecord(payload);
  if (!root) throw new HttpError(422, "parse_failed", "模型输出的不是 JSON 对象");

  const rawCourses = Array.isArray(root.courses) ? root.courses : [];
  if (rawCourses.length === 0) {
    return {
      personId: null,
      personName: null,
      courses: [],
      warnings: ["模型没有识别出任何课程，请换一张更清晰的截图或手工录入"],
    };
  }

  const warnings: string[] = [];
  const periodIndexes = new Set(input.periods.map((period) => period.periodIndex));
  const courses: ParsedCourse[] = [];

  rawCourses.forEach((rawCourse, courseIndex) => {
    const course = asRecord(rawCourse);
    if (!course) return;
    const name = typeof course.name === "string" ? truncate(course.name.trim(), 200) : "";
    if (!name) {
      warnings.push(`第 ${courseIndex + 1} 门课缺少名称，已跳过`);
      return;
    }

    const teacher =
      typeof course.teacher === "string" && course.teacher.trim()
        ? truncate(course.teacher.trim(), 100)
        : null;

    const meetings: ParsedMeeting[] = [];
    const rawMeetings = Array.isArray(course.meetings) ? course.meetings : [];
    for (const rawMeeting of rawMeetings) {
      const meeting = sanitizeMeeting(rawMeeting, name, periodIndexes, warnings);
      if (meeting && !meetings.some((existing) => sameMeeting(existing, meeting))) {
        meetings.push(meeting);
      }
    }

    if (meetings.length === 0) {
      warnings.push(`课程「${name}」没有可用的上课时间，已跳过`);
      return;
    }

    const confidence =
      typeof course.confidence === "number" && Number.isFinite(course.confidence)
        ? Math.min(1, Math.max(0, course.confidence))
        : 0.6;

    courses.push({ name, teacher, meetings, confidence });
  });

  return {
    personId: null,
    personName: null,
    courses,
    warnings,
  };
}

function sanitizeMeeting(
  rawMeeting: unknown,
  courseName: string,
  periodIndexes: Set<number>,
  warnings: string[],
): ParsedMeeting | null {
  const raw = asRecord(rawMeeting);
  if (!raw) return null;

  const weekday = toInteger(raw.weekday);
  if (weekday === null || weekday < 1 || weekday > 7) {
    warnings.push(`课程「${courseName}」有一个无法识别的星期，已跳过该时段`);
    return null;
  }

  const periodFrom = toInteger(raw.periodFrom);
  const periodTo = toInteger(raw.periodTo);
  if (periodFrom === null || periodTo === null || periodFrom < 1 || periodTo < 1) {
    warnings.push(`课程「${courseName}」有一个无法识别的节次，已跳过该时段`);
    return null;
  }
  if (
    periodIndexes.size > 0 &&
    (!periodIndexes.has(periodFrom) || !periodIndexes.has(periodTo))
  ) {
    warnings.push(
      `课程「${courseName}」的节次 ${periodFrom}-${periodTo} 不在本学期配置内，已跳过该时段`,
    );
    return null;
  }

  const from = Math.min(periodFrom, periodTo);
  const to = Math.max(periodFrom, periodTo);

  const patternRaw = typeof raw.patternKind === "string" ? raw.patternKind.trim() : "";
  let patternKind: WeekPatternKind = PATTERN_KINDS.includes(patternRaw as WeekPatternKind)
    ? (patternRaw as WeekPatternKind)
    : "all";
  if (!PATTERN_KINDS.includes(patternRaw as WeekPatternKind)) {
    warnings.push(`课程「${courseName}」的 patternKind「${patternRaw}」不合法，已按全周处理`);
  }

  let weekRanges = normalizeWeekRanges(raw.weekRanges);
  if (patternKind === "odd" || patternKind === "even" || patternKind === "all") {
    weekRanges = null;
  }
  if (patternKind === "ranges" && !weekRanges) {
    warnings.push(`课程「${courseName}」缺少 weekRanges，已按全周处理`);
    patternKind = "all";
  }

  const location =
    typeof raw.location === "string" && raw.location.trim()
      ? truncate(raw.location.trim(), 200)
      : null;

  return {
    weekday,
    periodFrom: from,
    periodTo: to,
    patternKind,
    weekRanges,
    location,
  };
}

function normalizeWeekRanges(value: unknown): string | null {
  if (Array.isArray(value)) {
    const weeks = value
      .map((item) => toInteger(item))
      .filter((item): item is number => item !== null && item >= 1);
    return weeks.length > 0 ? compressWeeks(weeks) : null;
  }
  if (typeof value !== "string") return null;

  // 兼容 "第1-8周、10-16周" 这类写法，只保留数字、逗号和连字符。
  const cleaned = value
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
    .replace(/[^0-9,\-]/g, "")
    .replace(/^[,\-]+|[,\-]+$/g, "");
  return cleaned || null;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [fence ? fence[1].trim() : trimmed];

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const chunkSize = 0x2000;
  let binary = "";
  for (let offset = 0; offset < view.length; offset += chunkSize) {
    binary += String.fromCharCode(...view.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function normalizeImageMime(mime: string): string {
  const value = (mime || "").split(";")[0].trim().toLowerCase();
  return IMAGE_MIMES.includes(value) ? value : "image/png";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sameMeeting(a: ParsedMeeting, b: ParsedMeeting): boolean {
  return (
    a.weekday === b.weekday &&
    a.periodFrom === b.periodFrom &&
    a.periodTo === b.periodTo &&
    a.patternKind === b.patternKind &&
    (a.weekRanges ?? "") === (b.weekRanges ?? "") &&
    (a.location ?? "") === (b.location ?? "")
  );
}

function compressWeeks(weeks: number[]): string {
  const sorted = [...new Set(weeks)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const parts: string[] = [];
  let start = sorted[0];
  let previous = start;
  for (let index = 1; index < sorted.length; index += 1) {
    const week = sorted[index];
    if (week === previous + 1) {
      previous = week;
      continue;
    }
    parts.push(start === previous ? String(start) : `${start}-${previous}`);
    start = week;
    previous = week;
  }
  parts.push(start === previous ? String(start) : `${start}-${previous}`);
  return parts.join(",");
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
