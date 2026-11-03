import { PeopleImport } from "../components/PeopleImport";
import { useEffect, useState } from "react";
import type {
  ImportJob,
  ImportSourceKind,
  ListResponse,
  ParsedCourse,
  ParsedMeeting,
  ParsedTimetable,
  PersonView,
  WeekPatternKind,
} from "../../shared/types";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Field, Select, TextInput } from "../components/Field";
import { ListState } from "../components/ListState";
import { Spinner } from "../components/Spinner";
import { DataTable, type Column } from "../components/Table";
import { useToast } from "../components/Toast";
import { api, messageOf } from "../lib/api";
import { WEEKDAYS, dateTimeText, weekdayName } from "../lib/format";
import { useAsync } from "../lib/hooks";
import {
  IMPORT_SOURCE_OPTIONS,
  WEEK_PATTERN_OPTIONS,
  importSourceLabel,
  importStatusLabel,
  importStatusTone,
} from "../lib/labels";
import { useTermsState } from "../lib/resources";

function fileAccept(kind: ImportSourceKind): string {
  switch (kind) {
    case "excel":
      return ".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "csv":
      return ".csv,text/csv";
    case "ics":
      return ".ics,text/calendar";
    case "screenshot":
      return "image/*";
    default:
      return "";
  }
}

export function ImportsPage() {
  const [tab, setTab] = useState("timetable");
  const toast = useToast();
  const terms = useTermsState();
  const persons = useAsync(
    async () => api.get<ListResponse<PersonView>>("/persons"),
    [],
  );

  const [termId, setTermId] = useState("");
  const [personId, setPersonId] = useState("");
  const [sourceKind, setSourceKind] = useState<ImportSourceKind>("excel");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const [historyVersion, setHistoryVersion] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [draft, setDraft] = useState<ParsedTimetable | null>(null);
  const [applying, setApplying] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    if (!termId && terms.current) setTermId(terms.current.id);
  }, [terms.current, termId]);

  const history = useAsync(
    async () => api.get<ListResponse<ImportJob>>("/imports"),
    [historyVersion],
  );

  useEffect(() => {
    const parsed = job?.parsed ?? null;
    setDraft(
      parsed
        ? {
            ...parsed,
            courses: (parsed.courses ?? []).map((course) => ({
              ...course,
              meetings: course.meetings ?? [],
            })),
            warnings: parsed.warnings ?? [],
          }
        : null,
    );
  }, [job?.id, job?.parsed]);

  // 解析是异步的：uploaded/parsing 时每 2 秒轮询一次。
  useEffect(() => {
    if (!job) return;
    if (job.status !== "parsing" && job.status !== "uploaded") return;

    let alive = true;
    const timer = window.setInterval(() => {
      void api
        .get<ImportJob>(`/imports/${encodeURIComponent(job.id)}`)
        .then((next) => {
          if (!alive) return;
          setJob(next);
          if (
            next.status === "needs_review" ||
            next.status === "applied" ||
            next.status === "failed"
          ) {
            window.clearInterval(timer);
            setHistoryVersion((value) => value + 1);
          }
        })
        .catch((error: unknown) => {
          if (!alive) return;
          window.clearInterval(timer);
          toast.error(`查询解析状态失败：${messageOf(error)}`);
        });
    }, 2000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status, toast]);

  async function upload(): Promise<void> {
    if (!file) {
      toast.error("请选择要上传的文件");
      return;
    }
    if (!termId) {
      toast.error("请选择学期");
      return;
    }

    const form = new FormData();
    form.append("file", file);
    form.append("sourceKind", sourceKind);
    form.append("termId", termId);
    if (personId) form.append("personId", personId);

    setUploading(true);
    try {
      const created = await api.post<ImportJob>("/imports", form);
      setJob(created);
      setHistoryVersion((value) => value + 1);
      toast.success("已上传，正在解析…");
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setUploading(false);
    }
  }

  async function openJob(id: string): Promise<void> {
    setOpeningId(id);
    try {
      const detail = await api.get<ImportJob>(
        `/imports/${encodeURIComponent(id)}`,
      );
      setJob(detail);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setOpeningId(null);
    }
  }

  function updateCourse(index: number, patch: Partial<ParsedCourse>): void {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            courses: previous.courses.map((course, i) =>
              i === index ? { ...course, ...patch } : course,
            ),
          }
        : previous,
    );
  }

  function updateMeeting(
    courseIndex: number,
    meetingIndex: number,
    patch: Partial<ParsedMeeting>,
  ): void {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            courses: previous.courses.map((course, i) =>
              i === courseIndex
                ? {
                    ...course,
                    meetings: course.meetings.map((meeting, j) =>
                      j === meetingIndex ? { ...meeting, ...patch } : meeting,
                    ),
                  }
                : course,
            ),
          }
        : previous,
    );
  }

  function removeMeeting(courseIndex: number, meetingIndex: number): void {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            courses: previous.courses.map((course, i) =>
              i === courseIndex
                ? {
                    ...course,
                    meetings: course.meetings.filter(
                      (_, j) => j !== meetingIndex,
                    ),
                  }
                : course,
            ),
          }
        : previous,
    );
  }

  function addMeeting(courseIndex: number): void {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            courses: previous.courses.map((course, i) =>
              i === courseIndex
                ? {
                    ...course,
                    meetings: [
                      ...course.meetings,
                      {
                        weekday: 1,
                        periodFrom: 1,
                        periodTo: 1,
                        patternKind: "all",
                        weekRanges: null,
                        location: null,
                      },
                    ],
                  }
                : course,
            ),
          }
        : previous,
    );
  }

  function removeCourse(index: number): void {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            courses: previous.courses.filter((_, i) => i !== index),
          }
        : previous,
    );
  }

  async function apply(): Promise<void> {
    if (!job || !draft) return;
    setApplying(true);
    try {
      // 注意：后端 apply 的请求体契约尚未在 docs/API.md 里细化，这里按「覆盖 parsed」的直觉发送。
      await api.post(`/imports/${encodeURIComponent(job.id)}/apply`, {
        parsed: draft,
        overwrite: false,
      });
      toast.success("解析结果已落库");
      setHistoryVersion((value) => value + 1);
      try {
        const next = await api.get<ImportJob>(
          `/imports/${encodeURIComponent(job.id)}`,
        );
        setJob(next);
      } catch {
        setJob((previous) =>
          previous
            ? { ...previous, status: "applied", parsed: draft }
            : previous,
        );
      }
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setApplying(false);
    }
  }

  const historyColumns: Column<ImportJob>[] = [
    {
      key: "created",
      header: "上传时间",
      render: (item) => (
        <span className="text-xs tabular-nums">
          {dateTimeText(item.createdAt)}
        </span>
      ),
    },
    {
      key: "kind",
      header: "类型",
      render: (item) => (
        <span className="text-xs">{importSourceLabel(item.sourceKind)}</span>
      ),
    },
    {
      key: "file",
      header: "文件",
      render: (item) => (
        <span
          className="block max-w-[220px] truncate text-xs"
          title={item.fileName ?? undefined}
        >
          {item.fileName ?? "—"}
        </span>
      ),
    },
    {
      key: "status",
      header: "状态",
      render: (item) => (
        <Badge tone={importStatusTone(item.status)}>
          {importStatusLabel(item.status)}
        </Badge>
      ),
    },
    {
      key: "action",
      header: "",
      className: "text-right",
      render: (item) => (
        <Button
          variant="ghost"
          size="sm"
          loading={openingId === item.id}
          onClick={() => void openJob(item.id)}
        >
          查看
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4 sm:space-y-5">
      <nav aria-label="导入类型" className="flex gap-2">
        <Button
          variant={tab === "timetable" ? "secondary" : "ghost"}
          onClick={() => setTab("timetable")}
        >
          课表导入
        </Button>
        <Button
          variant={tab === "people" ? "secondary" : "ghost"}
          onClick={() => setTab("people")}
        >
          人员导入
        </Button>
      </nav>
      {tab === "people" && <PeopleImport />}
      <div hidden={tab !== "timetable"} className="space-y-5">
        <Card
          title="上传课表"
          description="结构化文件直接解析；截图走视觉模型。解析结果必须先人工确认才落库。"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="文件"
              required
              hint={
                fileAccept(sourceKind)
                  ? `支持 ${fileAccept(sourceKind)}`
                  : undefined
              }
            >
              <input
                type="file"
                accept={fileAccept(sourceKind)}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="block w-full rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-indigo-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 dark:file:bg-indigo-500/15 dark:file:text-indigo-300"
              />
            </Field>
            <Field label="文件类型">
              <Select
                value={sourceKind}
                onChange={(event) => {
                  setSourceKind(event.target.value as ImportSourceKind);
                  setFile(null);
                }}
              >
                {IMPORT_SOURCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="学期" required>
              <Select
                value={termId}
                onChange={(event) => setTermId(event.target.value)}
              >
                <option value="">选择学期</option>
                {terms.terms.map((term) => (
                  <option key={term.id} value={term.id}>
                    {term.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="对应人员" hint="截图导入时建议指定">
              <Select
                value={personId}
                onChange={(event) => setPersonId(event.target.value)}
              >
                <option value="">不指定</option>
                {(persons.data?.items ?? []).map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.fullName}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {terms.error ? (
            <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
              学期加载失败：{terms.error}
            </p>
          ) : null}
          {persons.error ? (
            <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
              人员加载失败：{persons.error}
            </p>
          ) : null}
          {!terms.loading && terms.terms.length === 0 ? (
            <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
              还没有学期。导入的课程必须挂在学期下，请先到「学期」页创建。
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-slate-400">
              上传后后端解析，状态变为「待确认」后即可逐条修改。
            </p>
            <Button
              loading={uploading}
              disabled={!file || !termId}
              onClick={() => void upload()}
            >
              上传并解析
            </Button>
          </div>
        </Card>

        {job ? (
          <Card
            title="解析结果"
            description={`${importSourceLabel(job.sourceKind)} · ${job.fileName ?? "未命名文件"}`}
            actions={
              <>
                <Badge tone={importStatusTone(job.status)}>
                  {importStatusLabel(job.status)}
                </Badge>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!job.parsed}
                  onClick={() => setDraft(job.parsed)}
                >
                  重置为解析结果
                </Button>
              </>
            }
          >
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
              <span>创建：{dateTimeText(job.createdAt)}</span>
              {job.updatedAt ? (
                <span>更新：{dateTimeText(job.updatedAt)}</span>
              ) : null}
              {draft?.personName ? (
                <Badge tone="info">人员：{draft.personName}</Badge>
              ) : null}
            </div>

            {job.status === "uploaded" || job.status === "parsing" ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
                <Spinner size="sm" />
                解析中…页面会自动刷新状态
              </div>
            ) : job.status === "failed" ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm dark:border-rose-500/30 dark:bg-rose-500/10">
                <p className="font-medium text-rose-700 dark:text-rose-300">
                  解析失败
                </p>
                <p className="mt-1 text-xs break-words text-rose-600 dark:text-rose-300/90">
                  {job.error ?? "后端没有返回具体原因"}
                </p>
              </div>
            ) : draft ? (
              <div className="space-y-4">
                {draft.warnings.length > 0 ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                    <p className="font-medium">解析提示</p>
                    <ul className="mt-1 list-inside list-disc space-y-0.5">
                      {draft.warnings.map((warning) => (
                        <li key={warning} className="break-words">
                          {warning}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {draft.courses.length === 0 ? (
                  <EmptyState
                    title="没有解析出课程"
                    description="可以重新上传更清晰的文件，或手工在课表页添加。"
                  />
                ) : (
                  <div className="space-y-3">
                    {draft.courses.map((course, courseIndex) => (
                      <div
                        key={courseIndex}
                        className="rounded-xl border border-slate-200 p-3 dark:border-slate-800"
                      >
                        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                          <Field label="课程名">
                            <TextInput
                              value={course.name}
                              onChange={(event) =>
                                updateCourse(courseIndex, {
                                  name: event.target.value,
                                })
                              }
                            />
                          </Field>
                          <Field label="教师">
                            <TextInput
                              value={course.teacher ?? ""}
                              onChange={(event) =>
                                updateCourse(courseIndex, {
                                  teacher: event.target.value,
                                })
                              }
                            />
                          </Field>
                          <div className="flex items-end justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={job.status === "applied"}
                              onClick={() => removeCourse(courseIndex)}
                            >
                              移除课程
                            </Button>
                          </div>
                        </div>

                        <div className="mt-2 space-y-2">
                          {course.meetings.map((meeting, meetingIndex) => (
                            <div
                              key={meetingIndex}
                              className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-2 sm:grid-cols-3 lg:grid-cols-6 dark:bg-slate-800/40"
                            >
                              <Field label="星期">
                                <Select
                                  value={meeting.weekday}
                                  onChange={(event) =>
                                    updateMeeting(courseIndex, meetingIndex, {
                                      weekday: Number(event.target.value),
                                    })
                                  }
                                >
                                  {WEEKDAYS.map((day) => (
                                    <option key={day} value={day}>
                                      {weekdayName(day)}
                                    </option>
                                  ))}
                                </Select>
                              </Field>
                              <Field label="起始节">
                                <TextInput
                                  type="number"
                                  min={1}
                                  value={meeting.periodFrom}
                                  onChange={(event) =>
                                    updateMeeting(courseIndex, meetingIndex, {
                                      periodFrom: Number(event.target.value),
                                    })
                                  }
                                />
                              </Field>
                              <Field label="结束节">
                                <TextInput
                                  type="number"
                                  min={1}
                                  value={meeting.periodTo}
                                  onChange={(event) =>
                                    updateMeeting(courseIndex, meetingIndex, {
                                      periodTo: Number(event.target.value),
                                    })
                                  }
                                />
                              </Field>
                              <Field label="周次模式">
                                <Select
                                  value={meeting.patternKind}
                                  onChange={(event) =>
                                    updateMeeting(courseIndex, meetingIndex, {
                                      patternKind: event.target
                                        .value as WeekPatternKind,
                                    })
                                  }
                                >
                                  {WEEK_PATTERN_OPTIONS.map((option) => (
                                    <option
                                      key={option.value}
                                      value={option.value}
                                    >
                                      {option.label}
                                    </option>
                                  ))}
                                </Select>
                              </Field>
                              {meeting.patternKind === "ranges" ? (
                                <Field label="周次范围">
                                  <TextInput
                                    value={meeting.weekRanges ?? ""}
                                    onChange={(event) =>
                                      updateMeeting(courseIndex, meetingIndex, {
                                        weekRanges: event.target.value,
                                      })
                                    }
                                    placeholder="1-8"
                                  />
                                </Field>
                              ) : null}
                              <Field label="地点">
                                <TextInput
                                  value={meeting.location ?? ""}
                                  onChange={(event) =>
                                    updateMeeting(courseIndex, meetingIndex, {
                                      location: event.target.value,
                                    })
                                  }
                                  placeholder="可选"
                                />
                              </Field>
                              <div className="col-span-2 flex items-end justify-end sm:col-span-3 lg:col-span-6">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={job.status === "applied"}
                                  onClick={() =>
                                    removeMeeting(courseIndex, meetingIndex)
                                  }
                                >
                                  删除这条规则
                                </Button>
                              </div>
                            </div>
                          ))}
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={job.status === "applied"}
                            onClick={() => addMeeting(courseIndex)}
                          >
                            加一条上课规则
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <p className="text-[11px] text-slate-400">
                    确认后会把课程、选课与上课规则写入数据库。
                  </p>
                  <Button
                    loading={applying}
                    disabled={
                      job.status === "applied" || draft.courses.length === 0
                    }
                    onClick={() => void apply()}
                  >
                    {job.status === "applied" ? "已落库" : "确认落库"}
                  </Button>
                </div>
              </div>
            ) : (
              <EmptyState
                title="没有解析结果"
                description="后端已返回但 parsed 为空，可以重新上传。"
              />
            )}
          </Card>
        ) : null}

        <Card
          title="导入历史"
          description="最近 50 条；点「查看」载入解析结果。"
        >
          <ListState
            loading={history.loading}
            error={history.error}
            empty={(history.data?.items.length ?? 0) === 0}
            onRetry={history.reload}
            emptyTitle="还没有导入记录"
            emptyDescription="上传第一份课表后，这里会出现解析状态与结果。"
          >
            <DataTable
              columns={historyColumns}
              rows={history.data?.items ?? []}
              rowKey={(item) => item.id}
              minWidth="min-w-[680px]"
            />
          </ListState>
        </Card>
      </div>
    </div>
  );
}
