import { useMemo, type CSSProperties, type ReactNode } from "react";
import { addDays, weekdayName } from "../lib/format";

/**
 * 「长得像课表」的周视图：横向是星期，纵向是节次（没有节次时按整点），
 * 课程、班次、推荐时段都是落在格子上的色块。人员课表、排班和找时间共用这一个组件，
 * 学生看到的永远是同一种课表样式。
 *
 * 纵轴按段线性映射：节次行等高；节次之间的课间/午休/晚饭按时长压缩显示，
 * 这样 12:00 的饭点或 19:00 的活动也有确定位置，而且整体仍像一张课表。
 */

export interface TimetableDay {
  /** `YYYY-MM-DD`；没有具体日期（如按周次展示的模板课表）时可省略。 */
  date?: string;
  /** 1=周一 … 7=周日。 */
  weekday: number;
  today?: boolean;
}

export interface TimetablePeriod {
  index: number;
  /** 当天分钟数。 */
  start: number;
  end: number;
}

export interface TimetableBlock {
  id: string;
  /** days 中的下标。 */
  day: number;
  start: number;
  end: number;
  title: string;
  detail?: string;
  /** 同一 colorKey 同色，默认按 title。 */
  colorKey?: string;
  /** 显式颜色（十六进制），优先于 colorKey。 */
  color?: string;
  variant?: "solid" | "outline";
  selected?: boolean;
  /** 屏幕阅读器与悬停提示。 */
  label?: string;
  onClick?: () => void;
}

/** 整列横贯的背景带：饭点、可挪动范围等。 */
export interface TimetableBand {
  id: string;
  /** 省略时每天都画。 */
  day?: number;
  start: number;
  end: number;
  label?: string;
  kind: "meal" | "range";
}

/** 背景浓淡（如每 15 分钟有空人数），0–1。 */
export interface TimetableShade {
  day: number;
  start: number;
  end: number;
  level: number;
  label?: string;
}

/** 课表常见配色：中等明度，白字可读；按名称散列取色，同一门课始终同色。 */
const PALETTE = [
  "#3f7fe0",
  "#cc7a12",
  "#2b93c9",
  "#d9644f",
  "#c94f86",
  "#4a8f35",
  "#0f8a78",
  "#8458cc",
  "#b8611c",
  "#5263c4",
  "#a3486b",
  "#2f8559",
];

function hashIndex(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % PALETTE.length;
}

export function colorFor(key: string): string {
  return PALETTE[hashIndex(key)]!;
}

/** 同一视图内按散列取色，撞色时顺延到下一个未用的颜色，让不同课程尽量不同色。 */
function assignColors(keys: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<number>();
  for (const key of [...new Set(keys)].sort()) {
    let index = hashIndex(key);
    for (let step = 0; step < PALETTE.length && used.has(index); step += 1) index = (index + 1) % PALETTE.length;
    used.add(index);
    result.set(key, PALETTE[index]!);
  }
  return result;
}

/** `HH:mm[:ss]` → 分钟。 */
export function clockToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** 带偏移的本地 ISO（`…T14:00:00+08:00`）→ 当天分钟；跨到次日 0 点记 1440。 */
export function isoToMinutes(iso: string, date?: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return date && match[1]! > date ? 1440 + minutes : minutes;
}

export function minutesToClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 周一起的 7 天（含今天标记）。 */
export function weekDays(monday: string, today: string): TimetableDay[] {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(monday, i);
    return { date, weekday: i + 1, today: date === today };
  });
}

/** 给定日期所在周的周一。 */
export function mondayOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

const ROW_PX = 52;
const GAP_PX_PER_MIN = 0.5;
const THIN_GAP_PX = 6;
const HOUR_ROW_PX = 48;

interface Segment {
  start: number;
  end: number;
  top: number;
  height: number;
  period?: TimetablePeriod;
  /** 非节次段：是否在顶部标注起始时刻。 */
  labelled: boolean;
}

/** 由节次和需要覆盖的时间范围生成纵轴分段。 */
export function buildAxis(periods: TimetablePeriod[], lo: number, hi: number): { segments: Segment[]; total: number } {
  const sorted = [...periods].filter((p) => p.end > p.start).sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let top = 0;
  const pushGap = (start: number, end: number) => {
    if (end <= start) return;
    const minutes = end - start;
    if (minutes < 30) {
      segments.push({ start, end, top, height: THIN_GAP_PX, labelled: false });
      top += THIN_GAP_PX;
      return;
    }
    // 长空档按整点切开，每段标注起点，便于读出 19:00 这类时刻。
    let cursor = start;
    while (cursor < end) {
      const next = Math.min(end, Math.floor(cursor / 60) * 60 + 60);
      const piece = end - next < 20 ? end : next;
      const height = Math.max(14, (piece - cursor) * GAP_PX_PER_MIN);
      segments.push({ start: cursor, end: piece, top, height, labelled: true });
      top += height;
      cursor = piece;
    }
  };
  if (sorted.length === 0) {
    const from = Math.floor(lo / 60) * 60;
    const to = Math.ceil(hi / 60) * 60;
    for (let t = from; t < to; t += 60) {
      segments.push({ start: t, end: t + 60, top, height: HOUR_ROW_PX, labelled: true });
      top += HOUR_ROW_PX;
    }
    return { segments, total: top };
  }
  const first = sorted[0]!;
  if (lo < first.start) pushGap(Math.floor(lo / 30) * 30, first.start);
  let cursor = first.start;
  for (const period of sorted) {
    if (period.start > cursor) pushGap(cursor, period.start);
    const start = Math.max(cursor, period.start);
    if (period.end <= start) continue;
    segments.push({ start, end: period.end, top, height: ROW_PX, period, labelled: false });
    top += ROW_PX;
    cursor = period.end;
  }
  if (hi > cursor) pushGap(cursor, Math.ceil(hi / 30) * 30);
  return { segments, total: top };
}

function positionOf(segments: Segment[], minutes: number): number {
  if (segments.length === 0) return 0;
  const first = segments[0]!;
  if (minutes <= first.start) return first.top;
  for (const s of segments) {
    if (minutes <= s.end) return s.top + ((minutes - s.start) / (s.end - s.start)) * s.height;
  }
  const last = segments.at(-1)!;
  return last.top + last.height;
}

/** 同一天互相重叠的色块分成并排的列（经典日历布局）。 */
function layoutLanes(blocks: TimetableBlock[]): Map<string, { lane: number; lanes: number }> {
  const result = new Map<string, { lane: number; lanes: number }>();
  const byDay = new Map<number, TimetableBlock[]>();
  for (const block of blocks) {
    const list = byDay.get(block.day) ?? [];
    list.push(block);
    byDay.set(block.day, list);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => a.start - b.start || b.end - a.end);
    let cluster: TimetableBlock[] = [];
    let laneEnds: number[] = [];
    let clusterEnd = -1;
    const flush = () => {
      for (const block of cluster) result.get(block.id)!.lanes = laneEnds.length;
      cluster = [];
      laneEnds = [];
    };
    for (const block of list) {
      if (block.start >= clusterEnd) flush();
      let lane = laneEnds.findIndex((end) => end <= block.start);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(block.end);
      } else laneEnds[lane] = block.end;
      result.set(block.id, { lane, lanes: 1 });
      cluster.push(block);
      clusterEnd = Math.max(clusterEnd, block.end);
    }
    flush();
  }
  return result;
}

const MEAL_STYLE: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, rgb(148 140 130 / 0.16) 0 6px, transparent 6px 12px)",
};

export function WeekTimetable({
  days,
  periods = [],
  blocks,
  bands = [],
  shades = [],
  range,
  toolbar,
  caption,
  footer,
}: {
  days: TimetableDay[];
  periods?: TimetablePeriod[];
  blocks: TimetableBlock[];
  bands?: TimetableBand[];
  shades?: TimetableShade[];
  /** 至少展示的时间范围（分钟），默认 08:00–21:00 与内容取并集。 */
  range?: { start: number; end: number };
  toolbar?: ReactNode;
  /** 表格的无障碍名称。 */
  caption: string;
  footer?: ReactNode;
}) {
  const { segments, total } = useMemo(() => {
    let lo = range?.start ?? 8 * 60;
    let hi = range?.end ?? 21 * 60;
    for (const item of [...blocks, ...bands]) {
      lo = Math.min(lo, item.start);
      hi = Math.max(hi, item.end);
    }
    if (periods.length) {
      // 有节次时以节次为主体，范围只在内容溢出时扩展。
      lo = Math.min(lo, ...periods.map((p) => p.start));
      hi = Math.max(hi, ...periods.map((p) => p.end));
    }
    return buildAxis(periods, lo, Math.min(hi, 1440));
  }, [periods, blocks, bands, range?.start, range?.end]);
  const lanes = useMemo(() => layoutLanes(blocks), [blocks]);
  const colors = useMemo(() => assignColors(blocks.filter((b) => !b.color).map((b) => b.colorKey ?? b.title)), [blocks]);
  const y = (minutes: number) => positionOf(segments, minutes);
  const columns = `2.75rem repeat(${days.length}, minmax(0, 1fr))`;

  return (
    <div className="space-y-3">
      {toolbar}
      <section
        aria-label={caption}
        className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="grid border-b border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/60" style={{ gridTemplateColumns: columns }}>
          <div className="py-2" aria-hidden="true" />
          {days.map((day, i) => (
            <div
              key={day.date ?? i}
              className={`min-w-0 border-l border-slate-200 px-0.5 py-1.5 text-center leading-tight dark:border-slate-700 ${
                day.today ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300" : ""
              }`}
            >
              <span className="block text-xs font-semibold sm:text-sm">
                <span className="sm:hidden">{weekdayName(day.weekday).replace("周", "")}</span>
                <span className="hidden sm:inline">{weekdayName(day.weekday)}</span>
              </span>
              {day.date && (
                <span className="block text-[10px] tabular-nums text-slate-500 sm:text-[11px] dark:text-slate-400">
                  {day.date.slice(5)}
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="grid" style={{ gridTemplateColumns: columns }}>
          <div className="relative" style={{ height: total }} aria-hidden="true">
            {segments.map((s) => (
              <div
                key={s.start}
                className={`absolute inset-x-0 overflow-hidden border-b border-slate-100 text-center leading-tight dark:border-slate-800 ${
                  s.period ? "" : "bg-slate-50/70 dark:bg-slate-800/30"
                }`}
                style={{ top: s.top, height: s.height }}
              >
                {s.period ? (
                  <div className="pt-1.5">
                    <span className="block text-xs font-medium text-slate-700 dark:text-slate-200">{s.period.index}</span>
                    <span className="block text-[9px] tabular-nums text-slate-500 sm:text-[10px] dark:text-slate-400">
                      {minutesToClock(s.period.start)}
                    </span>
                    <span className="block text-[9px] tabular-nums text-slate-500 sm:text-[10px] dark:text-slate-400">
                      {minutesToClock(s.period.end)}
                    </span>
                  </div>
                ) : s.labelled && s.height >= 14 ? (
                  <span className="block pt-0.5 text-[9px] tabular-nums text-slate-400 sm:text-[10px]">{minutesToClock(s.start)}</span>
                ) : null}
              </div>
            ))}
          </div>
          {days.map((day, d) => (
            <div
              key={day.date ?? d}
              aria-label={`${weekdayName(day.weekday)}${day.date ? ` ${day.date}` : ""}`}
              role="group"
              className={`relative min-w-0 border-l border-slate-200 dark:border-slate-700 ${day.today ? "bg-indigo-50/30 dark:bg-indigo-500/5" : ""}`}
              style={{ height: total }}
            >
              {segments.map((s) => (
                <div
                  key={s.start}
                  aria-hidden="true"
                  className={`absolute inset-x-0 border-b border-slate-100 dark:border-slate-800 ${s.period ? "" : "bg-slate-50/70 dark:bg-slate-800/30"}`}
                  style={{ top: s.top, height: s.height }}
                />
              ))}
              {shades
                .filter((s) => s.day === d)
                .map((s) => (
                  <div
                    key={`shade-${s.start}`}
                    title={s.label}
                    aria-hidden="true"
                    className="absolute inset-x-0"
                    style={{
                      top: y(s.start),
                      height: Math.max(1, y(s.end) - y(s.start)),
                      backgroundColor: `rgb(240 163 94 / ${(0.03 + 0.27 * Math.max(0, Math.min(1, s.level)) ** 2).toFixed(3)})`,
                    }}
                  />
                ))}
              {bands
                .filter((b) => b.day === undefined || b.day === d)
                .map((b) => (
                  <div
                    key={b.id}
                    aria-hidden="true"
                    className={`absolute inset-x-0 overflow-hidden ${
                      b.kind === "range"
                        ? "mx-0.5 rounded-md border border-dashed border-indigo-400 bg-indigo-50/60 dark:border-indigo-400/70 dark:bg-indigo-500/10"
                        : ""
                    }`}
                    style={{ top: y(b.start), height: Math.max(2, y(b.end) - y(b.start)), ...(b.kind === "meal" ? MEAL_STYLE : {}) }}
                  >
                    {b.label && b.kind === "meal" && (
                      <span className="block truncate px-1 pt-0.5 text-[9px] text-slate-500 sm:text-[10px] dark:text-slate-400">{b.label}</span>
                    )}
                  </div>
                ))}
              {blocks
                .filter((b) => b.day === d)
                .map((b) => {
                  const lane = lanes.get(b.id) ?? { lane: 0, lanes: 1 };
                  const top = y(b.start);
                  const height = Math.max(16, y(b.end) - top);
                  const color = b.color ?? colors.get(b.colorKey ?? b.title) ?? colorFor(b.colorKey ?? b.title);
                  const solid = (b.variant ?? "solid") === "solid";
                  const style: CSSProperties = {
                    top: top + 1,
                    height: height - 2,
                    left: `calc(${(lane.lane / lane.lanes) * 100}% + 2px)`,
                    width: `calc(${100 / lane.lanes}% - 4px)`,
                    ...(solid
                      ? { backgroundColor: color, color: "#fff" }
                      : { borderColor: color, color, backgroundColor: "var(--tt-outline-bg)" }),
                  };
                  const className = `absolute overflow-hidden rounded-md px-1 py-0.5 text-center leading-tight sm:px-1.5 ${
                    solid ? "shadow-sm" : "border-2 border-dashed"
                  } ${b.selected ? "z-10 ring-2 ring-offset-1 ring-slate-900 dark:ring-slate-100 dark:ring-offset-slate-900" : ""} ${
                    b.onClick ? "cursor-pointer transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-900" : ""
                  }`;
                  const content = (
                    <>
                      <span className="block text-[10px] font-semibold break-all sm:text-xs">{b.title}</span>
                      {b.detail && height >= 34 && (
                        <span className="mt-0.5 block text-[9px] break-all opacity-90 sm:text-[11px]">{b.detail}</span>
                      )}
                    </>
                  );
                  return b.onClick ? (
                    <button
                      key={b.id}
                      type="button"
                      title={b.label}
                      aria-label={b.label ?? b.title}
                      aria-pressed={b.selected}
                      className={className}
                      style={style}
                      onClick={b.onClick}
                    >
                      {content}
                    </button>
                  ) : (
                    <div key={b.id} title={b.label} aria-label={b.label ?? b.title} role="note" className={className} style={style}>
                      {content}
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      </section>
      {footer}
    </div>
  );
}

/** 课表上方的「‹ 第 11 周 ›」切换。 */
export function WeekNav({
  label,
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled,
  children,
}: {
  label: ReactNode;
  onPrev: () => void;
  onNext: () => void;
  prevDisabled?: boolean;
  nextDisabled?: boolean;
  children?: ReactNode;
}) {
  const arrow =
    "inline-flex h-8 w-8 items-center justify-center rounded-lg text-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800";
  return (
    <div className="flex items-center gap-1">
      <button type="button" className={arrow} aria-label="上一周" disabled={prevDisabled} onClick={onPrev}>
        ‹
      </button>
      <span className="min-w-20 text-center text-sm font-semibold tabular-nums sm:text-base">{label}</span>
      <button type="button" className={arrow} aria-label="下一周" disabled={nextDisabled} onClick={onNext}>
        ›
      </button>
      {children}
    </div>
  );
}
