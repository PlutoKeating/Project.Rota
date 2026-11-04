import { SavedReports } from "../agent-import/SavedReports";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { Textarea } from "../components/Field";
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
  return (
    <div className="mx-auto max-w-5xl space-y-8 pb-8">
      <input
        ref={input}
        type="file"
        multiple
        className="sr-only"
        aria-label="选择导入材料"
        onChange={(e) => void upload(Array.from(e.target.files ?? []))}
      />
      {!job ? (
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
          className={`grid min-h-72 place-items-center rounded-2xl border border-dashed px-6 py-12 text-center ${dragging ? "border-indigo-600 bg-indigo-50" : "border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900"}`}
        >
          <div>
            <h2 className="text-lg font-medium">拖入一个压缩包，或选择文件</h2>
            <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-500">
              课表、名单、说明文档都可以。保留原来的文件夹和文件名，无需提前整理。
            </p>
            <Button
              className="mt-6"
              loading={busy}
              onClick={() => input.current?.click()}
            >
              选择材料
            </Button>
            <p className="mt-4 text-xs text-slate-500">
              支持 ZIP、RAR、7z、TAR/GZ、图片及 Office/PDF · 单次最多 100 MB
            </p>
          </div>
        </section>
      ) : (
        <section className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="break-all text-lg font-medium">{job.title}</h2>
              <p
                role="status"
                aria-live="polite"
                className="mt-2 text-sm text-slate-500"
              >
                {
                  {
                    running: "正在整理材料，尚未写入正式数据",
                    paused: "进度已保存，可以继续处理",
                    review: "整理完成，请复核后导入",
                    applied: "已导入，材料将在完成后 8 小时清理",
                    cancelled: "已取消，材料将在 8 小时后清理",
                  }[job.status]
                }
              </p>
            </div>
            <Button
              variant="ghost"
              disabled={job.status === "running" || busy}
              onClick={() => {
                setJob(null);
                setIssues([]);
                setError("");
              }}
            >
              返回导入
            </Button>
          </div>
          {job.status === "running" && (
            <div className="border-y border-slate-200 py-5 dark:border-slate-700">
              <p className="text-sm">
                {job.phase || "正在查看材料与现有数据…"}
              </p>
              <p className="mt-2 text-xs text-slate-500">
                {job.model ? `${job.model} · ` : ""}已完成 {job.turns} 轮 ·
                已保存 {Object.keys(job.timetables ?? {}).length} 份课表方案（
                {Object.values(job.timetables ?? {}).reduce(
                  (sum, t) => sum + t.entries.length,
                  0,
                )}{" "}
                条课程记录），{Object.keys(job.observations ?? {}).length}{" "}
                份材料笔记。关闭页面会暂停，重新打开后可恢复。
                {job.requestStartedAt && (
                  <RequestClock startedAt={job.requestStartedAt} />
                )}
              </p>
              <Button
                className="mt-4"
                variant="secondary"
                onClick={() => runner.current?.stop()}
              >
                完成当前步骤后暂停
              </Button>
            </div>
          )}
          {job.error && (
            <p
              role="alert"
              className="text-sm text-rose-700 dark:text-rose-300"
            >
              {job.error}
            </p>
          )}
          {["paused", "review"].includes(job.status) && (
            <div className="flex flex-wrap gap-3">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => run(job)}
              >
                {job.status === "review" ? "继续自查" : "继续处理"}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => input.current?.click()}
              >
                补充材料
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void cancel()}
              >
                取消本次导入
              </Button>
            </div>
          )}
          {job.summary && (
            <p className="max-w-3xl whitespace-pre-wrap text-sm leading-7">
              {job.summary}
            </p>
          )}
          {!!job.unresolved.length && (
            <div className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <p className="font-medium">需要留意</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {job.unresolved.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
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
          {!!issues.length && (
            <div
              role="alert"
              className="text-sm text-rose-700 dark:text-rose-300"
            >
              <p>提交前需要解决：</p>
              <ul className="mt-2 list-disc pl-5">
                {issues.slice(0, 20).map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          {["paused", "review"].includes(job.status) && (
            <div className="space-y-3 border-t border-slate-200 pt-5">
              <label htmlFor="import-feedback" className="text-sm font-medium">
                补充说明或修改意见
              </label>
              <Textarea
                id="import-feedback"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="例如：这两张图是同一个人；第一周从 9 月 7 日开始。"
                rows={3}
              />
              <div className="flex flex-wrap justify-between gap-3">
                <Button
                  variant="secondary"
                  disabled={!comment.trim() || busy}
                  onClick={async () => {
                    await feedback(job, comment);
                    setComment("");
                    run(job);
                  }}
                >
                  让 Agent 修改
                </Button>
                {job.status === "review" && (
                  <Button
                    loading={busy}
                    disabled={!!issues.length}
                    onClick={() => void finish()}
                  >
                    审核无误，导入全部选中内容
                  </Button>
                )}
              </div>
            </div>
          )}
          <HistoryPanel job={job} />
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer">
              处理记录 · {job.log.length} 条
            </summary>
            <ol className="mt-3 max-h-64 space-y-2 overflow-auto">
              {job.log.map((item, i) => (
                <li key={i} className="break-words">
                  <time>{new Date(item.at).toLocaleTimeString()}</time>{" "}
                  {item.text}
                </li>
              ))}
            </ol>
          </details>
        </section>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
          {error}
        </p>
      )}
      {!job && jobs.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-slate-600 dark:text-slate-300">
            本机最近导入 · {jobs.length} 批
          </summary>
          <ul className="mt-4 divide-y divide-slate-200 dark:divide-slate-700">
            {jobs.map((j) => (
              <li
                key={j.id}
                className="flex items-center justify-between gap-3 py-3"
              >
                <button
                  className="min-w-0 text-left text-sm underline-offset-4 hover:underline"
                  onClick={() => {
                    if (j.status === "running") j.status = "paused";
                    update(j);
                  }}
                >
                  <span className="block break-all">{j.title}</span>
                  <span className="text-xs text-slate-500">
                    {new Date(j.createdAt).toLocaleString()} ·{" "}
                    {
                      {
                        paused: "已暂停",
                        running: "可恢复",
                        review: "待复核",
                        applied: "已导入",
                        cancelled: "已取消",
                      }[j.status]
                    }
                  </span>
                </button>
                {["applied", "cancelled"].includes(j.status) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      await deleteJob(j.id);
                      setJobs(await listJobs(owner));
                    }}
                  >
                    立即清理
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!job && <SavedReports />}
      <p className="text-xs leading-5 text-slate-500">
        材料在本机处理，模型按需读取内容。正式数据仅在你确认后写入。完成或取消后保留
        8 小时；浏览器关闭期间到期的材料，下次打开时清理。
      </p>
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
              <span className="text-sm">
                第 {source.page} / {source.pages} 页
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

function RequestClock({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return (
    <span className="mt-1 block">
      本次请求已等待 {Math.max(0, Math.floor((now - startedAt) / 1000))} 秒
    </span>
  );
}
