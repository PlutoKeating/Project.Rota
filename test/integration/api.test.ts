import { describe, expect, it } from "vitest";
import guards from "../../migrations/0003_assignment_guards.sql?raw";
import ddl from "../../migrations/0001_init.sql?raw";
import app from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createFiles, createKv, D1Stub } from "../helpers/d1";

/**
 * 走真实 HTTP 栈（Hono app.request）的端到端用例：
 * 建学期 → 建组织/成员 → 建课 → 建任务/班次 → 试排 → 分配 → 公平 → 导出。
 * 覆盖「一个管理员从空库到排出第一班」的完整路径。
 */

function makeEnv(): Env {
  const db = new D1Stub(ddl + guards);
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

interface Reply {
  status: number;
  data: any;
  text: string;
}

async function call(env: Env, method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await app.request(
    path,
    {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
}

async function bootstrap(env: Env) {
  const term = await call(env, "POST", "/api/terms", {
    name: "2026 秋",
    startDate: "2026-09-07",
    weekCount: 4,
    periods: [
      { periodIndex: 1, startTime: "08:00", endTime: "08:45" },
      { periodIndex: 2, startTime: "08:55", endTime: "09:40" },
    ],
  });
  expect(term.status).toBe(200);

  const org = await call(env, "POST", "/api/orgs", { name: "宣传部", kind: "department" });
  expect(org.status).toBe(200);

  const zhang = await call(env, "POST", "/api/persons", { fullName: "张三", studentNo: "2026001" });
  const li = await call(env, "POST", "/api/persons", { fullName: "李四", studentNo: "2026002" });
  expect(zhang.status).toBe(200);
  expect(li.status).toBe(200);

  for (const id of [zhang.data.id, li.data.id]) {
    const membership = await call(env, "POST", "/api/memberships", { personId: id, orgId: org.data.id });
    expect(membership.status).toBe(200);
  }

  return {
    termId: term.data.term.id as string,
    orgId: org.data.id as string,
    zhangId: zhang.data.id as string,
    liId: li.data.id as string,
  };
}

describe("完整排班流程", () => {
  it("从空库到排出第一班", async () => {
    const env = makeEnv();
    const { termId, orgId, zhangId, liId } = await bootstrap(env);

    const detail = await call(env, "GET", `/api/terms/${termId}`);
    expect(detail.status).toBe(200);
    expect(detail.data.counts.slots).toBe(4 * 7 * 2);

    const course = await call(env, "POST", "/api/courses", {
      termId,
      name: "高等数学",
      teacher: "李老师",
      personIds: [zhangId],
      meetings: [{ weekday: 1, periodFrom: 1, periodTo: 1, patternKind: "all", location: "A101" }],
    });
    expect(course.status).toBe(200);

    const timetable = await call(env, "GET", `/api/persons/${zhangId}/timetable?termId=${termId}&week=1`);
    expect(timetable.status).toBe(200);
    const monday = (timetable.data.cells as any[]).find((cell) => cell.weekday === 1 && cell.periodIndex === 1);
    expect(monday.courses[0]?.courseName).toBe("高等数学");

    const task = await call(env, "POST", "/api/tasks", {
      orgId,
      title: "迎新值班",
      kind: "oneoff",
      windowStart: "2026-09-07T00:00:00+08:00",
      windowEnd: "2026-09-07T23:59:00+08:00",
    });
    expect(task.status).toBe(200);

    const shift = await call(env, "POST", `/api/tasks/${task.data.id}/shifts`, {
      startsAt: "2026-09-07T08:00:00+08:00",
      endsAt: "2026-09-07T08:45:00+08:00",
      requiredHeadcount: 1,
    });
    expect(shift.status).toBe(200);

    const preview = await call(env, "POST", `/api/shifts/${shift.data.id}/preview`, {});
    expect(preview.status).toBe(200);
    expect((preview.data.candidates as any[]).map((c) => c.personId)).toEqual([liId]);
    expect(preview.data.excluded[0]).toMatchObject({ personId: zhangId, reason: "busy" });

    const assigned = await call(env, "POST", `/api/shifts/${shift.data.id}/assign`, { personId: liId });
    expect(assigned.status).toBe(200);
    expect(assigned.data.assignment.personId).toBe(liId);

    const fairness = await call(env, "GET", `/api/fairness?orgId=${orgId}`);
    expect(fairness.status).toBe(200);
    expect(fairness.data.items[0]).toMatchObject({ personId: liId, shiftCount: 1, windowKey: "2026 秋-W1" });

    const board = await call(env, "GET", `/api/shifts?orgId=${orgId}`);
    expect(board.status).toBe(200);
    expect(board.data.items[0].assignments[0].personName).toBe("李四");

    const csv = await call(env, "GET", `/api/export/schedule.csv?orgId=${orgId}`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("迎新值班");
  });

  it("撤销后班次与账本一起回滚", async () => {
    const env = makeEnv();
    const { orgId, liId } = await bootstrap(env);
    const task = await call(env, "POST", "/api/tasks", { orgId, title: "值班", kind: "oneoff" });
    const shift = await call(env, "POST", `/api/tasks/${task.data.id}/shifts`, {
      startsAt: "2026-09-08T08:00:00+08:00",
      endsAt: "2026-09-08T08:45:00+08:00",
    });
    const assigned = await call(env, "POST", `/api/shifts/${shift.data.id}/assign`, { personId: liId });
    expect(assigned.status).toBe(200);

    const removed = await call(env, "DELETE", `/api/assignments/${assigned.data.assignment.id}`);
    expect(removed.status).toBe(200);

    const fairness = await call(env, "GET", `/api/fairness?orgId=${orgId}`);
    expect(fairness.data.items[0]?.shiftCount ?? 0).toBe(0);

    const preview = await call(env, "POST", `/api/shifts/${shift.data.id}/preview`, {});
    expect(preview.data.candidates.length).toBeGreaterThan(0);
  });

  it("管理接口与健康检查可达", async () => {
    const env = makeEnv();
    const health = await call(env, "GET", "/api/health");
    expect(health.status).toBe(200);
    expect(health.data.db).toBe("up");

    const me = await call(env, "GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.data.mode).toBe("disabled");

    const settings = await call(env, "GET", "/api/admin/settings");
    expect(settings.status).toBe(200);
    expect(settings.data.weights.fairness).toBeGreaterThan(0);
  });
});

describe("课表导入", () => {
  it("CSV 解析 → 待确认 → 落库后可查课表", async () => {
    const env = makeEnv();
    const { termId, zhangId } = await bootstrap(env);

    const csv = [
      "课程名称,星期,节次,周次,地点",
      "高等数学,周一,1-2,1-8,A101",
      "大学英语,周三,3-4,单周,B202",
    ].join("\n");

    const form = new FormData();
    form.append("file", new File([csv], "timetable.csv", { type: "text/csv" }));
    form.append("sourceKind", "csv");
    form.append("termId", termId);
    form.append("personId", zhangId);

    const upload = await app.request("/api/imports", { method: "POST", body: form }, env);
    expect([200, 201]).toContain(upload.status);
    const job = (await upload.json()) as any;
    expect(job.status).toBe("needs_review");
    expect(job.parsed.courses.length).toBe(2);
    expect(job.parsed.courses[0].meetings[0]).toMatchObject({ weekday: 1, periodFrom: 1, periodTo: 2 });

    const applied = await call(env, "POST", `/api/imports/${job.id}/apply`, {});
    expect(applied.status).toBe(200);

    const timetable = await call(env, "GET", `/api/persons/${zhangId}/timetable?termId=${termId}&week=1`);
    expect(timetable.status).toBe(200);
    const monday = (timetable.data.cells as any[]).find((cell) => cell.weekday === 1 && cell.periodIndex === 1);
    expect(monday.courses.length).toBeGreaterThan(0);
  });
});

describe("周期班次与编辑后导入", () => {
  it("按周生成班次是幂等的", async () => {
    const env = makeEnv();
    const { orgId } = await bootstrap(env);
    const task = await call(env, "POST", "/api/tasks", {
      orgId,
      title: "每周例会",
      kind: "recurring",
      windowStart: "2026-09-07T00:00:00+08:00",
      windowEnd: "2026-10-04T23:59:00+08:00",
    });
    expect(task.status).toBe(200);

    const body = { weekday: 2, periodFrom: 1, periodTo: 2, patternKind: "all", requiredHeadcount: 2 };
    const first = await call(env, "POST", `/api/tasks/${task.data.id}/shifts/generate`, body);
    expect(first.status).toBe(200);
    expect(first.data.created).toBe(4);

    const second = await call(env, "POST", `/api/tasks/${task.data.id}/shifts/generate`, body);
    expect(second.data.created).toBe(0);
    expect(second.data.skipped).toBe(4);

    const shifts = await call(env, "GET", `/api/tasks/${task.data.id}/shifts`);
    expect(shifts.data.items).toHaveLength(4);
    expect(shifts.data.items[0].startsAt).toContain("2026-09-08T08:00:00");
  });

  it("确认页改过的解析结果优先落库", async () => {
    const env = makeEnv();
    const { termId, zhangId } = await bootstrap(env);

    const form = new FormData();
    form.append("file", new File(["课程,星期,节次,周次\n旧名字,周一,1-1,1-4"], "t.csv", { type: "text/csv" }));
    form.append("sourceKind", "csv");
    form.append("termId", termId);
    form.append("personId", zhangId);

    const upload = await app.request("/api/imports", { method: "POST", body: form }, env);
    const job = (await upload.json()) as any;

    const edited = { ...job.parsed, courses: [{ ...job.parsed.courses[0], name: "新名字" }] };
    const applied = await call(env, "POST", `/api/imports/${job.id}/apply`, { parsed: edited, overwrite: false });
    expect(applied.status).toBe(200);

    const courses = await call(env, "GET", `/api/courses?termId=${termId}&personId=${zhangId}`);
    expect((courses.data.items as any[]).map((c) => c.name)).toContain("新名字");
  });
});

describe("管理后台", () => {
  it("模型供应商 CRUD 不回传密钥内容", async () => {
    const env = makeEnv();
    const created = await call(env, "POST", "/api/admin/llm-providers", {
      name: "默认视觉模型",
      kind: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      apiKeySecret: "LLM_API_KEY",
      enabled: true,
    });
    expect([200, 201]).toContain(created.status);
    expect(created.data.apiKeySecret).toBe("LLM_API_KEY");
    expect(JSON.stringify(created.data)).not.toContain("sk-");

    const patched = await call(env, "PATCH", `/api/admin/llm-providers/${created.data.id}`, { enabled: false });
    expect(patched.status).toBe(200);

    const listed = await call(env, "GET", "/api/admin/llm-providers");
    expect(listed.data.items).toHaveLength(1);
    expect(listed.data.items[0].enabled).toBe(false);

    const removed = await call(env, "DELETE", `/api/admin/llm-providers/${created.data.id}`);
    expect(removed.status).toBe(200);
    expect((await call(env, "GET", "/api/admin/llm-providers")).data.items).toHaveLength(0);
  });

  it("设置可读写并落到 KV", async () => {
    const env = makeEnv();
    const current = await call(env, "GET", "/api/admin/settings");
    const next = { ...current.data, defaultCooldownDays: 5, weights: { ...current.data.weights, fairness: 0.6 } };
    const saved = await call(env, "PUT", "/api/admin/settings", next);
    expect(saved.status).toBe(200);
    expect(saved.data.defaultCooldownDays).toBe(5);
    expect(saved.data.weights.fairness).toBe(0.6);
  });
});

describe("导入事务", () => {
  it("后续课程冲突时，前面的新课程也不会留下", async () => {
    const env = makeEnv();
    const { termId, zhangId } = await bootstrap(env);
    await call(env, "POST", "/api/courses", { termId, name: "已有课程", personIds: [zhangId], meetings: [{ weekday: 1, periodFrom: 1, periodTo: 1, patternKind: "all" }] });
    const form = new FormData();
    form.append("file", new File(["课程,星期,节次,周次\n新课程,周二,1-1,1-4\n已有课程,周一,1-1,1-4"], "test.csv"));
    form.append("termId", termId); form.append("personId", zhangId); form.append("sourceKind", "csv");
    const job = await (await app.request("/api/imports", { method: "POST", body: form }, env)).json() as any;
    expect((await call(env, "POST", `/api/imports/${job.id}/apply`, {})).status).toBe(409);
    const courses = await call(env, "GET", `/api/courses?termId=${termId}`);
    expect(courses.data.items.map((c: any) => c.name)).toEqual(["已有课程"]);
    expect((await call(env, "GET", `/api/imports/${job.id}`)).data.status).toBe("needs_review");
  });
});
