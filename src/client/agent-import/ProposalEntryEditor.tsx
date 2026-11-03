import { useState } from "react";
import type { TimetableProposal } from "../../shared/agent-import/timetable";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { Field, TextInput, Select } from "../components/Field";
import { WeeksField } from "./ScheduleFields";
type Entry = TimetableProposal["entries"][number];
export function ProposalEntryEditor({
  entry,
  onSave,
  onClose,
}: {
  entry: Entry;
  onSave: (value: Entry) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(entry),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const patch = (data: Partial<Entry>) => setValue((v) => ({ ...v, ...data }));
  return (
    <Modal title="修改课程" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onSave(value);
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="课程名称">
          <TextInput
            value={value.name}
            onChange={(e) => patch({ name: e.target.value })}
            required
          />
        </Field>
        <Field label="星期">
          <Select
            value={value.weekday ?? ""}
            onChange={(e) =>
              patch({ weekday: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">待确认</option>
            {["一", "二", "三", "四", "五", "六", "日"].map((d, i) => (
              <option key={d} value={i + 1}>
                周{d}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          {(["period_from", "period_to"] as const).map((key, i) => (
            <Field key={key} label={i ? "结束节次" : "开始节次"}>
              <TextInput
                type="number"
                min={1}
                max={48}
                placeholder="待确认"
                value={value[key] ?? ""}
                onChange={(e) =>
                  patch({
                    [key]: e.target.value ? Number(e.target.value) : null,
                  })
                }
              />
            </Field>
          ))}
        </div>
        <Field label="教学周">
          <label className="text-sm">
            <input
              type="checkbox"
              checked={value.weeks === null}
              onChange={(e) => patch({ weeks: e.target.checked ? null : [] })}
            />{" "}
            周次待确认
          </label>
          {value.weeks !== null && (
            <WeeksField
              value={JSON.stringify(value.weeks)}
              count={30}
              onChange={(weeks) => patch({ weeks: JSON.parse(weeks) })}
            />
          )}
        </Field>
        <Field label="地点">
          <TextInput
            value={value.location ?? ""}
            onChange={(e) => patch({ location: e.target.value || null })}
          />
        </Field>
        <Field label="教师">
          <TextInput
            value={value.teacher ?? ""}
            onChange={(e) => patch({ teacher: e.target.value || null })}
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-rose-700">
            {error}
          </p>
        )}
        <Button disabled={busy} type="submit">
          保存修改
        </Button>
      </form>
    </Modal>
  );
}
