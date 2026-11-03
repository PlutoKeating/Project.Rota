import { useEffect, useState } from "react";

type Health = { ok: boolean; env: string; db: "up" | "down"; ts: string };

const MILESTONES = [
  { key: "M1", title: "学期与人员", detail: "校历、节次、人员、部门与成员关系的增删改查" },
  { key: "M2", title: "课表与可用性", detail: "手工录入 + 展开占用，实时算「谁有空」" },
  { key: "M3", title: "排班与公平账本", detail: "试排、确认、撤销，跨周结转" },
  { key: "M4", title: "智能导入", detail: "Excel / ICS / 截图，模型解析后人工确认" },
  { key: "M5", title: "导出与通知", detail: "Excel、图片、邮件" },
];

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/health")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as Health;
      })
      .then((data) => {
        if (alive) setHealth(data);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const dbUp = health?.db === "up";

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-[0.18em] text-slate-500 uppercase">Project.Rota</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">在正确的时间，把活派给对的人</h1>
        </div>
        <span
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
            error
              ? "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
              : dbUp
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
          }`}
        >
          <span className={`size-1.5 rounded-full ${error ? "bg-rose-500" : dbUp ? "bg-emerald-500" : "bg-amber-500"}`} />
          {error ? "API 不可达" : health ? (dbUp ? "服务正常" : "数据库未就绪") : "检查中"}
        </span>
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { label: "当前学期", value: "—", hint: "M1 后可见" },
          { label: "在册成员", value: "—", hint: "M1 后可见" },
          { label: "待排班次", value: "—", hint: "M3 后可见" },
        ].map((item) => (
          <div
            key={item.label}
            className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <p className="text-xs text-slate-500">{item.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{item.value}</p>
            <p className="mt-1 text-[11px] text-slate-400">{item.hint}</p>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold">路线图</h2>
          <span className="text-[11px] text-slate-400">当前 M0 · 骨架</span>
        </div>
        <ol className="mt-4 space-y-3">
          {MILESTONES.map((m) => (
            <li key={m.key} className="flex gap-3">
              <span className="mt-0.5 inline-flex h-5 w-9 shrink-0 items-center justify-center rounded-md bg-slate-100 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {m.key}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">{m.title}</p>
                <p className="text-xs text-slate-500">{m.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2 text-[11px] text-slate-400">
        <span>v0.1.0 · {health?.env ?? "unknown"}</span>
        <span>schema: rota v0.1.0</span>
      </footer>
    </div>
  );
}
