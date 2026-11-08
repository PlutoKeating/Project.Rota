import { describe, it, expect } from "vitest";
import ddl from "../../migrations/0001_init.sql?raw";
import guards from "../../migrations/0003_assignment_guards.sql?raw";
import app from "../../src/worker/index";
import { D1Stub, createKv } from "../helpers/d1";
import type { Env } from "../../src/worker/env";
import {
  diff,
  emptySnapshot,
  materialize,
  mutate,
  validate,
  validateTransition,
  type Snapshot,
  type Evidence,
} from "../../src/shared/agent-import/model";
function env(): Env {
  return {
    DB: new D1Stub(ddl + guards) as unknown as D1Database,
    CONFIG: createKv() as unknown as KVNamespace,
    APP_ENV: "test",
    AUTH_DEV_BYPASS: "true",
  } as Env;
}
async function request(e: Env, method: string, path: string, body?: unknown) {
  const res = await app.request(
    "/api" + path,
    {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    e,
  );
  return { status: res.status, data: (await res.json()) as any };
}
function draft(base: Snapshot) {
  const s = structuredClone(base);
  mutate(s, "organization", "create", { name: "新媒体" }, "org");
  mutate(
    s,
    "person",
    "create",
    { full_name: "甲", class_name: "会计2601" },
    "p",
  );
  mutate(s, "membership", "create", { person_id: "p", org_id: "org" }, "m");
  mutate(
    s,
    "term",
    "create",
    { name: "2026 秋", start_date: "2026-09-07", week_count: 2 },
    "term",
  );
  mutate(
    s,
    "class_period",
    "create",
    {
      term_id: "term",
      period_index: 1,
      start_time: "08:00",
      end_time: "08:45",
    },
    "period",
  );
  mutate(
    s,
    "timetable_profile",
    "create",
    {
      term_id: "term",
      name: "晚课作息",
      periods: JSON.stringify([{ index: 1, start: "19:00", end: "19:45" }]),
    },
    "profile",
  );
  mutate(
    s,
    "timetable_entry",
    "create",
    {
      person_id: "p",
      term_id: "term",
      profile_id: "profile",
      name: "高数",
      weekday: 1,
      period_from: 1,
      period_to: 1,
      weeks: "[1,2]",
    },
    "entry",
  );
  return s;
}
function changes(base: Snapshot, s: Snapshot) {
  const evidence: Record<string, Evidence[]> = {};
  for (const [entity, rows] of [...Object.entries(base), ...Object.entries(s)])
    for (const r of rows)
      evidence[entity + ":" + r.id] = [
        {
          source: "课表.png",
          locator: "整页",
          explanation: "材料明确记载",
          inferred: false,
        },
      ];
  return diff(base, s, evidence);
}
describe("browser Agent import transactional boundary", () => {
  it("keeps draft local; applies independent evening timetable atomically and idempotently", async () => {
    const e = env();
    const base = (await request(e, "GET", "/agent-imports/snapshot")).data
        .data as Snapshot,
      s = draft(base),
      payload = { changes: changes(base, s), summary: "复核通过" };
    const id = (await request(e, "POST", "/agent-imports")).data.id;
    expect((await request(e, "GET", "/persons")).data.items).toHaveLength(0);
    expect(
      (await request(e, "POST", `/agent-imports/${id}/apply`, payload)).status,
    ).toBe(409);
    expect(
      (await request(e, "POST", `/agent-imports/${id}/lease`, {})).status,
    ).toBe(409);
    expect(
      (await request(e, "POST", `/agent-imports/${id}/lease`, payload)).status,
    ).toBe(200);
    // Keep-alive extends the held locks without re-sending the change set.
    expect(
      (await request(e, "POST", `/agent-imports/${id}/lease`, {})).status,
    ).toBe(200);
    const applied = await request(
      e,
      "POST",
      `/agent-imports/${id}/apply`,
      payload,
    );
    expect(applied).toMatchObject({ status: 200, data: { ok: true } });
    expect(
      (await e.DB.prepare("select * from timetable_event").all()).results,
    ).toHaveLength(2);
    expect(
      (await request(e, "POST", `/agent-imports/${id}/apply`, payload)).status,
    ).toBe(200);
    expect(
      (await e.DB.prepare("select * from person").all()).results,
    ).toHaveLength(1);
    const task = await request(e, "POST", "/tasks", {
      orgId: "org",
      title: "晚间工作",
    });
    const shift = await request(e, "POST", `/tasks/${task.data.id}/shifts`, {
      startsAt: "2026-09-07T19:00:00+08:00",
      endsAt: "2026-09-07T20:00:00+08:00",
      requiredHeadcount: 1,
    });
    const preview = await request(
      e,
      "POST",
      `/shifts/${shift.data.id}/preview`,
      {},
    );
    expect(preview.status).toBe(200);
    expect(preview.data.candidates).toHaveLength(0);
    expect(preview.data.excluded.some((x: any) => x.personId === "p")).toBe(
      true,
    );
  });
  it("rejects invalid references before any business write", async () => {
    const e = env(),
      base = emptySnapshot(),
      s = draft(base);
    s.membership[0].org_id = "missing";
    const id = (await request(e, "POST", "/agent-imports")).data.id;
    const payload = { changes: changes(base, s) };
    await request(e, "POST", `/agent-imports/${id}/lease`, payload);
    expect(
      (await request(e, "POST", `/agent-imports/${id}/apply`, payload)).status,
    ).toBe(400);
    expect(
      (await e.DB.prepare("SELECT * FROM person").all()).results,
    ).toHaveLength(0);
  });
  it("enforces leases against ordinary CRUD and releases on expiry", async () => {
    const e = env();
    await request(e, "POST", "/persons", {
      fullName: "原人员",
      studentNo: "123",
    });
    const base = (await request(e, "GET", "/agent-imports/snapshot")).data
        .data as Snapshot,
      s = structuredClone(base);
    s.person[0].full_name = "改名";
    const id = (await request(e, "POST", "/agent-imports")).data.id;
    expect(
      (
        await request(e, "POST", `/agent-imports/${id}/lease`, {
          changes: changes(base, s),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(e, "PATCH", `/persons/${s.person[0].id}`, {
          fullName: "其他修改",
        })
      ).status,
    ).toBe(409);
    await e.DB.prepare("UPDATE agent_lock SET expires_at=0").run();
    expect(
      (
        await request(e, "PATCH", `/persons/${s.person[0].id}`, {
          fullName: "其他修改",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(e, "POST", `/agent-imports/${id}/apply`, {
          changes: changes(base, s),
        })
      ).status,
    ).toBe(409);
  });
  it("rejects unknown columns and forged before values", async () => {
    const e = env(),
      base = emptySnapshot(),
      s = draft(base),
      id = (await request(e, "POST", "/agent-imports")).data.id;
    const c = changes(base, s);
    c[0].after!.sql = "DROP TABLE person";
    expect(
      (await request(e, "POST", `/agent-imports/${id}/lease`, { changes: c }))
        .status,
    ).toBe(409);
    expect(
      (await e.DB.prepare("select * from person").all()).results,
    ).toHaveLength(0);
  });
  it("validates assignment conflicts using absolute times across different profiles", () => {
    const base = emptySnapshot(),
      s = draft(base);
    mutate(s, "task", "create", { title: "采访", org_id: "org" }, "task");
    mutate(
      s,
      "shift",
      "create",
      {
        task_id: "task",
        starts_at: "2026-09-07T19:10:00+08:00",
        ends_at: "2026-09-07T20:10:00+08:00",
        required_headcount: 1,
      },
      "shift",
    );
    mutate(
      s,
      "assignment",
      "create",
      { shift_id: "shift", person_id: "p" },
      "a",
    );
    expect(
      validate(materialize(s, base)).some((x) =>
        x.message.includes("课表/不可用"),
      ),
    ).toBe(true);
  });
  it("imports a 100-person batch without exceeding the transaction statement budget", async () => {
    const e = env(),
      base = emptySnapshot(),
      s = draft(base);
    s.term[0].week_count = 20;
    s.timetable_entry = [];
    for (let i = 0; i < 100; i++) {
      const pid = "student-" + i;
      mutate(s, "person", "create", { full_name: "成员" + i }, pid);
      mutate(
        s,
        "membership",
        "create",
        { person_id: pid, org_id: "org" },
        "member-" + i,
      );
      for (let course = 0; course < 8; course++)
        mutate(
          s,
          "timetable_entry",
          "create",
          {
            person_id: pid,
            term_id: "term",
            profile_id: "profile",
            name: "课程" + course,
            weekday: (course % 7) + 1,
            period_from: 1,
            period_to: 1,
            weeks: JSON.stringify(Array.from({ length: 20 }, (_, n) => n + 1)),
          },
          "entry-" + i + "-" + course,
        );
    }
    const payload = { changes: changes(base, s) },
      id = (await request(e, "POST", "/agent-imports")).data.id;
    expect(
      (await request(e, "POST", `/agent-imports/${id}/lease`, payload)).status,
    ).toBe(200);
    expect(
      (await request(e, "POST", `/agent-imports/${id}/apply`, payload)).status,
    ).toBe(200);
    expect(
      (
        await e.DB.prepare("select count(*) as n from timetable_event").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(16000);
  }, 20000);
  it("rolls back business rows and commit metadata if audit persistence fails", async () => {
    const e = env(),
      base = emptySnapshot(),
      s = draft(base),
      payload = { changes: changes(base, s) },
      id = (await request(e, "POST", "/agent-imports")).data.id;
    await request(e, "POST", `/agent-imports/${id}/lease`, payload);
    await e.DB.prepare(
      "CREATE TRIGGER reject_agent_audit BEFORE INSERT ON audit_event BEGIN SELECT RAISE(ABORT,'test_failure'); END",
    ).run();
    expect(
      (await request(e, "POST", `/agent-imports/${id}/apply`, payload)).status,
    ).toBe(409);
    expect(
      (
        await e.DB.prepare("select count(*) as n from person").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await e.DB.prepare(
          "select count(*) as n from agent_commit_context",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect((await request(e, "GET", `/agent-imports/${id}`)).data.status).toBe(
      "draft",
    );
  });
});

it("allows unrelated changes despite historical problems, but rejects newly introduced violations", () => {
  const before = emptySnapshot();
  mutate(
    before,
    "term",
    "create",
    { name: "历史学期", start_date: "2026-09-07", week_count: 2 },
    "historical",
  );
  const after = structuredClone(before);
  mutate(
    after,
    "person",
    "create",
    { full_name: "新成员", student_no: "123" },
    "new",
  );
  expect(validateTransition(before, after)).toEqual([]);
  mutate(
    after,
    "person",
    "create",
    { full_name: "另一人", student_no: "123" },
    "duplicate",
  );
  expect(
    validateTransition(before, after).some((i) =>
      i.message.includes("student_no"),
    ),
  ).toBe(true);
});

it("atomically reparents existing departments to newly created parents while deleting the old parent", async () => {
  const e = env();
  await e.DB.prepare(
    "INSERT INTO organization(id,name,kind,status,created_at) VALUES('old','旧上级','department','active','2026-01-01T00:00:00Z')",
  ).run();
  await e.DB.prepare(
    "INSERT INTO organization(id,name,parent_id,kind,status,created_at) VALUES('child','新媒体','old','department','active','2026-01-01T00:00:00Z')",
  ).run();
  const base = (await request(e, "GET", "/agent-imports/snapshot")).data
    .data as Snapshot;
  const next = structuredClone(base);
  mutate(next, "organization", "create", { name: "新上级" }, "new");
  mutate(next, "organization", "update", { parent_id: "new" }, "child");
  mutate(next, "organization", "delete", {}, "old");
  const id = (await request(e, "POST", "/agent-imports")).data.id;
  const payload = { changes: changes(base, next) };
  expect(
    (await request(e, "POST", `/agent-imports/${id}/lease`, payload)).status,
  ).toBe(200);
  expect(
    (await request(e, "POST", `/agent-imports/${id}/apply`, payload)).status,
  ).toBe(200);
  expect(
    (
      await e.DB.prepare(
        "SELECT parent_id FROM organization WHERE id='child'",
      ).first<{ parent_id: string }>()
    )?.parent_id,
  ).toBe("new");
});

it("atomically retains reviewed structured evidence after browser material cleanup and rejects changing it on retry", async () => {
  const e = env(),
    base = emptySnapshot(),
    s = draft(base);
  const review = {
    version: 1,
    timetables: [],
    calendars: [],
    checks: {},
    consistency_review: [],
    unresolved: ["测试：附注保留在正式审核记录"],
  };
  const payload = { changes: changes(base, s), summary: "审核通过", review };
  const id = (await request(e, "POST", "/agent-imports")).data.id;
  expect(
    (await request(e, "GET", `/agent-imports/${id}/report`)).data.review,
  ).toBeNull();
  expect(
    (await request(e, "POST", `/agent-imports/${id}/lease`, payload)).status,
  ).toBe(200);
  expect(
    (await request(e, "POST", `/agent-imports/${id}/apply`, payload)).status,
  ).toBe(200);
  expect(
    (await request(e, "GET", `/agent-imports/${id}/report`)).data.review,
  ).toEqual(review);
  expect((await request(e, "GET", "/agent-imports")).data.items[0].id).toBe(id);
  expect(
    (await request(e, "POST", `/agent-imports/${id}/apply`, payload)).status,
  ).toBe(200);
  expect(
    (
      await request(e, "POST", `/agent-imports/${id}/apply`, {
        ...payload,
        review: { ...review, unresolved: [] },
      })
    ).status,
  ).toBe(409);
});

it("commits reviewed calendar, timed courses and individually unscheduled courses through the real transaction", async () => {
  const { stageCalendar, calendarSchema } = await import(
    "../../src/shared/agent-import/calendar"
  );
  const { stageTimetable, timetableProposalSchema } = await import(
    "../../src/shared/agent-import/timetable"
  );
  const e = env(),
    base = emptySnapshot();
  const sources = [
    {
      source: "课程.txt",
      locator: "全文",
      explanation: "合成完整材料",
      inferred: false,
    },
  ];
  const calendar = calendarSchema.parse({
    id: "c",
    name: "秋季",
    start_date: "2026-08-31",
    week_count: 18,
    periods: [{ index: 1, start: "08:30", end: "09:15" }],
    timetable_ids: ["p"],
    sources,
  });
  const c = stageCalendar(base, {}, calendar);
  const p = stageTimetable(
    c.draft,
    c.evidence,
    timetableProposalSchema.parse({
      id: "p",
      person: { id: "person", full_name: "甲" },
      term_name: "秋季",
      term_id: c.termId,
      profile_id: c.profileId,
      sources,
      entries: [
        {
          name: "数学",
          weekday: 1,
          period_from: 1,
          period_to: 1,
          weeks: [1, 9],
          teacher: "教师甲",
          location: "101",
        },
        { name: "劳动教育", no_fixed_time: true, note: "原件明确无固定时间" },
      ],
    }),
  );
  const id = (await request(e, "POST", "/agent-imports")).data.id;
  const payload = {
    changes: diff(base, p.draft, p.evidence),
    review: {
      version: 1,
      timetables: [p.proposal],
      calendars: [calendar],
      checks: {},
      unresolved: [],
    },
  };
  expect(
    (await request(e, "POST", `/agent-imports/${id}/lease`, payload)).status,
  ).toBe(200);
  expect(
    (await request(e, "POST", `/agent-imports/${id}/apply`, payload)).status,
  ).toBe(200);
  const db = (await request(e, "GET", "/agent-imports/snapshot")).data.data;
  expect(db.timetable_event).toHaveLength(2);
  expect(db.timetable_entry[0]).toMatchObject({
    teacher: "教师甲",
    location: "101",
  });
  expect(db.course[0].name).toBe("劳动教育");
  expect(db.enrollment[0].person_id).toBe("person");
  expect(db.course_occurrence).toHaveLength(0);
  const report = (await request(e, "GET", `/agent-imports/${id}/report`)).data
    .review;
  expect(report.timetables[0].entries[1].note).toBe("原件明确无固定时间");
});
