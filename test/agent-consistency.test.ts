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
it("requires explanations for every remaining disagreement, including legitimate different classes", () => {
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
