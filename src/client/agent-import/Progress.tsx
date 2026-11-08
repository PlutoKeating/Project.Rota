import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { cx } from "../lib/cx";
import type { Job } from "./store";
import type { PersonWorkspace } from "../../shared/agent-import/person-workspace";

const STEPS = ["识别材料", "逐人整理", "交叉核对", "复核导入"] as const;

/** Index of the active step; STEPS.length means everything is finished. */
export function stepOf(job: Job): number {
  if (job.status === "applied") return STEPS.length;
  if (job.status === "review") return 3;
  return { discover: 0, people: 1, reconcile: 2, review: 3 }[
    job.session?.phase ?? "discover"
  ];
}

export function Stepper({ job }: { job: Job }) {
  const current = stepOf(job);
  const running = job.status === "running";
  return (
    <ol className="flex items-center gap-2" aria-label="导入进度">
      {STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <span
              className={cx(
                "relative grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors duration-500",
                done && "bg-emerald-600 text-white",
                active && "bg-indigo-600 text-white",
                !done && !active && "bg-slate-200 text-slate-500 dark:bg-slate-800",
              )}
            >
              {active && running && (
                <span className="rota-ping absolute inset-0 rounded-full bg-indigo-600" />
              )}
              {done ? (
                <Icon name="check" className="rota-pop size-4" />
              ) : (
                <span className="relative">{i + 1}</span>
              )}
            </span>
            <span
              className={cx(
                "hidden truncate text-sm sm:inline",
                active ? "font-medium text-slate-900" : "text-slate-500",
              )}
            >
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="relative h-0.5 min-w-4 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <span
                  className={cx(
                    "absolute inset-y-0 left-0 rounded-full bg-emerald-600 transition-[width] duration-700 ease-out",
                    done ? "w-full" : "w-0",
                  )}
                />
                {active && running && (
                  <span className="rota-shimmer absolute inset-0" />
                )}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const shortModel = (model: string) =>
  model.includes(" / ") ? model.split(" / ").pop()! : model;

/** One line: what the agent is doing right now, which model, and recent fallbacks. */
export function LiveStatus({ job }: { job: Job }) {
  const running = job.status === "running";
  const now = useNow(running && !!job.requestStartedAt);
  const waited = job.requestStartedAt
    ? Math.max(0, Math.floor((now - job.requestStartedAt) / 1000))
    : 0;
  const last = job.metrics?.at(-1);
  const people = Object.values(job.session?.people ?? {});
  const done = people.filter((p) => p.status === "done").length;
  const courses = people.length
    ? people.reduce(
        (n, p) =>
          n + Object.values(p.timetables).reduce((m, t) => m + t.entries.length, 0),
        0,
      )
    : Object.values(job.timetables ?? {}).reduce((n, t) => n + t.entries.length, 0);
  const review = job.status === "review";
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
      <div
        role="status"
        aria-live="polite"
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <span className="relative flex size-2.5 shrink-0">
          {running && (
            <span className="rota-ping absolute inset-0 rounded-full bg-indigo-600" />
          )}
          <span
            className={cx(
              "relative size-2.5 rounded-full",
              running
                ? "bg-indigo-600"
                : review
                  ? "bg-amber-500"
                  : "bg-slate-300 dark:bg-slate-700",
            )}
          />
        </span>
        <span className="truncate text-sm font-medium">
          {running
            ? job.phase || "正在读取材料"
            : review
              ? "整理完成，等你确认"
              : "已暂停"}
        </span>
        {running && job.requestStartedAt && (
          <span className="shrink-0 font-mono text-xs tabular-nums text-slate-500">
            {waited}s
          </span>
        )}
      </div>
      <dl className="flex items-center gap-5 text-sm">
        {people.length > 0 && (
          <div className="flex items-baseline gap-1.5">
            <dt className="text-slate-500">人员</dt>
            <dd className="font-semibold tabular-nums">
              {done}
              <span className="font-normal text-slate-400">/{people.length}</span>
            </dd>
          </div>
        )}
        <div className="flex items-baseline gap-1.5">
          <dt className="text-slate-500">课程</dt>
          <dd className="font-semibold tabular-nums">{courses}</dd>
        </div>
      </dl>
      {last && (
        <ol
          aria-label="最近一次模型调用"
          className="flex w-full flex-wrap items-center gap-1.5 text-xs"
        >
          {last.attempts.map((a, i) => (
            <li key={i} className="flex items-center gap-1.5">
              {i > 0 && (
                <Icon name="chevron-left" className="size-3 rotate-180 text-slate-400" />
              )}
              <span
                title={
                  a.status === "ok"
                    ? `${(a.durationMs / 1000).toFixed(1)} 秒`
                    : `${a.code ?? "error"} ${a.httpStatus ?? ""}`
                }
                className={cx(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
                  a.status === "ok"
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                    : "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
                )}
              >
                <Icon name={a.status === "ok" ? "check" : "x"} className="size-3" />
                {a.model}
                {a.status !== "ok" && a.httpStatus ? ` ${a.httpStatus}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
      {!last && job.model && (
        <p className="w-full text-xs text-slate-500">{shortModel(job.model)}</p>
      )}
    </div>
  );
}

const STATUS: Record<
  PersonWorkspace["status"],
  { label: string; bar: string; width: string }
> = {
  queued: { label: "排队", bar: "bg-slate-300 dark:bg-slate-700", width: "w-0" },
  extracting: { label: "整理", bar: "bg-indigo-600", width: "w-1/2" },
  verifying: { label: "核对", bar: "bg-indigo-600", width: "w-4/5" },
  done: { label: "完成", bar: "bg-emerald-600", width: "w-full" },
  failed: { label: "暂停", bar: "bg-rose-600", width: "w-full" },
};

export function PeopleGrid({
  job,
  identity,
}: {
  job: Job;
  identity?: (person: PersonWorkspace) => ReactNode;
}) {
  const running = job.status === "running";
  // Once everything is ready for review, only people needing a decision stay on screen.
  const people = Object.values(job.session?.people ?? {}).filter(
    (p) => job.status !== "review" || p.status !== "done" || !!identity?.(p),
  );
  if (!people.length)
    return running && stepOf(job) === 0 ? (
      <ul aria-label="正在识别人员" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <li
            key={i}
            className="h-[68px] overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
          >
            <span className="rota-shimmer block size-full" style={{ animationDelay: `${i * 120}ms` }} />
          </li>
        ))}
      </ul>
    ) : null;
  return (
    <ul
      aria-label="人员处理进度"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
    >
      {people.map((p) => {
        const s = STATUS[p.status];
        const working = running && ["extracting", "verifying"].includes(p.status);
        const courses = Object.values(p.timetables).reduce(
          (n, t) => n + t.entries.length,
          0,
        );
        const pick = identity?.(p);
        return (
          <li
            key={p.key}
            title={p.agent.error || p.match?.reason}
            className={cx(
              "rota-enter rounded-xl border bg-white p-3 transition-colors dark:bg-slate-900",
              p.status === "failed" || pick
                ? "border-rose-300 dark:border-rose-500/40"
                : "border-slate-200 dark:border-slate-800",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium">
                {p.information?.full_name ?? p.label}
              </p>
              {p.status === "done" ? (
                <Icon name="check" className="rota-pop size-4 shrink-0 text-emerald-600" />
              ) : p.status === "failed" ? (
                <Icon name="alert" className="size-4 shrink-0 text-rose-600" />
              ) : (
                <span className="shrink-0 text-xs text-slate-500">{s.label}</span>
              )}
            </div>
            <div className="relative mt-2.5 h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <span
                className={cx(
                  "absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out",
                  s.bar,
                  s.width,
                )}
              />
              {working && <span className="rota-shimmer absolute inset-0" />}
            </div>
            <p className="mt-1.5 text-xs tabular-nums text-slate-500">
              {courses} 门课
            </p>
            {p.agent.error && (
              <p className="mt-1 line-clamp-2 text-xs text-rose-700 dark:text-rose-300">
                {p.agent.error}
              </p>
            )}
            {pick}
          </li>
        );
      })}
    </ul>
  );
}
