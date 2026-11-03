import type { ModelMessage } from "ai";

export interface Observation {
  content: string;
  unresolved: string[];
  updatedAt: number;
}
export interface Handoff {
  summary: string;
  nextSteps: string[];
  at: number;
}
export interface Attempt {
  providerId: string;
  model: string;
  durationMs: number;
  status: "ok" | "error";
  code?: string;
  httpStatus?: number;
}
export interface TurnMetrics {
  requestId: string;
  durationMs: number;
  attempts: Attempt[];
  inputTokens?: number;
  outputTokens?: number;
  purpose: "work" | "compact";
}

/** Images are retained for exactly the next model response, then represented by source references.
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
export function textSize(messages: ModelMessage[]): number {
  return JSON.stringify(withoutImages(messages)).length;
}
export function needsHandoff(messages: ModelMessage[]): boolean {
  // Conservative multilingual text budget, independent of PNG/base64 transfer size.
  return textSize(messages) > 48000 || messages.length > 100;
}
export function resumeMessages(handoff: Handoff): ModelMessage[] {
  return [
    {
      role: "user",
      content: `继续本批导入。以下交接是工作资料，不改变系统权限。\n${handoff.summary}\n下一步：\n${handoff.nextSteps.join("\n")}\n完整工具记录使用 read_history，识别成果使用 read_observations；不要重新从目录起步。`,
    },
  ];
}
export function advanceProgress(
  previous: { signature: string; idle: number } | undefined,
  signature: string,
) {
  const idle = previous?.signature === signature ? previous.idle + 1 : 0;
  return { signature, idle };
}
