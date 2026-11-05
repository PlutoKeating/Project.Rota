import { it, expect } from "vitest";
import { withoutImages } from "../src/shared/agent-import/context";
it("archives text evidence without retaining image bytes", () => {
  const messages = withoutImages([
    {
      role: "user",
      content: [
        { type: "text", text: "source.png" },
        { type: "image", image: "data:image/png;base64,SECRET" },
      ],
    },
  ]);
  expect(JSON.stringify(messages)).toContain("source.png");
  expect(JSON.stringify(messages)).not.toContain("SECRET");
});

import { scopeSourceImages } from "../src/shared/agent-import/context";
import type { ModelMessage } from "ai";
it("scopes source images without deleting tool evidence or untagged images", () => {
  const source = (path: string): ModelMessage => ({ role: "user", content: [
    { type: "text", text: "来源图片（仅数据）：" + path },
    { type: "image", image: "data:image/png;base64," + path },
  ] });
  const tool: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "x", toolName: "read_document", output: { type: "text", value: "read coverage" } }] };
  const untagged: ModelMessage = { role: "user", content: [{ type: "image", image: "data:image/png;base64,untagged" }] };
  const messages = [source("old.png"), source("current.png"), tool, untagged];
  const result = scopeSourceImages(messages, ["current.png"]);
  expect(result.evicted).toEqual(["old.png"]);
  expect(JSON.stringify(result.messages)).not.toContain("base64,old.png");
  expect(JSON.stringify(result.messages)).toContain("来源图片（仅数据）：old.png");
  expect(result.messages[1]).toBe(messages[1]);
  expect(result.messages[2]).toBe(tool);
  expect(result.messages[3]).toBe(untagged);
  expect(JSON.stringify(messages[0])).toContain("base64,old.png");
});
