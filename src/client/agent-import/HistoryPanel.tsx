import { useState } from "react";
import { readHistory, type Job } from "./store";
import { Button } from "../components/Button";

/** Full tool evidence is fetched on demand, never copied into the running progress panel. */
export function HistoryPanel({ job }: { job: Job }) {
  const [rows, setRows] = useState<any[]>([]),
    [offset, setOffset] = useState(0),
    [error, setError] = useState("");
  async function load(next: number) {
    try {
      setRows(await readHistory(job.id, next));
      setOffset(next);
      setError("");
    } catch {
      setError("历史读取失败，请重试");
    }
  }
  return (
    <div className="space-y-4 text-xs text-slate-600 dark:text-slate-400">
      {!!Object.keys(job.observations ?? {}).length && (
        <details>
          <summary className="cursor-pointer">
            已保存的材料识别成果 · {Object.keys(job.observations ?? {}).length}{" "}
            份
          </summary>
          {Object.entries(job.observations ?? {}).map(([path, o]) => (
            <details className="mt-3" key={path}>
              <summary className="cursor-pointer break-all">{path}</summary>
              <p className="mt-2 whitespace-pre-wrap">{o.content}</p>
              {o.unresolved.length > 0 && (
                <p className="mt-2">待核对：{o.unresolved.join("；")}</p>
              )}
            </details>
          ))}
        </details>
      )}
      {!!job.metrics?.length && (
        <details>
          <summary className="cursor-pointer">
            模型请求 · 最近 {job.metrics.length} 次
          </summary>
          <ol className="mt-3 max-h-64 space-y-3 overflow-auto">
            {job.metrics.map((m) => (
              <li key={m.requestId}>
                <p>
                  {m.purpose === "compact"
                    ? "交接"
                    : m.purpose === "checkpoint"
                      ? "保存成果"
                      : "整理"}{" "}
                  · {(m.durationMs / 1000).toFixed(1)} 秒 · 输入{" "}
                  {m.inputTokens ?? "未知"} / 输出 {m.outputTokens ?? "未知"}{" "}
                  tokens
                </p>
                {m.attempts.map((a, i) => (
                  <p key={i}>
                    {a.model} · {(a.durationMs / 1000).toFixed(1)} 秒 ·{" "}
                    {a.status === "ok"
                      ? "成功"
                      : `${a.code} ${a.httpStatus ?? ""}`}
                  </p>
                ))}
                <p className="break-all">请求编号：{m.requestId}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
      <details
        onToggle={(e) => {
          if (e.currentTarget.open) void load(0);
        }}
      >
        <summary className="cursor-pointer">完整工具与交接记录</summary>
        {rows.map((r) => (
          <details className="mt-3" key={r.key}>
            <summary className="cursor-pointer break-all">
              {r.kind} · {r.key}
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all">
              {JSON.stringify(r.data, null, 2)}
            </pre>
          </details>
        ))}
        <div className="mt-3 flex gap-2">
          <Button
            variant="ghost"
            disabled={offset === 0}
            onClick={() => void load(Math.max(0, offset - 10))}
          >
            上一页
          </Button>
          <Button
            variant="ghost"
            disabled={rows.length < 10}
            onClick={() => void load(offset + 10)}
          >
            下一页
          </Button>
        </div>
        {error && <p role="alert">{error}</p>}
      </details>
    </div>
  );
}
