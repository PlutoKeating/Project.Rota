import { canonical } from "./model";
import { z } from "zod";
import type { TimetableProposal } from "./timetable";
export const consistencyReviewSchema = z.object({
  key: z.string().max(1000),
  resolution: z.enum(["different_context", "unresolved"]),
  explanation: z.string().min(1).max(2000),
  checked_variants: z
    .array(z.object({ timetable_id: z.string(), teacher: z.string() }))
    .max(200)
    .default([]),
});
export type ConsistencyReview = z.infer<typeof consistencyReviewSchema>;
/** Compare only explicit LLM-produced fields; never interpret or merge source material. */
export function courseConflicts(plans: TimetableProposal[]) {
  const groups = new Map<
    string,
    {
      key: string;
      course: string;
      variants: {
        teacher: string;
        timetable_id: string;
        person: string;
        term: string | null;
        class_name?: string | null;
        entries: number[];
        sources: TimetableProposal["sources"];
      }[];
    }
  >();
  for (const plan of plans)
    for (const [index, entry] of plan.entries.entries()) {
      if (!entry.teacher?.trim()) continue;
      const course = entry.name.normalize("NFKC").replace(/\s+/g, " ").trim();
      const key = `teacher:${course}`;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { key, course, variants: [] }));
      const teacher = entry.teacher.trim();
      const existing = group.variants.find(
        (v) => v.timetable_id === plan.id && v.teacher === teacher,
      );
      if (existing) existing.entries.push(index);
      else
        group.variants.push({
          teacher,
          timetable_id: plan.id,
          person: plan.person.full_name,
          term: plan.term_name,
          class_name: plan.person.class_name,
          entries: [index],
          sources: plan.sources,
        });
    }
  return [...groups.values()].filter(
    (g) => new Set(g.variants.map((v) => v.teacher)).size > 1,
  );
}
export function validateConsistencyReview(
  conflicts: ReturnType<typeof courseConflicts>,
  reviews: ConsistencyReview[],
) {
  const keys = new Set(conflicts.map((c) => c.key));
  if (
    new Set(reviews.map((r) => r.key)).size !== reviews.length ||
    reviews.some((r) => !keys.has(r.key)) ||
    conflicts.some((c) => !reviews.some((r) => r.key === c.key))
  )
    throw Error(
      "跨课表教师差异尚未逐项核对。查看工作状态中的 conflicts 当前差异，回看来源修正；确属不同任课情境或仍无法确定时逐项说明。",
    );
}

export function validateCheckedVariants(
  group: ReturnType<typeof courseConflicts>[number],
  review: ConsistencyReview,
) {
  const key = (v: { timetable_id: string; teacher: string }) =>
    JSON.stringify([v.timetable_id, v.teacher]);
  const expected = group.variants.map(key).sort();
  const actual = review.checked_variants.map(key).sort();
  if (canonical(expected) !== canonical(actual))
    throw Error(
      "核对结论须逐项引用当前真实的 timetable_id 与 teacher，不能编造或遗漏；请读取当前差异详情。",
    );
}

export type ConsistencyCheckpoints = Record<string, {
  signature: string;
  review: ConsistencyReview;
}>;
export function retainedConsistencyReviews(
  conflicts: ReturnType<typeof courseConflicts>,
  checkpoints: ConsistencyCheckpoints = {},
): ConsistencyReview[] {
  return conflicts.flatMap((group) => {
    const saved = checkpoints[group.key];
    return saved?.signature === canonical(group) ? [saved.review] : [];
  });
}
