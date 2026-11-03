import type { WeekPatternKind } from "../../shared/types";

/**
 * 时间/日期/时长格式化。
 *
 * 后端存的是带偏移的 ISO 字符串（如 `2026-10-07T10:00:00+08:00`），
 * 格式化时直接取字符串里的「墙钟时间」，避免浏览器时区与校区时区不一致时
 * 出现「北京时间 10 点的班显示成 2 点」。
 */

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

const WEEKDAY_NAMES: Record<number, string> = {
  1: "周一",
  2: "周二",
  3: "周三",
  4: "周四",
  5: "周五",
  6: "周六",
  7: "周日",
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

function wallClock(iso: string): { date: string; time: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(iso);
  if (!match) return null;
  return { date: match[1] ?? "", time: match[2] ?? "" };
}

/** `10:00`；无法解析时返回 `—`。 */
export function hhmm(iso: string | null | undefined): string {
  if (!iso) return "—";
  return wallClock(iso)?.time ?? "—";
}

/** `10-07`；用于紧凑列表。 */
export function dateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return date ? `${date[2]}-${date[3]}` : "—";
}

/** `2026-10-07`。 */
export function dateFull(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return date ? date[1] ?? "—" : "—";
}

/** `2026-10-07 10:00`；时间窗、审计日志用。 */
export function dateTimeText(iso: string | null | undefined): string {
  if (!iso) return "—";
  const wall = wallClock(iso);
  return wall ? `${wall.date} ${wall.time}` : dateFull(iso);
}

export function weekdayName(weekday: number | null | undefined): string {
  if (!weekday) return "—";
  return WEEKDAY_NAMES[weekday] ?? `周${weekday}`;
}

/** 表格表头用的单字：一 / 二 / … / 日。 */
export function weekdayShort(weekday: number): string {
  return weekdayName(weekday).replace("周", "");
}

/** `10:00–12:00`。 */
export function timeRange(startIso: string | null | undefined, endIso: string | null | undefined): string {
  return `${hhmm(startIso)}–${hhmm(endIso)}`;
}

/** 分钟差；任一端无效时返回 null。 */
export function durationMinutes(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 60_000));
}

/** `2 小时 30 分` / `45 分钟`。 */
export function minutesText(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return "—";
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} 分钟`;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

/** 空间紧张时的写法：`2.5h`。 */
export function hoursText(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return "—";
  const hours = Math.max(0, minutes) / 60;
  return `${hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10}h`;
}

/** 本地今天（浏览器时区）的 `YYYY-MM-DD`。 */
export function isoDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 日期加减天数，返回 `YYYY-MM-DD`。 */
export function addDays(iso: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** 学期最后一天：开学日 + 周数 × 7 − 1。 */
export function termEndDate(startDate: string, weekCount: number): string {
  return addDays(startDate, Math.max(1, weekCount) * 7 - 1);
}

/**
 * `<input type="datetime-local">` 的值转 ISO。
 * 校区固定在 +08:00（见 ARCHITECTURE.md 的时区风险），这里显式补偏移。
 */
export function fromDateTimeLocal(value: string): string {
  if (!value) return "";
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return value;
  return value.length === 16 ? `${value}:00+08:00` : value;
}

/** ISO 转 `datetime-local` 输入框的值，取墙钟时间。 */
export function toDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const wall = wallClock(iso);
  return wall ? `${wall.date}T${wall.time}` : "";
}

export function weekPatternLabel(kind: WeekPatternKind | null | undefined): string {
  switch (kind) {
    case "odd":
      return "单周";
    case "even":
      return "双周";
    case "ranges":
      return "指定周次";
    case "all":
    default:
      return "每周";
  }
}

/** `单周` / `第 1-8、10-16 周`，用于课表与任务详情。 */
export function weekPatternText(kind: WeekPatternKind | null | undefined, weekRanges?: string | null): string {
  if (kind === "ranges") {
    return weekRanges ? `第 ${weekRanges.replace(/,/g, "、")} 周` : "指定周次";
  }
  return weekPatternLabel(kind);
}

/** 两位小数的分数；用于候选卡片。 */
export function scoreText(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toFixed(2);
}
