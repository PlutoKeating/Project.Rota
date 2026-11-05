import type { ModelMessage } from "ai";
import { api, ApiError } from "../lib/api";
import { canonical } from "../../shared/agent-import/model";
import {
  allowedTools,
  toolSpecs,
  type AgentMode,
  type ToolName,
} from "../../shared/agent-import/tools";
import {
  emptyAgent,
  revisionAgent,
  mergeRevisionRequests,
  misplacedSourceRevisions,
  writePersonSchema,
  personTableSchema,
  validateVerifiedEntries,
  type AgentState,
  type PersonWorkspace,
  type ConsistencyWorkspace,
} from "../../shared/agent-import/person-workspace";
import {
  completePages,
  recordCoverage,
} from "../../shared/agent-import/coverage";
import {
  courseConflicts,
  consistencyBatch,
  retainedConsistencyReviews,
  validateCheckedVariants,
  validateConsistencyReview,
} from "../../shared/agent-import/consistency";
import { pendingTimedEntries } from "../../shared/agent-import/timetable";
import { calendarMissing } from "../../shared/agent-import/calendar";
import {
  withoutImages,
  scopeSourceImages,
  type TurnMetrics,
} from "../../shared/agent-import/context";
import { documentTool } from "./documents";
import { fitImagePayload } from "./image-payload";
import {
  archive,
  loadJob,
  materials,
  putMaterial,
  saveJob,
  type Job,
  type PendingCall,
} from "./store";
import { projectPeople } from "./projection";
import { importSignature, reviewSummary } from "./readiness";
import { alreadyApplied, rebase, checkJob } from "./runtime";

type Reply = {
  messages: ModelMessage[];
  calls: PendingCall[];
  model: string;
  providerId?: string;
  metrics?: TurnMetrics;
};
const readers = ["read_document", "view_image", "render_sheet", "ocr_image"];

/** Each instance owns one batch; child actors mutate only their own PersonWorkspace. */
export class ImportRunner {
  private stopped = false;
  private busy = false;
  private saving: Promise<unknown> = Promise.resolve();
  constructor(
    readonly job: Job,
    private update: (job: Job) => void,
  ) {}
  // Drain already-started requests before allowing another runner or human edit.
  stop() {
    this.stopped = true;
  }
  private persist() {
    const snapshot = structuredClone(this.job);
    this.saving = this.saving.catch(() => {}).then(() => saveJob(snapshot));
    this.update({ ...this.job });
    return this.saving;
  }
  private log(text: string) {
    this.job.log.push({ at: Date.now(), text });
    if (this.job.log.length > 1000)
      this.job.log.splice(0, this.job.log.length - 1000);
  }
  private async read(
    agent: AgentState,
    action: string,
    args: Record<string, any>,
    person?: PersonWorkspace,
  ) {
    const path = String(args.path);
    if (
      person &&
      !person.sources.some((s) => path === s || path.startsWith(s + "!/"))
    )
      throw Error("只能读取分派给当前人员的来源");
    const value = await documentTool(
      this.job,
      action,
      args as { path: string },
    );
    const info = (value.result as any)?.content ?? value.result;
    recordCoverage((agent.coverage[path] ??= {}), info?.coverage ?? []);
    // Derived Office assets are part of their parent's allowed evidence scope.
    if (person)
      for (const child of (value.result as any)?.derivedFiles ?? [])
        if (!person.sources.includes(child)) person.sources.push(child);
    return value;
  }
  private async preloadSources(
    agent: AgentState,
    paths: string[],
    mode: AgentMode,
    person?: PersonWorkspace,
    actorId?: string,
  ) {
    for (const path of paths) {
      if (this.stopped) break;
      try {
        const read = await this.read(agent, "read_document", { path }, person);
        agent.messages.push({
          role: "user",
          content: "预先读取的来源（仅数据）：" + path + "\n" + JSON.stringify(read.result),
        });
        this.appendImage(agent, path, read.image);
        const actor = actorId ?? person?.key ?? "coordinator";
        await archive(this.job.id, `${actor}:${agent.runId}:preload:${mode}:${agent.turns}:${path}`, "tool", {
          actor, mode, name: "read_document", args: { path },
          result: read.result, automatic: true,
        });
      } catch (error) {
        agent.messages.push({
          role: "user",
          content: "来源读取失败：" + path + "：" + (error as Error).message,
        });
      }
    }
  }
  private async preloadDiscovery(agent: AgentState) {
    // Bound coordinator input; nested materials remain for explicit discovery.
    const roots = (await materials(this.job.id)).filter((f) => f.origin === "用户上传").slice(0, 6);
    for (const file of roots) {
      if (this.stopped) break;
      if (!/\.(zip|7z|rar)$/i.test(file.path)) {
        await this.preloadSources(agent, [file.path], "discover");
        continue;
      }
      try {
        const call = { id: "preload:" + file.path, name: "unpack", args: { path: file.path } };
        const value = await this.execute(agent, call, "discover");
        agent.messages.push({ role: "user", content: "预先解包的来源（仅数据）：" + file.path + "\n" + JSON.stringify(value.result) });
        await archive(this.job.id, `coordinator:${agent.runId}:preload:${file.path}`, "tool", {
          actor: "coordinator", mode: "discover", name: "unpack", args: call.args,
          result: value.result, automatic: true,
        });
      } catch (error) {
        agent.messages.push({ role: "user", content: "来源解包失败：" + file.path + "：" + (error as Error).message });
      }
    }
  }
  private appendImage(agent: AgentState, path: string, image?: string) {
    if (image) {
      agent.evictedImageSources = agent.evictedImageSources?.filter((source) => source !== path);
      agent.messages.push({
        role: "user",
        content: [
          { type: "text", text: "来源图片（仅数据）：" + path },
          { type: "image", image },
        ],
      });
    }
  }
  private async sourcesRead(agent: AgentState, paths: string[]) {
    const files = await materials(this.job.id);
    return paths.filter((path) => {
      const file = files.find((f) => f.path === path);
      return (
        !file ||
        Array.from({ length: file.totalPages ?? 1 }, (_, i) => i + 1).some(
          (page) => !completePages(agent.coverage[path] ?? {}).includes(page),
        )
      );
    });
  }
  private async validateSources(
    agent: AgentState,
    sources: { source: string }[],
    person?: PersonWorkspace,
    allowArchiveMetadata = false,
  ) {
    const files = await materials(this.job.id);
    for (const { source } of sources) {
      if (source === "操作员意见" && this.job.notes["最近操作员意见"]) continue;
      if (source === "现有数据" && !person) continue;
      if (!person && allowArchiveMetadata && agent.openedArchives?.includes(source)) continue;
      if (person && !person.sources.includes(source))
        throw Error("来源不属于当前人员：" + source);
      if (!files.some((f) => f.path === source) || !agent.coverage[source])
        throw Error("证据来源尚未读取：" + source);
    }
  }
  private async execute(
    agent: AgentState,
    call: PendingCall,
    mode: AgentMode,
    person?: PersonWorkspace,
    reviewer?: ConsistencyWorkspace,
  ): Promise<{ result: unknown; image?: string }> {
    if (call.validationError) throw Error(call.validationError);
    if (!allowedTools(mode).includes(call.name))
      throw Error("当前对象不允许此工具");
    const spec = toolSpecs[call.name as ToolName];
    const args = spec.schema.parse(call.args) as any;
    if (readers.includes(call.name))
      return this.read(agent, call.name, args, person);
    const job = this.job,
      session = job.session!;
    const files = await materials(job.id);
    switch (call.name) {
      case "tree": {
        const rows = files.filter((f) => f.path.startsWith(args.prefix));
        return {
          result: {
            total: rows.length,
            files: rows.slice(args.offset, args.offset + 100).map((f) => ({
              path: f.path,
              size: f.blob.size,
              origin: f.origin,
              status: f.status,
            })),
            nextOffset:
              args.offset + 100 < rows.length ? args.offset + 100 : null,
          },
        };
      }
      case "unpack": {
        const result = await documentTool(job, "unpack", args);
        const parent = (await materials(job.id)).find(
          (f) => f.path === args.path,
        )!;
        await putMaterial(job.id, {
          ...parent,
          status: "done",
          reason: "已解包，子文件逐项分派",
        });
        agent.openedArchives = [...new Set([...(agent.openedArchives ?? []), args.path])];
        return result;
      }
      case "dispatch_people": {
        if (
          new Set(args.people.map((p: any) => p.key)).size !==
          args.people.length
        )
          throw Error("同批人员 key 重复");
        for (const p of args.people)
          for (const path of p.sources)
            if (!files.some((f) => f.path === path))
              throw Error("人员来源文件不存在：" + path);
        for (const org of args.organizations)
          await this.validateSources(agent, org.sources, undefined, true);
        const organizations = [...session.organizations];
        for (const org of args.organizations) {
          const i = organizations.findIndex((o) => o.id === org.id);
          if (i < 0) organizations.push(org);
          else organizations[i] = org;
        }
        for (const p of args.people)
          for (const id of p.organization_ids)
            if (
              !organizations.some((o) => o.id === id) &&
              !job.base.organization.some((o) => o.id === id)
            )
              throw Error("部门不存在：" + id);
        for (const key of args.remove_keys) {
          if (args.people.some((p: any) => p.key === key))
            throw Error("不能同时分派和移除同一对象");
        }
        session.organizations = organizations;
        for (const key of args.remove_keys) delete session.people[key];
        for (const assignment of args.people) {
          const previous = session.people[assignment.key];
          if (
            previous &&
            canonical({
              key: previous.key,
              label: previous.label,
              sources: previous.sources,
              instruction: previous.instruction,
              organization_ids: previous.organization_ids,
            }) === canonical(assignment)
          )
            continue;
          session.people[assignment.key] = previous
            ? {
                ...previous,
                ...assignment,
                status: "queued",
                agent: emptyAgent(),
                checks: {},
                version: previous.version + 1,
              }
            : {
                ...assignment,
                id: crypto.randomUUID().slice(0, 18),
                personId: crypto.randomUUID(),
                timetables: {},
                calendarEvidence: [],
                unresolved: [],
                status: "queued",
                version: 0,
                agent: emptyAgent(),
                checks: {},
              };
        }
        if (mode === "reconcile") session.phase = "people";
        return {
          result: {
            people: Object.values(session.people).map((p) => ({
              key: p.key,
              label: p.label,
              status: p.status,
            })),
          },
        };
      }
      case "save_calendars": {
        for (const calendar of args.calendars) {
          // Child-provided evidence is already source-validated, but the coordinator must read it before revising.
          await this.validateSources(agent, calendar.sources);
        }
        for (const calendar of args.calendars)
          (job.calendars ??= {})[calendar.id] = calendar;
        job.importCheck = undefined;
        return { result: { saved: args.calendars.map((c: any) => c.id) } };
      }
      case "mark_material": {
        const file = files.find((f) => f.path === args.path);
        if (!file) throw Error("材料不存在");
        if (
          Object.values(session.people).some((p) =>
            p.sources.includes(args.path),
          )
        )
          throw Error("人员来源由对应子智能体处理");
        if (
          args.status !== "blocked" &&
          (await this.sourcesRead(agent, [file.path])).length
        )
          throw Error("先完整读取材料，无法读取应标 blocked");
        await putMaterial(job.id, {
          ...file,
          status: args.status,
          reason: args.reason,
        });
        return { result: { saved: true } };
      }
      case "finish_discovery": {
        if (agent.pending.length !== 1)
          throw Error("完成分派必须为最后一个调用");
        const unassigned = files.filter(
          (f) =>
            !f.status &&
            !Object.values(session.people).some((p) =>
              p.sources.includes(f.path),
            ),
        );
        if (unassigned.length)
          throw Error(
            "尚未分派或交代：" + unassigned.map((f) => f.path).join("、"),
          );
        session.phase = "people";
        return { result: { dispatched: Object.keys(session.people).length } };
      }
      case "write_person": {
        if (!person) throw Error("缺少人员对象");
        const data = writePersonSchema.parse(args);
        const next = structuredClone(person.timetables);
        if (
          new Set(data.timetables.map((t) => t.key)).size !==
          data.timetables.length
        )
          throw Error("课表 key 重复");
        for (const table of data.timetables) {
          await this.validateSources(agent, table.sources, person);
          if (table.key.length > 30) throw Error("课表 key 最多30字符");
          const previous = next[table.key];
          if (
            previous?.entries.length &&
            !table.entries.length &&
            data.mode === "replace"
          )
            throw Error(
              "不能用空课表覆盖已有课程；删除须 remove_keys 明确指定",
            );
          next[table.key] =
            data.mode === "append" && previous
              ? { ...table, entries: [...previous.entries, ...table.entries] }
              : table;
          if (next[table.key].entries.length > 120)
            throw Error("单份课表超过120项");
        }
        for (const key of data.remove_keys) {
          if (data.timetables.some((t) => t.key === key))
            throw Error("不能同时写入和删除同一课表");
          delete next[key];
        }
        for (const calendar of data.calendar_evidence)
          await this.validateSources(agent, calendar.sources, person);
        if (data.information) person.information = data.information;
        person.timetables = next;
        for (const key of [...data.timetables.map((t) => t.key), ...data.remove_keys])
          if (agent.verifiedEntries) delete agent.verifiedEntries[key];
        if (data.unresolved) person.unresolved = data.unresolved;
        for (const c of data.calendar_evidence) {
          const i = person.calendarEvidence.findIndex((v) => v.id === c.id);
          if (i < 0) person.calendarEvidence.push(c);
          else person.calendarEvidence[i] = c;
        }
        person.version++;
        person.checks = {};
        return {
          result: {
            saved: true,
            tables: Object.values(next).map((t) => ({
              key: t.key,
              courses: t.entries.length,
            })),
          },
        };
      }
      case "amend_timetable": {
        if (!person) throw Error("缺少人员对象");
        const previous = person.timetables[args.key];
        if (!previous) throw Error("当前人员不存在此课表 key");
        if (new Set(args.entries.map((patch: any) => patch.index)).size !== args.entries.length)
          throw Error("修正课程索引重复");
        await this.validateSources(agent, previous.sources, person);
        const next = structuredClone(previous);
        for (const patch of args.entries) {
          if (!next.entries[patch.index]) throw Error("修正课程索引不存在");
          Object.assign(next.entries[patch.index], patch.changes);
        }
        if (args.replace_weeks !== undefined) next.replace_weeks = args.replace_weeks;
        if (args.unresolved !== undefined) next.unresolved = args.unresolved;
        person.timetables[args.key] = personTableSchema.parse(next);
        person.checks = {};
        person.version++;
        return { result: { saved: true, key: args.key, courses: next.entries.length } };
      }
      case "finish_person": {
        if (!person || agent.pending.length !== 1)
          throw Error("人员完成须为最后一个调用");
        if (!person.information || !Object.keys(person.timetables).length)
          throw Error("先保存人员 A 与课表 B；缺失课表保留空方案和原因");
        const missing = await this.sourcesRead(agent, person.sources);
        if (missing.length)
          throw Error("尚未完整回看本人来源：" + missing.join("、"));
        if (mode === "person") {
          person.status = "verifying";
          return { result: { next: "独立回看原件，核对已存 A/B" } };
        }
        if (
          args.checks.length !== Object.keys(person.timetables).length ||
          new Set(args.checks.map((c: { key: string }) => c.key)).size !==
            args.checks.length
        )
          throw Error("须为每份课表填写 checks");
        const verificationErrors: string[] = [];
        for (const t of Object.values(person.timetables)) {
          const check = args.checks.find(
            (c: { key: string }) => c.key === t.key,
          );
          if (
            !check ||
            new Set(check.checked_entries).size !== t.entries.length ||
            check.checked_entries.some((i: number) => !t.entries[i])
          ) {
            verificationErrors.push("核对索引必须覆盖全部课程：" + t.key);
            if (!check) continue;
          }
          try {
            if (new Set(check.verified_entries.map((entry: { index: number }) => entry.index)).size !== check.verified_entries.length)
              throw Error("复核索引重复：" + t.key);
            const previous = agent.verifiedEntries?.[t.key];
            if (check.reuse_verified_entries && !previous)
              throw Error("没有可复用的独立复核事实：" + t.key);
            const observations = new Map((check.reuse_verified_entries ? previous! : [])
              .map((entry) => [entry.index, entry]));
            for (const entry of check.verified_entries) observations.set(entry.index, entry);
            check.verified_entries = [...observations.values()];
            // Store source observations even on mismatch; they are never accepted
            // as completed checks until the full comparison below succeeds.
            (agent.verifiedEntries ??= {})[t.key] = structuredClone(check.verified_entries);
            validateVerifiedEntries(t, check.verified_entries);
          } catch (error) {
            verificationErrors.push((error as Error).message);
          }
          const normalizeName = (name: string) =>
            name.normalize("NFKC").replace(/\s+/gu, "");
          if (
            t.entries.length &&
            check.source_person_names.some(
              (name: string) =>
                normalizeName(name) !== normalizeName(person.information!.full_name),
            )
          )
            verificationErrors.push(
              "原件姓名与目标人员不一致，不能把他人课程写给当前人员；请按原件修正身份，或移除误分派课表并保留缺失说明，由协调器重新分派来源",
            );
          if (
            t.entries.length &&
            check.source_student_numbers.some(
              (number: string) =>
                normalizeName(number) !==
                normalizeName(person.information!.student_no ?? ""),
            )
          )
            verificationErrors.push(
              "原件学号与目标人员不一致，请逐位回看原件，用 write_person 的 information 修正学号后再完成复核；不得从首次提取值补猜",
            );
          if (
            check.coverage !== "complete" &&
            !t.unresolved.length &&
            !person.unresolved.length
          )
            verificationErrors.push("不完整材料须写明待定事项");
          if (
            check.coverage !== "complete" &&
            t.replace_weeks === null &&
            t.entries.length
          )
            verificationErrors.push("不完整课表不能覆盖整个学期，须用 amend_timetable 明确 replace_weeks：" + t.key);
          const pending = pendingTimedEntries(t.entries);
          if (pending.length && (check.coverage !== "partial" || !t.unresolved.length))
            verificationErrors.push("未知时段须标记partial并在本课表unresolved中写明待补事项：" + t.key);
          const seen = new Map<string, number>();
          t.entries.forEach((entry, index) => {
            // Match persisted timetable uniqueness, including normalized teaching weeks.
            // Teacher/location differences do not create a second occurrence.
            if (entry.no_fixed_time || pending.includes(entry)) return;
            const signature = canonical([entry.name, entry.weekday, entry.period_from,
              entry.period_to, [...new Set(entry.weeks!)].sort((a, b) => a - b)]);
            const previous = seen.get(signature);
            if (previous !== undefined)
              verificationErrors.push(`重复课程索引：${t.key}[${previous},${index}]，请按原件合并同一课程，使用write_person替换课表后重新核对`);
            else seen.set(signature, index);
          });
          if (!t.entries.length && check.coverage !== "missing")
            verificationErrors.push("零课程方案须明确标记 missing，不能据此清空旧课表");
        }
        if (verificationErrors.length) throw Error(verificationErrors.join("\n") + "\n同轮复核事实已保留；amend_timetable 修正后可设置 reuse_verified_entries=true，只补交变化的复核值，仍须完整填写身份与覆盖检查。");
        person.checks = Object.fromEntries(
          args.checks.map(
            ({
              key,
              ...check
            }: {
              key: string;
            } & import("../../shared/agent-import/calendar").FieldChecks) => [
              key,
              check,
            ],
          ),
        );
        person.status = "done";
        return { result: { complete: true } };
      }
      case "revise_person": {
        const p = session.people[args.key];
        if (!p) throw Error("人员对象不存在");
        for (const path of args.sources ?? [])
          if (!files.some((f) => f.path === path))
            throw Error("对照来源不存在");
        if (reviewer) {
          const groups = this.reviewGroups(reviewer);
          if (!groups.some((group) => group.variants.some((v) =>
            Object.keys(p.timetables).some((key) => v.timetable_id === p.id + ":" + key))))
            throw Error("只能对本批核对涉及的人员提出返工");
          // Validate indices without changing the person while other readers are active.
          revisionAgent(p, p.sources, args.recheck_entries);
          reviewer.revisions.push(args);
          return { result: { deferred: p.key, reason: "全部并行核对结束后合并返工" } };
        }
        const sources = [...new Set([...p.sources, ...(args.sources ?? [])])];
        const nextAgent = revisionAgent(p, sources, args.recheck_entries);
        p.sources = sources;
        p.instruction = args.instruction;
        // Existing tables go straight to a fresh independent source check.
        // Verification tools can amend/rewrite them without a redundant extraction pass.
        p.status = Object.keys(p.timetables).length ? "verifying" : "queued";
        p.agent = nextAgent;
        p.checks = {};
        p.version++;
        session.phase = "people";
        return { result: { queued: p.key } };
      }
      case "review_consistency":
      case "finish_import": {
        if (call.name === "finish_import" && agent.pending.length !== 1) throw Error("交付必须为最后一个调用");
        if (Object.values(session.people).some((p) => p.status !== "done"))
          throw Error("人员对象尚未完成");
        if (!reviewer) projectPeople(job);
        const conflicts = courseConflicts(
          Object.values(job.timetables ?? {}).filter(
            (t) => !job.excluded.includes(t.person.id),
          ),
        );
        const submitted = call.name === "review_consistency" ? args.reviews : args.consistency_review;
        if (new Set(submitted.map((r: { key: string }) => r.key)).size !== submitted.length)
          throw Error("同一批核对不能重复 key");
        if (reviewer) this.reviewGroups(reviewer);
        const updates: NonNullable<typeof session.consistencyCheckpoints> = {};
        for (let review of submitted) {
          if (reviewer && !reviewer.keys.includes(review.key))
            throw Error("不能保存本批范围外的核对结论");
          const group = conflicts.find((g) => g.key === review.key);
          if (!group) throw Error("核对项已不属于当前差异：" + review.key);
          review = validateCheckedVariants(group, review);
          if (review.resolution === "different_context") {
            const paths = [
              ...new Set(
                group.variants.flatMap((v) => v.sources.map((s) => s.source)),
              ),
            ].filter((p) => files.some((f) => f.path === p));
            if ((await this.sourcesRead(agent, paths)).length)
              throw Error("任课差异结论须回看来源：" + group.key);
          }
          updates[group.key] = { signature: canonical(group), review };
        }
        // Merge after asynchronous source checks, so concurrent readers cannot overwrite peers.
        const checkpoints = { ...session.consistencyCheckpoints, ...updates };
        session.consistencyCheckpoints = checkpoints;
        const reviews = retainedConsistencyReviews(conflicts, checkpoints);
        if (call.name === "review_consistency")
          return { result: { checked: reviews.length, remaining: conflicts.length - reviews.length } };
        validateConsistencyReview(conflicts, reviews);
        job.importCheck = {
          signature: importSignature(job),
          consistency_review: reviews,
          calendar_review: "公共日历证据已协调；缺项保留",
          identity_review: "按 A 匹配现有人员，冲突保留",
          unresolved: args.unresolved,
        };
        const checked = await checkJob(job);
        if (checked.unread.length) throw Error("尚有未处理材料");
        job.unresolved = [
          ...new Set([
            ...args.unresolved,
            ...session.issues,
            ...Object.values(session.people).flatMap((p) =>
              [
                ...p.unresolved,
                ...Object.values(p.timetables).flatMap((t) => t.unresolved),
              ].map((x) => p.label + "：" + x),
            ),
            ...Object.values(job.calendars ?? {}).flatMap((c) =>
              [...calendarMissing(c), ...c.unresolved].map(
                (x) => c.name + "：" + x,
              ),
            ),
            ...reviews
              .filter((r: any) => r.resolution === "unresolved")
              .map((r: any) => r.key + "：" + r.explanation),
            ...checked.issues.map((i) => i.message),
            ...checked.warnings,
            ...checked.blocked.map((f) => f.path + "：" + f.reason),
          ]),
        ];
        job.status = "review";
        session.phase = "review";
        job.summary = reviewSummary(job);
        return {
          result: {
            readyForReview: true,
            readyToApply: !checked.issues.length,
          },
        };
      }
    }
    throw Error("工具未实现");
  }
  private reviewGroups(reviewer: ConsistencyWorkspace) {
    const groups = courseConflicts(Object.values(this.job.timetables ?? {})
      .filter((table) => !this.job.excluded.includes(table.person.id)))
      .filter((group) => reviewer.keys.includes(group.key));
    if (canonical(groups) !== reviewer.signature)
      throw Error("核对快照已变化，须重新分派");
    return groups;
  }
  private async context(person?: PersonWorkspace, reviewer?: ConsistencyWorkspace) {
    const job = this.job;
    if (reviewer) {
      const groups = this.reviewGroups(reviewer);
      const reviewed = retainedConsistencyReviews(groups, job.session!.consistencyCheckpoints);
      const pending = groups.filter((group) => !reviewed.some((review) => review.key === group.key));
      return JSON.stringify({
        reviewBatch: reviewer.id,
        conflicts: pending.map((group) => ({ ...group,
          variants: group.variants.map((variant, index) => ({ ...variant, index })),
        })),
        remainingConflictCount: pending.length,
        people: Object.values(job.session!.people).flatMap((person) => {
          const tables = Object.values(person.timetables).filter((table) => groups.some((group) =>
            group.variants.some((v) => v.timetable_id === person.id + ":" + table.key)));
          return tables.length ? [{ key: person.key, label: person.label, sources: person.sources,
            tables: tables.map((table) => ({ id: person.id + ":" + table.key, key: table.key })),
          }] : [];
        }),
        materialIssues: Object.values(job.session!.people).flatMap((person) => {
          const issues = [...person.unresolved, ...Object.values(person.timetables).flatMap((table) => table.unresolved)];
          return issues.length ? [{ person: person.label, sources: person.sources, issues }] : [];
        }),
        feedback: job.notes["最近操作员意见"],
      });
    }
    if (person)
      return JSON.stringify({
        person: {
          key: person.key,
          label: person.label,
          information:
            person.status === "verifying" && person.information
              ? { ...person.information, student_no: undefined }
              : person.information,
          timetables:
            person.status === "verifying"
              ? Object.fromEntries(
                  Object.entries(person.timetables).map(([key, table]) => [
                    key,
                    {
                      ...table,
                      reusable_verified_indices: person.agent.verifiedEntries?.[key]?.map((entry) => entry.index),
                      entries: table.entries.map((entry, index) => ({
                        index,
                        name: entry.name,
                      })),
                    },
                  ]),
                )
              : person.timetables,
          sources: person.sources,
          instruction: person.instruction,
          unresolved: person.unresolved,
        },
        calendars: job.calendars ?? {},
        feedback: job.notes["最近操作员意见"],
      });
    const conflicts = courseConflicts(Object.values(job.timetables ?? {}).filter(
      (t) => !job.excluded.includes(t.person.id),
    ));
    const reviewed = retainedConsistencyReviews(conflicts, job.session!.consistencyCheckpoints);
    const pending = conflicts.filter((g) => !reviewed.some((r) => r.key === g.key));
    return JSON.stringify({
      materials: (await materials(job.id)).map((f) => ({
        path: f.path,
        status: f.status,
        reason: f.reason,
      })),
      organizations: [...job.base.organization, ...job.session!.organizations],
      existingCalendars: {
        terms: job.base.term,
        profiles: job.base.timetable_profile,
      },
      calendars: job.calendars ?? {},
      people: Object.values(job.session!.people).map((p) => ({
        key: p.key,
        label: p.label,
        sources: p.sources,
        information: p.information,
        status: p.status,
        match: p.match,
        calendarEvidence: p.calendarEvidence,
        tables: Object.values(p.timetables).map((t) => ({
          id: p.id + ":" + t.key,
          key: t.key,
          calendar_id: t.calendar_id,
          courses: t.entries.length,
          unresolved: t.unresolved,
        })),
      })),
      conflicts: consistencyBatch(pending).map((group) => ({
        ...group, variants: group.variants.map((variant, index) => ({ ...variant, index })),
      })),
      remainingConflictCount: pending.length,
      completedConsistencyKeys: reviewed.map((r) => r.key),
      issues: job.session!.issues,
      feedback: job.notes["最近操作员意见"],
    });
  }
  private async request(
    agent: AgentState,
    mode: AgentMode,
    person?: PersonWorkspace,
    reviewer?: ConsistencyWorkspace,
  ): Promise<Reply> {
    let networkRetries = 0,
      modelRetries = 0;
    for (;;) {
      try {
        return await api.post<Reply>(
          `/agent-imports/${this.job.id}/turn`,
          {
            mode,
            messages: await fitImagePayload(agent.messages),
            context: await this.context(person, reviewer),
            preferredProvider: this.job.preferredProvider,
            cooldowns: this.job.cooldowns,
          },
          { timeoutMs: 130000 },
        );
      } catch (error) {
        const metrics =
          error instanceof ApiError
            ? (error.details as { metrics?: TurnMetrics })?.metrics
            : undefined;
        if (metrics) this.recordMetrics(metrics, reviewer?.id ?? person?.key ?? "coordinator");
        const attempts = metrics?.attempts ?? [];
        const quota =
          attempts.length &&
          attempts.every(
            (a) =>
              a.code === "quota_exhausted" || (a.retryAfterMs ?? 0) > 30000,
          );
        const network =
          error instanceof ApiError &&
          (error.status === 0 ||
            attempts.some((a) => a.code === "network_error"));
        const transient =
          error instanceof ApiError &&
          [0, 429, 502, 503, 504].includes(error.status);
        if (
          this.stopped ||
          quota ||
          !transient ||
          (network ? networkRetries++ >= 3 : modelRetries++ >= 1)
        )
          throw error;
        agent.messages.push({
          role: "user",
          content:
            "上一请求未返回有效结果，未执行写入。继续当前对象，长课表分段保存；无需重复已有成果。",
        });
        await this.persist();
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(
              network ? 2000 * 2 ** (networkRetries - 1) : 2000,
              ...attempts.map((a) => Math.min(a.retryAfterMs ?? 0, 30000)),
            ),
          ),
        );
        if (this.stopped) throw Error("已暂停，进度保留");
      }
    }
  }
  private recordMetrics(metrics: TurnMetrics, actorId: string) {
    (this.job.metrics ??= []).push({ ...metrics, actorId });
    if (this.job.metrics.length > 200)
      this.job.metrics.splice(0, this.job.metrics.length - 200);
  }
  private async actor(person?: PersonWorkspace, reviewer?: ConsistencyWorkspace) {
    const job = this.job,
      session = job.session!;
    let agent = reviewer?.agent ?? person?.agent ?? session.coordinator;
    if (person?.status === "queued") person.status = "extracting";
    if (person?.status === "failed")
      person.status = person.resumeStatus ?? "extracting";
    agent.error = undefined;
    agent.retryableFailure = false;
    agent.failures = 0;
    const initialTurns = agent.turns;
    try {
      while (!this.stopped && job.status === "running") {
        if (reviewer && !agent.pending.length && (reviewer.revisions.length ||
            retainedConsistencyReviews(this.reviewGroups(reviewer), session.consistencyCheckpoints).length === reviewer.keys.length)) {
          reviewer.done = true;
          // Completed readers need conclusions and tool records, not duplicate image bytes.
          agent.messages = withoutImages(agent.messages);
          agent.pendingImages = [];
          await this.persist();
          break;
        }
        if (
          person?.status === "done" ||
          (!person && ["people", "review"].includes(session.phase))
        )
          break;
        const mode: AgentMode = reviewer ? "consistency" : person
          ? person.status === "verifying"
            ? "verify"
            : "person"
          : session.phase === "discover"
            ? "discover"
            : "reconcile";
        if (!agent.messages.length) {
          agent.messages.push({
            role: "user",
            content: person
              ? "完成当前人员对象。当前成果见工作状态；现在" +
                (mode === "verify"
                  ? "独立回看全部原件并逐字段复核。"
                  : "提取 A/B，保留未知事实。")
              : "按当前状态完成材料分派或公共事实协调。",
          });
          if (person)
            await this.preloadSources(agent, [...person.sources], mode, person);
          else if (mode === "discover") await this.preloadDiscovery(agent);
          await this.persist();
        }
        if (!agent.pending.length) {
          if (mode === "reconcile" || mode === "consistency") {
            const conflicts = courseConflicts(Object.values(job.timetables ?? {})
              .filter((table) => !job.excluded.includes(table.person.id)));
            const reviewed = retainedConsistencyReviews(conflicts, session.consistencyCheckpoints);
            const current = reviewer ? this.reviewGroups(reviewer) :
              consistencyBatch(conflicts.filter((group) => !reviewed.some((r) => r.key === group.key)));
            const paths = [...new Set(current.flatMap((group) =>
              group.variants.flatMap((variant) => variant.sources.map((source) => source.source))))];
            // Prepare the same source evidence required by review_consistency without a model round trip.
            // Partial PDF/sheet reads still require the model to request remaining pages/ranges.
            const scope = canonical(current.map((group) => group.key));
            if (agent.reconcileImageScope !== scope) {
              const scoped = scopeSourceImages(agent.messages, paths);
              agent.messages = scoped.messages;
              agent.evictedImageSources = [...new Set([...(agent.evictedImageSources ?? []), ...scoped.evicted])];
              agent.reconcileImageScope = scope;
            }
            const unread = paths.filter((path) => !agent.coverage[path] || agent.evictedImageSources?.includes(path));
            if (unread.length) {
              await this.preloadSources(agent, unread, mode, undefined, reviewer?.id);
              await this.persist();
            }
            if (this.stopped) break;
          }
          if (agent.turns - initialTurns >= (person ? 32 : 60))
            throw Error("达到当前对象调用预算，已保存进度，请检查后继续");
          // Bound active context without throwing away unrecorded evidence or tool pairs.
          if (JSON.stringify(withoutImages(agent.messages)).length > 180000)
            throw Error("当前对象上下文过大，成果已保存，请缩小分派范围");
          job.phase = person
            ? "并行处理人员与逐人复核"
            : mode === "discover"
              ? "识别人员与公共日历"
              : "协调公共日历与跨人差异";
          job.requestStartedAt = Date.now();
          this.update({ ...job });
          const reply = await this.request(agent, mode, person, reviewer);
          if (reply.metrics)
            this.recordMetrics(reply.metrics, reviewer?.id ?? person?.key ?? "coordinator");
          job.preferredProvider = reply.providerId;
          job.model = reply.model;
          agent.turns++;
          job.turns++;
          if (!reply.calls?.length) throw Error("模型未返回工具调用");
          if (new Set(reply.calls.map((c) => c.id)).size !== reply.calls.length)
            throw Error("模型返回重复调用编号");
          agent.messages.push(...reply.messages);
          // These two operations share the current completed snapshot. Checkpoint
          // before queuing revisions; later fact changes invalidate its signature.
          agent.pending = ["reconcile", "consistency"].includes(mode) && reply.calls.every((call) =>
            ["review_consistency", "revise_person"].includes(call.name))
            ? [...reply.calls].sort((a, b) => Number(a.name === "revise_person") - Number(b.name === "revise_person"))
            : reply.calls;
          await this.persist();
          if (this.stopped) break;
        }
        while (agent.pending.length && !this.stopped) {
          const call = agent.pending[0];
          const started = Date.now();
          let value: { result: unknown; image?: string };
          try {
            value = await this.execute(agent, call, mode, person, reviewer);
            agent.failures = 0;
          } catch (e) {
            value = { result: { error: (e as Error).message } };
            agent.failures++;
          }
          agent.messages.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: call.id,
                toolName: call.name,
                output: { type: "json", value: value.result as any },
              },
            ],
          });
          if (value.image)
            agent.pendingImages.push({
              path: String((call.args as any)?.path ?? ""),
              image: value.image,
            });
          agent.pending.shift();
          // All tool results must precede user image messages in a parallel-call turn.
          if (!agent.pending.length) {
            for (const item of agent.pendingImages)
              this.appendImage(agent, item.path, item.image);
            agent.pendingImages = [];
          }
          await archive(
            job.id,
            `${reviewer?.id ?? person?.key ?? "coordinator"}:${agent.runId}:${agent.turns}:${call.id}`,
            "tool",
            {
              actor: reviewer?.id ?? person?.key ?? "coordinator",
              name: call.name,
              args: {
                ...(call.args as object),
                ...((call.args as any)?.password
                  ? { password: "[不保存密码]" }
                  : {}),
              },
              result: value.result,
              durationMs: Date.now() - started,
            },
          );
          this.log(
            `${reviewer?.id ?? person?.label ?? "协调器"} · ${call.name} · ${Date.now() - started} ms`,
          );
          if (person && ["done"].includes(person.status) && !agent.pending.length)
            agent.messages = withoutImages(agent.messages);
          // Switching extraction to verification starts a fresh context and fresh coverage.
          if (
            person?.status === "verifying" &&
            mode === "person" &&
            !agent.pending.length
          ) {
            const turns = agent.turns;
            person.agent = emptyAgent();
            agent = person.agent;
            agent.turns = turns;
          }
          await this.persist();
          if (agent.failures >= 6) throw Error("连续工具错误，当前对象已暂停");
        }
      }
    } catch (e) {
      agent.error = (e as Error).message;
      const attempts = e instanceof ApiError
        ? (e.details as { metrics?: TurnMetrics })?.metrics?.attempts ?? [] : [];
      agent.retryableFailure = e instanceof ApiError && (e.status === 0 ||
        (attempts.length > 0 && attempts.every((attempt) =>
          ["timeout", "network_error"].includes(attempt.code ?? ""))));
      if (person) {
        person.resumeStatus =
          person.status === "verifying" ? "verifying" : "extracting";
        person.status = "failed";
      } else if (!reviewer) throw e;
      this.log((reviewer?.id ?? person?.label ?? "协调器") + "：" + agent.error);
      await this.persist();
    }
  }
  private async runConsistency() {
    const job = this.job, session = job.session!;
    // Resume coordinator tool sequences before creating a new read-only wave.
    if (session.coordinator.pending.length) return false;
    projectPeople(job);
    const groups = courseConflicts(Object.values(job.timetables ?? {})
      .filter((table) => !job.excluded.includes(table.person.id)));
    const reviewed = retainedConsistencyReviews(groups, session.consistencyCheckpoints);
    const remaining = groups.filter((group) => !reviewed.some((review) => review.key === group.key));
    const workers = (session.consistencyWorkers ?? []).filter((worker) =>
      canonical(groups.filter((group) => worker.keys.includes(group.key))) === worker.signature &&
      (!worker.done || worker.revisions.length));
    if (!workers.length && remaining.length < 2) {
      delete session.consistencyWorkers;
      return false;
    }
    const assigned = new Set(workers.flatMap((worker) => worker.keys));
    let unassigned = remaining.filter((group) => !assigned.has(group.key));
    while (unassigned.length) {
      const batch = consistencyBatch(unassigned);
      workers.push({ id: "核对:" + crypto.randomUUID().slice(0, 8),
        keys: batch.map((group) => group.key), signature: canonical(batch),
        agent: emptyAgent(), revisions: [], done: false,
      });
      unassigned = unassigned.slice(batch.length);
    }
    session.consistencyWorkers = workers;
    await this.persist();
    const pending = workers.filter((worker) => !worker.done);
    let index = 0;
    // Readers only: queued revisions are applied after every in-flight reader drains.
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(4, session.concurrency, pending.length) }, async () => {
      while (!this.stopped && index < pending.length)
        await this.actor(undefined, pending[index++]);
    }));
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (this.stopped) return true;
    if (workers.some((worker) => !worker.done))
      throw Error("部分跨人核对失败，已完成结论及待返工意见已保存；继续时恢复未完成核对");
    for (const worker of workers) this.reviewGroups(worker);
    const revisions = mergeRevisionRequests(workers.flatMap((worker) => worker.revisions));
    for (const [index, args] of revisions.entries()) {
      const call = { id: "parallel-revision:" + index, name: "revise_person", args };
      const value = await this.execute(session.coordinator, call, "reconcile");
      await archive(job.id, "parallel-revision:" + crypto.randomUUID(), "tool", {
        actor: "coordinator", mode: "reconcile", name: call.name, args, result: value.result,
      });
      this.log(`合并返工 ${args.key}：${args.instruction}`);
    }
    delete session.consistencyWorkers;
    await this.persist();
    return revisions.length > 0;
  }
  private async runPeople() {
    const session = this.job.session!;
    const pending = Object.values(session.people).filter(
      (p) => p.status !== "done",
    );
    const queue = [...pending], retried = new Set<string>();
    let index = 0;
    await Promise.all(Array.from(
      { length: Math.min(session.concurrency, queue.length) },
      async () => {
        while (!this.stopped && index < queue.length) {
          const person = queue[index++];
          await this.actor(person);
          if (!this.stopped && person.status === "failed" && person.agent.retryableFailure && !retried.has(person.id)) {
            retried.add(person.id);
            // Keep extracted facts, but do not resubmit a repeatedly timed-out
            // conversation. Fresh source reads and verification are mandatory.
            const turns = person.agent.turns;
            person.agent = emptyAgent();
            person.agent.turns = turns;
            queue.push(person);
            this.log(`${person.label}：连接/超时失败，已加入队尾补跑（仅一次，重新读取来源）`);
            await this.persist();
          }
        }
      },
    ));
    if (this.stopped) return;
    if (pending.some((p) => p.status !== "done"))
      throw Error("部分人员处理失败，其他成果已保存；继续时只恢复未完成对象");
    // No concurrent writers now. Mark a shared file complete only after all owners finish.
    for (const file of await materials(this.job.id)) {
      const owners = Object.values(session.people).filter((p) =>
        p.sources.includes(file.path),
      );
      if (owners.length && owners.every((p) => p.status === "done"))
        await putMaterial(this.job.id, {
          ...file,
          status: "done",
          reason: "关联人员对象已完成来源复核",
        });
    }
    const handoffs = misplacedSourceRevisions(Object.values(session.people));
    for (const args of handoffs) {
      const call = { id: "source-handoff:" + crypto.randomUUID(), name: "revise_person", args };
      const value = await this.execute(session.coordinator, call, "reconcile");
      await archive(this.job.id, call.id, "tool", {
        actor: "coordinator", mode: "reconcile", name: call.name, args, result: value.result, automatic: true,
      });
      this.log(`补充错放来源 ${args.key}：重新独立复核`);
    }
    if (handoffs.length) { await this.persist(); return; }
    try {
      projectPeople(this.job);
    } catch (e) {
      session.issues = [(e as Error).message];
    }
    session.phase = "reconcile";
    // Keep coordinator evidence and completed tool results across revision waves.
    await this.persist();
  }
  async run() {
    if (this.busy || ["applied", "cancelled"].includes(this.job.status)) return;
    this.busy = true;
    this.stopped = false;
    const work = async () => {
      const job = this.job;
      if (!job.session)
        throw Error(
          "旧版批次原件和成果仍保留，仅供查看；请用原材料新建人员对象批次",
        );
      if (await alreadyApplied(job)) return;
      await rebase(job);
      job.status = "running";
      job.error = undefined;
      if (job.session.phase === "review") {
        job.session.phase = "reconcile";
        // Current context supplies edited facts; retain prior source evidence.
      }
      while (!this.stopped && job.status === "running") {
        if (job.session.phase === "people") await this.runPeople();
        else {
          const handedOff = job.session.phase === "reconcile" && await this.runConsistency();
          if (!this.stopped && !handedOff) await this.actor();
        }
      }
    };
    try {
      if (!navigator.locks)
        throw Error(
          "当前浏览器不支持导入任务锁，请使用支持 Web Locks 的浏览器",
        );
      await navigator.locks.request(
        "rota-import:" + this.job.id,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw Error("该批次正在其他标签页运行");
          const latest = await loadJob(this.job.id);
          if (latest) Object.assign(this.job, latest);
          try {
            await work();
          } catch (e) {
            this.job.error = (e as Error).message;
          } finally {
            if (this.job.status === "running") this.job.status = "paused";
            this.job.requestStartedAt = undefined;
            await this.persist();
          }
        },
      );
    } catch (e) {
      this.job.error = (e as Error).message;
      if (this.job.status === "running") this.job.status = "paused";
    } finally {
      this.busy = false;
      this.update({ ...this.job });
    }
  }
}
