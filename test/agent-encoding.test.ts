import { it, expect } from "vitest";
import { decodeDocumentText } from "../src/shared/agent-import/encoding";
it("decodes BOM in both transferable ArrayBuffer and Uint8Array", () => {
  const bytes = new Uint8Array([255, 254, 0x2d, 0x4e]);
  expect(decodeDocumentText(bytes).text).toBe("中");
  expect(decodeDocumentText(bytes.buffer).text).toBe("中");
});
it("honors a legacy HTML charset declaration", () => {
  const prefix = new TextEncoder().encode('<meta charset="GBK">');
  const bytes = new Uint8Array([...prefix, 0xd6, 0xd0]);
  expect(decodeDocumentText(bytes).text).toContain("中");
});
