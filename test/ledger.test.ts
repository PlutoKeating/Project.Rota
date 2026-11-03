import { describe, expect, it } from "vitest";
import { minutesBetween, windowKeyFor } from "../src/worker/domain/ledger";
import type { Term } from "../src/shared/types";

const term: Term = {
  id: "t1",
  name: "2026 秋",
  startDate: "2026-09-07",
  weekCount: 20,
  timezone: "Asia/Shanghai",
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
};

describe("windowKeyFor", () => {
  it("开学当天是第 1 周", () => {
    expect(windowKeyFor(term, "2026-09-07T10:00:00+08:00")).toBe("2026 秋-W1");
  });

  it("第二周周一进入 W2", () => {
    expect(windowKeyFor(term, "2026-09-14T08:00:00+08:00")).toBe("2026 秋-W2");
  });

  it("学期末仍可归属", () => {
    expect(windowKeyFor(term, "2027-01-18T08:00:00+08:00")).toBe("2026 秋-W20");
  });
});

describe("minutesBetween", () => {
  it("按分钟计算", () => {
    expect(minutesBetween("2026-09-07T08:00:00+08:00", "2026-09-07T09:40:00+08:00")).toBe(100);
  });

  it("跨天正确", () => {
    expect(minutesBetween("2026-09-07T23:00:00+08:00", "2026-09-08T01:00:00+08:00")).toBe(120);
  });

  it("非法区间返回 0", () => {
    expect(minutesBetween("2026-09-07T10:00:00+08:00", "2026-09-07T09:00:00+08:00")).toBe(0);
  });
});
