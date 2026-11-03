/** 极简的 className 合并：过滤 falsy 值后拼接，避免引入 clsx 之类的新依赖。 */
export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).join(" ");
}
