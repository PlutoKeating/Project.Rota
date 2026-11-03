import { useEffect, useState, type ReactNode } from "react";
import { api, messageOf } from "../lib/api";

interface Session { authenticated: boolean; user: { name: string; role: string } | null }
const errors: Record<string, string> = {
  invalid_state: "登录校验失败，请重新登录。", expired: "登录已超时，请重试。",
  not_allowed: "账号已验证，但尚未获得本系统管理员权限，请联系所有者。",
  failed: "登录未完成，请重试。",
};

export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState(() => errors[new URLSearchParams(location.search).get("auth_error") ?? ""] ?? "");
  useEffect(() => {
    api.get<Session>("/auth/me").then(setSession).catch(e => setError(messageOf(e)));
    const expired = () => setSession({ authenticated: false, user: null });
    window.addEventListener("rota:unauthorized", expired);
    return () => window.removeEventListener("rota:unauthorized", expired);
  }, []);
  if (!session?.authenticated) return <main className="min-h-screen grid place-items-center bg-slate-50 p-6">
    <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <p className="text-sm font-semibold text-indigo-600">Project.Rota</p>
      <h1 className="mt-3 text-2xl font-semibold text-slate-900">在正确的时间，把活派给对的人。</h1>
      <p className="mt-4 text-sm text-slate-600">使用 PlutoKeating 账号登录。系统仅向获得授权的组织管理员开放。</p>
      {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
      {session || error ? <a href="/api/auth/login" className="mt-6 block rounded-lg bg-indigo-600 px-4 py-3 text-center font-medium text-white">使用统一账号登录</a> : <p className="mt-6" role="status">正在检查登录状态…</p>}
      <a className="mt-6 block text-xs text-slate-500 underline" href="https://github.com/PlutoKeating/Project.Rota">源代码 · AGPL-3.0-or-later</a>
    </section>
  </main>;
  return <>
    <div className="flex justify-end gap-3 border-b bg-white px-4 py-2 text-xs text-slate-600">
      <span>{session.user?.name} · {session.user?.role === "owner" ? "所有者" : "管理员"}</span>
      <button className="underline" onClick={async () => {
        try { await api.post("/auth/logout"); location.assign("/"); } catch (e) { setError(messageOf(e)); }
      }}>退出登录</button>
      {error && <span role="alert">{error}</span>}
    </div>
    {children}
  </>;
}
