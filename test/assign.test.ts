import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHTS,
  pickAssignee,
  rankCandidates,
  scoreCandidate,
  stableHash,
  type Candidate,
  type ScoringContext,
} from "../src/worker/domain/assign";

const ctx: ScoringContext = {
  shiftId: "shift-1",
  totalShifts: 6,
  totalFreeMinutes: 1200,
  participantCount: 4,
  now: "2026-11-03T00:00:00.000Z",
  cooldownDays: 3,
};

const person = (over: Partial<Candidate> & { personId: string }): Candidate => ({
  freeMinutes: 300,
  assignedShifts: 2,
  preference: 0,
  manualPriority: 0,
  ...over,
});

describe("scoreCandidate", () => {
  it("冷却期内直接排除", () => {
    const breakdown = scoreCandidate(
      person({ personId: "a", lastAssignedAt: "2026-11-01T00:00:00.000Z" }),
      ctx,
    );
    expect(breakdown.excluded).toBe("cooldown");
  });

  it("人工指定可以越过冷却期", () => {
    const breakdown = scoreCandidate(
      person({ personId: "a", lastAssignedAt: "2026-11-01T00:00:00.000Z", manualPriority: 2 }),
      ctx,
    );
    expect(breakdown.excluded).toBeUndefined();
  });

  it("没有空闲时长的排除", () => {
    const breakdown = scoreCandidate(person({ personId: "a", freeMinutes: 0 }), ctx);
    expect(breakdown.excluded).toBe("no_free_time");
  });

  it("排得少的人得分更高", () => {
    const busy = scoreCandidate(person({ personId: "busy", assignedShifts: 6 }), ctx);
    const idle = scoreCandidate(person({ personId: "idle", assignedShifts: 0 }), ctx);
    expect(idle.score).toBeGreaterThan(busy.score);
  });

  it("空闲多的人目标次数更高", () => {
    const small = scoreCandidate(person({ personId: "s", freeMinutes: 120, assignedShifts: 0 }), ctx);
    const large = scoreCandidate(person({ personId: "l", freeMinutes: 600, assignedShifts: 0 }), ctx);
    expect(large.target).toBeGreaterThan(small.target);
    expect(large.deficit).toBeGreaterThan(small.deficit);
  });

  it("权重可覆盖", () => {
    const custom = scoreCandidate(person({ personId: "a" }), {
      ...ctx,
      weights: { fairness: 0, starvation: 0, preference: 0, priority: 0, recency: 0 },
    });
    expect(custom.score).toBe(0);
    expect(DEFAULT_WEIGHTS.fairness).toBeGreaterThan(0);
  });
});

describe("rankCandidates", () => {
  it("排除的人不进入排名", () => {
    const ranked = rankCandidates(
      [
        person({ personId: "cooldown", lastAssignedAt: "2026-11-02T00:00:00.000Z" }),
        person({ personId: "ok" }),
      ],
      ctx,
    );
    expect(ranked.map((r) => r.personId)).toEqual(["ok"]);
  });

  it("同分时结果稳定可复现", () => {
    const candidates = ["a", "b", "c", "d"].map((personId) =>
      person({ personId, assignedShifts: 0, freeMinutes: 300 }),
    );
    const first = rankCandidates(candidates, ctx).map((r) => r.personId);
    const second = rankCandidates([...candidates].reverse(), ctx).map((r) => r.personId);
    expect(first).toEqual(second);
  });

  it("pickAssignee 返回最高分", () => {
    const picked = pickAssignee(
      [person({ personId: "busy", assignedShifts: 5 }), person({ personId: "idle", assignedShifts: 0 })],
      ctx,
    );
    expect(picked?.personId).toBe("idle");
  });

  it("无人可用时返回 null", () => {
    expect(pickAssignee([person({ personId: "x", freeMinutes: 0 })], ctx)).toBeNull();
  });
});

describe("stableHash", () => {
  it("同输入同输出", () => {
    expect(stableHash("shift-1a")).toBe(stableHash("shift-1a"));
  });
  it("不同输入基本不同", () => {
    expect(stableHash("shift-1a")).not.toBe(stableHash("shift-1b"));
  });
});
