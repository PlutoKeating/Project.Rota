import { cx } from "../lib/cx";

export interface ScoreBarProps {
  label: string;
  value: number;
  /** 归一化上限：0.45 的公平项对 1 取比例。 */
  max?: number;
  /** 覆盖正负自动配色。 */
  tone?: "positive" | "negative" | "neutral";
  valueText?: string;
}

/**
 * 打分明细条。
 * 值可正可负（例如「近期连排惩罚」是负分），条宽取绝对值，颜色区分方向。
 */
export function ScoreBar({ label, value, max = 1, tone, valueText }: ScoreBarProps) {
  const safeValue = Number.isFinite(value) ? value : 0;
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.min(1, Math.abs(safeValue) / safeMax);
  const resolvedTone = tone ?? (safeValue < 0 ? "negative" : safeValue > 0 ? "positive" : "neutral");
  const fillClass =
    resolvedTone === "negative"
      ? "bg-rose-500"
      : resolvedTone === "positive"
        ? "bg-emerald-500"
        : "bg-slate-300 dark:bg-slate-600";

  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11px] text-slate-500 dark:text-slate-400">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <span
          className={cx("block h-full rounded-full transition-all", fillClass)}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </span>
      <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
        {valueText ?? safeValue.toFixed(2)}
      </span>
    </div>
  );
}
