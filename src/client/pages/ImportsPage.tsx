import { SavedReports } from "../agent-import/SavedReports";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { Spinner } from "../components/Spinner";
import { cx } from "../lib/cx";
import { Stepper, LiveStatus, PeopleGrid } from "../agent-import/Progress";
import type { PersonWorkspace } from "../../shared/agent-import/person-workspace";
import { Modal } from "../components/Modal";
import { useSession } from "../components/AuthGate";
import { api, messageOf } from "../lib/api";
import {
  listJobs,
  saveJob,
  materials,
  addFiles,
  deleteJob,
  RETENTION,
  type Job,
} from "../agent-import/store";
import {
  ImportRunner,
  createJob,
  feedback,
  applyJob,
  checkJob,
  renewLease,
  chooseIdentity,
} from "../agent-import/runtime";
import { HistoryPanel } from "../agent-import/HistoryPanel";
import { Review } from "../agent-import/Review";
import { documentTool } from "../agent-import/documents";

export function ImportsPage() {
  const session = useSession();
  const owner = session?.user?.id ?? "";
  const [jobs, setJobs] = useState<Job[]>([]),
    [job, setJob] = useState<Job | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [comment, setComment] = useState(""),
    [dragging, setDragging] = useState(false),
    [stopping, setStopping] = useState(false),
    [sending, setSending] = useState(false),
    [source, setSource] = useState<{
      path: string;
      image?: string;
      text?: string;
      page?: number;
      pages?: number;
    } | null>(null),
    [issues, setIssues] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null),
    runner = useRef<ImportRunner | null>(null),
    current = useRef<Job | null>(null);
  current.current = job;
  const update = (next: Job) => {
    setJob({ ...next });
    setJobs((old) => [next, ...old.filter((j) => j.id !== next.id)]);
  };
  useEffect(() => {
    if (owner)
      listJobs(owner)
        .then(setJobs)
        .catch((e) => setError(messageOf(e)));
    const timer = setInterval(() => {
      if (owner)
        void listJobs(owner).then((rows) => {
          setJobs(rows);
          const active = current.current;
          if (active?.expiresAt && active.expiresAt <= Date.now()) {
            runner.current?.stop();
            setJob(null);
          }
        });
    }, 60000);
    return () => {
      clearInterval(timer);
      runner.current?.stop();
    };
  }, [owner]);
  useEffect(() => {
    if (!job || !["running", "review"].includes(job.status)) return;
    const timer = setInterval(() => {
      void renewLease(current.current!).catch((e) => {
        runner.current?.stop();
        setError("相关数据锁续期失败：" + messageOf(e));
      });
    }, 45000);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  useEffect(() => {
    if (job?.status !== "running") setStopping(false);
  }, [job?.status]);
  useEffect(() => {
    if (!job || job.status === "running") return;
    void checkJob(job)
      .then((r) => setIssues(r.issues.map((x) => x.message)))
      .catch((e) => setIssues([messageOf(e)]));
  }, [job?.id, job?.revision, job?.status]);
  const run = (value: Job) => {
    runner.current = new ImportRunner(value, update);
    void runner.current.run();
  };
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    setError("");
    try {
      let value = job;
      if (value && !["applied", "cancelled"].includes(value.status)) {
        runner.current?.stop();
        if (value.status === "running") throw Error("请先暂停处理，再追加材料");
        await addFiles(value, files);
      } else value = await createJob(owner, files);
      update(value);
      run(value);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const onSource = async (path: string, page = 1) => {
    if (path === "现有数据") {
      setSource({
        path,
        text: "来自本批开始时读取的正式数据；具体记录和修改前后差异可在变更明细中查看。",
      });
      return;
    }
    if (path === "操作员意见") {
      setSource({
        path,
        text: job?.notes["最近操作员意见"] ?? "操作员在审核界面直接编辑。",
      });
      return;
    }
    if (!job) return;
    setBusy(true);
    try {
      const files = await materials(job.id);
      if (!files.some((f) => f.path === path)) {
        const children = files.filter((f) =>
          f.path.startsWith(path.replace(/\/$/, "") + "/"),
        );
        if (children.length) {
          setSource({
            path,
            text:
              "目录名称作为来源依据；目录中的材料：\n" +
              children.map((f) => f.path).join("\n"),
          });
          return;
        }
      }
      const result = await documentTool(job, "read_document", {
        path,
        page,
        offset: 0,
      });
      const info = result.result as {
        pages?: number;
        content?: { pages?: number };
      };
      setSource({
        path,
        page,
        pages: info.pages ?? info.content?.pages,
        image: result.image,
        text: result.image ? undefined : JSON.stringify(result.result, null, 2),
      });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      await applyJob(job);
      update(job);
    } catch (e) {
      setError(messageOf(e));
      update(job);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!job) return;
    runner.current?.stop();
    setBusy(true);
    try {
      await api.post(`/agent-imports/${job.id}/cancel`);
      job.status = "cancelled";
      job.expiresAt = Date.now() + RETENTION;
      await saveJob(job);
      update(job);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const pause = () => {
    setStopping(true);
    runner.current?.stop();
  };
  const back = () => {
    setJob(null);
    setIssues([]);
    setError("");
  };
  const sendFeedback = async () => {
    if (!job || !comment.trim()) return;
    setSending(true);
    try {
      await feedback(job, comment);
      setComment("");
      run(job);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSending(false);
    }
  };
  const identity = (p: PersonWorkspace) =>
    job &&
    p.match &&
    !p.match.id &&
    p.match.candidates.length > 0 &&
    job.status !== "running" ? (
      <select
        aria-label={`确认${p.label}身份`}
        className="mt-2 w-full rounded-lg border border-rose-300 bg-white px-2 py-1.5 text-xs dark:border-rose-500/40 dark:bg-slate-900"
        value=""
        onChange={(e) => {
          void chooseIdentity(
            job,
            p.key,
            e.target.value === "new" ? null : e.target.value,
          )
            .then(() => update(job))
            .catch((e) => setError(messageOf(e)));
        }}
      >
        <option value="" disabled>
          确认是谁…
        </option>
        {p.match.candidates.map((id) => {
          const row = job.base.person.find((row) => row.id === id);
          return (
            <option key={id} value={id}>
              {[row?.full_name, row?.student_no, row?.class_name]
                .filter(Boolean)
                .map(String)
                .join(" · ")}
            </option>
          );
        })}
        <option value="new">另一位新人员</option>
      </select>
    ) : null;
  const editable = job && ["paused", "review"].includes(job.status);
  return (
    <div className="max-w-5xl pb-8">
      <input
        ref={input}
        type="file"
        multiple
        className="sr-only"
        aria-label="选择导入材料"
        onChange={(e) => void upload(Array.from(e.target.files ?? []))}
      />
      {!job ? (
        <div className="space-y-10">
          <section
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void upload(Array.from(e.dataTransfer.files));
            }}
            className={cx(
              "group relative grid min-h-80 place-items-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors duration-200",
              dragging
                ? "border-indigo-600 bg-indigo-50 dark:bg-indigo-600/10"
                : "border-slate-300 bg-white hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900",
            )}
          >
            <div className="flex flex-col items-center">
              <span
                className={cx(
                  "grid size-14 place-items-center rounded-2xl transition duration-300 ease-out",
                  dragging
                    ? "-translate-y-1 scale-110 bg-indigo-600 text-white"
                    : "bg-indigo-50 text-indigo-600 dark:bg-indigo-600/15",
                )}
              >
                {busy ? (
                  <Spinner />
                ) : (
                  <Icon name="imports" className="size-7" />
                )}
              </span>
              <h2 className="mt-5 text-lg font-semibold">
                {busy ? "正在打开材料" : dragging ? "松开即可开始" : "拖入材料"}
              </h2>
              <p className="mt-1.5 text-sm text-slate-500">
                压缩包、课表、名单都行，无需整理
              </p>
              <Button
                className="mt-6"
                loading={busy}
                onClick={() => input.current?.click()}
              >
                选择文件
              </Button>
              <p className="mt-5 text-xs text-slate-400">
                ZIP · RAR · 7z · Office · PDF · 图片 · ≤100 MB
              </p>
            </div>
          </section>
          {error && <ErrorLine text={error} />}
          {jobs.length > 0 && (
            <section aria-labelledby="recent-imports">
              <h2 id="recent-imports" className="mb-3 text-sm font-semibold">
                最近导入
              </h2>
              <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                {jobs.map((j) => (
                  <li key={j.id} className="group/row flex items-center">
                    <button
                      className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/60"
                      onClick={() => {
                        if (j.status === "running") j.status = "paused";
                        update(j);
                      }}
                    >
                      <Icon name="file" className="size-4 shrink-0 text-slate-400" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{j.title}</span>
                        <span className="text-xs text-slate-400">
                          {new Date(j.createdAt).toLocaleString("zh-CN", {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </span>
                      <StatusChip status={j.status} />
                    </button>
                    {["applied", "cancelled"].includes(j.status) && (
                      <button
                        aria-label={`清理 ${j.title}`}
                        title="立即清理"
                        className="mr-2 grid size-8 place-items-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                        onClick={async () => {
                          await deleteJob(j.id);
                          setJobs(await listJobs(owner));
                        }}
                      >
                        <Icon name="trash" className="size-4" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <SavedReports />
        </div>
      ) : (
        <section className="space-y-5">
          {/* Controls stay reachable while scrolling a long people grid. */}
          <header className="sticky top-16 z-20 -mx-4 flex flex-wrap items-center gap-3 bg-slate-50/90 px-4 py-2 backdrop-blur md:-mx-8 md:px-8 dark:bg-slate-950/90">
            <button
              aria-label="返回导入"
              title="返回"
              disabled={job.status === "running" || busy}
              onClick={back}
              className="grid size-9 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40 dark:hover:bg-slate-800"
            >
              <Icon name="chevron-left" />
            </button>
            <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">
              {job.title}
            </h2>
            <StatusChip status={job.status} />
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              {job.status === "running" && (
                <Button
                  variant="secondary"
                  loading={stopping}
                  onClick={pause}
                >
                  {!stopping && <Icon name="pause" className="size-4" />}
                  {stopping ? "正在暂停" : "暂停"}
                </Button>
              )}
              {editable && (
                <>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void cancel()}
                  >
                    取消导入
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => input.current?.click()}
                  >
                    <Icon name="plus" className="size-4" />
                    补充材料
                  </Button>
                  <Button
                    variant={job.status === "paused" ? "primary" : "secondary"}
                    disabled={busy || !job.session}
                    onClick={() => run(job)}
                  >
                    <Icon name="play" className="size-4" />
                    {job.status === "review" ? "继续自查" : "继续处理"}
                  </Button>
                </>
              )}
            </div>
          </header>

          {job.status === "applied" ? (
            <div className="grid place-items-center rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center dark:border-slate-800 dark:bg-slate-900">
              <span className="rota-pop grid size-14 place-items-center rounded-full bg-emerald-600 text-white">
                <Icon name="check" className="size-7" />
              </span>
              <p className="mt-4 text-lg font-semibold">已导入</p>
              <Button className="mt-6" variant="secondary" onClick={back}>
                新的导入
              </Button>
            </div>
          ) : (
            job.status !== "cancelled" && (
              <div className="space-y-5 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 dark:border-slate-800 dark:bg-slate-900">
                <Stepper job={job} />
                {job.session && (
                  <div className="border-t border-slate-100 pt-4 dark:border-slate-800">
                    <LiveStatus job={job} />
                  </div>
                )}
              </div>
            )
          )}

          {!job.session && (
            <p role="alert" className="text-sm text-slate-500">
              旧版批次，仅可查看。请用原材料重新导入。
            </p>
          )}
          {job.error && <ErrorLine text={job.error} />}
          {error && <ErrorLine text={error} />}

          {job.status !== "applied" && <PeopleGrid job={job} identity={identity} />}

          {!!job.unresolved.length && (
            <details className="group rounded-xl bg-amber-50 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 font-medium [&::-webkit-details-marker]:hidden">
                <Icon name="alert" className="size-4" />
                待补 {new Set(job.unresolved).size} 项
                <Icon
                  name="chevron-down"
                  className="ml-auto size-4 transition group-open:rotate-180"
                />
              </summary>
              <ul className="list-disc space-y-1 px-4 pb-4 pl-9">
                {[...new Set(job.unresolved)].map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </details>
          )}
          {job.status !== "running" && (
            <Review
              job={job}
              onChange={(next) => {
                void saveJob(next);
                update(next);
              }}
              onSource={(path) => void onSource(path)}
            />
          )}

          {editable && (
            <div className="sticky bottom-14 z-10 -mx-4 border-t border-slate-200 bg-slate-50/95 px-4 py-3 backdrop-blur md:bottom-0 md:mx-0 md:rounded-xl md:border dark:border-slate-800 dark:bg-slate-950/95">
              {!!issues.length && (
                <div role="alert" className="mb-3 flex gap-2 text-xs text-rose-700 dark:text-rose-300">
                  <Icon name="alert" className="mt-px size-4 shrink-0" />
                  <ul className="space-y-0.5">
                    {issues.slice(0, 4).map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                    {issues.length > 4 && <li>还有 {issues.length - 4} 项</li>}
                  </ul>
                </div>
              )}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex flex-1 items-end gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900">
                  <label htmlFor="import-feedback" className="sr-only">
                    修改意见
                  </label>
                  <textarea
                    id="import-feedback"
                    rows={1}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void sendFeedback();
                      }
                    }}
                    placeholder="告诉 Agent 要改什么，例如：第一周从 9 月 7 日开始"
                    className="field-sizing-content max-h-32 min-h-7 flex-1 resize-none bg-transparent py-1 text-sm outline-none placeholder:text-slate-400"
                  />
                  <button
                    aria-label="让 Agent 修改"
                    title="发送（Enter）"
                    disabled={!comment.trim() || busy || sending}
                    onClick={() => void sendFeedback()}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-indigo-600 transition hover:bg-indigo-50 disabled:text-slate-300 disabled:hover:bg-transparent dark:hover:bg-indigo-600/15 dark:disabled:text-slate-700"
                  >
                    {sending ? <Spinner size="sm" /> : <Icon name="send" className="size-4" />}
                  </button>
                </div>
                {job.status === "review" && (
                  <Button
                    loading={busy}
                    disabled={!!issues.length || !job.session}
                    onClick={() => void finish()}
                    className="sm:py-2.5"
                  >
                    {!busy && <Icon name="check" className="size-4" />}
                    确认导入
                  </Button>
                )}
              </div>
            </div>
          )}
          <HistoryPanel job={job} />
        </section>
      )}
      {source && (
        <Modal onClose={() => setSource(null)} title="查看来源" size="lg">
          <p className="mb-3 break-all text-sm">{source?.path}</p>
          {source.pages && source.pages > 1 && (
            <div className="mb-4 flex items-center gap-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || source.page === 1}
                onClick={() =>
                  void onSource(source.path, (source.page ?? 1) - 1)
                }
              >
                上一页
              </Button>
              <span className="text-sm tabular-nums">
                {source.page} / {source.pages}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || source.page === source.pages}
                onClick={() =>
                  void onSource(source.path, (source.page ?? 1) + 1)
                }
              >
                下一页
              </Button>
            </div>
          )}
          {source?.image ? (
            <img
              src={source.image}
              alt={source.path}
              className="h-auto w-full"
            />
          ) : (
            <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words text-xs">
              {source?.text}
            </pre>
          )}
        </Modal>
      )}
    </div>
  );
}

const STATUS_CHIP: Record<Job["status"], [string, string]> = {
  running: ["处理中", "bg-indigo-50 text-indigo-700 dark:bg-indigo-600/15 dark:text-indigo-300"],
  paused: ["已暂停", "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"],
  review: ["待确认", "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"],
  applied: ["已导入", "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"],
  cancelled: ["已取消", "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"],
};

function StatusChip({ status }: { status: Job["status"] }) {
  const [label, tone] = STATUS_CHIP[status];
  return (
    <span className={cx("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium", tone)}>
      {label}
    </span>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p
      role="alert"
      className="flex gap-2 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
    >
      <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}
