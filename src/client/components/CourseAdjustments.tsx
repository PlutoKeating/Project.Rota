import { useEffect, useState } from "react";
import { api, messageOf } from "../lib/api";
import { Card } from "./Card";
import { Field, Select } from "./Field";
import { Button } from "./Button";
interface Course { id: string; name: string }
interface Occurrence { id: string; startsAt: string; periodIndex: number; status: string }
interface Slot { id: string; startsAt: string; periodIndex: number }
export function CourseAdjustments({ termId, personId, week, onChanged }: { termId: string; personId: string; week: number; onChanged: () => void }) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState("");
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [occurrenceId, setOccurrenceId] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotId, setSlotId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api.get<{ items: Course[] }>(`/courses?termId=${termId}&personId=${personId}`).then(r => {
      if (active) { setCourses(r.items); setCourseId(r.items[0]?.id ?? ""); }
    }).catch(e => active && setError(messageOf(e)));
    return () => { active = false; };
  }, [termId, personId]);
  useEffect(() => {
    let active = true;
    api.get<{ items: Slot[] }>(`/terms/${termId}/slots?week=${week}`).then(r => {
      if (active) { setSlots(r.items); setSlotId(r.items[0]?.id ?? ""); }
    }).catch(e => active && setError(messageOf(e)));
    return () => { active = false; };
  }, [termId, week]);
  async function reload() {
    if (!courseId) { setOccurrences([]); setOccurrenceId(""); return; }
    try {
      const r = await api.get<{ items: Occurrence[] }>(`/courses/${courseId}/occurrences`);
      setOccurrences(r.items); setOccurrenceId(r.items[0]?.id ?? "");
    } catch (e) { setError(messageOf(e)); }
  }
  useEffect(() => { void reload(); }, [courseId]);
  async function change(status: string) {
    setBusy(true); setError("");
    try { await api.patch(`/occurrences/${occurrenceId}`, { status, ...(status === "moved" ? { slotId } : {}) }); await reload(); onChanged(); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <Card title="单次调课与停课" description="每次修改一个节次，所有选修本课程的人员同步生效。目标节次来自当前选中的周；多节课程须逐节调整。">
    {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="课程"><Select value={courseId} onChange={e => setCourseId(e.target.value)}><option value="">选择课程</option>{courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      <Field label="原时段"><Select value={occurrenceId} onChange={e => setOccurrenceId(e.target.value)}>{occurrences.map(o => <option key={o.id} value={o.id}>{o.startsAt.slice(0,16).replace("T"," ")} 第{o.periodIndex}节 · {o.status === "cancelled" ? "已停课" : "上课"}</option>)}</Select></Field>
      <Field label="调至本周节次"><Select value={slotId} onChange={e => setSlotId(e.target.value)}>{slots.map(s => <option key={s.id} value={s.id}>{s.startsAt.slice(0,16).replace("T"," ")} 第{s.periodIndex}节</option>)}</Select></Field>
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button disabled={busy || !occurrenceId || !slotId} onClick={() => void change("moved")}>确认调课</Button>
      <Button variant="secondary" disabled={busy || !occurrenceId} onClick={() => void change("cancelled")}>停课</Button>
      <Button variant="secondary" disabled={busy || !occurrenceId} onClick={() => void change("scheduled")}>恢复当前时段上课</Button>
    </div>
  </Card>;
}
