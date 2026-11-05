import {
  canonical,
  mutate,
  type Evidence,
} from "../../shared/agent-import/model";
import {
  calendarMissing,
  stageCalendar,
  calendarThroughWeeks,
} from "../../shared/agent-import/calendar";
import {
  matchPerson,
  personInformationSchema,
} from "../../shared/agent-import/person-workspace";
import {
  stageTimetable,
  pendingTimedEntries,
  type TimetableProposal,
} from "../../shared/agent-import/timetable";
import { proposalSignature } from "./verification";
import type { Job } from "./state";

/** One deterministic writer: person agents never mutate shared business rows. */
export function projectPeople(job: Job) {
  if (!job.session) return;
  let draft = structuredClone(job.base);
  let evidence: Record<string, Evidence[]> = {};
  const plans: Record<string, TimetableProposal> = {};
  const checks: NonNullable<Job["timetableChecks"]> = {};
  const issues: string[] = [];
  for (const org of job.session.organizations) {
    const { sources, ...row } = org;
    const existing = draft.organization.find((o) => o.id === row.id);
    if (
      existing &&
      canonical({ name: existing.name, parent_id: existing.parent_id }) !==
        canonical({ name: row.name, parent_id: row.parent_id })
    )
      throw Error("部门引用与现有部门不一致：" + row.id);
    if (!existing) {
      mutate(draft, "organization", "create", row, row.id);
      evidence["organization:" + row.id] = sources;
    }
  }
  const bindings = new Map<string, { termId: string; profileId: string }>();
  const calendars = structuredClone(job.calendars ?? {});
  for (const proposed of Object.values(calendars)) {
    const tables = Object.values(job.session.people)
      .filter((p) => p.status === "done")
      .flatMap((p) => Object.values(p.timetables))
      .filter((t) => t.calendar_id === proposed.id);
    const calendar = calendarThroughWeeks(proposed, tables.flatMap((t) =>
      t.entries.flatMap((e) => e.weeks ?? [])));
    // Preserve the course evidence supporting the derived storage horizon.
    const horizonSources = tables.filter((t) => t.entries.some((e) =>
      e.weeks?.includes(calendar.week_count!))).flatMap((t) => t.sources);
    calendar.sources = [...new Map([...calendar.sources, ...horizonSources]
      .map((source) => [canonical(source), source])).values()].slice(0, 30);
    calendars[calendar.id] = calendar;
    if (calendarMissing(calendar).length) continue;
    const staged = stageCalendar(draft, evidence, calendar);
    draft = staged.draft;
    evidence = staged.evidence;
    bindings.set(calendar.id, staged);
    calendars[calendar.id] = staged.calendar;
  }
  const owners = new Map<string, string>();
  const scopes = new Map<string, Set<number>>();
  for (const p of Object.values(job.session.people)) {
    if (!p.information || p.status !== "done") {
      issues.push(p.label + "：人员对象尚未完成");
      continue;
    }
    p.match = matchPerson(p.information, job.base.person);
    if (p.identityChoice?.information === canonical(p.information)) {
      const id = p.identityChoice.id;
      if (id && !job.base.person.some((row) => row.id === id))
        throw Error("人工选择的人员已不存在");
      p.match = {
        id: id ?? undefined,
        candidates: [],
        reason: id ? "操作员明确选择现有人员" : "操作员确认新人员",
      };
    }
    if (!p.match.id && p.match.candidates.length) {
      issues.push(p.label + "：" + p.match.reason);
      continue;
    }
    const personId = p.match.id ?? p.personId;
    // Also protect duplicate new people in the same package.
    const identityKey = p.information.student_no?.trim()
      ? "student:" + p.information.student_no.trim()
      : "name:" +
        p.information.full_name.trim() +
        ":" +
        (p.information.class_name ?? "");
    for (const key of ["id:" + personId, identityKey]) {
      const owner = owners.get(key);
      if (owner && owner !== p.key)
        throw Error("重复人员对象，请协调合并：" + p.label);
      owners.set(key, p.key);
    }
    const existing = job.base.person.find((row) => row.id === personId);
    // Existing A stays authoritative; only B is replaced, as in the import contract.
    const person = {
      ...(existing ? personInformationSchema.parse(existing) : p.information),
      id: personId,
    };
    for (const table of Object.values(p.timetables)) {
      const id = p.id + ":" + table.key;
      const binding =
        table.entries.length && table.calendar_id
          ? bindings.get(table.calendar_id)
          : undefined;
      const hasUnknownTime = pendingTimedEntries(table.entries).length > 0;
      if (binding) {
        const scopeKey = personId + ":" + binding.termId;
        const weeks =
          table.replace_weeks ??
          Array.from(
            {
              length: Number(
                draft.term.find((t) => t.id === binding.termId)!.week_count,
              ),
            },
            (_, i) => i + 1,
          );
        if (table.entries.some((e) => e.weeks?.some((w) => !weeks.includes(w))))
          throw Error(p.label + "：课程周次超出声明的覆盖范围");
        const previousScope = scopes.get(scopeKey) ?? new Set<number>();
        if (weeks.some((w) => previousScope.has(w)))
          throw Error(p.label + "：同学期多个课表覆盖范围重叠，请先合并");
        scopes.set(scopeKey, new Set([...previousScope, ...weeks]));
        if (!job.excluded.includes(personId)) {
          for (const entry of [...draft.timetable_entry].filter(
            (e) => e.person_id === personId && e.term_id === binding.termId,
          )) {
            const remaining = (
              JSON.parse(String(entry.weeks)) as number[]
            ).filter((w) => !weeks.includes(w) || (hasUnknownTime &&
              !table.entries.some((known) => known.name === entry.name &&
                known.weekday === entry.weekday && known.period_from === entry.period_from &&
                known.period_to === entry.period_to && known.weeks?.includes(w))));
            if (
              remaining.length ===
              (JSON.parse(String(entry.weeks)) as number[]).length
            )
              continue;
            mutate(
              draft,
              "timetable_entry",
              remaining.length ? "update" : "delete",
              remaining.length ? { weeks: JSON.stringify(remaining) } : {},
              entry.id,
            );
            evidence["timetable_entry:" + entry.id] = table.sources;
          }
          const enrollments = draft.enrollment.filter(
            (e) => e.person_id === personId && e.term_id === binding.termId,
          );
          if ((table.replace_weeks || hasUnknownTime) && enrollments.length)
            throw Error(
              p.label +
                "：已有共享课程选课，局部覆盖须先在课程管理中明确处理，不能删除其他周",
            );
          if (!table.replace_weeks)
            for (const enrollment of enrollments) {
              mutate(draft, "enrollment", "delete", {}, enrollment.id);
              evidence["enrollment:" + enrollment.id] = table.sources;
            }
        }
      }
      const staged = stageTimetable(draft, evidence, {
        ...table,
        id,
        person,
        organization_ids: p.organization_ids,
        term_id: binding?.termId,
        profile_id: binding?.profileId,
        completed_sources: p.sources,
      });
      draft = staged.draft;
      evidence = staged.evidence;
      plans[id] = staged.proposal;
      if (p.checks[table.key])
        checks[id] = {
          signature: proposalSignature(staged.proposal),
          summary: "人员子智能体已逐项回看来源",
          at: Date.now(),
          checks: p.checks[table.key],
        };
    }
  }
  for (const c of Object.values(calendars))
    c.timetable_ids = Object.values(job.session.people).flatMap((p) =>
      Object.values(p.timetables)
        .filter((t) => t.calendar_id === c.id)
        .map((t) => p.id + ":" + t.key),
    );
  job.draft = draft;
  job.calendars = calendars;
  job.evidence = evidence;
  job.timetables = plans;
  job.timetableChecks = checks;
  job.session.issues = issues;
  job.revision++;
  job.validatedRevision = -1;
  job.importCheck = undefined;
}
