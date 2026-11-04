import { z } from "zod";
import type { TimetableProposal } from "./timetable";
export const consistencyReviewSchema = z.object({
  key: z.string().max(1000),
  resolution: z.enum(["different_context", "unresolved"]),
  explanation: z.string().min(1).max(2000),
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
      "跨课表教师差异尚未逐项核对。read_course_consistency 查看当前差异，回看来源修正；确属不同任课情境或仍无法确定时逐项说明。",
    );
}
