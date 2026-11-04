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
  purpose: "discover" | "person" | "verify" | "reconcile";
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
