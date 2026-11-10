import type {
  FreeWindow,
  FreeWindowBusyReason,
  FreeWindowEmptyReason,
  FreeWindowHeatRow,
  FreeWindowPerson,
} from "./types";

/**
 * 共同空闲时段：在接下来 N 天内找出最多人整段有空的 M 个不重叠时段。
 *
 * 做法与 LeetCode 759 Employee Free Time / 扫描线一致，只是把时间离散成 15 分钟格：
 * 从每个起点向后延伸时「整段有空的人」只会收缩，人群每变一次就产生一个候选——
 * 同一批人能一起待多久就多长（向下取整到 30 分钟，至少 60 分钟）。候选按人数↓、时长↓、开始时间↑排序后贪心取不重叠的前 M 个。
 *
 * 纯函数，不依赖运行时；Worker 负责取数，前端与测试可直接调用。
 */

export const CELL_MINUTES = 15;
export const UNIT_MINUTES = 30;
export const MIN_WINDOW_MINUTES = 60;

const MINUTE_MS = 60_000;
const CELL_MS = CELL_MINUTES * MINUTE_MS;
const UNIT_CELLS = UNIT_MINUTES / CELL_MINUTES;
const MIN_CELLS = MIN_WINDOW_MINUTES / CELL_MINUTES;
const DAY_MS = 86_400_000;

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
  offsetMinutes?: number;
}

export interface FindFreeWindowsOutput {
  windows: FreeWindow[];
  heatmap: FreeWindowHeatRow[];
  emptyReason: FreeWindowEmptyReason | null;
}

/** `HH:mm` → 分钟；允许 `24:00`。非法返回 null。 */
export function parseClock(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (Number(match[2]) > 59 || minutes > 1440) return null;
  return minutes;
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
 * 从此刻起的 N 个本地日期，按星期筛选，每天截取 [dayStart, dayEnd)；
 * 今天从此刻向上取整到 15 分钟。偏移须是 15 分钟的整数倍。
 */
export function buildDays(options: {
  now: number;
  days: number;
  dayStartMinutes: number;
  dayEndMinutes: number;
  weekdays: number[];
  offsetMinutes?: number;
}): FreeWindowDay[] {
  const offset = (options.offsetMinutes ?? 480) * MINUTE_MS;
  const allowed = new Set(options.weekdays);
  const firstMidnight = Math.floor((options.now + offset) / DAY_MS) * DAY_MS - offset;
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

interface Candidate {
  /** 全局格索引（跨天连续编号）。 */
  cell: number;
  cells: number;
  count: number;
  day: number;
}

const FREE = 0;
const BUSY = 1;
const UNKNOWN = 2;

export function findFreeWindows(params: FindFreeWindowsParams): FindFreeWindowsOutput {
  const { people, days } = params;
  const offsetMinutes = params.offsetMinutes ?? 480;
  if (days.length === 0) return { windows: [], heatmap: [], emptyReason: "no_days" };

  // 每天的格数与全局起始格。
  const dayCells = days.map((day) => Math.max(0, Math.floor((day.end - day.start) / CELL_MS)));
  const dayOffset: number[] = [];
  let totalCells = 0;
  for (const cells of dayCells) {
    dayOffset.push(totalCells);
    totalCells += cells;
  }

  // status[cell * P + person]：0 有空，1 忙，2 未知（忙优先于未知）。按格连续存放，扫描起点时访问连续。
  const P = people.length;
  const status = new Uint8Array(P * totalCells);
  const mark = (personIndex: number, interval: TimeInterval, value: number) => {
    // 天按时间升序：二分找到第一个可能重叠的天，再顺序向后。
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
      if (from >= to) continue;
      // 先标未知、再标忙，后写覆盖前写即可得到「忙优先」。
      for (let c = dayOffset[d]! + from; c < dayOffset[d]! + to; c += 1) status[c * P + personIndex] = value;
    }
  };
  people.forEach((person, index) => {
    for (const interval of params.unknown.get(person.id) ?? []) mark(index, interval, UNKNOWN);
    for (const interval of params.busy.get(person.id) ?? []) mark(index, interval, BUSY);
  });

  // 热力图计数，以及 next[c, p]：从格 c 起此人第一个不空闲的当天格（没有则为当天格数，≤ 96）。
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
  const requiredIndexes = people.flatMap((person, index) => (person.required ? [index] : []));
  const isRequired = new Uint8Array(P);
  for (const index of requiredIndexes) isRequired[index] = 1;

  const heatmap: FreeWindowHeatRow[] = days.map((day, d) => ({
    date: day.date,
    startsAt: toLocalIso(day.start, offsetMinutes),
    free: Array.from(heatFree.subarray(dayOffset[d]!, dayOffset[d]! + dayCells[d]!)),
    unknown: Array.from(heatUnknown.subarray(dayOffset[d]!, dayOffset[d]! + dayCells[d]!)),
  }));

  if (dayCells.every((cells) => cells < MIN_CELLS)) {
    return { windows: [], heatmap, emptyReason: "window_too_short" };
  }

  /**
   * 候选可能有数十万个；编码成一个数字键（人数 → 时长 → 越早越大）用 Float64Array 排序，
   * 比排序对象数组快一个数量级（Worker CPU 预算）。
   */
  const maxDayCells = Math.max(...dayCells);
  const LEN_BASE = maxDayCells + 1;
  const CELL_BASE = totalCells + 1;
  const dayOfCell = new Uint16Array(totalCells);
  dayCells.forEach((cells, d) => dayOfCell.fill(d, dayOffset[d]!, dayOffset[d]! + cells));
  const decode = (key: number): Candidate => {
    const reversed = key % CELL_BASE;
    const rest = (key - reversed) / CELL_BASE;
    const cells = rest % LEN_BASE;
    const cell = totalCells - reversed;
    return { cell, cells, count: (rest - cells) / LEN_BASE, day: dayOfCell[cell]! };
  };

  /**
   * 对每个起点 s：在 s 有空的人按「第一次不空闲的格」分桶。窗口 [s, v) 的人群
   * = next ≥ v 的人，只在有人掉出的 v 处变化；在每个变化点产生一个候选，
   * 即同一批人能一起待的最长时段。必到者全部在场时才有效。每个起点 O(人数 + 格数)。
   */
  const generate = (useRequired: boolean): number[] => {
    const out: number[] = [];
    const bucket = new Uint16Array(maxDayCells + 1);
    for (let d = 0; d < days.length; d += 1) {
      const n = dayCells[d]!;
      const o = dayOffset[d]!;
      starts: for (let s = 0; s + MIN_CELLS <= n; s += 1) {
        let count = 0;
        let limit = n;
        for (let p = 0; p < P; p += 1) {
          const index = (o + s) * P + p;
          if (status[index] !== FREE) {
            if (useRequired && isRequired[p]) {
              bucket.fill(0);
              continue starts;
            }
            continue;
          }
          const stop = next[index]!;
          bucket[stop] = bucket[stop]! + 1;
          count += 1;
          if (useRequired && isRequired[p] && stop < limit) limit = stop;
        }
        let remaining = count;
        for (let v = s + 1; v <= n && remaining > 0; v += 1) {
          const leaving = bucket[v]!;
          if (leaving === 0) continue;
          bucket[v] = 0;
          if (v <= limit) {
            const cells = Math.floor((v - s) / UNIT_CELLS) * UNIT_CELLS;
            if (cells >= MIN_CELLS) out.push((remaining * LEN_BASE + cells) * CELL_BASE + (totalCells - (o + s)));
          }
          remaining -= leaving;
        }
      }
    }
    return out;
  };

  const candidates = generate(true);
  if (candidates.length === 0) {
    const anyRequired = people.some((person) => person.required);
    const emptyReason = anyRequired && generate(false).length > 0 ? "required_unavailable" : "no_free_time";
    return { windows: [], heatmap, emptyReason };
  }

  /**
   * 贪心选取：与已选时段重叠的候选不直接丢弃，而是截到下一个已选时段之前
   * （按 30 分钟向下取整，仍 ≥ 1 小时才保留），以新键放回大顶堆继续竞争。
   * 起点落在已选时段内的候选无需处理：更晚的起点自有候选。
   */
  const keys = Float64Array.from(candidates).sort();
  const heap: number[] = [];
  const push = (key: number) => {
    let i = heap.push(key) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]! >= heap[i]!) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l]! > heap[m]!) m = l;
        if (r < heap.length && heap[r]! > heap[m]!) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  const chosen: Candidate[] = [];
  let k = keys.length - 1;
  while (chosen.length < params.count && (k >= 0 || heap.length > 0)) {
    const key = heap.length > 0 && (k < 0 || heap[0]! > keys[k]!) ? pop() : keys[k--]!;
    const candidate = decode(key);
    if (chosen.some((other) => other.cell <= candidate.cell && candidate.cell < other.cell + other.cells)) continue;
    let end = candidate.cell + candidate.cells;
    for (const other of chosen) if (other.cell > candidate.cell && other.cell < end) end = other.cell;
    if (end === candidate.cell + candidate.cells) {
      chosen.push(candidate);
      continue;
    }
    const cells = Math.floor((end - candidate.cell) / UNIT_CELLS) * UNIT_CELLS;
    if (cells >= MIN_CELLS) push((candidate.count * LEN_BASE + cells) * CELL_BASE + (totalCells - candidate.cell));
  }

  const windows = chosen.map((candidate): FreeWindow => {
    const day = days[candidate.day]!;
    const local = candidate.cell - dayOffset[candidate.day]!;
    const start = day.start + local * CELL_MS;
    const end = start + candidate.cells * CELL_MS;
    const window: FreeWindow = {
      startsAt: toLocalIso(start, offsetMinutes),
      endsAt: toLocalIso(end, offsetMinutes),
      minutes: candidate.cells * CELL_MINUTES,
      free: [],
      busy: [],
      unknown: [],
    };
    people.forEach((person, index) => {
      let state = FREE;
      for (let c = 0; c < candidate.cells; c += 1) {
        const value = status[(candidate.cell + c) * P + index]!;
        if (value === BUSY) {
          state = BUSY;
          break;
        }
        if (value === UNKNOWN) state = UNKNOWN;
      }
      if (state === FREE) window.free.push(person.id);
      else if (state === UNKNOWN) window.unknown.push(person.id);
      else {
        const hit = (params.busy.get(person.id) ?? [])
          .filter((item) => item.start < end && item.end > start)
          .sort((a, b) => a.start - b.start)[0];
        window.busy.push({ personId: person.id, reason: hit?.reason ?? "course", label: hit?.label ?? null });
      }
    });
    return window;
  });

  return { windows, heatmap, emptyReason: null };
}
