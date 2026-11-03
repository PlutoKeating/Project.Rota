import { useEffect, useState } from "react";
import { api, messageOf } from "../lib/api";
import { Card } from "./Card";
import { Button } from "./Button";
import { Field, Select, TextInput } from "./Field";

interface User { id: string; fullName: string; oidcSubject: string; role: string; enabled: number }
export function AdminUsers() {
  const [users, setUsers] = useState<User[]>([]);
  const [subject, setSubject] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("admin");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function reload() {
    try { setUsers((await api.get<{ items: User[] }>("/admin/users")).items); }
    catch (e) { setError(messageOf(e)); }
  }
  useEffect(() => { void reload(); }, []);
  return <Card title="管理员账号" description="所有者维护授权名单；停用或更改角色会立即撤销该账号的会话。">
    {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
    <ul className="divide-y divide-slate-200">
      {users.map(user => <li key={user.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
        <div><p className="font-medium">{user.fullName} · {user.role === "owner" ? "所有者" : "管理员"}</p><p className="break-all text-xs text-slate-500">{user.oidcSubject}</p></div>
        <Button size="sm" variant="secondary" disabled={busy} onClick={async () => {
          setBusy(true); setError("");
          try { await api.patch(`/admin/users/${user.id}`, { enabled: !user.enabled }); await reload(); }
          catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
        }}>{user.enabled ? "停用" : "启用"}</Button>
      </li>)}
    </ul>
    <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError("");
      try { await api.post("/admin/users", { oidcSubject: subject, fullName: name, role }); setSubject(""); setName(""); await reload(); }
      catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
    }}>
      <Field label="账号标识（OIDC sub）" required><TextInput required value={subject} onChange={e => setSubject(e.target.value)} /></Field>
      <Field label="姓名" required><TextInput required value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="权限"><Select value={role} onChange={e => setRole(e.target.value)}><option value="admin">管理员</option><option value="owner">所有者</option></Select></Field>
      <div className="self-end"><Button type="submit" loading={busy}>添加授权账号</Button></div>
    </form>
  </Card>;
}
