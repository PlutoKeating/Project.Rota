import { afterEach, expect, it, vi } from "vitest";
import { fileStore } from "../src/worker/storage";
import type { Env } from "../src/worker/env";
afterEach(() => vi.unstubAllGlobals());
it("文件存储不转发重定向，路径正确编码，删除 404 幂等", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 201 })).mockResolvedValueOnce(new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetcher);
  const store = fileStore({ STORAGE_URL: "https://storage.example/files", STORAGE_AUTHORIZATION: "Basic test" } as Env);
  await store.put("imports/id/课表.csv", new ArrayBuffer(1), { httpMetadata: { contentType: "text/csv" } });
  expect(String(fetcher.mock.calls[0][0])).toBe("https://storage.example/files/imports/id/%E8%AF%BE%E8%A1%A8.csv");
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual", headers: { Authorization: "Basic test" } });
  await expect(store.delete("imports/id/课表.csv")).resolves.toBeUndefined();
});
it("未配置存储、明文连接和存储拒绝写入时不假报成功", async () => {
  await expect(fileStore({} as Env).delete("x")).rejects.toThrow("尚未配置");
  await expect(fileStore({ STORAGE_URL: "http://storage.example", STORAGE_AUTHORIZATION: "Basic test" } as Env).delete("x")).rejects.toThrow("HTTPS");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  await expect(fileStore({ STORAGE_URL: "https://storage.example", STORAGE_AUTHORIZATION: "Basic test" } as Env).delete("x")).rejects.toThrow("暂时不可用");
});

it("存储重定向不会转发凭据且返回明确错误", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.example" } }));
  vi.stubGlobal("fetch", fetcher);
  await expect(fileStore({ STORAGE_URL: "https://storage.example", STORAGE_AUTHORIZATION: "Basic test" } as Env).delete("x")).rejects.toThrow("暂时不可用");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
