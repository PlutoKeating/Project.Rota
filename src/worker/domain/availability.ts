import type { Slot, TimetableCell, UnavailabilityKind } from "../../shared/types";
import { dbAll } from "../lib/core";

/**
 * 可用性 = 格子 − 上课 − 请假/黑名单 − 跨部门已排。
 *
 * 全部在内存里做区间比对：一个学期最多约 1700 个格子，一次性取回比在 SQL 里
 * 拼一堆 datetime 条件更清楚，也避免 D1 对带偏移字符串比较的边界问题。
 */

export type BusyReason = "course" | "leave" | "blacklist" | "cross_org";

export interface BusyInfo {
  reason: BusyReason;
  refId?: string;
  label?: string;
}

export interface AvailabilityResult {
  slots: Slot[];
  busy: Map<string, BusyInfo>;
}

const MINUTE = 60_000;

function toMs(iso: string): number {
  return Date.parse(iso);
}

interface OccurrenceRow {
  slotId: string;
  courseName: string;
}

interface AssignmentRow {
  shiftId: string;
  startsAt: string;
  endsAt: string;
}

export async function loadAvailability(
  db: D1Database,
  personId: string,
  termId: string,
  options: { week?: number | null; excludeShiftId?: string | null } = {},
): Promise<AvailabilityResult> {
  const { week = null, excludeShiftId = null } = options;

  const slotSql = week
    ? "select * from slot where term_id = ? and week_index = ? order by week_index, weekday, period_index"
    : "select * from slot where term_id = ? order by week_index, weekday, period_index";
  const slots = await dbAll<Slot>(db, slotSql, ...(week ? [termId, week] : [termId]));

  const busy = new Map<string, BusyInfo>();

  const occurrences = await dbAll<OccurrenceRow>(
    db,
    `select o.slot_id, c.name as course_name
       from enrollment e
       join course c on c.id = e.course_id
       join course_meeting m on m.course_id = c.id
       join course_occurrence o on o.meeting_id = m.id
      where e.person_id = ?
        and e.term_id = ?
        and e.status = 'active'
        and o.status != 'cancelled'`,
    personId,
    termId,
  );
  const personal = await dbAll<{ id: string; startsAt: string; endsAt: string; name: string }>(db,
    `select e.id,e.starts_at,e.ends_at,t.name from timetable_event e
     join timetable_entry t on t.id=e.entry_id where e.person_id=? and e.term_id=?`, personId, termId);
  for (const event of personal) {
    for (const slot of slots) {
      if (toMs(event.startsAt) < toMs(slot.endsAt) && toMs(event.endsAt) > toMs(slot.startsAt))
        busy.set(slot.id, { reason: "course", refId: event.id, label: event.name });
    }
  }
  for (const row of occurrences) {
    if (!busy.has(row.slotId)) busy.set(row.slotId, { reason: "course", label: row.courseName });
  }

  const leaves = await dbAll<{
    id: string;
    startsAt: string;
    endsAt: string;
    kind: UnavailabilityKind;
  }>(
    db,
    `select id, starts_at, ends_at, kind
       from unavailability
      where person_id = ? and status = 'approved'`,
    personId,
  );

  const assigned = await dbAll<AssignmentRow>(
    db,
    `select s.id as shift_id, s.starts_at, s.ends_at
       from assignment a
       join shift s on s.id = a.shift_id
      where a.person_id = ?
        and a.status in ('proposed', 'confirmed', 'completed')
        and (? is null or a.shift_id != ?)`,
    personId,
    excludeShiftId,
    excludeShiftId,
  );

  for (const slot of slots) {
    if (busy.has(slot.id)) continue;
    const start = toMs(slot.startsAt);
    const end = toMs(slot.endsAt);

    for (const leave of leaves) {
      if (toMs(leave.startsAt) < end && toMs(leave.endsAt) > start) {
        busy.set(slot.id, {
          reason: leave.kind === "blacklist" ? "blacklist" : "leave",
          refId: leave.id,
        });
        break;
      }
    }
    if (busy.has(slot.id)) continue;

    for (const item of assigned) {
      if (toMs(item.startsAt) < end && toMs(item.endsAt) > start) {
        busy.set(slot.id, { reason: "cross_org", refId: item.shiftId });
        break;
      }
    }
  }

  return { slots, busy };
}

export function isFree(busy: Map<string, BusyInfo>, slotId: string): boolean {
  return !busy.has(slotId);
}

/** 可排分钟数：空闲格子的时长之和。 */
export function freeMinutes(slots: Slot[], busy: Map<string, BusyInfo>): number {
  let total = 0;
  for (const slot of slots) {
    if (busy.has(slot.id)) continue;
    const span = toMs(slot.endsAt) - toMs(slot.startsAt);
    if (span > 0) total += span / MINUTE;
  }
  return Math.round(total);
}

/** 课表格子：带课程名与不可用原因，供前端直接渲染周视图。 */
export function toTimetableCells(
  slots: Slot[],
  busy: Map<string, BusyInfo>,
  coursesBySlot: Map<string, { courseId: string; courseName: string; location: string | null }[]>,
): TimetableCell[] {
  return slots.map((slot) => {
    const info = busy.get(slot.id);
    const courses = coursesBySlot.get(slot.id) ?? [];
    const cell: TimetableCell = {
      slotId: slot.id,
      weekday: slot.weekday,
      periodIndex: slot.periodIndex,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      courses,
    };
    if (info && info.reason !== "course") {
      cell.unavailable = { kind: info.reason === "blacklist" ? "blacklist" : "leave", reason: info.label ?? null };
    }
    return cell;
  });
}

/**
 * 批量版：一次取回所有人的占用，再在内存里按人分桶。
 * 300 人 × 1680 格 = 50 万次循环，远好过每人 4 条 SQL（1200 次往返）。
 */
export async function loadAvailabilityBatch(
  db: D1Database,
  personIds: string[],
  termId: string,
  excludeShiftId: string | null = null,
): Promise<{ slots: Slot[]; byPerson: Map<string, Map<string, BusyInfo>> }> {
  const byPerson = new Map<string, Map<string, BusyInfo>>();
  for (const id of personIds) byPerson.set(id, new Map());
  if (personIds.length === 0) return { slots: [], byPerson };

  const slots = await dbAll<Slot>(
    db,
    "select * from slot where term_id = ? order by week_index, weekday, period_index",
    termId,
  );

  const marks = "select value from json_each(?)";

  const occurrences = await dbAll<OccurrenceRow & { personId: string }>(
    db,
    `select e.person_id, o.slot_id, c.name as course_name
       from enrollment e
       join course c on c.id = e.course_id
       join course_meeting m on m.course_id = c.id
       join course_occurrence o on o.meeting_id = m.id
      where e.term_id = ? and e.status = 'active' and o.status != 'cancelled'
        and e.person_id in (${marks})`,
    termId,
    JSON.stringify(personIds),
  );

  const assignmentRows = await dbAll<AssignmentRow & { personId: string }>(
    db,
    `select a.person_id, s.id as shift_id, s.starts_at, s.ends_at
       from assignment a
       join shift s on s.id = a.shift_id
      where a.status in ('proposed', 'confirmed', 'completed')
        and (? is null or a.shift_id != ?)
        and a.person_id in (${marks})`,
    excludeShiftId,
    excludeShiftId,
    JSON.stringify(personIds),
  );

  const leaveRows = await dbAll<{
    id: string;
    personId: string;
    startsAt: string;
    endsAt: string;
    kind: UnavailabilityKind;
  }>(
    db,
    `select id, person_id, starts_at, ends_at, kind
       from unavailability
      where status = 'approved' and person_id in (${marks})`,
    JSON.stringify(personIds),
  );

  for (const row of occurrences) {
    const bucket = byPerson.get(row.personId);
    if (bucket && !bucket.has(row.slotId)) {
      bucket.set(row.slotId, { reason: "course", label: row.courseName });
    }
  }

  const personal = await dbAll<{ id: string; personId: string; startsAt: string; endsAt: string; name: string }>(db,
    `select e.id,e.person_id,e.starts_at,e.ends_at,t.name from timetable_event e
     join timetable_entry t on t.id=e.entry_id where e.term_id=? and e.person_id in (select value from json_each(?))`,
    termId, JSON.stringify(personIds));
  for (const event of personal) {
    for (const slot of slots) {
      if (toMs(event.startsAt) < toMs(slot.endsAt) && toMs(event.endsAt) > toMs(slot.startsAt))
        byPerson.get(event.personId)?.set(slot.id, { reason: "course", refId: event.id, label: event.name });
    }
  }

  // 先按人分组，避免「格子 × 人 × 全部请假记录」的三重循环
  const leavesByPerson = new Map<string, typeof leaveRows>();
  for (const leave of leaveRows) {
    const list = leavesByPerson.get(leave.personId) ?? [];
    list.push(leave);
    leavesByPerson.set(leave.personId, list);
  }
  const assignmentsByPerson = new Map<string, typeof assignmentRows>();
  for (const item of assignmentRows) {
    const list = assignmentsByPerson.get(item.personId) ?? [];
    list.push(item);
    assignmentsByPerson.set(item.personId, list);
  }

  for (const slot of slots) {
    const start = toMs(slot.startsAt);
    const end = toMs(slot.endsAt);
    for (const personId of personIds) {
      const bucket = byPerson.get(personId);
      if (!bucket || bucket.has(slot.id)) continue;

      for (const leave of leavesByPerson.get(personId) ?? []) {
        if (toMs(leave.startsAt) < end && toMs(leave.endsAt) > start) {
          bucket.set(slot.id, {
            reason: leave.kind === "blacklist" ? "blacklist" : "leave",
            refId: leave.id,
          });
          break;
        }
      }
      if (bucket.has(slot.id)) continue;

      for (const item of assignmentsByPerson.get(personId) ?? []) {
        if (toMs(item.startsAt) < end && toMs(item.endsAt) > start) {
          bucket.set(slot.id, { reason: "cross_org", refId: item.shiftId });
          break;
        }
      }
    }
  }

  return { slots, byPerson };
}
