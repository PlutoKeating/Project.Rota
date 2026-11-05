import type { ModelMessage } from "ai";

export interface Attempt {
  providerId: string;
  model: string;
  durationMs: number;
  status: "ok" | "error";
  code?: string;
  httpStatus?: number;
  retryAfterMs?: number;
  errorType?: string;
  causeCode?: string;
}
export interface TurnMetrics {
  requestId: string;
  durationMs: number;
  attempts: Attempt[];
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  finishReason?: string;
  purpose: "discover" | "person" | "verify" | "reconcile" | "consistency";
  actorId?: string;
}

/** Replace image bytes with source references when callers have secured the corresponding facts.
 * Never removes assistant/tool pairs. Original files remain available through the file tools. */
export function withoutImages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((p) =>
        p.type === "image"
          ? {
              type: "text" as const,
              text: "[图片已在上一轮展示；如需核对可按同条消息的路径重新查看。]",
            }
          : p,
      ),
    };
  });
}


/** Evict only source-tagged image payloads after a completed review boundary. */
export function scopeSourceImages(messages: ModelMessage[], keep: string[]) {
  const retained = new Set(keep), evicted = new Set<string>();
  const scoped = messages.map((message): ModelMessage => {
    if (message.role !== "user" || !Array.isArray(message.content) ||
        !message.content.some((part) => part.type === "image")) return message;
    const tag = message.content.find((part) => part.type === "text" &&
      part.text.startsWith("来源图片（仅数据）："));
    if (!tag || tag.type !== "text") return message;
    const path = tag.text.slice("来源图片（仅数据）：".length);
    if (retained.has(path)) return message;
    evicted.add(path);
    return withoutImages([message])[0];
  });
  return { messages: scoped, evicted: [...evicted] };
}
