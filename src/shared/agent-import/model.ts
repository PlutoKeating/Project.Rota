import { z } from "zod";
import {
  addDays,
  generateTermSlots,
  expandWeeks,
} from "../../worker/domain/time";

const id = z.string().min(1).max(100);
const text = z.string().max(4000).nullable().default(null);
const name = z.string().trim().min(1).max(200);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v,
  );
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const instant = z.string().datetime({ offset: true });
const created = { created_at: instant.default(() => new Date().toISOString()) };
const updated = { updated_at: instant.nullable().default(null) };
const ref = id.nullable().default(null);
const period = z
  .object({ index: z.number().int().min(1).max(48), start: time, end: time })
  .strict()
  .refine((v) => v.start < v.end, "节次结束必须晚于开始");
export const schemas = {
  organization: z
    .object({
      id,
      name,
      code: text,
      parent_id: ref,
      kind: z
        .enum(["school", "college", "department", "club", "team"])
        .default("department"),
      status: z.enum(["active", "archived"]).default("active"),
      ...created,
      ...updated,
    })
    .strict(),
  person: z
    .object({
      id,
      full_name: name,
      student_no: text,
      email: text,
      phone: text,
      class_name: text,
      major: text,
      status: z.enum(["active", "leave", "graduated"]).default("active"),
      ...created,
      ...updated,
    })
    .strict(),
  term: z
    .object({
      id,
      name,
      start_date: date,
      week_count: z.number().int().min(1).max(30),
      timezone: z.literal("Asia/Shanghai").default("Asia/Shanghai"),
      status: z.enum(["planned", "active", "archived"]).default("planned"),
      ...created,
      ...updated,
    })
    .strict(),
  class_period: z
    .object({
      id,
      term_id: id,
      period_index: z.number().int().min(1).max(48),
      label: text,
      start_time: time,
      end_time: time,
    })
    .strict(),
  role: z
    .object({ id, name, code: text, org_id: ref, description: text })
    .strict(),
  membership: z
    .object({
      id,
      person_id: id,
      org_id: id,
      role_id: ref,
      status: z.enum(["active", "suspended", "ended"]).default("active"),
      valid_from: date.nullable().default(null),
      valid_to: date.nullable().default(null),
      is_primary: z.union([z.literal(0), z.literal(1)]).default(0),
      ...created,
    })
    .strict(),
  timetable_profile: z
    .object({
      id,
      term_id: id,
      name,
      periods: z.string().refine((v) => {
        try {
          const p = z.array(period).min(1).max(48).parse(JSON.parse(v));
          return new Set(p.map((x) => x.index)).size === p.length;
        } catch {
          return false;
        }
      }, "periods 必须是 [{index,start,end}] JSON，序号唯一"),
    })
    .strict(),
  timetable_entry: z
    .object({
      id,
      person_id: id,
      term_id: id,
      profile_id: id,
      name,
      teacher: text,
      location: text,
      weekday: z.number().int().min(1).max(7),
      period_from: z.number().int().min(1).max(48),
      period_to: z.number().int().min(1).max(48),
      weeks: z.string().refine((v) => {
        try {
          const a = z
            .array(z.number().int().min(1).max(30))
            .min(1)
            .max(30)
            .parse(JSON.parse(v));
          return new Set(a).size === a.length;
        } catch {
          return false;
        }
      }, "weeks 必须是明确周次的 JSON 数组"),
      ...created,
    })
    .strict(),
  course: z
    .object({ id, term_id: id, code: text, name, teacher: text, ...created })
    .strict(),
  course_meeting: z
    .object({
      id,
      course_id: id,
      term_id: id,
      weekday: z.number().int().min(1).max(7),
      period_from: z.number().int().min(1).max(48),
      period_to: z.number().int().min(1).max(48),
      pattern_kind: z.enum(["all", "odd", "even", "ranges"]),
      week_ranges: text,
      location: text,
    })
    .strict(),
  enrollment: z
    .object({
      id,
      person_id: id,
      course_id: id,
      term_id: id,
      status: z.enum(["active", "dropped"]).default("active"),
      ...created,
    })
    .strict(),
  unavailability: z
    .object({
      id,
      person_id: id,
      starts_at: instant,
      ends_at: instant,
      kind: z.enum(["leave", "blacklist", "other"]).default("other"),
      status: z.enum(["pending", "approved", "rejected"]).default("approved"),
      reason: text,
      ...created,
    })
    .strict(),
  task: z
    .object({
      id,
      org_id: id,
      title: name,
      description: text,
      kind: z.enum(["oneoff", "recurring", "project"]).default("oneoff"),
      status: z
        .enum(["draft", "open", "scheduled", "done", "cancelled"])
        .default("open"),
      window_start: instant.nullable().default(null),
      window_end: instant.nullable().default(null),
      ...created,
      ...updated,
    })
    .strict(),
  shift: z
    .object({
      id,
      task_id: id,
      starts_at: instant,
      ends_at: instant,
      required_headcount: z.number().int().min(1).max(300),
      required_role_id: ref,
      required_skill_id: ref,
      location: text,
      status: z
        .enum(["open", "filled", "completed", "cancelled"])
        .default("open"),
      ...created,
    })
    .strict(),
  assignment: z
    .object({
      id,
      shift_id: id,
      person_id: id,
      status: z
        .enum(["proposed", "confirmed", "completed", "declined"])
        .default("confirmed"),
      score: z.number().nullable().default(null),
      reason: text,
      assigned_at: instant.default(() => new Date().toISOString()),
      assigned_by: text,
    })
    .strict(),
};
export type Entity = keyof typeof schemas;
export const entities = Object.keys(schemas) as Entity[];
export const tables = [
  ...entities,
  "slot",
  "course_occurrence",
  "timetable_event",
  "skill",
  "person_skill",
  "preference",
  "shift_pattern",
  "fairness_stat",
] as const;
export type Table = (typeof tables)[number];
export type Row = { id: string; [key: string]: string | number | null };
export type Snapshot = Record<Table, Row[]>;
export interface Evidence {
  source: string;
  locator: string;
  explanation: string;
  inferred: boolean;
}
export interface Change {
  entity: Entity;
  id: string;
  before: Row | null;
  after: Row | null;
  evidence: Evidence[];
}
export interface Issue {
  message: string;
  entity?: string;
  id?: string;
}
export const evidenceSchema = z
  .object({
    source: z.string().min(1).max(500),
    locator: z.string().max(200),
    explanation: z.string().min(1).max(2000),
    inferred: z.boolean(),
  })
  .strict();
export const changeSchema = z
  .object({
    entity: z.enum(entities),
    id,
    before: z
      .record(z.string(), z.union([z.string(), z.number(), z.null()]))
      .nullable(),
    after: z
      .record(z.string(), z.union([z.string(), z.number(), z.null()]))
      .nullable(),
    evidence: z.array(evidenceSchema).min(1).max(30),
  })
  .strict();
export function emptySnapshot(): Snapshot {
  return Object.fromEntries(tables.map((t) => [t, []])) as unknown as Snapshot;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const relations: Partial<Record<Table, Record<string, Table>>> = {
  organization: { parent_id: "organization" },
  class_period: { term_id: "term" },
  role: { org_id: "organization" },
  membership: { person_id: "person", org_id: "organization", role_id: "role" },
  timetable_profile: { term_id: "term" },
  timetable_entry: {
    person_id: "person",
    term_id: "term",
    profile_id: "timetable_profile",
  },
  timetable_event: {
    entry_id: "timetable_entry",
    person_id: "person",
    term_id: "term",
  },
  course: { term_id: "term" },
  course_meeting: { course_id: "course", term_id: "term" },
  enrollment: { person_id: "person", course_id: "course", term_id: "term" },
  unavailability: { person_id: "person" },
  task: { org_id: "organization" },
  shift: {
    task_id: "task",
    required_role_id: "role",
    required_skill_id: "skill",
  },
  assignment: { person_id: "person", shift_id: "shift" },
  slot: { term_id: "term" },
  course_occurrence: { meeting_id: "course_meeting", slot_id: "slot" },
  person_skill: { person_id: "person", skill_id: "skill" },
  preference: { person_id: "person" },
  shift_pattern: { task_id: "task", required_role_id: "role" },
  fairness_stat: { person_id: "person", org_id: "organization" },
};
export function applyChanges(base: Snapshot, changes: Change[]): Snapshot {
  const s = structuredClone(base);
  const seen = new Set<string>();
  for (const c of changes) {
    const key = c.entity + ":" + c.id;
    if (seen.has(key)) throw Error("同一条记录重复变更");
    seen.add(key);
    const old = s[c.entity].find((r) => r.id === c.id) ?? null;
    if (canonical(old) !== canonical(c.before))
      throw Error("相关数据已变化，请重新协调：" + key);
    const after = c.after ? (schemas[c.entity].parse(c.after) as Row) : null;
    if (after && after.id !== c.id) throw Error("记录 ID 不匹配");
    s[c.entity] = s[c.entity].filter((r) => r.id !== c.id);
    if (after) s[c.entity].push(after);
  }
  return s;
}
export function diff(
  base: Snapshot,
  draft: Snapshot,
  evidence: Record<string, Evidence[]>,
): Change[] {
  return entities.flatMap((entity) => {
    const a = new Map(base[entity].map((r) => [r.id, r])),
      b = new Map(draft[entity].map((r) => [r.id, r]));
    return [...new Set([...a.keys(), ...b.keys()])].flatMap((id) =>
      canonical(a.get(id) ?? null) === canonical(b.get(id) ?? null)
        ? []
        : [
            {
              entity,
              id,
              before: a.get(id) ?? null,
              after: b.get(id) ?? null,
              evidence: evidence[entity + ":" + id] ?? [],
            },
          ],
    );
  });
}
export function mutate(
  s: Snapshot,
  entity: Entity,
  action: "create" | "update" | "delete",
  data: Record<string, unknown>,
  recordId?: string,
): string {
  const key = recordId ?? crypto.randomUUID(),
    rows = s[entity],
    old = rows.find((r) => r.id === key);
  if (action === "create" && old) throw Error("ID 已存在");
  if (action !== "create" && !old) throw Error("记录不存在");
  if (action === "delete") {
    s[entity] = rows.filter((r) => r.id !== key);
    return key;
  }
  const row = schemas[entity].parse({ ...old, ...data, id: key }) as Row;
  s[entity] = [...rows.filter((r) => r.id !== key), row];
  return key;
}
const overlap = (a: Row, b: Row) =>
  Date.parse(String(a.starts_at)) < Date.parse(String(b.ends_at)) &&
  Date.parse(String(a.ends_at)) > Date.parse(String(b.starts_at));
/** Derivation uses explicit Agent-authored values only; it never interprets uploaded material. */
export function materialize(s: Snapshot, base: Snapshot): Snapshot {
  const out = structuredClone(s);
  const changedTerms = new Set(
    s.term
      .filter(
        (t) =>
          canonical(t) !== canonical(base.term.find((b) => b.id === t.id)) ||
          canonical(s.class_period.filter((p) => p.term_id === t.id)) !==
            canonical(base.class_period.filter((p) => p.term_id === t.id)),
      )
      .map((t) => t.id),
  );
  out.slot = out.slot.filter(
    (r) =>
      s.term.some((t) => t.id === r.term_id) &&
      !changedTerms.has(String(r.term_id)),
  );
  for (const t of s.term.filter((t) => changedTerms.has(t.id))) {
    const old = base.slot.filter((x) => x.term_id === t.id);
    for (const slot of generateTermSlots({
      termId: t.id,
      startDate: String(t.start_date),
      weekCount: Number(t.week_count),
      periods: s.class_period
        .filter((p) => p.term_id === t.id)
        .map((p) => ({
          periodIndex: Number(p.period_index),
          startTime: String(p.start_time),
          endTime: String(p.end_time),
        })),
    }))
      out.slot.push({
        id:
          old.find(
            (x) =>
              x.week_index === slot.weekIndex &&
              x.weekday === slot.weekday &&
              x.period_index === slot.periodIndex,
          )?.id ??
          `slot:${t.id}:${slot.weekIndex}:${slot.weekday}:${slot.periodIndex}`,
        term_id: t.id,
        week_index: slot.weekIndex,
        weekday: slot.weekday,
        period_index: slot.periodIndex,
        starts_at: slot.startsAt,
        ends_at: slot.endsAt,
      });
  }
  const rebuild = new Set(
    s.course_meeting
      .filter(
        (m) =>
          changedTerms.has(String(m.term_id)) ||
          canonical(m) !==
            canonical(base.course_meeting.find((x) => x.id === m.id)),
      )
      .map((m) => m.id),
  );
  out.course_occurrence = out.course_occurrence.filter(
    (o) =>
      s.course_meeting.some((m) => m.id === o.meeting_id) &&
      !rebuild.has(String(o.meeting_id)),
  );
  for (const m of s.course_meeting.filter((m) => rebuild.has(m.id))) {
    const t = s.term.find((t) => t.id === m.term_id);
    if (!t) continue;
    const weeks = expandWeeks(
      m.pattern_kind as "all",
      String(m.week_ranges ?? ""),
      Number(t.week_count),
    );
    for (const slot of out.slot.filter(
      (x) =>
        x.term_id === m.term_id &&
        weeks.includes(Number(x.week_index)) &&
        x.weekday === m.weekday &&
        Number(x.period_index) >= Number(m.period_from) &&
        Number(x.period_index) <= Number(m.period_to),
    ))
      out.course_occurrence.push({
        id: `occ:${m.id}:${slot.id}`,
        meeting_id: m.id,
        slot_id: slot.id,
        status: "scheduled",
        note: null,
      });
  }
  out.timetable_event = [];
  for (const entry of s.timetable_entry) {
    const t = s.term.find((x) => x.id === entry.term_id),
      p = s.timetable_profile.find((x) => x.id === entry.profile_id);
    if (!t || !p) continue;
    const periods = z.array(period).parse(JSON.parse(String(p.periods)));
    for (const week of JSON.parse(String(entry.weeks)) as number[])
      for (const part of periods.filter(
        (p) =>
          p.index >= Number(entry.period_from) &&
          p.index <= Number(entry.period_to),
      )) {
        const day = addDays(
          String(t.start_date),
          (week - 1) * 7 + Number(entry.weekday) - 1,
        );
        out.timetable_event.push({
          id: `event:${entry.id}:${week}:${part.index}`,
          entry_id: entry.id,
          person_id: entry.person_id,
          term_id: entry.term_id,
          week_index: week,
          weekday: entry.weekday,
          period_index: part.index,
          starts_at: `${day}T${part.start}:00+08:00`,
          ends_at: `${day}T${part.end}:00+08:00`,
        });
      }
  }
  // Rebuild the accounting projection whenever imported assignments/time windows change.
  if (
    ["assignment", "shift", "task", "term"].some(
      (k) => canonical(s[k as Table]) !== canonical(base[k as Table]),
    )
  ) {
    const buckets = new Map<string, Row>();
    for (const a of out.assignment.filter((a) =>
      ["proposed", "confirmed", "completed"].includes(String(a.status)),
    )) {
      const sh = out.shift.find((x) => x.id === a.shift_id),
        task = out.task.find((t) => t.id === sh?.task_id);
      if (!sh || !task?.org_id || sh.status === "cancelled") continue;
      const day = String(sh.starts_at).slice(0, 10),
        term = out.term.find(
          (t) =>
            String(t.start_date) <= day &&
            day < addDays(String(t.start_date), Number(t.week_count) * 7),
        );
      if (!term) continue;
      const week =
          Math.floor(
            (Date.parse(day) - Date.parse(String(term.start_date))) / 604800000,
          ) + 1,
        window = term.name + "-W" + week,
        key = a.person_id + ":" + task.org_id + ":" + window;
      const existing = base.fairness_stat.find(
        (f) =>
          f.person_id === a.person_id &&
          f.org_id === task.org_id &&
          f.window_key === window,
      );
      const bucket = buckets.get(key) ?? {
        id: existing?.id ?? "fair:" + key,
        person_id: a.person_id,
        org_id: task.org_id,
        window_key: window,
        shift_count: 0,
        minutes: 0,
        carry_over: 0,
        last_assigned_at: sh.starts_at,
      };
      bucket.shift_count = Number(bucket.shift_count) + 1;
      bucket.minutes =
        Number(bucket.minutes) +
        (Date.parse(String(sh.ends_at)) - Date.parse(String(sh.starts_at))) /
          60000;
      if (String(sh.starts_at) > String(bucket.last_assigned_at))
        bucket.last_assigned_at = sh.starts_at;
      buckets.set(key, bucket);
    }
    out.fairness_stat = [...buckets.values()];
  }
  return out;
}
export function validate(s: Snapshot): Issue[] {
  const issues: Issue[] = [];
  const report = (message: string, entity?: string, id?: string) =>
    issues.push({ message, entity, id });
  for (const table of tables) {
    const ids = new Set<string>();
    for (const r of s[table]) {
      if (ids.has(r.id)) report("重复 ID", table, r.id);
      ids.add(r.id);
      for (const [col, target] of Object.entries(relations[table] ?? {}))
        if (r[col] != null && !s[target].some((t) => t.id === r[col]))
          report(`引用不存在：${col}`, table, r.id);
    }
  }
  for (const [table, cols] of [
    ["person", ["student_no"]],
    ["term", ["name"]],
    ["organization", ["code"]],
    ["class_period", ["term_id", "period_index"]],
    ["enrollment", ["person_id", "course_id"]],
    ["assignment", ["shift_id", "person_id"]],
    [
      "timetable_entry",
      [
        "person_id",
        "term_id",
        "profile_id",
        "name",
        "weekday",
        "period_from",
        "period_to",
        "weeks",
      ],
    ],
  ] as [Table, string[]][]) {
    const seen = new Set<string>();
    for (const r of s[table]) {
      if (cols.some((c) => r[c] == null)) continue;
      const key = canonical(cols.map((c) => r[c]));
      if (seen.has(key)) report("重复 " + cols.join("/"), table, r.id);
      seen.add(key);
    }
  }
  for (const o of s.organization) {
    const seen = new Set([o.id]);
    let parent = o.parent_id;
    while (parent) {
      if (seen.has(String(parent))) {
        report("部门层级成环", "organization", o.id);
        break;
      }
      seen.add(String(parent));
      parent = s.organization.find((x) => x.id === parent)?.parent_id ?? null;
    }
  }
  for (const t of s.term) {
    if (new Date(String(t.start_date)).getUTCDay() !== 1)
      report("第一教学周起始日期必须为周一", "term", t.id);
    if (!s.class_period.some((p) => p.term_id === t.id))
      report("缺少全局节次", "term", t.id);
  }
  for (const p of s.class_period)
    if (String(p.start_time) >= String(p.end_time))
      report("节次起止时间无效", "class_period", p.id);
  for (const m of s.membership) {
    if (m.valid_from && m.valid_to && m.valid_from > m.valid_to)
      report("任期起止颠倒", "membership", m.id);
    const r = s.role.find((r) => r.id === m.role_id);
    if (r?.org_id && r.org_id !== m.org_id)
      report("角色不属于此部门", "membership", m.id);
  }
  for (const e of s.enrollment) {
    if (s.course.find((c) => c.id === e.course_id)?.term_id !== e.term_id)
      report("课程与选课学期不一致", "enrollment", e.id);
  }
  for (const e of s.timetable_entry) {
    try {
      const t = s.term.find((t) => t.id === e.term_id),
        p = s.timetable_profile.find((p) => p.id === e.profile_id);
      const ps = JSON.parse(String(p?.periods ?? "[]")) as { index: number }[];
      if (p?.term_id !== e.term_id)
        report("作息与课表学期不一致", "timetable_entry", e.id);
      if (
        Number(e.period_from) > Number(e.period_to) ||
        !ps.some((x) => x.index === e.period_from) ||
        !ps.some((x) => x.index === e.period_to)
      )
        report("课表节次超出作息范围", "timetable_entry", e.id);
      if (
        (JSON.parse(String(e.weeks)) as number[]).some(
          (w) => w > Number(t?.week_count),
        )
      )
        report("周次超出学期", "timetable_entry", e.id);
    } catch {
      report("课表周次或作息格式无效", "timetable_entry", e.id);
    }
  }
  for (const m of s.course_meeting) {
    const t = s.term.find((t) => t.id === m.term_id);
    if (s.course.find((c) => c.id === m.course_id)?.term_id !== m.term_id)
      report("课程规则学期不一致", "course_meeting", m.id);
    if (
      Number(m.period_from) > Number(m.period_to) ||
      !s.class_period.some(
        (p) => p.term_id === m.term_id && p.period_index === m.period_from,
      ) ||
      !s.class_period.some(
        (p) => p.term_id === m.term_id && p.period_index === m.period_to,
      )
    )
      report("课程规则节次无效", "course_meeting", m.id);
    if (
      !expandWeeks(
        m.pattern_kind as "all",
        String(m.week_ranges ?? ""),
        Number(t?.week_count ?? 0),
      ).length
    )
      report("课程周次为空", "course_meeting", m.id);
  }
  for (const table of ["shift", "unavailability"] as const)
    for (const r of s[table])
      if (!(Date.parse(String(r.starts_at)) < Date.parse(String(r.ends_at))))
        report("起止时间无效", table, r.id);
  const active = s.assignment.filter((a) =>
    ["proposed", "confirmed", "completed"].includes(String(a.status)),
  );
  for (const a of active) {
    const shift = s.shift.find((x) => x.id === a.shift_id);
    if (!shift) continue;
    const task = s.task.find((t) => t.id === shift.task_id);
    if (
      shift.status === "cancelled" ||
      ["cancelled", "done"].includes(String(task?.status))
    )
      report("不能向已关闭任务派班", "assignment", a.id);
    if (
      active.filter((x) => x.shift_id === shift.id).length >
      Number(shift.required_headcount)
    )
      report("班次超员", "shift", shift.id);
    if (
      !s.membership.some(
        (m) =>
          m.person_id === a.person_id &&
          m.org_id === task?.org_id &&
          m.status === "active" &&
          (!m.valid_from ||
            String(m.valid_from) <= String(shift.starts_at).slice(0, 10)) &&
          (!m.valid_to ||
            String(m.valid_to) >= String(shift.ends_at).slice(0, 10)) &&
          (!shift.required_role_id || m.role_id === shift.required_role_id),
      )
    )
      report("人员不满足部门/任期/角色要求", "assignment", a.id);
    if (s.person.find((p) => p.id === a.person_id)?.status !== "active")
      report("人员未启用", "assignment", a.id);
    if (
      shift.required_skill_id &&
      !s.person_skill.some(
        (p) =>
          p.person_id === a.person_id && p.skill_id === shift.required_skill_id,
      )
    )
      report("人员缺少所需技能", "assignment", a.id);
    if (
      active.some(
        (b) =>
          b.id !== a.id &&
          b.person_id === a.person_id &&
          s.shift.some(
            (t) =>
              t.id === b.shift_id &&
              t.status !== "cancelled" &&
              overlap(shift, t),
          ),
      )
    )
      report("人员班次时间冲突", "assignment", a.id);
    if (
      s.unavailability.some(
        (u) =>
          u.person_id === a.person_id &&
          u.status === "approved" &&
          overlap(shift, u),
      ) ||
      s.timetable_event.some(
        (e) => e.person_id === a.person_id && overlap(shift, e),
      )
    )
      report("班次与课表/不可用时段冲突", "assignment", a.id);
    const courses = s.enrollment
      .filter((e) => e.person_id === a.person_id && e.status === "active")
      .map((e) => e.course_id);
    const meetings = s.course_meeting
      .filter((m) => courses.includes(m.course_id))
      .map((m) => m.id);
    if (
      s.course_occurrence.some(
        (o) =>
          meetings.includes(String(o.meeting_id)) &&
          o.status !== "cancelled" &&
          s.slot.some((slot) => slot.id === o.slot_id && overlap(shift, slot)),
      )
    )
      report("班次与已有课程冲突", "assignment", a.id);
  }
  return issues;
}

/** Existing historical inconsistencies do not prevent unrelated imports; new violations do. */
export function validateTransition(before: Snapshot, after: Snapshot): Issue[] {
  const existing = new Set(validate(before).map((issue) => canonical(issue)));
  return validate(after).filter((issue) => !existing.has(canonical(issue)));
}
