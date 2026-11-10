import { WorkComposer } from "../components/WorkComposer";
import { FreeWindowFinder, type WorkDraft } from "../components/FreeWindowFinder";
import { FairnessPage } from "./FairnessPage";
import { TasksPage } from "./TasksPage";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CandidateView,
  ExcludedView,
  ListResponse,
  MealBlock,
  PreviewResult,
  ShiftView,
} from "../../shared/types";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Field, Select, TextInput } from "../components/Field";
import { ListState } from "../components/ListState";
import { Modal } from "../components/Modal";
import { ScoreBar } from "../components/ScoreBar";
import { Spinner } from "../components/Spinner";
import { useToast } from "../components/Toast";
import { api, messageOf } from "../lib/api";
import {
  addDays,
  dateFull,
  durationMinutes,
  isoDate,
  minutesText,
  timeRange,
} from "../lib/format";
import { useAsync } from "../lib/hooks";
import {
  exclusionLabel,
  shiftStatusLabel,
  shiftStatusTone,
} from "../lib/labels";
import { useOrgsState, usePeriodsState, useTermsState } from "../lib/resources";
import {
  clockToMinutes,
  isoToMinutes,
  WeekTimetable,
  type TimetableBlock,
  type TimetableDay,
} from "../components/WeekTimetable";

interface ShiftGroup {
  taskId: string;
  taskTitle: string;
  shifts: ShiftView[];
}

function summarizeResult(result: unknown): string {
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    const assigned = record.assigned ?? record.assignedCount ?? record.count;
    if (typeof assigned === "number")
      return `已安排 ${assigned} 人次，仍缺 ${record.skipped ?? 0} 席位`;
    if (typeof record.message === "string") return record.message;
  }
  return "自动排班已完成";
}

interface PreviewModalProps {
  shift: ShiftView;
  onClose: () => void;
  onAssigned: () => void;
}

function PreviewModal({ shift, onClose, onAssigned }: PreviewModalProps) {
  const toast = useToast();
  const [data, setData] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"auto" | "selected" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.post<PreviewResult>(
        `/shifts/${encodeURIComponent(shift.id)}/preview`,
        {},
      );
      setData(result);
      setSelectedId(result.candidates[0]?.personId ?? null);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [shift.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const candidates = useMemo(
    () => [...(data?.candidates ?? [])].sort((a, b) => b.score - a.score),
    [data],
  );
  const excluded = data?.excluded ?? [];

  async function assign(personId: string | null): Promise<void> {
    setBusy(personId ? "selected" : "auto");
    try {
      await api.post(
        `/shifts/${encodeURIComponent(shift.id)}/assign`,
        personId ? { personId } : {},
      );
      toast.success(personId ? "已分配给选中的候选" : "已自动选最高分分配");
      onAssigned();
      await load();
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      side
      title="班次与候选"
      description={`${shift.taskTitle} · ${dateFull(shift.startsAt)} ${timeRange(shift.startsAt, shift.endsAt)}`}
      size="xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
          <Button
            variant="secondary"
            loading={busy === "auto"}
            disabled={candidates.length === 0 || busy !== null}
            onClick={() => void assign(null)}
          >
            自动选最高分
          </Button>
          <Button
            loading={busy === "selected"}
            disabled={!selectedId || candidates.length === 0 || busy !== null}
            onClick={() => selectedId && void assign(selectedId)}
          >
            确认分配
          </Button>
        </>
      }
    >
      {(shift.assignments?.length ?? 0) > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold">已安排人员</h3>
          {shift.assignments?.map((a) => (
            <div
              key={a.id}
              className="flex justify-between border-b border-slate-200 py-2"
            >
              <span>{a.personName}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={async () => {
                  if (!confirm(`撤销 ${a.personName} 的本次分配？`)) return;
                  setBusy("selected");
                  try {
                    await api.del(`/assignments/${a.id}`);
                    onAssigned();
                    await load();
                  } catch (e) {
                    toast.error(messageOf(e));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                撤销分配
              </Button>
            </div>
          ))}
        </section>
      )}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
          <Spinner size="sm" />
          正在计算候选…
        </div>
      ) : error ? (
        <ListState
          loading={false}
          error={error}
          empty={false}
          onRetry={() => void load()}
        >
          <div />
        </ListState>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
            <Badge tone="info">{`候选 ${candidates.length} 人`}</Badge>
            <Badge
              tone={excluded.length > 0 ? "warning" : "neutral"}
            >{`排除 ${excluded.length} 人`}</Badge>
            <span>冷却 {data?.cooldownDays ?? 0} 天</span>
            {data?.appliedWeights ? (
              <span className="font-mono">
                权重 公平 {data.appliedWeights.fairness} / 饥饿{" "}
                {data.appliedWeights.starvation} / 偏好{" "}
                {data.appliedWeights.preference} / 优先级{" "}
                {data.appliedWeights.priority} / 连排{" "}
                {data.appliedWeights.recency}
              </span>
            ) : null}
          </div>

          {candidates.length === 0 ? (
            <EmptyState
              title="没有可用候选"
              description="所有人都被硬过滤排除了；先看看下面的排除原因，或调整冷却天数/权重。"
            />
          ) : (
            <ul className="space-y-2">
              {candidates.map((candidate: CandidateView) => {
                const active = selectedId === candidate.personId;
                return (
                  <li key={candidate.personId}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(candidate.personId)}
                      aria-pressed={active}
                      className={
                        active
                          ? "w-full rounded-xl border-2 border-indigo-500 bg-indigo-50/60 p-3 text-left dark:border-indigo-400 dark:bg-indigo-500/10"
                          : "w-full rounded-xl border border-slate-200 p-3 text-left transition hover:border-indigo-300 dark:border-slate-700 dark:hover:border-indigo-500/40"
                      }
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">
                            {candidate.fullName}
                          </p>
                          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                            已排 {candidate.assignedCount} 次 · 空闲{" "}
                            {minutesText(candidate.freeMinutes)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-lg leading-none font-semibold tabular-nums text-indigo-600 dark:text-indigo-400">
                            {Number.isFinite(candidate.score)
                              ? candidate.score.toFixed(2)
                              : "—"}
                          </p>
                          <p className="text-[10px] text-slate-400">总分</p>
                        </div>
                      </div>
                      <div className="mt-2 space-y-1">
                        <ScoreBar
                          label="公平"
                          value={candidate.breakdown?.fairness ?? 0}
                        />
                        <ScoreBar
                          label="饥饿"
                          value={candidate.breakdown?.starvation ?? 0}
                        />
                        <ScoreBar
                          label="偏好"
                          value={candidate.breakdown?.preference ?? 0}
                        />
                        <ScoreBar
                          label="优先级"
                          value={candidate.breakdown?.priority ?? 0}
                        />
                        <ScoreBar
                          label="连排"
                          value={candidate.breakdown?.recency ?? 0}
                        />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {excluded.length > 0 ? (
            <section>
              <h3 className="mb-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                排除名单（{excluded.length}）
              </h3>
              <ul className="space-y-1 rounded-xl border border-slate-200 p-2 dark:border-slate-800">
                {excluded.map((item: ExcludedView) => (
                  <li
                    key={item.personId}
                    className="flex items-center justify-between gap-2 px-1 py-1 text-xs"
                  >
                    <span className="truncate">{item.fullName}</span>
                    <Badge tone="danger">{exclusionLabel(item.reason)}</Badge>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/** 排班的课表视图：从开始日期起 7 天，班次按真实时间落在节次网格上，饭点画斜纹。 */
function ScheduleWeek({
  from,
  to,
  shifts,
  onOpen,
}: {
  from: string;
  to: string;
  shifts: ShiftView[];
  onOpen: (shift: ShiftView) => void;
}) {
  const terms = useTermsState();
  const periods = usePeriodsState(terms.current?.id ?? null);
  const meals = useAsync(() => api.get<{ items: MealBlock[] }>("/meal-blocks"), []);
  const today = isoDate();
  const days: TimetableDay[] = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(from, i);
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return { date, weekday: day === 0 ? 7 : day, today: date === today };
  });
  const index = new Map(days.map((d, i) => [d.date!, i]));
  const blocks: TimetableBlock[] = shifts.flatMap((shift) => {
    const date = dateFull(shift.startsAt);
    const day = index.get(date);
    if (day === undefined) return [];
    const assigned = shift.assignments?.length ?? 0;
    const missing = Math.max(0, shift.requiredHeadcount - assigned);
    const cancelled = shift.status === "cancelled";
    const title = shift.taskTitle ?? "未命名任务";
    return [
      {
        id: shift.id,
        day,
        start: isoToMinutes(shift.startsAt),
        end: isoToMinutes(shift.endsAt, date),
        title,
        detail: cancelled ? "已取消" : missing ? `${assigned}/${shift.requiredHeadcount} 人 · 缺 ${missing}` : `${assigned}/${shift.requiredHeadcount} 人`,
        colorKey: shift.taskId,
        ...(cancelled ? { variant: "outline" as const, color: "#8a8178" } : missing ? { variant: "outline" as const } : {}),
        label: `查看与安排：${title} ${date} ${timeRange(shift.startsAt, shift.endsAt)}，已排 ${assigned}/${shift.requiredHeadcount} 人`,
        onClick: cancelled ? undefined : () => onOpen(shift),
      },
    ];
  });
  return (
    <WeekTimetable
      caption="排班课表"
      days={days}
      periods={(periods.data?.items ?? []).map((p) => ({ index: p.periodIndex, start: clockToMinutes(p.startTime), end: clockToMinutes(p.endTime) }))}
      blocks={blocks}
      bands={(meals.data?.items ?? []).map((m, i) => ({
        id: `meal${i}`,
        start: clockToMinutes(m.start),
        end: clockToMinutes(m.end),
        label: m.label,
        kind: "meal" as const,
      }))}
      toolbar={
        <p className="text-xs text-slate-500">
          实心为已排满，虚线框为仍缺人；斜纹为饭点。点班次查看候选并安排。
          {to > addDays(from, 6) ? ` 课表视图只显示 ${from.slice(5)} 起 7 天，翻周或切到列表查看其余日期。` : ""}
        </p>
      }
      footer={
        blocks.length === 0 ? <p className="text-center text-xs text-slate-500">这 7 天没有班次。</p> : null
      }
    />
  );
}

export function SchedulePage() {
  const [tab, setTab] = useState("shifts");
  const [batch, setBatch] = useState<{
    taskId: string;
    rows: { s: ShiftView; p: PreviewResult }[];
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [finding, setFinding] = useState(false);
  const [draft, setDraft] = useState<WorkDraft | null>(null);
  const [detailTask, setDetailTask] = useState<string | null>(null);
  useEffect(() => {
    const open = () => setCreating(true);
    window.addEventListener("rota:create-work", open);
    return () => window.removeEventListener("rota:create-work", open);
  }, []);
  const [missingOnly, setMissingOnly] = useState(false);
  const [view, setView] = useState<"week" | "list">(() => {
    try {
      return localStorage.getItem("rota:schedule-view") === "list" ? "list" : "week";
    } catch {
      return "week";
    }
  });
  function changeView(next: "week" | "list"): void {
    setView(next);
    try {
      localStorage.setItem("rota:schedule-view", next);
    } catch {
      // 不可写时只在本次生效。
    }
  }
  const [taskQuery, setTaskQuery] = useState("");
  const toast = useToast();
  const orgsState = useOrgsState();

  const [from, setFrom] = useState(
    () => sessionStorage.getItem("rota:from") || isoDate(),
  );
  const [to, setTo] = useState(
    () => sessionStorage.getItem("rota:to") || addDays(isoDate(), 6),
  );
  const [orgId, setOrgId] = useState("");
  const [version, setVersion] = useState(0);
  const [previewShift, setPreviewShift] = useState<ShiftView | null>(null);
  const [autoTaskId, setAutoTaskId] = useState<string | null>(null);

  const shifts = useAsync(async () => {
    if (from > to) throw new Error("开始日期不能晚于结束日期");
    const params = new URLSearchParams({
      from: `${from}T00:00:00+08:00`,
      to: `${to}T23:59:59+08:00`,
    });
    if (orgId) params.set("orgId", orgId);
    return api.get<ListResponse<ShiftView>>(`/shifts?${params.toString()}`);
  }, [from, to, orgId, version]);

  useEffect(() => {
    sessionStorage.setItem("rota:from", from);
    sessionStorage.setItem("rota:to", to);
  }, [from, to]);
  const shiftList = (shifts.data?.items ?? []).filter(
    (s) =>
      (!missingOnly || (s.assignments?.length ?? 0) < s.requiredHeadcount) &&
      (s.taskTitle ?? "").includes(taskQuery),
  );
  useEffect(() => {
    if (previewShift) {
      const latest = shifts.data?.items.find((s) => s.id === previewShift.id);
      if (latest) setPreviewShift(latest);
    }
  }, [shifts.data]);

  const groups = useMemo<ShiftGroup[]>(() => {
    const map = new Map<string, ShiftGroup>();
    for (const shift of shiftList) {
      const existing = map.get(shift.taskId);
      if (existing) {
        existing.shifts.push(shift);
      } else {
        map.set(shift.taskId, {
          taskId: shift.taskId,
          taskTitle: shift.taskTitle ?? "未命名任务",
          shifts: [shift],
        });
      }
    }
    const result = [...map.values()];
    for (const group of result) {
      group.shifts.sort(
        (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
      );
    }
    return result;
  }, [shiftList]);

  async function autoAssign(taskId: string): Promise<void> {
    setAutoTaskId(taskId);
    try {
      const all = await api.get<ListResponse<ShiftView>>(
        `/tasks/${encodeURIComponent(taskId)}/shifts`,
      );
      const previews = await Promise.all(
        all.items
          .filter((s) => s.status !== "cancelled")
          .map(async (s) => ({
            s,
            p: await api.post<PreviewResult>(`/shifts/${s.id}/preview`, {}),
          })),
      );
      setBatch({ taskId, rows: previews });
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setAutoTaskId(null);
    }
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="排班视图" className="flex gap-2">
          {[
            ["shifts", "班次"],
            ["tasks", "任务"],
            ["fairness", "公平账本"],
          ].map(([id, label]) => (
            <Button
              key={id}
              variant={tab === id ? "secondary" : "ghost"}
              onClick={() => setTab(id)}
            >
              {label}
            </Button>
          ))}
        </nav>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setFinding(true)}>
            找时间
          </Button>
          <Button onClick={() => setCreating(true)}>安排工作</Button>
        </div>
      </div>
      {tab === "tasks" && <TasksPage taskId={null} />}
      {tab === "fairness" && <FairnessPage />}
      <div hidden={tab !== "shifts"} className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setFrom(addDays(from, -7));
              setTo(addDays(to, -7));
            }}
          >
            上一周
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setFrom(isoDate());
              setTo(addDays(isoDate(), 6));
            }}
          >
            今天起一周
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setFrom(addDays(from, 7));
              setTo(addDays(to, 7));
            }}
          >
            下一周
          </Button>
          <Button
            variant={missingOnly ? "primary" : "ghost"}
            size="sm"
            onClick={() => setMissingOnly(!missingOnly)}
          >
            只看缺员
          </Button>
          <div className="flex gap-1" role="group" aria-label="显示方式">
            <Button size="sm" variant={view === "week" ? "secondary" : "ghost"} aria-pressed={view === "week"} onClick={() => changeView("week")}>
              课表
            </Button>
            <Button size="sm" variant={view === "list" ? "secondary" : "ghost"} aria-pressed={view === "list"} onClick={() => changeView("list")}>
              列表
            </Button>
          </div>
          <a
            className="ml-auto text-sm underline"
            href={`/api/export/schedule.csv?${new URLSearchParams({ from: from + "T00:00:00+08:00", to: to + "T23:59:59+08:00", ...(orgId ? { orgId } : {}) })}`}
          >
            导出班表
          </a>
        </div>
        <TextInput
          aria-label="搜索工作"
          placeholder="搜索工作名称"
          value={taskQuery}
          onChange={(e) => setTaskQuery(e.target.value)}
        />
        <Card>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Field label="开始日期">
              <TextInput
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </Field>
            <Field label="结束日期">
              <TextInput
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </Field>
            <Field label="部门">
              <Select
                value={orgId}
                onChange={(event) => setOrgId(event.target.value)}
              >
                <option value="">全部部门</option>
                {(orgsState.data?.items ?? []).map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setVersion((value) => value + 1)}
              >
                刷新
              </Button>
              <span className="pb-2 text-[11px] text-slate-400">
                {shifts.loading ? "加载中…" : `${shiftList.length} 个班次`}
              </span>
            </div>
          </div>
          {orgsState.error ? (
            <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
              组织加载失败：{orgsState.error}
            </p>
          ) : null}
        </Card>

        {view === "week" ? (
          shifts.error ? (
            <ListState loading={false} error={shifts.error} empty={false} onRetry={shifts.reload}>
              <div />
            </ListState>
          ) : (
            <ScheduleWeek from={from} to={to} shifts={shiftList} onOpen={setPreviewShift} />
          )
        ) : (
        <ListState
          loading={shifts.loading}
          error={shifts.error}
          empty={groups.length === 0}
          onRetry={shifts.reload}
          emptyTitle="这个时间范围内没有班次"
          emptyDescription="调整筛选条件，或直接安排一项工作。"
          emptyAction={
            <Button onClick={() => setCreating(true)}>安排工作</Button>
          }
        >
          <div className="space-y-4">
            {groups.map((group) => {
              const filled = group.shifts.reduce(
                (total, shift) => total + (shift.assignments?.length ?? 0),
                0,
              );
              const required = group.shifts.reduce(
                (total, shift) => total + shift.requiredHeadcount,
                0,
              );
              return (
                <Card
                  key={group.taskId}
                  title={group.taskTitle}
                  description={`${group.shifts.length} 个班次 · 已排 ${filled}/${required} 人次`}
                  actions={
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDetailTask(group.taskId)}
                      >
                        任务详情
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={autoTaskId === group.taskId}
                        onClick={() => void autoAssign(group.taskId)}
                      >
                        整任务自动排
                      </Button>
                    </>
                  }
                  bodyClassName="p-3 sm:p-4"
                >
                  <div className="divide-y divide-slate-200 dark:divide-slate-800">
                    {group.shifts.map((shift) => {
                      const assigned = shift.assignments ?? [];
                      const full = assigned.length >= shift.requiredHeadcount;
                      return (
                        <article
                          key={shift.id}
                          className="grid gap-3 py-4 md:grid-cols-[2fr_1fr_2fr_auto] md:items-center"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="text-xs font-medium tabular-nums">
                                {dateFull(shift.startsAt)}{" "}
                                {timeRange(shift.startsAt, shift.endsAt)}
                              </p>
                              <p className="mt-0.5 text-[11px] text-slate-400">
                                {minutesText(
                                  durationMinutes(shift.startsAt, shift.endsAt),
                                )}
                                {shift.location ? ` · ${shift.location}` : ""}
                              </p>
                            </div>
                            <Badge tone={shiftStatusTone(shift.status)}>
                              {shiftStatusLabel(shift.status)}
                            </Badge>
                          </div>

                          <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                            <span
                              className={
                                full
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-amber-600 dark:text-amber-400"
                              }
                            >
                              {assigned.length}/{shift.requiredHeadcount} 人
                            </span>
                            <span className="text-slate-300 dark:text-slate-600">
                              ·
                            </span>
                            <span>需求 {shift.requiredHeadcount}</span>
                          </div>

                          <div className="mt-2 flex min-h-6 flex-wrap gap-1">
                            {assigned.length === 0 ? (
                              <span className="text-[11px] text-slate-400">
                                还没有人
                              </span>
                            ) : (
                              assigned.map((assignment) => (
                                <Badge key={assignment.id} tone="info">
                                  {assignment.personName}
                                </Badge>
                              ))
                            )}
                          </div>

                          <div className="mt-3 flex justify-end">
                            <Button
                              size="sm"
                              disabled={shift.status === "cancelled"}
                              onClick={() => setPreviewShift(shift)}
                            >
                              查看与安排
                            </Button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </Card>
              );
            })}
          </div>
        </ListState>
        )}
      </div>
      {detailTask && (
        <Modal side title="任务详情" onClose={() => setDetailTask(null)}>
          <TasksPage taskId={detailTask} />
        </Modal>
      )}
      {finding && (
        <FreeWindowFinder
          onClose={() => setFinding(false)}
          onArrange={(next) => {
            setFinding(false);
            setDraft(next);
            setCreating(true);
          }}
        />
      )}
      {creating && (
        <WorkComposer
          initial={draft ?? undefined}
          onClose={() => {
            setCreating(false);
            setDraft(null);
          }}
          onCreated={(date) => {
            setFrom(date);
            setTo(addDays(date, 6));
            setTab("shifts");
            setVersion((v) => v + 1);
          }}
        />
      )}
      {batch && (
        <Modal
          side
          title="批量排班预览"
          description="覆盖本任务全部班次。以下是当前可用性检查；确认时逐次重新检查人员冲突，最终人数可能变化。"
          onClose={() => setBatch(null)}
          footer={
            <Button
              loading={autoTaskId !== null}
              onClick={async () => {
                setAutoTaskId(batch.taskId);
                try {
                  const result = await api.post(
                    `/tasks/${batch.taskId}/auto-assign`,
                    {},
                  );
                  toast.success(summarizeResult(result));
                  setBatch(null);
                  setVersion((v) => v + 1);
                } catch (e) {
                  toast.error(messageOf(e));
                } finally {
                  setAutoTaskId(null);
                }
              }}
            >
              确认自动分配
            </Button>
          }
        >
          <ul className="divide-y divide-slate-200">
            {batch.rows.map(({ s, p }) => {
              const gap = Math.max(
                0,
                s.requiredHeadcount - (s.assignments?.length ?? 0),
              );
              return (
                <li key={s.id} className="py-4">
                  <p className="font-medium">
                    {dateFull(s.startsAt)} {timeRange(s.startsAt, s.endsAt)}
                  </p>
                  <p className="mt-2 text-sm">
                    {gap === 0
                      ? "已填满"
                      : `缺 ${gap} 人 · 可用候选 ${p.candidates.length} 人`}
                  </p>
                  {gap > 0 && p.candidates.length === 0 && (
                    <p className="mt-1 text-rose-600">
                      需人工处理：
                      {p.excluded
                        .map(
                          (e) => `${e.fullName}（${exclusionLabel(e.reason)}）`,
                        )
                        .join("、") || "部门暂无有效成员"}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </Modal>
      )}
      {previewShift ? (
        <PreviewModal
          shift={previewShift}
          onClose={() => setPreviewShift(null)}
          onAssigned={() => setVersion((value) => value + 1)}
        />
      ) : null}
    </div>
  );
}
