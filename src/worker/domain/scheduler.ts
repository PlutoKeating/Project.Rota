import type {
  AssignmentView,
  CandidateView,
  ExcludedView,
  PreviewResult,
  ScoreWeights,
  Shift,
  Task,
} from "../../shared/types";
import {
  badRequest,
  conflict,
  dbAll,
  dbBatch,
  dbOne,
  dbRun,
  nowIso,
  ulid,
} from "../lib/core";
import { DEFAULT_WEIGHTS, scoreCandidate, type Candidate, type ScoringContext } from "./assign";
import { freeMinutes, loadAvailabilityBatch } from "./availability";
import { minutesBetween, resolveTermForDate, windowKeyFor } from "./ledger";
import { isoWeekday } from "./time";

export interface ScheduleConfig {
  cooldownDays: number;
  weights: ScoreWeights;
}

export const DEFAULT_SCHEDULE_CONFIG: ScheduleConfig = {
  cooldownDays: 3,
  weights: { ...DEFAULT_WEIGHTS },
};

interface PersonRow {
  id: string;
  fullName: string;
}

interface PreferenceRow {
  personId: string;
  weekday: number | null;
  polarity: "prefer" | "avoid";
  weight: number | null;
}

interface LedgerRow {
  personId: string;
  shiftCount: number;
  minutes: number;
  lastAssignedAt: string | null;
}

function overlaps(startsAt: string, endsAt: string, slot: { startsAt: string; endsAt: string }): boolean {
  return Date.parse(slot.startsAt) < Date.parse(endsAt) && Date.parse(slot.endsAt) > Date.parse(startsAt);
}

async function loadShift(db: D1Database, shiftId: string): Promise<Shift> {
  const shift = await dbOne<Shift>(db, "select * from shift where id = ?", shiftId);
  if (!shift) throw badRequest("班次不存在");
  return shift;
}

async function loadTask(db: D1Database, taskId: string): Promise<Task> {
  const task = await dbOne<Task>(db, "select * from task where id = ?", taskId);
  if (!task) throw badRequest("任务不存在");
  return task;
}

export async function previewShift(
  db: D1Database,
  shiftId: string,
  config: ScheduleConfig,
): Promise<PreviewResult> {
  const shift = await loadShift(db, shiftId);
  const task = await loadTask(db, shift.taskId);
  if (!task.orgId) throw badRequest("任务未归属部门，无法按公平口径排班");

  const term = await resolveTermForDate(db, shift.startsAt);
  const windowKey = windowKeyFor(term, shift.startsAt);
  const weekday = isoWeekday(shift.startsAt.slice(0, 10));

  const persons = await dbAll<PersonRow>(
    db,
    `select p.id, p.full_name
       from person p
       join membership m on m.person_id = p.id
      where m.org_id = ? and m.status = 'active' and p.status = 'active'
        and (? is null or m.role_id = ?)
      order by p.full_name collate nocase`,
    task.orgId,
    shift.requiredRoleId,
    shift.requiredRoleId,
  );

  const personIds = persons.map((p) => p.id);
  const { slots, byPerson } = await loadAvailabilityBatch(db, personIds, term.id, shift.id);

  const ledgerRows = await dbAll<LedgerRow>(
    db,
    "select person_id, shift_count, minutes, last_assigned_at from fairness_stat where org_id = ? and window_key = ?",
    task.orgId,
    windowKey,
  );
  const ledger = new Map(ledgerRows.map((row) => [row.personId, row]));

  const prefs = personIds.length
    ? await dbAll<PreferenceRow>(
        db,
        `select person_id, weekday, polarity, weight
           from preference
          where person_id in (${personIds.map(() => "?").join(",")})`,
        ...personIds,
      )
    : [];
  const prefsByPerson = new Map<string, PreferenceRow[]>();
  for (const pref of prefs) {
    const list = prefsByPerson.get(pref.personId) ?? [];
    list.push(pref);
    prefsByPerson.set(pref.personId, list);
  }

  const shiftCountRow = await dbOne<{ total: number }>(
    db,
    "select count(*) as total from shift where task_id = ? and status != 'cancelled'",
    task.id,
  );
  const totalShifts = shiftCountRow?.total ?? 1;

  const excluded: ExcludedView[] = [];
  const prepared: { person: PersonRow; candidate: Candidate; free: number; busy: boolean }[] = [];

  for (const person of persons) {
    const bucket = byPerson.get(person.id) ?? new Map();
    const busy = slots.some((slot) => bucket.has(slot.id) && overlaps(shift.startsAt, shift.endsAt, slot));
    const free = freeMinutes(slots, bucket);
    const own = ledger.get(person.id);

    if (busy) {
      excluded.push({ personId: person.id, fullName: person.fullName, reason: "busy" });
      continue;
    }

    let preference = 0;
    for (const pref of prefsByPerson.get(person.id) ?? []) {
      if (pref.weekday !== null && pref.weekday !== weekday) continue;
      const weight = pref.weight ?? 1;
      preference += pref.polarity === "prefer" ? weight : -weight;
    }

    prepared.push({
      person,
      free,
      busy,
      candidate: {
        personId: person.id,
        freeMinutes: free,
        assignedShifts: own?.shiftCount ?? 0,
        lastAssignedAt: own?.lastAssignedAt ?? undefined,
        preference: Math.max(-1, Math.min(1, preference)),
        manualPriority: 0,
      },
    });
  }

  const totalFreeMinutes = prepared.reduce((sum, item) => sum + item.free, 0);
  const ctx: ScoringContext = {
    shiftId: shift.id,
    totalShifts,
    totalFreeMinutes,
    participantCount: prepared.length,
    now: nowIso(),
    cooldownDays: config.cooldownDays,
    weights: config.weights,
  };

  const candidates: CandidateView[] = [];
  for (const item of prepared) {
    const breakdown = scoreCandidate(item.candidate, ctx);
    if (breakdown.excluded) {
      excluded.push({ personId: item.person.id, fullName: item.person.fullName, reason: breakdown.excluded });
      continue;
    }
    candidates.push({
      personId: item.person.id,
      fullName: item.person.fullName,
      freeMinutes: item.free,
      assignedCount: item.candidate.assignedShifts,
      score: breakdown.score,
      breakdown,
      excluded: null,
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.personId.localeCompare(b.personId));

  return {
    shift,
    candidates,
    excluded,
    appliedWeights: config.weights,
    cooldownDays: config.cooldownDays,
  };
}

function ledgerStatements(
  key: { personId: string; orgId: string; windowKey: string },
  minutes: number,
  delta: 1 | -1,
): { sql: string; params: (string | number)[] }[] {
  const at = nowIso();
  const statements: { sql: string; params: (string | number)[] }[] = [
    {
      sql: `update fairness_stat
               set shift_count = max(0, shift_count + ?),
                   minutes = max(0, minutes + ?),
                   last_assigned_at = case when ? > 0 then ? else last_assigned_at end
             where person_id = ? and org_id = ? and window_key = ?`,
      params: [delta, delta * minutes, delta, at, key.personId, key.orgId, key.windowKey],
    },
  ];
  if (delta > 0) {
    statements.push({
      sql: `insert into fairness_stat
              (id, person_id, org_id, window_key, shift_count, minutes, carry_over, last_assigned_at)
            select ?, ?, ?, ?, 1, ?, 0, ?
             where not exists (
               select 1 from fairness_stat
                where person_id = ? and org_id = ? and window_key = ?
             )`,
      params: [ulid(), key.personId, key.orgId, key.windowKey, minutes, at, key.personId, key.orgId, key.windowKey],
    });
  }
  return statements;
}

export async function assignShift(
  db: D1Database,
  shiftId: string,
  personId: string | null,
  config: ScheduleConfig,
  actor: string,
): Promise<{ assignment: AssignmentView; preview: PreviewResult }> {
  const preview = await previewShift(db, shiftId, config);
  const shift = preview.shift;
  const task = await loadTask(db, shift.taskId);
  if (!task.orgId) throw badRequest("任务未归属部门");

  const term = await resolveTermForDate(db, shift.startsAt);
  const windowKey = windowKeyFor(term, shift.startsAt);

  let chosen: CandidateView | null = preview.candidates[0] ?? null;
  if (personId) {
    chosen = preview.candidates.find((c) => c.personId === personId) ?? null;
    if (!chosen) {
      const why = preview.excluded.find((e) => e.personId === personId);
      const reasonText: Record<string, string> = {
        busy: "该时段已有课或有其他安排",
        cooldown: "在冷却期内，刚被排过",
        no_free_time: "该时段没有空闲",
        role: "角色不匹配",
        skill: "技能不匹配",
      };
      throw conflict(`无法安排该成员：${why ? (reasonText[why.reason] ?? why.reason) : "不在候选范围"}`);
    }
  }
  if (!chosen) throw conflict("没有可用候选，无法自动分配");

  const existing = await dbOne<{ c: number }>(
    db,
    "select count(*) as c from assignment where shift_id = ? and status != 'declined'",
    shiftId,
  );
  if ((existing?.c ?? 0) >= shift.requiredHeadcount) throw conflict("该班次人数已满");

  const assignmentId = ulid();
  const minutes = minutesBetween(shift.startsAt, shift.endsAt);

  const statements: { sql: string; params: (string | number)[] }[] = [
    {
      sql: `insert into assignment
              (id, shift_id, person_id, status, score, reason, assigned_at, assigned_by)
            values (?, ?, ?, 'confirmed', ?, ?, ?, ?)`,
      params: [
        assignmentId,
        shiftId,
        chosen.personId,
        chosen.score,
        JSON.stringify(chosen.breakdown),
        nowIso(),
        actor,
      ],
    },
    ...ledgerStatements({ personId: chosen.personId, orgId: task.orgId, windowKey }, minutes, 1),
  ];

  if ((existing?.c ?? 0) + 1 >= shift.requiredHeadcount) {
    statements.push({ sql: "update shift set status = 'filled' where id = ?", params: [shiftId] });
  }
  statements.push({
    sql: `insert into audit_event (id, actor_id, action, target_type, target_id, payload, created_at)
          values (?, ?, 'assignment.create', 'assignment', ?, ?, ?)`,
    params: [
      ulid(),
      actor,
      assignmentId,
      JSON.stringify({ shiftId, personId: chosen.personId, score: chosen.score }),
      nowIso(),
    ],
  });

  try {
    await dbBatch(db, statements);
  } catch (error) {
    throw conflict(`写入失败，可能已被占用：${String(error).slice(0, 120)}`);
  }

  const assignment = await dbOne<AssignmentView>(
    db,
    `select a.*, p.full_name as person_name
       from assignment a join person p on p.id = a.person_id
      where a.id = ?`,
    assignmentId,
  );

  return { assignment: assignment as AssignmentView, preview };
}

export async function unassign(
  db: D1Database,
  assignmentId: string,
  actor: string,
): Promise<{ ok: true }> {
  const row = await dbOne<{ shiftId: string; personId: string }>(
    db,
    `select a.shift_id, a.person_id
       from assignment a where a.id = ?`,
    assignmentId,
  );
  if (!row) throw badRequest("分配记录不存在");

  const shift = await dbOne<Shift>(db, "select * from shift where id = ?", row.shiftId);
  if (!shift) throw badRequest("班次不存在");
  const task = await loadTask(db, shift.taskId);
  if (!task.orgId) throw badRequest("任务未归属部门");
  const term = await resolveTermForDate(db, shift.startsAt);
  const windowKey = windowKeyFor(term, shift.startsAt);
  const minutes = minutesBetween(shift.startsAt, shift.endsAt);

  await dbBatch(db, [
    { sql: "delete from assignment where id = ?", params: [assignmentId] },
    ...ledgerStatements({ personId: row.personId, orgId: task.orgId, windowKey }, minutes, -1),
    { sql: "update shift set status = 'open' where id = ?", params: [shift.id] },
    {
      sql: `insert into audit_event (id, actor_id, action, target_type, target_id, payload, created_at)
            values (?, ?, 'assignment.delete', 'assignment', ?, ?, ?)`,
      params: [ulid(), actor, assignmentId, JSON.stringify({ shiftId: shift.id }), nowIso()],
    },
  ]);

  return { ok: true };
}

export async function autoAssignTask(
  db: D1Database,
  taskId: string,
  config: ScheduleConfig,
  actor: string,
): Promise<{ assigned: number; skipped: number }> {
  const shifts = await dbAll<{ id: string }>(
    db,
    "select id from shift where task_id = ? and status = 'open' order by starts_at",
    taskId,
  );

  let assigned = 0;
  let skipped = 0;
  for (const shift of shifts) {
    try {
      await assignShift(db, shift.id, null, config, actor);
      assigned += 1;
    } catch {
      skipped += 1;
    }
  }
  return { assigned, skipped };
}
