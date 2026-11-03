import type { FairnessRow, Term } from "../../shared/types";
import { badRequest, dbAll, dbBatch, dbOne, dbRun, nowIso, ulid } from "../lib/core";
import { addDays, weekIndexOf } from "./time";

/**
 * 公平账本。核心不是"记次数"，而是"跨窗口结转"：
 * 本周少排一次，下周的缺口会更大，权重自然把它补回来。
 */

export function windowKeyFor(term: Term, iso: string): string {
  const date = iso.slice(0, 10);
  const week = weekIndexOf(date, term.startDate, term.weekCount) ?? 1;
  return `${term.name}-W${week}`;
}

/** 找出某个时刻所属的学期；跨学期边界时以日期为准。 */
export async function resolveTermForDate(db: D1Database, iso: string): Promise<Term> {
  const date = iso.slice(0, 10);
  const terms = await dbAll<Term>(db, "select * from term order by start_date desc");
  const hit = terms.find((term) => {
    const end = addDays(term.startDate, term.weekCount * 7);
    return term.startDate <= date && date < end;
  });
  if (!hit) throw badRequest(`时间 ${date} 不在任何学期内，请先建学期`);
  return hit;
}

export function minutesBetween(startsAt: string, endsAt: string): number {
  const span = (Date.parse(endsAt) - Date.parse(startsAt)) / 60_000;
  return Number.isFinite(span) && span > 0 ? Math.round(span) : 0;
}

export interface LedgerKey {
  personId: string;
  orgId: string;
  windowKey: string;
}

export interface LedgerRow extends LedgerKey {
  id: string;
  shiftCount: number;
  minutes: number;
  carryOver: number;
  lastAssignedAt: string | null;
}

export async function getLedgerRow(db: D1Database, key: LedgerKey): Promise<LedgerRow | null> {
  return dbOne<LedgerRow>(
    db,
    "select * from fairness_stat where person_id = ? and org_id = ? and window_key = ?",
    key.personId,
    key.orgId,
    key.windowKey,
  );
}

/** delta=+1 记一次，delta=-1 撤销。手动 upsert，避开 SQLite 对 NULL 唯一键的宽松。 */
export async function bumpLedger(
  db: D1Database,
  input: LedgerKey & { minutes: number; delta: 1 | -1 },
): Promise<void> {
  const existing = await getLedgerRow(db, input);
  if (existing) {
    await dbRun(
      db,
      `update fairness_stat
          set shift_count = max(0, shift_count + ?),
              minutes = max(0, minutes + ?),
              last_assigned_at = case when ? > 0 then ? else last_assigned_at end
        where id = ?`,
      input.delta,
      input.delta * input.minutes,
      input.delta,
      nowIso(),
      existing.id,
    );
    return;
  }
  if (input.delta < 0) return;
  await dbRun(
    db,
    `insert into fairness_stat
       (id, person_id, org_id, window_key, shift_count, minutes, carry_over, last_assigned_at)
     values (?, ?, ?, ?, 1, ?, 0, ?)`,
    `FS${Date.parse(nowIso())}${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    input.personId,
    input.orgId,
    input.windowKey,
    input.minutes,
    nowIso(),
  );
}

export async function listFairness(
  db: D1Database,
  filter: { orgId?: string | null; windowKey?: string | null },
): Promise<FairnessRow[]> {
  return dbAll<FairnessRow>(
    db,
    `select f.person_id, p.full_name, f.org_id, o.name as org_name,
            f.window_key, f.shift_count, f.minutes,
            coalesce((select count(*) from assignment a join shift s on s.id=a.shift_id join task t on t.id=s.task_id
              where a.person_id=f.person_id and t.org_id=f.org_id and a.status in ('proposed','confirmed','completed')
              and s.status != 'cancelled' and julianday(s.starts_at) < (
                select julianday(tm.start_date || 'T00:00:00+08:00') + (cast(substr(f.window_key,length(tm.name)+3) as integer)-1)*7
                from term tm where substr(f.window_key,1,length(tm.name)+2)=tm.name || '-W' limit 1
              )),0) as carry_over, f.last_assigned_at
       from fairness_stat f
       join person p on p.id = f.person_id
       left join organization o on o.id = f.org_id
      where (? is null or f.org_id = ?)
        and (? is null or f.window_key = ?)
      order by f.shift_count asc, f.minutes asc, p.full_name collate nocase`,
    filter.orgId ?? null,
    filter.orgId ?? null,
    filter.windowKey ?? null,
    filter.windowKey ?? null,
  );
}

/**
 * 从 assignment 重算账本。幂等：先清后建，用于手工改班或数据修复后的对账。
 */
export async function recomputeFairness(
  db: D1Database,
  filter: { orgId?: string | null } = {},
): Promise<number> {
  const terms = await dbAll<Term>(db, "select * from term");
  const rows = await dbAll<{
    personId: string;
    orgId: string | null;
    startsAt: string;
    endsAt: string;
  }>(
    db,
    `select a.person_id, t.org_id, s.starts_at, s.ends_at
       from assignment a
       join shift s on s.id = a.shift_id
       join task t on t.id = s.task_id
      where a.status in ('proposed', 'confirmed', 'completed')
        and t.org_id is not null
        and (? is null or t.org_id = ?)`,
    filter.orgId ?? null,
    filter.orgId ?? null,
  );

  const buckets = new Map<string, { personId: string; orgId: string; windowKey: string; count: number; minutes: number; last: string }>();
  for (const row of rows) {
    if (!row.orgId) continue;
    const term = terms.find((t) => {
      const date = row.startsAt.slice(0, 10);
      return t.startDate <= date && date < addDays(t.startDate, t.weekCount * 7);
    });
    if (!term) continue;
    const key = `${row.personId}|${row.orgId}|${windowKeyFor(term, row.startsAt)}`;
    const bucket = buckets.get(key) ?? {
      personId: row.personId,
      orgId: row.orgId,
      windowKey: windowKeyFor(term, row.startsAt),
      count: 0,
      minutes: 0,
      last: row.startsAt,
    };
    bucket.count += 1;
    bucket.minutes += minutesBetween(row.startsAt, row.endsAt);
    if (row.startsAt > bucket.last) bucket.last = row.startsAt;
    buckets.set(key, bucket);
  }

  const statements: { sql: string; params: (string | number | null)[] }[] = [{
    sql: filter.orgId ? "delete from fairness_stat where org_id = ?" : "delete from fairness_stat",
    params: filter.orgId ? [filter.orgId] : [],
  }];
  for (const bucket of buckets.values()) {
    statements.push({ sql: `insert into fairness_stat
      (id, person_id, org_id, window_key, shift_count, minutes, carry_over, last_assigned_at)
      values (?, ?, ?, ?, ?, ?, 0, ?)`,
      params: [ulid(), bucket.personId, bucket.orgId, bucket.windowKey, bucket.count, bucket.minutes, bucket.last] });
  }
  await dbBatch(db, statements);
  return buckets.size;
}
