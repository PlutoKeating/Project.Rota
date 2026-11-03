import { QuickSearch } from "./QuickSearch";
import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { useSession } from "./AuthGate";
import { api, messageOf } from "../lib/api";
const NAV: { path: string; label: string; icon: IconName }[] = [
  { path: "/", label: "排班", icon: "schedule" },
  { path: "/people", label: "人员", icon: "people" },
  { path: "/imports", label: "导入", icon: "imports" },
];
export function Layout({
  title,
  subtitle,
  path,
  children,
}: {
  title: string;
  subtitle?: string;
  path: string;
  children: ReactNode;
}) {
  const session = useSession();
  const [theme, setTheme] = useState(
    () =>
      localStorage.getItem("rota:theme") ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );
  const [error, setError] = useState("");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("rota:theme", theme);
  }, [theme]);
  const section = ["/schedule", "/tasks", "/fairness"].some((p) =>
    path.startsWith(p),
  )
    ? "/"
    : path.startsWith("/timetable")
      ? "/people"
      : path.startsWith("/terms")
        ? "/settings"
        : path;
  const link = (item: (typeof NAV)[number]) => (
    <a
      key={item.path}
      href={`#${item.path}`}
      aria-current={
        section === item.path ||
        (item.path !== "/" && section.startsWith(item.path))
          ? "page"
          : undefined
      }
      className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm text-slate-600 hover:bg-slate-100 aria-[current=page]:bg-indigo-600/10 aria-[current=page]:text-indigo-600 dark:text-slate-400 dark:hover:bg-slate-800"
    >
      <Icon name={item.icon} className="size-5" />
      {item.label}
    </a>
  );
  return (
    <div className="h-dvh overflow-hidden">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:z-[90] focus:bg-white focus:p-3"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        跳到主内容
      </a>
      <header className="fixed inset-x-0 top-0 z-40 flex h-16 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-900 md:px-6">
        <a href="#/" className="flex items-center gap-3 font-semibold">
          <span className="grid size-8 place-items-center rounded-lg bg-indigo-600 text-white">
            R
          </span>
          <span>Project.Rota</span>
        </a>
        <div className="flex items-center gap-3">
          <QuickSearch />
          <button
            aria-label="切换明暗主题"
            className="rounded-lg px-2 py-2 text-xs"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "浅色" : "深色"}
          </button>
          <details className="relative">
            <summary className="cursor-pointer rounded-lg p-2 text-sm">
              {session?.user?.name ?? "账号"}
            </summary>
            <div className="absolute right-0 mt-3 w-48 rounded-xl border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-800 dark:bg-slate-900">
              <a
                className="block rounded-lg p-3 hover:bg-slate-100 dark:hover:bg-slate-800"
                href="#/settings"
              >
                管理
              </a>
              <button
                className="w-full p-3 text-left"
                onClick={async () => {
                  try {
                    await api.post("/auth/logout");
                    location.assign("/");
                  } catch (e) {
                    setError(messageOf(e));
                  }
                }}
              >
                退出登录
              </button>
              {error && <p role="alert">{error}</p>}
            </div>
          </details>
        </div>
      </header>
      <aside className="fixed bottom-0 left-0 top-16 hidden w-48 flex-col border-r border-slate-200 px-3 py-6 md:flex dark:border-slate-800">
        <nav aria-label="主导航" className="space-y-2">
          {NAV.map(link)}
        </nav>
        <div className="mt-auto">
          {link({ path: "/settings", label: "管理", icon: "settings" })}
          <p className="px-4 pt-5 text-xs text-slate-500">
            把合适的人，安排到位。
          </p>
        </div>
      </aside>
      <main
        id="main"
        tabIndex={-1}
        className="h-dvh overflow-y-auto px-4 pb-24 pt-24 focus:outline-none md:ml-48 md:px-8 md:pb-10"
      >
        <div className="mx-auto max-w-[1440px]">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {subtitle && (
              <p className="mt-2 text-sm text-slate-500">{subtitle}</p>
            )}
          </div>
          {children}
        </div>
      </main>
      <nav
        aria-label="手机主导航"
        className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden dark:border-slate-800 dark:bg-slate-900"
      >
        {NAV.map(link)}
      </nav>
    </div>
  );
}
