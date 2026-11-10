import { useState } from "react";
import { api, messageOf } from "../lib/api";
import { useOrgsState, useTermsState } from "../lib/resources";
import { Button } from "./Button";
import { Field, TextInput, Select, Checkbox } from "./Field";
import { Modal } from "./Modal";
import { TermsPage } from "../pages/TermsPage";
import { PeoplePage } from "../pages/PeoplePage";
import { isoDate } from "../lib/format";
import { useToast } from "./Toast";
import type { WorkDraft } from "./FreeWindowFinder";
export function WorkComposer({
  onClose,
  onCreated,
  initial,
}: {
  onClose: () => void;
  onCreated: (date: string) => void;
  /** 从「找时间」带入的时间、部门、人数与能到的人。 */
  initial?: WorkDraft;
}) {
  const orgs = useOrgsState(),
    terms = useTermsState(),
    toast = useToast();
  const attendees = initial?.attendees ?? [];
  const [title, setTitle] = useState(""),
    [org, setOrg] = useState(initial?.orgId ?? ""),
    [date, setDate] = useState(initial?.date ?? isoDate()),
    [start, setStart] = useState(initial?.start ?? "09:00"),
    [end, setEnd] = useState(initial?.end ?? "10:00"),
    [count, setCount] = useState(initial?.count ?? 1),
    [repeat, setRepeat] = useState(false),
    [assignNow, setAssignNow] = useState(attendees.length > 0),
    [weeks, setWeeks] = useState(4),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [setup, setSetup] = useState<"terms" | "people" | null>(null);
  async function save() {
    setBusy(true);
    setError("");
    try {
      const created = await api.post<{ taskId: string; shiftIds: string[] }>("/work", {
        title,
        orgId: org,
        startsAt: `${date}T${start}:00+08:00`,
        endsAt: `${date}T${end}:00+08:00`,
        requiredHeadcount: count,
        repeatWeeks: repeat ? weeks : 1,
      });
      if (assignNow && attendees.length > 0) {
        // 逐个直接安排；服务端照常检查部门成员、冲突与人数上限，失败的人留给候选列表处理。
        let assigned = 0;
        const failed: string[] = [];
        for (const shiftId of created.shiftIds) {
          for (const person of attendees) {
            try {
              await api.post(`/shifts/${encodeURIComponent(shiftId)}/assign`, { personId: person.id });
              assigned += 1;
            } catch (e) {
              failed.push(`${person.name}：${messageOf(e)}`);
            }
          }
        }
        if (failed.length === 0) toast.success(`已直接安排 ${assigned} 人次`);
        else toast.error(`已安排 ${assigned} 人次，${failed.length} 人次未安排（${failed.slice(0, 3).join("；")}${failed.length > 3 ? "…" : ""}）`);
      }
      onCreated(date);
      onClose();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      side
      title="安排工作"
      description="填写工作与时间，创建后即可查看候选并确认人员。"
      onClose={onClose}
      footer={
        <Button
          loading={busy}
          disabled={!title.trim() || !org || !date || !start || !end}
          onClick={() => void save()}
        >
          创建班次并开始排班
        </Button>
      }
    >
      {setup ? (
        <>
          <Button
            variant="secondary"
            onClick={() => {
              setSetup(null);
              orgs.reload();
              terms.reload();
            }}
          >
            返回安排工作
          </Button>
          {setup === "terms" ? <TermsPage /> : <PeoplePage />}
        </>
      ) : (
        <>
          <Field label="工作名称">
            <TextInput
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：迎新咨询值班"
            />
          </Field>
          <Field label="负责部门">
            <Select value={org} onChange={(e) => setOrg(e.target.value)}>
              <option value="">选择部门</option>
              {orgs.data?.items.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSetup("people")}
            >
              补充人员或部门
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSetup("terms")}>
              {terms.terms.length ? "维护学期" : "先创建学期"}
            </Button>
          </div>
          <Field label="日期">
            <TextInput
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="开始时间">
              <TextInput
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field label="结束时间">
              <TextInput
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
          </div>
          <Field label="需要人数">
            <TextInput
              type="number"
              min={1}
              max={300}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
          </Field>
          {attendees.length > 0 && (
            <div className="space-y-1 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <Checkbox
                label={`创建后直接安排这 ${attendees.length} 位能到的人`}
                checked={assignNow}
                onChange={(e) => setAssignNow(e.target.checked)}
              />
              <p className="text-xs text-slate-500">
                {attendees.map((a) => a.name).join("、")}。只能安排所选部门的成员；重复的周次照常检查冲突，未能安排的人可在候选列表里处理。
              </p>
            </div>
          )}
          <Checkbox
            label="每周重复"
            checked={repeat}
            onChange={(e) => setRepeat(e.target.checked)}
          />
          {repeat && (
            <Field label="连续周数（包含本周）">
              <TextInput
                type="number"
                min={1}
                max={30}
                value={weeks}
                onChange={(e) => setWeeks(Number(e.target.value))}
              />
            </Field>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-rose-600">
          {error}
        </p>
      )}
      {orgs.error && <p role="alert">{orgs.error}</p>}
    </Modal>
  );
}
