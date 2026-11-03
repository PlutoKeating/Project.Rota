// Opt-in real-provider verification. Private archives and reports never enter Git.
// The actual browser runner and document tools execute; only business HTTP writes are isolated.
import "../../scripts/prepare-ocr.mjs";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
const [archivePath, outputPath, snapshotPath] = process.argv.slice(2);
if (!archivePath || !outputPath)
  throw Error(
    "Usage: node --env-file=.env.production test/live/agent-import.mjs ARCHIVE PRIVATE_OUTPUT [SNAPSHOT_JSON]",
  );
const port = Number(process.env.ROTA_LIVE_PORT ?? 5188);
const out = path.resolve(outputPath);
const testSession =
  "rota-live-" + createHash("sha256").update(out).digest("hex").slice(0, 32);
await fs.mkdir(out, { recursive: true, mode: 0o700 });
await fs.chmod(out, 0o700);
if (process.env.ROTA_CAPTURE_PROVIDER_RESPONSES === "1") {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (!response.ok && url.hostname === "opencode.ai") {
      let body = await response.clone().text();
      const headers = new Headers(init?.headers);
      for (const secret of [
        headers.get("authorization"),
        headers.get("authorization")?.replace(/^Bearer /i, ""),
        headers.get("x-api-key"),
        headers.get("x-goog-api-key"),
        url.searchParams.get("key"),
      ]) {
        if (secret) body = body.split(secret).join("[REDACTED]");
      }
      await fs.writeFile(
        path.join(out, `provider-error-${Date.now()}.json`),
        JSON.stringify({
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
          body,
        }),
        { mode: 0o600 },
      );
    }
    if (url.pathname.endsWith("/chat/completions")) {
      const value = await response
        .clone()
        .json()
        .catch(() => null);
      if (value?.choices)
        await fs.writeFile(
          path.join(out, `provider-${Date.now()}-${crypto.randomUUID()}.json`),
          JSON.stringify({
            model: value.model,
            choices: value.choices.map((c) => ({
              finish_reason: c.finish_reason,
              tool_calls: c.message?.tool_calls,
              content: c.message?.content,
            })),
          }),
          { mode: 0o600 },
        );
    }
    return response;
  };
}
const privateConfig = JSON.parse(
  await fs.readFile(
    process.env.ROTA_DATA_CONFIG ??
      path.join(os.homedir(), ".config/rota/storage.json"),
    "utf8",
  ),
);
const vite = await createServer({
  configFile: "test/browser/vite.config.ts",
  cacheDir: path.join(out, "vite-cache"),
  server: {
    port,
    strictPort: true,
    hmr: false,
    watch: { ignored: ["**/*"] },
  },
  optimizeDeps: {
    include: [
      "7z-wasm",
      "xlsx",
      "jszip",
      "mammoth",
      "@file-viewer/doc",
      "@file-viewer/ppt",
      "pdfjs-dist",
      "tesseract.js",
      "parse5",
      "html-to-image",
    ],
  },
});
await vite.listen();
let browser;
try {
  const { remoteData } = await vite.ssrLoadModule("/src/worker/remote-data.ts");
  const { agentTurn } = await vite.ssrLoadModule("/src/worker/llm/agent.ts");
  const { emptySnapshot } = await vite.ssrLoadModule(
    "/src/shared/agent-import/model.ts",
  );
  const env = {
    ...process.env,
    DATA_SERVICE_URL: privateConfig.STORAGE_URL,
    DATA_SERVICE_AUTHORIZATION: privateConfig.STORAGE_AUTHORIZATION,
  };
  Object.assign(env, remoteData(env));
  // Only model configuration reads are permitted by this test's server-side adapter.
  const remote = env.DB;
  env.DB = {
    prepare(sql) {
      if (!/^\s*select\b/i.test(sql))
        throw Error("Live verification forbids database mutations");
      return remote.prepare(sql);
    },
  };
  const config = env.CONFIG;
  env.CONFIG = {
    get: (key) => config.get(key),
    put: () => {
      throw Error("Live verification forbids configuration writes");
    },
  };
  // Optional isolated provider comparison; never changes stored provider configuration.
  if (process.env.ROTA_LIVE_MODEL) {
    const source = await env.DB.prepare(
      "SELECT * FROM llm_provider WHERE id = ?",
    )
      .bind(process.env.ROTA_LIVE_PROVIDER_ID)
      .first();
    if (!source) throw Error("Comparison source provider not found");
    const baseUrl = process.env.ROTA_LIVE_BASE_URL || source.base_url;
    if (new URL(baseUrl).origin !== new URL(source.base_url).origin)
      throw Error("Comparison must use the credential's existing origin");
    const provider = {
      ...source,
      name: "隔离对照",
      model: process.env.ROTA_LIVE_MODEL,
      kind: process.env.ROTA_LIVE_KIND || source.kind,
      base_url: baseUrl,
      params: JSON.stringify({
        ...JSON.parse(source.params || "{}"),
        ...JSON.parse(process.env.ROTA_LIVE_PARAMS || "{}"),
        vision: true,
        toolCalling: true,
      }),
    };
    env.DB = {
      prepare(sql) {
        if (!/^\s*select\b/i.test(sql) || !/\bfrom\s+llm_provider\b/i.test(sql))
          throw Error("Comparison permits provider reads only");
        const statement = {
          bind: () => statement,
          first: async (column) => (column ? provider[column] : provider),
          all: async () => ({ results: [provider] }),
        };
        return statement;
      },
    };
    env.CONFIG = {
      ...env.CONFIG,
      get: (key) =>
        key === "llm:order"
          ? Promise.resolve(JSON.stringify([provider.id]))
          : config.get(key),
    };
    console.log(
      JSON.stringify({ comparisonModel: provider.model, kind: provider.kind }),
    );
  }
  const snapshot = snapshotPath
    ? JSON.parse(await fs.readFile(snapshotPath, "utf8"))
    : emptySnapshot();
  browser = await chromium.launchPersistentContext(path.join(out, "browser"), {
    headless: true,
  });
  let requests = 0;
  await browser.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    let data = { status: "draft" };
    if (p.endsWith("/auth/me"))
      data = {
        authenticated: true,
        user: { id: "live-test", role: "owner", name: "隔离验收" },
      };
    else if (p.endsWith("/snapshot")) data = { data: snapshot };
    else if (p === "/api/agent-imports") data = { id: testSession };
    else if (p.endsWith("/turn")) {
      const n = ++requests,
        start = Date.now();
      console.log(JSON.stringify({ request: n, phase: "model-start" }));
      try {
        data = await agentTurn(
          env,
          route.request().postDataJSON(),
          testSession,
        );
        console.log(
          JSON.stringify({
            request: n,
            seconds: (Date.now() - start) / 1000,
            model: data.model,
            tools: data.calls.map((c) => c.name),
            outputTokens: data.metrics?.outputTokens,
            reasoningTokens: data.metrics?.reasoningTokens,
          }),
        );
      } catch (e) {
        console.log(
          JSON.stringify({
            request: n,
            error: e.code ?? e.name,
            message: e.message,
            seconds: (Date.now() - start) / 1000,
          }),
        );
        return route.fulfill({
          status: e.status ?? 502,
          json: {
            error: { code: e.code ?? "test_proxy", message: e.message },
            metrics: e.metrics,
          },
        });
      }
    } else if (p.endsWith("/apply") || p.endsWith("/cancel"))
      throw Error("Live test must never mutate the real batch");
    await route.fulfill({ json: data });
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/#/imports`);
  let progressWrites = Promise.resolve();
  await page.exposeFunction("saveLiveProgress", (job) => {
    job.images = job.images?.map(({ data, ...image }) => image);
    job.messages = job.messages.map((m) => ({
      ...m,
      content: Array.isArray(m.content)
        ? m.content.map((p) =>
            p.type === "image"
              ? { type: "text", text: "[图像保留在浏览器检查点]" }
              : p,
          )
        : m.content,
    }));
    const json = JSON.stringify(job);
    progressWrites = progressWrites.then(() =>
      fs.writeFile(path.join(out, "progress.json"), json),
    );
    return progressWrites;
  });
  const bytes = Array.from(await fs.readFile(archivePath));
  const start = Date.now();
  const result = await page.evaluate(
    async ({ bytes, name, maxMs }) => {
      const r = await import("/src/client/agent-import/runtime.ts"),
        s = await import("/src/client/agent-import/store.ts");
      const existing = (await s.listJobs("live-test"))[0];
      const job =
        existing ??
        (await r.createJob("live-test", [
          new File([new Uint8Array(bytes)], name),
        ]));
      const runner = new r.ImportRunner(job, (j) => {
        void window.saveLiveProgress(j);
      });
      const timer = setTimeout(() => runner.stop(), maxMs);
      try {
        await runner.run();
      } finally {
        clearTimeout(timer);
      }
      const history = [];
      for (let offset = 0; ; offset += 10) {
        const rows = await s.readHistory(job.id, offset);
        history.push(...rows);
        if (rows.length < 10) break;
      }
      const files = (await s.materials(job.id)).map(({ blob, ...f }) => ({
        ...f,
        size: blob.size,
      }));
      return { job, history, files, validation: await r.checkJob(job) };
    },
    {
      bytes,
      name: path.basename(archivePath),
      maxMs: Number(process.env.ROTA_LIVE_MAX_MS ?? 1200000),
    },
  );
  await progressWrites;
  result.elapsedMs = Date.now() - start;
  result.totalJobAgeMs = Date.now() - result.job.createdAt;
  await fs.writeFile(
    path.join(out, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      seconds: result.elapsedMs / 1000,
      totalJobSeconds: result.totalJobAgeMs / 1000,
      status: result.job.status,
      error: result.job.error,
      turns: result.job.turns,
      observations: Object.keys(result.job.observations ?? {}).length,
      people: result.job.draft.person.length,
      courses: result.job.draft.timetable_entry.length,
      preparedEntries: Object.values(result.job.timetables ?? {}).reduce(
        (n, p) => n + p.entries.length,
        0,
      ),
      reviewedPlans: Object.keys(result.job.timetableChecks ?? {}).length,
      issues: result.validation.issues.length,
      unread: result.validation.unread.length,
    }),
  );
  if (
    result.job.status !== "review" ||
    result.validation.issues.length ||
    result.validation.unread.length ||
    !result.job.draft.timetable_entry.length
  )
    process.exitCode = 1;
} finally {
  await browser?.close();
  await vite.close();
}
