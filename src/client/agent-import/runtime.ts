import {
  recordCoverage,
  completePages,
} from "../../shared/agent-import/coverage";
import {
  courseConflicts,
  consistencySignature,
  validateCheckedVariants,
  validateConsistencyReview,
} from "../../shared/agent-import/consistency";
import { reviewArtifactSchema } from "../../shared/agent-import/review-artifact";
import {
  calendarSchema,
  calendarMissing,
  stageCalendar,
} from "../../shared/agent-import/calendar";
import {
  calendarBindingIssues,
  importSignature,
  needsImportCheck,
  reviewSummary,
} from "./readiness";
import { fitImagePayload } from "./image-payload";
import {
  startVerification,
  sourceFiles,
  confirmVerification,
  recordVerificationRead,
  needsVerification,
  proposalSignature,
  verificationCandidate,
} from "./verification";
import {
  stageTimetable,
  proposalForModel,
  timetableWarnings,
} from "../../shared/agent-import/timetable";
import {
  needsHandoff,
  withoutImages,
  retainUnrecordedImages,
  resumeMessages,
  advanceProgress,
  type TurnMetrics,
} from "../../shared/agent-import/context";
import { z } from "zod";
import type { ModelMessage } from "ai";
import { api, ApiError } from "../lib/api";
import {
  applyChanges,
  canonical,
  diff,
  materialize,
  mutate,
  schemas,
  validateTransition,
  type Change,
  type Snapshot,
  type Entity,
  type Row,
} from "../../shared/agent-import/model";
import { toolSpecs, type ToolName } from "../../shared/agent-import/tools";
import { documentTool } from "./documents";
import {
  archive,
  readHistory,
  materials,
  putMaterial,
  saveJob,
  addFiles,
  RETENTION,
  type Job,
  type PendingCall,
} from "./store";
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
    harnessVersion: 3,
    createdAt: Date.now(),
    expiresAt: null,
    base: data,
    draft: structuredClone(data),
    evidence: {},
    notes: {},
    messages: [{ role: "user", content: "请整理本批上传材料并完成复核预览。" }],
    pending: [],
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
function archiveMessages(messages: ModelMessage[]) {
  return withoutImages(messages).map((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? { ...m, content: m.content.filter((p) => p.type !== "reasoning") }
      : m,
  );
}
function recordMetrics(job: Job, metrics: TurnMetrics) {
  (job.metrics ??= []).push(metrics);
  if (job.metrics.length > 200) job.metrics.splice(0, job.metrics.length - 200);
  for (const a of metrics.attempts) {
    if (a.status === "error")
      (job.cooldowns ??= {})[a.providerId] = Date.now() + 120000;
    else if (job.cooldowns) delete job.cooldowns[a.providerId];
  }
}
function log(job: Job, text: string) {
  job.log.push({ at: Date.now(), text });
  if (job.log.length > 1000) job.log.splice(0, job.log.length - 1000);
}
async function requestTurn<T>(
  job: Job,
  body: unknown,
  update: () => void,
): Promise<T> {
  const reduceTimedOutResponse = () => {
    if (
      !job.metrics
        ?.at(-1)
        ?.attempts.some((a) =>
          [
            "timeout",
            "output_truncated",
            "invalid_tool_call",
            "network_error",
          ].includes(a.code ?? ""),
        )
    )
      return;
    const networkFailure = job.metrics
      ?.at(-1)
      ?.attempts.some((a) => a.code === "network_error");
    const guidance = networkFailure
      ? "上次网络连接中断，未返回的工具调用没有执行。继续当前步骤，已保存成果无需重复创建。"
      : (body as { mode?: string }).mode === "compact"
        ? "上一响应未成功返回有效工具；没有执行任何业务动作。请仅调用 save_handoff 一次，简短填写下一步和待定事项，参数必须符合工具契约。"
        : "上一响应超时、截断或未返回有效工具，未返回的工具调用没有执行。请缩小本次响应：只处理一个人的一小部分，每次 save_timetable 最多保存 8 条 entries，后续用 mode=append 继续；不要丢弃其余课程或提前标记材料完成。note 仅保留必要原文周次、定位和疑点，不重复已有字段。复核每次只修正少量差异；交接摘要只写下一步和未决事项，不复述已保存的全部课表。";
    if (job.messages.at(-1)?.content !== guidance)
      job.messages.push({ role: "user", content: guidance });
    body = { ...(body as object), messages: job.messages };
  };
  reduceTimedOutResponse();
  for (let retry = 0; ; retry++) {
    const start = Date.now();
    try {
      const transport = {
        ...(body as object),
        messages: await fitImagePayload(job.messages),
      };
      return await api.post<T>(`/agent-imports/${job.id}/turn`, transport, {
        timeoutMs: 130000,
      });
    } catch (e) {
      const supplied =
        e instanceof ApiError
          ? (e.details as { metrics?: TurnMetrics } | undefined)?.metrics
          : undefined;
      const metrics: TurnMetrics = supplied ?? {
        requestId: "client-" + crypto.randomUUID(),
        durationMs: Date.now() - start,
        purpose: (
          body as {
            mode: "work" | "compact" | "checkpoint" | "verify" | "reconcile";
          }
        ).mode,
        attempts: [
          {
            providerId: "gateway",
            model: "未知（请求未返回模型信息）",
            durationMs: Date.now() - start,
            status: "error",
            code: e instanceof ApiError ? e.code : "network",
            httpStatus: e instanceof ApiError ? e.status : undefined,
          },
        ],
      };
      recordMetrics(job, metrics);
      reduceTimedOutResponse();
      job.checkpoint = {
        key: "request:" + metrics.requestId,
        kind: "request",
        data: metrics,
      };
      await saveJob(job);
      const transient =
        e instanceof ApiError &&
        [0, 429, 502, 503, 504].includes(e.status) &&
        (!supplied ||
          supplied.attempts.some(
            (a) =>
              [
                "timeout",
                "output_truncated",
                "invalid_tool_call",
                "network_error",
              ].includes(a.code ?? "") ||
              (a.httpStatus === 429 &&
                a.code !== "quota_exhausted" &&
                (a.retryAfterMs ?? 0) <= 30000) ||
              (a.httpStatus ?? 0) >= 500,
          ));
      if (!transient || retry >= 1) throw e;
      const retryDelay = Math.max(
        2000,
        ...metrics.attempts.map((a) => Math.min(a.retryAfterMs ?? 0, 30000)),
      );
      log(
        job,
        `模型请求暂时失败，进度已保存；${Math.ceil(retryDelay / 1000)} 秒后重试一次。请求编号：` +
          metrics.requestId,
      );
      job.phase = "模型请求暂时失败，正在重试";
      await saveJob(job);
      update();
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      body = { ...(body as object), cooldowns: job.cooldowns };
    }
  }
}
async function alreadyApplied(job: Job) {
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
  job.base = data;
  job.draft = next;
  if (conflicts.length) {
    job.notes["并发变化"] =
      "以下记录正式数据已变化，本次草稿改动未继续套用，请根据现有值与来源重新判断：" +
      conflicts.join("，");
    job.messages.push({ role: "user", content: job.notes["并发变化"] });
    job.revision++;
    job.validatedRevision = -1;
    job.status = "paused";
    log(job, "正式数据发生变化，已保留最新记录并标记需要重新协调的内容。");
  }
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
  for (const t of Object.values(job.timetables ?? {}))
    if (!job.excluded.includes(t.person.id)) {
      if (needsVerification(job, t))
        issues.push({
          message: `${t.person.full_name}：等待 Agent 回看原件逐项核对`,
        });
      if (!t.bound)
        issues.push({
          message: `${t.person.full_name}：已保存 ${t.entries.length} 项课程，待绑定学期/作息后才能正式导入`,
        });
      else if (
        t.entries.length !==
        t.entryIds.length + (t.unscheduledIds?.length ?? 0)
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
        timetableWarnings(t.entries).map((w) => t.person.full_name + "：" + w),
      ),
    unread: unread.map((f) => f.path),
    blocked: blocked.map((f) => ({ path: f.path, reason: f.reason })),
    changes: changes.length,
    files: files.length,
  };
}
function canReconcile(job: Job, files: Awaited<ReturnType<typeof materials>>) {
  const plans = Object.values(job.timetables ?? {});
  return (
    !job.verification &&
    plans.length > 0 &&
    plans.every((p) => !needsVerification(job, p)) &&
    files.every((f) => Boolean(f.status))
  );
}
function missingConsistencySources(
  job: Job,
  group: ReturnType<typeof courseConflicts>[number],
  files: Awaited<ReturnType<typeof materials>>,
) {
  const required = new Map<string, number>();
  for (const variant of group.variants)
    for (const file of sourceFiles(
      job.timetables![variant.timetable_id],
      files,
    ))
      required.set(file.path, file.totalPages ?? 1);
  return [...required]
    .filter(([path, pages]) =>
      Array.from({ length: pages }, (_, i) => i + 1).some(
        (page) =>
          !completePages(job.consistencyCoverage?.[path] ?? {}).includes(page),
      ),
    )
    .map(([path]) => path);
}
function recordConsistencyRead(job: Job, path: string, result: any) {
  const info = result?.content ?? result;
  const coverage = ((job.consistencyCoverage ??= {})[path] ??= {});
  recordCoverage(coverage, info?.coverage ?? []);
}
async function execute(
  job: Job,
  call: PendingCall,
  explicitRemoval = false,
): Promise<{ result: unknown; image?: string }> {
  if (call.validationError)
    throw Error("工具未执行，请修正参数：" + call.validationError);
  const name = call.name as ToolName;
  if (!(name in toolSpecs)) throw Error("未知工具");
  const args = toolSpecs[name].schema.parse(call.args) as Record<string, any>;
  if (
    job.verification &&
    [
      "change_record",
      "bind_timetables",
      "materialize_calendar",
      "confirm_import_check",
    ].includes(name)
  )
    throw Error(
      "逐人复核期间只用 revise_timetable 修正当前方案；其他业务变化留到回到主任务后处理",
    );
  switch (name) {
    case "read_course_consistency": {
      const groups = courseConflicts(
        Object.values(job.timetables ?? {}).filter(
          (p) => !job.excluded.includes(p.person.id),
        ),
      );
      const offset = args.offset;
      if (args.key) {
        const group = groups.find((g) => g.key === args.key);
        if (!group) return { result: { resolved: true } };
        (job.consistencyReads ??= {})[`${group.key}:${offset}`] = canonical(
          group.variants.slice(offset, offset + 5),
        );
        return {
          result: {
            key: group.key,
            course: group.course,
            missing_sources: missingConsistencySources(
              job,
              group,
              await materials(job.id),
            ),
            total: group.variants.length,
            items: group.variants.slice(offset, offset + 5).map((v) => ({
              ...v,
              sources: [...new Set(v.sources.map((s) => s.source))],
            })),
            nextOffset: offset + 5 < group.variants.length ? offset + 5 : null,
          },
        };
      }
      const pending = groups.filter(
        (g) =>
          job.consistencyChecks?.[g.key]?.signature !== consistencySignature(g),
      );
      return {
        result: {
          total: pending.length,
          items: pending.slice(offset, offset + 10).map((g) => ({
            key: g.key,
            teachers: [...new Set(g.variants.map((v) => v.teacher))],
            people: g.variants.length,
          })),
          nextOffset: offset + 10 < pending.length ? offset + 10 : null,
          instruction:
            "逐项指定 key 读取详情；核对后 record_consistency_check 保存结论。处理后从 offset=0 获取剩余项目。",
        },
      };
    }
    case "record_consistency_check": {
      const group = courseConflicts(
        Object.values(job.timetables ?? {}).filter(
          (p) => !job.excluded.includes(p.person.id),
        ),
      ).find((g) => g.key === args.key);
      if (!group) throw Error("该差异已不存在，请重新读取待核对索引");
      validateCheckedVariants(group, args as any);
      const missing = missingConsistencySources(
        job,
        group,
        await materials(job.id),
      );
      if (args.resolution === "different_context" && missing.length)
        throw Error(
          "断言任课差异成立前须在本轮全批复核回看来源，尚缺：" +
            missing.join("、"),
        );
      (job.consistencyChecks ??= {})[group.key] = {
        signature: consistencySignature(group),
        review: {
          key: args.key,
          resolution: args.resolution,
          explanation: args.explanation,
          checked_variants: args.checked_variants,
        },
      };
      job.importCheck = undefined;
      return { result: { saved: true } };
    }
    case "read_calendars": {
      if (args.id) {
        const calendar = job.calendars?.[args.id];
        return {
          result: calendar
            ? { ...calendar, missing: calendarMissing(calendar) }
            : { error: "日历方案不存在" },
        };
      }
      const rows = Object.values(job.calendars ?? {});
      return {
        result: {
          total: rows.length,
          items: rows.slice(args.offset, args.offset + 20).map((c) => ({
            id: c.id,
            name: c.name,
            start_date: c.start_date,
            week_count: c.week_count,
            minimum_weeks: c.minimum_weeks,
            periods: c.periods.length,
            applicable: c.timetable_ids.length,
            missing: calendarMissing(c),
          })),
          nextOffset: args.offset + 20 < rows.length ? args.offset + 20 : null,
        },
      };
    }
    case "save_calendar": {
      const calendar = calendarSchema.parse(args);
      const files = await materials(job.id);
      for (const e of calendar.sources)
        if (
          !["现有数据", "操作员意见"].includes(e.source) &&
          !files.some((f) => f.path === e.source && f.inspected)
        )
          throw Error("日历来源未读取：" + e.source);
      for (const id of calendar.timetable_ids)
        if (!job.timetables?.[id]) throw Error("适用课表不存在：" + id);
      if (canonical(job.calendars?.[calendar.id]) !== canonical(calendar)) {
        (job.calendars ??= {})[calendar.id] = calendar;
        job.revision++;
        job.validatedRevision = -1;
      }
      return {
        result: {
          saved: true,
          id: calendar.id,
          missing: calendarMissing(calendar),
        },
      };
    }
    case "materialize_calendar": {
      const calendar = job.calendars?.[args.id];
      if (!calendar) throw Error("日历方案不存在");
      const staged = stageCalendar(job.draft, job.evidence, calendar);
      if (diff(job.draft, staged.draft, staged.evidence).length) {
        job.revision++;
        job.validatedRevision = -1;
      }
      job.draft = staged.draft;
      job.evidence = staged.evidence;
      return {
        result: {
          term_id: staged.termId,
          profile_id: staged.profileId,
          timetable_ids: calendar.timetable_ids,
        },
      };
    }
    case "confirm_import_check": {
      if (
        job.verification ||
        Object.values(job.timetables ?? {}).some((t) =>
          needsVerification(job, t),
        )
      )
        throw Error("请先完成逐人原件核对");
      if ((await materials(job.id)).some((f) => !f.status))
        throw Error("仍有未处理材料");
      const plans = Object.values(job.timetables ?? {}).filter(
        (t) => !job.excluded.includes(t.person.id),
      );
      const calendars = Object.values(job.calendars ?? {});
      const missing = plans.filter(
        (t) =>
          !t.bound && !calendars.some((c) => c.timetable_ids.includes(t.id)),
      );
      if (missing.length)
        throw Error(
          "这些未绑定课表尚未保存日历证据方案（未知字段可 null，但须逐项汇总线索）：" +
            missing.map((p) => p.id).join("、"),
        );
      const bindable = calendars.filter(
        (c) =>
          !calendarMissing(c).length &&
          c.timetable_ids.some(
            (id) => job.timetables?.[id] && !job.timetables[id].bound,
          ),
      );
      if (bindable.length)
        throw Error(
          "已有完整日历，请先生成并绑定适用课表：" +
            bindable.map((c) => c.id).join("、"),
        );
      const conflicts = courseConflicts(plans);
      const reviews = conflicts
        .map(
          (g) =>
            args.consistency_review.find(
              (r: { key: string }) => r.key === g.key,
            ) ??
            (job.consistencyChecks?.[g.key]?.signature ===
            consistencySignature(g)
              ? job.consistencyChecks[g.key].review
              : undefined),
        )
        .filter(Boolean);
      validateConsistencyReview(conflicts, reviews);
      for (const group of conflicts) {
        const review = reviews.find(
          (r: { key: string }) => r.key === group.key,
        )!;
        validateCheckedVariants(group, review);
        if (
          review.resolution === "different_context" &&
          missingConsistencySources(job, group, await materials(job.id)).length
        )
          throw Error("跨课表结论缺少本轮原件回看：" + group.key);
      }
      const pendingConsistency = reviews
        .filter((r: { resolution: string }) => r.resolution === "unresolved")
        .map(
          (r: { key: string; explanation: string }) =>
            `${r.key}：${r.explanation}`,
        );
      job.importCheck = {
        consistency_review: reviews,
        signature: importSignature(job),
        calendar_review: args.calendar_review,
        identity_review: args.identity_review,
        unresolved: [...args.unresolved, ...pendingConsistency],
      };
      return { result: { checked: true, summary: reviewSummary(job) } };
    }
    case "confirm_timetable_check":
      confirmVerification(
        job,
        args.id,
        args.summary,
        await materials(job.id),
        args.checks,
      );
      return { result: { checked: true, id: args.id } };
    case "revise_timetable": {
      const previous = job.timetables?.[args.id];
      if (!previous) throw Error("课表方案不存在");
      if (job.verification && job.verification.id !== args.id)
        throw Error("只能修正当前复核方案");
      const indexes = [
        ...args.remove,
        ...args.updates.map((u: any) => u.index),
      ];
      const conflicts = args.updates
        .map((u: any) => u.index)
        .filter((i: number) => args.remove.includes(i));
      if (conflicts.length)
        throw Error(
          "同一条目不能同时更新和删除。索引 " +
            conflicts.join("、") +
            " 同时出现在 updates 和 remove；若要删除，只保留 remove，移除对应 updates。当前草稿未变更。",
        );
      if (new Set(indexes).size !== indexes.length)
        throw Error(
          "updates 或 remove 内有重复索引，每个原条目只能指定一次；当前草稿未变更",
        );
      if (indexes.some((i) => i >= previous.entries.length))
        throw Error(
          `索引越界：当前 entries 共 ${previous.entries.length} 条，使用 read_timetables 返回的 index；当前草稿未变更`,
        );
      const entries = previous.entries
        .map((e, i) => ({
          ...e,
          ...args.updates.find((u: any) => u.index === i)?.patch,
        }))
        .filter((_, i) => !args.remove.includes(i))
        .concat(args.append);
      const person = job.draft.person.find((p) => p.id === previous.person.id);
      if (!person) throw Error("人员已删除");
      const sources = [
        ...new Map(
          [...previous.sources, ...args.sources].map((e) => [canonical(e), e]),
        ).values(),
      ];
      return execute(
        job,
        {
          id: call.id,
          name: "save_timetable",
          args: {
            ...previous,
            person: { ...person, ...args.person },
            term_name: args.term_name ?? previous.term_name,
            entries,
            sources,
            unresolved: args.unresolved ?? previous.unresolved,
            mode: "replace",
          },
        },
        true,
      );
    }
    case "save_timetable": {
      const { mode, ...fields } = toolSpecs.save_timetable.schema.parse(
        call.args,
      );
      if (job.verification && job.verification.id !== fields.id)
        throw Error("只能修正当前复核方案");
      const previous = job.timetables?.[fields.id];
      if (
        !explicitRemoval &&
        mode === "replace" &&
        previous?.entries.length &&
        !fields.entries.length
      )
        throw Error(
          `已有 ${previous.entries.length} 条课程，不能用空 entries 覆盖。只改身份或标题请用 revise_timetable；确需删除课程须在 remove 中明确列出索引。当前草稿未变更。`,
        );
      const input =
        mode === "append" && previous
          ? toolSpecs.save_timetable.schema.parse({
              ...previous,
              ...fields,
              person: { ...previous.person, ...fields.person },
              entries: [...previous.entries, ...fields.entries],
              organization_ids: [
                ...new Set([
                  ...previous.organization_ids,
                  ...fields.organization_ids,
                ]),
              ],
              sources: [
                ...new Map(
                  [...previous.sources, ...fields.sources].map((e) => [
                    canonical(e),
                    e,
                  ]),
                ).values(),
              ],
              completed_sources: [
                ...new Set([
                  ...previous.completed_sources,
                  ...fields.completed_sources,
                ]),
              ],
              unresolved: fields.unresolved,
            })
          : fields;
      const files = await materials(job.id);
      for (const e of input.sources)
        if (
          !["操作员意见", "现有数据"].includes(e.source) &&
          !files.some(
            (f) =>
              (f.path === e.source && f.inspected) ||
              f.path.startsWith(e.source.replace(/\/$/, "") + "/"),
          )
        )
          throw Error("课表来源未读取：" + e.source);
      for (const path of input.completed_sources) {
        const f = files.find((f) => f.path === path);
        if (!f?.inspected || (f.totalPages ?? 1) > (f.pagesRead?.length ?? 0))
          throw Error("材料未完整读取：" + path);
        if (!input.sources.some((e) => e.source === path))
          throw Error("完成材料必须包含在 sources 中");
      }
      const staged = stageTimetable(
        job.draft,
        job.evidence,
        input,
        job.timetables?.[input.id],
      );
      job.draft = staged.draft;
      job.evidence = staged.evidence;
      if (
        staged.changed ||
        canonical(job.timetables?.[input.id]) !== canonical(staged.proposal)
      ) {
        job.revision++;
        job.validatedRevision = -1;
      }
      (job.timetables ??= {})[input.id] = staged.proposal;
      const sourcePaths = new Set(fields.sources.map((e) => e.source));
      for (const path of sourcePaths)
        if (job.unrecordedImageViews) delete job.unrecordedImageViews[path];
      job.unrecordedReads = job.unrecordedReads?.filter(
        (p) => !sourcePaths.has(p),
      );
      for (const path of input.completed_sources) {
        const f = files.find((f) => f.path === path)!;
        await putMaterial(job.id, {
          ...f,
          status: "done",
          reason: "Agent 已保存结构化课表草稿，待逐人回看核对：" + input.id,
        });
      }
      return {
        result: {
          id: input.id,
          person_id: input.person.id,
          courses: input.entries.length,
          bound: staged.proposal.bound,
          entryIds: staged.proposal.entryIds,
          unresolved: input.unresolved,
          warnings: timetableWarnings(input.entries),
        },
      };
    }
    case "bind_timetables": {
      let draft = job.draft,
        evidence = job.evidence;
      const plans = { ...job.timetables };
      for (const id of new Set<string>(args.ids)) {
        const previous = plans[id];
        if (!previous) throw Error("课表方案不存在：" + id);
        const person = draft.person.find((p) => p.id === previous.person.id);
        if (!person) throw Error("人员已删除，不能绑定已失效的方案：" + id);
        const input = toolSpecs.save_timetable.schema.parse({
          ...previous,
          person,
          organization_ids: draft.membership
            .filter((m) => m.person_id === person.id && m.status === "active")
            .map((m) => m.org_id),
          term_id: args.term_id,
          profile_id: args.profile_id,
        });
        const staged = stageTimetable(draft, evidence, input, previous);
        draft = staged.draft;
        evidence = staged.evidence;
        plans[id] = staged.proposal;
      }
      if (
        canonical(plans) !== canonical(job.timetables) ||
        diff(job.draft, draft, evidence).length
      ) {
        job.revision++;
        job.validatedRevision = -1;
      }
      job.draft = draft;
      job.evidence = evidence;
      job.timetables = plans;
      return {
        result: {
          bound: args.ids,
          term_id: args.term_id,
          profile_id: args.profile_id,
        },
      };
    }
    case "read_timetables": {
      if (args.id) {
        const plan = job.timetables?.[args.id];
        return {
          result: plan
            ? {
                ...proposalForModel(plan),
                fieldCheck: job.timetableChecks?.[plan.id]?.checks,
              }
            : {
                error: "方案不存在",
                availableIds: Object.keys(job.timetables ?? {}),
              },
        };
      }
      const rows = Object.values(job.timetables ?? {}).filter(
        (t) => !args.person_id || t.person.id === args.person_id,
      );
      return {
        result: {
          total: rows.length,
          items: rows.slice(args.offset, args.offset + 20).map((t) => ({
            id: t.id,
            person: t.person,
            term_name: t.term_name,
            courses: t.entries.length,
            bound: t.bound,
            unresolved: t.unresolved,
          })),
          nextOffset: args.offset + 20 < rows.length ? args.offset + 20 : null,
        },
      };
    }
    case "tree": {
      const list = (await materials(job.id)).filter((f) =>
        f.path.startsWith(args.prefix),
      );
      return {
        result: {
          total: list.length,
          items: list
            .slice(args.offset, args.offset + 100)
            .map(({ blob, ...f }) => ({ ...f, size: blob.size })),
          nextOffset:
            args.offset + 100 < list.length ? args.offset + 100 : null,
        },
      };
    }
    case "unpack":
      return documentTool(job, name, args as { path: string });
    case "read_document":
    case "view_image":
    case "ocr_image":
    case "render_sheet": {
      if (canReconcile(job, await materials(job.id))) {
        const response = await documentTool(
          job,
          name,
          args as { path: string },
        );
        recordConsistencyRead(job, args.path, response.result);
        return response;
      }
      const unread = (job.unrecordedReads ??= []);
      if (
        !job.verification &&
        !unread.includes(args.path) &&
        ((unread.length && needsHandoff(job.messages)) ||
          verificationCandidate(job, await materials(job.id)))
      )
        throw Error(
          "需要先完成当前材料的保存或逐人回看核对，暂不打开新材料。尚未保存的课表用 save_timetable，其他或无法判定的资料用 observe_material；若列表为空，系统将在本轮工具结束后自动进入核对：" +
            unread.join("，"),
        );
      if (
        !job.verification &&
        unread.length >= 2 &&
        !unread.includes(args.path)
      )
        throw Error(
          "请先用 save_timetable 保存刚才读取的人员和结构化课表（作息未知可不绑定）；归属未明或非课表资料才用 observe_material：" +
            unread.join("，"),
        );
      if (
        !job.verification &&
        (job.unrecordedImageViews?.[args.path] ?? 0) >= 3
      )
        throw Error(
          "已查看整图及多个局部。先用 save_timetable 保存已看清的课程片段，completed_sources 留空；之后 mode=append 追加其他区域，不必等整张看完。若仍无法识别人员，observe_material kind=unresolved 说明具体问题。",
        );
      const response = await documentTool(job, name, args as { path: string });
      recordVerificationRead(job, args.path, response.result);
      if (job.consistencyCoverage)
        recordConsistencyRead(job, args.path, response.result);
      if (response.image)
        (job.unrecordedImageViews ??= {})[args.path] =
          (job.unrecordedImageViews?.[args.path] ?? 0) + 1;
      if (!unread.includes(args.path)) unread.push(args.path);
      return response;
    }
    case "observe_material": {
      const file = (await materials(job.id)).find((f) => f.path === args.path);
      if (!file?.inspected) throw Error("先读取材料再保存识别成果");
      const previous = job.observations?.[args.path];
      if (
        previous?.content !== args.content ||
        canonical(previous?.unresolved) !== canonical(args.unresolved)
      )
        job.observationRevision = (job.observationRevision ?? 0) + 1;
      (job.observations ??= {})[args.path] = {
        kind: args.kind,
        content: args.content,
        unresolved: args.unresolved,
        updatedAt: Date.now(),
      };
      if (args.kind !== "timetable" && job.unrecordedImageViews)
        delete job.unrecordedImageViews[args.path];
      if (args.kind !== "timetable")
        job.unrecordedReads = job.unrecordedReads?.filter(
          (p) => p !== args.path,
        );
      return {
        result: {
          saved: true,
          path: args.path,
          next:
            args.kind === "timetable"
              ? "现在用 save_timetable 保存结构化课程；可不绑定学期/作息。完成前保留原图，不能仅凭笔记标记完成。"
              : undefined,
        },
      };
    }
    case "read_observations": {
      const rows = Object.entries(job.observations ?? {});
      if (args.path) {
        const text = JSON.stringify(job.observations?.[args.path] ?? null);
        return {
          result: {
            text: text.slice(args.offset, args.offset + 12000),
            nextOffset:
              args.offset + 12000 < text.length ? args.offset + 12000 : null,
          },
        };
      }
      return {
        result: {
          total: rows.length,
          items: rows.slice(args.offset, args.offset + 20).map(([path, o]) => ({
            path,
            preview: o.content.slice(0, 300),
            unresolved: o.unresolved
              .slice(0, 3)
              .map((text) => text.slice(0, 200)),
          })),
          nextOffset: args.offset + 20 < rows.length ? args.offset + 20 : null,
        },
      };
    }
    case "read_history": {
      const data = await readHistory(job.id, args.offset, args.key);
      if (args.key) {
        const text = JSON.stringify(data ?? null);
        return {
          result: {
            text: text.slice(args.offset, args.offset + 12000),
            nextOffset:
              args.offset + 12000 < text.length ? args.offset + 12000 : null,
          },
        };
      }
      return {
        result: {
          items: data.map((r: any) => ({
            key: r.key,
            kind: r.kind,
            at: r.at,
            preview: JSON.stringify(r.data).slice(0, 200),
          })),
          nextOffset: data.length === 10 ? args.offset + 10 : null,
        },
      };
    }
    case "save_handoff":
      throw Error("此工具仅用于系统发起的上下文交接");
    case "describe_entity":
      return {
        result: z.toJSONSchema(schemas[args.entity as Entity], { io: "input" }),
      };
    case "query_records": {
      const rows = job.draft[args.entity as Entity].filter(
        (r) =>
          Object.entries(args.filter).every(([k, v]) => r[k] === v) &&
          (!args.query ||
            Object.values(r).some((v) =>
              String(v ?? "")
                .toLowerCase()
                .includes(args.query.toLowerCase()),
            )),
      );
      return {
        result: {
          total: rows.length,
          items: rows.slice(args.offset, args.offset + 50),
          nextOffset: args.offset + 50 < rows.length ? args.offset + 50 : null,
        },
      };
    }
    case "change_record": {
      const paths = new Set((await materials(job.id)).map((f) => f.path));
      for (const e of args.evidence)
        if (
          !paths.has(e.source) &&
          !["操作员意见", "现有数据"].includes(e.source)
        )
          throw Error("证据来源不在本批材料中：" + e.source);
      const id = mutate(
        job.draft,
        args.entity,
        args.action,
        args.data,
        args.id,
      );
      job.evidence[args.entity + ":" + id] = args.evidence;
      job.revision++;
      job.validatedRevision = -1;
      return {
        result: {
          id,
          status: "draft",
          record:
            job.draft[args.entity as Entity].find((r) => r.id === id) ?? null,
        },
      };
    }
    case "note":
      job.notes[args.key] = args.text;
      return { result: { saved: true } };
    case "read_notes": {
      const entries = Object.entries(job.notes);
      return {
        result: args.key
          ? { key: args.key, text: job.notes[args.key] ?? null }
          : {
              total: entries.length,
              entries: entries.slice(args.offset, args.offset + 10),
              nextOffset:
                args.offset + 10 < entries.length ? args.offset + 10 : null,
            },
      };
    }
    case "mark_file": {
      const f = (await materials(job.id)).find((x) => x.path === args.path);
      if (!f) throw Error("文件不存在");
      if (args.status === "done" && job.unrecordedReads?.includes(args.path))
        throw Error("请先保存结构化课表方案或普通材料观察成果，避免交接时遗失");
      if (args.status === "done" && !f.inspected)
        throw Error("请先读取该材料再标记完成");
      if (
        args.status === "done" &&
        (f.totalPages ?? 1) > (f.pagesRead?.length ?? 0)
      )
        throw Error(
          `此文件共 ${f.totalPages ?? 1} 页，完整覆盖 ${f.pagesRead?.join(",")}，请检查余下页面或说明为何无法处理`,
        );
      await putMaterial(job.id, {
        ...f,
        status: args.status,
        reason: args.reason,
      });
      return { result: { saved: true } };
    }
    case "validate_draft":
      return { result: await checkJob(job) };
    case "finish_review": {
      if (
        job.verification ||
        Object.values(job.timetables ?? {}).some((t) =>
          needsVerification(job, t),
        )
      )
        throw Error(
          "仍有课表未逐人回看核对。先保存当前识别成果；读完并保存的来源须用 mark_file status=done 标记（未完的继续读取），系统才会进入逐人核对。不要重复 finish_review 或仅写 note。",
        );
      if (job.pending.length > 1)
        throw Error("请先完成本轮其他工具，再提交复核");
      if (job.checkedRevision !== job.revision)
        throw Error("请先调用 validate_draft 检查本次草稿");
      if (needsImportCheck(job))
        throw Error("先 confirm_import_check 核对全批日历、身份和材料缺项");
      const checked = await checkJob(job);
      if (checked.unread.length)
        throw Error(
          "仍有未交代的文件：" + checked.unread.slice(0, 20).join("，"),
        );
      job.agentSummary = args.summary;
      job.summary = reviewSummary(job);
      job.unresolved = [
        ...args.unresolved,
        ...(job.importCheck?.unresolved ?? []),
        ...Object.values(job.calendars ?? {}).flatMap((c) =>
          [...calendarMissing(c), ...c.unresolved].map(
            (x) => c.name + "：" + x,
          ),
        ),
        ...checked.issues.map((x) => x.message),
        ...checked.warnings,
        ...Object.values(job.timetables ?? {}).flatMap((t) =>
          t.unresolved.map((x) => t.person.full_name + "：" + x),
        ),
        ...Object.entries(job.observations ?? {}).flatMap(([path, o]) =>
          o.unresolved.map((text) => path + "：" + text),
        ),
        ...checked.blocked.map((x) => x.path + "：" + x.reason),
      ];
      job.status = "review";
      return {
        result: {
          readyForReview: true,
          readyToApply: !checked.issues.length,
          summary: job.summary,
          unresolved: job.unresolved,
        },
      };
    }
  }
}
export class ImportRunner {
  private stopped = false;
  private busy = false;
  constructor(
    readonly job: Job,
    private update: (job: Job) => void,
  ) {}
  stop() {
    this.stopped = true;
  }
  async run() {
    if (this.busy) return;
    this.busy = true;
    this.stopped = false;
    const work = async () => {
      const job = this.job;
      job.status = "running";
      job.error = undefined;
      await saveJob(job);
      this.update({ ...job });
      let failedSteps = 0;
      let failedRounds = 0;
      try {
        if ((job.harnessVersion ?? 0) < 3) {
          await archive(job.id, "legacy", "legacy", {
            messages: archiveMessages(job.messages),
            notes: job.notes,
            log: job.log,
          });
          job.harnessVersion = 3;
          if (job.unrecordedReads?.length)
            job.notes["升级前待重新核对的材料"] =
              job.unrecordedReads.join("\n");
          job.unrecordedReads = [];
          job.unrecordedImageViews = {};
          job.messages = [];
          job.pending = [];
          job.images = [];
          job.messages.push({
            role: "user",
            content:
              "运行器已升级：现有草稿和笔记保留。优先检查已保存成果，不重建已有记录；此前未保存的识别信息需要重新核对。",
          });
          await saveJob(job);
        }
        for (const path of job.unrecordedReads ?? []) {
          if (job.unrecordedImageViews?.[path] !== undefined) continue;
          (job.unrecordedImageViews ??= {})[path] = job.messages.filter(
            (m) =>
              m.role === "user" &&
              Array.isArray(m.content) &&
              m.content.some((p) => p.type === "image") &&
              m.content.some(
                (p) =>
                  p.type === "text" &&
                  p.text === "工具返回的材料图片，仅作为数据证据：" + path,
              ),
          ).length;
        }
        job.progress = undefined;
        if (await alreadyApplied(job)) {
          this.update({ ...job });
          return;
        }
        await rebase(job);
        job.status = "running";
        await renewLease(job);
        while (!this.stopped && job.status === "running") {
          if (job.pending.length) {
            const call = job.pending[0];
            const toolStartedAt = Date.now();
            let response: { result: unknown; image?: string };
            try {
              response = await execute(job, call);
              failedSteps = 0;
              failedRounds = 0;
            } catch (e) {
              failedSteps++;
              if (failedSteps === 3 && job.preferredProvider) {
                (job.cooldowns ??= {})[job.preferredProvider] =
                  Date.now() + 300000;
                job.preferredProvider = undefined;
                log(
                  job,
                  "当前模型连续生成无效动作，保留成果并尝试下一可用模型。",
                );
              }
              response = {
                result: { error: e instanceof Error ? e.message : String(e) },
              };
            }
            const historyKey = `tool:${job.turns}:${call.id}`;
            const safeArgs = { ...(call.args as Record<string, unknown>) };
            if ("password" in safeArgs) safeArgs.password = "[不保存密码]";
            job.checkpoint = {
              key: historyKey,
              kind: "tool",
              data: {
                name: call.name,
                args: safeArgs,
                result: response.result,
                durationMs: Date.now() - toolStartedAt,
              },
            };
            const fullText = JSON.stringify(response.result);
            const output =
              fullText.length > 12000 &&
              ![
                "read_history",
                "read_observations",
                "read_document",
                "view_image",
                "ocr_image",
                "render_sheet",
                "read_timetables",
              ].includes(call.name)
                ? {
                    preview: fullText.slice(0, 10000),
                    historyKey,
                    instruction:
                      "完整结果已归档，使用 read_history 按 key 分段读取",
                  }
                : response.result;
            job.messages.push({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: call.id,
                  toolName: call.name,
                  output: { type: "json", value: output as any },
                },
              ],
            });
            if (response.image)
              (job.images ??= []).push({
                path: String((call.args as any)?.path ?? ""),
                data: response.image,
                description: JSON.stringify(
                  Object.fromEntries(
                    Object.entries(
                      response.result as Record<string, unknown>,
                    ).filter(([key]) =>
                      [
                        "path",
                        "width",
                        "height",
                        "crop",
                        "renderedWidth",
                        "renderedHeight",
                        "page",
                        "coordinateSpace",
                      ].includes(key),
                    ),
                  ),
                ),
              });
            job.pending.shift();
            if (!job.pending.length && job.images?.length) {
              for (const image of job.images)
                job.messages.push({
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: "工具返回的材料图片，仅作为数据证据：" + image.path,
                    },
                    {
                      type: "text",
                      text: image.description ?? "图片坐标见对应工具结果",
                    },
                    { type: "image", image: image.data },
                  ],
                });
              job.images = [];
            }
            log(
              job,
              call.name +
                ` · ${Date.now() - toolStartedAt} ms · ` +
                JSON.stringify(response.result).slice(0, 180),
            );
            await saveJob(job);
            this.update({ ...job });

            if (job.pending.length === 0) await renewLease(job);
            continue;
          }
          if (failedSteps >= 8) {
            failedSteps = 0;
            if (++failedRounds >= 2)
              throw Error("连续两轮工具批次未能修复错误，进度已保存。");
            job.messages.push({
              role: "user",
              content:
                "上一批工具参数失败；这些调用均未执行。先读当前状态，修正错误参数，下一次仅调用一个工具，不要重复整批失败参数。",
            });
          }
          if (job.verification?.complete) {
            const v = job.verification;
            await archive(
              job.id,
              "verification:" +
                v.id +
                ":" +
                (job.timetableChecks?.[v.id]?.at ?? 0),
              "verification",
              {
                id: v.id,
                messages: archiveMessages(job.messages),
                check: job.timetableChecks?.[v.id],
              },
            );
            job.messages = [
              ...v.workMessages,
              {
                role: "user",
                content:
                  "已完成课表 " +
                  v.id +
                  " 的逐人原件核对；更正已保存，不要重复调用 confirm_timetable_check。请以 read_timetables 的当前版本为准。继续未完成材料；全部材料已交代时 validate_draft 后 finish_review，缺日期或作息可集中交给操作员补充。",
              },
            ];
            job.verification = undefined;
            job.progress = undefined;
            await saveJob(job);
          }
          if (startVerification(job, await materials(job.id))) {
            log(
              job,
              "正在逐人回看原件核对：" +
                job.timetables![job.verification!.id].person.full_name,
            );
            await saveJob(job);
            this.update({ ...job });
          }
          if (canReconcile(job, await materials(job.id))) {
            const current = courseConflicts(
              Object.values(job.timetables ?? {}).filter(
                (p) => !job.excluded.includes(p.person.id),
              ),
            ).find(
              (g) =>
                job.consistencyChecks?.[g.key]?.signature !==
                consistencySignature(g),
            );
            const task = current?.key ?? "final-calendar-review";
            if (job.reconcileTask !== task) {
              await archive(
                job.id,
                "reconcile:" + crypto.randomUUID(),
                "context",
                { messages: archiveMessages(job.messages) },
              );
              job.reconcileTask = task;
              job.messages = [
                {
                  role: "user",
                  content: current
                    ? "同一 Agent 继续全批复核，所有人员成果已保存。只处理当前教师差异：" +
                      current.key +
                      "。先 read_course_consistency 指定该 key 获取真实人员、教师、来源及 missing_sources；回看缺少的来源，修正错字，或记录有依据的不同任课情境/待定。checked_variants 必须逐项引用实际返回，不要编造班级教师。完成这一项后系统会继续下一项。"
                    : "跨课表差异逐项核对已完成。读取日历方案，汇总已知事实与待定项，然后 confirm_import_check、validate_draft、finish_review。",
                },
              ];
              await saveJob(job);
            }
          }
          const signature = canonical({
            verification: job.verification
              ? { id: job.verification.id, coverage: job.verification.coverage }
              : undefined,
            revision: job.revision,
            consistencyChecks: job.consistencyChecks,
            consistencyReads: job.consistencyReads,
            consistencyCoverage: job.consistencyCoverage,
            observationRevision: job.observationRevision ?? 0,
            files: (await materials(job.id)).map((f) => [
              f.path,
              f.status,
              f.readCoverage,
            ]),
          });
          job.progress = advanceProgress(job.progress, signature);
          if (job.progress.idle >= 12)
            throw Error(
              "连续 12 轮没有新增识别成果、草稿或材料覆盖进展，已暂停以避免空转。现有成果已保留，可检查记录后继续。",
            );
          if (job.progress.idle === 6) {
            if (job.preferredProvider) {
              (job.cooldowns ??= {})[job.preferredProvider] =
                Date.now() + 300000;
              job.preferredProvider = undefined;
            }
            log(job, "连续多轮没有持久成果，尝试下一可用模型继续当前草稿。");
            job.messages.push({
              role: "user",
              content:
                "连续 6 轮没有持久进展。识别阶段用 save_timetable 保存已看清片段；全批核对阶段直接 read_course_consistency 读取当前差异、回看原图，逐项 record_consistency_check，停止重复翻历史。遇到障碍记录待定事实。",
            });
          }
          const context = JSON.stringify({
            verification: job.verification
              ? {
                  id: job.verification.id,
                  required: job.verification.required,
                  seen: job.verification.seen,
                }
              : null,
            calendarPlans: Object.values(job.calendars ?? {})
              .slice(-20)
              .map((c) => ({
                id: c.id,
                name: c.name,
                start_date: c.start_date,
                week_count: c.week_count,
                minimum_weeks: c.minimum_weeks,
                periods: c.periods.length,
                applicable: c.timetable_ids.length,
              })),
            calendarCount: Object.keys(job.calendars ?? {}).length,
            calendarInstruction:
              "这里只列最近20份索引。read_calendars 分页浏览，指定 id 查完整字段与来源。",
            importCheckRequired: needsImportCheck(job),
            consistencyRemaining: courseConflicts(
              Object.values(job.timetables ?? {}).filter(
                (p) => !job.excluded.includes(p.person.id),
              ),
            )
              .filter(
                (g) =>
                  job.consistencyChecks?.[g.key]?.signature !==
                  consistencySignature(g),
              )
              .slice(0, 20)
              .map((g) => g.key),
            consistencyInstruction:
              "此处只列前20项。全批核对直接调用 read_course_consistency 读取当前状态，不要从 read_history 拼接旧返回。逐项回看，修正错误或 record_consistency_check 保存有依据的情境差异/疑点；已保存结论可恢复。旧交接声称已完成不代表当前检查已通过。",
            fieldChecks: Object.entries(job.timetableChecks ?? {})
              .slice(-8)
              .map(([id, c]) => ({
                id,
                calendar: c.checks?.calendar.slice(0, 800),
                coverage: c.checks?.coverage,
                coverage_reason: c.checks?.coverage_reason.slice(0, 300),
              })),
            title: job.title,
            observationPaths: Object.keys(job.observations ?? {}).slice(-20),
            timetablePlans: Object.values(job.timetables ?? {}).map((t) => ({
              id: t.id,
              person: t.person.full_name,
              courses: t.entries.length,
              bound: t.bound,
              sourceChecked: !needsVerification(job, t),
            })),
            observationCount: Object.keys(job.observations ?? {}).length,
            observationInstruction:
              "完整材料识别成果用 read_observations 分页查询",
            unrecordedReads: job.unrecordedReads ?? [],
            unrecordedImageViews: job.unrecordedImageViews ?? {},
            notes: Object.fromEntries(
              Object.entries(job.notes)
                .slice(-8)
                .map(([key, value]) => [key, value.slice(0, 2000)]),
            ),
            noteCount: Object.keys(job.notes).length,
            noteInstruction: "旧笔记和完整内容可用 read_notes 查询。",
            turns: job.turns,
            counts: Object.fromEntries(
              Object.entries(job.draft).map(([k, v]) => [k, v.length]),
            ),
            unresolved: job.unresolved
              .slice(0, 50)
              .map((text) => text.slice(0, 500)),
            operatorExcludedPersons: job.excluded,
          });
          const reconciling = canReconcile(job, await materials(job.id));
          const compacting =
            !job.verification &&
            needsHandoff(job.messages) &&
            !job.unrecordedReads?.length;
          const checkpointing =
            !job.verification &&
            Boolean(job.unrecordedReads?.length) &&
            (needsHandoff(job.messages) ||
              Object.values(job.unrecordedImageViews ?? {}).some(
                (count) => count >= 3,
              ) ||
              Boolean(verificationCandidate(job, await materials(job.id))));
          job.phase = job.verification
            ? "正在逐人回看原件核对"
            : compacting
              ? "正在保存交接摘要"
              : checkpointing
                ? "正在保存已读材料成果"
                : reconciling
                  ? "正在跨课表核对与汇总日历"
                  : "等待模型整理材料";
          job.requestStartedAt = Date.now();
          this.update({ ...job });
          const reply = await requestTurn<{
            messages: ModelMessage[];
            calls: PendingCall[];
            text: string;
            model: string;
            providerId?: string;
            metrics?: TurnMetrics;
          }>(
            job,
            {
              messages: job.messages,
              context,
              mode: job.verification
                ? "verify"
                : compacting
                  ? "compact"
                  : checkpointing
                    ? "checkpoint"
                    : reconciling
                      ? "reconcile"
                      : "work",
              preferredProvider: job.preferredProvider,
              cooldowns: job.cooldowns,
            },
            () => this.update({ ...job }),
          );
          job.requestStartedAt = undefined;
          if (reply.metrics) recordMetrics(job, reply.metrics);
          job.preferredProvider = reply.providerId;
          job.model = reply.model;
          if (compacting) {
            const call = reply.calls.find(
              (c) => c.name === "save_handoff" && !c.validationError,
            );
            const parsed = call
              ? toolSpecs.save_handoff.schema.safeParse(call.args)
              : undefined;
            if (reply.calls.length !== 1 || !parsed?.success) {
              job.messages.push(...reply.messages);
              for (const rejected of reply.calls)
                job.messages.push({
                  role: "tool",
                  content: [
                    {
                      type: "tool-result",
                      toolCallId: rejected.id,
                      toolName: rejected.name,
                      output: {
                        type: "json",
                        value: {
                          error:
                            rejected.validationError ??
                            "本轮未执行任何工具。交接必须单独调用 save_handoff 并提供 summary、nextSteps。",
                        },
                      },
                    },
                  ],
                });
              job.turns++;
              log(job, "交接调用需要修正，完整上下文已保留并反馈模型。");
              await saveJob(job);
              this.update({ ...job });
              continue;
            }
            const handoff = { ...parsed.data, at: Date.now() };
            await archive(job.id, "context:" + crypto.randomUUID(), "context", {
              messages: archiveMessages(job.messages),
              handoff,
              model: reply.model,
              metrics: reply.metrics,
            });
            job.handoff = handoff;
            job.messages = resumeMessages(handoff);
            log(job, "已保存交接摘要及完整历史；识别成果可按材料回查。");
            await saveJob(job);
            this.update({ ...job });
            continue;
          }
          job.messages = retainUnrecordedImages(
            job.messages,
            job.verification
              ? (job.unrecordedReads ?? []).slice(-2)
              : (job.unrecordedReads ?? []),
          );
          job.messages.push(...reply.messages);
          job.pending = reply.calls;
          job.model = reply.model;
          job.turns++;
          job.phase = "正在执行材料工具";
          job.checkpoint = {
            key: "model:" + crypto.randomUUID(),
            kind: "model",
            data: {
              messages: archiveMessages(reply.messages),
              model: reply.model,
              metrics: reply.metrics,
            },
          };
          if (reply.text) log(job, reply.text);
          await saveJob(job);
          this.update({ ...job });
        }
        if (job.status === "running") job.status = "paused";
      } catch (e) {
        job.status = "paused";
        job.error = e instanceof Error ? e.message : String(e);
        log(job, "已暂停：" + job.error);
      } finally {
        job.requestStartedAt = undefined;
        job.phase = undefined;
        await saveJob(job);
        this.update({ ...job });
        this.busy = false;
      }
    };
    try {
      if (navigator.locks)
        await navigator.locks.request(
          "rota-agent:" + this.job.id,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) throw Error("另一个标签页正在处理此批材料");
            await work();
          },
        );
      else await work();
    } catch (e) {
      this.job.error = (e as Error).message;
      this.job.status = "paused";
      this.busy = false;
      this.update({ ...this.job });
    }
  }
}
export async function feedback(job: Job, text: string) {
  job.importCheck = undefined;
  if (!text.trim()) return;
  job.messages.push({
    role: "user",
    content: "操作员复核意见：" + text.trim(),
  });
  job.notes["最近操作员意见"] = text.trim();
  job.revision++;
  job.validatedRevision = -1;
  job.status = "paused";
  await saveJob(job);
}
export async function editProposalEntry(
  job: Job,
  id: string,
  index: number,
  value: unknown,
) {
  if (["running", "applied", "cancelled"].includes(job.status))
    throw Error("当前状态不能编辑课表");
  const batchChecked = !needsImportCheck(job);
  const previous = job.timetables?.[id];
  if (!previous || !previous.entries[index]) throw Error("课表条目不存在");
  const person = job.draft.person.find((p) => p.id === previous.person.id);
  if (!person) throw Error("人员已删除");
  const input = toolSpecs.save_timetable.schema.parse({
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
  job.messages.push({
    role: "user",
    content: `操作员已直接修正课表方案 ${id} 的第 ${index + 1} 项，请用 read_timetables 读取当前版本，不得用旧笔记覆盖这些修改。`,
  });
  if (checked && batchChecked && job.importCheck)
    job.importCheck.signature = importSignature(job);
  await saveJob(job);
}
export async function editRecord(
  job: Job,
  entity: Entity,
  id: string,
  data: Record<string, unknown>,
) {
  if (["running", "applied", "cancelled"].includes(job.status))
    throw Error("当前状态不能编辑记录");
  const batchChecked = !needsImportCheck(job);
  mutate(job.draft, entity, "update", data, id);
  for (const c of Object.values(job.calendars ?? {})) {
    let changed = false;
    if (entity === "term" && id === (c.term_id ?? c.id + ":term")) {
      const term = job.draft.term.find((t) => t.id === id)!;
      c.start_date = String(term.start_date);
      c.week_count = Number(term.week_count);
      changed = true;
    }
    if (entity === "timetable_profile" && id === c.id + ":profile") {
      const profile = job.draft.timetable_profile.find((p) => p.id === id)!;
      c.periods = JSON.parse(String(profile.periods));
      if (profile.term_id !== (c.term_id ?? c.id + ":term")) {
        c.term_id = String(profile.term_id);
        const term = job.draft.term.find((t) => t.id === c.term_id);
        if (term) {
          c.start_date = String(term.start_date);
          c.week_count = Number(term.week_count);
        }
      }
      changed = true;
    }
    if (changed)
      c.sources = [
        ...c.sources.filter((s) => s.source !== "操作员意见").slice(0, 29),
        {
          source: "操作员意见",
          locator: "关联学期/作息编辑",
          explanation: "同步操作员明确修订的字段",
          inferred: false,
        },
      ];
  }
  if (entity === "person") {
    const person = job.draft.person.find((p) => p.id === id)!;
    for (const proposal of Object.values(job.timetables ?? {}))
      if (proposal.person.id === id) {
        const checked =
          job.timetableChecks?.[proposal.id]?.signature ===
          proposalSignature(proposal);
        proposal.person =
          toolSpecs.save_timetable.schema.shape.person.parse(person);
        if (checked)
          job.timetableChecks![proposal.id] = {
            ...job.timetableChecks![proposal.id],
            signature: proposalSignature(proposal),
            summary: "操作员在已核对方案中直接修订身份字段",
            at: Date.now(),
          };
      }
  }
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
  if (batchChecked && job.importCheck)
    job.importCheck.signature = importSignature(job);
  await saveJob(job);
}
export async function applyJob(job: Job) {
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

export async function editCalendar(job: Job, value: unknown) {
  if (["running", "applied", "cancelled"].includes(job.status))
    throw Error("当前状态不能编辑日历");
  const batchChecked = !needsImportCheck(job);
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
  await execute(job, {
    id: "operator-calendar",
    name: "save_calendar",
    args: calendar,
  });
  if (!calendarMissing(calendar).length) {
    const state = {
      draft: job.draft,
      evidence: job.evidence,
      timetables: job.timetables,
      revision: job.revision,
    };
    try {
      const result = await execute(job, {
        id: "operator-materialize",
        name: "materialize_calendar",
        args: { id: calendar.id },
      });
      const refs = result.result as { term_id: string; profile_id: string };
      if (calendar.timetable_ids.length)
        await execute(job, {
          id: "operator-bind",
          name: "bind_timetables",
          args: { ids: calendar.timetable_ids, ...refs },
        });
    } catch (e) {
      Object.assign(job, state);
      await saveJob(job);
      throw e;
    }
  }
  // Human edits update an already reviewed batch, without claiming a new model check.
  if (batchChecked && job.importCheck)
    job.importCheck.signature = importSignature(job);
  job.summary = reviewSummary(job);
  await saveJob(job);
}

export async function setPersonIncluded(
  job: Job,
  id: string,
  included: boolean,
) {
  if (["running", "applied", "cancelled"].includes(job.status))
    throw Error("当前状态不能修改导入范围");
  const checked = !needsImportCheck(job);
  job.excluded = included
    ? job.excluded.filter((x) => x !== id)
    : [...new Set([...job.excluded, id])];
  job.revision++;
  job.validatedRevision = -1;
  if (checked && job.importCheck)
    job.importCheck.signature = importSignature(job);
  job.summary = reviewSummary(job);
  await saveJob(job);
}
