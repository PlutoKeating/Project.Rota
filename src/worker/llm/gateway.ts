import { unseal } from "./secrets";
import type { LlmProviderKind } from "../../shared/types";
import type { Env } from "../env";
import { HttpError, dbAll, dbOne, parseJson } from "../lib/core";

/**
 * 模型网关：配置读 D1，密钥读 Cloudflare Secret。
 *
 * 只做"发一条消息、拿回文本"这一件事，导入、截图识别、后台测试都走这里。
 * 各家的协议差异（system 位置、多模态字段名）集中在 buildRequest 里，
 * 上层不需要知道当前用的是哪家。
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatImage {
  mime: string;
  /** 不含 `data:` 前缀的 base64。 */
  base64: string;
}

export interface CompleteOptions {
  providerId?: string | null;
  messages: ChatMessage[];
  json?: boolean;
  temperature?: number;
  /**
   * 图片输入。ChatMessage.content 仍是字符串（契约不变），
   * 图片在这里单独传，由网关按供应商拼成多模态请求。
   */
  images?: ChatImage[];
}

export interface ResolvedProvider {
  id: string;
  name: string;
  kind: LlmProviderKind;
  baseUrl: string;
  model: string;
  apiKeySecret: string | null;
  apiKey: string;
  params: Record<string, unknown>;
}

interface ProviderRow {
  id: string;
  name: string | null;
  kind: LlmProviderKind;
  baseUrl: string | null;
  model: string | null;
  apiKeySecret: string | null;
  enabled: number | boolean | null;
  params: string | null;
  updatedAt: string | null;
}

interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const PROVIDER_COLUMNS =
  "id, name, kind, base_url, model, api_key_secret, enabled, params, updated_at";

/** 查一个启用的供应商；不传 providerId 时取第一个（按名称排序，保证可复现）。 */
export async function resolveProvider(
  env: Env,
  providerId?: string | null,
  needsVision = false,
): Promise<ResolvedProvider> {
  if (!providerId) {
    const order = JSON.parse(
      (await env.CONFIG.get("llm:order")) || "[]",
    ) as string[];
    const enabled = (
      await dbAll<{ id: string; params: string | null }>(
        env.DB,
        "select id, params from llm_provider where enabled = 1 order by name, id",
      )
    ).filter(
      (p) =>
        !needsVision ||
        parseJson<Record<string, unknown>>(p.params)?.vision !== false,
    );
    providerId =
      order.find((id) => enabled.some((p) => p.id === id)) ?? enabled[0]?.id;
    if (!providerId)
      throw new HttpError(
        503,
        "llm_not_configured",
        "没有已启用且支持当前输入的模型",
      );
  }
  const row = providerId
    ? await dbOne<ProviderRow>(
        env.DB,
        `select ${PROVIDER_COLUMNS} from llm_provider where id = ? and enabled = 1`,
        providerId,
      )
    : await dbOne<ProviderRow>(
        env.DB,
        `select ${PROVIDER_COLUMNS} from llm_provider where enabled = 1 order by name, id limit 1`,
      );

  if (!row) {
    if (providerId)
      throw new HttpError(404, "not_found", "模型供应商不存在或已停用");
    throw new HttpError(
      503,
      "llm_not_configured",
      "还没有启用任何模型供应商，请先在管理后台配置",
    );
  }

  const model = row.model?.trim() ?? "";
  if (!model) {
    throw new HttpError(
      500,
      "llm_misconfigured",
      `模型供应商「${row.name ?? row.id}」缺少 model`,
    );
  }

  const baseUrl = (row.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (row.kind !== "cloudflare_ai" && !baseUrl) {
    throw new HttpError(
      500,
      "llm_misconfigured",
      `模型供应商「${row.name ?? row.id}」缺少 baseUrl`,
    );
  }

  // Secret 在 Worker 里以同名绑定暴露在 env 上；Env 没有索引签名，只能安全断言。
  let apiKey = "";
  if (row.apiKeySecret) {
    const secret = (env as unknown as Record<string, unknown>)[
      row.apiKeySecret
    ];
    if (typeof secret === "string") apiKey = secret.trim();
  }
  const storedParams = parseJson<Record<string, unknown>>(row.params) ?? {};
  if (typeof storedParams.encryptedKey === "string")
    apiKey = await unseal(env, storedParams.encryptedKey);
  if (!apiKey && row.kind !== "cloudflare_ai") {
    throw new HttpError(
      500,
      "llm_secret_missing",
      `模型供应商「${row.name ?? row.id}」的密钥 ${row.apiKeySecret ?? "(未配置名称)"} 未绑定到 Worker Secret`,
    );
  }

  return {
    id: row.id,
    name: row.name ?? row.id,
    kind: row.kind,
    baseUrl,
    model,
    apiKeySecret: row.apiKeySecret,
    apiKey,
    params: parseJson<Record<string, unknown>>(row.params) ?? {},
  };
}

/** 发一条对话，返回纯文本。HTTP 非 2xx 统一 502，超时 504。 */
export async function complete(
  env: Env,
  options: CompleteOptions,
): Promise<string> {
  const provider = await resolveProvider(
    env,
    options.providerId,
    !!options.images?.length,
  );
  const temperature =
    options.temperature ?? paramNumber(provider.params, "temperature") ?? 0.2;
  if (provider.kind === "cloudflare_ai") {
    if (!env.AI)
      throw new HttpError(503, "llm_not_configured", "Workers AI 绑定尚未配置");
    const input = buildOpenAi(provider, options, temperature).body;
    const result = asRecord(await env.AI.run(provider.model, input));
    const text =
      typeof result?.response === "string"
        ? result.response
        : extractOpenAiText(result);
    if (!text.trim()) throw new HttpError(502, "llm_error", "模型返回内容为空");
    return text;
  }
  const request = buildRequest(provider, options, temperature);

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new HttpError(504, "llm_timeout", "模型请求超时（30 秒）");
    }
    throw new HttpError(
      502,
      "llm_error",
      "模型请求失败，请检查服务地址与网络连接",
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    throw new HttpError(
      502,
      "llm_error",
      `模型返回 HTTP ${response.status}，请检查密钥、权限与模型配置`,
    );
  }

  let payload: unknown = null;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    payload = null;
  }

  const text = extractText(provider.kind, payload);
  if (!text.trim()) {
    throw new HttpError(502, "llm_error", "模型返回内容为空或格式无法识别");
  }
  return text;
}

/** 后台"测试连接"：失败不抛异常，把原因放进 message 给前端展示。 */
export async function testProvider(
  env: Env,
  id: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const text = await complete(env, {
      providerId: id,
      messages: [{ role: "user", content: "ping" }],
      temperature: 0,
    });
    return { ok: true, message: truncate(text) };
  } catch (error) {
    return { ok: false, message: truncate(errorText(error)) };
  }
}

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

function buildRequest(
  provider: ResolvedProvider,
  options: CompleteOptions,
  temperature: number,
): BuiltRequest {
  switch (provider.kind) {
    case "openai_compatible":
      return buildOpenAi(provider, options, temperature);
    case "anthropic":
      return buildAnthropic(provider, options, temperature);
    case "google":
      return buildGoogle(provider, options, temperature);
    case "cloudflare_ai":
      throw new HttpError(
        501,
        "not_implemented",
        "Workers AI 必须通过绑定调用",
      );
    default:
      throw new HttpError(
        501,
        "not_implemented",
        `未知的模型供应商类型：${provider.kind}`,
      );
  }
}

function buildOpenAi(
  provider: ResolvedProvider,
  options: CompleteOptions,
  temperature: number,
): BuiltRequest {
  const lastUser = findLastUserIndex(options.messages);
  const messages = options.messages.map((message, index) => {
    if (index !== lastUser || !options.images?.length) {
      return { role: message.role, content: message.content };
    }
    return {
      role: message.role,
      content: [
        { type: "text", text: message.content },
        ...imageParts(options.images, (image) => ({
          type: "image_url",
          image_url: { url: `data:${image.mime};base64,${image.base64}` },
        })),
      ],
    };
  });

  return {
    url: `${provider.baseUrl}/chat/completions`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`,
    },
    body: {
      model: provider.model,
      messages,
      temperature,
      response_format: options.json ? { type: "json_object" } : undefined,
    },
  };
}

function buildAnthropic(
  provider: ResolvedProvider,
  options: CompleteOptions,
  temperature: number,
): BuiltRequest {
  const system = options.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const chat = options.messages.filter((message) => message.role !== "system");
  const lastUser = findLastUserIndex(chat);

  const messages = chat.map((message, index) => {
    if (index !== lastUser || !options.images?.length) {
      return { role: message.role, content: message.content };
    }
    return {
      role: message.role,
      content: [
        ...imageParts(options.images, (image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mime,
            data: image.base64,
          },
        })),
        { type: "text", text: message.content },
      ],
    };
  });

  return {
    url: `${provider.baseUrl}/v1/messages`,
    headers: {
      "content-type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: {
      model: provider.model,
      max_tokens: options.json ? 2048 : 1024,
      messages,
      system: system || undefined,
      temperature,
    },
  };
}

function buildGoogle(
  provider: ResolvedProvider,
  options: CompleteOptions,
  temperature: number,
): BuiltRequest {
  const system = options.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const chat = options.messages.filter((message) => message.role !== "system");
  const lastUser = findLastUserIndex(chat);

  const contents = chat.map((message, index) => {
    const parts: Record<string, unknown>[] = [{ text: message.content }];
    if (index === lastUser && options.images?.length) {
      parts.push(
        ...imageParts(options.images, (image) => ({
          inline_data: { mime_type: image.mime, data: image.base64 },
        })),
      );
    }
    return {
      role: message.role === "assistant" ? "model" : "user",
      parts,
    };
  });

  return {
    url: `${provider.baseUrl}/v1beta/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`,
    headers: { "content-type": "application/json" },
    body: {
      contents,
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: {
        temperature,
        responseMimeType: options.json ? "application/json" : undefined,
      },
    },
  };
}

/** 图片只挂在最后一条 user 消息上，避免多轮对话里重复上传。 */
function imageParts(
  images: ChatImage[],
  toPart: (image: ChatImage) => Record<string, unknown>,
): Record<string, unknown>[] {
  return images.map(toPart);
}

function findLastUserIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

function extractText(kind: LlmProviderKind, payload: unknown): string {
  switch (kind) {
    case "openai_compatible":
      return extractOpenAiText(payload);
    case "anthropic":
      return extractAnthropicText(payload);
    case "google":
      return extractGoogleText(payload);
    case "cloudflare_ai":
      return "";
    default:
      return "";
  }
}

function extractOpenAiText(payload: unknown): string {
  const choice = asArray(asRecord(payload)?.choices)[0];
  const content = asRecord(asRecord(choice)?.message)?.content;
  if (typeof content === "string") return content;
  // 部分兼容实现把 content 拆成 [{type:"text", text:"..."}]
  return asArray(content)
    .map((part) => asText(asRecord(part)?.text))
    .join("");
}

function extractAnthropicText(payload: unknown): string {
  return asArray(asRecord(payload)?.content)
    .filter((block) => asRecord(block)?.type === "text")
    .map((block) => asText(asRecord(block)?.text))
    .join("");
}

function extractGoogleText(payload: unknown): string {
  const candidate = asArray(asRecord(payload)?.candidates)[0];
  const parts = asArray(asRecord(asRecord(candidate)?.content)?.parts);
  return parts.map((part) => asText(asRecord(part)?.text)).join("");
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function paramNumber(
  params: Record<string, unknown>,
  key: string,
): number | null {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 错误响应可能很长，写进 HttpError 前截断，避免把整页 HTML 塞给前端。 */
function truncate(value: string, max = 300): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
