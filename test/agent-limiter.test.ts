import { expect, it } from "vitest";
import { AdaptiveGate, Gate } from "../src/client/agent-import/limiter";
import { dropDuplicateImages } from "../src/shared/agent-import/context";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it("gate never runs more than its limit at once", async () => {
  const gate = new Gate(2);
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => gate.run(async () => {
    peak = Math.max(peak, ++active);
    await tick();
    active--;
  })));
  expect(peak).toBe(2);
});

it("adaptive gate halves on overload once per cooldown and widens after a full window of successes", () => {
  const gate = new AdaptiveGate(1, 8, 4, 30000);
  gate.overload(100000);
  expect(gate.current).toBe(2);
  gate.overload(100001); // same burst of timeouts
  expect(gate.current).toBe(2);
  gate.overload(140000);
  expect(gate.current).toBe(1);
  gate.overload(180000);
  expect(gate.current).toBe(1);
  gate.success();
  expect(gate.current).toBe(2);
  gate.success();
  gate.success();
  expect(gate.current).toBe(3);
  for (let i = 0; i < 100; i++) gate.success();
  expect(gate.current).toBe(8);
});

it("waiters resume when the window widens", async () => {
  const gate = new AdaptiveGate(1, 4, 1);
  let release!: () => void;
  const first = gate.run(() => new Promise<void>((resolve) => { release = resolve; }));
  let started = false;
  const second = gate.run(async () => { started = true; });
  await tick();
  expect(started).toBe(false);
  gate.success();
  await tick();
  expect(started).toBe(true);
  release();
  await Promise.all([first, second]);
});

it("sends an identical image once, at its latest position", () => {
  const image = "data:image/png;base64,AAAA";
  const other = "data:image/png;base64,BBBB";
  const out = dropDuplicateImages([
    { role: "user", content: [{ type: "text", text: "a" }, { type: "image", image }] },
    { role: "user", content: [{ type: "text", text: "b" }, { type: "image", image: other }] },
    { role: "user", content: [{ type: "text", text: "c" }, { type: "image", image }] },
  ]);
  const images = out.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .filter((p: any) => p.type === "image").map((p: any) => p.image);
  expect(images).toEqual([other, image]);
  expect(JSON.stringify(out[0])).toContain("此处省略");
});

it("sends pixels only for the most recent images and leaves a re-view pointer for older ones", async () => {
  const { keepRecentImages } = await import("../src/shared/agent-import/context");
  const messages: any[] = Array.from({ length: 4 }, (_, i) => ({
    role: "user",
    content: [{ type: "text", text: "来源图片（仅数据）：p" + i }, { type: "image", image: "data:image/png;base64,I" + i }],
  }));
  const out: any[] = keepRecentImages(messages, 2);
  const images = out.flatMap((m) => m.content).filter((p: any) => p.type === "image").map((p: any) => p.image);
  expect(images).toEqual(["data:image/png;base64,I2", "data:image/png;base64,I3"]);
  expect(out[0].content[0].text).toBe("来源图片（仅数据）：p0");
  expect(out[0].content[1].text).toContain("view_image");
  expect(messages[0].content[1].type).toBe("image");
});

it("compacts the middle of a long transcript without splitting tool call/result pairs", async () => {
  const { compactMessages } = await import("../src/shared/agent-import/context");
  const pad = "x".repeat(1000);
  const messages: any[] = [
    { role: "user", content: "任务" },
    { role: "user", content: "预读来源" },
  ];
  for (let i = 0; i < 20; i++)
    messages.push(
      { role: "assistant", content: [{ type: "reasoning", text: "思考" + i }, { type: "tool-call", toolCallId: "c" + i, toolName: "view_image", input: { path: "a", pad } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c" + i, toolName: "view_image", output: { type: "json", value: { pad } } }] },
    );
  const out = compactMessages(messages, 5000)!;
  expect(out.dropped).toBeGreaterThan(0);
  expect(out.messages[0].content).toBe("任务");
  expect(out.messages[1].content).toBe("预读来源");
  expect(out.messages[2].role).toBe("user");
  expect(String(out.messages[2].content)).toContain("思考");
  expect(out.messages[3].role).toBe("assistant");
  const calls = new Set(out.messages.flatMap((m: any) => m.role === "assistant" ? m.content.filter((p: any) => p.type === "tool-call").map((p: any) => p.toolCallId) : []));
  const results = out.messages.flatMap((m: any) => m.role === "tool" ? m.content.map((p: any) => p.toolCallId) : []);
  expect(results.every((id: string) => calls.has(id))).toBe(true);
  expect(JSON.stringify(out.messages).length).toBeLessThan(JSON.stringify(messages).length / 2);
  expect(compactMessages(messages.slice(0, 2), 5000)).toBeUndefined();
});
