import { api } from "../lib/api";
import {
  applyChanges,
  canonical,
  diff,
  materialize,
  mutate,
  validateTransition,
  type Change,
  type Entity,
  type Snapshot,
} from "../../shared/agent-import/model";
import {
  emptySession,
  emptyAgent,
} from "../../shared/agent-import/person-workspace";
import {
  timetableProposalSchema,
  stageTimetable,
  timetableWarnings,
  pendingTimedEntries,
} from "../../shared/agent-import/timetable";
import {
  calendarSchema,
  calendarMissing,
  stageCalendar,
} from "../../shared/agent-import/calendar";
import { reviewArtifactSchema } from "../../shared/agent-import/review-artifact";
import { needsVerification, proposalSignature } from "./verification";
import {
  calendarBindingIssues,
  needsImportCheck,
  reviewSummary,
} from "./readiness";
import {
  materials,
  saveJob,
  addFiles,
  RETENTION,
  type Job,
  withJobLock,
} from "./store";
import { projectPeople } from "./projection";
export { ImportRunner } from "./person-runner";
export function changesFor(job: Job): Change[] {
  const changes = diff(job.base, job.draft, job.evidence);
  const excluded = new Set(job.excluded);
  const skip = new Set<string>(job.excluded.map((id) => "person:" + id));
  for (const p of Object.values(job.timetables ?? {}))
    if (excluded.has(p.person.id))
      for (const c of changes.filter(
        (c) => c.entity === "course" && c.id.startsWith(p.id + ":untimed:"),
      ))
        skip.add("course:" + c.id);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of changes) {
      const r = c.after ?? c.before;
      if (
        r &&
        (excluded.has(String(r.person_id)) ||
          (c.entity === "assignment" && skip.has("shift:" + r.shift_id)))
      ) {
        const key = c.entity + ":" + c.id;
        if (!skip.has(key)) {
          skip.add(key);
          grew = true;
        }
      }
    }
  }
  return changes.filter((c) => !skip.has(c.entity + ":" + c.id));
}
export async function createJob(owner: string, files: File[]): Promise<Job> {
  const [{ id }, { data }] = await Promise.all([
    api.post<{ id: string }>("/agent-imports"),
    api.get<{ data: Snapshot }>("/agent-imports/snapshot"),
  ]);
  const job: Job = {
    id,
    owner,
    title: files[0]?.name ?? "导入材料",
    status: "paused",
    harnessVersion: 4,
    createdAt: Date.now(),
    expiresAt: null,
    base: data,
    draft: structuredClone(data),
    evidence: {},
    notes: {},
    session: emptySession(),
    log: [],
    summary: "",
    unresolved: [],
    revision: 0,
    validatedRevision: -1,
    turns: 0,
    model: "",
    excluded: [],
  };
  await addFiles(job, files);
  return job;
}
export async function alreadyApplied(job: Job) {
  const remote = await api.get<{ status: string; applied_at?: string }>(
    `/agent-imports/${job.id}`,
  );
  if (remote.status === "applied") {
    job.status = "applied";
    job.expiresAt =
      Date.parse(remote.applied_at ?? new Date().toISOString()) + RETENTION;
    await saveJob(job);
    return true;
  }
  if (remote.status === "cancelled") throw Error("此批次已取消");
  return false;
}
export async function rebase(job: Job) {
  const { data } = await api.get<{ data: Snapshot }>("/agent-imports/snapshot");
  const oldChanges = diff(job.base, job.draft, job.evidence);
  const next = structuredClone(data);
  const conflicts: string[] = [];
  for (const c of oldChanges) {
    const current = data[c.entity].find((r) => r.id === c.id) ?? null;
    if (canonical(current) !== canonical(c.before)) {
      conflicts.push(
        JSON.stringify({
          entity: c.entity,
          id: c.id,
          previous: c.before,
          intended: c.after,
          current,
          evidence: c.evidence,
        }),
      );
      continue;
    }
    next[c.entity] = next[c.entity].filter((r) => r.id !== c.id);
    if (c.after) next[c.entity].push(c.after);
  }
  if (conflicts.length)
    throw Error(
      "正式数据已发生变化，草稿保持不变；请核对后重新导入。冲突记录数：" +
        conflicts.length,
    );
  job.base = data;
  job.draft = next;
  await saveJob(job);
}
export async function renewLease(job: Job) {
  return api.post(`/agent-imports/${job.id}/lease`, {
    changes: changesFor(job),
  });
}
export async function checkJob(job: Job) {
  const changes = changesFor(job);
  let issues;
  try {
    issues = validateTransition(
      job.base,
      materialize(applyChanges(job.base, changes), job.base),
    );
  } catch (e) {
    issues = [{ message: (e as Error).message }];
  }
  const files = await materials(job.id);
  const unread = files.filter((f) => !f.status);
  const blocked = files.filter((f) => f.status === "blocked");
  issues.push(...(job.session?.issues ?? []).map((message) => ({ message })));
  if (unread.length) issues.push({ message: "仍有未交代材料" });
  if (
    job.session &&
    Object.values(job.session.people).some((p) => p.status !== "done")
  )
    issues.push({ message: "仍有未完成人员对象" });
  for (const t of Object.values(job.timetables ?? {}))
    if (!job.excluded.includes(t.person.id)) {
      if (needsVerification(job, t))
        issues.push({
          message: `${t.person.full_name}：等待 Agent 回看原件逐项核对`,
        });
      const missingOnly = !t.entries.length &&
        job.timetableChecks?.[t.id]?.checks?.coverage === "missing" &&
        !needsVerification(job, t);
      if (!t.bound && !missingOnly)
        issues.push({
          message: `${t.person.full_name}：已保存 ${t.entries.length} 项课程，待绑定学期/作息后才能正式导入`,
        });
      else if (
        t.entries.length !==
        t.entryIds.length + (t.unscheduledIds?.length ?? 0) &&
        !(job.timetableChecks?.[t.id]?.checks?.coverage === "partial" &&
          !needsVerification(job, t) && t.unresolved.length &&
          t.entries.length === t.entryIds.length + (t.unscheduledIds?.length ?? 0) + pendingTimedEntries(t.entries).length)
      )
        issues.push({
          message: `${t.person.full_name}：部分课程缺少星期、节次或周次，尚未形成完整占用`,
        });
    }
  issues.push(...calendarBindingIssues(job).map((message) => ({ message })));
  if (needsImportCheck(job))
    issues.push({
      message: "等待 Agent 全批核对日期、作息、人员关系与材料缺项",
    });
  job.checkedRevision = job.revision;
  job.validatedRevision = issues.length ? -1 : job.revision;
  return {
    issues,
    warnings: Object.values(job.timetables ?? {})
      .filter((t) => !job.excluded.includes(t.person.id))
      .flatMap((t) =>
        [...timetableWarnings(t.entries), ...pendingTimedEntries(t.entries).map((e) =>
          `「${e.name}」时段不完整，仅保存在待补清单，尚未计入课程占用；不能据此判定有空。`)]
          .map((w) => t.person.full_name + "：" + w),
      ),
    unread: unread.map((f) => f.path),
    blocked: blocked.map((f) => ({ path: f.path, reason: f.reason })),
    changes: changes.length,
    files: files.length,
  };
}
async function editProposalEntryUnlocked(
  job: Job,
  id: string,
  index: number,
  value: unknown,
) {
  if (["running", "applied", "cancelled"].includes(job.status))
    throw Error("当前状态不能编辑课表");
  const previous = job.timetables?.[id];
  if (!previous || !previous.entries[index]) throw Error("课表条目不存在");
  const person = job.draft.person.find((p) => p.id === previous.person.id);
  if (!person) throw Error("人员已删除");
  const input = timetableProposalSchema.parse({
    ...previous,
    person,
    organization_ids: [],
    entries: previous.entries.map((e, i) => (i === index ? value : e)),
    sources: [
      ...previous.sources.filter((s) => s.source !== "操作员意见").slice(0, 29),
      {
        source: "操作员意见",
        locator: `课表 ${id} 第 ${index + 1} 项`,
        explanation: "操作员直接修改课程字段",
        inferred: false,
      },
    ],
  });
  const checked =
    job.timetableChecks?.[id]?.signature === proposalSignature(previous);
  const staged = stageTimetable(job.draft, job.evidence, input, previous);
  job.draft = staged.draft;
  job.evidence = staged.evidence;
  job.timetables![id] = staged.proposal;
  if (checked)
    job.timetableChecks![id] = {
      ...job.timetableChecks![id],
      signature: proposalSignature(staged.proposal),
      summary: "操作员在已核对方案中直接修订课程",
      at: Date.now(),
    };
  job.revision++;
  job.validatedRevision = -1;
  syncPersonObjects(job);
  job.importCheck = undefined;
  await saveJob(job);
}
async function editRecordUnlocked(
  job: Job,
  entity: Entity,
  id: string,
  data: Record<string, unknown>,
) {
  if (["running", "applied", "cancelled"].includes(job.status))
    throw Error("当前状态不能编辑记录");
  if (
    !["person", "organization"].includes(entity) ||
    job.base[entity].some((row) => row.id === id)
  )
    throw Error("这里只能修订本批新增人员或部门；课表与日历请使用对应编辑器");
  const draft = structuredClone(job.draft);
  mutate(draft, entity, "update", data, id);
  if (entity === "person") {
    const person = draft.person.find((p) => p.id === id)!;
    for (const proposal of Object.values(job.timetables ?? {})) {
      if (proposal.person.id !== id) continue;
      const checked =
        job.timetableChecks?.[proposal.id]?.signature ===
        proposalSignature(proposal);
      proposal.person = timetableProposalSchema.shape.person.parse(person);
      if (checked)
        job.timetableChecks![proposal.id] = {
          ...job.timetableChecks![proposal.id],
          signature: proposalSignature(proposal),
          summary: "操作员在已核对方案中直接修订新增人员身份",
          at: Date.now(),
        };
    }
  } else {
    const org = job.session!.organizations.find((o) => o.id === id);
    if (!org) throw Error("部门对象不存在");
    const row = draft.organization.find((o) => o.id === id)!;
    org.name = String(row.name);
    org.parent_id = row.parent_id ? String(row.parent_id) : null;
    org.sources = [
      {
        source: "操作员意见",
        locator: "部门编辑",
        explanation: "操作员直接修订新增部门",
        inferred: false,
      },
    ];
  }
  job.draft = draft;
  job.evidence[entity + ":" + id] = [
    {
      source: "操作员意见",
      locator: "审核界面编辑",
      explanation: "操作员直接修改字段",
      inferred: false,
    },
  ];
  job.revision++;
  job.validatedRevision = -1;
  syncPersonObjects(job);
  job.importCheck = undefined;
  await saveJob(job);
}
async function applyJobUnlocked(job: Job) {
  if (!job.session) throw Error("旧版批次保留只读，请用原材料创建新版批次");
  if (await alreadyApplied(job)) return;
  await rebase(job);
  if (job.status !== "review") throw Error("数据已变化，请继续处理后重新审核");
  const result = await checkJob(job);
  if (result.issues.length)
    throw Error(result.issues.map((x) => x.message).join("；"));
  await renewLease(job);
  const committedSummary = reviewSummary(job, true);
  await api.post(`/agent-imports/${job.id}/apply`, {
    changes: changesFor(job),
    summary: committedSummary,
    review: reviewArtifactSchema.parse({
      version: 1,
      timetables: Object.values(job.timetables ?? {}).filter(
        (t) => !job.excluded.includes(t.person.id),
      ),
      calendars: Object.values(job.calendars ?? {}),
      checks: Object.fromEntries(
        Object.entries(job.timetableChecks ?? {})
          .filter(
            ([id, c]) =>
              c.checks &&
              !job.excluded.includes(job.timetables?.[id]?.person.id ?? ""),
          )
          .map(([id, c]) => [id, c.checks]),
      ),
      consistency_review: job.importCheck?.consistency_review ?? [],
      unresolved: job.unresolved,
    }),
  });
  job.status = "applied";
  job.summary = committedSummary;
  job.expiresAt = Date.now() + RETENTION;
  await saveJob(job);
}

function syncPersonObjects(job: Job) {
  for (const p of Object.values(job.session?.people ?? {})) {
    for (const [key, table] of Object.entries(p.timetables)) {
      const plan = job.timetables?.[p.id + ":" + key];
      if (!plan) continue;
      p.information = timetableProposalSchema.shape.person
        .omit({ id: true })
        .parse(plan.person);
      p.timetables[key] = {
        ...table,
        entries: plan.entries,
        sources: plan.sources,
        unresolved: plan.unresolved,
        term_name: plan.term_name,
      };
      if (job.timetableChecks?.[plan.id]?.checks)
        p.checks[key] = job.timetableChecks[plan.id].checks!;
    }
  }
}
async function feedbackUnlocked(job: Job, text: string) {
  if (!text.trim()) return;
  if (!job.session) throw Error("旧版批次保留只读，请重新导入材料");
  if (["running", "applied", "cancelled"].includes(job.status))
    throw Error("请先暂停处理");
  job.notes["最近操作员意见"] = text.trim();
  job.session.phase = "reconcile";
  // Cancel unexecuted instructions; completed source evidence remains valid.
  if (job.session.coordinator.pending.length)
    job.session.coordinator = emptyAgent();
  job.importCheck = undefined;
  job.revision++;
  job.validatedRevision = -1;
  job.status = "paused";
  await saveJob(job);
}
async function editCalendarUnlocked(job: Job, value: unknown) {
  if (["running", "applied", "cancelled"].includes(job.status))
    throw Error("当前状态不能编辑日历");
  const calendar = calendarSchema.parse(value);
  calendar.sources = [
    ...calendar.sources.filter((s) => s.source !== "操作员意见").slice(0, 29),
    {
      source: "操作员意见",
      locator: "日历复核",
      explanation: "操作员直接修订日历字段",
      inferred: false,
    },
  ];
  const before = structuredClone(job);
  try {
    (job.calendars ??= {})[calendar.id] = calendar;
    if (job.session && Object.keys(job.session.people).length) {
      for (const p of Object.values(job.session.people))
        for (const t of Object.values(p.timetables))
          if (calendar.timetable_ids.includes(p.id + ":" + t.key))
            t.calendar_id = calendar.id;
      projectPeople(job);
    } else if (!calendarMissing(calendar).length) {
      const staged = stageCalendar(job.draft, job.evidence, calendar);
      job.draft = staged.draft;
      job.evidence = staged.evidence;
      for (const id of calendar.timetable_ids) {
        const previous = job.timetables?.[id];
        if (!previous) throw Error("适用课表不存在");
        const result = stageTimetable(
          job.draft,
          job.evidence,
          { ...previous, term_id: staged.termId, profile_id: staged.profileId },
          previous,
        );
        job.draft = result.draft;
        job.evidence = result.evidence;
        job.timetables![id] = result.proposal;
      }
    }
    job.importCheck = undefined;
    job.revision++;
    job.validatedRevision = -1;
    job.summary = reviewSummary(job);
    await saveJob(job);
  } catch (e) {
    Object.assign(job, before);
    throw e;
  }
}
async function setPersonIncludedUnlocked(
  job: Job,
  id: string,
  included: boolean,
) {
  if (["running", "applied", "cancelled"].includes(job.status))
    throw Error("当前状态不能修改导入范围");
  job.excluded = included
    ? job.excluded.filter((x) => x !== id)
    : [...new Set([...job.excluded, id])];
  job.revision++;
  job.validatedRevision = -1;
  job.importCheck = undefined;
  job.summary = reviewSummary(job);
  await saveJob(job);
}

async function chooseIdentityUnlocked(
  job: Job,
  key: string,
  id: string | null,
) {
  if (!job.session || ["running", "applied", "cancelled"].includes(job.status))
    throw Error("请先暂停处理");
  const p = job.session.people[key];
  if (!p?.information) throw Error("人员信息尚未识别");
  if (id && !job.base.person.some((row) => row.id === id))
    throw Error("人员不存在");
  p.identityChoice = { id, information: canonical(p.information) };
  projectPeople(job);
  await saveJob(job);
}

export const editProposalEntry = (
  ...args: Parameters<typeof editProposalEntryUnlocked>
) => withJobLock(args[0], () => editProposalEntryUnlocked(...args));

export const editRecord = (...args: Parameters<typeof editRecordUnlocked>) =>
  withJobLock(args[0], () => editRecordUnlocked(...args));

export const applyJob = (...args: Parameters<typeof applyJobUnlocked>) =>
  withJobLock(args[0], () => applyJobUnlocked(...args));

export const feedback = (...args: Parameters<typeof feedbackUnlocked>) =>
  withJobLock(args[0], () => feedbackUnlocked(...args));

export const editCalendar = (
  ...args: Parameters<typeof editCalendarUnlocked>
) => withJobLock(args[0], () => editCalendarUnlocked(...args));

export const setPersonIncluded = (
  ...args: Parameters<typeof setPersonIncludedUnlocked>
) => withJobLock(args[0], () => setPersonIncludedUnlocked(...args));

export const chooseIdentity = (
  ...args: Parameters<typeof chooseIdentityUnlocked>
) => withJobLock(args[0], () => chooseIdentityUnlocked(...args));
