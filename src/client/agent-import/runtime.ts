import { z } from "zod";
import type { ModelMessage } from "ai";
import { api } from "../lib/api";
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
function log(job: Job, text: string) {
  job.log.push({ at: Date.now(), text });
  if (job.log.length > 1000) job.log.splice(0, job.log.length - 1000);
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
    case "read_document":
    case "view_image":
      return documentTool(job, name, args as { path: string });
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
      if (job.validatedRevision !== job.revision)
        throw Error("请先调用 validate_draft 并修正结构错误");
      const checked = await checkJob(job);
      if (checked.unread.length)
        throw Error(
          "仍有未交代的文件：" + checked.unread.slice(0, 20).join("，"),
        );
      job.summary = args.summary;
      job.unresolved = [
        ...args.unresolved,
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
            job.messages.push({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: call.id,
                  toolName: call.name,
                  output: { type: "json", value: response.result as any },
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
              call.name + " · " + JSON.stringify(response.result).slice(0, 180),
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
          // A rolling context retains durable notes, the complete draft and evidence on disk.
          // Compaction occurs only at a tool-call boundary; no unmatched calls are discarded.
          if (
            job.messages.length > 80 ||
            JSON.stringify(job.messages).length > 12 * 1024 * 1024
          ) {
            job.messages = job.messages.slice(-12);
            while (
              job.messages.length &&
              (job.messages[0].role === "tool" ||
                job.messages[0].role === "assistant")
            )
              job.messages.shift();
            job.messages.unshift({
              role: "user",
              content:
                "继续整理；先前记录已持久保存，使用 tree/query_records 检查进度。",
            });
            log(job, "已整理上下文，草稿、来源和笔记完整保留。");
          }
          const context = JSON.stringify({
            title: job.title,
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
            unresolved: job.unresolved,
            operatorExcludedPersons: job.excluded,
          });
          const reply = await api.post<{
            messages: ModelMessage[];
            calls: PendingCall[];
            text: string;
            model: string;
          }>(`/agent-imports/${job.id}/turn`, {
            messages: job.messages,
            context,
          });
          job.messages.push(...reply.messages);
          job.pending = reply.calls;
          job.model = reply.model;
          job.turns++;
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
