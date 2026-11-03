import { afterEach, expect, it, vi } from "vitest";
import ddl from "../../migrations/0001_init.sql?raw";
import app from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { complete, testProvider } from "../../src/worker/llm/gateway";
import { createKv, D1Stub } from "../helpers/d1";
async function fixture(baseUrl = "https://opencode.ai/zen/go/v1") {
  const env = {
    DB: new D1Stub(ddl) as unknown as D1Database,
    CONFIG: createKv() as unknown as KVNamespace,
    ASSETS: {} as Fetcher,
    APP_ENV: "test",
    AUTH_DEV_BYPASS: "true",
    OIDC_ISSUER: "https://id.example",
    OIDC_CLIENT_ID: "test",
    PROVIDER_ENCRYPTION_KEY: btoa("a".repeat(32)),
  } satisfies Env;
  const res = await app.request(
    "/api/admin/llm-providers",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "OpenCode Go",
        kind: "openai_compatible",
        baseUrl,
        model: "step-5-preview-free",
        apiKey: "test-key",
        params: { catalogId: "opencode-go" },
      }),
    },
    env,
  );
  const provider = (await res.json()) as { id: string };
  return { env, id: provider.id };
}
afterEach(() => vi.unstubAllGlobals());
it("connection test satisfies OpenCode session and client headers", async () => {
  const { env, id } = await fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      if (
        !h.get("x-opencode-session") ||
        h.get("user-agent") !== "Project.Rota/0.1.0"
      )
        return new Response(JSON.stringify({ type: "MissingSessionID" }), {
          status: 400,
        });
      return Response.json({ choices: [{ message: { content: "pong" } }] });
    }),
  );
  expect(await testProvider(env, id)).toEqual({ ok: true, message: "pong" });
});
it("keeps one supplied conversation id across retries, distinct ids for independent tests", async () => {
  const { env, id } = await fixture(
    "https://opencode.ai/inference/go/openai/v1",
  );
  const headers: Headers[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      headers.push(new Headers(init.headers));
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    }),
  );
  await complete(env, {
    providerId: id,
    messages: [{ role: "user", content: "ping" }],
    sessionId: "conversation-1",
  });
  await complete(env, {
    providerId: id,
    messages: [{ role: "user", content: "retry" }],
    sessionId: "conversation-1",
  });
  await testProvider(env, id);
  await testProvider(env, id);
  expect(headers[0].get("x-opencode-session")).toBe("conversation-1");
  expect(headers[1].get("x-opencode-session")).toBe("conversation-1");
  expect(headers[2].get("x-opencode-session")).toBeTruthy();
  expect(headers[2].get("x-opencode-session")).not.toBe(
    headers[3].get("x-opencode-session"),
  );
});
it("does not send OpenCode headers to another host even with copied catalog id", async () => {
  const { env, id } = await fixture("https://opencode.ai.example/v1");
  const fetcher = vi.fn(async () =>
    Response.json({ choices: [{ message: { content: "ok" } }] }),
  );
  vi.stubGlobal("fetch", fetcher);
  await testProvider(env, id);
  const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(new Headers(init.headers).has("x-opencode-session")).toBe(false);
});

it("reports the captured unavailable-model response without blaming the key or exposing upstream content", async () => {
  const { env, id } = await fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          error: {
            type: "server_error",
            message: "Upstream request failed: Model is unavailable.",
            debug: "Bearer test-key",
          },
        },
        { status: 400 },
      ),
    ),
  );
  const result = await testProvider(env, id);
  expect(result.ok).toBe(false);
  expect(result.message).toContain("step-5-preview-free");
  expect(result.message).toContain("当前服务端点不可用");
  expect(result.message).not.toContain("检查密钥");
  expect(result.message).not.toContain("test-key");
});
it("identifies missing sessions separately and never echoes arbitrary upstream errors", async () => {
  const { env, id } = await fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: { type: "MissingSessionID", message: "private test-key" } },
        { status: 400 },
      ),
    ),
  );
  expect((await testProvider(env, id)).message).toContain("会话标识");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: { message: "private test-key request rejected" } },
        { status: 400 },
      ),
    ),
  );
  const result = await testProvider(env, id);
  expect(result.message).toContain("请求参数或协议");
  expect(result.message).not.toContain("test-key");
});
it("reconciles Go choices with the provider list and fails closed without affecting other providers", async () => {
  const { env } = await fixture();
  const { catalog } = await import("../../src/worker/llm/catalog");
  const directory = {
    "opencode-go": {
      name: "OpenCode Go",
      npm: "@ai-sdk/openai-compatible",
      api: "https://opencode.ai/inference/go/openai/v1",
      models: {
        available: { id: "minimax-m3.1-flash" },
        unavailable: { id: "minimax-m3.1-flash-free" },
      },
    },
    other: { name: "Other", models: { a: { id: "a" } } },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(
        url.includes("models.dev")
          ? directory
          : { data: [{ id: "minimax-m3.1-flash" }] },
      ),
    ),
  );
  const result = await catalog(env);
  expect(
    result.providers
      .find((p) => p.id === "opencode-go")
      ?.models.map((m) => m.id),
  ).toEqual(["minimax-m3.1-flash"]);
  const fresh = { ...env, CONFIG: createKv() as unknown as KVNamespace };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("models.dev")) return Response.json(directory);
      throw Error("offline");
    }),
  );
  const failed = await catalog(fresh);
  expect(failed.providers.find((p) => p.id === "opencode-go")?.models).toEqual(
    [],
  );
  expect(failed.providers.find((p) => p.id === "other")?.models).toHaveLength(
    1,
  );
  expect(failed.error).toContain("OpenCode Go");
  const cached = await catalog(env, true);
  expect(
    cached.providers
      .find((p) => p.id === "opencode-go")
      ?.models.map((m) => m.id),
  ).toEqual(["minimax-m3.1-flash"]);
});

it("returns complete owner diagnostics with HTTP status, code and type while redacting credentials", async () => {
  const { env, id } = await fixture();
  const long = "model diagnostic ".repeat(80);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          error: {
            type: "invalid_request_error",
            code: 40001,
            message: long,
            api_key: "test-key",
            metadata: { authorization: "Bearer another-secret" },
          },
        },
        { status: 400 },
      ),
    ),
  );
  const result = await testProvider(env, id);
  expect(result.status).toBe(400);
  expect(result.code).toBe("40001");
  expect(result.type).toBe("invalid_request_error");
  expect(result.details).toContain(long);
  expect(result.details).not.toContain("test-key");
  expect(result.details).not.toContain("another-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          "Proxy error: " + long + " Authorization: Bearer test-key",
          { status: 502 },
        ),
    ),
  );
  const plain = await testProvider(env, id);
  expect(plain.status).toBe(502);
  expect(plain.details).toContain(long);
  expect(plain.details).not.toContain("test-key");
});

it("connection tests and image completion use explicitly configured Responses endpoints", async () => {
  const { env, id } = await fixture(
    "https://opencode.ai/inference/go/openai/v1",
  );
  const stored = await env.DB.prepare(
    "SELECT params FROM llm_provider WHERE id=?",
  )
    .bind(id)
    .first<{ params: string }>();
  await env.DB.prepare("UPDATE llm_provider SET params=? WHERE id=?")
    .bind(
      JSON.stringify({
        ...JSON.parse(stored!.params),
        api: "responses",
        vision: true,
      }),
      id,
    )
    .run();
  let sent: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      expect(String(url)).toBe(
        "https://opencode.ai/inference/go/openai/v1/responses",
      );
      sent = JSON.parse(init.body);
      return Response.json({
        output: [
          { type: "message", content: [{ type: "output_text", text: "pong" }] },
        ],
      });
    }),
  );
  expect(await testProvider(env, id)).toEqual({ ok: true, message: "pong" });
  expect(sent.store).toBe(false);
  await complete(env, {
    providerId: id,
    messages: [{ role: "user", content: "检查图片" }],
    images: [{ mime: "image/png", base64: "synthetic" }],
  });
  expect(sent.input[0].content[1]).toEqual({
    type: "input_image",
    image_url: "data:image/png;base64,synthetic",
  });
});
