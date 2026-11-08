import { afterEach, expect, it, vi } from "vitest";
import ddl from "../../migrations/0001_init.sql?raw";
import { D1Stub, createKv } from "../helpers/d1";
import type { Env } from "../../src/worker/env";
import { agentTurn } from "../../src/worker/llm/agent";

async function fixture(params = '{"vision":true}', baseUrl = "https://api.deepseek.com") {
  const db = new D1Stub(ddl);
  await db.prepare("INSERT INTO llm_provider(id,name,kind,base_url,model,api_key_secret,enabled,params) VALUES(?,?,?,?,?,?,?,?)")
    .bind("ds", "DeepSeek", "openai_compatible", baseUrl, "deepseek-flash", "KEY", 1, params).run();
  return { DB: db, CONFIG: createKv(), KEY: "test-secret" } as unknown as Env;
}
afterEach(() => vi.unstubAllGlobals());

/** Mirrors the documented DeepSeek thinking-mode validation. */
function upstream() {
  const bodies: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const thinking = body.thinking?.type !== "disabled" && body.reasoning_effort !== "none";
    const toolChoiceForced = body.tool_choice === "required" || typeof body.tool_choice === "object";
    const missingReasoning = body.messages.some((m: any) => m.role === "assistant" && m.tool_calls && !m.reasoning_content);
    if (thinking && (toolChoiceForced || missingReasoning))
      return Response.json({ error: { message: "invalid request", type: "invalid_request_error" } }, { status: 400 });
    return Response.json({ id: "r", object: "chat.completion", created: 1, model: "deepseek-flash", choices: [{ index: 0, message: { role: "assistant", content: null, reasoning_content: "think", tool_calls: [{ id: "call", type: "function", function: { name: "read_document", arguments: '{"path":"a.txt"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }));
  return bodies;
}

const history = [
  { role: "user", content: "ping" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "k1", toolName: "read_document", input: { path: "a.txt" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "k1", toolName: "read_document", output: { type: "json", value: { ok: true } } }] },
];

it("does not force tool_choice in DeepSeek thinking mode and backfills reasoning for foreign tool turns", async () => {
  const bodies = upstream();
  const reply = await agentTurn(await fixture(), { mode: "discover", context: "{}", messages: history }, "batch");
  expect(reply.calls[0].name).toBe("read_document");
  expect(bodies[0].tool_choice).toBe("auto");
  expect(bodies[0].messages.find((m: any) => m.role === "assistant").reasoning_content).toBeTruthy();
  // Returned history keeps DeepSeek's own reasoning for the next turn.
  expect(JSON.stringify(reply.messages)).toContain("think");
});

it("keeps required tool calls when thinking is explicitly disabled", async () => {
  const bodies = upstream();
  await agentTurn(await fixture('{"vision":true,"reasoning_effort":"none"}'), { mode: "discover", context: "{}", messages: [{ role: "user", content: "ping" }] }, "batch");
  expect(bodies[0].tool_choice).toBe("required");
  expect(bodies[0].reasoning_effort).toBe("none");
});

it("leaves other OpenAI-compatible hosts unchanged", async () => {
  const bodies: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ id: "r", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "read_document", arguments: '{"path":"a.txt"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }));
  await agentTurn(await fixture('{"vision":true}', "https://gateway.example/v1"), { mode: "discover", context: "{}", messages: history }, "batch");
  expect(bodies[0].tool_choice).toBe("required");
  expect(bodies[0].messages.find((m: any) => m.role === "assistant").reasoning_content).toBeUndefined();
});
