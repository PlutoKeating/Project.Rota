import { z } from "zod";
import {
  evidenceSchema,
  mutate,
  diff,
  canonical,
  type Snapshot,
  type Evidence,
} from "./model";
const nullableText = z.string().max(1000).nullable().optional();
export const timetableProposalSchema = z.object({
  id: z.string().min(1).max(60),
  person: z.object({
    id: z.string().min(1).max(100),
    full_name: z.string().min(1).max(100),
    student_no: nullableText,
    class_name: nullableText,
    major: nullableText,
  }),
  organization_ids: z.array(z.string()).max(30).default([]),
  term_name: z.string().max(200),
  term_id: z.string().nullable().optional(),
  profile_id: z.string().nullable().optional(),
  entries: z
    .array(
      z
        .object({
          name: z.string().min(1).max(200),
          no_fixed_time: z.boolean().optional(),
          weekday: z.number().int().min(1).max(7).nullable().default(null),
          period_from: z.number().int().min(1).max(48).nullable().default(null),
          period_to: z.number().int().min(1).max(48).nullable().default(null),
          weeks: z
            .array(z.number().int().min(1).max(30))
            .min(1)
            .max(30)
            .nullable()
            .default(null),
          teacher: nullableText,
          location: nullableText,
          note: nullableText,
        })
        .refine(
          (e) =>
            e.period_from === null ||
            e.period_to === null ||
            e.period_from <= e.period_to,
          "节次起止颠倒",
        )
        .refine(
          (e) =>
            !e.no_fixed_time ||
            (e.weekday === null &&
              e.period_from === null &&
              e.period_to === null),
          "明确无固定时段不能同时提供固定星期节次",
        ),
    )
    .max(120),
  sources: z.array(evidenceSchema).min(1).max(30),
  completed_sources: z.array(z.string()).max(30).default([]),
  unresolved: z.array(z.string().max(1000)).max(50).default([]),
});
export type TimetableProposal = z.infer<typeof timetableProposalSchema> & {
  entryIds: string[];
  bound: boolean;
  unscheduledIds?: string[];
};
/** Explicit model-produced fields only. No filename matching, text parsing, or inferred dates. */
export function stageTimetable(
  base: Snapshot,
  evidence: Record<string, Evidence[]>,
  input: z.infer<typeof timetableProposalSchema>,
  previous?: TimetableProposal,
) {
  const draft = structuredClone(base),
    proof = structuredClone(evidence);
  if (previous && previous.person.id !== input.person.id)
    throw Error("修改已有课表方案时不能偷偷换人，请使用新的方案 id");
  const oldPerson = draft.person.find((p) => p.id === input.person.id);
  const personExists = Boolean(oldPerson);
  mutate(
    draft,
    "person",
    personExists ? "update" : "create",
    input.person,
    input.person.id,
  );
  if (
    !oldPerson ||
    canonical(oldPerson) !==
      canonical(draft.person.find((p) => p.id === input.person.id))
  )
    proof["person:" + input.person.id] = input.sources;
  for (const org_id of input.organization_ids) {
    if (!draft.organization.some((o) => o.id === org_id))
      throw Error("部门不存在：" + org_id);
    if (
      !draft.membership.some(
        (m) =>
          m.person_id === input.person.id &&
          m.org_id === org_id &&
          m.status === "active",
      )
    ) {
      const id = mutate(draft, "membership", "create", {
        person_id: input.person.id,
        org_id,
      });
      proof["membership:" + id] = input.sources;
    }
  }
  const bound = Boolean(input.term_id && input.profile_id);
  if (
    bound &&
    (!draft.term.some((t) => t.id === input.term_id) ||
      !draft.timetable_profile.some(
        (p) => p.id === input.profile_id && p.term_id === input.term_id,
      ))
  )
    throw Error("学期或作息不存在，先保留未绑定方案，不要猜造引用");
  for (const id of previous?.entryIds ?? []) {
    mutate(draft, "timetable_entry", "delete", {}, id);
    proof["timetable_entry:" + id] = input.sources;
  }
  for (const id of previous?.unscheduledIds ?? []) {
    mutate(draft, "enrollment", "delete", {}, id + ":enrollment");
    mutate(draft, "course", "delete", {}, id);
    proof["enrollment:" + id + ":enrollment"] = input.sources;
    proof["course:" + id] = input.sources;
  }
  const entryIds: string[] = [],
    unscheduledIds: string[] = [];
  if (bound)
    for (const [i, e] of input.entries.entries()) {
      if (e.no_fixed_time) {
        const id = input.id + ":untimed:" + i;
        if (draft.course.some((c) => c.id === id))
          throw Error("无固定时段课程 ID 冲突：" + id);
        mutate(
          draft,
          "course",
          "create",
          {
            id,
            term_id: input.term_id,
            name: e.name,
            teacher: e.teacher ?? null,
            created_at: base.course.find((c) => c.id === id)?.created_at,
          },
          id,
        );
        mutate(
          draft,
          "enrollment",
          "create",
          {
            id: id + ":enrollment",
            person_id: input.person.id,
            course_id: id,
            term_id: input.term_id,
            created_at: base.enrollment.find((c) => c.id === id + ":enrollment")
              ?.created_at,
          },
          id + ":enrollment",
        );
        proof["course:" + id] = input.sources;
        proof["enrollment:" + id + ":enrollment"] = input.sources;
        unscheduledIds.push(id);
        continue;
      }
      if (
        e.weekday === null ||
        e.period_from === null ||
        e.period_to === null ||
        e.weeks === null
      )
        continue;
      const id = input.id + ":" + i;
      if (draft.timetable_entry.some((e) => e.id === id))
        throw Error("课表 ID 与已有记录冲突：" + id);
      mutate(
        draft,
        "timetable_entry",
        "create",
        {
          id,
          created_at: base.timetable_entry.find((row) => row.id === id)
            ?.created_at,
          person_id: input.person.id,
          term_id: input.term_id,
          profile_id: input.profile_id,
          name: e.name,
          weekday: e.weekday,
          period_from: e.period_from,
          period_to: e.period_to,
          weeks: JSON.stringify([...new Set(e.weeks)].sort((a, b) => a - b)),
          teacher: e.teacher ?? null,
          location: e.location ?? null,
        },
        id,
      );
      proof["timetable_entry:" + id] = input.sources;
      entryIds.push(id);
    }
  return {
    draft,
    evidence: proof,
    proposal: { ...input, bound, entryIds, unscheduledIds },
    changed: diff(base, draft, proof).length > 0,
  };
}

/** Checks only explicit structured fields; warnings never invent or remove a source fact. */
export function timetableWarnings(
  entries: TimetableProposal["entries"],
): string[] {
  const warnings: string[] = [];
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i],
        b = entries[j];
      if (
        a.weekday === null ||
        a.weekday !== b.weekday ||
        a.period_from === null ||
        b.period_from === null ||
        a.period_to === null ||
        b.period_to === null ||
        !a.weeks ||
        !b.weeks
      )
        continue;
      const weeks = a.weeks.filter((w) => b.weeks!.includes(w));
      if (
        weeks.length &&
        a.period_from <= b.period_to &&
        b.period_from <= a.period_to
      )
        warnings.push(
          `第 ${i + 1} 项「${a.name}」与第 ${j + 1} 项「${b.name}」在周${a.weekday}、第${weeks.join("、")}周时段重叠。核对原图行对应关系与重复记录；真实冲突保留来源说明。`,
        );
    }
  return warnings;
}

/** Explicit indexes for model patch calls; never persisted as business fields. */
export function proposalForModel(plan: TimetableProposal) {
  return {
    ...plan,
    entries: plan.entries.map((entry, index) => ({ index, ...entry })),
  };
}
