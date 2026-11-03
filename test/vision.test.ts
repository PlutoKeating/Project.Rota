import { beforeEach, expect, it, vi } from "vitest";
import { parseScreenshot } from "../src/worker/import/vision";
import { complete } from "../src/worker/llm/gateway";
import type { Env } from "../src/worker/env";
import type { Period, Term } from "../src/shared/types";
vi.mock("../src/worker/llm/gateway", () => ({ complete: vi.fn() }));
const input = { bytes: new ArrayBuffer(1), mime: "image/png",
  term: { id: "t", name: "Term", weekCount: 1, startDate: "2027-02-01" } as Term,
  periods: [{ periodIndex: 1, startTime: "08:00", endTime: "08:45" }] as Period[] };
const env = { CONFIG: { get: async () => null } } as unknown as Env;
const result = (to: number) => JSON.stringify({ courses: [{ name: "Math", meetings: [{ weekday: 1, periodFrom: 1, periodTo: to, patternKind: "all" }] }] });
beforeEach(() => vi.mocked(complete).mockReset());
it("模型返回不存在的节次时重试，不能把全部丢弃的课程假报解析成功", async () => {
  vi.mocked(complete).mockResolvedValueOnce(result(2)).mockResolvedValueOnce(result(1));
  const parsed = await parseScreenshot(env, input);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(parsed.courses[0].meetings[0]).toMatchObject({ periodFrom: 1, periodTo: 1 });
});
it("两次识别均无有效时段时明确失败", async () => {
  vi.mocked(complete).mockResolvedValue(result(2));
  await expect(parseScreenshot(env, input)).rejects.toThrow("截图解析失败");
});
