import { z } from "zod";
import { calendarSchema, type FieldChecks } from "./calendar";
import { timetableProposalSchema } from "./timetable";
import { canonical, evidenceSchema, type Row } from "./model";
import type { ConsistencyCheckpoints } from "./consistency";
import type { CoverageState } from "./coverage";
import type { ModelMessage } from "ai";

export const personInformationSchema =
  timetableProposalSchema.shape.person.omit({ id: true });
export const personTableSchema = timetableProposalSchema
  .omit({
    id: true,
    person: true,
    organization_ids: true,
    term_id: true,
    profile_id: true,
    completed_sources: true,
  })
  .extend({
    key: z.string().min(1).max(30).describe("短标识，例如 main 或 fall；不必重复姓名与学期，最多30字符。"),
    calendar_id: z.string().nullable().default(null),
    // A partial source may replace only its explicit teaching weeks.
    replace_weeks: z
      .array(z.number().int().min(1).max(30))
      .min(1)
      .max(30)
      .nullable()
      .default(null),
  });
export type PersonTable = z.infer<typeof personTableSchema>;
export const assignmentSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  sources: z.array(z.string().min(1)).min(1).max(100),
  instruction: z.string().max(4000).default(""),
  organization_ids: z.array(z.string()).max(30).default([]),
});
export const organizationSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  parent_id: z.string().nullable().default(null),
  sources: z.array(evidenceSchema).min(1).max(30),
});
export const writePersonSchema = z.object({
  information: personInformationSchema.optional(),
  timetables: z.array(personTableSchema).max(30).default([]),
  mode: z.enum(["replace", "append"]).default("replace"),
  remove_keys: z.array(z.string()).max(30).default([]),
  calendar_evidence: z.array(calendarSchema).max(10).default([]),
  unresolved: z.array(z.string().max(1000)).max(50).optional(),
});
// A source reread must agree with persisted facts, not merely claim all indices checked.
export const verifiedEntrySchema = z
  .object(timetableProposalSchema.shape.entries.element.shape)
  .omit({ note: true })
  .extend({ index: z.number().int().min(0).max(119) });
export function validateVerifiedEntries(
  table: PersonTable,
  verified: z.infer<typeof verifiedEntrySchema>[],
) {
  if (
    verified.length !== table.entries.length ||
    new Set(verified.map((e) => e.index)).size !== table.entries.length
  )
    throw Error("复核值必须逐条覆盖课程：" + table.key);
  const facts = (entry: PersonTable["entries"][number]) => ({
    name: entry.name,
    no_fixed_time: entry.no_fixed_time ?? false,
    weekday: entry.weekday,
    period_from: entry.period_from,
    period_to: entry.period_to,
    weeks:
      entry.weeks === null
        ? null
        : [...new Set(entry.weeks)].sort((a, b) => a - b),
    teacher: entry.teacher ?? null,
    location: entry.location ?? null,
  });
  const mismatches: string[] = [];
  for (const entry of verified) {
    const saved = table.entries[entry.index];
    if (!saved) {
      mismatches.push(`${table.key}[${entry.index}]（索引不存在）`);
      continue;
    }
    const expected = facts(saved), actual = facts(entry);
    const fields = (Object.keys(expected) as (keyof typeof expected)[])
      .filter((key) => canonical(expected[key]) !== canonical(actual[key]));
    if (fields.length)
      mismatches.push(`${table.key}[${entry.index}]（${fields.join("、")}）`);
  }
  if (mismatches.length)
    throw Error(
      `复核值与已存课程不一致：${mismatches.join("；")}；请回看来源，用 amend_timetable 一次修正以上全部差异后再完成`,
    );
}
export interface AgentState {
  runId: string;
  pendingImages: { path: string; image: string }[];
  messages: ModelMessage[];
  pending: {
    id: string;
    name: string;
    args: unknown;
    validationError?: string;
  }[];
  coverage: Record<string, CoverageState>;
  turns: number;
  failures: number;
  error?: string;
}
export const emptyAgent = (): AgentState => ({
  runId: crypto.randomUUID(),
  pendingImages: [],
  messages: [],
  pending: [],
  coverage: {},
  turns: 0,
  failures: 0,
});
export interface PersonWorkspace extends z.infer<typeof assignmentSchema> {
  id: string;
  personId: string;
  information?: z.infer<typeof personInformationSchema>;
  timetables: Record<string, PersonTable>;
  calendarEvidence: z.infer<typeof calendarSchema>[];
  unresolved: string[];
  status: "queued" | "extracting" | "verifying" | "done" | "failed";
  version: number;
  resumeStatus?: "extracting" | "verifying";
  agent: AgentState;
  checks: Record<string, FieldChecks>;
  identityChoice?: { id: string | null; information: string };
  match?: { id?: string; candidates: string[]; reason: string };
}
export interface ImportSession {
  version: 1;
  phase: "discover" | "people" | "reconcile" | "review";
  coordinator: AgentState;
  people: Record<string, PersonWorkspace>;
  organizations: z.infer<typeof organizationSchema>[];
  consistencyCheckpoints?: ConsistencyCheckpoints;
  concurrency: number;
  issues: string[];
}
export const emptySession = (): ImportSession => ({
  version: 1,
  phase: "discover",
  coordinator: emptyAgent(),
  people: {},
  organizations: [],
  concurrency: 16,
  issues: [],
});
export function matchPerson(
  info: z.infer<typeof personInformationSchema>,
  rows: Row[],
) {
  const norm = (v: unknown) =>
    String(v ?? "")
      .normalize("NFKC")
      .trim();
  if (norm(info.student_no)) {
    const candidates = rows.filter(
      (p) => norm(p.student_no) === norm(info.student_no),
    );
    if (
      candidates.length === 1 &&
      norm(candidates[0].full_name) === norm(info.full_name)
    )
      return {
        id: candidates[0].id,
        candidates: [candidates[0].id],
        reason: "学号和姓名一致",
      };
    if (candidates.length)
      return {
        candidates: candidates.map((p) => p.id),
        reason: "学号对应身份冲突",
      };
  }
  const sameName = rows.filter(
    (p) => norm(p.full_name) === norm(info.full_name),
  );
  const candidates = sameName.filter(
    (p) =>
      (!norm(info.student_no) || !norm(p.student_no)) &&
      (!norm(info.class_name) || norm(p.class_name) === norm(info.class_name)),
  );
  if (
    candidates.length === 1 &&
    norm(info.class_name) &&
    norm(candidates[0].class_name) === norm(info.class_name)
  )
    return {
      id: candidates[0].id,
      candidates: [candidates[0].id],
      reason: "姓名与班级唯一匹配",
    };
  return {
    candidates: candidates.map((p) => p.id),
    reason: candidates.length ? "身份信息不足或存在同名，请确认" : "新人员",
  };
}
