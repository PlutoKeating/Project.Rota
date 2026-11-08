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
  path,
  children,
}: {
  title: string;
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
        <div className="flex items-center gap-1.5 sm:gap-2">
          <QuickSearch />
          <button
            aria-label={theme === "dark" ? "切换到浅色" : "切换到深色"}
            title={theme === "dark" ? "浅色" : "深色"}
            className="grid size-9 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} className="size-[18px]" />
          </button>
          <details className="group relative">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg py-1 pl-1 pr-2 transition hover:bg-slate-100 dark:hover:bg-slate-800 [&::-webkit-details-marker]:hidden">
              <span
                aria-hidden="true"
                className="grid size-7 place-items-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                {(session?.user?.name ?? "账").slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden max-w-32 truncate text-sm sm:inline">
                {session?.user?.name ?? "账号"}
              </span>
              <Icon
                name="chevron-down"
                className="size-4 text-slate-400 transition group-open:rotate-180"
              />
            </summary>
            <div className="absolute right-0 mt-2 w-44 rounded-xl border border-slate-200 bg-white p-1.5 text-sm shadow-lg dark:border-slate-800 dark:bg-slate-900">
              <a
                className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-slate-100 dark:hover:bg-slate-800"
                href="#/settings"
              >
                <Icon name="settings" className="size-4 text-slate-500" />
                管理
              </a>
              <button
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                onClick={async () => {
                  try {
                    await api.post("/auth/logout");
                    location.assign("/");
                  } catch (e) {
                    setError(messageOf(e));
                  }
                }}
              >
                <Icon name="logout" className="size-4 text-slate-500" />
                退出登录
              </button>
              {error && (
                <p role="alert" className="px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                  {error}
                </p>
              )}
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
