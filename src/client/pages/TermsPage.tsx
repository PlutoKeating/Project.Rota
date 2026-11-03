import { useEffect, useState } from "react";
import type { CreateTermInput, Period, Term, TermDetail, TermStatus } from "../../shared/types";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { DataTable, type Column } from "../components/Table";
import { EmptyState } from "../components/EmptyState";
import { Field, Select, TextInput } from "../components/Field";
import { ListState } from "../components/ListState";
import { Modal } from "../components/Modal";
import { Spinner } from "../components/Spinner";
import { useToast } from "../components/Toast";
import { api, messageOf } from "../lib/api";
import { dateFull, isoDate } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { TERM_STATUS_OPTIONS, termStatusLabel, termStatusTone } from "../lib/labels";
import { useTermsState } from "../lib/resources";

let periodKeySeed = 0;

interface PeriodRow {
  key: string;
  periodIndex: string;
  startTime: string;
  endTime: string;
  label: string;
}

const COMMON_PERIODS: [string, string][] = [
  ["08:00", "08:45"],
  ["08:55", "09:40"],
  ["10:00", "10:45"],
  ["10:55", "11:40"],
  ["14:00", "14:45"],
  ["14:55", "15:40"],
  ["16:00", "16:45"],
  ["16:55", "17:40"],
  ["19:00", "19:45"],
  ["19:55", "20:40"],
];

function defaultPeriodRows(count = 5): PeriodRow[] {
  return COMMON_PERIODS.slice(0, count).map(([startTime, endTime], index) => {
    periodKeySeed += 1;
    return {
      key: `period-${periodKeySeed}`,
      periodIndex: String(index + 1),
      startTime,
      endTime,
      label: "",
    };
  });
}

function newPeriodRow(rows: PeriodRow[]): PeriodRow {
  periodKeySeed += 1;
  const maxIndex = rows.reduce((max, row) => Math.max(max, Number(row.periodIndex) || 0), 0);
  return { key: `period-${periodKeySeed}`, periodIndex: String(maxIndex + 1), startTime: "", endTime: "", label: "" };
}

interface CreateTermModalProps {
  onClose: () => void;
  onCreated: (termId: string | null) => void;
}

function CreateTermModal({ onClose, onCreated }: CreateTermModalProps) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState(isoDate());
  const [weekCount, setWeekCount] = useState("20");
  const [periods, setPeriods] = useState<PeriodRow[]>(() => defaultPeriodRows());
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function updatePeriod(key: string, patch: Partial<PeriodRow>): void {
    setPeriods((previous) => previous.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function removePeriod(key: string): void {
    setPeriods((previous) => previous.filter((row) => row.key !== key));
  }

  async function submit(): Promise<void> {
    const nextErrors: Record<string, string> = {};
    if (!name.trim()) nextErrors.name = "请填写学期名称";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) nextErrors.startDate = "请选择开学日期";
    const weeks = Number.parseInt(weekCount, 10);
    if (!Number.isFinite(weeks) || weeks < 1 || weeks > 60) nextErrors.weekCount = "周数需在 1–60 之间";
    if (periods.length === 0) nextErrors.periods = "至少保留一个节次";

    const seen = new Set<number>();
    for (const [index, row] of periods.entries()) {
      const periodIndex = Number.parseInt(row.periodIndex, 10);
      if (!Number.isFinite(periodIndex) || periodIndex < 1) {
        nextErrors.periods = `第 ${index + 1} 行的序号无效`;
        break;
      }
      if (seen.has(periodIndex)) {
        nextErrors.periods = `序号 ${periodIndex} 重复`;
        break;
      }
      seen.add(periodIndex);
      if (!row.startTime || !row.endTime) {
        nextErrors.periods = `第 ${index + 1} 行缺少开始或结束时间`;
        break;
      }
      if (row.startTime >= row.endTime) {
        nextErrors.periods = `第 ${index + 1} 行结束时间需晚于开始时间`;
        break;
      }
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const payload: CreateTermInput = {
      name: name.trim(),
      startDate,
      weekCount: weeks,
      periods: periods.map((row) => ({
        periodIndex: Number.parseInt(row.periodIndex, 10),
        ...(row.label.trim() ? { label: row.label.trim() } : {}),
        startTime: row.startTime,
        endTime: row.endTime,
      })),
    };

    setBusy(true);
    try {
      const created = await api.post<TermDetail>("/terms", payload);
      toast.success(`学期「${created?.term?.name ?? payload.name}」已创建`);
      onCreated(created?.term?.id ?? null);
      onClose();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="新建学期"
      description="创建时会同时生成节次与整个学期的格子。"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            创建学期
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="学期名称" error={errors.name}>
          <TextInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="2026 秋季学期"
            autoFocus
          />
        </Field>
        <Field label="开学日" hint="YYYY-MM-DD，周次从这天算起" error={errors.startDate}>
          <TextInput type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
        </Field>
        <Field label="周数" error={errors.weekCount}>
          <TextInput
            type="number"
            min={1}
            max={60}
            value={weekCount}
            onChange={(event) => setWeekCount(event.target.value)}
          />
        </Field>
        <div className="flex items-end">
          <p className="text-[11px] text-slate-400 dark:text-slate-500">
            生成格子数 = 周数 × 7 × 节次数
          </p>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">节次</h3>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPeriods(defaultPeriodRows())}>
              重置为常见节次
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPeriods((previous) => [...previous, newPeriodRow(previous)])}
            >
              添加节次
            </Button>
          </div>
        </div>
        {errors.periods ? <p className="mb-2 text-[11px] text-rose-600 dark:text-rose-400">{errors.periods}</p> : null}
        <div className="space-y-2">
          {periods.map((row) => (
            <div
              key={row.key}
              className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 p-2.5 sm:grid-cols-[72px_1fr_1fr_1fr_auto] dark:border-slate-700"
            >
              <Field label="序号">
                <TextInput
                  type="number"
                  min={1}
                  value={row.periodIndex}
                  onChange={(event) => updatePeriod(row.key, { periodIndex: event.target.value })}
                />
              </Field>
              <Field label="开始">
                <TextInput
                  type="time"
                  value={row.startTime}
                  onChange={(event) => updatePeriod(row.key, { startTime: event.target.value })}
                />
              </Field>
              <Field label="结束">
                <TextInput
                  type="time"
                  value={row.endTime}
                  onChange={(event) => updatePeriod(row.key, { endTime: event.target.value })}
                />
              </Field>
              <Field label="标签（可选）">
                <TextInput
                  value={row.label}
                  onChange={(event) => updatePeriod(row.key, { label: event.target.value })}
                  placeholder="第 1 节"
                />
              </Field>
              <div className="col-span-2 flex items-end justify-end sm:col-span-1">
                <Button variant="ghost" size="sm" onClick={() => removePeriod(row.key)}>
                  删除
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function TermsPage() {
  const toast = useToast();
  const terms = useTermsState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);
  const [statusDraft, setStatusDraft] = useState<TermStatus>("planned");
  const [statusBusy, setStatusBusy] = useState(false);

  useEffect(() => {
    if (selectedId) return;
    if (terms.current) setSelectedId(terms.current.id);
  }, [terms.current, selectedId]);

  const detail = useAsync(
    async () => (selectedId ? api.get<TermDetail>(`/terms/${encodeURIComponent(selectedId)}`) : null),
    [selectedId, detailVersion],
  );

  const detailTerm = detail.data?.term ?? null;

  useEffect(() => {
    if (detailTerm) setStatusDraft(detailTerm.status);
  }, [detailTerm]);

  async function saveStatus(): Promise<void> {
    if (!selectedId) return;
    setStatusBusy(true);
    try {
      await api.patch(`/terms/${encodeURIComponent(selectedId)}`, { status: statusDraft });
      toast.success("学期状态已更新");
      terms.reload();
      setDetailVersion((value) => value + 1);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setStatusBusy(false);
    }
  }

  const columns: Column<Term>[] = [
    {
      key: "name",
      header: "学期",
      render: (term) => (
        <div className="min-w-0">
          <p className="font-medium">{term.name}</p>
          <p className="text-[11px] text-slate-400">{term.timezone ?? "Asia/Shanghai"}</p>
        </div>
      ),
    },
    { key: "start", header: "开学日", render: (term) => <span className="tabular-nums">{dateFull(term.startDate)}</span> },
    { key: "weeks", header: "周数", render: (term) => <span className="tabular-nums">{term.weekCount}</span> },
    {
      key: "status",
      header: "状态",
      render: (term) => <Badge tone={termStatusTone(term.status)}>{termStatusLabel(term.status)}</Badge>,
    },
    {
      key: "action",
      header: "",
      className: "text-right",
      render: (term) => (
        <span className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
          {selectedId === term.id ? "正在查看" : "查看详情"}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4 sm:space-y-5">
      <Card
        title="学期列表"
        description="一个学期对应一套节次与格子；同一时间只建议一个「进行中」。"
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            新建学期
          </Button>
        }
      >
        <ListState
          loading={terms.loading}
          error={terms.error}
          empty={terms.terms.length === 0}
          onRetry={terms.reload}
          emptyTitle="还没有学期"
          emptyDescription="创建学期后，才能生成节次、录入课表与班次。"
          emptyAction={<Button size="sm" onClick={() => setCreateOpen(true)}>新建学期</Button>}
        >
          <DataTable
            columns={columns}
            rows={terms.terms}
            rowKey={(term) => term.id}
            onRowClick={(term) => setSelectedId(term.id)}
            minWidth="min-w-[560px]"
          />
        </ListState>
      </Card>

      {selectedId ? (
        <Card
          title="学期详情"
          description={detailTerm ? `${detailTerm.name} · ${detailTerm.weekCount} 周` : undefined}
          actions={
            detailTerm ? (
              <div className="flex items-center gap-2">
                <Select
                  value={statusDraft}
                  onChange={(event) => setStatusDraft(event.target.value as TermStatus)}
                  aria-label="学期状态"
                  className="w-28 py-1.5 text-xs"
                >
                  {TERM_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  loading={statusBusy}
                  disabled={statusDraft === detailTerm.status}
                  onClick={() => void saveStatus()}
                >
                  保存状态
                </Button>
              </div>
            ) : undefined
          }
        >
          {detail.loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
              <Spinner size="sm" />
              加载学期详情…
            </div>
          ) : detail.error ? (
            <ListState
              loading={false}
              error={detail.error}
              empty={false}
              onRetry={() => setDetailVersion((value) => value + 1)}
            >
              <div />
            </ListState>
          ) : detailTerm ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {[
                  { label: "人员", value: detail.data?.counts.persons ?? 0 },
                  { label: "课程", value: detail.data?.counts.courses ?? 0 },
                  { label: "成员关系", value: detail.data?.counts.memberships ?? 0 },
                  { label: "任务", value: detail.data?.counts.tasks ?? 0 },
                  { label: "格子", value: detail.data?.counts.slots ?? 0 },
                ].map((item) => (
                  <div key={item.label} className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">{item.label}</p>
                    <p className="text-lg font-semibold tabular-nums">{item.value}</p>
                  </div>
                ))}
              </div>

              <div className="grid gap-2 text-xs sm:grid-cols-3">
                <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
                  <span className="text-slate-500 dark:text-slate-400">开学日</span>
                  <p className="mt-0.5 font-medium tabular-nums">{dateFull(detailTerm.startDate)}</p>
                </div>
                <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
                  <span className="text-slate-500 dark:text-slate-400">时区</span>
                  <p className="mt-0.5 font-medium">{detailTerm.timezone}</p>
                </div>
                <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
                  <span className="text-slate-500 dark:text-slate-400">状态</span>
                  <p className="mt-0.5">
                    <Badge tone={termStatusTone(detailTerm.status)}>{termStatusLabel(detailTerm.status)}</Badge>
                  </p>
                </div>
              </div>

              <div>
                <h3 className="mb-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                  节次表（{detail.data?.periods.length ?? 0} 节）
                </h3>
                <ListState
                  loading={false}
                  error={null}
                  empty={(detail.data?.periods.length ?? 0) === 0}
                  emptyTitle="这个学期还没有节次"
                  emptyDescription="后端创建学期时通常会自动生成节次；若为空请检查接口实现。"
                >
                  <DataTable
                    columns={[
                      { key: "index", header: "序号", render: (period: Period) => <span className="tabular-nums">{period.periodIndex}</span> },
                      { key: "label", header: "标签", render: (period: Period) => period.label ?? "—" },
                      { key: "start", header: "开始", render: (period: Period) => <span className="tabular-nums">{period.startTime}</span> },
                      { key: "end", header: "结束", render: (period: Period) => <span className="tabular-nums">{period.endTime}</span> },
                    ]}
                    rows={[...(detail.data?.periods ?? [])].sort((a, b) => a.periodIndex - b.periodIndex)}
                    rowKey={(period) => period.id}
                    minWidth="min-w-[420px]"
                  />
                </ListState>
              </div>
            </div>
          ) : (
            <EmptyState title="请选择一个学期" description="点上方列表中的任意一行查看详情。" />
          )}
        </Card>
      ) : null}

      {createOpen ? (
        <CreateTermModal
          onClose={() => setCreateOpen(false)}
          onCreated={(termId) => {
            terms.reload();
            if (termId) {
              setSelectedId(termId);
              setDetailVersion((value) => value + 1);
            }
          }}
        />
      ) : null}
    </div>
  );
}
