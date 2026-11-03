import * as XLSX from "xlsx";
import type {
  ParsedCourse,
  ParsedMeeting,
  ParsedTimetable,
  Period,
  Slot,
  Term,
  WeekPatternKind,
} from "../../shared/types";
import { isoWeekday, parseWeekRanges, weekIndexOf } from "../domain/time";

/**
 * 课表解析：Excel / CSV / ICS → ParsedTimetable。
 *
 * 设计原则：
 * - 永远不抛异常给路由层（除非调用方 bug）。解析不出来就返回 warnings + 空课程，
 *   让任务停在 needs_review，而不是把用户上传的文件"吞掉"。
 * - Excel / CSV 表头千奇百怪，优先按表头识别，识别不到再按列序猜，
 *   并且一定在 warnings 里说明"是猜的"。
 * - ICS 用学期开学日期 + 节次时间把绝对时间映射成 (weekday, period)，RRULE 只支持
 *   FREQ=WEEKLY（含 INTERVAL / COUNT / UNTIL / BYDAY），其余频率降级为单次并告警。
 */

export interface ParseTimetableInput {
  kind: "csv" | "excel" | "ics";
  bytes: ArrayBuffer;
  fileName: string;
  term: Term;
  periods: Period[];
  slots: Slot[];
}

const DAY_MS = 86_400_000;

export function parseTimetable(input: ParseTimetableInput): ParsedTimetable {
  try {
    if (input.kind === "ics") return parseIcs(input);
    return parseWorkbook(input);
  } catch (error) {
    return emptyParsed([
      `解析失败：${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Excel / CSV
// ---------------------------------------------------------------------------

type Field = "name" | "weekday" | "periodFrom" | "periodTo" | "weeks" | "teacher" | "location";

interface ColumnMap {
  name: number;
  weekday: number;
  periodFrom: number;
  periodTo: number;
  weeks: number;
  teacher: number;
  location: number;
}

const HEADER_ALIASES: Record<Field, string[]> = {
  name: ["课程", "课程名称", "课程名", "课名", "名称", "科目", "科目名称", "course", "subject"],
  weekday: ["星期", "星期几", "周几", "上课日", "上课星期", "weekday", "day"],
  periodFrom: [
    "开始节",
    "开始节次",
    "起始节",
    "起节",
    "节次",
    "上课节次",
    "节",
    "period",
    "periodfrom",
  ],
  periodTo: ["结束节", "结束节次", "止节", "终止节", "periodto"],
  weeks: ["周次", "上课周次", "周数", "教学周", "周", "weeks", "week"],
  teacher: ["教师", "老师", "任课教师", "任课老师", "teacher"],
  location: ["地点", "教室", "上课地点", "上课教室", "location", "room"],
};

const WEEKDAY_CN: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
};

const WEEKDAY_EN: Record<string, number> = {
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 7,
  sunday: 7,
};

interface WeekPattern {
  kind: WeekPatternKind;
  ranges: string | null;
}

function parseWorkbook(input: ParseTimetableInput): ParsedTimetable {
  const warnings: string[] = [];
  const rows = readWorkbookRows(input.bytes);
  if (rows.length === 0) return emptyParsed(["工作表为空"]);

  const detected = detectHeader(rows);
  let columns: ColumnMap;
  let startRow: number;
  if (detected) {
    columns = detected.map;
    startRow = detected.rowIndex + 1;
  } else {
    columns = {
      name: 0,
      weekday: 1,
      periodFrom: 2,
      periodTo: 3,
      weeks: 4,
      teacher: 5,
      location: 6,
    };
    startRow = 0;
    addWarning(
      warnings,
      "未识别到表头，按列序猜测（第1列课程、第2列星期、第3-4列节次、第5列周次、第6列教师、第7列地点），请人工核对",
    );
  }

  const periodIndexes = new Set(input.periods.map((period) => period.periodIndex));
  const courses = new Map<string, ParsedCourse>();

  for (let rowIndex = startRow; rowIndex < rows.length; rowIndex += 1) {
    const cells = rows[rowIndex] ?? [];
    const name = cleanText(cellAt(cells, columns.name), 200);
    if (!name) continue;

    // 有些表会在数据中重复表头，只跳"精确表头"的行，避免把课程名误判成表头。
    if (
      isExactHeaderCell(name, "name") &&
      isExactHeaderCell(cellAt(cells, columns.weekday), "weekday")
    ) {
      continue;
    }

    const weekdayRaw = cellAt(cells, columns.weekday);
    const weekday = parseWeekday(weekdayRaw);
    if (weekday === null) {
      addWarning(warnings, `第 ${rowIndex + 1} 行：无法识别星期「${weekdayRaw}」，已跳过`);
      continue;
    }

    const fromRaw = cellAt(cells, columns.periodFrom);
    const toRaw = cellAt(cells, columns.periodTo);
    const span = parsePeriodSpan(fromRaw, toRaw);
    if (!span) {
      addWarning(
        warnings,
        `第 ${rowIndex + 1} 行：无法识别节次「${fromRaw || toRaw}」，已跳过`,
      );
      continue;
    }

    const weeksRaw = cellAt(cells, columns.weeks);
    const pattern = parseWeekPattern(weeksRaw, input.term.weekCount);
    if (!pattern) {
      addWarning(warnings, `第 ${rowIndex + 1} 行：无法识别周次「${weeksRaw}」，按全周处理`);
    }

    if (
      periodIndexes.size > 0 &&
      (!periodIndexes.has(span.from) || !periodIndexes.has(span.to))
    ) {
      addWarning(
        warnings,
        `第 ${rowIndex + 1} 行：节次 ${formatSpan(span.from, span.to)} 不在本学期节次配置内，请核对`,
      );
    }

    const teacher = cleanText(cellAt(cells, columns.teacher), 100) || null;
    const location = cleanText(cellAt(cells, columns.location), 200) || null;
    const meeting: ParsedMeeting = {
      weekday,
      periodFrom: span.from,
      periodTo: span.to,
      patternKind: pattern?.kind ?? "all",
      weekRanges: pattern?.ranges ?? null,
      location,
    };

    const courseKey = `${name}\u0000${teacher ?? ""}`;
    let course = courses.get(courseKey);
    if (!course) {
      course = {
        name,
        teacher,
        meetings: [],
        confidence: detected ? 0.9 : 0.55,
      };
      courses.set(courseKey, course);
    }
    if (!course.meetings.some((existing) => sameMeeting(existing, meeting))) {
      course.meetings.push(meeting);
    }
  }

  if (courses.size === 0 && warnings.length === 0) {
    warnings.push("没有解析出任何课程，请检查文件是否有表头或数据");
  }

  return {
    personId: null,
    personName: null,
    courses: [...courses.values()],
    warnings,
  };
}

function readWorkbookRows(bytes: ArrayBuffer): string[][] {
  const workbook = XLSX.read(new Uint8Array(bytes), {
    type: "array",
    codepage: 65001,
    cellDates: false,
    // CSV 里 "1-16" 会被 SheetJS 猜成日期（1/16/01），必须关掉纯文本值推断。
    raw: true,
  });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("工作簿里没有工作表");
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`工作表「${sheetName}」为空`);

  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
    raw: false,
  });
  return raw.map((row) => (Array.isArray(row) ? row.map(cellToText) : []));
}

function detectHeader(rows: string[][]): { map: ColumnMap; rowIndex: number } | null {
  const limit = Math.min(rows.length, 8);
  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const map = emptyColumnMap();
    const cells = rows[rowIndex] ?? [];
    cells.forEach((cell, columnIndex) => {
      const field = classifyHeader(cell);
      if (field && map[field] < 0) map[field] = columnIndex;
    });
    if (map.name < 0) continue;
    // 除了课程列，至少还要有一列是精确表头（"星期" / "节次" / "周次"…），
    // 否则 "课程设计,星期一,1-2,..." 这样的首行数据会被误认成表头。
    const hasExactOther =
      (map.weekday >= 0 && isExactHeaderCell(cells[map.weekday] ?? "", "weekday")) ||
      (map.periodFrom >= 0 && isExactHeaderCell(cells[map.periodFrom] ?? "", "periodFrom")) ||
      (map.weeks >= 0 && isExactHeaderCell(cells[map.weeks] ?? "", "weeks"));
    if (hasExactOther) return { map, rowIndex };
  }
  return null;
}

function emptyColumnMap(): ColumnMap {
  return {
    name: -1,
    weekday: -1,
    periodFrom: -1,
    periodTo: -1,
    weeks: -1,
    teacher: -1,
    location: -1,
  };
}

const FIELD_ORDER: Field[] = [
  "name",
  "weekday",
  "weeks",
  "periodFrom",
  "periodTo",
  "teacher",
  "location",
];

function classifyHeader(value: string): Field | null {
  const text = normalizeHeader(value);
  if (!text) return null;
  for (const field of FIELD_ORDER) {
    if (HEADER_ALIASES[field].some((alias) => normalizeHeader(alias) === text)) return field;
  }
  if (text.includes("课程") || text.includes("科目") || text.includes("课名")) return "name";
  if (text.includes("星期") || text.includes("周几") || text.includes("上课日")) return "weekday";
  if (text.includes("周次") || text.includes("周数") || text.includes("教学周")) return "weeks";
  if (text.includes("开始节") || text.includes("起节") || text.includes("节次")) return "periodFrom";
  if (text.includes("结束节") || text.includes("止节")) return "periodTo";
  if (text.includes("教师") || text.includes("老师")) return "teacher";
  if (text.includes("地点") || text.includes("教室")) return "location";
  return null;
}

function isExactHeaderCell(value: string, field: Field): boolean {
  const text = normalizeHeader(value);
  return HEADER_ALIASES[field].some((alias) => normalizeHeader(alias) === text);
}

function normalizeHeader(value: string): string {
  return value
    .replace(/[\s\u3000（）()【】[\]：:、.,，。*＊]/g, "")
    .toLowerCase();
}

function parseWeekday(raw: string): number | null {
  const text = normalizeDigits(raw).trim().toLowerCase();
  if (!text) return null;

  const cn = /(?:星期|周|礼拜)\s*([一二三四五六日天1-7])/.exec(text);
  if (cn) return WEEKDAY_CN[cn[1]] ?? null;

  const digit = /^0?([1-7])$/.exec(text);
  if (digit) return Number(digit[1]);

  const english = text.replace(/[.\s]/g, "");
  const byEnglish = WEEKDAY_EN[english];
  if (byEnglish) return byEnglish;

  return WEEKDAY_CN[text] ?? null;
}

function parsePeriodSpan(
  fromRaw: string,
  toRaw: string,
): { from: number; to: number } | null {
  const fromNumbers = numbersIn(fromRaw);
  const toNumbers = numbersIn(toRaw);
  if (fromNumbers.length === 0 && toNumbers.length === 0) return null;

  let from: number;
  let to: number;
  if (fromNumbers.length === 0) {
    from = toNumbers[0];
    to = toNumbers[0];
  } else {
    from = fromNumbers[0];
    to = fromNumbers.length >= 2 ? fromNumbers[fromNumbers.length - 1] : from;
    if (toNumbers.length > 0) to = toNumbers[toNumbers.length - 1];
  }

  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

function numbersIn(value: string): number[] {
  const matches = normalizeDigits(value).match(/\d+/g);
  if (!matches) return [];
  return matches.map((item) => Number.parseInt(item, 10)).filter(Number.isFinite);
}

/**
 * "1-16周" → ranges 1-16
 * "1-8,10-16" → ranges 1-8,10-16
 * "单周" / "双周" → odd / even
 * "1-16周(单)" → 把 1-16 里的单周展开成显式 ranges，避免 odd 误覆盖整个学期
 */
function parseWeekPattern(raw: string, weekCount: number): WeekPattern | null {
  const text = normalizeDigits(raw).replace(/\s/g, "");
  if (!text) return { kind: "all", ranges: null };

  const odd = text.includes("单");
  const even = text.includes("双");
  const rangePart = text.replace(/[^0-9,\-]/g, "");
  const weeks = rangePart ? parseWeekRanges(rangePart, weekCount) : [];

  if (weeks.length === 0) {
    if (odd) return { kind: "odd", ranges: null };
    if (even) return { kind: "even", ranges: null };
    if (/全周|每周|全部|所有/.test(text)) return { kind: "all", ranges: null };
    return null;
  }

  let selected = weeks;
  if (odd || even) {
    selected = weeks.filter((week) => (odd ? week % 2 === 1 : week % 2 === 0));
  }
  if (selected.length === 0) return null;

  if (!odd && !even && isEveryWeek(selected, weekCount)) {
    return { kind: "all", ranges: null };
  }
  if (odd && sameNumbers(selected, everyWeek(weekCount).filter((week) => week % 2 === 1))) {
    return { kind: "odd", ranges: null };
  }
  if (even && sameNumbers(selected, everyWeek(weekCount).filter((week) => week % 2 === 0))) {
    return { kind: "even", ranges: null };
  }

  return { kind: "ranges", ranges: compressWeeks(selected) };
}

// ---------------------------------------------------------------------------
// ICS
// ---------------------------------------------------------------------------

interface IcsEvent {
  index: number;
  summary: string;
  description: string;
  location: string;
  dtStart: string;
  dtEnd: string;
  rrule: string;
  exdates: Set<string>;
}

interface IcsDate {
  dateIso: string;
  /** 当天 0 点起的分钟数。 */
  minutes: number;
  hasTime: boolean;
}

interface RRule {
  freq: string;
  interval: number;
  count: number | null;
  until: string | null;
  byDay: number[];
}

interface PeriodTime {
  periodIndex: number;
  start: number;
  end: number;
}

function parseIcs(input: ParseTimetableInput): ParsedTimetable {
  const warnings: string[] = [];
  const startDate = input.term.startDate;
  if (!startDate) return emptyParsed(["学期缺少开学日期，无法把 ICS 时间映射到周次"]);

  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(
    new Uint8Array(input.bytes),
  );
  if (text.includes("\uFFFD")) {
    addWarning(warnings, "文件不是 UTF-8 编码，中文可能乱码；建议另存为 UTF-8 后再导入");
  }
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    addWarning(warnings, "文件里没有 VCALENDAR，仍尝试按 VEVENT 解析");
  }

  const events = readIcsEvents(text);
  if (events.length === 0) return emptyParsed([...warnings, "没有找到 VEVENT 事件"]);

  const periodTimes = effectivePeriods(input.periods, input.slots);
  if (periodTimes.length === 0) {
    return emptyParsed([...warnings, "本学期没有节次配置，无法把 ICS 时间映射成节次"]);
  }

  const courses = new Map<string, ParsedCourse>();

  for (const event of events) {
    const summary = cleanText(unescapeIcsText(event.summary), 200);
    if (!summary) {
      addWarning(warnings, `第 ${event.index} 个事件缺少 SUMMARY，已跳过`);
      continue;
    }

    const start = parseIcsDate(event.dtStart);
    if (!start) {
      addWarning(warnings, `${summary}：DTSTART「${event.dtStart}」无法解析，已跳过`);
      continue;
    }
    if (!start.hasTime) {
      addWarning(warnings, `${summary}：全天事件无法映射节次，已跳过`);
      continue;
    }

    const end = event.dtEnd ? parseIcsDate(event.dtEnd) : null;
    const from = mapTimeToPeriod(start.minutes, periodTimes, "start");
    const to = end?.hasTime ? mapTimeToPeriod(end.minutes, periodTimes, "end") : from;
    if (from === null || to === null) {
      addWarning(warnings, `${summary}：上课时间无法匹配到任何节次，已跳过`);
      continue;
    }

    const periodFrom = Math.min(from, to);
    const periodTo = Math.max(from, to);
    const location = cleanText(unescapeIcsText(event.location), 200) || null;
    const teacher = parseIcsTeacher(event.description);

    const expanded = expandEventDates(event, input.term);
    for (const warning of expanded.warnings) addWarning(warnings, `${summary}：${warning}`);

    const groups = new Map<string, Set<number>>();
    let outOfTerm = 0;
    for (const dateIso of expanded.dates) {
      const week = weekIndexOf(dateIso, startDate, input.term.weekCount);
      if (week === null) {
        outOfTerm += 1;
        continue;
      }
      const weekday = isoWeekday(dateIso);
      const key = `${weekday}\u0001${periodFrom}\u0001${periodTo}\u0001${location ?? ""}`;
      const bucket = groups.get(key) ?? new Set<number>();
      bucket.add(week);
      groups.set(key, bucket);
    }
    if (outOfTerm > 0) {
      addWarning(warnings, `${summary}：${outOfTerm} 次课在学期外，已忽略`);
    }
    if (groups.size === 0) {
      addWarning(warnings, `${summary}：没有落在学期内的上课时间`);
      continue;
    }

    const courseKey = `${summary}\u0000${teacher ?? ""}`;
    let course = courses.get(courseKey);
    if (!course) {
      course = { name: summary, teacher, meetings: [], confidence: 0.85 };
      courses.set(courseKey, course);
    }

    for (const [key, weeks] of groups) {
      const [weekdayRaw, fromRaw, toRaw, locRaw] = key.split("\u0001");
      const weekday = Number.parseInt(weekdayRaw ?? "", 10);
      const fromIndex = Number.parseInt(fromRaw ?? "", 10);
      const toIndex = Number.parseInt(toRaw ?? "", 10);
      if (!Number.isFinite(weekday) || !Number.isFinite(fromIndex) || !Number.isFinite(toIndex)) {
        continue;
      }
      const pattern = weeksToPattern(weeks, input.term.weekCount);
      const meeting: ParsedMeeting = {
        weekday,
        periodFrom: fromIndex,
        periodTo: toIndex,
        patternKind: pattern.patternKind,
        weekRanges: pattern.weekRanges,
        location: locRaw || null,
      };
      if (!course.meetings.some((existing) => sameMeeting(existing, meeting))) {
        course.meetings.push(meeting);
      }
    }
  }

  if (courses.size === 0 && warnings.length === 0) {
    warnings.push("没有解析出任何课程");
  }

  return {
    personId: null,
    personName: null,
    courses: [...courses.values()],
    warnings,
  };
}

function readIcsEvents(text: string): IcsEvent[] {
  const unfolded = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "");
  const events: IcsEvent[] = [];
  let current: IcsEvent | null = null;
  let index = 0;

  for (const line of unfolded.split("\n")) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:VEVENT")) {
      index += 1;
      current = {
        index,
        summary: "",
        description: "",
        location: "",
        dtStart: "",
        dtEnd: "",
        rrule: "",
        exdates: new Set<string>(),
      };
      continue;
    }
    if (upper.startsWith("END:VEVENT")) {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const property = splitIcsProperty(line);
    if (!property) continue;
    switch (property.name) {
      case "SUMMARY":
        current.summary = property.value;
        break;
      case "DESCRIPTION":
        current.description = property.value;
        break;
      case "LOCATION":
        current.location = property.value;
        break;
      case "DTSTART":
        current.dtStart = property.value;
        break;
      case "DTEND":
        current.dtEnd = property.value;
        break;
      case "RRULE":
        current.rrule = property.value;
        break;
      case "EXDATE":
        for (const value of property.value.split(",")) {
          const date = parseIcsDate(value);
          if (date) current.exdates.add(date.dateIso);
        }
        break;
      default:
        break;
    }
  }

  if (current) events.push(current);
  return events;
}

function splitIcsProperty(line: string): { name: string; value: string } | null {
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const head = line.slice(0, colon).split(";")[0] ?? "";
  return {
    name: head.trim().toUpperCase(),
    value: line.slice(colon + 1).trim(),
  };
}

/** 支持 20260907T080000 / 20260907T080000Z / 2026-09-07T08:00:00 / 20260907。 */
function parseIcsDate(value: string): IcsDate | null {
  const match =
    /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2})(?::?(\d{2}))?)?(Z)?$/i.exec(value.trim());
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hasTime = match[4] !== undefined;
  const hour = hasTime ? Number.parseInt(match[4], 10) : 0;
  const minute = hasTime ? Number.parseInt(match[5], 10) : 0;
  const second = match[6] ? Number.parseInt(match[6], 10) : 0;
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  if (match[7]) {
    // UTC 时间换算成本项目约定的 +08:00 墙钟时间（亚洲/上海无夏令时）。
    const shifted = Date.UTC(year, month - 1, day, hour, minute, second) + 8 * 60 * 60 * 1000;
    const date = new Date(shifted);
    return {
      dateIso: `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
      minutes: date.getUTCHours() * 60 + date.getUTCMinutes(),
      hasTime,
    };
  }

  return {
    dateIso: `${year}-${pad2(month)}-${pad2(day)}`,
    minutes: hour * 60 + minute,
    hasTime,
  };
}

function expandEventDates(
  event: IcsEvent,
  term: Term,
): { dates: string[]; warnings: string[] } {
  const base = parseIcsDate(event.dtStart);
  if (!base) return { dates: [], warnings: ["DTSTART 无法解析"] };
  if (!event.rrule) return { dates: [base.dateIso], warnings: [] };

  const rule = parseRRule(event.rrule);
  if (!rule) return { dates: [base.dateIso], warnings: ["RRULE 无法解析，已按单次事件处理"] };
  if (rule.freq !== "WEEKLY") {
    return {
      dates: [base.dateIso],
      warnings: [`暂不支持 FREQ=${rule.freq || "?"}，已按单次事件处理`],
    };
  }

  const startMs = dateIsoToMs(base.dateIso);
  const startWeekday = isoWeekday(base.dateIso);
  const mondayMs = startMs - (startWeekday - 1) * DAY_MS;
  const interval = Math.max(1, rule.interval);
  const byDays = rule.byDay.length > 0 ? [...new Set(rule.byDay)] : [startWeekday];
  const untilMs = rule.until ? dateIsoToMs(rule.until) : null;
  const dates: string[] = [];
  const seen = new Set<string>();
  let produced = 0;

  for (let week = 0; week <= Math.max(1, term.weekCount) + 1; week += 1) {
    if (week % interval !== 0) continue;
    for (const weekday of byDays) {
      const ms = mondayMs + week * 7 * DAY_MS + (weekday - 1) * DAY_MS;
      if (ms < startMs) continue;
      if (untilMs !== null && ms > untilMs) continue;
      const dateIso = msToIso(ms);
      if (seen.has(dateIso) || event.exdates.has(dateIso)) continue;
      seen.add(dateIso);
      dates.push(dateIso);
      produced += 1;
      if (rule.count !== null && produced >= rule.count) {
        return { dates, warnings: [] };
      }
      if (dates.length >= 500) {
        return { dates, warnings: ["事件展开超过 500 次，已截断"] };
      }
    }
  }

  return { dates, warnings: [] };
}

function parseRRule(value: string): RRule | null {
  const fields = new Map<string, string>();
  for (const part of value.split(";")) {
    const [key, ...rest] = part.split("=");
    const val = rest.join("=");
    if (key && val) fields.set(key.trim().toUpperCase(), val.trim().toUpperCase());
  }

  const freq = fields.get("FREQ") ?? "";
  if (!freq) return null;

  const intervalRaw = fields.get("INTERVAL");
  const interval = intervalRaw ? Number.parseInt(intervalRaw, 10) : 1;
  const countRaw = fields.get("COUNT");
  const count = countRaw ? Number.parseInt(countRaw, 10) : null;
  const untilRaw = fields.get("UNTIL");
  const until = untilRaw ? parseIcsDate(untilRaw)?.dateIso ?? null : null;

  const byDay: number[] = [];
  for (const token of (fields.get("BYDAY") ?? "").split(",")) {
    // 允许 "+1MO" 这类前缀，只取最后两位星期码。
    const match = /([A-Z]{2})$/.exec(token.trim());
    if (!match) continue;
    const weekday = ICS_WEEKDAYS[match[1]];
    if (weekday) byDay.push(weekday);
  }

  return {
    freq,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 1,
    count: count !== null && Number.isFinite(count) && count > 0 ? count : null,
    until,
    byDay,
  };
}

const ICS_WEEKDAYS: Record<string, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
};

function effectivePeriods(periods: Period[], slots: Slot[]): PeriodTime[] {
  const fromPeriods = periods
    .map((period) => {
      const start = toMinutes(period.startTime);
      const end = toMinutes(period.endTime);
      return start === null || end === null
        ? null
        : { periodIndex: period.periodIndex, start, end };
    })
    .filter((item): item is PeriodTime => item !== null);
  if (fromPeriods.length > 0) return fromPeriods.sort((a, b) => a.start - b.start);

  // 没传节次时退而从已物化的 slot 反推每节的起止时间。
  const byIndex = new Map<number, { start: number; end: number }>();
  for (const slot of slots) {
    const start = toMinutes(slot.startsAt);
    const end = toMinutes(slot.endsAt);
    if (start === null || end === null) continue;
    const existing = byIndex.get(slot.periodIndex);
    if (!existing) {
      byIndex.set(slot.periodIndex, { start, end });
    } else {
      existing.start = Math.min(existing.start, start);
      existing.end = Math.max(existing.end, end);
    }
  }
  return [...byIndex.entries()]
    .map(([periodIndex, time]) => ({ periodIndex, ...time }))
    .sort((a, b) => a.start - b.start);
}

function mapTimeToPeriod(
  minutes: number,
  periods: PeriodTime[],
  edge: "start" | "end",
): number | null {
  if (periods.length === 0) return null;
  const containing = periods.filter((period) => minutes >= period.start && minutes <= period.end);
  if (containing.length > 0) {
    // 跨节次边界时取最短的那一节，避免把 10:00 归到 08:00-10:00 的大节。
    return containing.sort((a, b) => a.end - a.start - (b.end - b.start))[0].periodIndex;
  }

  let best = periods[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const period of periods) {
    const anchor = edge === "end" ? period.end : period.start;
    const distance = Math.abs(minutes - anchor);
    if (distance < bestDistance) {
      best = period;
      bestDistance = distance;
    }
  }
  return best.periodIndex;
}

function weeksToPattern(
  weeks: Set<number>,
  weekCount: number,
): { patternKind: WeekPatternKind; weekRanges: string | null } {
  const sorted = [...weeks]
    .filter((week) => week >= 1 && week <= weekCount)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return { patternKind: "ranges", weekRanges: "" };
  if (isEveryWeek(sorted, weekCount)) return { patternKind: "all", weekRanges: null };
  if (sameNumbers(sorted, everyWeek(weekCount).filter((week) => week % 2 === 1))) {
    return { patternKind: "odd", weekRanges: null };
  }
  if (sameNumbers(sorted, everyWeek(weekCount).filter((week) => week % 2 === 0))) {
    return { patternKind: "even", weekRanges: null };
  }
  return { patternKind: "ranges", weekRanges: compressWeeks(sorted) };
}

// ---------------------------------------------------------------------------
// 公共小工具
// ---------------------------------------------------------------------------

function emptyParsed(warnings: string[]): ParsedTimetable {
  return { personId: null, personName: null, courses: [], warnings };
}

function cellAt(cells: string[], index: number): string {
  if (index < 0) return "";
  return (cells[index] ?? "").trim();
}

function cellToText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return cell.trim();
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  return String(cell).trim();
}

function cleanText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeDigits(value: string): string {
  return value
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
    .replace(/[－—–~～]/g, "-")
    .replace(/[，、]/g, ",");
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

function addWarning(warnings: string[], message: string): void {
  if (warnings.length < 40) {
    warnings.push(message);
  } else if (warnings.length === 40) {
    warnings.push("……警告过多，后续已省略");
  }
}

function formatSpan(from: number, to: number): string {
  return from === to ? String(from) : `${from}-${to}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function dateIsoToMs(iso: string): number {
  const [year, month, day] = iso.split("-").map((part) => Number.parseInt(part, 10));
  return Date.UTC(year, (month ?? 1) - 1, day ?? 1);
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function toMinutes(value: string): number | null {
  const match = /(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return null;
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function everyWeek(weekCount: number): number[] {
  return Array.from({ length: Math.max(0, weekCount) }, (_, index) => index + 1);
}

function isEveryWeek(weeks: number[], weekCount: number): boolean {
  return sameNumbers(weeks, everyWeek(weekCount));
}

function sameNumbers(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
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

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseIcsTeacher(description: string): string | null {
  if (!description) return null;
  const text = unescapeIcsText(description);
  const match = /(?:任课教师|教师|老师)\s*[:：]\s*([^\n;；,，]+)/.exec(text);
  const teacher = match?.[1] ? cleanText(match[1], 100) : "";
  return teacher || null;
}
