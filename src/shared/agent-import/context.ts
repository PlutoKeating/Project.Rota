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

// Cached tool results make repeated reads return the identical data URL; send
// such a duplicate once (its latest occurrence) and leave a pointer elsewhere.
export function dropDuplicateImages(messages: ModelMessage[]): ModelMessage[] {
  const last = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role === "user" && Array.isArray(m.content))
      for (const p of m.content)
        if (p.type === "image" && typeof p.image === "string") last.set(p.image, i);
  });
  return messages.map((m, i) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    if (!m.content.some((p) => p.type === "image" && typeof p.image === "string" && last.get(p.image) !== i))
      return m;
    return {
      ...m,
      content: m.content.map((p) =>
        p.type === "image" && typeof p.image === "string" && last.get(p.image) !== i
          ? { type: "text" as const, text: "（同一图片在后文再次提供，此处省略）" }
          : p,
      ),
    };
  });
}

/**
 * Transport-only: send pixels for the most recent `keep` images and replace older
 * ones with a pointer. Context grows by every view, and resending all of them
 * each turn overloads both the upload link and the Worker's memory.
 */
export function keepRecentImages(messages: ModelMessage[], keep: number): ModelMessage[] {
  let seen = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    if (!m.content.some((p) => p.type === "image")) continue;
    const images = m.content.filter((p) => p.type === "image").length;
    if (seen + images <= keep) {
      seen += images;
      continue;
    }
    out[i] = {
      ...m,
      content: m.content.map((p) =>
        p.type === "image"
          ? { type: "text" as const, text: "（较早查看的图片本轮未发送；如需再看，请重新调用 view_image）" }
          : p,
      ),
    };
  }
  return out;
}

/**
 * Keep the task/preload head and the most recent turns within `target` text
 * characters, replacing the middle with one note. Facts the agent saved live
 * in the workspace (sent as context every turn), so dropping old reads loses
 * only transcript, never results. The tail always starts at an assistant
 * message so every tool result keeps its call. Returns undefined when nothing
 * can be dropped.
 */
export function compactMessages(
  messages: ModelMessage[],
  target: number,
): { messages: ModelMessage[]; dropped: number } | undefined {
  const size = (m: ModelMessage) => JSON.stringify(withoutImages([m])).length;
  const first = messages.findIndex((m) => m.role === "assistant");
  if (first < 0) return undefined;
  let total = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i > first; i--) {
    total += size(messages[i]);
    if (total > target) break;
    start = i;
  }
  while (start < messages.length && messages[start].role !== "assistant") start++;
  if (start >= messages.length || start <= first) return undefined;
  const dropped = messages.slice(first, start);
  // Carry the latest dropped reasoning forward so the agent keeps its place.
  const lastThought = [...dropped]
    .reverse()
    .flatMap((m) =>
      m.role === "assistant" && Array.isArray(m.content)
        ? m.content.flatMap((p) =>
            (p.type === "reasoning" || p.type === "text") && p.text.trim() ? [p.text] : [],
          )
        : [],
    )[0];
  const note =
    `为控制上下文，较早的 ${dropped.length} 条读取与推理记录已压缩。` +
    "已保存的人员信息、课表与待确认项以当前工作状态为准；已读区域记录仍有效，需要时可重新查看原件。" +
    (lastThought ? "\n压缩前最近一次推理要点：" + lastThought.slice(-1500) : "");
  return {
    messages: [...messages.slice(0, first), { role: "user", content: note }, ...messages.slice(start)],
    dropped: dropped.length,
  };
}
