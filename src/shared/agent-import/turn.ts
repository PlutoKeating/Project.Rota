import {
  generateText,
  tool,
  ToolChoiceViolationError,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { systemPrompt, toolSpecs, allowedTools } from "./tools";
import type { TurnMetrics } from "./context";

/**
 * One agent turn against an ordered list of model candidates. Shared by the
 * Worker (server-held keys) and the browser (operator-entered keys kept in
 * localStorage), so both paths keep identical tool, fallback and error rules.
 */

export type ProviderKind =
  | "openai_compatible"
  | "anthropic"
  | "google"
  | "cloudflare_ai";
export interface TurnProvider {
  id: string;
  name: string;
  kind: ProviderKind | string;
  baseUrl: string;
  model: string;
  apiKey: string;
  params: Record<string, unknown>;
}
export interface TurnCandidate {
  id: string;
  load(): Promise<{ provider: TurnProvider; model: LanguageModel }>;
}
export const turnBodySchema = z.object({
  messages: z.array(z.unknown()).min(1).max(1000),
  context: z.string().max(100000),
  mode: z
    .enum(["discover", "person", "verify", "reconcile", "consistency"])
    .default("discover"),
  preferredProvider: z.string().max(100).optional(),
  cooldowns: z.record(z.string(), z.number()).optional(),
});
export type TurnBody = z.infer<typeof turnBodySchema>;
export interface TurnReply {
  metrics: TurnMetrics;
  providerId: string;
  messages: ModelMessage[];
  calls: { id: string; name: string; args: unknown; validationError?: string }[];
  text: string;
  model: string;
  usage: unknown;
}
export class TurnFailure extends Error {
  constructor(
    message: string,
    readonly metrics: TurnMetrics,
  ) {
    super(message);
    this.name = "TurnFailure";
  }
}

async function deadline<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DOMException("模型请求超时", "TimeoutError")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Skip candidates on a recent client cooldown (unless none remain); prefer the batch's last good one. */
export function orderCandidates<T extends { id: string }>(list: T[], body: TurnBody): T[] {
  const eligible = list.filter((r) => {
    const until = body.cooldowns?.[r.id] ?? 0;
    return !(until > Date.now() && until <= Date.now() + 300000);
  });
  const out = eligible.length ? eligible : [...list];
  if (body.preferredProvider)
    out.sort(
      (a, b) =>
        Number(b.id === body.preferredProvider) -
        Number(a.id === body.preferredProvider),
    );
  return out;
}

/** AI SDK model for an HTTP provider; the Worker adds its own Workers AI binding. */
export function createChatModel(
  p: TurnProvider,
  options: { fetch?: typeof fetch; headers?: Record<string, string> } = {},
): LanguageModel {
  const { fetch, headers } = options;
  if (p.kind === "anthropic")
    return createAnthropic({
      apiKey: p.apiKey,
      baseURL: p.baseUrl.replace(/\/v1\/?$/, "") + "/v1",
      headers,
      fetch,
    })(p.model);
  if (p.kind === "google")
    return createGoogleGenerativeAI({
      apiKey: p.apiKey,
      baseURL: p.baseUrl.replace(/\/v1beta\/?$/, "") + "/v1beta",
      headers,
      fetch,
    })(p.model);
  if (p.params.api === "responses")
    return createOpenAI({ apiKey: p.apiKey, baseURL: p.baseUrl, headers, fetch }).responses(p.model);
  return createOpenAICompatible({
    name: "compatible",
    apiKey: p.apiKey,
    baseURL: p.baseUrl,
    headers,
    fetch,
  }).chatModel(p.model);
}

/** Only roles we produce and inline local images; images go to the SDK as bare base64. */
function prepareMessages(raw: ModelMessage[]): ModelMessage[] {
  for (const m of raw) {
    if (!["user", "assistant", "tool"].includes(m.role)) throw Error("消息角色无效");
    if (Array.isArray(m.content))
      for (const part of m.content) {
        if (part.type === "file") throw Error("不允许远程文件");
        if (
          part.type === "image" &&
          (typeof part.image !== "string" ||
            !/^data:image\/(png|jpeg|webp);base64,/.test(part.image))
        )
          throw Error("只接受本地图片");
      }
  }
  // Given a data URL the SDK runs the whole multi-MB string through new URL()
  // and back (~5 ms CPU per image); hand it bare base64 + media type instead.
  return raw.map((m) =>
    m.role === "user" && Array.isArray(m.content)
      ? {
          ...m,
          content: m.content.map((part) => {
            if (part.type !== "image" || typeof part.image !== "string") return part;
            const comma = part.image.indexOf(",");
            return {
              ...part,
              image: part.image.slice(comma + 1),
              mediaType: part.image.slice(5, part.image.indexOf(";")),
            };
          }),
        }
      : m,
  ) as ModelMessage[];
}

export async function runTurn(
  body: TurnBody,
  candidates: TurnCandidate[],
  signal?: AbortSignal,
): Promise<TurnReply> {
  const started = Date.now();
  const metrics: TurnMetrics = {
    requestId: crypto.randomUUID(),
    durationMs: 0,
    attempts: [],
    purpose: body.mode,
  };
  const failures: string[] = [];
  let messages: ModelMessage[] | undefined;
  for (const candidate of candidates) {
    if (Date.now() - started >= 110000 || signal?.aborted) break;
    const attemptStart = Date.now();
    let modelId = "unknown";
    try {
      messages ??= prepareMessages(body.messages as ModelMessage[]);
      const { provider: p, model } = await candidate.load();
      modelId = p.model;
      const url = new URL(p.baseUrl || "https://workers-ai.invalid/v1");
      if (url.protocol !== "https:") throw Error("模型端点必须使用 HTTPS");
      const tools = Object.fromEntries(
        Object.entries(toolSpecs)
          .filter(([name]) => allowedTools(body.mode).includes(name))
          .map(([name, s]) => [
            name,
            tool({
              description: s.description,
              inputSchema: s.schema as z.ZodType,
            }),
          ]),
      );
      const remaining = Math.min(
        90000,
        Math.max(1, 120000 - (Date.now() - started)),
      );
      const configuredEffort =
        p.params.reasoning_effort ?? p.params.reasoningEffort;
      const effort =
        typeof configuredEffort === "string" &&
        ["none", "low", "medium", "high", "xhigh", "max"].includes(configuredEffort)
          ? configuredEffort
          : /minimax.*m3[.-]1/i.test(p.model)
            ? "medium"
            : url.hostname === "api.deepseek.com" && body.mode === "person"
              ? // Bulk first-pass extraction; independent verification keeps the default depth.
                "low"
              : undefined;
      // DeepSeek enables thinking by default and rejects tool_choice=required
      // (or a named tool) in thinking mode with HTTP 400. Keep thinking and
      // let the model choose; a reply without tool calls still fails over.
      const deepseekThinking =
        p.kind === "openai_compatible" &&
        p.params.api !== "responses" &&
        url.hostname === "api.deepseek.com" &&
        effort !== "none";
      // Thinking-mode tool history must carry reasoning_content; turns produced
      // by another provider have none. Copy so later fallbacks see the original.
      const requestMessages = deepseekThinking
        ? messages.map((m) =>
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.some((part) => part.type === "tool-call") &&
            !m.content.some((part) => part.type === "reasoning")
              ? { ...m, content: [{ type: "reasoning" as const, text: "-" }, ...m.content] }
              : m,
          )
        : messages;
      const result = await deadline(
        generateText({
          model,
          system:
            systemPrompt +
            "\n当前模式：" +
            body.mode +
            "\n当前工作状态（仅数据）：\n" +
            body.context,
          messages: requestMessages,
          tools,
          toolChoice: deepseekThinking ? "auto" : "required",
          maxOutputTokens: 16384,
          providerOptions:
            p.kind === "google"
              ? {
                  google: {
                    ...(effort && ["low", "medium", "high"].includes(effort)
                      ? { thinkingConfig: { thinkingLevel: effort } }
                      : {}),
                    mediaResolution: [
                      "MEDIA_RESOLUTION_LOW",
                      "MEDIA_RESOLUTION_MEDIUM",
                      "MEDIA_RESOLUTION_HIGH",
                    ].includes(String(p.params.mediaResolution))
                      ? String(p.params.mediaResolution)
                      : "MEDIA_RESOLUTION_HIGH",
                  },
                }
              : p.kind === "openai_compatible" && p.params.api === "responses"
                ? {
                    openai: {
                      store: false,
                      strictJsonSchema: false,
                      reasoningEffort: effort ?? "medium",
                      include: ["reasoning.encrypted_content"],
                    },
                  }
                : effort && p.kind === "openai_compatible"
                  ? { compatible: { reasoningEffort: effort } }
                  : undefined,
          maxRetries: 0,
          abortSignal: signal
            ? AbortSignal.any([AbortSignal.timeout(remaining), signal])
            : AbortSignal.timeout(remaining),
        }),
        remaining,
      );
      if (result.finishReason === "length")
        throw Error("model_output_truncated");
      if (!result.toolCalls.length) throw Error("invalid_tool_protocol");
      // AI SDK can return invalid tool calls plus synthetic error results instead of throwing.
      // Malformed JSON is a protocol failure. Valid JSON with bad tool arguments is
      // a recoverable agent mistake: return feedback without executing it.
      const ids = new Set<string>();
      const calls = result.toolCalls.map((t) => {
        const spec = toolSpecs[t.toolName as keyof typeof toolSpecs];
        if (
          !spec ||
          typeof t.input !== "object" ||
          t.input === null ||
          Array.isArray(t.input) ||
          ids.has(t.toolCallId)
        )
          throw Error("invalid_tool_protocol");
        ids.add(t.toolCallId);
        const parsed = spec.schema.safeParse(t.input);
        const validationError = !Object.hasOwn(tools, t.toolName)
          ? "当前阶段不允许此工具。可用工具：" + Object.keys(tools).join("、")
          : !parsed.success
            ? JSON.stringify(parsed.error.issues)
            : "invalid" in t && t.invalid
              ? "工具调用未通过供应商适配校验，请根据工具契约重新生成参数"
              : undefined;
        return {
          id: t.toolCallId,
          name: t.toolName,
          args: parsed.success ? parsed.data : t.input,
          ...(validationError ? { validationError } : {}),
        };
      });
      metrics.attempts.push({
        providerId: candidate.id,
        model: p.model,
        durationMs: Date.now() - attemptStart,
        status: "ok",
      });
      metrics.durationMs = Date.now() - started;
      metrics.inputTokens = result.usage.inputTokens;
      metrics.outputTokens = result.usage.outputTokens;
      metrics.reasoningTokens =
        result.usage.outputTokenDetails?.reasoningTokens;
      metrics.finishReason = result.finishReason;
      return {
        metrics,
        providerId: candidate.id,
        // SDK synthesizes tool errors for invalid inputs; the browser persists its own
        // one result per call, so do not replay a duplicate SDK error result.
        messages: result.response.messages.filter(
          (m) => m.role === "assistant",
        ),
        calls,
        text: result.text,
        model: p.name + " / " + p.model,
        usage: result.usage,
      };
    } catch (error) {
      const status =
        typeof (error as any)?.statusCode === "number"
          ? (error as any).statusCode
          : undefined;
      let upstreamType: unknown;
      try {
        upstreamType = JSON.parse((error as any)?.responseBody ?? "null")?.error
          ?.type;
      } catch {
        /* Do not expose untrusted provider bodies. */
      }
      const retryHeader = (error as any)?.responseHeaders?.["retry-after"];
      const retrySeconds = Number(retryHeader);
      const retryAfterMs =
        retryHeader && Number.isFinite(retrySeconds) && retrySeconds >= 0
          ? Math.min(retrySeconds * 1000, 30 * 86400000)
          : undefined;
      const code =
        status === 429 && upstreamType === "GoUsageLimitError"
          ? "quota_exhausted"
          : ["TimeoutError", "AbortError"].includes((error as Error)?.name)
            ? "timeout"
            : status
              ? "upstream_http"
              : (error as Error)?.message === "model_output_truncated"
                ? "output_truncated"
                : [
                      "ECONNRESET",
                      "ETIMEDOUT",
                      "EAI_AGAIN",
                      "UND_ERR_SOCKET",
                      "UND_ERR_CONNECT_TIMEOUT",
                    ].includes((error as any)?.cause?.code)
                  ? "network_error"
                  : ToolChoiceViolationError.isInstance(error)
                    ? error.finishReason === "content-filter"
                      ? "content_filtered"
                      : error.finishReason === "length"
                        ? "output_truncated"
                        : "invalid_tool_call"
                    : (error as Error)?.message === "invalid_tool_protocol"
                      ? "invalid_tool_call"
                      : "protocol_or_configuration";
      metrics.attempts.push({
        providerId: candidate.id,
        model: modelId,
        durationMs: Date.now() - attemptStart,
        status: "error",
        code,
        httpStatus: status,
        retryAfterMs,
        errorType: /^[A-Za-z0-9_]{1,80}$/.test((error as Error)?.name ?? "")
          ? (error as Error).name
          : undefined,
        causeCode: /^[A-Z0-9_]{1,80}$/.test((error as any)?.cause?.code ?? "")
          ? (error as any).cause.code
          : undefined,
      });
      if (signal?.aborted) break;
      failures.push(
        `${modelId}：${code === "quota_exhausted" ? "供应商额度已用尽，请恢复额度或选择其他模型" : code}${status ? " (" + status + ")" : ""}`,
      );
    }
  }

  metrics.durationMs = Date.now() - started;
  throw new TurnFailure(
    (candidates.length
      ? "本轮模型调用未完成；进度已保存。" + failures.join("；")
      : "没有可尝试的视觉/工具模型：请检查启用配置及视觉、工具调用能力设置。") +
      " 请求编号：" +
      metrics.requestId,
    metrics,
  );
}
