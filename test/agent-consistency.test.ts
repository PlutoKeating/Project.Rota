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
