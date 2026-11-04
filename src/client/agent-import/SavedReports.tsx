import { useState } from "react";
import { api } from "../lib/api";
import { Button } from "../components/Button";
export function SavedReports() {
  const [rows, setRows] = useState<
    { id: string; summary: string; applied_at: string }[]
  >([]);
  const [error, setError] = useState("");
  return (
    <details
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
      <summary className="cursor-pointer text-sm text-slate-600">
        已提交的审核记录
      </summary>
      <p className="my-2 text-xs text-slate-500">
        保留结构化课程、日历依据与待定说明。原始文件和模型对话按 8 小时清理。
      </p>
      {rows.map((r) => (
        <div key={r.id} className="border-t border-slate-200 py-3 text-sm">
          <p>
            {r.applied_at} · {r.summary}
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
            下载审核记录
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
