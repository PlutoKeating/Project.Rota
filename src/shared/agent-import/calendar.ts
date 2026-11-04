import type { TimetableProposal } from "./timetable";
import { z } from "zod";
import {
  canonical,
  evidenceSchema,
  mutate,
  type Snapshot,
  type Evidence,
} from "./model";
const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .nullable();
export const calendarSchema = z
  .object({
    id: z.string().min(1).max(60),
    name: z.string().min(1).max(200),
    term_id: z.string().min(1).max(100).nullable().default(null),
    start_date: z.iso.date().nullable(),
    week_count: z.number().int().min(1).max(30).nullable(),
    minimum_weeks: z.number().int().min(1).max(30).nullable().default(null),
    periods: z
      .array(
        z.object({
          index: z.number().int().min(1).max(48),
          start: clock,
          end: clock,
        }),
      )
      .max(48),
    timetable_ids: z.array(z.string()).max(100),
    sources: z.array(evidenceSchema).min(1).max(30),
    unresolved: z.array(z.string().max(1000)).max(50).default([]),
  })
  .superRefine((c, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (c.start_date && new Date(c.start_date + "T00:00:00Z").getUTCDay() !== 1)
      invalid("首周日期必须是周一");
    if (c.week_count && c.minimum_weeks && c.week_count < c.minimum_weeks)
      invalid("总周数不能小于已知课程周次");
    if (new Set(c.periods.map((p) => p.index)).size !== c.periods.length)
      invalid("节次重复");
    for (const p of c.periods)
      if (p.start && p.end && p.start >= p.end)
        invalid("下课时间必须晚于上课时间");
  });
export type CalendarProposal = z.infer<typeof calendarSchema>;
export function calendarMissing(c: CalendarProposal) {
  return [
    ...(!c.start_date ? ["第一教学周周一"] : []),
    ...(!c.week_count ? ["总教学周数（至少多少周不能代替总周数）"] : []),
    ...(!c.periods.length ? ["节次作息"] : []),
    ...c.periods.flatMap((p) => [
      ...(!p.start ? [`第${p.index}节上课时间`] : []),
      ...(!p.end ? [`第${p.index}节下课时间`] : []),
    ]),
  ];
}
/** Only materializes explicitly supplied complete fields. Never derives a calendar from business text. */
export function stageCalendar(
  base: Snapshot,
  proof: Record<string, Evidence[]>,
  c: CalendarProposal,
) {
  const missing = calendarMissing(c);
  if (missing.length) throw Error("作息尚不完整：" + missing.join("、"));
  const draft = structuredClone(base),
    evidence = structuredClone(proof);
  const termId = c.term_id ?? c.id + ":term",
    profileId = c.id + ":profile";
  const existingTerm = draft.term.find((t) => t.id === termId);
  if (c.term_id && !existingTerm) throw Error("明确引用的学期不存在");
  if (
    c.term_id &&
    (existingTerm!.start_date !== c.start_date ||
      existingTerm!.week_count !== c.week_count)
  )
    throw Error("日历与引用学期不一致，请先核对");
  const put = (
    entity: "term" | "timetable_profile" | "class_period",
    id: string,
    data: Record<string, unknown>,
  ) => {
    mutate(
      draft,
      entity,
      draft[entity].some((r) => r.id === id) ? "update" : "create",
      { ...data, id },
      id,
    );
    evidence[entity + ":" + id] = c.sources;
  };
  if (!c.term_id)
    put("term", termId, {
      name: c.name,
      start_date: c.start_date,
      week_count: c.week_count,
    });
  put("timetable_profile", profileId, {
    term_id: termId,
    name: c.name,
    periods: JSON.stringify(c.periods),
  });
  if (!c.term_id || !draft.class_period.some((p) => p.term_id === termId))
    for (const p of c.periods)
      put("class_period", c.id + ":period:" + p.index, {
        term_id: termId,
        period_index: p.index,
        start_time: p.start,
        end_time: p.end,
      });
  return { draft, evidence, termId, profileId };
}
export const fieldChecksSchema = z.object({
  identity: z.string().min(1).max(1000),
  courses_and_times: z.string().min(1).max(2000),
  teachers_and_locations: z.string().min(1).max(2000),
  calendar: z.string().min(1).max(2000),
  coverage: z.enum(["complete", "partial", "missing"]),
  coverage_reason: z.string().min(1).max(2000),
  checked_entries: z.array(z.number().int().min(0)).max(120),
});
export type FieldChecks = z.infer<typeof fieldChecksSchema>;

export function calendarBindingIssues(job: {
  draft: Snapshot;
  calendars?: Record<string, CalendarProposal>;
  timetables?: Record<string, TimetableProposal>;
  excluded: string[];
}) {
  const issues: string[] = [];
  for (const c of Object.values(job.calendars ?? {})) {
    if (
      !Object.values(job.timetables ?? {}).some(
        (t) =>
          t.bound &&
          !job.excluded.includes(t.person.id) &&
          t.profile_id === c.id + ":profile",
      )
    )
      continue;
    const term = job.draft.term.find(
      (t) => t.id === (c.term_id ?? c.id + ":term"),
    );
    const profile = job.draft.timetable_profile.find(
      (p) => p.id === c.id + ":profile",
    );
    if (
      !term ||
      !profile ||
      term.start_date !== c.start_date ||
      term.week_count !== c.week_count ||
      canonical(JSON.parse(String(profile.periods))) !== canonical(c.periods)
    )
      issues.push(`${c.name}：日历证据已变更，须重新生成并核对绑定的学期/作息`);
  }
  return issues;
}
