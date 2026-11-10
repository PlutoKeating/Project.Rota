import type {
  FreeWindow,
  FreeWindowBusyReason,
  FreeWindowEmptyReason,
  FreeWindowHeatRow,
  FreeWindowMode,
  FreeWindowPerson,
  MealBlock,
} from "./types";

/**
 * 给一个已知时长的活动挑时间。
 *
 * 时间离散成 15 分钟格。对每个可能的开始格 s，活动占 [s, s+D)：
 *   1. 硬条件：不碰饭点（聚餐反过来：必须覆盖饭点）；必到者整段有空；
 *      「至少 K 人」模式下到场人数 ≥ K。
 *   2. 同一天里连续可行、到场名单完全相同的开始时间合成一个「可挪动区间」，
 *      只推荐区间里最舒服的那个开始时间（聚餐最贴合饭点；前后紧挨课的人最少；整点/半点优先；越早越好）。
 *   3. 排序：全员/聚餐 → 到场人数↓、时段舒适度↑、紧挨人数↑、时间↑；
 *      至少 K 人 → 达标后先看舒适度（工作日白天优先），再看人数。
 *   4. 贪心取不重叠的前 M 个，每天最多 2 个，避免推荐都挤在同一天。
 *
 * 纯函数，不依赖运行时；Worker 负责取数，前端与测试可直接调用。
 */

export const CELL_MINUTES = 15;
export const MIN_DURATION_MINUTES = 30;
export const MAX_DURATION_MINUTES = 480;
export const MAX_PER_DAY = 2;
/** 聚餐至少要与饭点重叠的分钟数（活动更短时取活动时长）。 */
export const MEAL_OVERLAP_MINUTES = 30;

export const DEFAULT_MEAL_BLOCKS: MealBlock[] = [
  { label: "午饭", start: "12:00", end: "13:30" },
  { label: "晚饭", start: "17:30", end: "18:30" },
];

const MINUTE_MS = 60_000;
const CELL_MS = CELL_MINUTES * MINUTE_MS;
const DAY_MS = 86_400_000;
const EARLY_MINUTES = 8 * 60;
const LATE_MINUTES = 21 * 60 + 30;

export interface TimeInterval {
  start: number;
  end: number;
}

export interface BusyInterval extends TimeInterval {
  reason: FreeWindowBusyReason;
  label: string | null;
}

/** 一天的可用窗口（毫秒时间戳，start 已按 15 分钟对齐）。 */
export interface FreeWindowDay {
  date: string;
  start: number;
  end: number;
}

export interface FindFreeWindowsParams {
  people: FreeWindowPerson[];
  days: FreeWindowDay[];
  busy: Map<string, BusyInterval[]>;
  unknown: Map<string, TimeInterval[]>;
  count: number;
  durationMinutes: number;
  mode?: FreeWindowMode;
  /** 「至少 K 人」模式的 K。 */
  minAttendees?: number;
  meals?: MealBlock[];
  offsetMinutes?: number;
}

export interface FindFreeWindowsOutput {
  windows: FreeWindow[];
  heatmap: FreeWindowHeatRow[];
  emptyReason: FreeWindowEmptyReason | null;
  /** 满足其他条件时最多能到场的人数（用于「凑不够 K 人」时的提示）。 */
  bestAttendees: number;
}

/** `HH:mm` → 分钟；允许 `24:00`。非法返回 null。 */
export function parseClock(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (Number(match[2]) > 59 || minutes > 1440) return null;
  return minutes;
}

/**
 * 校验并规整饭点配置：最多 6 段，名称 1–20 字，15 分钟对齐，结束晚于开始，互不重叠。
 * 返回错误信息字符串表示不合法。
 */
export function normalizeMealBlocks(value: unknown): MealBlock[] | string {
  if (!Array.isArray(value)) return "饭点须为数组";
  if (value.length > 6) return "饭点最多 6 段";
  const result: MealBlock[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return "饭点格式无效";
    const record = item as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label.trim() : "";
    if (!label || label.length > 20) return "饭点名称须为 1–20 字";
    const start = typeof record.start === "string" ? parseClock(record.start) : null;
    const end = typeof record.end === "string" ? parseClock(record.end) : null;
    if (start === null || end === null || start % 15 !== 0 || end % 15 !== 0)
      return `「${label}」的时间须为 15 分钟对齐的 HH:mm`;
    if (end <= start) return `「${label}」的结束时间须晚于开始时间`;
    result.push({ label, start: record.start as string, end: record.end as string });
  }
  const sorted = [...result].sort((a, b) => parseClock(a.start)! - parseClock(b.start)!);
  for (let i = 1; i < sorted.length; i += 1)
    if (parseClock(sorted[i]!.start)! < parseClock(sorted[i - 1]!.end)!) return "饭点时段不能重叠";
  return sorted;
}

/** 毫秒时间戳 → 带固定偏移的本地 ISO，如 `2026-11-10T14:00:00+08:00`。 */
export function toLocalIso(ms: number, offsetMinutes = 480): string {
  const local = new Date(ms + offsetMinutes * MINUTE_MS).toISOString().slice(0, 19);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local}${sign}${hh}:${mm}`;
}

/** 本地日期的星期（1=周一…7=周日）。 */
function weekdayOf(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * 从 fromDate（默认今天）起的 N 个本地日期，按星期筛选，每天截取 [dayStart, dayEnd)；
 * 早于此刻的部分跳过（今天从此刻向上取整到 15 分钟）。偏移须是 15 分钟的整数倍。
 */
export function buildDays(options: {
  now: number;
  days: number;
  dayStartMinutes: number;
  dayEndMinutes: number;
  weekdays: number[];
  fromDate?: string;
  offsetMinutes?: number;
}): FreeWindowDay[] {
  const offset = (options.offsetMinutes ?? 480) * MINUTE_MS;
  const allowed = new Set(options.weekdays);
  const today = Math.floor((options.now + offset) / DAY_MS) * DAY_MS - offset;
  const requested = options.fromDate ? Date.parse(`${options.fromDate}T00:00:00Z`) - offset : today;
  const firstMidnight = Math.max(today, requested);
  const earliest = Math.ceil(options.now / CELL_MS) * CELL_MS;
  const result: FreeWindowDay[] = [];
  for (let i = 0; i < options.days; i += 1) {
    const midnight = firstMidnight + i * DAY_MS;
    const date = new Date(midnight + offset).toISOString().slice(0, 10);
    if (!allowed.has(weekdayOf(date))) continue;
    const start = Math.max(midnight + options.dayStartMinutes * MINUTE_MS, earliest);
    const end = midnight + options.dayEndMinutes * MINUTE_MS;
    if (end > start) result.push({ date, start, end });
  }
  return result;
}

const FREE = 0;
const BUSY = 1;
const UNKNOWN = 2;

interface Option {
  /** 当天格下标。 */
  s: number;
  attendees: number;
  comfort: number;
  tight: number;
  aligned: boolean;
  /** 聚餐：与饭点重叠越多、开始越贴近饭点越好（越小越好）；其他模式为 0。 */
  fit: number;
}

interface Group {
  day: number;
  first: number;
  last: number;
  /** 区间内按「舒适度、紧挨人数、整点、越早」排好的候选开始格。 */
  options: Option[];
}

export function findFreeWindows(params: FindFreeWindowsParams): FindFreeWindowsOutput {
  const { people, days } = params;
  const offsetMinutes = params.offsetMinutes ?? 480;
  const mode = params.mode ?? "all";
  const D = Math.max(1, Math.round(params.durationMinutes / CELL_MINUTES));
  const minAttendees = mode === "quorum" ? Math.max(1, params.minAttendees ?? 1) : 1;
  const meals = (params.meals ?? []).map((m) => ({ start: parseClock(m.start) ?? 0, end: parseClock(m.end) ?? 0 }));
  if (days.length === 0) return { windows: [], heatmap: [], emptyReason: "no_days", bestAttendees: 0 };

  // 每天的格数、全局起始格与窗口起点在当天的分钟数。
  const dayCells = days.map((day) => Math.max(0, Math.floor((day.end - day.start) / CELL_MS)));
  const dayOffset: number[] = [];
  let totalCells = 0;
  for (const cells of dayCells) {
    dayOffset.push(totalCells);
    totalCells += cells;
  }
  const dayStartMinute = days.map((day) => Math.round(((day.start + offsetMinutes * MINUTE_MS) % DAY_MS) / MINUTE_MS));
  const weekend = days.map((day) => weekdayOf(day.date) >= 6);

  // status[cell * P + person]：0 有空，1 忙，2 未知（忙优先于未知）。
  const P = people.length;
  const status = new Uint8Array(P * totalCells);
  const mark = (personIndex: number, interval: TimeInterval, value: number) => {
    let lo = 0;
    let hi = days.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid]!.end <= interval.start) lo = mid + 1;
      else hi = mid;
    }
    for (let d = lo; d < days.length && days[d]!.start < interval.end; d += 1) {
      const day = days[d]!;
      const cells = dayCells[d]!;
      const from = Math.max(0, Math.floor((interval.start - day.start) / CELL_MS));
      const to = Math.min(cells, Math.ceil((interval.end - day.start) / CELL_MS));
      for (let c = dayOffset[d]! + from; c < dayOffset[d]! + to; c += 1) status[c * P + personIndex] = value;
    }
  };
  people.forEach((person, index) => {
    for (const interval of params.unknown.get(person.id) ?? []) mark(index, interval, UNKNOWN);
    for (const interval of params.busy.get(person.id) ?? []) mark(index, interval, BUSY);
  });

  // 热力图，以及 next[c, p]：从格 c 起此人第一个不空闲的当天格（没有则为当天格数，≤ 96）。
  const heatFree = new Uint16Array(totalCells);
  const heatUnknown = new Uint16Array(totalCells);
  const next = new Uint8Array(P * totalCells);
  const stops = new Uint8Array(P);
  for (let d = 0; d < days.length; d += 1) {
    const n = dayCells[d]!;
    stops.fill(n);
    for (let c = n - 1; c >= 0; c -= 1) {
      const cell = dayOffset[d]! + c;
      let free = 0;
      let unknown = 0;
      for (let p = 0; p < P; p += 1) {
        const value = status[cell * P + p]!;
        if (value === FREE) free += 1;
        else {
          stops[p] = c;
          if (value === UNKNOWN) unknown += 1;
        }
        next[cell * P + p] = stops[p]!;
      }
      heatFree[cell] = free;
      heatUnknown[cell] = unknown;
    }
  }
  const heatmap: FreeWindowHeatRow[] = days.map((day, d) => ({
    date: day.date,
    startsAt: toLocalIso(day.start, offsetMinutes),
    free: Array.from(heatFree.subarray(dayOffset[d]!, dayOffset[d]! + dayCells[d]!)),
    unknown: Array.from(heatUnknown.subarray(dayOffset[d]!, dayOffset[d]! + dayCells[d]!)),
  }));
  if (dayCells.every((cells) => cells < D)) return { windows: [], heatmap, emptyReason: "window_too_short", bestAttendees: 0 };

  const required = people.flatMap((person, index) => (person.required ? [index] : []));
  const durationMinutes = D * CELL_MINUTES;
  const mealOk = (m0: number): boolean => {
    const m1 = m0 + durationMinutes;
    if (mode === "meal") {
      const need = Math.min(durationMinutes, MEAL_OVERLAP_MINUTES);
      return meals.some((meal) => Math.min(m1, meal.end) - Math.max(m0, meal.start) >= need);
    }
    return meals.every((meal) => m1 <= meal.start || m0 >= meal.end);
  };

  const mealFit = (m0: number): number => {
    if (mode !== "meal") return 0;
    let best = Number.POSITIVE_INFINITY;
    for (const meal of meals) {
      const overlap = Math.min(m0 + durationMinutes, meal.end) - Math.max(m0, meal.start);
      if (overlap > 0) best = Math.min(best, -overlap * 1000 + Math.abs(m0 - meal.start));
    }
    return best;
  };

  // 逐个开始格判断，连续可行且名单相同的合成一组。
  let timeValid = 0;
  let requiredValid = 0;
  let bestAttendees = 0;
  const groups: Group[] = [];
  const present = new Uint8Array(P);
  const previous = new Uint8Array(P);
  for (let d = 0; d < days.length; d += 1) {
    const n = dayCells[d]!;
    const o = dayOffset[d]!;
    let group: Group | null = null;
    for (let s = 0; s + D <= n; s += 1) {
      const m0 = dayStartMinute[d]! + s * CELL_MINUTES;
      let ok = mealOk(m0);
      if (ok) timeValid += 1;
      if (ok) {
        for (const p of required) {
          if (next[(o + s) * P + p]! < s + D) {
            ok = false;
            break;
          }
        }
        if (ok) requiredValid += 1;
      }
      let attendees = 0;
      if (ok) {
        for (let p = 0; p < P; p += 1) {
          const here = next[(o + s) * P + p]! >= s + D ? 1 : 0;
          present[p] = here;
          attendees += here;
        }
        bestAttendees = Math.max(bestAttendees, attendees);
        if (attendees < minAttendees) ok = false;
      }
      if (!ok) {
        group = null;
        continue;
      }
      // 紧挨：到场者在活动前一格或后一格有确定的安排（刚下课赶来 / 结束就要走）。
      let tight = 0;
      for (let p = 0; p < P; p += 1) {
        if (!present[p]) continue;
        if ((s > 0 && status[(o + s - 1) * P + p] === BUSY) || (s + D < n && status[(o + s + D) * P + p] === BUSY)) tight += 1;
      }
      const m1 = m0 + durationMinutes;
      const comfort = (weekend[d] ? 1 : 0) + (m0 < EARLY_MINUTES ? 1 : 0) + (m1 > LATE_MINUTES ? 1 : 0);
      const option: Option = { s, attendees, comfort, tight, aligned: m0 % 30 === 0, fit: mealFit(m0) };
      let same = group !== null && group.last === s - 1;
      if (same) {
        for (let p = 0; p < P; p += 1) {
          if (present[p] !== previous[p]) {
            same = false;
            break;
          }
        }
      }
      if (same && group) {
        group.last = s;
        group.options.push(option);
      } else {
        group = { day: d, first: s, last: s, options: [option] };
        groups.push(group);
      }
      previous.set(present);
    }
  }

  if (groups.length === 0) {
    const anyRequired = required.length > 0;
    const emptyReason: FreeWindowEmptyReason =
      timeValid === 0
        ? "meal_conflict"
        : anyRequired && requiredValid === 0
          ? "required_unavailable"
          : mode === "quorum" && bestAttendees > 0
            ? "quorum_unreachable"
            : "no_free_time";
    return { windows: [], heatmap, emptyReason, bestAttendees };
  }

  const inGroup = (a: Option, b: Option) =>
    a.comfort - b.comfort || a.fit - b.fit || a.tight - b.tight || Number(b.aligned) - Number(a.aligned) || a.s - b.s;
  for (const group of groups) group.options.sort(inGroup);
  const absolute = (g: Group) => dayOffset[g.day]! + g.options[0]!.s;
  const rank = (a: Group, b: Group): number => {
    const x = a.options[0]!;
    const y = b.options[0]!;
    if (mode === "quorum")
      return x.comfort - y.comfort || y.attendees - x.attendees || x.tight - y.tight || absolute(a) - absolute(b);
    return y.attendees - x.attendees || x.comfort - y.comfort || x.tight - y.tight || absolute(a) - absolute(b);
  };
  groups.sort(rank);

  const chosen: { group: Group; option: Option }[] = [];
  const perDay = new Map<number, number>();
  for (const group of groups) {
    if (chosen.length >= params.count) break;
    if ((perDay.get(group.day) ?? 0) >= MAX_PER_DAY) continue;
    const option = group.options.find((candidate) =>
      chosen.every(
        (other) => other.group.day !== group.day || candidate.s + D <= other.option.s || candidate.s >= other.option.s + D,
      ),
    );
    if (!option) continue;
    chosen.push({ group, option });
    perDay.set(group.day, (perDay.get(group.day) ?? 0) + 1);
  }

  const windows = chosen.map(({ group, option }): FreeWindow => {
    const day = days[group.day]!;
    const o = dayOffset[group.day]!;
    const start = day.start + option.s * CELL_MS;
    const end = start + D * CELL_MS;
    const n = dayCells[group.day]!;
    const window: FreeWindow = {
      startsAt: toLocalIso(start, offsetMinutes),
      endsAt: toLocalIso(end, offsetMinutes),
      minutes: durationMinutes,
      flexStart: toLocalIso(day.start + group.first * CELL_MS, offsetMinutes),
      flexEnd: toLocalIso(day.start + (group.last + D) * CELL_MS, offsetMinutes),
      free: [],
      busy: [],
      unknown: [],
      tight: [],
      notes: [
        ...(weekend[group.day] ? (["weekend"] as const) : []),
        ...(dayStartMinute[group.day]! + option.s * CELL_MINUTES < EARLY_MINUTES ? (["early"] as const) : []),
        ...(dayStartMinute[group.day]! + (option.s + D) * CELL_MINUTES > LATE_MINUTES ? (["late"] as const) : []),
      ],
    };
    people.forEach((person, index) => {
      if (next[(o + option.s) * P + index]! >= option.s + D) {
        window.free.push(person.id);
        const before = option.s > 0 && status[(o + option.s - 1) * P + index] === BUSY;
        const after = option.s + D < n && status[(o + option.s + D) * P + index] === BUSY;
        if (before || after) window.tight.push(person.id);
        return;
      }
      let state = FREE;
      for (let c = option.s; c < option.s + D; c += 1) {
        const value = status[(o + c) * P + index]!;
        if (value === BUSY) {
          state = BUSY;
          break;
        }
        if (value === UNKNOWN) state = UNKNOWN;
      }
      if (state === UNKNOWN) window.unknown.push(person.id);
      else {
        const hit = (params.busy.get(person.id) ?? [])
          .filter((item) => item.start < end && item.end > start)
          .sort((a, b) => a.start - b.start)[0];
        window.busy.push({ personId: person.id, reason: hit?.reason ?? "course", label: hit?.label ?? null });
      }
    });
    return window;
  });

  return { windows, heatmap, emptyReason: null, bestAttendees };
}
