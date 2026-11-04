import { useState } from "react";
import {
  calendarMissing,
  type CalendarProposal,
} from "../../shared/agent-import/calendar";
import type { Job } from "./store";
import { editCalendar } from "./runtime";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { Field, TextInput, Textarea } from "../components/Field";
export function CalendarReview({
  job,
  onChange,
  onSource,
}: {
  job: Job;
  onChange: (j: Job) => void;
  onSource: (path: string) => void;
}) {
  const [editing, setEditing] = useState<CalendarProposal | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <div className="space-y-4">
      {Object.values(job.calendars ?? {}).map((c) => (
        <section key={c.id} className="border-t border-slate-200 py-3 text-sm">
          <p className="font-medium">{c.name} · 日历证据</p>
          <p>
            首周周一：{c.start_date ?? "待定"}；总周数：{c.week_count ?? "待定"}
            {c.minimum_weeks ? `（已知至少 ${c.minimum_weeks} 周）` : ""}
          </p>
          <p className="text-xs text-slate-500">
            适用：
            {c.timetable_ids
              .map((id) => job.timetables?.[id]?.person.full_name ?? id)
              .join("、") || "尚待判断"}
          </p>
          <div className="my-2 flex flex-wrap gap-3">
            {c.periods.map((p) => (
              <span key={p.index}>
                第{p.index}节 {p.start ?? "上课待定"}–{p.end ?? "下课待定"}
              </span>
            ))}
          </div>
          {!!calendarMissing(c).length && (
            <p className="text-amber-700">
              待补：{calendarMissing(c).join("、")}
            </p>
          )}
          {c.unresolved.map((x, i) => (
            <p key={i} className="text-amber-700">
              {x}
            </p>
          ))}
          <details>
            <summary>来源与判断</summary>
            {c.sources.map((s, i) => (
              <p key={i}>
                <button
                  className="underline"
                  onClick={() => onSource(s.source)}
                >
                  {s.source}
                </button>{" "}
                {s.locator} · {s.inferred ? "推断：" : ""}
                {s.explanation}
              </p>
            ))}
          </details>
          <Button
            size="sm"
            variant="ghost"
            disabled={["running", "applied", "cancelled"].includes(job.status)}
            onClick={() => {
              setEditing(structuredClone(c));
              setError("");
            }}
          >
            复核日期与作息
          </Button>
        </section>
      ))}
      {editing && (
        <Modal
          title="复核日期与作息"
          onClose={() => {
            if (!saving) setEditing(null);
          }}
        >
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setSaving(true);
              setError("");
              try {
                await editCalendar(job, editing);
                onChange({ ...job });
                setEditing(null);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            <Field label="第一教学周周一">
              <TextInput
                type="date"
                value={editing.start_date ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, start_date: e.target.value || null })
                }
              />
            </Field>
            <Field label="总教学周数（未知留空）">
              <TextInput
                type="number"
                min={1}
                max={30}
                value={editing.week_count ?? ""}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    week_count: e.target.value ? Number(e.target.value) : null,
                  })
                }
              />
            </Field>
            {editing.periods.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <span>第{p.index}节</span>
                {(["start", "end"] as const).map((k) => (
                  <TextInput
                    key={k}
                    className="min-w-0"
                    aria-label={`第${p.index}节${k === "start" ? "上课" : "下课"}`}
                    type="time"
                    value={p[k] ?? ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        periods: editing.periods.map((x, j) =>
                          j === i ? { ...x, [k]: e.target.value || null } : x,
                        ),
                      })
                    }
                  />
                ))}
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setEditing({
                  ...editing,
                  periods: [
                    ...editing.periods,
                    {
                      index:
                        Math.max(0, ...editing.periods.map((p) => p.index)) + 1,
                      start: null,
                      end: null,
                    },
                  ],
                })
              }
            >
              增加节次
            </Button>
            <Field label="仍待确认的事项（每行一项）">
              <Textarea
                value={editing.unresolved.join("\n")}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    unresolved: e.target.value
                      .split("\n")
                      .filter((line) => line.trim()),
                  })
                }
              />
            </Field>
            <p className="text-xs text-slate-500">
              信息完整后将生成学期与作息草稿，并绑定上述适用人员，供最终审核。
            </p>
            {error && (
              <p role="alert" className="text-rose-700">
                {error}
              </p>
            )}
            <Button type="submit" disabled={saving}>
              保存复核结果
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
