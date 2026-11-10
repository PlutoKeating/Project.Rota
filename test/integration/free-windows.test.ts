import { describe, expect, it } from "vitest";
import guards from "../../migrations/0003_assignment_guards.sql?raw";
import ddl from "../../migrations/0001_init.sql?raw";
import { loadFreeWindows } from "../../src/worker/domain/free-windows";
import app from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createFiles, createKv, D1Stub } from "../helpers/d1";

/**
 * 共同空闲时段：真实 SQL 取数（课程 occurrence、个人课表事件、请假、已排班、学期覆盖）
 * → 纯函数计算。时间固定在 2026-11-10（周二）07:00，窗口 08:00–18:00。
 */

const NOW = "2026-11-01T00:00:00.000Z";

async function run(db: D1Stub, sql: string, ...params: (string | number | null)[]): Promise<void> {
  await db.prepare(sql).bind(...params).run();
}

async function seed(): Promise<D1Stub> {
  const db = new D1Stub(ddl + guards);
  await run(db, "insert into term (id,name,start_date,week_count,timezone,status,created_at) values ('t1','2026 秋','2026-11-09',2,'Asia/Shanghai','active',?)", NOW);
  await run(db, "insert into organization (id,code,name,parent_id,kind,status,created_at,updated_at) values ('o1','XCB','宣传部',null,'department','active',?,null)", NOW);
  for (const [id, name] of [["p1", "张三"], ["p2", "李四"], ["p3", "王五"], ["p4", "赵六"]] as const) {
    await run(db, "insert into person (id,student_no,full_name,email,phone,status,created_at,updated_at) values (?,?,?,null,null,'active',?,null)", id, id.toUpperCase(), name, NOW);
  }

  // 张三：周二 08:00–09:40 上课（课程 occurrence 走 slot 时间）。
  await run(db, "insert into slot (id,term_id,week_index,weekday,period_index,starts_at,ends_at) values ('s1','t1',1,2,1,'2026-11-10T08:00:00+08:00','2026-11-10T09:40:00+08:00')");
  await run(db, "insert into course (id,term_id,code,name,teacher,created_at) values ('c1','t1','MATH','高等数学','李老师',?)", NOW);
  await run(db, "insert into course_meeting (id,course_id,term_id,weekday,period_from,period_to,pattern_kind,week_ranges,location) values ('cm1','c1','t1',2,1,1,'all',null,'A101')");
  await run(db, "insert into course_occurrence (id,meeting_id,slot_id,status,note) values ('co1','cm1','s1','scheduled',null)");
  await run(db, "insert into enrollment (id,person_id,course_id,term_id,status,created_at) values ('e1','p1','c1','t1','active',?)", NOW);

  // 李四：个人课表 10:00–12:00，另有 14:00–15:00 已批准请假。
  await run(db, "insert into timetable_profile (id,term_id,name,periods) values ('tp1','t1','默认','[]')");
  await run(db, "insert into timetable_entry (id,person_id,term_id,profile_id,name,teacher,location,weekday,period_from,period_to,weeks,created_at) values ('te1','p2','t1','tp1','大学英语',null,null,2,3,4,'[1]',?)", NOW);
  await run(db, "insert into timetable_event (id,entry_id,person_id,term_id,week_index,weekday,period_index,starts_at,ends_at) values ('ev1','te1','p2','t1',1,2,3,'2026-11-10T10:00:00+08:00','2026-11-10T12:00:00+08:00')");
  await run(db, "insert into unavailability (id,person_id,starts_at,ends_at,kind,status,reason,created_at) values ('u1','p2','2026-11-10T14:00:00+08:00','2026-11-10T15:00:00+08:00','leave','approved','看病',?)", NOW);

  // 王五：没有任何课表数据 → 未知。赵六：有课表（无具体事件）且 16:00–17:00 已排班。
  await run(db, "insert into timetable_entry (id,person_id,term_id,profile_id,name,teacher,location,weekday,period_from,period_to,weeks,created_at) values ('te4','p4','t1','tp1','体育',null,null,5,1,1,'[]',?)", NOW);
  await run(db, "insert into task (id,org_id,title,description,kind,status,window_start,window_end,created_at,updated_at) values ('task1','o1','迎新值班',null,'one_off','open',null,null,?,null)", NOW);
  await run(db, "insert into shift (id,task_id,starts_at,ends_at,required_headcount,status,created_at) values ('sh1','task1','2026-11-10T16:00:00+08:00','2026-11-10T17:00:00+08:00',1,'open',?)", NOW);
  await run(db, "insert into assignment (id,shift_id,person_id,status,score,reason,assigned_at,assigned_by) values ('a1','sh1','p4','confirmed',null,null,?,null)", NOW);
  return db;
}

const QUERY = {
  personIds: ["p1", "p2", "p3", "p4"],
  requiredPersonIds: [] as string[],
  days: 1,
  count: 4,
  dayStartMinutes: 8 * 60,
  dayEndMinutes: 18 * 60,
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  bufferMinutes: 0,
};
const now = Date.parse("2026-11-10T07:00:00+08:00");
const span = (w: { startsAt: string; endsAt: string }) => `${w.startsAt.slice(11, 16)}-${w.endsAt.slice(11, 16)}`;

describe("loadFreeWindows", () => {
  it("combines courses, timetable events, leave, assignments and term coverage", async () => {
    const db = await seed();
    const result = await loadFreeWindows(db as unknown as D1Database, QUERY, now);
    expect(result.emptyReason).toBeNull();
    expect(result.windows.map(span)).toEqual(["12:00-14:00", "15:00-16:00", "17:00-18:00", "08:00-10:00"]);
    expect(result.windows[0]).toMatchObject({ free: ["p1", "p2", "p4"], unknown: ["p3"], busy: [], minutes: 120 });
    expect(result.windows[3]).toMatchObject({
      free: ["p2", "p4"],
      busy: [{ personId: "p1", reason: "course", label: "高等数学" }],
      unknown: ["p3"],
    });
    expect(result.heatmap).toHaveLength(1);
    expect(result.heatmap[0]!.free).toHaveLength(40);
    expect(result.heatmap[0]!.unknown.every((n) => n === 1)).toBe(true);
    expect(result.rangeStart).toBe("2026-11-10T08:00:00+08:00");
  });

  it("applies buffers and reports busy reasons", async () => {
    const db = await seed();
    const result = await loadFreeWindows(db as unknown as D1Database, { ...QUERY, bufferMinutes: 15, count: 2, personIds: ["p2", "p4"] }, now);
    // 李四 09:45–12:15、13:45–15:15 忙（含缓冲），赵六 15:45 起忙 → 08:00–09:30、12:15–13:45 各 90 分钟。
    expect(result.windows.map(span)).toEqual(["08:00-09:30", "12:15-13:45"]);
  });

  it("enforces required people and marks days outside any term as unknown", async () => {
    const db = await seed();
    const blocked = await loadFreeWindows(db as unknown as D1Database, { ...QUERY, requiredPersonIds: ["p3"] }, now);
    expect(blocked.windows).toEqual([]);
    expect(blocked.emptyReason).toBe("required_unavailable");

    const outside = await loadFreeWindows(db as unknown as D1Database, { ...QUERY, days: 1 }, Date.parse("2026-12-01T07:00:00+08:00"));
    expect(outside.emptyReason).toBe("no_free_time");
    expect(outside.heatmap[0]!.unknown.every((n) => n === 4)).toBe(true);
  });
});

describe("POST /api/free-windows", () => {
  function env(db: D1Stub): Env {
    return {
      DB: db as unknown as D1Database,
      FILES: createFiles() as unknown as R2Bucket,
      CONFIG: createKv() as unknown as KVNamespace,
      ASSETS: {} as Fetcher,
      APP_ENV: "test",
      AUTH_DEV_BYPASS: "true",
      OIDC_ISSUER: "https://id.example",
      OIDC_CLIENT_ID: "test",
    };
  }
  const post = (e: Env, body: unknown) =>
    app.request("/api/free-windows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, e);

  it("validates input and returns a result", async () => {
    const e = env(await seed());
    expect((await post(e, { personIds: [] })).status).toBe(400);
    expect((await post(e, { personIds: ["p1"], requiredPersonIds: ["p2"] })).status).toBe(400);
    expect((await post(e, { personIds: ["p1"], dayStart: "08:10" })).status).toBe(400);
    expect((await post(e, { personIds: ["p1"], days: 29 })).status).toBe(400);
    expect((await post(e, { personIds: ["nobody"] })).status).toBe(400);
    const ok = await post(e, { personIds: ["p1", "p2"], days: 3, count: 2 });
    expect(ok.status).toBe(200);
    const data = (await ok.json()) as { people: unknown[]; cellMinutes: number };
    expect(data.people).toHaveLength(2);
    expect(data.cellMinutes).toBe(15);
  });
});
