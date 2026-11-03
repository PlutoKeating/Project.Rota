import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";

export interface ModalProps {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  side?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
}

const dialogs: HTMLElement[] = [];
let originalOverflow = "";

const SIZES = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  xl: "sm:max-w-4xl",
} as const;

/** 自写弹层：桌面居中、手机贴底，Esc 与点遮罩关闭。 */
export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  size = "md",
  side = false,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef(document.activeElement as HTMLElement | null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const panel=panelRef.current!;
    if(dialogs.length===0){originalOverflow=document.body.style.overflow;document.getElementById('root')?.setAttribute('inert','')}
    const previousPanel=dialogs.at(-1);if(previousPanel)previousPanel.inert=true;
    dialogs.push(panel);
    const previousFocus = openerRef.current;
    const focusable = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ) ?? [],
      ).filter(el=>el.getClientRects().length>0);
    focusable()[0]?.focus();
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent): void => {
      if(dialogs.at(-1)!==panel)return;
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      const index=dialogs.indexOf(panel);if(index>=0)dialogs.splice(index,1);
      const top=dialogs.at(-1);if(top)top.inert=false;
      else {document.body.style.overflow=originalOverflow;document.getElementById('root')?.removeAttribute('inert')}
      if(previousFocus?.isConnected)previousFocus.focus();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return createPortal(
    <div
      className={
        side
          ? "fixed inset-0 z-50 flex justify-end"
          : "fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      }
    >
      <div
        className="absolute inset-0 bg-slate-900/35"
        onClick={() => closeRef.current()}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          "relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white shadow-2xl sm:rounded-2xl dark:border-slate-700 dark:bg-slate-900",
          side ? "!max-h-dvh !rounded-none sm:max-w-2xl" : SIZES[size],
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5 dark:border-slate-800">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {title}
            </h2>
            {description ? (
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => closeRef.current()}
            aria-label="关闭"
            className="-mr-1 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-indigo-500/40 focus-visible:outline-none dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              className="size-5"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          {children}
        </div>
        {footer ? (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-4 py-3 sm:px-5 dark:border-slate-800">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
