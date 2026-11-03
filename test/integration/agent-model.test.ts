import { afterEach, describe, it, expect, vi } from "vitest";
import ddl from "../../migrations/0001_init.sql?raw";
import { D1Stub, createKv } from "../helpers/d1";
import type { Env } from "../../src/worker/env";
import { agentTurn } from "../../src/worker/llm/agent";
afterEach(() => vi.unstubAllGlobals());
async function setup(kind: string, url: string) {
  const db = new D1Stub(ddl);
  await db
    .prepare(
      "INSERT INTO llm_provider(id,name,kind,base_url,model,api_key_secret,enabled,params) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(
      "model",
      "测试模型",
      kind,
      url,
      "test-model",
      "KEY",
      1,
      '{"vision":true}',
    )
    .run();
  return {
    DB: db as unknown as D1Database,
    CONFIG: createKv() as unknown as KVNamespace,
    KEY: "never-send-to-browser",
  } as unknown as Env;
}
describe("single-turn credential proxy", () => {
  it("returns genuine OpenAI tool calls, sends credentials only upstream, and replays tool results", async () => {
    const env = await setup("openai_compatible", "https://opencode.ai/zen/v1");
    let sent: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        sent = options;
        return new Response(
          JSON.stringify({
            id: "resp",
            object: "chat.completion",
            created: 1,
            model: "test-model",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "tree",
                        arguments: '{"prefix":"","offset":0}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    const result = await agentTurn(
      env,
      { messages: [{ role: "user", content: "整理材料" }], context: "{}" },
      "batch",
    );
    expect(result.calls).toEqual([
      { id: "call-1", name: "tree", args: { prefix: "", offset: 0 } },
    ]);
    expect(JSON.stringify(result)).not.toContain("never-send-to-browser");
    expect(sent.headers.authorization ?? sent.headers.Authorization).toBe(
      "Bearer never-send-to-browser",
    );
    expect(sent.headers["x-opencode-session"]).toBe("batch");
    expect(sent.redirect).toBe("manual");
    const body = JSON.parse(sent.body);
    expect(
      body.tools.some((t: any) => t.function.name === "change_record"),
    ).toBe(true);
    expect(body.messages[0].content).toContain("没有固定的解析流程");
    await agentTurn(
      env,
      {
        messages: [
          ...result.messages,
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "tree",
                output: { type: "json", value: { items: [] } },
              },
            ],
          },
        ],
        context: "{}",
      },
      "batch",
    );
    expect(
      JSON.parse(sent.body).messages.some((m: any) => m.role === "tool"),
    ).toBe(true);
  });
  it("uses the configured global order and fails over without exposing upstream errors", async () => {
    const env = await setup("openai_compatible", "https://first.example/v1");
    await env.DB.prepare(
      "INSERT INTO llm_provider(id,name,kind,base_url,model,api_key_secret,enabled,params) VALUES(?,?,?,?,?,?,?,?)",
    )
      .bind(
        "second",
        "备用",
        "openai_compatible",
        "https://second.example/v1",
        "second",
        "KEY",
        1,
        '{"vision":true}',
      )
      .run();
    await env.CONFIG.put("llm:order", '["model","second"]');
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        urls.push(String(url));
        if (String(url).includes("first.example"))
          return new Response(
            '{"error":{"message":"bad-key-never-send-to-browser"}}',
            { status: 400 },
          );
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "tool",
                      type: "function",
                      function: { name: "tree", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    const result = await agentTurn(
      env,
      { messages: [{ role: "user", content: "继续" }], context: "{}" },
      "batch",
    );
    expect(urls[0]).toContain("first.example");
    expect(urls.at(-1)).toContain("second.example");
    expect(result.calls[0].name).toBe("tree");
  });
});

describe("native provider tool protocols", () => {
  it.each([
    {
      kind: "anthropic",
      url: "https://anthropic.example",
      response: {
        id: "message",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [
          { type: "tool_use", id: "native-call", name: "tree", input: {} },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 4 },
      },
    },
    {
      kind: "google",
      url: "https://google.example",
      response: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "tree", args: {} } }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 4,
          totalTokenCount: 9,
        },
      },
    },
  ])("adapts $kind native tool calls", async ({ kind, url, response }) => {
    const env = await setup(kind, url);
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        fetched.push(String(input));
        return Response.json(response);
      }),
    );
    const result = await agentTurn(
      env,
      { messages: [{ role: "user", content: "检查材料" }], context: "{}" },
      "native",
    );
    expect(result.calls[0].name).toBe("tree");
    expect(JSON.stringify(result)).not.toContain("never-send-to-browser");
    expect(fetched[0]).toContain(kind === "google" ? "/v1beta/" : "/v1/");
  });
  it("adapts Workers AI binding tool calls without network fetch", async () => {
    const env = await setup("cloudflare_ai", "");
    const run = vi.fn(async () => ({
      response: "",
      tool_calls: [{ name: "tree", arguments: {} }],
    }));
    Object.assign(env, { AI: { run } });
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const result = await agentTurn(
      env,
      { messages: [{ role: "user", content: "检查" }], context: "{}" },
      "cf",
    );
    expect(result.calls[0].name).toBe("tree");
    expect(run).toHaveBeenCalledOnce();
    expect(network).not.toHaveBeenCalled();
  });
});
