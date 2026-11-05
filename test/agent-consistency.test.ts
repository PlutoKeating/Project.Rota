import { expect, it } from "vitest";
import {
  courseConflicts,
  validateCheckedVariants,
  validateConsistencyReview,
} from "../src/shared/agent-import/consistency";
const plans = [
  {
    id: "a",
    person: { id: "a", full_name: "甲" },
    term_name: "秋",
    entries: [{ name: "社会公益Ⅰ", teacher: "李静炎" }],
    sources: [],
  },
  {
    id: "b",
    person: { id: "b", full_name: "乙" },
    term_name: "秋",
    entries: [{ name: "社会公益Ⅰ", teacher: "李静爽" }],
    sources: [],
  },
];
it("exposes inconsistent teachers across independently reviewed people without choosing a winner", () => {
  const conflicts = courseConflicts(plans as any);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].variants.map((v) => v.teacher)).toEqual([
    "李静炎",
    "李静爽",
  ]);
  expect(() => validateConsistencyReview(conflicts, [])).toThrow("跨课表");
  expect(() =>
    validateConsistencyReview(conflicts, [
      {
        key: conflicts[0].key,
        resolution: "unresolved",
        explanation: "需核对同一教师工号的原图",
        checked_variants: [],
      },
    ]),
  ).not.toThrow();
});
it("does not treat repeated meetings or corrected spellings as a disagreement", () => {
  expect(
    courseConflicts([
      plans[0],
      { ...plans[1], entries: plans[0].entries },
    ] as any),
  ).toEqual([]);
});
it("requires explanations for every remaining disagreement when context is unknown", () => {
  const conflicts = courseConflicts(plans as any);
  expect(() =>
    validateConsistencyReview(conflicts, [
      {
        key: "obsolete",
        resolution: "different_context",
        explanation: "其他班级",
        checked_variants: [],
      },
    ]),
  ).toThrow();
});

it("rejects explanations that reference invented teachers instead of actual variants", () => {
  const group = courseConflicts(plans as any)[0];
  expect(() =>
    validateCheckedVariants(group, {
      key: group.key,
      resolution: "different_context",
      explanation: "不同班级",
      checked_variants: [
        { timetable_id: "a", teacher: "编造的人名" },
        { timetable_id: "b", teacher: "李静爽" },
      ],
    }),
  ).toThrow("不能编造");
  expect(() =>
    validateCheckedVariants(group, {
      key: group.key,
      resolution: "unresolved",
      explanation: "需回看",
      checked_variants: group.variants.map((v) => ({
        timetable_id: v.timetable_id,
        teacher: v.teacher,
      })),
    }),
  ).not.toThrow();
});

import { canonical } from "../src/shared/agent-import/model";
import { retainedConsistencyReviews, type ConsistencyReview } from "../src/shared/agent-import/consistency";
it("reuses checkpointed reviews only while the corresponding facts still match", () => {
  const groups = courseConflicts(plans as any);
  const review: ConsistencyReview = {
    key: groups[0].key, resolution: "unresolved", explanation: "待确认",
    checked_variants: groups[0].variants.map(({ timetable_id, teacher }) => ({ timetable_id, teacher })),
  };
  const saved = { [review.key]: { signature: canonical(groups[0]), review } };
  expect(retainedConsistencyReviews(groups, saved)).toEqual([review]);
  const changed = structuredClone(groups);
  changed[0].variants[0].teacher = "更正教师";
  expect(retainedConsistencyReviews(changed, saved)).toEqual([]);
  expect(retainedConsistencyReviews([], saved)).toEqual([]);
  expect(retainedConsistencyReviews(groups)).toEqual([]);
  const unrelated = structuredClone(groups[0]);
  unrelated.key = "teacher:另一课程";
  expect(retainedConsistencyReviews([...groups, unrelated], saved)).toEqual([review]);
});


it("resolves compact variant indices to the complete persisted evidence", () => {
  const group = courseConflicts(plans as any)[0];
  const input: ConsistencyReview = { key: group.key, resolution: "different_context",
    explanation: "已回看原件", checked_variants: [],
    checked_variant_indices: group.variants.map((_, i) => i).reverse() };
  const result = validateCheckedVariants(group, input);
  expect(result.checked_variants).toEqual([...group.variants].reverse().map(({ timetable_id, teacher }) => ({ timetable_id, teacher })));
  expect(result.checked_variant_indices).toBeUndefined();
  expect(input.checked_variants).toEqual([]);
  for (const indices of [[], [0, 0], [0, 199]])
    expect(() => validateCheckedVariants(group, { ...input, checked_variant_indices: indices })).toThrow("核对编号");
  expect(() => validateCheckedVariants(group, { ...input, checked_variants: result.checked_variants })).toThrow("不能同时");
});

import { consistencyBatch } from "../src/shared/agent-import/consistency";
it("bounds source fanout without splitting or omitting conflict groups", () => {
  const base = courseConflicts(plans as any)[0];
  const groups = Array.from({ length: 6 }, (_, i) => ({ ...base, key: String(i), variants: [
    { ...base.variants[0], sources: Array.from({ length: 3 }, (_, j) => ({ source: `${i}-${j}`, locator: "page:1", explanation: "test", inferred: false })) },
  ] }));
  expect(consistencyBatch(groups).map((g) => g.key)).toEqual(["0", "1"]);
  expect(consistencyBatch(groups.slice(2)).map((g) => g.key)).toEqual(["2", "3"]);
  const large = { ...groups[0], variants: groups.flatMap((g) => g.variants) };
  expect(consistencyBatch([large, groups[1]])).toEqual([large, groups[1]]);
});

it("reuses an oversized source set for up to five groups without increasing image fanout", () => {
  const base = courseConflicts(plans as any)[0];
  const sources = Array.from({ length: 10 }, (_, i) => ({ source: String(i), locator: "page:1", explanation: "test", inferred: false }));
  const groups = Array.from({ length: 7 }, (_, i) => ({ ...base, key: String(i), variants: [
    { ...base.variants[0], sources },
  ] }));
  expect(consistencyBatch(groups)).toEqual(groups.slice(0, 5));
  expect(consistencyBatch(groups.slice(5))).toEqual(groups.slice(5));
  const moreSources = { ...groups[1], variants: [{ ...groups[1].variants[0], sources: [...sources, { ...sources[0], source: "new" }] }] };
  expect(consistencyBatch([groups[0], moreSources])).toEqual([groups[0]]);
});

it("invalid compact review indices explain the exact group and required per-table variant indices", () => {
  const group = courseConflicts(plans as any)[0];
  expect(() => validateCheckedVariants(group, { key: group.key, resolution: "different_context", explanation: "核对", checked_variant_indices: [0], checked_variants: [] }))
    .toThrow(`当前组${group.key}须提交checked_variant_indices=[0,1]`);
});

const scopedPlans = () => plans.map((plan) => ({ ...plan, term_id: "fall", person: { ...plan.person, class_name: "一班" }, entries: plan.entries.map((entry) => ({ ...entry, weekday: 1, period_from: 1, period_to: 2, weeks: [1, 2] })) }));
it.each(["class", "term", "weekday", "period", "week"])("does not treat a distinct %s teaching context as a conflicting teacher", (dimension) => {
  const input = scopedPlans();
  if (dimension === "class") input[1].person.class_name = "二班";
  if (dimension === "term") input[1].term_id = "spring";
  if (dimension === "weekday") input[1].entries[0].weekday = 2;
  if (dimension === "period") { input[1].entries[0].period_from = 3; input[1].entries[0].period_to = 4; }
  if (dimension === "week") input[1].entries[0].weeks = [3, 4];
  expect(courseConflicts(input as any)).toEqual([]);
});
it("retains same-context disagreements and excludes unrelated third-class variants", () => {
  const input = scopedPlans();
  input[1].entries[0].weeks = [2, 3];
  const unrelated = { ...input[0], id: "c", person: { id: "c", full_name: "丙", class_name: "二班" }, entries: [{ ...input[0].entries[0], teacher: "另一教师" }] };
  const groups = courseConflicts([...input, unrelated] as any);
  expect(groups).toHaveLength(1);
  expect(groups[0].variants.map((v) => v.timetable_id)).toEqual(["a", "b"]);
  expect(() => validateConsistencyReview(groups, [])).toThrow("跨课表");
});
it("unknown class or time cannot establish separate teaching contexts", () => {
  const input = scopedPlans();
  expect(courseConflicts([{ ...input[0], person: { id: "a", full_name: "甲" } }, input[1]] as any)).toHaveLength(1);
  expect(courseConflicts([input[0], { ...input[1], entries: [{ ...input[1].entries[0], weeks: null, weekday: null, period_from: null, period_to: null }] }] as any)).toHaveLength(1);
});
it("changing overlapping meetings invalidates their old teacher review", () => {
  const input = scopedPlans(), groups = courseConflicts(input as any);
  const review: ConsistencyReview = { key: groups[0].key, resolution: "unresolved", explanation: "待核对", checked_variants: [] };
  const saved = { [review.key]: { signature: canonical(groups[0]), review } };
  input[1].entries[0].weeks = [2, 3];
  expect(retainedConsistencyReviews(courseConflicts(input as any), saved)).toEqual([]);
});
