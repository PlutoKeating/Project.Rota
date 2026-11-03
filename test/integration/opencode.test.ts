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
