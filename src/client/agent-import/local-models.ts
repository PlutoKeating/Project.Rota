import { ApiError } from "../lib/api";
import type { TurnMetrics } from "../../shared/agent-import/context";

/**
 * Operator-entered model providers called straight from this browser.
 * Keys live only in this browser's localStorage; nothing is sent to our server,
 * and server-held keys are never sent down. Removes the Worker (and its CPU
 * limit) from the model path entirely.
 */
export type LocalKind = "openai_compatible" | "openai_responses" | "anthropic" | "google";
export interface LocalModel {
  id: string;
  name: string;
  kind: LocalKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  reasoningEffort?: string;
  enabled: boolean;
}
export interface LocalModelSettings {
  /** When on, every model turn goes browser → provider directly. */
  direct: boolean;
  models: LocalModel[];
}

export const PRESETS: { label: string; kind: LocalKind; baseUrl: string; model: string }[] = [
  { label: "DeepSeek", kind: "openai_compatible", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
  { label: "Kimi（Moonshot）", kind: "openai_compatible", baseUrl: "https://api.moonshot.ai/v1", model: "" },
  { label: "OpenAI", kind: "openai_responses", baseUrl: "https://api.openai.com/v1", model: "" },
  { label: "Google Gemini", kind: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "" },
  { label: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "" },
  { label: "其他 OpenAI 兼容", kind: "openai_compatible", baseUrl: "", model: "" },
];

const KEY = "rota:local-models";
const EMPTY: LocalModelSettings = { direct: false, models: [] };

export function loadLocalModels(): LocalModelSettings {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (value && Array.isArray(value.models)) return { direct: !!value.direct, models: value.models };
  } catch {
    /* storage unavailable or corrupt: behave as not configured */
  }
  return { ...EMPTY, models: [] };
}
export function saveLocalModels(settings: LocalModelSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    throw Error("浏览器不允许保存本机模型设置（可能是隐私模式）");
  }
  window.dispatchEvent(new Event("rota:local-models"));
}
/** Enabled models when direct mode is on; empty means "use the server". */
export function activeLocalModels(): LocalModel[] {
  const s = loadLocalModels();
  return s.direct ? s.models.filter((m) => m.enabled && m.apiKey && m.model && m.baseUrl) : [];
}

function toProvider(m: LocalModel) {
  return {
    id: "local:" + m.id,
    name: m.name,
    kind: m.kind === "openai_responses" ? "openai_compatible" : m.kind,
    baseUrl: m.baseUrl.replace(/\/+$/, ""),
    model: m.model,
    apiKey: m.apiKey,
    params: {
      vision: true,
      ...(m.kind === "openai_responses" ? { api: "responses" } : {}),
      ...(m.reasoningEffort ? { reasoning_effort: m.reasoningEffort } : {}),
    } as Record<string, unknown>,
  };
}

/** Same request body and reply as POST /agent-imports/:id/turn, executed locally. */
export async function localTurn(body: unknown, models = activeLocalModels()) {
  const { runTurn, createChatModel, orderCandidates, turnBodySchema, TurnFailure } =
    await import("../../shared/agent-import/turn");
  const parsed = turnBodySchema.parse(body);
  const candidates = orderCandidates(
    models.map((m) => ({
      id: "local:" + m.id,
      async load() {
        const provider = toProvider(m);
        return {
          provider,
          model: createChatModel(provider, {
            // Anthropic rejects browser calls unless explicitly opted in.
            headers:
              m.kind === "anthropic"
                ? { "anthropic-dangerous-direct-browser-access": "true" }
                : undefined,
          }),
        };
      },
    })),
    parsed,
  );
  try {
    return await runTurn(parsed, candidates);
  } catch (error) {
    if (error instanceof TurnFailure) {
      // Same shape the server returns, so retry/metrics handling is shared.
      const e = new ApiError(502, "llm_error", error.message);
      e.details = { metrics: error.metrics as TurnMetrics };
      throw e;
    }
    throw error;
  }
}

/** One real tool-calling round trip: proves CORS, key, model name and tool support. */
export async function testLocalModel(m: LocalModel): Promise<{ ok: boolean; ms: number; message: string }> {
  const started = performance.now();
  try {
    await localTurn(
      {
        mode: "discover",
        context: "{}",
        messages: [{ role: "user", content: "连接测试：请立即调用 tree 工具，prefix 为空字符串、offset 为 0。" }],
      },
      [{ ...m, enabled: true }],
    );
    return { ok: true, ms: Math.round(performance.now() - started), message: "可用" };
  } catch (error) {
    const metrics = (error as ApiError)?.details as { metrics?: TurnMetrics } | undefined;
    const attempt = metrics?.metrics?.attempts?.[0];
    const message =
      attempt?.httpStatus === 401 || attempt?.httpStatus === 403
        ? "密钥无效或无权限"
        : attempt?.httpStatus === 404
          ? "地址或模型名不存在"
          : attempt?.code === "invalid_tool_call"
            ? "模型不支持工具调用"
            : attempt?.code === "timeout"
              ? "响应超时"
              : attempt?.code === "network_error" || attempt?.code === "protocol_or_configuration"
                ? "无法连接（地址错误或不允许浏览器直连）"
                : attempt
                  ? [attempt.code, attempt.httpStatus].filter(Boolean).join(" ")
                  : (error as Error).message;
    return { ok: false, ms: Math.round(performance.now() - started), message };
  }
}
