import { describe, it, expect } from "vitest";
import { emptySnapshot, mutate } from "../src/shared/agent-import/model";
import {
  stageTimetable,
  timetableWarnings,
  timetableProposalSchema,
} from "../src/shared/agent-import/timetable";
const input = () =>
  timetableProposalSchema.parse({
    id: "plan",
    person: { id: "person", full_name: "测试甲" },
    organization_ids: ["dept"],
    term_name: "测试学期",
    entries: [
      { name: "数学", weekday: 1, period_from: 3, period_to: 4, weeks: [7, 8] },
    ],
    sources: [
      {
        source: "课表.png",
        locator: "星期一",
        explanation: "原图明确记载",
        inferred: false,
      },
    ],
  });
const base = () => {
  const s = emptySnapshot();
  mutate(s, "organization", "create", { id: "dept", name: "部门" }, "dept");
  return s;
};
describe("structured timetable staging", () => {
  it("keeps source course facts without inventing calendar dates and binds membership", () => {
    const original = base(),
      r = stageTimetable(original, {}, input());
    expect(original.person).toHaveLength(0);
    expect(r.draft.person).toHaveLength(1);
    expect(r.draft.membership).toHaveLength(1);
    expect(r.proposal.entries[0].weeks).toEqual([7, 8]);
    expect(r.proposal.bound).toBe(false);
    expect(r.draft.term).toEqual([]);
    expect(r.draft.timetable_entry).toEqual([]);
  });
  it("rejects an invalid department atomically", () => {
    const original = base();
    const x = input();
    x.organization_ids = ["missing"];
    expect(() => stageTimetable(original, {}, x)).toThrow("部门不存在");
    expect(original.person).toHaveLength(0);
  });
  it("cannot silently assign an existing plan to another person", () => {
    const first = stageTimetable(base(), {}, input());
    const x = input();
    x.person.id = "other";
    expect(() =>
      stageTimetable(first.draft, first.evidence, x, first.proposal),
    ).toThrow("不能偷偷换人");
  });
  it("materializes all known course fields when explicit calendar/profile references arrive", () => {
    const first = stageTimetable(base(), {}, input());
    mutate(
      first.draft,
      "term",
      "create",
      {
        id: "term",
        name: "测试学期",
        start_date: "2026-08-31",
        week_count: 18,
      },
      "term",
    );
    mutate(
      first.draft,
      "timetable_profile",
      "create",
      {
        id: "profile",
        term_id: "term",
        name: "测试作息",
        periods: JSON.stringify([
          { index: 3, start: "10:20", end: "11:00" },
          { index: 4, start: "11:10", end: "11:50" },
        ]),
      },
      "profile",
    );
    const x = input();
    x.term_id = "term";
    x.profile_id = "profile";
    const r = stageTimetable(first.draft, first.evidence, x, first.proposal);
    expect(r.draft.timetable_entry).toHaveLength(1);
    expect(r.draft.timetable_entry[0]).toMatchObject({
      person_id: "person",
      weekday: 1,
      period_from: 3,
      period_to: 4,
      weeks: "[7,8]",
    });
    expect(r.draft.membership).toHaveLength(1);
    expect(r.proposal.bound).toBe(true);
    const again = stageTimetable(r.draft, r.evidence, x, r.proposal);
    expect(again.changed).toBe(false);
  });
});

it("warns about explicit overlapping periods without changing source entries", () => {
  const a = input().entries[0];
  const entries = [
    a,
    { ...a, name: "物理", weeks: [8, 9] },
    { ...a, name: "另一天", weekday: 2 },
    { ...a, name: "待定", weekday: null },
  ];
  const before = structuredClone(entries);
  expect(timetableWarnings(entries)).toHaveLength(1);
  expect(timetableWarnings(entries)[0]).toContain("第8周");
  expect(entries).toEqual(before);
});

it("preserves an explicitly unscheduled course as an individual enrollment instead of dropping it", () => {
  const s = base();
  mutate(
    s,
    "term",
    "create",
    { id: "t", name: "秋季", start_date: "2026-08-31", week_count: 18 },
    "t",
  );
  mutate(
    s,
    "timetable_profile",
    "create",
    {
      id: "clock",
      term_id: "t",
      name: "作息",
      periods: '[{"index":1,"start":"08:30","end":"09:15"}]',
    },
    "clock",
  );
  const x = timetableProposalSchema.parse({
    ...input(),
    term_id: "t",
    profile_id: "clock",
    entries: [
      {
        name: "劳动教育",
        no_fixed_time: true,
        teacher: "教师甲",
        note: "附注列出课程，没有固定上课时段",
      },
    ],
  });
  const r = stageTimetable(s, {}, x);
  expect(r.draft.course).toHaveLength(1);
  expect(r.draft.enrollment[0]).toMatchObject({
    person_id: x.person.id,
    course_id: r.draft.course[0].id,
  });
  expect(r.draft.course_meeting).toHaveLength(0);
  expect(r.draft.timetable_entry).toHaveLength(0);
});
it("rejects contradictory fixed and explicitly unscheduled input", () => {
  expect(
    timetableProposalSchema.safeParse({
      ...input(),
      entries: [{ ...input().entries[0], no_fixed_time: true }],
    }).success,
  ).toBe(false);
});
it("replaces an individual unscheduled course without duplicates and can remove it", () => {
  const s = base();
  mutate(
    s,
    "term",
    "create",
    { id: "t", name: "秋季", start_date: "2026-08-31", week_count: 18 },
    "t",
  );
  mutate(
    s,
    "timetable_profile",
    "create",
    {
      id: "clock",
      term_id: "t",
      name: "作息",
      periods: '[{"index":1,"start":"08:30","end":"09:15"}]',
    },
    "clock",
  );
  const x = timetableProposalSchema.parse({
    ...input(),
    term_id: "t",
    profile_id: "clock",
    entries: [{ name: "劳动教育", no_fixed_time: true }],
  });
  const a = stageTimetable(s, {}, x),
    b = stageTimetable(a.draft, a.evidence, x, a.proposal);
  expect(b.changed).toBe(false);
  expect(b.draft.course).toHaveLength(1);
  expect(b.draft.enrollment).toHaveLength(1);
  const removed = stageTimetable(
    b.draft,
    b.evidence,
    { ...x, entries: [] },
    b.proposal,
  );
  expect(removed.draft.course).toHaveLength(0);
  expect(removed.draft.enrollment).toHaveLength(0);
});
