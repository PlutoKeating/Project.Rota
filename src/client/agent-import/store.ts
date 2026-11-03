import { openDB } from "idb";
import type { ModelMessage } from "ai";
import type { Evidence, Snapshot } from "../../shared/agent-import/model";
export const RETENTION = 8 * 60 * 60 * 1000;
export interface Material {
  path: string;
  blob: Blob;
  origin: string;
  inspected?: boolean;
  totalPages?: number;
  pagesRead?: number[];
  status?: "done" | "irrelevant" | "blocked";
  reason?: string;
}
export interface PendingCall {
  id: string;
  name: string;
  args: unknown;
}
export interface Job {
  id: string;
  owner: string;
  title: string;
  status: "paused" | "running" | "review" | "applied" | "cancelled";
  createdAt: number;
  expiresAt: number | null;
  base: Snapshot;
  draft: Snapshot;
  evidence: Record<string, Evidence[]>;
  notes: Record<string, string>;
  messages: ModelMessage[];
  pending: PendingCall[];
  images?: { path: string; data: string }[];
  log: { at: number; text: string }[];
  summary: string;
  unresolved: string[];
  revision: number;
  validatedRevision: number;
  turns: number;
  model: string;
  error?: string;
  excluded: string[];
}
const dbPromise = openDB("rota-agent-import", 1, {
  upgrade(db) {
    db.createObjectStore("jobs", { keyPath: "id" });
    db.createObjectStore("files", { keyPath: ["jobId", "path"] }).createIndex(
      "jobId",
      "jobId",
    );
  },
});
export async function saveJob(job: Job) {
  await (await dbPromise).put("jobs", structuredClone(job));
}
export async function listJobs(owner: string): Promise<Job[]> {
  await cleanup();
  return (await (await dbPromise).getAll("jobs"))
    .filter((j: Job) => j.owner === owner)
    .sort((a: Job, b: Job) => b.createdAt - a.createdAt);
}
export async function materials(jobId: string): Promise<Material[]> {
  return (await dbPromise).getAllFromIndex("files", "jobId", jobId);
}
export async function putMaterial(jobId: string, file: Material) {
  await (await dbPromise).put("files", { ...file, jobId });
}
export async function deleteJob(id: string) {
  const db = await dbPromise,
    tx = db.transaction(["jobs", "files"], "readwrite");
  for (const key of await tx.objectStore("files").index("jobId").getAllKeys(id))
    await tx.objectStore("files").delete(key);
  await tx.objectStore("jobs").delete(id);
  await tx.done;
}
export async function cleanup() {
  const db = await dbPromise;
  for (const job of (await db.getAll("jobs")) as Job[])
    if (job.expiresAt && job.expiresAt <= Date.now()) await deleteJob(job.id);
}
export async function addFiles(job: Job, files: File[]) {
  const existing = await materials(job.id);
  let size = existing.reduce((n, f) => n + f.blob.size, 0);
  if (files.reduce((n, f) => n + f.size, 0) > 100 * 1024 * 1024)
    throw Error("一次上传最多 100 MB");
  if (existing.length + files.length > 1000)
    throw Error("本批文件数量超过 1000");
  let index = 0;
  const added: Material[] = [];
  for (const f of files) {
    size += f.size;
    if (size > 600 * 1024 * 1024) throw Error("本批展开材料超过 600 MB");
    let path = f.webkitRelativePath || f.name;
    path = path.replace(/\\/g, "/");
    if (path.startsWith("/") || path.split("/").includes(".."))
      throw Error("文件路径不合法");
    while (existing.some((x) => x.path === path))
      path = `补充-${Date.now()}-${++index}/${f.name}`;
    const material = { path, blob: f, origin: "用户上传" };
    existing.push(material);
    added.push(material);
  }
  job.revision++;
  job.validatedRevision = -1;
  job.status = "paused";
  job.expiresAt = null;
  job.notes["新材料"] = "有新上传材料，请重新 tree 检查并处理。";
  const db = await dbPromise;
  const tx = db.transaction(["jobs", "files"], "readwrite");
  for (const material of added)
    await tx.objectStore("files").put({ ...material, jobId: job.id });
  await tx.objectStore("jobs").put(structuredClone(job));
  await tx.done;
}
