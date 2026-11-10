import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FreeWindow,
  FreeWindowBusyReason,
  FreeWindowMode,
  FreeWindowNote,
  FreeWindowsInput,
  FreeWindowsResult,
  ListResponse,
  MealBlock,
  PersonView,
} from "../../shared/types";
import { api, messageOf } from "../lib/api";
import { addDays, dateFull, hhmm, isoDate, minutesText, weekdayName, WEEKDAYS } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { useOrgsState, usePeriodsState, useTermsState } from "../lib/resources";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Checkbox, Field, TextInput } from "./Field";
import { Modal } from "./Modal";
import { Spinner } from "./Spinner";
import {
  clockToMinutes,
  isoToMinutes,
  mondayOf,
  WeekNav,
  WeekTimetable,
  weekDays,
  type TimetableBand,
  type TimetableBlock,
  type TimetableShade,
} from "./WeekTimetable";

/** 「安排工作」侧栏的预填值。 */
export interface WorkDraft {
  orgId?: string;
  date: string;
  start: string;
  end: string;
  count: number;
  /** 这个时间能到的人；创建后可直接安排。 */
  attendees?: { id: string; name: string }[];
}

const STORAGE_KEY = "rota:free-windows:v2";

type RangeKey = "thisWeek" | "nextWeek" | "twoWeeks" | "fourWeeks";

interface Settings {
  mode: FreeWindowMode;
  durationMinutes: number;
  minAttendees: number;
  range: RangeKey;
  count: number;
  dayStart: string;
  dayEnd: string;
  weekdays: number[];
  bufferMinutes: number;
  orgIds: string[];
  extra: string[];
  excluded: string[];
  required: string[];
}

const DEFAULTS: Settings = {
  mode: "all",
  durationMinutes: 60,
  minAttendees: 5,
  range: "thisWeek",
  count: 5,
  dayStart: "08:00",
  dayEnd: "22:00",
  weekdays: [...WEEKDAYS],
  bufferMinutes: 0,
  orgIds: [],
  extra: [],
  excluded: [],
  required: [],
};

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Settings> | null;
    return raw ? { ...DEFAULTS, ...raw } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 隐私窗口等场景不可写，忽略即可。
  }
}

const MODES: { id: FreeWindowMode; label: string; hint: string }[] = [
  { id: "all", label: "全员活动", hint: "到的人越多越好" },
  { id: "quorum", label: "至少几人", hint: "够人数就行，优先工作日白天" },
  { id: "meal", label: "聚餐", hint: "只在饭点附近找" },
];
const DURATIONS = [30, 60, 90, 120, 180];
const RANGES: { id: RangeKey; label: string }[] = [
  { id: "thisWeek", label: "本周" },
  { id: "nextWeek", label: "下周" },
  { id: "twoWeeks", label: "两周内" },
  { id: "fourWeeks", label: "四周内" },
];

const BUSY_LABELS: Record<FreeWindowBusyReason, string> = {
  course: "上课",
  leave: "请假",
  blacklist: "不可排",
  assignment: "已排班",
};
const NOTE_LABELS: Record<FreeWindowNote, string> = { weekend: "周末", early: "较早", late: "较晚" };

/** 范围 → 起始日期与天数（北京时间日期）。 */
function rangeOf(range: RangeKey, today: string): { fromDate: string; days: number } {
  const monday = mondayOf(today);
  switch (range) {
    case "nextWeek":
      return { fromDate: addDays(monday, 7), days: 7 };
    case "twoWeeks":
      return { fromDate: today, days: 14 };
    case "fourWeeks":
      return { fromDate: today, days: 28 };
    default:
      return { fromDate: today, days: 7 - ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) };
  }
}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const text = /^[\s]*[=+@-]/.test(raw) ? "'" + raw : raw;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function weekdayOfDate(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function isActiveMember(person: PersonView, orgId: string, today: string): boolean {
  return (
    person.status === "active" &&
    person.memberships.some(
      (m) =>
        m.orgId === orgId &&
        m.status === "active" &&
        (!m.validFrom || m.validFrom <= today) &&
        (!m.validTo || m.validTo >= today),
    )
  );
}

/** 允许清空再输入的数字框：失焦或回车时按范围收敛。 */
function NumberInput({
  value,
  min,
  max,
  step = 1,
  onCommit,
  ...rest
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (value: number) => void;
  "aria-label"?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const parsed = Number(text);
    const next = Number.isFinite(parsed) && text.trim() !== "" ? Math.min(max, Math.max(min, Math.round(parsed / step) * step)) : value;
    setText(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <TextInput
      {...rest}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={step}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-sm transition ${
        active
          ? "border-indigo-600 bg-indigo-600 text-white dark:text-slate-950"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

export function FreeWindowFinder({ onClose, onArrange }: { onClose: () => void; onArrange: (draft: WorkDraft) => void }) {
  const orgs = useOrgsState();
  const persons = useAsync(() => api.get<ListResponse<PersonView>>("/persons"), []);
  const terms = useTermsState();
  const periods = usePeriodsState(terms.current?.id ?? null);
  const meals = useAsync(() => api.get<{ items: MealBlock[] }>("/meal-blocks"), []);
  const today = isoDate();

  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [query, setQuery] = useState("");
  const [editingPeople, setEditingPeople] = useState(() => loadSettings().orgIds.length + loadSettings().extra.length === 0);
  const [result, setResult] = useState<FreeWindowsResult | null>(null);
  const [selected, setSelected] = useState(0);
  const [weekStart, setWeekStart] = useState(() => mondayOf(today));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  // 第一次使用且只有一个部门时直接选上，打开就有结果。
  useEffect(() => {
    const items = orgs.data?.items ?? [];
    if (items.length === 1 && settings.orgIds.length === 0 && settings.extra.length === 0) {
      update({ orgIds: [items[0]!.id] });
      setEditingPeople(false);
    }
    // 只在部门列表到达时判断一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgs.data]);

  function update(patch: Partial<Settings>): void {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveSettings(next);
      return next;
    });
  }

  const all = persons.data?.items ?? [];
  const byId = useMemo(() => new Map(all.map((p) => [p.id, p])), [all]);
  const excluded = useMemo(() => new Set(settings.excluded), [settings.excluded]);
  const required = useMemo(() => new Set(settings.required), [settings.required]);

  // 候选 = 所选部门的有效成员 ∪ 额外添加的人；勾掉的人不参与统计。
  const roster = useMemo(() => {
    const ids = new Set<string>();
    for (const person of all) if (settings.orgIds.some((orgId) => isActiveMember(person, orgId, today))) ids.add(person.id);
    for (const id of settings.extra) ids.add(id);
    return [...ids].map((id) => byId.get(id)).filter((p): p is PersonView => !!p);
  }, [all, byId, settings.orgIds, settings.extra, today]);
  const included = useMemo(() => roster.filter((p) => !excluded.has(p.id)), [roster, excluded]);
  const requiredCount = included.filter((p) => required.has(p.id)).length;

  const matches = query.trim()
    ? all
        .filter((p) => !roster.some((r) => r.id === p.id))
        .filter((p) => p.fullName.includes(query.trim()) || (p.studentNo ?? "").includes(query.trim()))
        .slice(0, 8)
    : [];

  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const minAttendees = Math.min(Math.max(1, settings.minAttendees), Math.max(1, included.length));

  // 条件变化后自动重新计算（去抖），过期响应直接丢弃。
  const body = useMemo<FreeWindowsInput | null>(() => {
    if (included.length === 0 || settings.weekdays.length === 0) return null;
    const { fromDate, days } = rangeOf(settings.range, today);
    return {
      personIds: included.map((p) => p.id),
      requiredPersonIds: included.filter((p) => required.has(p.id)).map((p) => p.id),
      durationMinutes: settings.durationMinutes,
      mode: settings.mode,
      ...(settings.mode === "quorum" ? { minAttendees } : {}),
      fromDate,
      days,
      count: settings.count,
      dayStart: settings.dayStart,
      dayEnd: settings.dayEnd,
      weekdays: settings.weekdays,
      bufferMinutes: settings.bufferMinutes,
    };
  }, [included, required, settings, minAttendees, today]);
  const bodyKey = body ? JSON.stringify(body) : "";
  useEffect(() => {
    if (!body) {
      setResult(null);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .post<FreeWindowsResult>("/free-windows", body)
        .then((next) => {
          if (id !== requestId.current) return;
          setResult(next);
          setError("");
          setSelected(0);
          const first = next.windows[0]?.startsAt ?? next.rangeStart;
          setWeekStart(mondayOf(dateFull(first)));
        })
        .catch((e) => {
          if (id === requestId.current) setError(messageOf(e));
        })
        .finally(() => {
          if (id === requestId.current) setLoading(false);
        });
    }, 350);
    return () => window.clearTimeout(timer);
    // bodyKey 代表 body 的内容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyKey]);

  const names = new Map(result?.people.map((p) => [p.id, p.fullName]) ?? []);
  const nameOf = (id: string) => names.get(id) ?? byId.get(id)?.fullName ?? id;
  const total = result?.people.length ?? included.length;
  const mealBlocks = result?.mealBlocks ?? meals.data?.items ?? [];
  const mealText = mealBlocks.map((m) => `${m.label} ${m.start}–${m.end}`).join("、");

  const windowLabel = (w: FreeWindow) => {
    const date = dateFull(w.startsAt);
    return `${date.slice(5)} ${weekdayName(weekdayOfDate(date))} ${hhmm(w.startsAt)}–${hhmm(w.endsAt)}`;
  };
  const missingText = (w: FreeWindow) =>
    [
      ...w.busy.map((b) => `${nameOf(b.personId)}（${BUSY_LABELS[b.reason]}${b.label ? `·${b.label}` : ""}）`),
      ...w.unknown.map((id) => `${nameOf(id)}（未导入课表）`),
    ].join("、");

  function exportCsv(): void {
    if (!result) return;
    const rows: unknown[][] = [
      ["排名", "日期", "星期", "开始", "结束", "可挪动范围", "到场人数", "总人数", "到场", "没空", "未知", "前后紧挨"],
      ...result.windows.map((w, i) => [
        i + 1,
        dateFull(w.startsAt),
        weekdayName(weekdayOfDate(dateFull(w.startsAt))),
        hhmm(w.startsAt),
        hhmm(w.endsAt),
        `${hhmm(w.flexStart)}–${hhmm(w.flexEnd)}`,
        w.free.length,
        result.people.length,
        w.free.map(nameOf).join("、"),
        w.busy.map((b) => `${nameOf(b.personId)}（${BUSY_LABELS[b.reason]}）`).join("、"),
        w.unknown.map(nameOf).join("、"),
        w.tight.map(nameOf).join("、"),
      ]),
    ];
    const text = "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `rota-free-windows-${today}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function arrange(w: FreeWindow): void {
    const date = dateFull(w.startsAt);
    onArrange({
      orgId: settings.orgIds.length === 1 ? settings.orgIds[0] : undefined,
      date,
      start: hhmm(w.startsAt),
      end: dateFull(w.endsAt) === date ? hhmm(w.endsAt) : "23:59",
      count: Math.max(1, Math.min(300, w.free.length)),
      attendees: w.free.map((id) => ({ id, name: nameOf(id) })),
    });
  }

  // 课表视图：当前周的推荐、饭点、可挪动范围与有空人数深浅。
  const days = weekDays(weekStart, today);
  const dayIndex = new Map(days.map((d, i) => [d.date!, i]));
  const firstWeek = result ? mondayOf(dateFull(result.rangeStart)) : weekStart;
  const lastWeek = result ? mondayOf(dateFull(result.rangeEnd)) : weekStart;
  const current = result?.windows[selected] ?? null;
  const blocks: TimetableBlock[] = (result?.windows ?? []).flatMap((w, i) => {
    const day = dayIndex.get(dateFull(w.startsAt));
    if (day === undefined) return [];
    return [
      {
        id: `w${i}`,
        day,
        start: isoToMinutes(w.startsAt),
        end: isoToMinutes(w.endsAt, dateFull(w.startsAt)),
        title: `#${i + 1}`,
        detail: `${w.free.length}/${total} 人`,
        color: "#b85c21",
        selected: i === selected,
        label: `推荐 #${i + 1}：${windowLabel(w)}，${w.free.length}/${total} 人可到`,
        onClick: () => setSelected(i),
      },
    ];
  });
  const bands: TimetableBand[] = mealBlocks.map((m, i) => ({
    id: `meal${i}`,
    start: clockToMinutes(m.start),
    end: clockToMinutes(m.end),
    label: m.label,
    kind: "meal",
  }));
  if (current) {
    const day = dayIndex.get(dateFull(current.startsAt));
    if (day !== undefined && (current.flexStart !== current.startsAt || current.flexEnd !== current.endsAt))
      bands.push({
        id: "flex",
        day,
        start: isoToMinutes(current.flexStart),
        end: isoToMinutes(current.flexEnd, dateFull(current.flexStart)),
        kind: "range",
      });
  }
  const shades: TimetableShade[] = [];
  for (const row of result?.heatmap ?? []) {
    const day = dayIndex.get(row.date);
    if (day === undefined) continue;
    const first = isoToMinutes(row.startsAt);
    row.free.forEach((count, c) => {
      const start = first + c * result!.cellMinutes;
      shades.push({
        day,
        start,
        end: start + result!.cellMinutes,
        level: count / Math.max(1, total),
        label: `${count}/${total} 人有空${row.unknown[c] ? `，${row.unknown[c]} 人未知` : ""}`,
      });
    });
  }
  const axisPeriods = (periods.data?.items ?? []).map((p) => ({
    index: p.periodIndex,
    start: clockToMinutes(p.startTime),
    end: clockToMinutes(p.endTime),
  }));

  // 有学期时用「第 N 周」，与学生课表一致；否则显示这周周一的日期。
  const termWeekLabel = (monday: string): string => {
    const start = terms.current?.startDate;
    if (start) {
      const week = Math.floor((Date.parse(monday) - Date.parse(mondayOf(start))) / (7 * 86_400_000)) + 1;
      if (week >= 1 && week <= (terms.current?.weekCount ?? 0)) return `第 ${week} 周`;
    }
    return `${monday.slice(5)} 起`;
  };

  const emptyText = (r: FreeWindowsResult): string => {
    switch (r.emptyReason) {
      case "no_days":
        return "所选范围内没有可用日期：检查星期，或今天剩余时间已过。";
      case "window_too_short":
        return "每天的时间范围短于活动时长。";
      case "meal_conflict":
        return r.mode === "meal"
          ? "每天的时间范围没有覆盖饭点，放宽「每天从/到」后再试。"
          : "扣除饭点后，每天的时间范围里放不下这么长的活动。";
      case "required_unavailable":
        return "必到人员凑不出共同空闲，取消部分必到后再试。";
      case "quorum_unreachable":
        return `这段时间最多只能凑到 ${r.bestAttendees} 人。`;
      default:
        return "没有人能整段空出来；课表未导入或学期未覆盖的人计为未知。";
    }
  };

  return (
    <Modal side title="找时间" description="选好活动类型和时长，自动给出最合适的时间。" onClose={onClose}>
      <section className="space-y-3" aria-label="活动">
        <div className="flex flex-wrap gap-2" role="group" aria-label="活动类型">
          {MODES.map((m) => (
            <Chip key={m.id} active={settings.mode === m.id} title={m.hint} onClick={() => update({ mode: m.id })}>
              {m.label}
            </Chip>
          ))}
        </div>
        {settings.mode === "quorum" && (
          <div className="flex items-center gap-2 text-sm">
            <span>至少</span>
            <div className="w-20">
              <NumberInput
                aria-label="至少到场人数"
                value={minAttendees}
                min={1}
                max={Math.max(1, included.length)}
                onCommit={(v) => update({ minAttendees: v })}
              />
            </div>
            <span className="text-slate-500">人到场（共 {included.length} 人）</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="活动时长">
          <span className="w-10 text-xs text-slate-500">时长</span>
          {DURATIONS.map((d) => (
            <Chip key={d} active={settings.durationMinutes === d} onClick={() => update({ durationMinutes: d })}>
              {minutesText(d).replace(" 小时 30 分", ".5 小时")}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="时间范围">
          <span className="w-10 text-xs text-slate-500">范围</span>
          {RANGES.map((r) => (
            <Chip key={r.id} active={settings.range === r.id} onClick={() => update({ range: r.id })}>
              {r.label}
            </Chip>
          ))}
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700" aria-label="参与人员">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-sm">
            <span className="font-medium">
              {settings.orgIds
                .map((id) => orgs.data?.items.find((o) => o.id === id)?.name)
                .filter(Boolean)
                .join("、") || (included.length ? "手动选择" : "还没有选人")}
            </span>
            <span className="text-slate-500">
              {" "}
              · {included.length} 人{requiredCount ? ` · 必到 ${requiredCount}` : ""}
            </span>
          </p>
          <Button size="sm" variant="secondary" aria-expanded={editingPeople} onClick={() => setEditingPeople(!editingPeople)}>
            {editingPeople ? "收起" : "选择人员"}
          </Button>
        </div>
        {editingPeople && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {orgs.data?.items.map((org) => (
                <Checkbox
                  key={org.id}
                  label={org.name}
                  checked={settings.orgIds.includes(org.id)}
                  onChange={() => update({ orgIds: toggleIn(settings.orgIds, org.id) })}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 dark:border-slate-700"
                />
              ))}
            </div>
            <Field label="添加其他人员" hint="按姓名或学号搜索">
              <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="例如：张三" />
            </Field>
            {matches.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {matches.map((p) => (
                  <Button
                    key={p.id}
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      update({ extra: [...settings.extra, p.id] });
                      setQuery("");
                    }}
                  >
                    + {p.fullName}
                  </Button>
                ))}
              </div>
            )}
            {persons.error && <p role="alert" className="text-rose-600">{persons.error}</p>}
            {roster.length > 0 && (
              <>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Button size="sm" variant="ghost" onClick={() => update({ required: included.map((p) => p.id) })}>
                    全部设为必到
                  </Button>
                  <Button size="sm" variant="ghost" disabled={requiredCount === 0} onClick={() => update({ required: [] })}>
                    清除必到
                  </Button>
                </div>
                <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                  {roster.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                      <Checkbox
                        label={p.fullName}
                        checked={!excluded.has(p.id)}
                        onChange={() => update({ excluded: toggleIn(settings.excluded, p.id) })}
                      />
                      <Button
                        size="sm"
                        variant={required.has(p.id) ? "primary" : "ghost"}
                        disabled={excluded.has(p.id)}
                        aria-pressed={required.has(p.id)}
                        onClick={() => update({ required: toggleIn(settings.required, p.id) })}
                      >
                        {required.has(p.id) ? "必到" : "设为必到"}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </section>

      <details className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-700">
        <summary className="cursor-pointer text-slate-600 dark:text-slate-300">
          更多条件 · 每天 {settings.dayStart}–{settings.dayEnd}
          {settings.weekdays.length < 7 ? ` · ${settings.weekdays.map((d) => weekdayName(d).replace("周", "")).join("")}` : ""}
          {settings.bufferMinutes ? ` · 缓冲 ${settings.bufferMinutes} 分钟` : ""}
          {mealText ? ` · ${settings.mode === "meal" ? "围绕" : "避开"}${mealText}` : ""}
        </summary>
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="每天从">
              <TextInput type="time" step={900} value={settings.dayStart} onChange={(e) => e.target.value && update({ dayStart: e.target.value })} />
            </Field>
            <Field label="到">
              <TextInput type="time" step={900} value={settings.dayEnd} onChange={(e) => e.target.value && update({ dayEnd: e.target.value })} />
            </Field>
            <Field label="前后缓冲（分钟）" hint="课前课后留出路上时间">
              <NumberInput value={settings.bufferMinutes} min={0} max={120} step={5} onCommit={(v) => update({ bufferMinutes: v })} />
            </Field>
            <Field label="推荐个数" hint="每天最多 2 个">
              <NumberInput value={settings.count} min={1} max={20} onCommit={(v) => update({ count: v })} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-3">
            {WEEKDAYS.map((d) => (
              <Checkbox
                key={d}
                label={weekdayName(d)}
                checked={settings.weekdays.includes(d)}
                onChange={() =>
                  update({
                    weekdays: settings.weekdays.includes(d)
                      ? settings.weekdays.filter((x) => x !== d)
                      : [...settings.weekdays, d].sort((a, b) => a - b),
                  })
                }
              />
            ))}
          </div>
          <p className="text-xs text-slate-500">饭点由「管理 → 规则」统一配置。课表里的斜纹为饭点，橙色深浅表示每 15 分钟有空的人数。</p>
        </div>
      </details>

      <section className="space-y-3" aria-label="推荐结果" aria-busy={loading}>
        {!body ? (
          <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            {included.length === 0 ? "先选择部门或人员，结果会自动出现在这里。" : "至少勾选一个星期。"}
          </p>
        ) : error ? (
          <p role="alert" className="text-rose-600">{error}</p>
        ) : !result ? (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner size="sm" /> 正在找时间…
          </p>
        ) : result.emptyReason ? (
          <div className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
            <p>{emptyText(result)}</p>
            {result.emptyReason === "quorum_unreachable" && result.bestAttendees > 0 && (
              <Button size="sm" variant="secondary" onClick={() => update({ minAttendees: result.bestAttendees })}>
                改为至少 {result.bestAttendees} 人
              </Button>
            )}
          </div>
        ) : (
          current && (
            <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
              <article className="space-y-2 rounded-xl border-2 border-indigo-600 bg-indigo-50/50 p-3 dark:bg-indigo-500/10">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-xs text-indigo-700 dark:text-indigo-300">推荐 #{selected + 1}</p>
                    <p className="text-lg font-semibold tabular-nums">{windowLabel(current)}</p>
                    {(current.flexStart !== current.startsAt || current.flexEnd !== current.endsAt) && (
                      <p className="text-xs text-slate-600 dark:text-slate-300">
                        同一批人可在 {hhmm(current.flexStart)}–{hhmm(current.flexEnd)} 内挪动
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={current.free.length === total ? "success" : "info"}>
                      {current.free.length === total ? `全员 ${total} 人可到` : `${current.free.length}/${total} 人可到`}
                    </Badge>
                    {current.notes.map((n) => (
                      <Badge key={n} tone="warning">
                        {NOTE_LABELS[n]}
                      </Badge>
                    ))}
                  </div>
                </div>
                {missingText(current) && (
                  <p className="text-sm">
                    <span className="text-slate-500">缺：</span>
                    {missingText(current)}
                  </p>
                )}
                {current.tight.length > 0 && (
                  <p className="text-xs text-slate-500">前后紧挨其他安排：{current.tight.map(nameOf).join("、")}</p>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button onClick={() => arrange(current)}>用这个时间安排</Button>
                  <Button variant="ghost" size="sm" onClick={exportCsv}>
                    导出 CSV
                  </Button>
                </div>
              </article>
              {result.windows.length > 1 && (
                <ol className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                  {result.windows.map((w, i) =>
                    i === selected ? null : (
                      <li key={w.startsAt}>
                        <button
                          type="button"
                          className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
                          onClick={() => {
                            setSelected(i);
                            setWeekStart(mondayOf(dateFull(w.startsAt)));
                          }}
                        >
                          <span className="text-sm tabular-nums">
                            <span className="text-slate-500">#{i + 1}</span> {windowLabel(w)}
                          </span>
                          <span className="min-w-0 text-xs text-slate-500">
                            {w.free.length}/{total} 人
                            {w.busy.length + w.unknown.length > 0 && ` · 缺 ${[...w.busy.map((b) => b.personId), ...w.unknown].map(nameOf).slice(0, 3).join("、")}${w.busy.length + w.unknown.length > 3 ? " 等" : ""}`}
                          </span>
                        </button>
                      </li>
                    ),
                  )}
                </ol>
              )}
            </div>
          )
        )}

        {result && result.heatmap.length > 0 && (
          <WeekTimetable
            caption="找时间课表"
            days={days}
            periods={axisPeriods}
            blocks={blocks}
            bands={bands}
            shades={shades}
            range={{ start: clockToMinutes(settings.dayStart), end: Math.min(1440, clockToMinutes(settings.dayEnd)) }}
            toolbar={
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-slate-500">橙色越深人越多 · 斜纹为饭点 · 点色块查看</p>
                <WeekNav
                  label={termWeekLabel(weekStart)}
                  prevDisabled={weekStart <= firstWeek}
                  nextDisabled={weekStart >= lastWeek}
                  onPrev={() => setWeekStart(addDays(weekStart, -7))}
                  onNext={() => setWeekStart(addDays(weekStart, 7))}
                />
              </div>
            }
          />
        )}
      </section>
    </Modal>
  );
}
