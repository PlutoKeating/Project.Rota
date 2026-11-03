import { useState } from "react";
import { api, messageOf } from "../lib/api";
import { useOrgsState, useTermsState } from "../lib/resources";
import { Button } from "./Button";
import { Field, TextInput, Select, Checkbox } from "./Field";
import { Modal } from "./Modal";
import { TermsPage } from "../pages/TermsPage";
import { PeoplePage } from "../pages/PeoplePage";
import { isoDate } from "../lib/format";
export function WorkComposer({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (date: string) => void;
}) {
  const orgs = useOrgsState(),
    terms = useTermsState();
  const [title, setTitle] = useState(""),
    [org, setOrg] = useState(""),
    [date, setDate] = useState(isoDate()),
    [start, setStart] = useState("09:00"),
    [end, setEnd] = useState("10:00"),
    [count, setCount] = useState(1),
    [repeat, setRepeat] = useState(false),
    [weeks, setWeeks] = useState(4),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [setup, setSetup] = useState<"terms" | "people" | null>(null);
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.post("/work", {
        title,
        orgId: org,
        startsAt: `${date}T${start}:00+08:00`,
        endsAt: `${date}T${end}:00+08:00`,
        requiredHeadcount: count,
        repeatWeeks: repeat ? weeks : 1,
      });
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
