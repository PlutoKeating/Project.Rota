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

const seconds = (now: number, at: number) =>
  Math.max(0, Math.floor((now - at) / 1000)) + "s";

/** Turn internal diagnostics into a few words; the raw text stays in the tooltip. */
export function friendlyError(text: string): string {
  const rules: [RegExp, string][] = [
    [/请求超时|模型请求超时|timeout/i, "模型响应超时"],
    [/文件工具运行超时|OCR 超时/, "读取文件超时"],
    [/网络不可达|network/i, "网络中断"],
    [/50[23]/, "服务器繁忙，自动重试"],
    [/额度/, "模型额度用尽"],
    [/本轮模型调用未完成/, "模型暂时不可用"],
    [/调用预算/, "调用次数已达上限"],
    [/上下文过大/, "材料过多，需缩小范围"],
    [/连续工具错误/, "连续读取出错"],
    [/已暂停/, "已暂停"],
  ];
  for (const [pattern, label] of rules) if (pattern.test(text)) return label;
  return text.replace(/\s*请求编号：\S+/, "").slice(0, 60);
}

/** "张三 会计2603" / "张三（金工2401）" → name + class tag. */
export function splitLabel(label: string): { name: string; tag?: string } {
  const m = /^(.+?)[\s（(]+([^）)]+?)[）)]?\s*$/.exec(label.trim());
  return m ? { name: m[1], tag: m[2] } : { name: label };
}

type Lane = "done" | "working" | "retry" | "failed" | "queued";
const LANES: { lane: Lane; label: string; color: string }[] = [
  { lane: "done", label: "完成", color: "bg-emerald-600" },
  { lane: "working", label: "处理中", color: "bg-indigo-600" },
  { lane: "retry", label: "等待重试", color: "bg-amber-500" },
  { lane: "failed", label: "失败", color: "bg-rose-600" },
  { lane: "queued", label: "排队", color: "bg-slate-300 dark:bg-slate-700" },
];

function laneOf(job: Job, p: PersonWorkspace): Lane {
  const activity = job.activity?.[p.key]?.text;
  if (p.status === "done") return "done";
  if (activity === "排队重试") return "retry";
  if (activity === "排队") return "queued";
  // A requeued person has a fresh agent (no error) until it starts again.
  if (p.status === "failed")
    return job.status === "running" && !p.agent.error ? "retry" : "failed";
  if (p.status === "queued") return activity ? "working" : "queued";
  return "working";
}

/** Share of the person's sources read in the current pass (real, not a guess). */
function progressOf(p: PersonWorkspace): number {
  if (p.status === "done") return 100;
  if (p.status === "queued") return 0;
  const read = p.sources.length
    ? p.sources.filter((s) => p.agent.coverage[s]).length / p.sources.length
    : 0;
  const verifying =
    p.status === "verifying" || (p.status === "failed" && p.resumeStatus === "verifying");
  return Math.round((verifying ? 50 : 5) + read * 45);
}

/** What the agent is doing now, overall people progress, and model health. */
export function LiveStatus({ job }: { job: Job }) {
  const running = job.status === "running";
  const now = useNow(running);
  const people = Object.values(job.session?.people ?? {});
  const counts = Object.fromEntries(LANES.map((l) => [l.lane, 0])) as Record<Lane, number>;
  for (const p of people) counts[laneOf(job, p)]++;
  const courses = people.length
    ? people.reduce(
        (n, p) =>
          n + Object.values(p.timetables).reduce((m, t) => m + t.entries.length, 0),
        0,
      )
    : Object.values(job.timetables ?? {}).reduce((n, t) => n + t.entries.length, 0);
  const review = job.status === "review";
  const coordinator = job.activity?.coordinator;
  // Aggregate every model call of this batch: which models answered, which failed.
  const models = new Map<string, { ok: number; failed: number; codes: Set<string> }>();
  for (const m of job.metrics ?? [])
    for (const a of m.attempts) {
      const row = models.get(a.model) ?? { ok: 0, failed: 0, codes: new Set<string>() };
      if (a.status === "ok") row.ok++;
      else {
        row.failed++;
        row.codes.add([a.code, a.httpStatus].filter(Boolean).join(" "));
      }
      models.set(a.model, row);
    }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
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
          {running && coordinator && (
            <span className="shrink-0 text-xs text-slate-500">
              {coordinator.text}
              <span className="ml-1 font-mono tabular-nums">
                {seconds(now, coordinator.at)}
              </span>
            </span>
          )}
        </div>
        <dl className="flex items-center gap-5 text-sm">
          {people.length > 0 && (
            <div className="flex items-baseline gap-1.5">
              <dt className="text-slate-500">人员</dt>
              <dd className="font-semibold tabular-nums">
                {counts.done}
                <span className="font-normal text-slate-400">/{people.length}</span>
              </dd>
            </div>
          )}
          <div className="flex items-baseline gap-1.5">
            <dt className="text-slate-500">课程</dt>
            <dd className="font-semibold tabular-nums">{courses}</dd>
          </div>
        </dl>
      </div>
      {people.length > 0 && (
        <div>
          <div
            className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
            role="img"
            aria-label={LANES.filter((l) => counts[l.lane])
              .map((l) => `${l.label} ${counts[l.lane]}`)
              .join("，")}
          >
            {LANES.filter((l) => counts[l.lane] && l.lane !== "queued").map((l) => (
              <span
                key={l.lane}
                className={cx(
                  "relative h-full overflow-hidden transition-[flex-grow] duration-700 ease-out",
                  l.color,
                )}
                style={{ flexGrow: counts[l.lane] }}
              >
                {l.lane === "working" && running && (
                  <span className="rota-shimmer absolute inset-0" />
                )}
              </span>
            ))}
            {counts.queued > 0 && <span style={{ flexGrow: counts.queued }} />}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            {LANES.filter((l) => counts[l.lane]).map((l) => (
              <li key={l.lane} className="flex items-center gap-1.5">
                <span className={cx("size-2 rounded-full", l.color)} />
                {l.label}
                <span className="font-medium tabular-nums text-slate-700 dark:text-slate-300">
                  {counts[l.lane]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {models.size > 0 && (
        <ul aria-label="模型调用" className="flex flex-wrap gap-1.5 text-xs">
          {[...models].map(([model, row]) => (
            <li
              key={model}
              title={row.codes.size ? "失败：" + [...row.codes].join("、") : undefined}
              className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 py-0.5 pl-2 pr-2.5 dark:bg-slate-800"
            >
              <span className="text-slate-700 dark:text-slate-300">{model}</span>
              {row.ok > 0 && (
                <span className="inline-flex items-center gap-0.5 tabular-nums text-emerald-700 dark:text-emerald-300">
                  <Icon name="check" className="size-3" />
                  {row.ok}
                </span>
              )}
              {row.failed > 0 && (
                <span className="inline-flex items-center gap-0.5 tabular-nums text-rose-700 dark:text-rose-300">
                  <Icon name="x" className="size-3" />
                  {row.failed}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {!models.size && job.model && (
        <p className="text-xs text-slate-500">
          {job.model.includes(" / ") ? job.model.split(" / ").pop() : job.model}
        </p>
      )}
    </div>
  );
}

const LANE_STYLE: Record<Lane, { bar: string; border: string; label: string }> = {
  done: { bar: "bg-emerald-600", border: "border-slate-200 dark:border-slate-800", label: "完成" },
  working: { bar: "bg-indigo-600", border: "border-slate-200 dark:border-slate-800", label: "处理中" },
  retry: { bar: "bg-amber-500", border: "border-amber-300 dark:border-amber-500/40", label: "等待重试" },
  failed: { bar: "bg-rose-600", border: "border-rose-300 dark:border-rose-500/40", label: "失败" },
  queued: { bar: "bg-slate-300 dark:bg-slate-700", border: "border-slate-200 dark:border-slate-800", label: "排队" },
};

export function PeopleGrid({
  job,
  identity,
}: {
  job: Job;
  identity?: (person: PersonWorkspace) => ReactNode;
}) {
  const running = job.status === "running";
  const now = useNow(running);
  const [open, setOpen] = useState<string>();
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
  const selected = people.find((p) => p.key === open);
  return (
    <div className="space-y-2">
      <ul
        aria-label="人员处理进度"
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
      >
        {people.map((p) => {
          const lane = laneOf(job, p);
          const style = LANE_STYLE[lane];
          const activity = running ? job.activity?.[p.key] : undefined;
          const working = running && lane === "working" && !!activity;
          const courses = Object.values(p.timetables).reduce(
            (n, t) => n + t.entries.length,
            0,
          );
          const pick = identity?.(p);
          const { name, tag } = splitLabel(p.label);
          const error = lane === "failed" ? p.agent.error : undefined;
          return (
            <li
              key={p.key}
              className={cx(
                "rota-enter overflow-hidden rounded-xl border bg-white transition-colors dark:bg-slate-900",
                pick ? "border-rose-300 dark:border-rose-500/40" : style.border,
                open === p.key && "ring-2 ring-indigo-600/30",
              )}
            >
              <button
                type="button"
                aria-expanded={open === p.key}
                onClick={() => setOpen(open === p.key ? undefined : p.key)}
                className="block w-full p-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-sm font-medium">{name}</span>
                    {tag && (
                      <span className="truncate text-xs text-slate-500">{tag}</span>
                    )}
                  </span>
                  {lane === "done" ? (
                    <Icon name="check" className="rota-pop size-4 shrink-0 text-emerald-600" />
                  ) : lane === "failed" ? (
                    <Icon name="alert" className="size-4 shrink-0 text-rose-600" />
                  ) : null}
                </span>
                <span className="relative mt-2.5 block h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <span
                    className={cx(
                      "absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out",
                      style.bar,
                    )}
                    style={{ width: progressOf(p) + "%" }}
                  />
                  {working && <span className="rota-shimmer absolute inset-0" />}
                </span>
                <span className="mt-1.5 flex items-center justify-between gap-2 text-xs text-slate-500">
                  <span
                    className={cx(
                      "truncate",
                      lane === "failed" && "text-rose-700 dark:text-rose-300",
                      lane === "retry" && "text-amber-700 dark:text-amber-300",
                    )}
                    title={p.agent.error}
                  >
                    {error
                      ? friendlyError(error)
                      : activity
                        ? activity.text
                        : style.label}
                    {activity && (
                      <span className="ml-1 font-mono tabular-nums text-slate-400">
                        {seconds(now, activity.at)}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 tabular-nums">{courses} 门课</span>
                </span>
              </button>
              {pick && <div className="px-3 pb-3">{pick}</div>}
            </li>
          );
        })}
      </ul>
      {selected && <PersonDetail job={job} person={selected} onClose={() => setOpen(undefined)} />}
    </div>
  );
}

function PersonDetail({
  job,
  person,
  onClose,
}: {
  job: Job;
  person: PersonWorkspace;
  onClose: () => void;
}) {
  const prefix = [person.label + " · ", person.label + "："];
  const log = job.log
    .filter((item) => prefix.some((p) => item.text.startsWith(p)))
    .slice(-30)
    .reverse();
  const calls = (job.metrics ?? []).filter((m) => m.actorId === person.key).slice(-8).reverse();
  return (
    <section
      aria-label={person.label + " 详情"}
      className="rota-enter rounded-xl border border-slate-200 bg-white p-4 text-xs dark:border-slate-800 dark:bg-slate-900"
    >
      <header className="flex items-center justify-between gap-3">
        <h3 className="truncate text-sm font-semibold">{person.label}</h3>
        <button
          type="button"
          aria-label="收起详情"
          onClick={onClose}
          className="grid size-7 place-items-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <Icon name="x" className="size-4" />
        </button>
      </header>
      {person.agent.error && (
        <p className="mt-2 break-words rounded-lg bg-rose-50 px-3 py-2 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          {person.agent.error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {person.sources.map((s) => (
          <span
            key={s}
            title={s}
            className={cx(
              "inline-flex max-w-full items-center gap-1 truncate rounded-md px-2 py-0.5",
              person.agent.coverage[s]
                ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300"
                : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
            )}
          >
            <Icon name="file" className="size-3 shrink-0" />
            <span className="truncate">{s.split(/!\/|\//).pop()}</span>
          </span>
        ))}
      </div>
      {calls.length > 0 && (
        <ol aria-label="模型调用" className="mt-3 flex flex-wrap gap-1.5">
          {calls.map((m) =>
            m.attempts.map((a, i) => (
              <li
                key={m.requestId + i}
                title={a.status === "ok" ? undefined : [a.code, a.httpStatus].filter(Boolean).join(" ")}
                className={cx(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 tabular-nums",
                  a.status === "ok"
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                    : "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
                )}
              >
                <Icon name={a.status === "ok" ? "check" : "x"} className="size-3" />
                {(a.durationMs / 1000).toFixed(0)}s
              </li>
            )),
          )}
        </ol>
      )}
      {log.length > 0 && (
        <ol className="mt-3 max-h-48 space-y-0.5 overflow-auto text-slate-600 dark:text-slate-400">
          {log.map((item, i) => (
            <li
              key={i}
              className={cx("flex gap-3", item.text.includes("失败") && "text-rose-700 dark:text-rose-300")}
            >
              <time className="shrink-0 tabular-nums text-slate-400">
                {new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false })}
              </time>
              <span className="break-words">{item.text.slice(person.label.length + 3)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
