import type { ReactNode } from "react";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { Spinner } from "./Spinner";

export interface ListStateProps {
  loading: boolean;
  error: string | null;
  /** 加载成功但列表为空。 */
  empty: boolean;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  children: ReactNode;
}

/**
 * 列表三态：loading / error / empty。
 * 把重复的样板收敛到一处，保证每个页面观感一致。
 */
export function ListState({
  loading,
  error,
  empty,
  onRetry,
  emptyTitle = "暂无数据",
  emptyDescription,
  emptyAction,
  children,
}: ListStateProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500 dark:text-slate-400">
        <Spinner size="sm" />
        加载中…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm dark:border-rose-500/30 dark:bg-rose-500/10">
        <p className="font-medium text-rose-700 dark:text-rose-300">加载失败</p>
        <p className="mt-1 text-xs break-words text-rose-600 dark:text-rose-300/90">{error}</p>
        {onRetry ? (
          <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
            重试
          </Button>
        ) : null}
      </div>
    );
  }

  if (empty) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
      />
    );
  }

  return <>{children}</>;
}
