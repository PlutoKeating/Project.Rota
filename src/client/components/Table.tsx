import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cx } from "../lib/cx";

export interface TableProps {
  children: ReactNode;
  /** 窄屏时表格的最小宽度，超出会横向滚动。 */
  minWidth?: string;
  className?: string;
}

export function Table({ children, minWidth = "min-w-[640px]", className }: TableProps) {
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <div className="inline-block min-w-full align-middle">
        <table className={cx("w-full border-collapse text-left text-sm", minWidth, className)}>{children}</table>
      </div>
    </div>
  );
}

export function Th({ className, children, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      {...rest}
      scope="col"
      className={cx(
        "whitespace-nowrap px-3 py-2 text-xs font-medium text-slate-500 dark:text-slate-400",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ className, children, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td {...rest} className={cx("px-3 py-2.5 align-middle text-slate-700 dark:text-slate-200", className)}>
      {children}
    </td>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  className?: string;
  render: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  minWidth?: string;
  /** 行点击（例如点开任务详情）。 */
  onRowClick?: (row: T) => void;
}

/** 由列定义驱动的表格，页面不用手写 thead/tbody。 */
export function DataTable<T>({ columns, rows, rowKey, minWidth, onRowClick }: DataTableProps<T>) {
  return (
    <Table minWidth={minWidth}>
      <thead>
        <tr className="border-b border-slate-200 dark:border-slate-700">
          {columns.map((column) => (
            <Th key={column.key} className={column.className}>
              {column.header}
            </Th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map((row) => (
          <tr
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={cx(
              "transition-colors",
              onRowClick
                ? "cursor-pointer hover:bg-indigo-50/60 dark:hover:bg-indigo-500/10"
                : "hover:bg-slate-50/70 dark:hover:bg-slate-800/40",
            )}
          >
            {columns.map((column) => (
              <Td key={column.key} className={column.className}>
                {column.render(row)}
              </Td>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
