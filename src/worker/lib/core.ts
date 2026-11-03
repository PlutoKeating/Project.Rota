import type { Context } from "hono";

/** 业务错误：路由里 throw，统一由 index.ts 的 onError 转成 JSON。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, "bad_request", message);
}

export function notFound(message = "资源不存在"): HttpError {
  return new HttpError(404, "not_found", message);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, "conflict", message);
}

// ---------------------------------------------------------------------------
// ID 与时间
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID：26 字符，前 10 位时间有序，便于按创建顺序排序。 */
export function ulid(now = Date.now()): string {
  let time = "";
  let rest = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = "";
  for (const byte of bytes) random += CROCKFORD[byte % 32];
  return time + random;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 行 → 对象
// ---------------------------------------------------------------------------

const toCamel = (key: string): string => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const toSnake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export function camelize<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[toCamel(key)] = value;
  return out as T;
}

export function camelizeAll<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((row) => camelize<T>(row));
}

/** 只用于调试与日志，不参与业务。 */
export function snakeCase(value: string): string {
  return toSnake(value);
}

export function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1" || value === "true";
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export function asString(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${field} 必须是非空字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`${field} 超过 ${max} 字符`);
  return trimmed;
}

export function optString(value: unknown, field: string, max = 2000): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw badRequest(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`${field} 超过 ${max} 字符`);
  return trimmed === "" ? null : trimmed;
}

export function asInt(value: unknown, field: string, min = Number.NEGATIVE_INFINITY): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) throw badRequest(`${field} 必须是整数`);
  if (parsed < min) throw badRequest(`${field} 不能小于 ${min}`);
  return parsed;
}

export function optInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  return asInt(value, field);
}

export function asBool(value: unknown, fallback = false): boolean {
  if (value === null || value === undefined) return fallback;
  return value === true || value === 1 || value === "1" || value === "true";
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw badRequest(`${field} 必须是 ${allowed.join(" / ")} 之一`);
  }
  return value as T;
}

export async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
}

// ---------------------------------------------------------------------------
// D1 便捷查询
// ---------------------------------------------------------------------------

type Bind = string | number | null;

export async function dbAll<T>(
  db: D1Database,
  sql: string,
  ...params: Bind[]
): Promise<T[]> {
  const { results } = await db.prepare(sql).bind(...params).all();
  return camelizeAll<T>((results ?? []) as Record<string, unknown>[]);
}

export async function dbOne<T>(
  db: D1Database,
  sql: string,
  ...params: Bind[]
): Promise<T | null> {
  const row = await db.prepare(sql).bind(...params).first<Record<string, unknown>>();
  return row ? camelize<T>(row) : null;
}

export async function dbRun(
  db: D1Database,
  sql: string,
  ...params: Bind[]
): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

/** 批量写入：D1 batch 是单事务，排班这类一致性要求高的场景必须用它。 */
export async function dbBatch(
  db: D1Database,
  statements: { sql: string; params?: Bind[] }[],
): Promise<D1Result[]> {
  if (statements.length === 0) return [];
  return db.batch(
    statements.map((s) => db.prepare(s.sql).bind(...(s.params ?? []))),
  );
}

export function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (c) => `\\${c}`);
}
