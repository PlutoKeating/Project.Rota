import { cloneElement, isValidElement, useId } from "react";
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cx } from "../lib/cx";

/** 表单控件共用的边框/聚焦样式。 */
export const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-500 dark:disabled:bg-slate-900";

export interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/** label + 控件 + 提示/错误。 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  className,
  children,
}: FieldProps) {
  const generated = useId();
  const control = isValidElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }>(children)
    ? children
    : null;
  const id = htmlFor || control?.props.id || generated;
  return (
    <div className={cx("space-y-1.5", className)}>
      <label
        htmlFor={id}
        className="block text-xs font-medium text-slate-600 dark:text-slate-300"
      >
        {label}
        {required ? <span className="ml-0.5 text-rose-500">*</span> : null}
      </label>
      {control
        ? cloneElement(control, {
            id,
            "aria-describedby": hint || error ? `${id}-hint` : undefined,
            "aria-invalid": !!error,
          })
        : children}
      {error ? (
        <p
          id={`${id}-hint`}
          className="text-[11px] text-rose-600 dark:text-rose-400"
        >
          {error}
        </p>
      ) : hint ? (
        <p
          id={`${id}-hint`}
          className="text-[11px] text-slate-400 dark:text-slate-500"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(inputClass, className)} />;
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(inputClass, "pr-8", className)}>
      {children}
    </select>
  );
}

export function Textarea({
  className,
  rows = 3,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      rows={rows}
      className={cx(inputClass, "resize-y", className)}
    />
  );
}

export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode;
}

export function Checkbox({ label, className, ...rest }: CheckboxProps) {
  return (
    <label
      className={cx(
        "flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200",
        className,
      )}
    >
      <input
        {...rest}
        type="checkbox"
        className="size-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-600 dark:bg-slate-900"
      />
      <span>{label}</span>
    </label>
  );
}
