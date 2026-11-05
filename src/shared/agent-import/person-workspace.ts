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
export const recheckEntriesSchema = z.array(z.object({
  key: z.string().min(1).max(30),
  indices: z.array(z.number().int().min(0).max(119)).min(1).max(120),
})).min(1).max(30);
export const revisionRequestSchema = z.object({
  key: z.string(),
  instruction: z.string().min(1).max(4000),
  recheck_entries: recheckEntriesSchema.optional(),
  sources: z.array(z.string()).max(100).optional(),
});
export type RevisionRequest = z.infer<typeof revisionRequestSchema>;
export interface ConsistencyWorkspace {
  id: string;
  keys: string[];
  signature: string;
  agent: AgentState;
  revisions: RevisionRequest[];
  done: boolean;
}
/** Combine independent findings before changing a person, preserving every instruction. */
export function mergeRevisionRequests(requests: RevisionRequest[]) {
  const merged = new Map<string, RevisionRequest>();
  for (const request of requests) {
    const previous = merged.get(request.key);
    if (!previous) { merged.set(request.key, structuredClone(request)); continue; }
    const scopes = new Map<string, Set<number>>();
    if (previous.recheck_entries && request.recheck_entries)
      for (const item of [...previous.recheck_entries, ...request.recheck_entries])
        scopes.set(item.key, new Set([...(scopes.get(item.key) ?? []), ...item.indices]));
    merged.set(request.key, revisionRequestSchema.parse({
      key: request.key,
      instruction: previous.instruction + "\n" + request.instruction,
      sources: [...new Set([...(previous.sources ?? []), ...(request.sources ?? [])])],
      recheck_entries: scopes.size ? [...scopes].map(([key, indices]) => ({ key, indices: [...indices] })) : undefined,
    }));
  }
  return [...merged.values()];
}
/** Route only explicit, independently checked names; never copy course facts or infer from folders. */
export function misplacedSourceRevisions(people: PersonWorkspace[], active: ReadonlySet<string> = new Set()): RevisionRequest[] {
  const norm = (value: string) => value.normalize("NFKC").trim();
  const candidates = new Map<string, Set<string>>();
  for (const donor of people) {
    if (donor.status !== "done" || active.has(donor.key)) continue;
    for (const table of Object.values(donor.timetables)) {
      const check = donor.checks[table.key];
      const names = [...new Set((check?.source_person_names ?? []).map(norm))];
      if (table.entries.length || check?.coverage !== "missing" || names.length !== 1) continue;
      const matches = people.filter((p) => p.information && norm(p.information.full_name) === names[0]);
      if (matches.length !== 1 || matches[0].key === donor.key || matches[0].status !== "done" || active.has(matches[0].key)) continue;
      const target = matches[0];
      const paths = candidates.get(target.key) ?? new Set<string>();
      for (const source of table.sources)
        if (donor.sources.includes(source.source) && !target.sources.includes(source.source)) paths.add(source.source);
      if (paths.size) candidates.set(target.key, paths);
    }
  }
  return [...candidates].filter(([, paths]) => paths.size <= 100).map(([key, paths]) => ({
    key, sources: [...paths],
    instruction: "其他人员的缺失课表复核在原件印出你的姓名，补充来源供你独立核实。请回看全部来源确认身份，合并互补课程、避免重复条目，并核对底部无固定时段课程；来源属于他人时保留错放说明，不得复制他人课程。",
  }));
}
/** Preserve only previously completed independent observations outside explicit revision targets. */
export function revisionAgent(
  person: PersonWorkspace,
  sources: string[],
  recheck?: z.infer<typeof recheckEntriesSchema>,
): AgentState {
  const agent = emptyAgent();
  if (!recheck) return agent;
  const targets = new Map<string, Set<number>>();
  for (const item of recheck) {
    const table = person.timetables[item.key];
    if (!table || targets.has(item.key) || new Set(item.indices).size !== item.indices.length ||
        item.indices.some((index) => !table.entries[index]))
      throw Error("返工范围必须引用真实且不重复的课表/课程索引");
    targets.set(item.key, new Set(item.indices));
  }
  if (person.status !== "done" || canonical([...sources].sort()) !== canonical([...person.sources].sort()))
    return agent;
  for (const table of Object.values(person.timetables)) {
    const observations = person.agent.verifiedEntries?.[table.key];
    if (!observations || !person.checks[table.key]) continue;
    try { validateVerifiedEntries(table, observations); }
    catch { continue; } // Stale or partial observations cannot certify unchanged entries.
    (agent.verifiedEntries ??= {})[table.key] = structuredClone(observations
      .filter((entry) => !targets.get(table.key)?.has(entry.index)));
  }
  return agent;
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
  openedArchives?: string[];
  reconcileImageScope?: string;
  evictedImageSources?: string[];
  // Independent observations; explicit same-source revisions may retain unaffected entries.
  verifiedEntries?: Record<string, z.infer<typeof verifiedEntrySchema>[]>;
  turns: number;
  failures: number;
  retryableFailure?: boolean;
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
  checks: Record<string, FieldChecks & { source_person_names?: string[]; source_student_numbers?: string[] }>;
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
  consistencyWorkers?: ConsistencyWorkspace[];
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
