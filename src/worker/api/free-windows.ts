import { Hono } from "hono";
import { parseClock } from "../../shared/free-windows";
import { loadFreeWindows } from "../domain/free-windows";
import type { Env } from "../env";
import { badRequest, readJson } from "../lib/core";

const freeWindows = new Hono<{ Bindings: Env }>();

const MAX_PEOPLE = 300;

function intIn(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw badRequest(`${field} 须为 ${min}–${max} 的整数`);
  return value;
}

function idList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item || item.length > 64))
    throw badRequest(`${field} 须为人员 ID 数组`);
  return [...new Set(value as string[])];
}

function clock(value: unknown, field: string, fallback: string): number {
  const raw = value === undefined || value === null ? fallback : value;
  const minutes = typeof raw === "string" ? parseClock(raw) : null;
  if (minutes === null || minutes % 15 !== 0) throw badRequest(`${field} 须为 15 分钟对齐的 HH:mm`);
  return minutes;
}

/** 只读计算：接下来 N 天内最多人整段有空的 M 个不重叠时段。不写库、不审计。 */
freeWindows.post("/free-windows", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const personIds = idList(body.personIds, "personIds");
  if (personIds.length === 0 || personIds.length > MAX_PEOPLE) throw badRequest(`人员须为 1–${MAX_PEOPLE} 人`);
  const requiredPersonIds = idList(body.requiredPersonIds, "requiredPersonIds");
  const people = new Set(personIds);
  if (requiredPersonIds.some((id) => !people.has(id))) throw badRequest("必到人员须在统计人员中");

  const dayStartMinutes = clock(body.dayStart, "dayStart", "08:00");
  const dayEndMinutes = clock(body.dayEnd, "dayEnd", "22:00");
  if (dayEndMinutes - dayStartMinutes < 60) throw badRequest("每日窗口至少 1 小时");

  let weekdays = [1, 2, 3, 4, 5, 6, 7];
  if (body.weekdays !== undefined && body.weekdays !== null) {
    if (!Array.isArray(body.weekdays) || body.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
      throw badRequest("weekdays 须为 1–7 的整数数组");
    weekdays = [...new Set(body.weekdays as number[])];
    if (weekdays.length === 0) throw badRequest("至少选择一个星期");
  }

  const result = await loadFreeWindows(c.env.DB, {
    personIds,
    requiredPersonIds,
    days: intIn(body.days, "days", 1, 28, 7),
    count: intIn(body.count, "count", 1, 20, 5),
    dayStartMinutes,
    dayEndMinutes,
    weekdays,
    bufferMinutes: intIn(body.bufferMinutes, "bufferMinutes", 0, 120, 0),
  });
  return c.json(result);
});

export { freeWindows };
