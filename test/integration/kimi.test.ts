import { afterEach, expect, it, vi } from "vitest";
import ddl from "../../migrations/0001_init.sql?raw";
import { D1Stub, createKv } from "../helpers/d1";
import type { Env } from "../../src/worker/env";
import { resolveProvider, testProvider } from "../../src/worker/llm/gateway";
import { agentTurn } from "../../src/worker/llm/agent";

async function fixture(baseUrl = "https://api.kimi.com/coding/v1", model = "kimi-for-coding") {
  const db = new D1Stub(ddl);
  await db.prepare("INSERT INTO llm_provider(id,name,kind,base_url,model,api_key_secret,enabled,params) VALUES(?,?,?,?,?,?,?,?)")
    .bind("kimi", "Kimi", "openai_compatible", baseUrl, model, "KEY", 1, '{"vision":true}').run();
  return { DB: db, CONFIG: createKv(), KEY: "test-secret" } as unknown as Env;
}
afterEach(() => vi.unstubAllGlobals());

function upstream() {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const url = String(input), body = JSON.parse(String(init.body));
    calls.push({ url, body, headers: new Headers(init.headers) });
    // Observed from an actual Worker: China endpoint returns an HTML WAF block.
    if (new URL(url).hostname === "api.kimi.com")
      return new Response('<title>Attention Required! | Cloudflare</title>', { status: 403 });
    if (body.temperature != null && body.temperature !== 1)
      return Response.json({ error: { message: "invalid temperature: only 1 is allowed for this model" } }, { status: 400 });
    return Response.json({ id: "r", object: "chat.completion", created: 1, model: "kimi-for-coding", choices: [{ index: 0, message: body.tools ? { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "read_document", arguments: '{"path":"sample.txt"}' } }] } : { role: "assistant", content: "pong" }, finish_reason: body.tools ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }));
  return calls;
}
it("connection test uses Kimi overseas endpoint and its supported temperature for saved China configurations", async () => {
  const env = await fixture(), calls = upstream();
  expect(await testProvider(env, "kimi")).toEqual({ ok: true, message: "pong" });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://api.kimi.ai/coding/v1/chat/completions");
  expect(calls[0].body.temperature).toBe(1);
  expect(calls[0].headers.get("authorization")).toBe("Bearer test-secret");
  expect((await env.DB.prepare("SELECT base_url FROM llm_provider WHERE id='kimi'").first<any>())?.base_url).toBe("https://api.kimi.com/coding/v1");
});
it("real agent requests use the same Kimi endpoint without impersonating another client", async () => {
  const env = await fixture(), calls = upstream();
  await agentTurn(env, { mode: "discover", context: "{}", messages: [{ role: "user", content: "ping" }] }, "batch");
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://api.kimi.ai/coding/v1/chat/completions");
  expect(calls[0].body.tools.length).toBeGreaterThan(0);
  expect(calls[0].headers.get("user-agent") ?? "").not.toMatch(/claude|kimi-cli|opencode/i);
});
it.each([
  "https://api.kimi.com.example/coding/v1",
  "https://api.kimi.com/other/v1",
  "https://api.kimi.com:8443/coding/v1",
  "http://api.kimi.com/coding/v1",
  "https://api.moonshot.cn/v1",
  "https://api.kimi.ai/coding/v1",
  "https://api.kimi.com/coding/v1?custom=1",
  "https://api.kimi.com/coding/v1#custom",
])("does not rewrite other endpoints: %s", async (url) => {
  expect((await resolveProvider(await fixture(url), "kimi")).baseUrl).toBe(url);
});

it("does not force Kimi sampling settings on a custom provider using the same model name", async () => {
  const env = await fixture("https://custom.example/v1");
  const calls = upstream();
  await testProvider(env, "kimi");
  expect(calls[0].url).toBe("https://custom.example/v1/chat/completions");
  expect(calls[0].body.temperature).toBe(0);
});
it("preserves the Anthropic protocol and appends its version only once", async () => {
  const env = await fixture("https://api.kimi.com/coding/");
  await env.DB.prepare("UPDATE llm_provider SET kind='anthropic'").run();
  const fetcher = vi.fn(async (_input: string, _init: RequestInit) => Response.json({ content: [{ type: "text", text: "pong" }] }));
  vi.stubGlobal("fetch", fetcher);
  expect(await testProvider(env, "kimi")).toEqual({ ok: true, message: "pong" });
  expect(fetcher.mock.calls[0][0]).toBe("https://api.kimi.ai/coding/v1/messages");
});
