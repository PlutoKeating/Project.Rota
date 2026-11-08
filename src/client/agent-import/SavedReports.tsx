import { useState } from "react";
import { api } from "../lib/api";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
export function SavedReports() {
  const [rows, setRows] = useState<
    { id: string; summary: string; applied_at: string }[]
  >([]);
  const [error, setError] = useState("");
  return (
    <details
      className="group"
      onToggle={async (e) => {
        if (!e.currentTarget.open) return;
        try {
          setRows(
            (await api.get<{ items: typeof rows }>("/agent-imports")).items,
          );
          setError("");
        } catch {
          setError("审核记录读取失败");
        }
      }}
    >
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm text-slate-500 transition hover:text-slate-900 dark:hover:text-slate-100 [&::-webkit-details-marker]:hidden">
        已提交记录
        <Icon
          name="chevron-down"
          className="size-4 transition group-open:rotate-180"
        />
      </summary>
      {rows.map((r) => (
        <div
          key={r.id}
          className="flex items-center justify-between gap-3 border-b border-slate-200 py-2.5 text-sm dark:border-slate-800"
        >
          <p className="min-w-0 truncate" title={r.summary}>
            <span className="tabular-nums text-slate-500">{r.applied_at}</span>{" "}
            {r.summary}
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                const data = await api.get<{ review: unknown }>(
                  `/agent-imports/${r.id}/report`,
                );
                if (!data.review) {
                  setError("此历史批次没有保存结构化审核记录");
                  return;
                }
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(data.review, null, 2)], {
                    type: "application/json",
                  }),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = `导入审核-${r.id}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch {
                setError("下载失败，请重试");
              }
            }}
          >
            下载
          </Button>
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm text-rose-700">
          {error}
        </p>
      )}
    </details>
  );
}
