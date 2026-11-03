import { useEffect, useMemo, useState } from "react";
import type {
  CreateShiftInput,
  CreateTaskInput,
  GenerateShiftsInput,
  ListResponse,
  Org,
  Period,
  Role,
  ShiftView,
  Task,
  TaskKind,
  TaskStatus,
  WeekPatternKind,
} from "../../shared/types";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Field, Select, TextInput, Textarea } from "../components/Field";
import { ListState } from "../components/ListState";
import { Modal } from "../components/Modal";
import { Spinner } from "../components/Spinner";
import { DataTable, type Column } from "../components/Table";
import { useToast } from "../components/Toast";
import { api, messageOf } from "../lib/api";
import {
  WEEKDAYS,
  dateFull,
  durationMinutes,
  fromDateTimeLocal,
  hhmm,
  isoDate,
  minutesText,
  timeRange,
  toDateTimeLocal,
  weekdayName,
} from "../lib/format";
import { useAsync } from "../lib/hooks";
import {
  TASK_KIND_OPTIONS,
  TASK_STATUS_OPTIONS,
  WEEK_PATTERN_OPTIONS,
  shiftStatusLabel,
  shiftStatusTone,
  taskKindLabel,
  taskStatusLabel,
  taskStatusTone,
} from "../lib/labels";
import { navigate } from "../lib/router";
import { useOrgsState, usePeriodsState, useTermsState } from "../lib/resources";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function addHoursToInput(value: string, hours: number): string {
  const date = new Date(`${value}:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setHours(date.getHours() + hours);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function windowText(task: Task): string {
  if (!task.windowStart && !task.windowEnd) return "—";
  const start = task.windowStart ? `${dateFull(task.windowStart)} ${hhmm(task.windowStart)}` : "…";
  const end = task.windowEnd ? `${dateFull(task.windowEnd)} ${hhmm(task.windowEnd)}` : "…";
  return `${start} → ${end}`;
}

interface NewTaskModalProps {
  orgs: Org[];
  onClose: () => void;
  onCreated: (task: Task | null) => void;
}

function NewTaskModal({ orgs, onClose, onCreated }: NewTaskModalProps) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [orgId, setOrgId] = useState("");
  const [kind, setKind] = useState<TaskKind>("oneoff");
  const [description, setDescription] = useState("");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!title.trim()) {
      setError("请填写任务标题");
      return;
    }
    setError(null);

    const input: CreateTaskInput = {
      title: title.trim(),
      kind,
      orgId: orgId || null,
      description: description.trim() || undefined,
      windowStart: fromDateTimeLocal(windowStart) || undefined,
      windowEnd: fromDateTimeLocal(windowEnd) || undefined,
    };

    setBusy(true);
    try {
      const created = await api.post<Task>("/tasks", input);
      toast.success("任务已创建");
      onCreated(created ?? null);
      onClose();
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="新建任务"
      description="任务是一件事，班次是它的具体时段。"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            创建任务
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="标题" required error={error ?? undefined} className="sm:col-span-2">
          <TextInput value={title} onChange={(event) => setTitle(event.target.value)} placeholder="迎新晚会签到" autoFocus />
        </Field>
        <Field label="所属部门">
          <Select value={orgId} onChange={(event) => setOrgId(event.target.value)}>
            <option value="">不指定</option>
            {orgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="类型">
          <Select value={kind} onChange={(event) => setKind(event.target.value as TaskKind)}>
            {TASK_KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="时间窗开始">
          <TextInput type="datetime-local" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} />
        </Field>
        <Field label="时间窗结束">
          <TextInput type="datetime-local" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} />
        </Field>
        <Field label="说明" className="sm:col-span-2">
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="可选" />
        </Field>
      </div>
    </Modal>
  );
}

interface AddShiftModalProps {
  task: Task;
  roles: Role[];
  onClose: () => void;
  onSaved: () => void;
}

function AddShiftModal({ task, roles, onClose, onSaved }: AddShiftModalProps) {
  const toast = useToast();
  const initialStart = toDateTimeLocal(task.windowStart) || `${isoDate()}T09:00`;
  const [startsAt, setStartsAt] = useState(initialStart);
  const [endsAt, setEndsAt] = useState(() => addHoursToInput(initialStart, 2));
  const [headcount, setHeadcount] = useState("1");
  const [roleId, setRoleId] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);

  const availableRoles = useMemo(
    () => roles.filter((role) => (task.orgId ? role.orgId === task.orgId || role.orgId === null : role.orgId === null)),
    [roles, task.orgId],
  );

  async function submit(): Promise<void> {
    if (!startsAt || !endsAt) {
      toast.error("请填写开始与结束时间");
      return;
    }
    if (startsAt >= endsAt) {
      toast.error("结束时间需晚于开始时间");
      return;
    }
    const count = Number.parseInt(headcount, 10);
    if (!Number.isFinite(count) || count < 1) {
      toast.error("需求人数至少为 1");
      return;
    }

    const input: CreateShiftInput = {
      startsAt: fromDateTimeLocal(startsAt),
      endsAt: fromDateTimeLocal(endsAt),
      requiredHeadcount: count,
      requiredRoleId: roleId || null,
      location: location.trim() || undefined,
    };

    setBusy(true);
    try {
      await api.post(`/tasks/${encodeURIComponent(task.id)}/shifts`, input);
      toast.success("班次已添加");
      onSaved();
      onClose();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="加一个班次"
      description={task.title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            添加班次
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="开始时间" required>
          <TextInput
            type="datetime-local"
            value={startsAt}
            onChange={(event) => {
              setStartsAt(event.target.value);
              if (!endsAt || endsAt <= event.target.value) setEndsAt(addHoursToInput(event.target.value, 2));
            }}
          />
        </Field>
        <Field label="结束时间" required>
          <TextInput type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
        </Field>
        <Field label="需求人数">
          <TextInput
            type="number"
            min={1}
            value={headcount}
            onChange={(event) => setHeadcount(event.target.value)}
          />
        </Field>
        <Field label="角色要求">
          <Select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
            <option value="">不限</option>
            {availableRoles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="地点" className="sm:col-span-2">
          <TextInput value={location} onChange={(event) => setLocation(event.target.value)} placeholder="可选" />
        </Field>
      </div>
    </Modal>
  );
}

interface GenerateShiftsModalProps {
  task: Task;
  periods: Period[];
  roles: Role[];
  onClose: () => void;
  onSaved: () => void;
}

function GenerateShiftsModal({ task, periods, roles, onClose, onSaved }: GenerateShiftsModalProps) {
  const toast = useToast();
  const [weekday, setWeekday] = useState(1);
  const [periodFrom, setPeriodFrom] = useState(1);
  const [periodTo, setPeriodTo] = useState(1);
  const [patternKind, setPatternKind] = useState<WeekPatternKind>("all");
  const [weekRanges, setWeekRanges] = useState("");
  const [headcount, setHeadcount] = useState("1");
  const [roleId, setRoleId] = useState("");
  const [busy, setBusy] = useState(false);

  const periodCount = periods.length > 0 ? periods.length : 12;
  const availableRoles = useMemo(
    () => roles.filter((role) => (task.orgId ? role.orgId === task.orgId || role.orgId === null : role.orgId === null)),
    [roles, task.orgId],
  );

  async function submit(): Promise<void> {
    if (periodFrom > periodTo) {
      toast.error("开始节次不能晚于结束节次");
      return;
    }
    if (patternKind === "ranges" && !weekRanges.trim()) {
      toast.error("请填写周次范围，如 1-8,10-16");
      return;
    }
    const count = Number.parseInt(headcount, 10);
    if (!Number.isFinite(count) || count < 1) {
      toast.error("需求人数至少为 1");
      return;
    }

    const input: GenerateShiftsInput = {
      weekday,
      periodFrom,
      periodTo,
      patternKind,
      weekRanges: patternKind === "ranges" ? weekRanges.trim() : undefined,
      requiredHeadcount: count,
      requiredRoleId: roleId || null,
    };

    setBusy(true);
    try {
      await api.post(`/tasks/${encodeURIComponent(task.id)}/shifts/generate`, input);
      toast.success("已按周生成班次（同一时段不会重复）");
      onSaved();
      onClose();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="按周生成班次"
      description={`${task.title} · 展开后写入整个学期`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            生成
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="星期">
          <Select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>
            {WEEKDAYS.map((day) => (
              <option key={day} value={day}>
                {weekdayName(day)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="节次范围">
          <div className="flex items-center gap-2">
            <Select value={periodFrom} onChange={(event) => setPeriodFrom(Number(event.target.value))}>
              {Array.from({ length: periodCount }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>
                  第 {value} 节
                </option>
              ))}
            </Select>
            <span className="text-xs text-slate-400">至</span>
            <Select value={periodTo} onChange={(event) => setPeriodTo(Number(event.target.value))}>
              {Array.from({ length: periodCount }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>
                  第 {value} 节
                </option>
              ))}
            </Select>
          </div>
        </Field>
        <Field label="周次模式">
          <Select value={patternKind} onChange={(event) => setPatternKind(event.target.value as WeekPatternKind)}>
            {WEEK_PATTERN_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        {patternKind === "ranges" ? (
          <Field label="周次范围" hint="例如 1-8,10-16">
            <TextInput value={weekRanges} onChange={(event) => setWeekRanges(event.target.value)} placeholder="1-8" />
          </Field>
        ) : null}
        <Field label="每班人数">
          <TextInput
            type="number"
            min={1}
            value={headcount}
            onChange={(event) => setHeadcount(event.target.value)}
          />
        </Field>
        <Field label="角色要求">
          <Select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
            <option value="">不限</option>
            {availableRoles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

export function TasksPage({ taskId }: { taskId: string | null }) {
  const toast = useToast();
  const terms = useTermsState();
  const orgsState = useOrgsState();

  const [orgFilter, setOrgFilter] = useState("");
  const [taskVersion, setTaskVersion] = useState(0);
  const [shiftVersion, setShiftVersion] = useState(0);
  const [newOpen, setNewOpen] = useState(false);
  const [addShiftOpen, setAddShiftOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [statusDraft, setStatusDraft] = useState<TaskStatus>("draft");
  const [statusBusy, setStatusBusy] = useState(false);

  const orgs = orgsState.data?.items ?? [];

  const tasks = useAsync(async () => {
    const query = orgFilter ? `?orgId=${encodeURIComponent(orgFilter)}` : "";
    return api.get<ListResponse<Task>>(`/tasks${query}`);
  }, [orgFilter, taskVersion]);

  const shifts = useAsync(
    async () =>
      taskId ? api.get<ListResponse<ShiftView>>(`/tasks/${encodeURIComponent(taskId)}/shifts`) : null,
    [taskId, shiftVersion],
  );

  const periods = usePeriodsState(terms.current?.id ?? null);
  const roles = useAsync(async () => api.get<ListResponse<Role>>("/roles"), []);

  const taskList = tasks.data?.items ?? [];
  const task = taskId ? (taskList.find((item) => item.id === taskId) ?? null) : null;
  const shiftList = useMemo(
    () => [...(shifts.data?.items ?? [])].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    [shifts.data],
  );

  useEffect(() => {
    if (task) setStatusDraft(task.status);
  }, [task]);

  function refreshTasks(): void {
    setTaskVersion((value) => value + 1);
  }

  function refreshShifts(): void {
    setShiftVersion((value) => value + 1);
    setTaskVersion((value) => value + 1);
  }

  async function saveStatus(): Promise<void> {
    if (!taskId) return;
    setStatusBusy(true);
    try {
      await api.patch(`/tasks/${encodeURIComponent(taskId)}`, { status: statusDraft });
      toast.success("任务状态已更新");
      refreshTasks();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setStatusBusy(false);
    }
  }

  const listColumns: Column<Task>[] = [
    {
      key: "title",
      header: "标题",
      render: (item) => (
        <div className="min-w-0">
          <p className="font-medium">{item.title}</p>
          {item.description ? <p className="truncate text-[11px] text-slate-400">{item.description}</p> : null}
        </div>
      ),
    },
    {
      key: "org",
      header: "部门",
      render: (item) => (item.orgId ? (orgs.find((org) => org.id === item.orgId)?.name ?? item.orgId) : "—"),
    },
    { key: "kind", header: "类型", render: (item) => taskKindLabel(item.kind) },
    {
      key: "status",
      header: "状态",
      render: (item) => <Badge tone={taskStatusTone(item.status)}>{taskStatusLabel(item.status)}</Badge>,
    },
    {
      key: "window",
      header: "时间窗",
      render: (item) => <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{windowText(item)}</span>,
    },
    {
      key: "action",
      header: "",
      className: "text-right",
      render: () => <span className="text-xs font-medium text-indigo-600 dark:text-indigo-400">打开</span>,
    },
  ];

  if (taskId) {
    return (
      <div className="space-y-4 sm:space-y-5">
        <a
          href="#/tasks"
          className="inline-flex items-center text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          ← 返回任务列表
        </a>

        {tasks.loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
            <Spinner size="sm" />
            加载任务…
          </div>
        ) : tasks.error ? (
          <Card title="任务详情">
            <ListState loading={false} error={tasks.error} empty={false} onRetry={tasks.reload}>
              <div />
            </ListState>
          </Card>
        ) : !task ? (
          <EmptyState
            title="找不到这个任务"
            description="它可能已被删除，或当前筛选条件下不可见。"
            action={
              <Button variant="secondary" size="sm" onClick={() => navigate("/tasks")}>
                返回列表
              </Button>
            }
          />
        ) : (
          <>
            <Card
              title={task.title}
              description={`${task.orgId ? (orgs.find((org) => org.id === task.orgId)?.name ?? "未知部门") : "未指定部门"} · ${taskKindLabel(task.kind)}`}
              actions={
                <>
                  <Button variant="secondary" size="sm" onClick={() => setGenerateOpen(true)}>
                    按周生成
                  </Button>
                  <Button size="sm" onClick={() => setAddShiftOpen(true)}>
                    加一个班次
                  </Button>
                </>
              }
            >
              <div className="grid gap-2 text-xs sm:grid-cols-3">
                <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
                  <span className="text-slate-500 dark:text-slate-400">时间窗</span>
                  <p className="mt-0.5 font-medium tabular-nums">{windowText(task)}</p>
                </div>
                <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
                  <span className="text-slate-500 dark:text-slate-400">状态</span>
                  <div className="mt-1 flex items-center gap-2">
                    <Select
                      value={statusDraft}
                      onChange={(event) => setStatusDraft(event.target.value as TaskStatus)}
                      className="w-28 py-1 text-xs"
                    >
                      {TASK_STATUS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={statusBusy}
                      disabled={statusDraft === task.status}
                      onClick={() => void saveStatus()}
                    >
                      保存
                    </Button>
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
                  <span className="text-slate-500 dark:text-slate-400">班次</span>
                  <p className="mt-0.5 text-base font-semibold tabular-nums">{shiftList.length}</p>
                </div>
              </div>
              {task.description ? (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{task.description}</p>
              ) : null}
            </Card>

            <Card
              title="班次"
              description="已排人员来自 assignment；撤销请到排班页。"
              actions={
                <Button variant="secondary" size="sm" onClick={() => setShiftVersion((value) => value + 1)}>
                  刷新
                </Button>
              }
            >
              <ListState
                loading={shifts.loading}
                error={shifts.error}
                empty={shiftList.length === 0}
                onRetry={shifts.reload}
                emptyTitle="还没有班次"
                emptyDescription="加一个具体时段，或按周批量生成整个学期。"
                emptyAction={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button size="sm" onClick={() => setAddShiftOpen(true)}>
                      加一个班次
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setGenerateOpen(true)}>
                      按周生成
                    </Button>
                  </div>
                }
              >
                <DataTable
                  columns={[
                    {
                      key: "time",
                      header: "时间",
                      render: (shift: ShiftView) => (
                        <div>
                          <p className="font-medium tabular-nums">
                            {dateFull(shift.startsAt)} {timeRange(shift.startsAt, shift.endsAt)}
                          </p>
                          <p className="text-[11px] text-slate-400">
                            {minutesText(durationMinutes(shift.startsAt, shift.endsAt))}
                            {shift.location ? ` · ${shift.location}` : ""}
                          </p>
                        </div>
                      ),
                    },
                    {
                      key: "people",
                      header: "人数",
                      render: (shift: ShiftView) => (
                        <span className="tabular-nums">
                          {shift.assignments?.length ?? 0}/{shift.requiredHeadcount}
                        </span>
                      ),
                    },
                    {
                      key: "status",
                      header: "状态",
                      render: (shift: ShiftView) => (
                        <Badge tone={shiftStatusTone(shift.status)}>{shiftStatusLabel(shift.status)}</Badge>
                      ),
                    },
                    {
                      key: "assigned",
                      header: "已排人员",
                      render: (shift: ShiftView) =>
                        (shift.assignments?.length ?? 0) === 0 ? (
                          <span className="text-xs text-slate-400">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {(shift.assignments ?? []).map((assignment) => (
                              <Badge key={assignment.id} tone="info">
                                {assignment.personName}
                              </Badge>
                            ))}
                          </div>
                        ),
                    },
                  ]}
                  rows={shiftList}
                  rowKey={(shift) => shift.id}
                  minWidth="min-w-[720px]"
                />
              </ListState>
            </Card>
          </>
        )}

        {task && addShiftOpen ? (
          <AddShiftModal
            task={task}
            roles={roles.data?.items ?? []}
            onClose={() => setAddShiftOpen(false)}
            onSaved={refreshShifts}
          />
        ) : null}

        {task && generateOpen ? (
          <GenerateShiftsModal
            task={task}
            periods={periods.data?.items ?? []}
            roles={roles.data?.items ?? []}
            onClose={() => setGenerateOpen(false)}
            onSaved={refreshShifts}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <Card
        title="任务"
        description="按部门筛选；点一行进入班次管理。"
        actions={
          <Button size="sm" onClick={() => setNewOpen(true)}>
            新建任务
          </Button>
        }
      >
        <div className="mb-3 grid gap-2 sm:grid-cols-[220px_1fr]">
          <Select value={orgFilter} onChange={(event) => setOrgFilter(event.target.value)} aria-label="按部门筛选">
            <option value="">全部部门</option>
            {orgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </Select>
          <div className="flex items-center justify-end">
            <Button variant="secondary" size="sm" onClick={() => tasks.reload()}>
              刷新
            </Button>
          </div>
        </div>

        {orgsState.error ? (
          <p className="mb-2 text-[11px] text-amber-600 dark:text-amber-400">组织加载失败：{orgsState.error}</p>
        ) : null}

        <ListState
          loading={tasks.loading}
          error={tasks.error}
          empty={taskList.length === 0}
          onRetry={tasks.reload}
          emptyTitle={orgFilter ? "该部门还没有任务" : "还没有任务"}
          emptyDescription="先建一个任务，再为它添加班次或按周生成。"
          emptyAction={
            <Button size="sm" onClick={() => setNewOpen(true)}>
              新建任务
            </Button>
          }
        >
          <DataTable
            columns={listColumns}
            rows={taskList}
            rowKey={(item) => item.id}
            onRowClick={(item) => navigate(`/tasks/${item.id}`)}
            minWidth="min-w-[760px]"
          />
        </ListState>
      </Card>

      {newOpen ? (
        <NewTaskModal
          orgs={orgs}
          onClose={() => setNewOpen(false)}
          onCreated={() => {
            refreshTasks();
          }}
        />
      ) : null}
    </div>
  );
}
