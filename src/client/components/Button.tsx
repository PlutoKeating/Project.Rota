import type { ButtonHTMLAttributes } from "react";
import { cx } from "../lib/cx";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  loading?: boolean;
}

const BASE =
  "inline-flex shrink-0 whitespace-nowrap items-center justify-center gap-1.5 rounded-lg font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-indigo-600 text-white shadow-sm hover:bg-indigo-500 active:bg-indigo-700",
  secondary:
    "border border-slate-300 bg-white text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
  ghost:
    "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white",
  danger:
    "bg-rose-600 text-white shadow-sm hover:bg-rose-500 active:bg-rose-700",
};

const SIZES = {
  sm: "px-2.5 py-1.5 text-xs",
  md: "px-3.5 py-2 text-sm",
} as const;

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  disabled,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      className={cx(BASE, SIZES[size], VARIANTS[variant], className)}
    >
      {loading ? <Spinner size="sm" /> : null}
      {children}
    </button>
  );
}
