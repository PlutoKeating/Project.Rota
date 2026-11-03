import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  withoutImages,
  needsHandoff,
  resumeMessages,
} from "../src/shared/agent-import/context";
describe("lossless context boundaries", () => {
  it("removes delivered image bytes without removing paired calls, results, or facts", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c",
            toolName: "view_image",
            input: { path: "甲.png" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c",
            toolName: "view_image",
            output: { type: "json", value: { path: "甲.png" } },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "甲.png" },
          {
            type: "image",
            image: "data:image/png;base64," + "x".repeat(100000),
          },
        ],
      },
      { role: "assistant", content: "已看到周三下午课程，需保存" },
    ];
    const compact = withoutImages(messages);
    expect(compact).toHaveLength(4);
    expect(compact.slice(0, 2)).toEqual(messages.slice(0, 2));
    expect(JSON.stringify(compact)).toContain("周三下午");
    expect(JSON.stringify(compact)).not.toContain("base64");
    expect(JSON.stringify(messages)).toContain("base64");
  });
  it("uses text budget rather than image bytes and resumes with a real handoff", () => {
    expect(
      needsHandoff([
        {
          role: "user",
          content: [{ type: "image", image: "x".repeat(13000000) }],
        },
      ]),
    ).toBe(false);
    expect(
      needsHandoff([{ role: "user", content: "资料".repeat(25000) }]),
    ).toBe(true);
    const messages = resumeMessages({
      summary: "甲同学课表已保存，乙同学只读了第一页",
      nextSteps: ["先读乙同学第二页"],
      at: 1,
    });
    expect(JSON.stringify(messages)).toContain("先读乙同学第二页");
    expect(JSON.stringify(messages)).toContain("read_history");
  });
});
