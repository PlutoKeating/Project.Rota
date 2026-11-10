import { useMemo, useState } from "react";
import type {
  FreeWindow,
  FreeWindowBusyReason,
  FreeWindowEmptyReason,
  FreeWindowsInput,
  FreeWindowsResult,
  ListResponse,
  PersonView,
} from "../../shared/types";
import { api, messageOf } from "../lib/api";
import { dateFull, hhmm, isoDate, minutesText, weekdayName, weekdayShort, WEEKDAYS } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { useOrgsState } from "../lib/resources";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Checkbox, Field, TextInput } from "./Field";
import { Modal } from "./Modal";

/** 「安排工作」侧栏的预填值。 */
export interface WorkDraft {
  orgId?: string;
  date: string;
  start: string;
  end: string;
  count: number;
}

const STORAGE_KEY = "rota:free-windows";

interface Settings {
  days: number;
  count: number;
  dayStart: string;
  dayEnd: string;
  weekdays: number[];
  bufferMinutes: number;
}

const DEFAULTS: Settings = {
  days: 7,
  count: 5,
  dayStart: "08:00",
  dayEnd: "22:00",
  weekdays: [...WEEKDAYS],
  bufferMinutes: 0,
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

const BUSY_LABELS: Record<FreeWindowBusyReason, string> = {
  course: "上课",
  leave: "请假",
  blacklist: "不可排",
  assignment: "已排班",
};

const EMPTY_LABELS: Record<FreeWindowEmptyReason, string> = {
  no_days: "所选范围内没有可用日期：检查天数与星期，或今天的窗口已过。",
  window_too_short: "每日窗口不足 1 小时（今天剩余时间也计算在内）。",
  required_unavailable: "必到人员没有共同的 1 小时空闲，取消部分必到后再试。",
  no_free_time: "没有任何人能连续空闲 1 小时；课表未导入或学期未覆盖的人计为未知。",
};

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

export function FreeWindowFinder({
  onClose,
  onArrange,
}: {
  onClose: () => void;
  onArrange: (draft: WorkDraft) => void;
}) {
  const orgs = useOrgsState();
  const persons = useAsync(() => api.get<ListResponse<PersonView>>("/persons"), []);
  const today = isoDate();

  const [orgIds, setOrgIds] = useState<string[]>([]);
  const [extra, setExtra] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [required, setRequired] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [result, setResult] = useState<FreeWindowsResult | null>(null);
  const [open, setOpen] = useState<number | null>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const all = persons.data?.items ?? [];
  const byId = useMemo(() => new Map(all.map((p) => [p.id, p])), [all]);

  // 候选 = 所选部门的有效成员 ∪ 额外添加的人；勾掉的人不参与统计。
  const roster = useMemo(() => {
    const ids = new Set<string>();
    for (const person of all) if (orgIds.some((orgId) => isActiveMember(person, orgId, today))) ids.add(person.id);
    for (const id of extra) ids.add(id);
    return [...ids].map((id) => byId.get(id)).filter((p): p is PersonView => !!p);
  }, [all, byId, orgIds, extra, today]);
  const included = roster.filter((p) => !excluded.has(p.id));

  const matches = query.trim()
    ? all
        .filter((p) => !roster.some((r) => r.id === p.id))
        .filter((p) => p.fullName.includes(query.trim()) || (p.studentNo ?? "").includes(query.trim()))
        .slice(0, 8)
    : [];

  function update(patch: Partial<Settings>): void {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveSettings(next);
      return next;
    });
  }

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  async function search(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const body: FreeWindowsInput = {
        personIds: included.map((p) => p.id),
        requiredPersonIds: included.filter((p) => required.has(p.id)).map((p) => p.id),
        days: settings.days,
        count: settings.count,
        dayStart: settings.dayStart,
        dayEnd: settings.dayEnd,
        weekdays: settings.weekdays,
        bufferMinutes: settings.bufferMinutes,
      };
      setResult(await api.post<FreeWindowsResult>("/free-windows", body));
      setOpen(0);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const names = new Map(result?.people.map((p) => [p.id, p.fullName]) ?? []);
  const nameList = (ids: string[]) => ids.map((id) => names.get(id) ?? id).join("、");

  function exportCsv(): void {
    if (!result) return;
    const rows: unknown[][] = [
      ["排名", "日期", "星期", "开始", "结束", "时长（分钟）", "有空人数", "总人数", "有空", "没空", "未知"],
      ...result.windows.map((w, i) => [
        i + 1,
        dateFull(w.startsAt),
        weekdayName(weekdayOfDate(dateFull(w.startsAt))),
        hhmm(w.startsAt),
        hhmm(w.endsAt),
        w.minutes,
        w.free.length,
        result.people.length,
        nameList(w.free),
        w.busy.map((b) => `${names.get(b.personId) ?? b.personId}（${BUSY_LABELS[b.reason]}）`).join("、"),
        nameList(w.unknown),
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
    const end = dateFull(w.endsAt) === date ? hhmm(w.endsAt) : "23:59";
    onArrange({
      orgId: orgIds.length === 1 ? orgIds[0] : undefined,
      date,
      start: hhmm(w.startsAt),
      end,
      count: Math.max(1, Math.min(300, w.free.length)),
    });
  }

  return (
    <Modal
      side
      title="找共同空闲"
      description="在接下来几天里，找出最多人整段有空、至少 1 小时的时段。"
      onClose={onClose}
      footer={
        <Button loading={busy} disabled={included.length === 0 || settings.weekdays.length === 0} onClick={() => void search()}>
          查找 {included.length} 人的共同空闲
        </Button>
      }
    >
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">参与人员</h3>
        <div className="flex flex-wrap gap-2">
          {orgs.data?.items.map((org) => (
            <Checkbox
              key={org.id}
              label={org.name}
              checked={orgIds.includes(org.id)}
              onChange={() =>
                setOrgIds((ids) => (ids.includes(org.id) ? ids.filter((id) => id !== org.id) : [...ids, org.id]))
              }
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
                  setExtra((ids) => [...ids, p.id]);
                  setQuery("");
                }}
              >
                + {p.fullName}
              </Button>
            ))}
          </div>
        )}
        {persons.error && <p role="alert" className="text-rose-600">{persons.error}</p>}
        {roster.length > 0 ? (
          <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
            {roster.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <Checkbox
                  label={p.fullName}
                  checked={!excluded.has(p.id)}
                  onChange={() => setExcluded((set) => toggle(set, p.id))}
                />
                <Button
                  size="sm"
                  variant={required.has(p.id) ? "primary" : "ghost"}
                  disabled={excluded.has(p.id)}
                  aria-pressed={required.has(p.id)}
                  onClick={() => setRequired((set) => toggle(set, p.id))}
                >
                  {required.has(p.id) ? "必到" : "设为必到"}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">选择部门或添加人员。</p>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">条件</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="接下来天数" hint="含今天剩余时间，1–28">
            <TextInput type="number" min={1} max={28} value={settings.days} onChange={(e) => update({ days: Number(e.target.value) })} />
          </Field>
          <Field label="时段个数" hint="互不重叠，1–20">
            <TextInput type="number" min={1} max={20} value={settings.count} onChange={(e) => update({ count: Number(e.target.value) })} />
          </Field>
          <Field label="前后缓冲（分钟）" hint="每段安排前后预留">
            <TextInput
              type="number"
              min={0}
              max={120}
              step={5}
              value={settings.bufferMinutes}
              onChange={(e) => update({ bufferMinutes: Number(e.target.value) })}
            />
          </Field>
          <Field label="每天从">
            <TextInput type="time" step={900} value={settings.dayStart} onChange={(e) => update({ dayStart: e.target.value })} />
          </Field>
          <Field label="到">
            <TextInput type="time" step={900} value={settings.dayEnd} onChange={(e) => update({ dayEnd: e.target.value })} />
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
        <p className="text-xs text-slate-500">
          开始时间按 15 分钟对齐，时长为 30 分钟的整数倍且至少 1 小时；先保证人数最多，再在同一批人都有空时尽量延长。
        </p>
      </section>

      {error && <p role="alert" className="text-rose-600">{error}</p>}

      {result && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              结果 · {result.people.length} 人 · {dateFull(result.rangeStart)} 至 {dateFull(result.rangeEnd)}
            </h3>
            {result.windows.length > 0 && (
              <Button size="sm" variant="secondary" onClick={exportCsv}>
                导出 CSV
              </Button>
            )}
          </div>
          {result.emptyReason ? (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
              {EMPTY_LABELS[result.emptyReason]}
            </p>
          ) : (
            <ol className="space-y-2">
              {result.windows.map((w, i) => (
                <li key={w.startsAt} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      className="text-left"
                      aria-expanded={open === i}
                      onClick={() => setOpen(open === i ? null : i)}
                    >
                      <span className="font-medium">
                        #{i + 1} {dateFull(w.startsAt)} {weekdayName(weekdayOfDate(dateFull(w.startsAt)))}{" "}
                        {hhmm(w.startsAt)}–{hhmm(w.endsAt)}
                      </span>
                      <span className="ml-2 text-sm text-slate-500">{minutesText(w.minutes)}</span>
                    </button>
                    <div className="flex items-center gap-2">
                      <Badge tone={w.free.length === result.people.length ? "success" : "info"}>
                        {w.free.length}/{result.people.length} 人有空
                      </Badge>
                      <Button size="sm" variant="secondary" onClick={() => arrange(w)}>
                        安排工作
                      </Button>
                    </div>
                  </div>
                  {open === i && (
                    <dl className="mt-3 space-y-1 text-sm">
                      <div>
                        <dt className="inline text-slate-500">有空：</dt>
                        <dd className="inline">{nameList(w.free) || "—"}</dd>
                      </div>
                      <div>
                        <dt className="inline text-slate-500">没空：</dt>
                        <dd className="inline">
                          {w.busy
                            .map(
                              (b) =>
                                `${names.get(b.personId) ?? b.personId}（${BUSY_LABELS[b.reason]}${b.label ? `·${b.label}` : ""}）`,
                            )
                            .join("、") || "—"}
                        </dd>
                      </div>
                      {w.unknown.length > 0 && (
                        <div>
                          <dt className="inline text-slate-500">未知：</dt>
                          <dd className="inline">{nameList(w.unknown)}（学期未覆盖或未导入课表）</dd>
                        </div>
                      )}
                    </dl>
                  )}
                </li>
              ))}
            </ol>
          )}
          <Heatmap result={result} />
        </section>
      )}
    </Modal>
  );
}

/** N 天 × 15 分钟的有空人数热力图（类似 When2meet），结果时段加框。 */
function Heatmap({ result }: { result: FreeWindowsResult }) {
  const total = Math.max(1, result.people.length);
  const step = result.cellMinutes * 60_000;
  const ranges = result.windows.map((w, i) => ({ i, start: Date.parse(w.startsAt), end: Date.parse(w.endsAt) }));
  if (result.heatmap.length === 0) return null;
  // 今天从此刻开始，其余天从窗口起点开始；左侧补空格让同一时刻上下对齐。
  const minuteOf = (iso: string) => {
    const [h, m] = hhmm(iso).split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const earliest = Math.min(...result.heatmap.map((row) => minuteOf(row.startsAt)));
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-slate-600 dark:text-slate-300">每 15 分钟有空人数（颜色越深人越多，框内为结果时段）</h4>
      <div className="overflow-x-auto rounded-lg border border-slate-200 p-2 dark:border-slate-700">
        <table className="border-separate border-spacing-px text-[10px]">
          <tbody>
            {result.heatmap.map((row) => {
              const first = Date.parse(row.startsAt);
              return (
                <tr key={row.date}>
                  <th scope="row" className="whitespace-nowrap pr-2 text-left font-normal text-slate-500">
                    {row.date.slice(5)} {weekdayShort(weekdayOfDate(row.date))}
                  </th>
                  {Array.from({ length: (minuteOf(row.startsAt) - earliest) / result.cellMinutes }, (_, k) => (
                    <td key={`pad-${k}`} />
                  ))}
                  {row.free.map((count, c) => {
                    const at = first + c * step;
                    const hit = ranges.find((r) => at >= r.start && at < r.end);
                    const time = hhmm(new Date(at + 8 * 3_600_000).toISOString().replace("Z", "+08:00"));
                    return (
                      <td
                        key={c}
                        title={`${row.date} ${time} · ${count}/${result.people.length} 人有空${row.unknown[c] ? `，${row.unknown[c]} 人未知` : ""}${hit ? ` · 结果 #${hit.i + 1}` : ""}`}
                        className={`h-4 w-2.5 min-w-2.5 rounded-[2px] ${hit ? "outline outline-1 outline-amber-500" : ""}`}
                        style={{ backgroundColor: `rgb(79 70 229 / ${0.08 + (0.92 * count) / total})` }}
                      />
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
