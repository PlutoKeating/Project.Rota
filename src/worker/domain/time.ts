/**
 * 校历网格：周次模式展开 + 格子生成。
 *
 * 这里刻意不引入日期库：学期、周次、节次都是本地墙钟时间，亚洲/上海无夏令时，
 * 用固定偏移做 UTC 运算即可，避免 Workers 冷启动时多背一个时区数据库。
 */

export type WeekPatternKind = "all" | "odd" | "even" | "ranges";

/** "1-8,10-16,18" → [1..8, 10..16, 18]，越界与重复自动清理。 */
export function parseWeekRanges(spec: string, weekCount: number): number[] {
  const weeks = new Set<number>();
  for (const chunk of spec.split(",")) {
    const part = chunk.trim();
    if (!part) continue;
    const [fromRaw, toRaw] = part.split("-");
    const from = Number.parseInt(fromRaw ?? "", 10);
    const to = toRaw === undefined ? from : Number.parseInt(toRaw, 10);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const lo = Math.max(1, Math.min(from, to));
    const hi = Math.min(weekCount, Math.max(from, to));
    for (let w = lo; w <= hi; w += 1) weeks.add(w);
  }
  return [...weeks].sort((a, b) => a - b);
}

/**
 * 把「单双周 / 周段 / 全周」展开成具体周次。
 * odd 以第 1 周为单周，even 以第 2 周为双周——这是国内教务的通行约定。
 */
export function expandWeeks(
  kind: WeekPatternKind,
  weekRanges: string | undefined,
  weekCount: number,
): number[] {
  switch (kind) {
    case "all":
      return Array.from({ length: weekCount }, (_, i) => i + 1);
    case "odd":
      return Array.from({ length: weekCount }, (_, i) => i + 1).filter((w) => w % 2 === 1);
    case "even":
      return Array.from({ length: weekCount }, (_, i) => i + 1).filter((w) => w % 2 === 0);
    case "ranges":
      return parseWeekRanges(weekRanges ?? "", weekCount);
    default:
      return [];
  }
}

function parseIsoDate(iso: string): number {
  const [y, m, d] = iso.split("-").map((v) => Number.parseInt(v, 10));
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return toIsoDate(parseIsoDate(iso) + days * 86_400_000);
}

/** 2026-09-07 → 1（周一）。 */
export function isoWeekday(iso: string): number {
  const day = new Date(parseIsoDate(iso)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** 某日期属于学期第几周；早于开学或超出学期返回 null。 */
export function weekIndexOf(iso: string, termStartMonday: string, weekCount: number): number | null {
  const diffDays = Math.round((parseIsoDate(iso) - parseIsoDate(termStartMonday)) / 86_400_000);
  if (diffDays < 0) return null;
  const week = Math.floor(diffDays / 7) + 1;
  return week > weekCount ? null : week;
}

/** 带偏移的本地时间，如 2026-09-07T08:00:00+08:00。 */
export function localDateTime(dateIso: string, hhmm: string, offsetMinutes = 480): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${dateIso}T${hhmm}:00${offset}`;
}

export interface PeriodDef {
  periodIndex: number;
  startTime: string;
  endTime: string;
}

export interface GeneratedSlot {
  termId: string;
  weekIndex: number;
  weekday: number;
  periodIndex: number;
  startsAt: string;
  endsAt: string;
}

/**
 * 物化一整学期的格子。20 周 × 7 天 × 12 节 = 1680 行，
 * 一次生成、整学期查表，比每次请求现算重复规则便宜得多。
 */
export function generateTermSlots(input: {
  termId: string;
  startDate: string;
  weekCount: number;
  periods: PeriodDef[];
  offsetMinutes?: number;
}): GeneratedSlot[] {
  const { termId, startDate, weekCount, periods, offsetMinutes = 480 } = input;
  const slots: GeneratedSlot[] = [];
  for (let week = 1; week <= weekCount; week += 1) {
    const weekMonday = addDays(startDate, (week - 1) * 7);
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      const dateIso = addDays(weekMonday, weekday - 1);
      for (const period of periods) {
        slots.push({
          termId,
          weekIndex: week,
          weekday,
          periodIndex: period.periodIndex,
          startsAt: localDateTime(dateIso, period.startTime, offsetMinutes),
          endsAt: localDateTime(dateIso, period.endTime, offsetMinutes),
        });
      }
    }
  }
  return slots;
}

/** 一次上课覆盖的节次区间（含两端）。 */
export function periodSpan(from: number, to: number): number[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}
