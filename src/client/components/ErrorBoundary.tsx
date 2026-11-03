import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./Button";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 路由变化时通过 key 重建，错误状态自然复位。 */
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 兜底：后端返回了意料之外的形状时，至少给出可读错误，而不是整页白屏。
 * 具体接口错误由页面自己的 ListState 处理，这里只接渲染期异常。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("页面渲染失败", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 dark:border-rose-500/30 dark:bg-rose-500/10">
          <h2 className="text-sm font-semibold text-rose-800 dark:text-rose-200">页面渲染出错</h2>
          <p className="mt-1 text-xs break-words text-rose-600 dark:text-rose-300/90">
            {this.state.error.message || "未知错误"}
          </p>
          <p className="mt-1 text-[11px] text-rose-500/80 dark:text-rose-300/70">
            常见原因是后端接口返回的字段与前端类型不一致（例如列表缺少 items）。
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => this.setState({ error: null })}>
              重试
            </Button>
            <a
              href="#/"
              className="inline-flex items-center rounded-lg border border-rose-300 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-500/40 dark:text-rose-200 dark:hover:bg-rose-500/10"
            >
              回到概览
            </a>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
