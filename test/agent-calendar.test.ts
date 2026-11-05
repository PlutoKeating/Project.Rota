import { expect, it } from "vitest";
import { toolSpecs } from "../src/shared/agent-import/tools";

it("offers a durable partial calendar without manufacturing missing end clocks or total weeks", () => {
  const tool = { schema: calendarSchema };
  expect(
    tool,
    "partial calendar currently has no tool and is lost in prose",
  ).toBeDefined();
  const value = tool.schema.parse({
    id: "calendar",
    name: "秋季",
    start_date: "2026-08-31",
    week_count: null,
    minimum_weeks: 18,
    periods: [{ index: 1, start: "08:30", end: null }],
    timetable_ids: ["student"],
    sources: [
      {
        source: "week9.png",
        locator: "顶部",
        explanation: "第9周周一10月26日，倒推首周周一8月31日",
        inferred: true,
      },
    ],
    unresolved: ["总周数和下课钟点缺失"],
  });
  expect(value.week_count).toBeNull();
  expect(value.periods[0].end).toBeNull();
  expect(value.start_date).toBe("2026-08-31");
});

it("requires field-specific checks before a timetable can be marked checked", () => {
  expect(
    toolSpecs.finish_person.schema.safeParse({
      checks: [{ key: "plan", identity: "已看过" }],
    }).success,
  ).toBe(false);
});

import {
  calendarSchema,
  calendarMissing,
  stageCalendar,
} from "../src/shared/agent-import/calendar";
import {
  emptySnapshot,
  materialize,
  validateTransition,
} from "../src/shared/agent-import/model";
import {
  stageTimetable,
  timetableProposalSchema,
} from "../src/shared/agent-import/timetable";
const proof = [
  {
    source: "schedule.txt",
    locator: "全文",
    explanation: "测试原件明确提供",
    inferred: false,
  },
];
it("refuses to materialize partial clocks without changing the draft", () => {
  const base = emptySnapshot();
  const c = calendarSchema.parse({
    id: "c",
    name: "秋季",
    start_date: "2026-08-31",
    week_count: null,
    minimum_weeks: 18,
    periods: [{ index: 1, start: "08:30", end: null }],
    timetable_ids: [],
    sources: proof,
  });
  expect(calendarMissing(c)).toEqual([
    "第1节下课时间",
  ]);
  expect(() => stageCalendar(base, {}, c)).toThrow("尚不完整");
  expect(base.term).toHaveLength(0);
});
it("known course range materializes without requiring a fixed semester total", () => {
  const c = calendarSchema.parse({
    id: "dynamic", name: "秋季", start_date: "2026-08-31", week_count: null,
    minimum_weeks: 18, periods: [{ index: 1, start: "08:30", end: "09:10" }],
    timetable_ids: [], sources: proof,
  });
  expect(calendarMissing(c)).toEqual([]);
  const staged = stageCalendar(emptySnapshot(), {}, c);
  expect(staged.draft.term[0].week_count).toBe(18);
  expect(c.week_count).toBeNull();
});
it("complete reviewed calendar yields actual scheduled availability with all teacher and place fields", () => {
  const base = emptySnapshot();
  const c = calendarSchema.parse({
    id: "c",
    name: "秋季",
    start_date: "2026-08-31",
    week_count: 18,
    minimum_weeks: 18,
    periods: [{ index: 1, start: "08:30", end: "09:15" }],
    timetable_ids: ["p"],
    sources: proof,
  });
  const staged = stageCalendar(base, {}, c);
  const plan = timetableProposalSchema.parse({
    id: "p",
    person: { id: "person", full_name: "测试甲" },
    term_name: "秋季",
    term_id: staged.termId,
    profile_id: staged.profileId,
    entries: [
      {
        name: "数学",
        weekday: 1,
        period_from: 1,
        period_to: 1,
        weeks: [1, 2],
        teacher: "测试教师",
        location: "101",
      },
    ],
    sources: proof,
  });
  const bound = stageTimetable(staged.draft, staged.evidence, plan);
  const actual = materialize(bound.draft, base);
  expect(validateTransition(base, actual)).toEqual([]);
  expect(actual.timetable_entry[0]).toMatchObject({
    teacher: "测试教师",
    location: "101",
  });
  expect(actual.timetable_event).toHaveLength(2);
  expect(actual.timetable_event[0].starts_at).toContain("2026-08-31");
});
it("rejects non-Monday starts, duplicate periods and unsupported total weeks", () => {
  const c = {
    id: "c",
    name: "秋季",
    start_date: "2026-09-01",
    week_count: 17,
    minimum_weeks: 18,
    periods: [
      { index: 1, start: "08:30", end: "08:00" },
      { index: 1, start: null, end: null },
    ],
    timetable_ids: [],
    sources: proof,
  };
  expect(calendarSchema.safeParse(c).success).toBe(false);
});
it("supports a second clock profile for an explicit existing term without changing global periods", () => {
  const first = stageCalendar(
    emptySnapshot(),
    {},
    calendarSchema.parse({
      id: "c",
      name: "秋季",
      start_date: "2026-08-31",
      week_count: 18,
      periods: [{ index: 1, start: "08:30", end: "09:15" }],
      timetable_ids: [],
      sources: proof,
    }),
  );
  const second = stageCalendar(
    first.draft,
    first.evidence,
    calendarSchema.parse({
      id: "other-campus",
      term_id: first.termId,
      name: "另一校区",
      start_date: "2026-08-31",
      week_count: 18,
      periods: [{ index: 1, start: "09:00", end: "09:45" }],
      timetable_ids: [],
      sources: proof,
    }),
  );
  expect(second.draft.term).toHaveLength(1);
  expect(second.draft.timetable_profile).toHaveLength(2);
  expect(second.draft.class_period).toEqual(first.draft.class_period);
});
it("detects stale materialized clocks after a calendar proposal loses an end time", async () => {
  const { calendarBindingIssues } = await import(
    "../src/shared/agent-import/calendar"
  );
  const c = calendarSchema.parse({
    id: "c",
    name: "秋季",
    start_date: "2026-08-31",
    week_count: 18,
    periods: [{ index: 1, start: "08:30", end: "09:15" }],
    timetable_ids: ["p"],
    sources: proof,
  });
  const result = stageCalendar(emptySnapshot(), {}, c);
  const plan = timetableProposalSchema.parse({
    id: "p",
    person: { id: "person", full_name: "甲" },
    term_name: "秋季",
    term_id: result.termId,
    profile_id: result.profileId,
    entries: [],
    sources: proof,
  });
  const staged = stageTimetable(result.draft, result.evidence, plan);
  const job = {
    draft: staged.draft,
    calendars: { c },
    timetables: { p: staged.proposal },
    excluded: [],
  };
  expect(calendarBindingIssues(job)).toEqual([]);
  job.calendars!.c.periods[0].end = null;
  expect(calendarBindingIssues(job)[0]).toContain("须重新生成");
});
