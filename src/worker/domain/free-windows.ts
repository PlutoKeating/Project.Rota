import type { FreeWindowPerson, FreeWindowsResult } from "../../shared/types";
import {
  CELL_MINUTES,
  buildDays,
  findFreeWindows,
  toLocalIso,
  type BusyInterval,
  type TimeInterval,
} from "../../shared/free-windows";
import { badRequest, dbAll } from "../lib/core";
import { addDays } from "./time";

/** 固定北京时间（见 ARCHITECTURE「已知边界」）。 */
const OFFSET_MINUTES = 480;
const MINUTE_MS = 60_000;

export interface FreeWindowsQuery {
  personIds: string[];
  requiredPersonIds: string[];
  days: number;
  count: number;
  dayStartMinutes: number;
  dayEndMinutes: number;
  weekdays: number[];
  bufferMinutes: number;
}

interface TermRow {
  id: string;
  startDate: string | null;
  weekCount: number | null;
}

/**
 * 取数并计算共同空闲时段。忙碌 = 课程 occurrence + 个人课表事件 + 已批准请假/黑名单
 * + 任意部门的有效排班；当天没有学期覆盖或此人在该学期没有任何课表数据时记为未知。
 * 一次性按时间范围取回所有人的区间，计算在内存里完成（见 shared/free-windows.ts）。
 */
export async function loadFreeWindows(
  db: D1Database,
  query: FreeWindowsQuery,
  now = Date.now(),
): Promise<FreeWindowsResult> {
  const ids = JSON.stringify(query.personIds);
  const rows = await dbAll<{ id: string; fullName: string }>(
    db,
    "select id, full_name from person where id in (select value from json_each(?))",
    ids,
  );
  const names = new Map(rows.map((row) => [row.id, row.fullName]));
  const missing = query.personIds.filter((id) => !names.has(id));
  if (missing.length > 0) throw badRequest(`人员不存在：${missing.slice(0, 5).join("、")}`);
  const requiredSet = new Set(query.requiredPersonIds);
  const people: FreeWindowPerson[] = query.personIds.map((id) => ({
    id,
    fullName: names.get(id) ?? id,
    required: requiredSet.has(id),
  }));

  const days = buildDays({
    now,
    days: query.days,
    dayStartMinutes: query.dayStartMinutes,
    dayEndMinutes: query.dayEndMinutes,
    weekdays: query.weekdays,
    offsetMinutes: OFFSET_MINUTES,
  });
  const rangeStart = days[0]?.start ?? now;
  const rangeEnd = days.at(-1)?.end ?? now;
  const base = { rangeStart: toLocalIso(rangeStart), rangeEnd: toLocalIso(rangeEnd), cellMinutes: CELL_MINUTES, people };
  if (days.length === 0) return { ...base, windows: [], heatmap: [], emptyReason: "no_days" };

  const buffer = query.bufferMinutes * MINUTE_MS;
  const from = toLocalIso(rangeStart - buffer);
  const to = toLocalIso(rangeEnd + buffer);

  const [courseRows, eventRows, leaveRows, assignmentRows, terms, coverage] = await Promise.all([
    dbAll<{ personId: string; startsAt: string; endsAt: string; label: string }>(
      db,
      `select e.person_id, s.starts_at, s.ends_at, c.name as label
         from enrollment e
         join course c on c.id = e.course_id
         join course_meeting m on m.course_id = c.id
         join course_occurrence o on o.meeting_id = m.id
         join slot s on s.id = o.slot_id
        where e.status = 'active' and o.status != 'cancelled'
          and e.person_id in (select value from json_each(?))
          and julianday(s.starts_at) < julianday(?) and julianday(s.ends_at) > julianday(?)`,
      ids, to, from,
    ),
    dbAll<{ personId: string; startsAt: string; endsAt: string; label: string }>(
      db,
      `select e.person_id, e.starts_at, e.ends_at, t.name as label
         from timetable_event e
         join timetable_entry t on t.id = e.entry_id
        where e.person_id in (select value from json_each(?))
          and julianday(e.starts_at) < julianday(?) and julianday(e.ends_at) > julianday(?)`,
      ids, to, from,
    ),
    dbAll<{ personId: string; startsAt: string; endsAt: string; kind: string; reason: string | null }>(
      db,
      `select person_id, starts_at, ends_at, kind, reason
         from unavailability
        where status = 'approved'
          and person_id in (select value from json_each(?))
          and julianday(starts_at) < julianday(?) and julianday(ends_at) > julianday(?)`,
      ids, to, from,
    ),
    dbAll<{ personId: string; startsAt: string; endsAt: string; label: string }>(
      db,
      `select a.person_id, s.starts_at, s.ends_at, t.title as label
         from assignment a
         join shift s on s.id = a.shift_id
         join task t on t.id = s.task_id
        where a.status in ('proposed', 'confirmed', 'completed') and s.status != 'cancelled'
          and a.person_id in (select value from json_each(?))
          and julianday(s.starts_at) < julianday(?) and julianday(s.ends_at) > julianday(?)`,
      ids, to, from,
    ),
    dbAll<TermRow>(db, "select id, start_date, week_count from term where start_date is not null and week_count is not null"),
    dbAll<{ personId: string; termId: string }>(
      db,
      `select person_id, term_id from enrollment
        where status = 'active' and person_id in (select value from json_each(?))
       union
       select person_id, term_id from timetable_entry
        where person_id in (select value from json_each(?))`,
      ids,
      ids,
    ),
  ]);

  const busy = new Map<string, BusyInterval[]>();
  const push = (personId: string, startsAt: string, endsAt: string, reason: BusyInterval["reason"], label: string | null) => {
    const start = Date.parse(startsAt) - buffer;
    const end = Date.parse(endsAt) + buffer;
    if (!(end > start)) return;
    const list = busy.get(personId);
    const item = { start, end, reason, label };
    if (list) list.push(item);
    else busy.set(personId, [item]);
  };
  for (const row of courseRows) push(row.personId, row.startsAt, row.endsAt, "course", row.label);
  for (const row of eventRows) push(row.personId, row.startsAt, row.endsAt, "course", row.label);
  for (const row of leaveRows)
    push(row.personId, row.startsAt, row.endsAt, row.kind === "blacklist" ? "blacklist" : "leave", row.reason);
  for (const row of assignmentRows) push(row.personId, row.startsAt, row.endsAt, "assignment", row.label);

  // 当天由哪个学期覆盖；没有覆盖、或此人在该学期没有任何课表数据 → 未知。
  const hasData = new Set(coverage.map((row) => `${row.personId}|${row.termId}`));
  const termOf = (date: string): string | null => {
    for (const term of terms) {
      if (!term.startDate || !term.weekCount) continue;
      if (date >= term.startDate && date < addDays(term.startDate, term.weekCount * 7)) return term.id;
    }
    return null;
  };
  const unknown = new Map<string, TimeInterval[]>();
  for (const day of days) {
    const termId = termOf(day.date);
    for (const person of people) {
      if (termId && hasData.has(`${person.id}|${termId}`)) continue;
      const list = unknown.get(person.id);
      const item = { start: day.start, end: day.end };
      if (list) list.push(item);
      else unknown.set(person.id, [item]);
    }
  }

  const result = findFreeWindows({ people, days, busy, unknown, count: query.count, offsetMinutes: OFFSET_MINUTES });
  return { ...base, ...result };
}
