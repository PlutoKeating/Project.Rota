import { useState } from "react";
import { readHistory, type Job } from "./store";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { cx } from "../lib/cx";

type Tab = "models" | "log" | "tools";

/** Diagnostics stay folded away; full tool evidence is fetched only when asked for. */
export function HistoryPanel({ job }: { job: Job }) {
  const [tab, setTab] = useState<Tab>("models"),
    [rows, setRows] = useState<any[]>([]),
    [offset, setOffset] = useState(0),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  async function load(next: number) {
    setLoading(true);
    try {
      setRows(await readHistory(job.id, next));
      setOffset(next);
      setError("");
    } catch {
      setError("读取失败，请重试");
    } finally {
      setLoading(false);
    }
  }
  const tabs: [Tab, string, number?][] = [
    ["models", "模型", job.metrics?.length],
    ["log", "步骤", job.log.length],
    ["tools", "工具"],
  ];
  return (
    <details className="group rounded-xl border border-slate-200 bg-white text-xs dark:border-slate-800 dark:bg-slate-900">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-slate-600 dark:text-slate-300 [&::-webkit-details-marker]:hidden">
        运行记录
        <Icon
          name="chevron-down"
          className="size-4 text-slate-400 transition group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-slate-200 px-4 pb-4 dark:border-slate-800">
        <div role="tablist" className="flex gap-1 py-3">
          {tabs.map(([key, label, count]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => {
                setTab(key);
                if (key === "tools" && !rows.length) void load(0);
              }}
              className="rounded-md px-2.5 py-1 text-slate-500 transition hover:text-slate-900 aria-selected:bg-slate-100 aria-selected:text-slate-900 dark:hover:text-slate-100 dark:aria-selected:bg-slate-800 dark:aria-selected:text-slate-100"
            >
              {label}
              {count ? <span className="ml-1 tabular-nums text-slate-400">{count}</span> : null}
            </button>
          ))}
        </div>
        <div className="max-h-72 overflow-auto text-slate-600 dark:text-slate-400">
          {tab === "models" &&
            (job.metrics?.length ? (
              <ol className="space-y-1.5">
                {[...job.metrics].reverse().map((m) => (
                  <li
                    key={m.requestId}
                    title={"请求编号 " + m.requestId}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1"
                  >
                    <span className="w-24 truncate text-slate-500">
                      {m.actorId ?? "协调器"}
                    </span>
                    {m.attempts.map((a, i) => (
                      <span
                        key={i}
                        className={cx(
                          "inline-flex items-center gap-1",
                          a.status === "ok"
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-rose-700 dark:text-rose-300",
                        )}
                      >
                        <span
                          className={cx(
                            "size-1.5 rounded-full",
                            a.status === "ok" ? "bg-emerald-600" : "bg-rose-600",
                          )}
                        />
                        {a.model}
                        {a.status !== "ok" && (
                          <span>
                            {a.code}
                            {a.httpStatus ? " " + a.httpStatus : ""}
                          </span>
                        )}
                      </span>
                    ))}
                    <span className="ml-auto tabular-nums text-slate-400">
                      {(m.durationMs / 1000).toFixed(1)}s
                      {m.inputTokens != null &&
                        ` · ${m.inputTokens}/${m.outputTokens ?? "?"}`}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-slate-400">暂无</p>
            ))}
          {tab === "log" && (
            <ol className="space-y-1">
              {[...job.log].reverse().map((item, i) => (
                <li
                  key={i}
                  className={cx(
                    "flex gap-3",
                    /失败|超时/.test(item.text) && "text-rose-700 dark:text-rose-300",
                  )}
                >
                  <time className="shrink-0 tabular-nums text-slate-400">
                    {new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false })}
                  </time>
                  <span className="break-words">{item.text}</span>
                </li>
              ))}
            </ol>
          )}
          {tab === "tools" && (
            <div aria-busy={loading}>
              {rows.map((r) => (
                <details key={r.key} className="border-b border-slate-100 py-1.5 dark:border-slate-800">
                  <summary className="cursor-pointer truncate">
                    {r.data?.name ?? r.kind}
                    {r.data?.args?.path ? (
                      <span className="text-slate-400"> · {String(r.data.args.path)}</span>
                    ) : null}
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[11px]">
                    {JSON.stringify(r.data, null, 2)}
                  </pre>
                </details>
              ))}
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={offset === 0 || loading}
                  onClick={() => void load(Math.max(0, offset - 10))}
                >
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={loading}
                  disabled={rows.length < 10}
                  onClick={() => void load(offset + 10)}
                >
                  下一页
                </Button>
              </div>
              {error && <p role="alert" className="text-rose-700">{error}</p>}
            </div>
          )}
        </div>
      </div>
    </details>
  );
}
