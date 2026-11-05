import { canonical, diff } from "../../shared/agent-import/model";
import { pendingTimedEntries } from "../../shared/agent-import/timetable";
import type { Job } from "./store";
export function importSignature(job: Job) {
  return canonical({
    policy: 3,
    draft: job.draft,
    timetables: job.timetables,
    calendars: job.calendars,
    excluded: job.excluded,
    people: job.session
      ? Object.values(job.session.people).map((p) => [
          p.key,
          p.version,
          p.status,
        ])
      : undefined,
  });
}
export function needsImportCheck(job: Job) {
  return (
    Object.keys(job.timetables ?? {}).length > 0 &&
    job.importCheck?.signature !== importSignature(job)
  );
}
export function reviewSummary(job: Job, submitted = job.status === "applied") {
  const plans = Object.values(job.timetables ?? {}).filter(
    (p) => !job.excluded.includes(p.person.id),
  );
  const changes = diff(job.base, job.draft, job.evidence);
  const added = (entity: string) =>
    changes.filter(
      (c) =>
        c.entity === entity &&
        !c.before &&
        c.after &&
        (entity !== "person" || !job.excluded.includes(c.id)),
    ).length;
  const partial = plans.filter(
    (p) => job.timetableChecks?.[p.id]?.checks?.coverage !== "complete",
  ).length;
  const pending = plans.reduce((n, p) => n + pendingTimedEntries(p.entries).length, 0);
  return `${submitted ? "已提交" : "待审核"}：${new Set(plans.map((p) => p.person.id)).size} 人、${plans.reduce((n, p) => n + p.entries.length, 0)} 项课程（其中 ${pending} 项时段待补，仅保存在审核报告，尚未形成占用）；${plans.filter((p) => p.entries.length && !p.bound).length} 份课表待绑定学期/作息，${partial} 份材料不完整或完整性未确认。新增人员 ${added("person")}、部门 ${added("organization")}、学期 ${added("term")}。${submitted ? "正式数据已提交。" : "正式数据尚未提交。"}`;
}

export { calendarBindingIssues } from "../../shared/agent-import/calendar";
