/**
 * 排班打分。v1 不做全局求解（不用 CP-SAT），只用可解释的加权打分 + 贪心：
 *
 *   硬过滤：没有空闲、冷却期内（除非人工指定）
 *   软评分：公平缺口 + 饥饿补偿 + 偏好 + 人工优先级 − 近期连排惩罚
 *
 * 每一次打分都留下 breakdown，写进 Assignment.reason。
 * 公平争议靠这份明细复盘，而不是靠"系统说的"。
 */

export interface Candidate {
  personId: string;
  /** 本窗口内可被排的分钟数（课表 + 请假 + 跨部门占用扣除后的净值） */
  freeMinutes: number;
  /** 已排次数，含历史结转 carry_over */
  assignedShifts: number;
  lastAssignedAt?: string;
  /** -1 不喜 … +1 偏好 */
  preference: number;
  /** 0 无 … 3 最高（考研、骨干、临时指定） */
  manualPriority: number;
}

export interface Weights {
  fairness: number;
  starvation: number;
  preference: number;
  priority: number;
  recency: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  fairness: 0.45,
  starvation: 0.3,
  preference: 0.15,
  priority: 0.1,
  recency: 0.2,
};

export interface ScoringContext {
  shiftId: string;
  totalShifts: number;
  totalFreeMinutes: number;
  participantCount: number;
  now: string;
  cooldownDays: number;
  weights?: Partial<Weights>;
}

export type Exclusion = "cooldown" | "no_free_time";

export interface ScoreBreakdown {
  target: number;
  deficit: number;
  fairness: number;
  starvation: number;
  preference: number;
  priority: number;
  recency: number;
  score: number;
  excluded?: Exclusion;
}

const DAY_MS = 86_400_000;

export function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** FNV-1a：稳定、无依赖，保证同输入同顺序，重跑结果一致。 */
export function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 目标次数按空闲时长分摊：时间多的人多排，时间少的人少排，
 * 这样"公平"不是绝对平均，而是与可付出能力成比例。
 */
export function expectedShare(candidate: Candidate, ctx: ScoringContext): number {
  if (ctx.totalFreeMinutes > 0) return candidate.freeMinutes / ctx.totalFreeMinutes;
  return 1 / Math.max(1, ctx.participantCount);
}

export function scoreCandidate(candidate: Candidate, ctx: ScoringContext): ScoreBreakdown {
  const weights: Weights = { ...DEFAULT_WEIGHTS, ...ctx.weights };
  const empty: ScoreBreakdown = {
    target: 0,
    deficit: 0,
    fairness: 0,
    starvation: 0,
    preference: 0,
    priority: 0,
    recency: 0,
    score: 0,
  };

  if (candidate.freeMinutes <= 0) return { ...empty, excluded: "no_free_time" };

  const daysSinceLast = candidate.lastAssignedAt
    ? daysBetween(candidate.lastAssignedAt, ctx.now)
    : Number.POSITIVE_INFINITY;

  const overridden = candidate.manualPriority > 0;
  if (ctx.cooldownDays > 0 && daysSinceLast < ctx.cooldownDays && !overridden) {
    return { ...empty, excluded: "cooldown" };
  }

  const share = expectedShare(candidate, ctx);
  const target = ctx.totalShifts * share;
  const deficit = target - candidate.assignedShifts;

  // 归一化到约 [-1, 1]，避免总班次变化时权重失真
  const fairnessTerm = deficit / Math.max(1, ctx.totalShifts);

  // 一次都没排过的人优先；超过三周没排的同样触发
  const starving = candidate.assignedShifts === 0 || daysSinceLast > 21 ? 1 : 0;

  const recency = ctx.cooldownDays > 0 && Number.isFinite(daysSinceLast)
    ? clamp01(1 - daysSinceLast / ctx.cooldownDays)
    : 0;

  const priorityTerm = clamp01(candidate.manualPriority / 3);

  const score =
    weights.fairness * fairnessTerm +
    weights.starvation * starving +
    weights.preference * candidate.preference +
    weights.priority * priorityTerm -
    weights.recency * recency;

  return {
    target,
    deficit,
    fairness: weights.fairness * fairnessTerm,
    starvation: weights.starvation * starving,
    preference: weights.preference * candidate.preference,
    priority: weights.priority * priorityTerm,
    recency: -weights.recency * recency,
    score,
  };
}

export interface Ranked {
  personId: string;
  breakdown: ScoreBreakdown;
}

/** 分数降序；同分时用 (shiftId, personId) 的稳定哈希决定，保证可复现。 */
export function rankCandidates(candidates: Candidate[], ctx: ScoringContext): Ranked[] {
  const ranked = candidates
    .map((candidate) => ({ personId: candidate.personId, breakdown: scoreCandidate(candidate, ctx) }))
    .filter((entry) => entry.breakdown.excluded === undefined);

  ranked.sort((a, b) => {
    const delta = b.breakdown.score - a.breakdown.score;
    if (Math.abs(delta) > 1e-9) return delta;
    return stableHash(ctx.shiftId + a.personId) - stableHash(ctx.shiftId + b.personId);
  });

  return ranked;
}

export function pickAssignee(candidates: Candidate[], ctx: ScoringContext): Ranked | null {
  return rankCandidates(candidates, ctx)[0] ?? null;
}
