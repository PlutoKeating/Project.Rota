import { cx } from "../lib/cx";

export interface SpinnerProps {
  size?: "sm" | "md";
  className?: string;
}

/** 纯 CSS 旋转指示器，无第三方依赖。 */
export function Spinner({ size = "md", className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="加载中"
      className={cx(
        "inline-block animate-spin rounded-full border-2 border-current border-t-transparent align-[-0.125em]",
        size === "sm" ? "size-3.5" : "size-5",
        className,
      )}
    />
  );
}
