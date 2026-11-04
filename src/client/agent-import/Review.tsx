import { CalendarReview } from "./CalendarReview";
import { needsVerification } from "./verification";
import { useMemo, useState } from "react";
import { timetableWarnings } from "../../shared/agent-import/timetable";
import { WeeksField, PeriodsField } from "./ScheduleFields";
import type { Job } from "./store";
import {
  changesFor,
  editRecord,
  editProposalEntry,
  setPersonIncluded,
} from "./runtime";
import {
  relations,
  diff,
  type Entity,
  type Row,
  type Evidence,
} from "../../shared/agent-import/model";
import { ProposalEntryEditor } from "./ProposalEntryEditor";
import type { TimetableProposal } from "../../shared/agent-import/timetable";
import { Button } from "../components/Button";
import { Field, TextInput, Select } from "../components/Field";
import { Modal } from "../components/Modal";
const names: Record<string, string> = {
  organization: "部门",
  person: "人员",
  term: "学期",
  class_period: "全局节次",
  role: "角色",
  membership: "部门关系",
  timetable_profile: "作息方案",
  timetable_entry: "个人课程",
  course: "已有课程",
  course_meeting: "课程规则",
  enrollment: "选课",
  unavailability: "不可用时段",
  task: "任务",
  shift: "班次",
  assignment: "安排",
};
const labels: Record<string, string> = {
  name: "名称",
  full_name: "姓名",
  student_no: "学号",
  class_name: "班级",
  major: "专业",
  email: "邮箱",
  phone: "电话",
  status: "状态",
  title: "任务名称",
  description: "说明",
  code: "编号",
  parent_id: "上级部门",
  org_id: "部门",
  person_id: "人员",
  term_id: "学期",
  role_id: "角色",
  profile_id: "作息方案",
  course_id: "课程",
  task_id: "任务",
  shift_id: "班次",
  start_date: "第一教学周周一",
  week_count: "教学周数",
  timezone: "时区",
  period_index: "节次",
  label: "标签",
  start_time: "开始时间",
  end_time: "结束时间",
  valid_from: "任期开始",
  valid_to: "任期结束",
  is_primary: "主要部门（0/1）",
  periods: "节次时间",
  teacher: "教师",
  location: "地点",
  weekday: "星期（1–7）",
  period_from: "开始节次",
  period_to: "结束节次",
  weeks: "上课周次",
  pattern_kind: "周次模式",
  week_ranges: "周次范围",
  starts_at: "开始日期时间",
  ends_at: "结束日期时间",
  kind: "类型",
  reason: "说明",
  required_headcount: "需要人数",
  required_role_id: "所需角色",
  required_skill_id: "所需技能",
  window_start: "任务开始",
  window_end: "任务结束",
  score: "评分",
};
const display = (r: Row) =>
  String(r.full_name ?? r.name ?? r.title ?? r.label ?? r.id);
export function Review({
  job,
  onChange,
  onSource,
}: {
  job: Job;
  onChange: (job: Job) => void;
  onSource: (path: string) => void;
}) {
  const changes = changesFor(job),
    all = useMemo(() => job.draft, [job.draft, job.revision]);
  const [editor, setEditor] = useState<{ entity: Entity; row: Row } | null>(
      null,
    ),
    [values, setValues] = useState<Record<string, string>>({}),
    [error, setError] = useState(""),
    [week, setWeek] = useState(1),
    [term, setTerm] = useState("");
  const [proposalEditor, setProposalEditor] = useState<{
    id: string;
    index: number;
    entry: TimetableProposal["entries"][number];
  } | null>(null);
  const activeTerm = term || String(all.term[0]?.id ?? "");
  const changed = new Set(changes.map((c) => c.entity + ":" + c.id));
  const affected = new Set(
    Object.values(job.timetables ?? {}).map((p) => p.person.id),
  );
  for (const c of diff(job.base, job.draft, job.evidence)) {
    if (c.entity === "person") affected.add(c.id);
    for (const r of [c.before, c.after])
      if (r?.person_id) affected.add(String(r.person_id));
  }
  const open = (entity: Entity, row: Row) => {
    setEditor({ entity, row });
    setValues(
      Object.fromEntries(
        Object.entries(row)
          .filter(
            ([k]) =>
              ![
                "id",
                "created_at",
                "updated_at",
                "assigned_at",
                "assigned_by",
              ].includes(k),
          )
          .map(([k, v]) => [k, String(v ?? "")]),
      ),
    );
    setError("");
  };
  const evidenceList = (items: Evidence[] | undefined) => {
    if (!items?.length) return null;
    return (
      <details className="mt-2 text-xs text-slate-500">
        <summary className="cursor-pointer">
          来源与判断{items.some((x) => x.inferred) ? " · 含推断" : ""}
        </summary>
        <ul className="mt-2 space-y-2">
          {items.map((e, i) => (
            <li key={i}>
              <button
                className="underline underline-offset-4"
                onClick={() => onSource(e.source)}
              >
                {e.source}
              </button>{" "}
              {e.locator}
              <p>
                {e.inferred ? "推断：" : ""}
                {e.explanation}
              </p>
            </li>
          ))}
        </ul>
      </details>
    );
  };
  const evidence = (entity: Entity, id: string) =>
    evidenceList(job.evidence[entity + ":" + id]);
  const editButton = (entity: Entity, row: Row) => (
    <Button
      size="sm"
      variant="ghost"
      disabled={["running", "applied", "cancelled"].includes(job.status)}
      onClick={() => {
        if (entity === "timetable_entry") {
          const plan = Object.values(job.timetables ?? {}).find((t) =>
            t.entryIds.includes(row.id),
          );
          const index =
            plan?.entries.findIndex((_, i) => `${plan.id}:${i}` === row.id) ??
            -1;
          if (plan && index >= 0) {
            setProposalEditor({
              id: plan.id,
              index,
              entry: plan.entries[index],
            });
            return;
          }
        }
        open(entity, row);
      }}
    >
      修改
    </Button>
  );
  const person = (p: Row) => (
    <details
      key={p.id}
      className="border-t border-slate-200 py-3 dark:border-slate-700"
    >
      <summary className="cursor-pointer font-medium">
        {display(p)}{" "}
        <span className="text-xs font-normal text-slate-500">
          {String(p.class_name ?? "")} {String(p.major ?? "")}{" "}
          {String(p.student_no ?? "未提供学号")}
          {job.excluded.includes(p.id) ? " · 本次不导入" : ""}
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {editButton("person", p)}
          <label className="text-xs">
            <input
              type="checkbox"
              checked={!job.excluded.includes(p.id)}
              disabled={["running", "applied", "cancelled"].includes(
                job.status,
              )}
              onChange={async (e) => {
                const saved = setPersonIncluded(job, p.id, e.target.checked);
                onChange({ ...job });
                await saved;
              }}
            />{" "}
            包含此人的变更
          </label>
        </div>
        {evidence("person", p.id)}
        {Object.values(job.timetables ?? {})
          .filter((t) => t.person.id === p.id)
          .map((t) => (
            <p key={t.id} className="text-xs text-slate-500">
              {job.excluded.includes(p.id)
                ? "本次不导入此人。"
                : !needsVerification(job, t)
                  ? `Agent 已回看核对。${job.timetableChecks?.[t.id]?.checks?.coverage === "complete" ? "" : "资料覆盖不完整；"}${job.timetableChecks?.[t.id]?.checks?.coverage_reason ?? "完整性尚未确认"} 仍需人工复核。`
                  : "等待 Agent 逐人回看核对。"}
            </p>
          ))}
        {Object.values(job.timetables ?? {})
          .filter((t) => t.person.id === p.id)
          .flatMap((t) => timetableWarnings(t.entries))
          .map((warning, i) => (
            <p key={i} className="text-sm text-amber-700">
              {warning}
            </p>
          ))}
        {Object.values(job.timetables ?? {})
          .filter(
            (t) =>
              t.person.id === p.id &&
              (!t.bound || t.entries.length !== t.entryIds.length),
          )
          .map((t) => (
            <section key={t.id} className="space-y-3">
              <p className="text-sm font-medium">
                {t.term_name || "学期待确认"} · 已识别 {t.entries.length}{" "}
                条课程记录
                {t.bound ? " · 含无固定时段课程" : " · 待确认学期与作息"}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th>课程</th>
                      <th>星期</th>
                      <th>节次</th>
                      <th>教学周</th>
                      <th>地点 / 教师</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.entries.map((e, i) => (
                      <tr key={i} className="border-t border-slate-200">
                        <td className="py-2">
                          {e.name}
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={[
                              "running",
                              "applied",
                              "cancelled",
                            ].includes(job.status)}
                            onClick={() =>
                              setProposalEditor({
                                id: t.id,
                                index: i,
                                entry: e,
                              })
                            }
                          >
                            修改课程
                          </Button>
                          {e.note && (
                            <p className="text-xs text-slate-500">{e.note}</p>
                          )}
                        </td>
                        <td>
                          {e.weekday
                            ? "周" +
                              ["一", "二", "三", "四", "五", "六", "日"][
                                e.weekday - 1
                              ]
                            : e.no_fixed_time
                              ? "无固定时段"
                              : "待确认"}
                        </td>
                        <td>
                          {e.period_from === null
                            ? "待确认"
                            : `${e.period_from}–${e.period_to ?? "?"}`}
                        </td>
                        <td>{e.weeks?.join("、") ?? "待确认"}</td>
                        <td>
                          {e.location} {e.teacher}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {evidenceList(t.sources)}
            </section>
          ))}

        {Object.values(job.timetables ?? {})
          .filter((t) => t.person.id === p.id)
          .flatMap((t) => t.unresolved)
          .map((issue, i) => (
            <p key={i} className="text-sm text-amber-700">
              {issue}
            </p>
          ))}

        {all.timetable_entry.some(
          (e) => e.person_id === p.id && e.term_id === activeTerm,
        ) && (
          <div className="grid grid-cols-1 gap-px border border-slate-200 bg-slate-200 sm:grid-cols-7 dark:border-slate-700 dark:bg-slate-700">
            {["一", "二", "三", "四", "五", "六", "日"].map((day, i) => (
              <div key={day} className="min-w-0 bg-white p-3 dark:bg-slate-900">
                <p className="mb-3 text-xs text-slate-500">周{day}</p>
                {all.timetable_entry
                  .filter(
                    (e) =>
                      e.person_id === p.id &&
                      e.term_id === activeTerm &&
                      e.weekday === i + 1 &&
                      (JSON.parse(String(e.weeks)) as number[]).includes(week),
                  )
                  .map((e) => (
                    <div key={e.id} className="mb-4 text-sm">
                      <p className="font-medium break-words">{display(e)}</p>
                      <p className="text-xs text-slate-500">
                        第 {e.period_from}–{e.period_to} 节
                      </p>
                      <p className="text-xs text-slate-500">
                        {String(e.location ?? "")}
                        {String(e.teacher ?? "")}
                      </p>
                      {editButton("timetable_entry", e)}
                      {evidence("timetable_entry", e.id)}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        )}
        {!all.timetable_entry.some((e) => e.person_id === p.id) &&
          !Object.values(job.timetables ?? {}).some(
            (t) => t.person.id === p.id,
          ) && (
            <p className="text-sm text-amber-700">
              尚未保存此人的结构化课表，不能据此判断没有课程。
            </p>
          )}
        {all.membership
          .filter((m) => m.person_id === p.id)
          .map((m) => (
            <p key={m.id} className="text-xs">
              {display(all.organization.find((o) => o.id === m.org_id) ?? m)} ·{" "}
              {m.status === "active" ? "有效" : "已结束/暂停"}{" "}
              {editButton("membership", m)}
              {evidence("membership", m.id)}
            </p>
          ))}
        {all.unavailability
          .filter((u) => u.person_id === p.id)
          .map((u) => (
            <div key={u.id} className="text-sm">
              {String(u.reason ?? "不可用")} · {String(u.starts_at)} —{" "}
              {String(u.ends_at)} {editButton("unavailability", u)}
              {evidence("unavailability", u.id)}
            </div>
          ))}
        <details className="text-xs">
          <summary className="cursor-pointer">全部课程与周次</summary>
          {all.timetable_entry
            .filter((e) => e.person_id === p.id)
            .map((e) => (
              <p key={e.id} className="mt-2">
                {display(e)} ·{" "}
                {display(all.term.find((t) => t.id === e.term_id) ?? e)} · 周
                {e.weekday} · {e.weeks}周 · {e.period_from}–{e.period_to}节{" "}
                {editButton("timetable_entry", e)}
              </p>
            ))}
        </details>
      </div>
    </details>
  );
  const org = (o: Row, depth = 0): React.ReactNode => (
    <details
      key={o.id}
      open={depth === 0}
      className="border-t border-slate-200 py-4 dark:border-slate-700"
    >
      <summary className="cursor-pointer font-semibold">
        {display(o)}
        {changed.has("organization:" + o.id) ? " · 有变更" : ""}
      </summary>
      <div className="pl-3 sm:pl-5">
        {editButton("organization", o)}
        {evidence("organization", o.id)}
        {all.person
          .filter(
            (p) =>
              affected.has(p.id) &&
              all.membership.some(
                (m) => m.person_id === p.id && m.org_id === o.id,
              ),
          )
          .map(person)}
        {depth < 20 &&
          all.organization
            .filter((child) => child.parent_id === o.id)
            .map((child) => org(child, depth + 1))}
        {all.task
          .filter(
            (t) =>
              t.org_id === o.id &&
              (changed.has("task:" + t.id) ||
                all.shift.some(
                  (s) =>
                    s.task_id === t.id &&
                    (changed.has("shift:" + s.id) ||
                      all.assignment.some(
                        (a) =>
                          a.shift_id === s.id &&
                          changed.has("assignment:" + a.id),
                      )),
                )),
          )
          .map((t) => (
            <details key={t.id} className="border-t border-slate-200 py-3">
              <summary className="cursor-pointer">任务 · {display(t)}</summary>
              {editButton("task", t)}
              {evidence("task", t.id)}
              {all.shift
                .filter((s) => s.task_id === t.id)
                .map((s) => (
                  <div key={s.id} className="my-3 text-sm">
                    <p>
                      {String(s.starts_at)} — {String(s.ends_at)} ·{" "}
                      {s.required_headcount} 人 {editButton("shift", s)}
                    </p>
                    <p>
                      {all.assignment
                        .filter(
                          (a) => a.shift_id === s.id && a.status !== "declined",
                        )
                        .map((a) => (
                          <span key={a.id}>
                            {display(
                              all.person.find((p) => p.id === a.person_id) ?? a,
                            )}
                            {editButton("assignment", a)}{" "}
                          </span>
                        ))}
                    </p>
                    {evidence("shift", s.id)}
                  </div>
                ))}
            </details>
          ))}
      </div>
    </details>
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-3">
        {!all.term.length && (
          <p className="text-sm text-slate-500">
            学期尚待确认，已识别的课程按原始节次和周次展示。
          </p>
        )}
        {!!all.term.length && (
          <>
            <label className="text-xs">
              查看学期
              <Select
                value={activeTerm}
                disabled={!all.term.length}
                onChange={(e) => {
                  setTerm(e.target.value);
                  setWeek(1);
                }}
              >
                {all.term.map((t) => (
                  <option key={t.id} value={t.id}>
                    {display(t)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="text-xs">
              教学周
              <Select
                value={week}
                onChange={(e) => setWeek(Number(e.target.value))}
              >
                {Array.from(
                  {
                    length: Number(
                      all.term.find((t) => t.id === activeTerm)?.week_count ??
                        1,
                    ),
                  },
                  (_, i) => (
                    <option key={i} value={i + 1}>
                      第 {i + 1} 周
                    </option>
                  ),
                )}
              </Select>
            </label>
          </>
        )}
      </div>
      {!!job.importCheck?.consistency_review?.length && (
        <details>
          <summary className="cursor-pointer font-medium">
            跨课表核对 · {job.importCheck.consistency_review.length} 项
          </summary>
          {job.importCheck.consistency_review.map((item) => (
            <div key={item.key} className="mt-3 text-sm">
              <p>
                {item.key.replace(/^teacher:/, "")} ·{" "}
                {item.resolution === "unresolved" ? "待确认" : "不同任课情境"}
              </p>
              <p className="text-muted">{item.explanation}</p>
              {!!item.checked_variants?.length && (
                <p className="mt-1 text-muted">
                  {item.checked_variants
                    .map(
                      (v) =>
                        `${job.timetables?.[v.timetable_id]?.person.full_name ?? v.timetable_id}：${v.teacher}`,
                    )
                    .join("；")}
                </p>
              )}
            </div>
          ))}
        </details>
      )}
      <CalendarReview job={job} onChange={onChange} onSource={onSource} />
      <details>
        <summary className="cursor-pointer font-medium">学期与作息方案</summary>
        {all.term.map((t) => (
          <div key={t.id} className="mt-3 text-sm">
            <p>
              {display(t)} · 首周 {String(t.start_date)} · {t.week_count} 周{" "}
              {editButton("term", t)}
            </p>
            {evidence("term", t.id)}
            {all.timetable_profile
              .filter((p) => p.term_id === t.id)
              .map((p) => (
                <div key={p.id} className="my-2">
                  <p>
                    {display(p)} {editButton("timetable_profile", p)}
                  </p>
                  <div className="flex flex-wrap gap-3 text-xs">
                    {(
                      JSON.parse(String(p.periods)) as {
                        index: number;
                        start: string;
                        end: string;
                      }[]
                    ).map((x) => (
                      <span key={x.index}>
                        第{x.index}节 {x.start}–{x.end}
                      </span>
                    ))}
                  </div>
                  {evidence("timetable_profile", p.id)}
                </div>
              ))}
          </div>
        ))}
      </details>
      <div>
        {all.organization.filter((o) => !o.parent_id).map((o) => org(o))}
        {all.person
          .filter(
            (p) =>
              affected.has(p.id) &&
              !all.membership.some((m) => m.person_id === p.id),
          )
          .map(person)}
      </div>
      <details>
        <summary className="cursor-pointer text-sm">
          逐项变更对照 · {changes.length} 项
        </summary>
        <div className="mt-3 divide-y divide-slate-200">
          {changes.map((c) => (
            <div key={c.entity + c.id} className="py-3 text-sm">
              <p className={!c.after ? "font-medium text-rose-700" : ""}>
                {c.after ? (c.before ? "修改" : "新增") : "删除"}
                {names[c.entity]} · {display((c.after ?? c.before)!)}{" "}
                {c.after && editButton(c.entity, c.after)}
              </p>
              {c.before && (
                <p className="mt-1 break-words text-xs text-slate-500">
                  {Object.keys(c.before)
                    .filter(
                      (k) =>
                        k !== "id" &&
                        canonicalValue(c.before![k]) !==
                          canonicalValue(c.after?.[k]),
                    )
                    .map(
                      (k) =>
                        `${labels[k] ?? k}：${String(c.before![k] ?? "空")} → ${String(c.after?.[k] ?? "删除")}`,
                    )
                    .join("；")}
                </p>
              )}
              {evidence(c.entity, c.id)}
            </div>
          ))}
        </div>
      </details>
      {proposalEditor && (
        <ProposalEntryEditor
          entry={proposalEditor.entry}
          onClose={() => setProposalEditor(null)}
          onSave={async (value) => {
            await editProposalEntry(
              job,
              proposalEditor.id,
              proposalEditor.index,
              value,
            );
            onChange({ ...job });
          }}
        />
      )}
      {editor && (
        <Modal
          onClose={() => setEditor(null)}
          title={`修改${editor ? names[editor.entity] : ""}`}
        >
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!editor) return;
              try {
                const data = Object.fromEntries(
                  Object.entries(values).map(([k, v]) => [
                    k,
                    v === ""
                      ? null
                      : typeof editor.row[k] === "number"
                        ? Number(v)
                        : v,
                  ]),
                );
                await editRecord(job, editor.entity, editor.row.id, data);
                onChange({ ...job });
                setEditor(null);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {Object.entries(values).map(([k, v]) => (
              <Field key={k} label={labels[k] ?? k}>
                {k === "weeks" ? (
                  <WeeksField
                    value={v}
                    count={Number(
                      all.term.find((t) => t.id === values.term_id)
                        ?.week_count ?? 20,
                    )}
                    onChange={(value) => setValues({ ...values, [k]: value })}
                  />
                ) : k === "periods" ? (
                  <PeriodsField
                    value={v}
                    onChange={(value) => setValues({ ...values, [k]: value })}
                  />
                ) : relations[editor!.entity]?.[k] ? (
                  <Select
                    value={v}
                    onChange={(e) =>
                      setValues({ ...values, [k]: e.target.value })
                    }
                  >
                    <option value="">未指定</option>
                    {all[relations[editor!.entity]![k]].map((r) => (
                      <option key={r.id} value={r.id}>
                        {display(r)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <TextInput
                    value={v}
                    onChange={(e) =>
                      setValues({ ...values, [k]: e.target.value })
                    }
                  />
                )}
              </Field>
            ))}
            {error && (
              <p role="alert" className="text-sm text-rose-700">
                {error}
              </p>
            )}
            <Button type="submit">保存草稿修改</Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function canonicalValue(value: unknown) {
  return JSON.stringify(value);
}
