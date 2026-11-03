import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { Icon, type IconName } from "./Icon";

const NAV: { path: string; label: string; short: string; icon: IconName }[] = [
  { path: "/", label: "概览", short: "概览", icon: "overview" },
  { path: "/terms", label: "学期与节次", short: "学期", icon: "terms" },
  { path: "/people", label: "人员与组织", short: "人员", icon: "people" },
  { path: "/timetable", label: "课表", short: "课表", icon: "timetable" },
  { path: "/tasks", label: "任务", short: "任务", icon: "tasks" },
  { path: "/schedule", label: "排班", short: "排班", icon: "schedule" },
  { path: "/fairness", label: "公平账本", short: "公平", icon: "fairness" },
  { path: "/imports", label: "导入", short: "导入", icon: "imports" },
  { path: "/settings", label: "设置", short: "设置", icon: "settings" },
];

function isActive(path: string, current: string): boolean {
  if (path === "/") return current === "/";
  return current === path || current.startsWith(`${path}/`);
}

export interface LayoutProps {
  title: string;
  subtitle?: string;
  path: string;
  children: ReactNode;
}

/** 桌面左侧栏 + 手机底部 tab，全部是 hash 链接。 */
export function Layout({ title, subtitle, path, children }: LayoutProps) {
  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <a
        href="#main"
        onClick={(event) => {
          // 跳过导航：不能真的改 hash，否则会命中前端路由。
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[80] focus:rounded-lg focus:bg-indigo-600 focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        跳到主内容
      </a>

      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-slate-200 bg-white md:flex dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-indigo-600 text-sm font-bold text-white shadow-sm">
            R
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">Project.Rota</p>
            <p className="text-[11px] text-slate-400">排班与公平账本</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4" aria-label="主导航">
          {NAV.map((item) => {
            const active = isActive(item.path, path);
            return (
              <a
                key={item.path}
                href={`#${item.path}`}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                  active
                    ? "bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white",
                )}
              >
                <Icon name={item.icon} className={cx("size-5", active ? "text-indigo-600 dark:text-indigo-300" : "text-slate-400")} />
                {item.label}
              </a>
            );
          })}
        </nav>

        <div className="border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400 dark:border-slate-800">
          <p>v0.1.0 · 单体 Worker</p>
          <p className="mt-0.5">API 同源 /api</p>
        </div>
      </aside>

      <div className="md:pl-60">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white/85 px-4 py-3 backdrop-blur md:px-8 dark:border-slate-800 dark:bg-slate-900/85">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white md:hidden">
            R
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">{title}</h1>
            {subtitle ? <p className="truncate text-[11px] text-slate-500 sm:text-xs dark:text-slate-400">{subtitle}</p> : null}
          </div>
        </header>

        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl px-4 py-4 pb-28 focus:outline-none md:px-8 md:py-6 md:pb-10"
        >
          {children}
        </main>
      </div>

      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden dark:border-slate-800 dark:bg-slate-900/95"
        aria-label="主导航"
      >
        <div className="flex overflow-x-auto px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {NAV.map((item) => {
            const active = isActive(item.path, path);
            return (
              <a
                key={item.path}
                href={`#${item.path}`}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex min-w-16 shrink-0 flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 text-[10px] transition",
                  active
                    ? "bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                    : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
                )}
              >
                <Icon name={item.icon} className="size-5" />
                {item.short}
              </a>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
