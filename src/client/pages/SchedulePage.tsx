import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CandidateView,
  ExcludedView,
  ListResponse,
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
import { addDays, dateFull, durationMinutes, isoDate, minutesText, timeRange } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { exclusionLabel, shiftStatusLabel, shiftStatusTone } from "../lib/labels";
import { useOrgsState } from "../lib/resources";

interface ShiftGroup {
  taskId: string;
  taskTitle: string;
  shifts: ShiftView[];
}

function summarizeResult(result: unknown): string {
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    const assigned = record.assigned ?? record.assignedCount ?? record.count;
    if (typeof assigned === "number") return `已自动排 ${assigned} 个班次`;
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
      const result = await api.post<PreviewResult>(`/shifts/${encodeURIComponent(shift.id)}/preview`, {});
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
      await api.post(`/shifts/${encodeURIComponent(shift.id)}/assign`, personId ? { personId } : {});
      toast.success(personId ? "已分配给选中的候选" : "已自动选最高分分配");
      onAssigned();
      onClose();
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      title="试排预览"
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
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
          <Spinner size="sm" />
          正在计算候选…
        </div>
      ) : error ? (
        <ListState loading={false} error={error} empty={false} onRetry={() => void load()}>
          <div />
        </ListState>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
            <Badge tone="info">{`候选 ${candidates.length} 人`}</Badge>
            <Badge tone={excluded.length > 0 ? "warning" : "neutral"}>{`排除 ${excluded.length} 人`}</Badge>
            <span>冷却 {data?.cooldownDays ?? 0} 天</span>
            {data?.appliedWeights ? (
              <span className="font-mono">
                权重 公平 {data.appliedWeights.fairness} / 饥饿 {data.appliedWeights.starvation} / 偏好{" "}
                {data.appliedWeights.preference} / 优先级 {data.appliedWeights.priority} / 连排{" "}
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
                          <p className="text-sm font-medium">{candidate.fullName}</p>
                          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                            已排 {candidate.assignedCount} 次 · 空闲 {minutesText(candidate.freeMinutes)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-lg leading-none font-semibold tabular-nums text-indigo-600 dark:text-indigo-400">
                            {Number.isFinite(candidate.score) ? candidate.score.toFixed(2) : "—"}
                          </p>
                          <p className="text-[10px] text-slate-400">总分</p>
                        </div>
                      </div>
                      <div className="mt-2 space-y-1">
                        <ScoreBar label="公平" value={candidate.breakdown?.fairness ?? 0} />
                        <ScoreBar label="饥饿" value={candidate.breakdown?.starvation ?? 0} />
                        <ScoreBar label="偏好" value={candidate.breakdown?.preference ?? 0} />
                        <ScoreBar label="优先级" value={candidate.breakdown?.priority ?? 0} />
                        <ScoreBar label="连排" value={candidate.breakdown?.recency ?? 0} />
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
                  <li key={item.personId} className="flex items-center justify-between gap-2 px-1 py-1 text-xs">
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

export function SchedulePage() {
  const toast = useToast();
  const orgsState = useOrgsState();

  const [from, setFrom] = useState(isoDate());
  const [to, setTo] = useState(addDays(isoDate(), 13));
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

  const shiftList = shifts.data?.items ?? [];

  const groups = useMemo<ShiftGroup[]>(() => {
    const map = new Map<string, ShiftGroup>();
    for (const shift of shiftList) {
      const existing = map.get(shift.taskId);
      if (existing) {
        existing.shifts.push(shift);
      } else {
        map.set(shift.taskId, { taskId: shift.taskId, taskTitle: shift.taskTitle ?? "未命名任务", shifts: [shift] });
      }
    }
    const result = [...map.values()];
    for (const group of result) {
      group.shifts.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    }
    return result;
  }, [shiftList]);

  async function autoAssign(taskId: string): Promise<void> {
    setAutoTaskId(taskId);
    try {
      const result = await api.post<unknown>(`/tasks/${encodeURIComponent(taskId)}/auto-assign`, {});
      toast.success(summarizeResult(result));
      setVersion((value) => value + 1);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setAutoTaskId(null);
    }
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <Card title="排班" description="按时间范围查看班次，先试排再确认；也可以整任务自动排。">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="开始日期">
            <TextInput type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="结束日期">
            <TextInput type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          <Field label="部门">
            <Select value={orgId} onChange={(event) => setOrgId(event.target.value)}>
              <option value="">全部部门</option>
              {(orgsState.data?.items ?? []).map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setVersion((value) => value + 1)}>
              刷新
            </Button>
            <span className="pb-2 text-[11px] text-slate-400">
              {shifts.loading ? "加载中…" : `${shiftList.length} 个班次`}
            </span>
          </div>
        </div>
        {orgsState.error ? (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">组织加载失败：{orgsState.error}</p>
        ) : null}
      </Card>

      <ListState
        loading={shifts.loading}
        error={shifts.error}
        empty={groups.length === 0}
        onRetry={shifts.reload}
        emptyTitle="这个时间范围内没有班次"
        emptyDescription="换一个时间范围，或先到任务页生成班次。"
        emptyAction={
          <a href="#/tasks" className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            去任务页 →
          </a>
        }
      >
        <div className="space-y-4">
          {groups.map((group) => {
            const filled = group.shifts.reduce((total, shift) => total + (shift.assignments?.length ?? 0), 0);
            const required = group.shifts.reduce((total, shift) => total + shift.requiredHeadcount, 0);
            return (
              <Card
                key={group.taskId}
                title={group.taskTitle}
                description={`${group.shifts.length} 个班次 · 已排 ${filled}/${required} 人次`}
                actions={
                  <>
                    <a
                      href={`#/tasks/${group.taskId}`}
                      className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      任务详情
                    </a>
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
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {group.shifts.map((shift) => {
                    const assigned = shift.assignments ?? [];
                    const full = assigned.length >= shift.requiredHeadcount;
                    return (
                      <article
                        key={shift.id}
                        className="flex flex-col rounded-xl border border-slate-200 p-3 dark:border-slate-800"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-xs font-medium tabular-nums">
                              {dateFull(shift.startsAt)} {timeRange(shift.startsAt, shift.endsAt)}
                            </p>
                            <p className="mt-0.5 text-[11px] text-slate-400">
                              {minutesText(durationMinutes(shift.startsAt, shift.endsAt))}
                              {shift.location ? ` · ${shift.location}` : ""}
                            </p>
                          </div>
                          <Badge tone={shiftStatusTone(shift.status)}>{shiftStatusLabel(shift.status)}</Badge>
                        </div>

                        <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                          <span className={full ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                            {assigned.length}/{shift.requiredHeadcount} 人
                          </span>
                          <span className="text-slate-300 dark:text-slate-600">·</span>
                          <span>需求 {shift.requiredHeadcount}</span>
                        </div>

                        <div className="mt-2 flex min-h-6 flex-wrap gap-1">
                          {assigned.length === 0 ? (
                            <span className="text-[11px] text-slate-400">还没有人</span>
                          ) : (
                            assigned.map((assignment) => (
                              <Badge key={assignment.id} tone="info">
                                {assignment.personName}
                              </Badge>
                            ))
                          )}
                        </div>

                        <div className="mt-3 flex justify-end">
                          <Button size="sm" disabled={shift.status === "cancelled"} onClick={() => setPreviewShift(shift)}>
                            试排
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
