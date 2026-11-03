import { useEffect, useState } from "react";
import { WeeksField } from "../agent-import/ScheduleFields";
import { api, messageOf } from "../lib/api";
import { Button } from "./Button";
import { Field, TextInput, Select } from "./Field";
import { Modal } from "./Modal";
import {
  materialize,
  validateTransition,
  type Snapshot,
  type Row,
  type Change,
} from "../../shared/agent-import/model";
export function PersonalTimetable({
  personId,
  termId,
  week,
  onChanged,
}: {
  personId: string;
  termId: string;
  week: number;
  onChanged: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [editing, setEditing] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .get<{ data: Snapshot }>("/agent-imports/snapshot")
      .then((x) => {
        if (alive) setSnapshot(x.data);
      })
      .catch((e) => {
        if (alive) setError(messageOf(e));
      });
    return () => {
      alive = false;
    };
  }, [personId, termId]);
  const entries =
    snapshot?.timetable_entry.filter(
      (e) => e.person_id === personId && e.term_id === termId,
    ) ?? [];
  const commit = async (before: Row, after: Row | null) => {
    if (!snapshot) return;
    setBusy(true);
    setError("");
    let batchId: string | undefined;
    try {
      const draft = structuredClone(snapshot);
      draft.timetable_entry = draft.timetable_entry.filter(
        (e) => e.id !== before.id,
      );
      if (after) draft.timetable_entry.push(after);
      const issues = validateTransition(snapshot, materialize(draft, snapshot));
      if (issues.length) throw Error(issues.map((x) => x.message).join("；"));
      const change: Change = {
        entity: "timetable_entry",
        id: before.id,
        before,
        after,
        evidence: [
          {
            source: "操作员意见",
            locator: "人员课表管理",
            explanation: "管理员修正已导入课表",
            inferred: false,
          },
        ],
      };
      const { id } = await api.post<{ id: string }>("/agent-imports");
      batchId = id;
      const body = { changes: [change], summary: "人员课表管理修改" };
      await api.post(`/agent-imports/${id}/lease`, body);
      await api.post(`/agent-imports/${id}/apply`, body);
      setSnapshot(draft);
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(messageOf(e));
      if (batchId)
        await api.post(`/agent-imports/${batchId}/cancel`).catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  if (!entries.length && !error) return null;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <h2 className="text-sm font-semibold">独立课表与实际时间</h2>
      <p className="mt-1 text-xs text-slate-500">
        第 {week} 周 · 按个人作息显示，排班按实际时间检查冲突。
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-rose-700">
          {error}
        </p>
      )}
      <div className="mt-3 divide-y divide-slate-200">
        {entries.map((e) => {
          const profile = snapshot!.timetable_profile.find(
            (p) => p.id === e.profile_id,
          );
          const periods = JSON.parse(String(profile?.periods ?? "[]")) as {
            index: number;
            start: string;
            end: string;
          }[];
          const active = (JSON.parse(String(e.weeks)) as number[]).includes(
            week,
          );
          return (
            <div
              key={e.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div>
                <p className="text-sm font-medium">
                  {e.name}{" "}
                  {!active && (
                    <span className="text-xs font-normal text-slate-500">
                      本周不上课
                    </span>
                  )}
                </p>
                <p className="text-xs text-slate-500">
                  周{e.weekday} ·{" "}
                  {periods.find((p) => p.index === e.period_from)?.start}–
                  {periods.find((p) => p.index === e.period_to)?.end} ·{" "}
                  {String(e.location ?? "")} · {e.weeks}周
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing({ ...e })}
              >
                修改课程
              </Button>
            </div>
          );
        })}
      </div>
      {editing && (
        <Modal
          title="修改独立课表"
          onClose={() => {
            if (!busy) setEditing(null);
          }}
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void commit(entries.find((x) => x.id === editing.id)!, editing);
            }}
          >
            {[
              ["name", "课程"],
              ["teacher", "教师"],
              ["location", "地点"],
              ["weekday", "星期（1–7）"],
              ["period_from", "开始节次"],
              ["period_to", "结束节次"],
            ].map(([key, label]) => (
              <Field key={key} label={label}>
                <TextInput
                  value={String(editing[key] ?? "")}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      [key]: ["weekday", "period_from", "period_to"].includes(
                        key,
                      )
                        ? Number(e.target.value)
                        : e.target.value,
                    })
                  }
                />
              </Field>
            ))}
            <Field label="上课周次">
              <WeeksField
                value={String(editing.weeks)}
                count={Number(
                  snapshot!.term.find((t) => t.id === termId)?.week_count ?? 20,
                )}
                onChange={(weeks) => setEditing({ ...editing, weeks })}
              />
            </Field>
            <Field label="作息方案">
              <Select
                value={String(editing.profile_id)}
                onChange={(e) =>
                  setEditing({ ...editing, profile_id: e.target.value })
                }
              >
                {snapshot!.timetable_profile
                  .filter((p) => p.term_id === termId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
            </Field>
            {error && (
              <p
                role="alert"
                className="text-sm text-rose-700 dark:text-rose-300"
              >
                {error}
              </p>
            )}
            <div className="flex justify-between">
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void commit(entries.find((x) => x.id === editing.id)!, null)
                }
              >
                删除此课程
              </Button>
              <Button type="submit" loading={busy}>
                保存修改
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
