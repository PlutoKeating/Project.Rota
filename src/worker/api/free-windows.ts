import { Hono } from "hono";
import { MAX_DURATION_MINUTES, MIN_DURATION_MINUTES, parseClock } from "../../shared/free-windows";
import type { FreeWindowMode } from "../../shared/types";
import { loadFreeWindows, loadMealBlocks } from "../domain/free-windows";
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

const MODES: readonly FreeWindowMode[] = ["all", "quorum", "meal"];

/** 全组织统一的饭点（只读）；排班课表视图与找时间面板用来画饭点。 */
freeWindows.get("/meal-blocks", async (c) => c.json({ items: await loadMealBlocks(c.env.CONFIG) }));

/** 只读计算：给定时长的活动在接下来几天里最合适的 M 个时间。不写库、不审计。 */
freeWindows.post("/free-windows", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const personIds = idList(body.personIds, "personIds");
  if (personIds.length === 0 || personIds.length > MAX_PEOPLE) throw badRequest(`人员须为 1–${MAX_PEOPLE} 人`);
  const requiredPersonIds = idList(body.requiredPersonIds, "requiredPersonIds");
  const people = new Set(personIds);
  if (requiredPersonIds.some((id) => !people.has(id))) throw badRequest("必到人员须在统计人员中");

  const dayStartMinutes = clock(body.dayStart, "dayStart", "08:00");
  const dayEndMinutes = clock(body.dayEnd, "dayEnd", "22:00");

  let weekdays = [1, 2, 3, 4, 5, 6, 7];
  if (body.weekdays !== undefined && body.weekdays !== null) {
    if (!Array.isArray(body.weekdays) || body.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
      throw badRequest("weekdays 须为 1–7 的整数数组");
    weekdays = [...new Set(body.weekdays as number[])];
    if (weekdays.length === 0) throw badRequest("至少选择一个星期");
  }

  const durationMinutes = intIn(body.durationMinutes, "durationMinutes", MIN_DURATION_MINUTES, MAX_DURATION_MINUTES, 60);
  if (durationMinutes % 15 !== 0) throw badRequest("durationMinutes 须为 15 的整数倍");
  if (dayEndMinutes - dayStartMinutes < durationMinutes) throw badRequest("每日范围短于活动时长");
  const mode = (body.mode ?? "all") as FreeWindowMode;
  if (!MODES.includes(mode)) throw badRequest("mode 须为 all / quorum / meal");
  const minAttendees = mode === "quorum" ? intIn(body.minAttendees, "minAttendees", 1, personIds.length, 1) : null;
  let fromDate: string | undefined;
  if (body.fromDate !== undefined && body.fromDate !== null) {
    if (typeof body.fromDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.fromDate) || Number.isNaN(Date.parse(body.fromDate)))
      throw badRequest("fromDate 须为 YYYY-MM-DD");
    fromDate = body.fromDate;
  }

  const result = await loadFreeWindows(c.env.DB, {
    personIds,
    requiredPersonIds,
    durationMinutes,
    mode,
    minAttendees,
    mealBlocks: await loadMealBlocks(c.env.CONFIG),
    fromDate,
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
