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
  it.each(["checkpoint", "verify"])(
    "offers scoped tools in %s mode",
    async (mode) => {
      const env = await setup(
        "openai_compatible",
        "https://opencode.ai/zen/v1",
      );
      let sent: any;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, options) => {
          sent = JSON.parse(options.body);
          return new Response(
            JSON.stringify({
              id: "r",
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
                        id: "c",
                        type: "function",
                        function: { name: "read_timetables", arguments: "{}" },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }),
      );
      const result = await agentTurn(
        env,
        {
          messages: [{ role: "user", content: "保存成果" }],
          context: "{}",
          mode,
        },
        "batch",
      );
      const names = sent.tools.map((t: any) => t.function.name);
      expect(names).toContain("save_timetable");
      if (mode === "checkpoint") {
        expect(names).toContain("observe_material");
        expect(names).not.toContain("view_image");
        expect(names).not.toContain("ocr_image");
        expect(names).not.toContain("read_document");
      } else {
        expect(names).toContain("view_image");
        expect(names).toContain("confirm_timetable_check");
        expect(names).not.toContain("read_notes");
        expect(names).not.toContain("query_records");
      }
      expect(result.calls[0].name).toBe("read_timetables");
    },
  );
  it("returns genuine OpenAI tool calls, sends credentials only upstream, and replays tool results", async () => {
    const env = await setup("openai_compatible", "https://opencode.ai/zen/v1");
    await env.DB.prepare("UPDATE llm_provider SET model=?")
      .bind("minimax-m3.1-flash")
      .run();
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
                  reasoning_content: "synthetic-provider-continuation",
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
    expect(
      result.messages.some(
        (m) =>
          m.role === "assistant" &&
          Array.isArray(m.content) &&
          m.content.some((p) => p.type === "reasoning"),
      ),
    ).toBe(true);
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
    expect(body.reasoning_effort).toBe("medium");
    expect(
      body.tools.some((t: any) => t.function.name === "save_timetable"),
    ).toBe(true);
    expect(
      body.tools.some((t: any) => t.function.name === "change_record"),
    ).toBe(true);
    expect(body.tools.some((t: any) => t.function.name === "confirm_timetable_check")).toBe(false);
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
      JSON.parse(sent.body).messages.find((m: any) => m.role === "assistant")
        ?.reasoning_content,
    ).toBe("synthetic-provider-continuation");
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
    expect(result.metrics.attempts.map((a) => a.status)).toEqual([
      "error",
      "ok",
    ]);
    expect(result.model).toContain("second");
    expect(JSON.stringify(result)).not.toContain("bad-key");
    urls.length = 0;
    await agentTurn(
      env,
      {
        messages: [{ role: "user", content: "继续" }],
        context: "{}",
        preferredProvider: result.providerId,
      },
      "batch",
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("second.example");
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

describe("handoff and diagnostic boundaries", () => {
  it("offers only the handoff tool during compaction", async () => {
    const env = await setup("openai_compatible", "https://model.example/v1");
    let sent: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        sent = JSON.parse(options.body);
        return Response.json({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "h",
                    type: "function",
                    function: {
                      name: "save_handoff",
                      arguments: JSON.stringify({
                        summary: "已保存明确事实与来源，尚未确定学期首周日期。",
                        nextSteps: ["读取下一个人的材料"],
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      }),
    );
    const result = await agentTurn(
      env,
      {
        messages: [{ role: "user", content: "需要交接" }],
        context: "{}",
        mode: "compact",
      },
      "batch",
    );
    expect(sent.tools.map((t: any) => t.function.name)).toEqual([
      "save_handoff",
    ]);
    expect(result.calls[0].name).toBe("save_handoff");
    expect(result.metrics.purpose).toBe("compact");
    expect(result.metrics.requestId).toBeTruthy();
  });
  it("reports upstream status without leaking upstream body or retrying the same provider", async () => {
    const env = await setup("openai_compatible", "https://model.example/v1");
    const network = vi.fn(
      async () =>
        new Response('{"error":{"message":"secret-body"}}', { status: 503 }),
    );
    vi.stubGlobal("fetch", network);
    let error: any;
    try {
      await agentTurn(
        env,
        { messages: [{ role: "user", content: "继续" }], context: "{}" },
        "batch",
      );
    } catch (e) {
      error = e;
    }
    expect(network).toHaveBeenCalledOnce();
    expect(error.metrics.attempts[0]).toMatchObject({
      status: "error",
      httpStatus: 503,
      code: "upstream_http",
    });
    expect(error.message).not.toContain("secret-body");
    expect(error.message).not.toContain("数据库");
    expect(error.message).toContain(error.metrics.requestId);
  });
});

it("rejects malformed provider tool calls before persisting them or reporting model success", async () => {
  const env = await setup("openai_compatible", "https://broken.example/v1");
  await env.DB.prepare(
    "INSERT INTO llm_provider(id,name,kind,base_url,model,api_key_secret,enabled,params) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(
      "fallback",
      "备用",
      "openai_compatible",
      "https://healthy.example/v1",
      "healthy",
      "KEY",
      1,
      '{"vision":true}',
    )
    .run();
  await env.CONFIG.put("llm:order", '["model","fallback"]');
  // Protocol shape captured from the real import: DSML fragments inside JSON arguments.
  // No private source content is stored in this regression fixture.
  const malformed =
    '{"path">材料.txt</parameter>\n<｜DSML｜: "材料.txt", "content": "事实"}';
  const fetcher = vi.fn(async (url) =>
    Response.json({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call",
                type: "function",
                function: String(url).includes("broken.example")
                  ? { name: "observe_material", arguments: malformed }
                  : { name: "tree", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const result = await agentTurn(
    env,
    { messages: [{ role: "user", content: "整理材料" }], context: "{}" },
    "protocol-repro",
  );
  expect(result.providerId).toBe("fallback");
  expect(result.calls).toEqual([
    { id: "call", name: "tree", args: { prefix: "", offset: 0 } },
  ]);
  expect(JSON.stringify(result.messages)).not.toContain("DSML");
  expect(result.metrics.attempts.map((a) => a.status)).toEqual(["error", "ok"]);
});

it.each([
  { mode: "work", name: "query_records", args: { entity: "departments" } },
  {
    mode: "verify",
    name: "note",
    args: { key: "x", text: "must not execute" },
  },
])(
  "returns actionable feedback for JSON-valid $name mistakes instead of discarding the model turn",
  async ({ mode, name, args }) => {
    const env = await setup("openai_compatible", "https://example.com/v1");
    const fetcher = vi.fn(async () =>
      Response.json({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "repair",
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await agentTurn(
      env,
      { messages: [{ role: "user", content: "整理" }], context: "{}", mode },
      "repair-test",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.calls[0]).toMatchObject({
      name,
      args,
      validationError: expect.any(String),
    });
    expect(result.messages.every((m) => m.role === "assistant")).toBe(true);
  },
);
