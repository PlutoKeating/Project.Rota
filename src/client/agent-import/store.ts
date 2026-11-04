import { openDB } from "idb";
import { emptyAgent } from "../../shared/agent-import/person-workspace";
import type { Job, Material } from "./state";
export type { Job, Material, PendingCall } from "./state";
export const RETENTION = 8 * 60 * 60 * 1000;
const dbPromise = openDB("rota-agent-import", 1, {
  upgrade(db) {
    db.createObjectStore("jobs", { keyPath: "id" });
    db.createObjectStore("files", { keyPath: ["jobId", "path"] }).createIndex(
      "jobId",
      "jobId",
    );
  },
});
// Separate database avoids a version-change lock held by an older open import tab.
const historyDb = openDB("rota-agent-history", 1, {
  upgrade(db) {
    const store = db.createObjectStore("events", { keyPath: ["jobId", "key"] });
    store.createIndex("jobId", "jobId");
    store.createIndex("jobAt", ["jobId", "at", "key"]);
  },
});
export async function archive(
  jobId: string,
  key: string,
  kind: string,
  data: unknown,
) {
  const db = await historyDb;
  const tx = db.transaction("events", "readwrite");
  if (!(await tx.store.get([jobId, key])))
    await tx.store.put({ jobId, key, kind, at: Date.now(), data });
  await tx.done;
}
export async function readHistory(jobId: string, offset = 0, key?: string) {
  const db = await historyDb;
  if (key) return db.get("events", [jobId, key]);
  const rows = [];
  let cursor = await db
    .transaction("events")
    .store.index("jobAt")
    .openCursor(
      IDBKeyRange.bound(
        [jobId, 0, ""],
        [jobId, Number.MAX_SAFE_INTEGER, "\uffff"],
      ),
    );
  if (cursor && offset) cursor = await cursor.advance(offset);
  while (cursor && rows.length < 10) {
    rows.push(cursor.value);
    cursor = await cursor.continue();
  }
  return rows;
}
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
  const history = await historyDb,
    historyTx = history.transaction("events", "readwrite");
  for (const key of await historyTx.store.index("jobId").getAllKeys(id))
    await historyTx.store.delete(key);
  await historyTx.done;
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
  return withJobLock(job, () => addFilesUnlocked(job, files));
}
async function addFilesUnlocked(job: Job, files: File[]) {
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
  job.importCheck = undefined;
  job.validatedRevision = -1;
  job.status = "paused";
  job.expiresAt = null;
  if (job.session) {
    job.session.phase = "discover";
    job.session.coordinator = emptyAgent();
  }
  job.notes["新材料"] = "有新上传材料，重新分派；已经完成的人员对象保留。";
  const db = await dbPromise;
  const tx = db.transaction(["jobs", "files"], "readwrite");
  for (const material of added)
    await tx.objectStore("files").put({ ...material, jobId: job.id });
  await tx.objectStore("jobs").put(structuredClone(job));
  await tx.done;
}

export async function loadJob(id: string): Promise<Job | undefined> {
  return (await dbPromise).get("jobs", id);
}
/** One writer across tabs for both agents and operator actions. */
export async function withJobLock<T>(
  job: Job,
  action: () => Promise<T>,
): Promise<T> {
  if (!job.session) throw Error("旧版批次保留只读，请用原材料创建新版批次");
  return navigator.locks.request(
    "rota-import:" + job.id,
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw Error("该批次正在其他标签页运行，请待处理结束后重新打开");
      const saved = await loadJob(job.id);
      if (
        saved &&
        (saved.revision !== job.revision ||
          saved.turns !== job.turns ||
          ["applied", "cancelled"].includes(saved.status))
      )
        throw Error("批次已发生变化，请重新打开后操作");
      return action();
    },
  );
}
