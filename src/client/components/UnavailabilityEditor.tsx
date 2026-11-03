import { useEffect, useState } from "react";
import { api, messageOf } from "../lib/api";
import { Card } from "./Card";
import { Button } from "./Button";
import { Field, TextInput, Select } from "./Field";

interface Leave { id: string; startsAt: string; endsAt: string; reason: string | null; kind: string }
export function UnavailabilityEditor({ personId, onChanged }: { personId: string; onChanged: () => void }) {
  const [items, setItems] = useState<Leave[]>([]);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState("leave");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function reload() {
    try { setItems((await api.get<{ items: Leave[] }>(`/persons/${personId}/unavailability`)).items); }
    catch (e) { setError(messageOf(e)); }
  }
  useEffect(() => { setItems([]); setError(""); void reload(); }, [personId]);
  return <Card title="请假与不可用时段" description="按北京时间填写；保存后直接生效，并参与后续排班冲突检查。">
    {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
    <ul className="divide-y text-sm">
      {items.map(item => <li key={item.id} className="flex flex-wrap justify-between gap-2 py-2">
        <span>{item.startsAt.slice(0, 16).replace("T", " ")} — {item.endsAt.slice(0, 16).replace("T", " ")} {item.reason}</span>
        <Button size="sm" variant="secondary" disabled={busy} onClick={async () => {
          setBusy(true); setError("");
          try { await api.del(`/unavailability/${item.id}`); await reload(); onChanged(); }
          catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
        }}>撤销</Button>
      </li>)}
    </ul>
    <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError("");
      try {
        await api.post(`/persons/${personId}/unavailability`, { startsAt: `${start}:00+08:00`, endsAt: `${end}:00+08:00`, reason, kind });
        await reload(); onChanged(); setReason("");
      } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
    }}>
      <Field label="开始" required><TextInput type="datetime-local" required value={start} onChange={e => setStart(e.target.value)} /></Field>
      <Field label="结束" required><TextInput type="datetime-local" required value={end} onChange={e => setEnd(e.target.value)} /></Field>
      <Field label="类型"><Select value={kind} onChange={e => setKind(e.target.value)}><option value="leave">请假</option><option value="blacklist">禁止排班</option><option value="other">其他安排</option></Select></Field>
      <Field label="原因"><TextInput value={reason} onChange={e => setReason(e.target.value)} maxLength={500} /></Field>
      <Button type="submit" loading={busy}>添加不可用时段</Button>
    </form>
  </Card>;
}
