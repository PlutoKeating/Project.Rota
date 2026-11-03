import type { Env } from "./env";
import { HttpError } from "./lib/core";

/** Generic HTTPS object storage: PUT /<key>, DELETE /<key>. Credentials stay in Worker Secrets. */
export function fileStore(env: Env) {
  if (env.FILES) return env.FILES;
  async function request(method: string, key: string, body?: ArrayBuffer, contentType?: string) {
    if (!env.STORAGE_URL || !env.STORAGE_AUTHORIZATION) throw new HttpError(503, "unavailable", "文件存储尚未配置");
    const base = new URL(env.STORAGE_URL);
    if (base.protocol !== "https:") throw new HttpError(503, "unavailable", "文件存储必须使用 HTTPS");
    const url = new URL(base.href.replace(/\/$/, "") + "/" + key.split("/").map(encodeURIComponent).join("/"));
    let res: Response;
    try {
      // workerd only supports follow/manual; inspect redirects without forwarding credentials.
      res = await fetch(url, { method, body, redirect: "manual", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: env.STORAGE_AUTHORIZATION, "Content-Type": contentType ?? "application/octet-stream" } });
    } catch {
      throw new HttpError(502, "storage_error", "文件存储连接失败，请稍后重试");
    }
    if (!res.ok && !(method === "DELETE" && res.status === 404)) {
      await res.body?.cancel();
      throw new HttpError(502, "storage_error", "文件存储暂时不可用，请稍后重试");
    }
    await res.body?.cancel();
  }
  return {
    put(key: string, body: ArrayBuffer, options: { httpMetadata: { contentType: string } }) {
      return request("PUT", key, body, options.httpMetadata.contentType);
    },
    delete(key: string) { return request("DELETE", key); },
  };
}
