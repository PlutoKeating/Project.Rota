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
