import { describe, expect, it } from "vitest";
import {
  addDays,
  expandWeeks,
  generateTermSlots,
  parseWeekRanges,
  periodSpan,
  weekIndexOf,
} from "../src/worker/domain/time";

const TERM_START = "2026-09-07";

describe("parseWeekRanges", () => {
  it("解析区间与单周，并排序去重", () => {
    expect(parseWeekRanges("10-12,1-2,2,18", 20)).toEqual([1, 2, 10, 11, 12, 18]);
  });

  it("越界自动裁剪", () => {
    expect(parseWeekRanges("0-3,19-25", 20)).toEqual([1, 2, 3, 19, 20]);
  });

  it("忽略空片段", () => {
    expect(parseWeekRanges(" , 3 ,, 5 ", 10)).toEqual([3, 5]);
  });
});

describe("expandWeeks", () => {
  it("odd 取 1,3,5…", () => {
    expect(expandWeeks("odd", undefined, 6)).toEqual([1, 3, 5]);
  });

  it("even 取 2,4,6…", () => {
    expect(expandWeeks("even", undefined, 6)).toEqual([2, 4, 6]);
  });

  it("all 覆盖整学期", () => {
    expect(expandWeeks("all", undefined, 4)).toEqual([1, 2, 3, 4]);
  });

  it("ranges 走 week_ranges", () => {
    expect(expandWeeks("ranges", "3-5", 20)).toEqual([3, 4, 5]);
  });
});

describe("weekIndexOf", () => {
  it("开学当天是第 1 周", () => {
    expect(weekIndexOf(TERM_START, TERM_START, 20)).toBe(1);
  });

  it("第 8 天进入第 2 周", () => {
    expect(weekIndexOf(addDays(TERM_START, 7), TERM_START, 20)).toBe(2);
  });

  it("开学前返回 null", () => {
    expect(weekIndexOf(addDays(TERM_START, -1), TERM_START, 20)).toBeNull();
  });

  it("超出学期返回 null", () => {
    expect(weekIndexOf(addDays(TERM_START, 21 * 7), TERM_START, 20)).toBeNull();
  });
});

describe("generateTermSlots", () => {
  const periods = [
    { periodIndex: 1, startTime: "08:00", endTime: "08:45" },
    { periodIndex: 2, startTime: "08:55", endTime: "09:40" },
  ];

  it("格子数 = 周数 × 7 × 节次数", () => {
    const slots = generateTermSlots({
      termId: "t1",
      startDate: TERM_START,
      weekCount: 3,
      periods,
    });
    expect(slots).toHaveLength(3 * 7 * 2);
  });

  it("第一格是第 1 周周一第 1 节", () => {
    const [first] = generateTermSlots({ termId: "t1", startDate: TERM_START, weekCount: 1, periods });
    expect(first).toMatchObject({
      weekIndex: 1,
      weekday: 1,
      periodIndex: 1,
      startsAt: `${TERM_START}T08:00:00+08:00`,
      endsAt: `${TERM_START}T08:45:00+08:00`,
    });
  });

  it("第 2 周周一是开学后第 7 天", () => {
    const slots = generateTermSlots({ termId: "t1", startDate: TERM_START, weekCount: 2, periods: [periods[0]] });
    const week2Monday = slots.find((s) => s.weekIndex === 2 && s.weekday === 1);
    expect(week2Monday?.startsAt.startsWith(addDays(TERM_START, 7))).toBe(true);
  });
});

describe("periodSpan", () => {
  it("包含两端", () => {
    expect(periodSpan(3, 5)).toEqual([3, 4, 5]);
  });
  it("反向输入自动纠正", () => {
    expect(periodSpan(5, 3)).toEqual([3, 4, 5]);
  });
});

describe("addDays", () => {
  it("跨月正确", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
  });
});
