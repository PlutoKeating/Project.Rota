import {
  needsHandoff,
  withoutImages,
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
    harnessVersion: 2,
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
  for (let retry = 0; ; retry++) {
    const start = Date.now();
    try {
      return await api.post<T>(`/agent-imports/${job.id}/turn`, body, {
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
        purpose: (body as { mode: "work" | "compact" }).mode,
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
              a.code === "timeout" ||
              a.httpStatus === 429 ||
              (a.httpStatus ?? 0) >= 500,
          ));
      if (!transient || retry >= 1) throw e;
      log(
        job,
        "模型请求暂时失败，进度已保存；2 秒后重试一次。请求编号：" +
          metrics.requestId,
      );
      job.phase = "模型请求暂时失败，正在重试";
      await saveJob(job);
      update();
      await new Promise((resolve) => setTimeout(resolve, 2000));
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
  job.checkedRevision = job.revision;
  job.validatedRevision = issues.length ? -1 : job.revision;
  return {
    issues,
    unread: unread.map((f) => f.path),
    blocked: blocked.map((f) => ({ path: f.path, reason: f.reason })),
    changes: changes.length,
    files: files.length,
  };
}
async function execute(
  job: Job,
  call: PendingCall,
): Promise<{ result: unknown; image?: string }> {
  const name = call.name as ToolName;
  if (!(name in toolSpecs)) throw Error("未知工具");
  const args = toolSpecs[name].schema.parse(call.args) as Record<string, any>;
  switch (name) {
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
    case "view_image": {
      const unread = (job.unrecordedReads ??= []);
      if (unread.length >= 2 && !unread.includes(args.path))
        throw Error(
          "请先用 observe_material 保存刚才读取的材料识别成果：" +
            unread.join("，"),
        );
      const response = await documentTool(job, name, args as { path: string });
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
        content: args.content,
        unresolved: args.unresolved,
        updatedAt: Date.now(),
      };
      job.unrecordedReads = job.unrecordedReads?.filter((p) => p !== args.path);
      return { result: { saved: true, path: args.path } };
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
      return { result: z.toJSONSchema(schemas[args.entity as Entity]) };
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
        throw Error("请先用 observe_material 保存识别成果，避免交接时遗失");
      if (args.status === "done" && !f.inspected)
        throw Error("请先读取该材料再标记完成");
      if (
        args.status === "done" &&
        f.totalPages &&
        f.totalPages > (f.pagesRead?.length ?? 0)
      )
        throw Error(
          `此文件共 ${f.totalPages} 页，已读 ${f.pagesRead?.join(",")}，请检查余下页面或说明为何无法处理`,
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
      if (job.pending.length > 1)
        throw Error("请先完成本轮其他工具，再提交复核");
      if (job.checkedRevision !== job.revision)
        throw Error("请先调用 validate_draft 检查本次草稿");
      const checked = await checkJob(job);
      if (checked.unread.length)
        throw Error(
          "仍有未交代的文件：" + checked.unread.slice(0, 20).join("，"),
        );
      job.summary = args.summary;
      job.unresolved = [
        ...args.unresolved,
        ...checked.issues.map((x) => x.message),
        ...Object.entries(job.observations ?? {}).flatMap(([path, o]) =>
          o.unresolved.map((text) => path + "：" + text),
        ),
        ...checked.blocked.map((x) => x.path + "：" + x.reason),
      ];
      job.status = "review";
      return {
        result: {
          ready: true,
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
      try {
        if (!job.harnessVersion) {
          await archive(job.id, "legacy", "legacy", {
            messages: archiveMessages(job.messages),
            notes: job.notes,
            log: job.log,
          });
          job.harnessVersion = 2;
          job.messages.push({
            role: "user",
            content:
              "运行器已升级：现有草稿和笔记保留。优先检查已保存成果，不重建已有记录；此前未保存的识别信息需要重新核对。",
          });
          await saveJob(job);
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
            } catch (e) {
              failedSteps++;
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
              !["read_history", "read_observations"].includes(call.name)
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
            if (failedSteps >= 8)
              throw Error(
                "连续 8 次工具调用未成功，进度已保存；请检查处理记录后继续。",
              );
            if (job.pending.length === 0) await renewLease(job);
            continue;
          }
          const signature = canonical({
            revision: job.revision,
            observationRevision: job.observationRevision ?? 0,
            files: (await materials(job.id)).map((f) => [
              f.path,
              f.status,
              f.pagesRead,
            ]),
          });
          job.progress = advanceProgress(job.progress, signature);
          if (job.progress.idle >= 12)
            throw Error(
              "连续 12 轮没有新增识别成果、草稿或材料覆盖进展，已暂停以避免空转。现有成果已保留，可检查记录后继续。",
            );
          if (job.progress.idle === 6)
            job.messages.push({
              role: "user",
              content:
                "连续 6 轮没有持久进展。立即保存已读材料的 observe_material，或处理明确未完成项；遇到障碍请说明并交付可复核部分，停止重复查询。",
            });
          const context = JSON.stringify({
            title: job.title,
            observationPaths: Object.keys(job.observations ?? {}).slice(-20),
            observationCount: Object.keys(job.observations ?? {}).length,
            observationInstruction:
              "完整材料识别成果用 read_observations 分页查询",
            unrecordedReads: job.unrecordedReads ?? [],
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
          const compacting = needsHandoff(job.messages);
          job.phase = compacting ? "正在保存交接摘要" : "等待模型整理材料";
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
              mode: compacting ? "compact" : "work",
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
            const call = reply.calls.find((c) => c.name === "save_handoff");
            if (!call)
              throw Error(
                "模型未生成交接摘要，完整上下文已保留；继续处理将重试交接。",
              );
            const handoff = {
              ...toolSpecs.save_handoff.schema.parse(call.args),
              at: Date.now(),
            };
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
          job.messages = withoutImages(job.messages);
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
export async function editRecord(
  job: Job,
  entity: Entity,
  id: string,
  data: Record<string, unknown>,
) {
  mutate(job.draft, entity, "update", data, id);
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
  await api.post(`/agent-imports/${job.id}/apply`, {
    changes: changesFor(job),
    summary: job.summary,
  });
  job.status = "applied";
  job.expiresAt = Date.now() + RETENTION;
  await saveJob(job);
}
