import { createOpenAI } from "@ai-sdk/openai";
import { resolveProvider } from "./gateway";
import { HttpError } from "../lib/core";
import type { Env } from "../env";
import type { TurnMetrics } from "../../shared/agent-import/context";
import {
  createChatModel,
  orderCandidates,
  runTurn,
  TurnFailure,
  turnBodySchema,
} from "../../shared/agent-import/turn";

export class AgentTurnError extends HttpError {
  constructor(
    message: string,
    readonly metrics: TurnMetrics,
  ) {
    super(502, "llm_error", message);
  }
}

/** Server-held keys: candidates are the enabled vision/tool providers in global order. */
export async function agentTurn(
  env: Env,
  input: unknown,
  sessionId: string,
  // Aborts when the browser gives up, so no orphaned upstream call keeps billing.
  signal?: AbortSignal,
) {
  const body = turnBodySchema.parse(input);
  const rows = await env.DB.prepare(
    "SELECT id,params FROM llm_provider WHERE enabled=1 ORDER BY name,id",
  ).all<{ id: string; params: string | null }>();
  const order = JSON.parse(
    (await env.CONFIG.get("llm:order")) || "[]",
  ) as string[];
  const enabled = rows.results
    .filter((r) => {
      const p = JSON.parse(r.params || "{}");
      return p.vision !== false && p.toolCalling !== false;
    })
    .sort((a, b) => {
      const rank = (id: string) =>
        order.includes(id) ? order.indexOf(id) : order.length;
      return rank(a.id) - rank(b.id);
    });
  const candidates = orderCandidates(enabled, body).map((row) => ({
    id: row.id,
    async load() {
      const p = await resolveProvider(env, row.id, true);
      const url = new URL(p.baseUrl || "https://workers-ai.invalid/v1");
      const headers: Record<string, string> = {};
      if (
        url.hostname === "opencode.ai" &&
        /^\/(zen|inference)(\/|$)/.test(url.pathname)
      ) {
        headers["user-agent"] = "Project.Rota/0.1.0";
        headers["x-opencode-session"] = sessionId;
      }
      const guardedFetch: typeof fetch = (input, init) =>
        fetch(input, { ...init, redirect: "manual" });
      const bindingFetch: typeof fetch = async (_input, init) => {
        if (!env.AI) throw Error("Workers AI 未配置");
        const request = JSON.parse(String(init?.body));
        const value = (await env.AI.run(p.model, request)) as Record<
          string,
          any
        >;
        const calls = value.tool_calls?.map(
          (t: Record<string, any>, i: number) => ({
            id: t.id ?? "cf-" + crypto.randomUUID(),
            type: "function",
            function: {
              name: t.function?.name ?? t.name,
              arguments:
                typeof (t.function?.arguments ?? t.arguments) === "string"
                  ? (t.function?.arguments ?? t.arguments)
                  : JSON.stringify(t.function?.arguments ?? t.arguments ?? {}),
            },
          }),
        );
        return new Response(
          JSON.stringify(
            value.choices
              ? value
              : {
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        content: value.response ?? null,
                        tool_calls: calls,
                      },
                      finish_reason: calls?.length ? "tool_calls" : "stop",
                    },
                  ],
                },
          ),
          { headers: { "content-type": "application/json" } },
        );
      };
      const model =
        p.kind === "cloudflare_ai"
          ? createOpenAI({
              apiKey: "binding",
              baseURL: "https://workers-ai.invalid/v1",
              fetch: bindingFetch,
            }).chat(p.model)
          : createChatModel(p, { headers, fetch: guardedFetch });
      return { provider: p, model };
    },
  }));
  try {
    return await runTurn(body, candidates, signal);
  } catch (error) {
    if (error instanceof TurnFailure)
      throw new AgentTurnError(error.message, error.metrics);
    throw error;
  }
}
