import type { ReactNode } from "react";
import { cx } from "../lib/cx";

export interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/** 页面内容的基本容器：标题行 + 内容区。 */
export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: CardProps) {
  const hasHeader = Boolean(title) || Boolean(description) || Boolean(actions);
  return (
    <section
      className={cx(
        "overflow-hidden rounded-[14px] border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
        className,
      )}
    >
      {hasHeader ? (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5 dark:border-slate-800">
          <div className="min-w-0">
            {title ? (
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </header>
      ) : null}
      <div className={bodyClassName ?? "p-4 sm:p-5"}>{children}</div>
    </section>
  );
}
