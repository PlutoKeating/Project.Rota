import { describe, it, expect } from "vitest";
import {
  recordCoverage,
  completePages,
  type CoverageState,
} from "../src/shared/agent-import/coverage";
describe("file read coverage", () => {
  it("does not call a nine-column sheet complete after reading eight columns", () => {
    const s: CoverageState = {};
    recordCoverage(s, [
      { key: "page:2", extent: [0, 0, 9, 7], region: [0, 0, 8, 7] },
    ]);
    expect(completePages(s)).toEqual([]);
    recordCoverage(s, [
      { key: "page:2", extent: [0, 0, 9, 7], region: [8, 0, 9, 7] },
    ]);
    expect(completePages(s)).toEqual([2]);
  });
  it("requires all text chunks including the leading chunk and footer", () => {
    const s: CoverageState = {};
    recordCoverage(s, [
      { key: "page:1", extent: [0, 0, 30000, 1], region: [24000, 0, 30000, 1] },
      { key: "outside", extent: [0, 0, 10, 1], region: [0, 0, 5, 1] },
    ]);
    expect(completePages(s)).toEqual([]);
    recordCoverage(s, [
      { key: "page:1", extent: [0, 0, 30000, 1], region: [0, 0, 24000, 1] },
    ]);
    expect(completePages(s)).toEqual([]);
    recordCoverage(s, [
      { key: "outside", extent: [0, 0, 10, 1], region: [5, 0, 10, 1] },
    ]);
    expect(completePages(s)).toEqual([1]);
  });
  it("detects gaps between image crops and accepts complete overlapping coverage", () => {
    const s: CoverageState = {};
    recordCoverage(s, [
      { key: "page:1", extent: [0, 0, 100, 100], region: [0, 0, 49, 100] },
      { key: "page:1", extent: [0, 0, 100, 100], region: [50, 0, 100, 100] },
    ]);
    expect(completePages(s)).toEqual([]);
    recordCoverage(s, [
      { key: "page:1", extent: [0, 0, 100, 100], region: [40, 0, 60, 100] },
    ]);
    expect(completePages(s)).toEqual([1]);
  });
});
