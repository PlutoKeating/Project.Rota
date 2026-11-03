import { describe, expect, it } from "vitest";
import ddl from "../../migrations/0001_init.sql?raw";
import { assignShift, previewShift, unassign, type ScheduleConfig } from "../../src/worker/domain/scheduler";
import { listFairness } from "../../src/worker/domain/ledger";
import { D1Stub } from "../helpers/d1";

/**
 * 端到端（真实 SQL，无 workerd）：
 * 建学期/格子/组织/成员/课程/班次 → 试排 → 确认 → 账本 → 撤销。
 * 这是本机唯一能验证「有空/没空」链路的方式。
 */

const CONFIG: ScheduleConfig = {
  cooldownDays: 3,
  weights: { fairness: 0.45, starvation: 0.3, preference: 0.15, priority: 0.1, recency: 0.2 },
};

const NOW = "2026-09-01T00:00:00.000Z";

async function run(db: D1Stub, sql: string, ...params: (string | number | null)[]): Promise<void> {
  await db.prepare(sql).bind(...params).run();
}

async function seed(): Promise<D1Stub> {
  const db = new D1Stub(ddl);

  await run(
    db,
    "insert into term (id,name,start_date,week_count,timezone,status,created_at) values (?,?,?,?,?,?,?)",
    "t1", "2026 秋", "2026-09-07", 5, "Asia/Shanghai", "active", NOW,
  );

  await run(
    db,
    "insert into slot (id,term_id,week_index,weekday,period_index,starts_at,ends_at) values (?,?,?,?,?,?,?)",
    "s1", "t1", 1, 1, 1, "2026-09-07T08:00:00+08:00", "2026-09-07T08:45:00+08:00",
  );

  await run(
    db,
    "insert into organization (id,code,name,parent_id,kind,status,created_at,updated_at) values (?,?,?,?,?,?,?,?)",
    "o1", "XCB", "宣传部", null, "department", "active", NOW, null,
  );

  for (const [id, name] of [["p1", "张三"], ["p2", "李四"], ["p3", "王五"]] as const) {
    await run(
      db,
      "insert into person (id,student_no,full_name,email,phone,status,created_at,updated_at) values (?,?,?,?,?,?,?,?)",
      id, id.toUpperCase(), name, null, null, "active", NOW, null,
    );
    await run(
      db,
      "insert into membership (id,person_id,org_id,role_id,status,valid_from,valid_to,is_primary,created_at) values (?,?,?,?,?,?,?,?,?)",
      `m-${id}`, id, "o1", null, "active", "2026-09-01", null, 1, NOW,
    );
  }

  // 张三周一第 1 节有课
  await run(
    db,
    "insert into course (id,term_id,code,name,teacher,created_at) values (?,?,?,?,?,?)",
    "c1", "t1", "MATH", "高等数学", "李老师", NOW,
  );
  await run(
    db,
    "insert into course_meeting (id,course_id,term_id,weekday,period_from,period_to,pattern_kind,week_ranges,location) values (?,?,?,?,?,?,?,?,?)",
    "cm1", "c1", "t1", 1, 1, 1, "all", null, "A101",
  );
  await run(
    db,
    "insert into course_occurrence (id,meeting_id,slot_id,status,note) values (?,?,?,?,?)",
    "co1", "cm1", "s1", "scheduled", null,
  );
  await run(
    db,
    "insert into enrollment (id,person_id,course_id,term_id,status,created_at) values (?,?,?,?,?,?)",
    "e1", "p1", "c1", "t1", "active", NOW,
  );

  await run(
    db,
    "insert into task (id,org_id,title,description,kind,status,window_start,window_end,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)",
    "task1", "o1", "迎新值班", null, "oneoff", "open", "2026-09-07T00:00:00+08:00", "2026-09-07T23:59:00+08:00", NOW, null,
  );
  await run(
    db,
    "insert into shift (id,task_id,starts_at,ends_at,required_headcount,required_role_id,required_skill_id,location,status,created_at) values (?,?,?,?,?,?,?,?,?,?)",
    "sh1", "task1", "2026-09-07T08:00:00+08:00", "2026-09-07T08:45:00+08:00", 1, null, null, "门口", "open", NOW,
  );

  return db;
}

describe("排班链路", () => {
  it("有课的人被排除，空的人成为候选", async () => {
    const db = await seed();
    const preview = await previewShift(db as unknown as D1Database, "sh1", CONFIG);

    expect(preview.candidates.map((c) => c.personId).sort()).toEqual(["p2", "p3"]);
    expect(preview.excluded).toEqual(
      expect.arrayContaining([expect.objectContaining({ personId: "p1", reason: "busy" })]),
    );
  });

  it("确认分配后写 assignment、班次满员、账本 +1", async () => {
    const db = await seed();
    const result = await assignShift(db as unknown as D1Database, "sh1", "p2", CONFIG, "tester");

    expect(result.assignment.personId).toBe("p2");
    expect(result.assignment.status).toBe("confirmed");

    const shift = await db.prepare("select status from shift where id = ?").bind("sh1").first<{ status: string }>();
    expect(shift?.status).toBe("filled");

    const rows = await listFairness(db as unknown as D1Database, { orgId: "o1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ personId: "p2", shiftCount: 1, minutes: 45, windowKey: "2026 秋-W1" });
  });

  it("撤销后账本归零、班次回到 open", async () => {
    const db = await seed();
    const created = await assignShift(db as unknown as D1Database, "sh1", "p2", CONFIG, "tester");
    await unassign(db as unknown as D1Database, created.assignment.id, "tester");

    const rows = await listFairness(db as unknown as D1Database, { orgId: "o1" });
    expect(rows[0]?.shiftCount ?? 0).toBe(0);

    const shift = await db.prepare("select status from shift where id = ?").bind("sh1").first<{ status: string }>();
    expect(shift?.status).toBe("open");
  });

  it("不可指定有课的人", async () => {
    const db = await seed();
    await expect(
      assignShift(db as unknown as D1Database, "sh1", "p1", CONFIG, "tester"),
    ).rejects.toThrow(/无法安排/);
  });

  it("重复分配同一人被唯一键挡住", async () => {
    const db = await seed();
    await assignShift(db as unknown as D1Database, "sh1", "p2", CONFIG, "tester");
    await expect(
      assignShift(db as unknown as D1Database, "sh1", "p3", CONFIG, "tester"),
    ).rejects.toThrow(/人数已满/);
  });
});
