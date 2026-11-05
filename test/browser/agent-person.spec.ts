import { test, expect, type Page } from "@playwright/test";
import { emptySnapshot } from "../../src/shared/agent-import/model";
import JSZip from "jszip";
const evidence = (path: string) => [
  {
    source: path,
    locator: "全文",
    explanation: "合成测试材料",
    inferred: false,
  },
];
const fields = {
  source_person_names: [],
  source_student_numbers: [],
  identity: "已核对",
  courses_and_times: "已逐项核对",
  teachers_and_locations: "原件未提供，不猜造",
  calendar: "使用公共日历",
  coverage: "complete",
  coverage_reason: "完整合成课表",
  checked_entries: [0],
};
const calendar = {
  id: "cal",
  name: "秋季",
  start_date: "2026-08-31",
  week_count: 2,
  periods: [{ index: 1, start: "08:00", end: "08:45" }],
  timetable_ids: [],
  sources: evidence("a.txt"),
};
const assignment = (key: string) => ({
  key,
  label: key,
  sources: [key + ".txt"],
});
function output(calls: { name: string; args: any }[]) {
  const resolved = calls.map((c, i) => ({ ...c, id: "call-" + i }));
  return {
    calls: resolved,
    messages: [
      {
        role: "assistant",
        content: resolved.map((c) => ({
          type: "tool-call",
          toolCallId: c.id,
          toolName: c.name,
          input: c.args,
        })),
      },
    ],
    model: "synthetic",
    providerId: "fake",
  };
}
function discovery(keys = ["a", "b"], complete = true) {
  return output([
    { name: "read_document", args: { path: "a.txt" } },
    { name: "dispatch_people", args: { people: keys.map(assignment) } },
    ...(complete
      ? [{ name: "save_calendars", args: { calendars: [calendar] } }]
      : []),
    { name: "finish_discovery", args: {} },
  ]);
}
function personReply(body: any, complete = true) {
  const c = JSON.parse(body.context);
  if (body.mode === "person")
    return output([
      {
        name: "write_person",
        args: {
          information: {
            full_name: c.person.key === "a" ? "甲" : "乙",
            student_no: c.person.key,
          },
          timetables: [
            {
              key: "fall",
              term_name: "秋季",
              calendar_id: complete ? "cal" : null,
              entries: [
                {
                  name: "数学",
                  weekday: 1,
                  period_from: 1,
                  period_to: 1,
                  weeks: [1, 2],
                },
              ],
              sources: evidence(c.person.key + ".txt"),
            },
          ],
        },
      },
      { name: "finish_person", args: {} },
    ]);
  if (body.mode === "verify")
    return output([
      { name: "finish_person", args: { checks: [{ key: "fall", ...fields, verified_entries: Object.values(c.person.timetables).flatMap((t: any) => t.entries.map((entry: any, index: number) => ({ ...entry, index, weekday: 1, period_from: 1, period_to: 1, weeks: [1, 2] }))) }] } },
    ]);
  return output([{ name: "finish_import", args: {} }]);
}
async function setup(page: Page, turn: (body: any) => any | Promise<any>) {
  const applied: any[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: any = { status: "draft" };
    if (path.endsWith("/auth/me"))
      data = {
        authenticated: true,
        user: { id: "owner", role: "owner", name: "测试" },
      };
    else if (path.endsWith("/snapshot"))
      data = { data: emptySnapshot(), version: 0 };
    else if (path === "/api/agent-imports")
      data =
        route.request().method() === "GET"
          ? { items: [] }
          : { id: "object-test" };
    else if (path.endsWith("/turn"))
      data = await turn(route.request().postDataJSON());
    else if (path.endsWith("/apply")) {
      applied.push(route.request().postDataJSON());
      data = { ok: true };
    }
    await route.fulfill({ json: data });
  });
  await page.goto("/#/imports");
  return applied;
}
async function upload(page: Page, keys = ["a", "b"]) {
  await page.getByLabel("选择导入材料").setInputFiles(
    keys.map((key) => ({
      name: key + ".txt",
      mimeType: "text/plain",
      buffer: Buffer.from(key + " 学号 " + key + " 数学 周一 第1节 第1-2周"),
    })),
  );
}
async function saved(page: Page) {
  return page.evaluate(async () => {
    const { listJobs } = await import("/src/client/agent-import/store.ts");
    return (await listJobs("owner"))[0];
  });
}
test("independent people overlap model requests and commit only after human review", async ({
  page,
}) => {
  let active = 0,
    peak = 0;
  const modes: string[] = [];
  const applied = await setup(page, async (body) => {
    modes.push(body.mode);
    if (body.mode === "discover") return discovery();
    if (body.mode === "person") {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 120));
      active--;
    }
    return personReply(body);
  });
  await upload(page);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(peak).toBe(2);
  expect(modes.filter((m) => m === "person")).toHaveLength(2);
  expect(modes.filter((m) => m === "verify")).toHaveLength(2);
  expect(applied).toHaveLength(0);
  const job = await saved(page);
  expect(
    Object.values(job.session.people).every((p: any) => p.status === "done"),
  ).toBe(true);
  expect(Object.keys(job.timetables)).toHaveLength(2);
  expect(job.draft.person).toHaveLength(2);
  const preloads = await page.evaluate(async (id) => {
    const { readHistory } = await import("/src/client/agent-import/store.ts");
    const rows = [];
    for (let offset = 0; ; offset += 10) {
      const page = await readHistory(id, offset);
      rows.push(...page);
      if (page.length < 10) break;
    }
    return rows.filter((row) => row.data.automatic).map((row) => ({
      actor: row.data.actor, mode: row.data.mode, path: row.data.args.path,
    }));
  }, job.id);
  expect(preloads).toEqual(expect.arrayContaining([
    { actor: "a", mode: "person", path: "a.txt" },
    { actor: "a", mode: "verify", path: "a.txt" },
    { actor: "b", mode: "person", path: "b.txt" },
    { actor: "b", mode: "verify", path: "b.txt" },
  ]));

  await page
    .getByRole("button", { name: "确认导入已知内容并保存待补清单" })
    .click();
  await expect.poll(() => applied.length).toBe(1);
  expect(applied[0].review.timetables).toHaveLength(2);
});
test("automatic discovery unpacks root metadata without marking child content read", async ({ page }) => {
  let discoveryTurns = 0, automaticallyOpened = false;
  const archive = "学生部门.zip", child = archive + "!/a.txt";
  const organization = { id: "org", name: "学生部门", sources: evidence(archive) };
  await setup(page, (body) => {
    if (body.mode === "discover") {
      if (discoveryTurns++ === 0) {
        automaticallyOpened = JSON.stringify(body.messages).includes("预先解包的来源");
        return output([
        { name: "dispatch_people", args: { people: [], organizations: [organization] } },
      ]);
      }
      return output([
        { name: "read_document", args: { path: child } },
        { name: "dispatch_people", args: { people: [{ ...assignment("a"), sources: [child], organization_ids: ["org"] }], organizations: [organization] } },
        { name: "save_calendars", args: { calendars: [{ ...calendar, sources: evidence(child) }] } },
        { name: "finish_discovery", args: {} },
      ]);
    }
    const reply = personReply(body);
    if (body.mode === "person") {
      reply.calls[0].args.timetables[0].sources = evidence(child);
      return output(reply.calls);
    }
    return reply;
  });
  const zip = new JSZip().file("a.txt", "甲 学号 a 数学 周一第1节 1-2周");
  await page.getByLabel("选择导入材料").setInputFiles({
    name: archive, mimeType: "application/zip", buffer: await zip.generateAsync({ type: "nodebuffer" }),
  });
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(automaticallyOpened).toBe(true);
  const job = await saved(page);
  expect(job.session.organizations[0].sources[0].source).toBe(archive);
  expect(job.session.coordinator.coverage[archive]).toBeUndefined();
});

test("an unset semester total derives course coverage and permits reviewed submission", async ({ page }) => {
  const applied = await setup(page, (body) => {
    if (body.mode === "discover") {
      const reply = discovery();
      const call = reply.calls.find((c) => c.name === "save_calendars")!;
      call.args.calendars[0] = { ...calendar, week_count: null };
      return output(reply.calls);
    }
    return personReply(body);
  });
  await upload(page);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  const job = await saved(page);
  expect(job.draft.term[0].week_count).toBe(2);
  expect(Object.values(job.timetables).every((t: any) => t.bound)).toBe(true);
  await page.getByRole("button", { name: "确认导入已知内容并保存待补清单" }).click();
  await expect.poll(() => applied.length).toBe(1);
});

test("large batches bound concurrency and retain every person's verified result", async ({ page }) => {
  const keys = Array.from({ length: 18 }, (_, i) => i === 0 ? "a" : `person${i}`);
  let active = 0;
  let peak = 0;
  const verified = new Set<string>();
  let release!: () => void;
  const firstWave = new Promise<void>((resolve) => { release = resolve; });
  await setup(page, async (body) => {
    if (body.mode === "discover") return discovery(keys);
    if (body.mode === "person") {
      active++;
      peak = Math.max(peak, active);
      if (active === 16) release();
      await firstWave;
      await new Promise((resolve) => setTimeout(resolve, 50));
      active--;
    }
    if (body.mode === "verify") verified.add(JSON.parse(body.context).person.key);
    return personReply(body);
  });
  await upload(page, keys);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  const job = await saved(page);
  expect(peak).toBe(16);
  expect(verified.size).toBe(18);
  expect(Object.keys(job.timetables)).toHaveLength(18);
  expect(job.draft.person).toHaveLength(18);
  expect(Object.values(job.session.people).every((p: any) => p.status === "done")).toBe(true);
});
test("missing public calendar yields review with structured courses but prohibits apply", async ({
  page,
}) => {
  const applied = await setup(page, (body) =>
    body.mode === "discover"
      ? discovery(["a"], false)
      : personReply(body, false),
  );
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  const job = await saved(page);
  expect(Object.values(job.timetables)[0]).toMatchObject({
    bound: false,
    entries: [expect.objectContaining({ name: "数学" })],
  });
  expect(applied).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "确认导入已知内容并保存待补清单" }),
  ).toBeDisabled();
});
test("a child cannot read another person's material or change shared calendars", async ({
  page,
}) => {
  let attacked = false,
    rejected = false;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery();
    const c = JSON.parse(body.context);
    if (body.mode === "person" && c.person.key === "a" && !attacked) {
      attacked = true;
      return output([
        { name: "read_document", args: { path: "b.txt" } },
        { name: "save_calendars", args: { calendars: [calendar] } },
      ]);
    }
    if (body.mode === "person" && c.person.key === "a") {
      const history = JSON.stringify(body.messages);
      rejected =
        history.includes("只能读取分派") && history.includes("当前对象不允许");
    }
    return personReply(body);
  });
  await upload(page);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(rejected).toBe(true);
  expect((await saved(page)).session.people.b.information.full_name).toBe("乙");
});
test("rejects a timetable whose printed owner conflicts with the target person", async ({ page }) => {
  let rejected = false;
  const applied = await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    const reply = personReply(body);
    if (body.mode === "verify") {
      rejected ||= JSON.stringify(body.messages).includes("原件姓名与目标人员不一致");
      return output(reply.calls.map((call) => ({
        name: call.name,
        args: { checks: call.args.checks.map((check: any) => ({ ...check, source_person_names: ["乙"] })) },
      })));
    }
    return reply;
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.session?.people?.a?.status).toBe("failed");
  expect(rejected).toBe(true);
  expect((await saved(page)).session.people.a.status).toBe("failed");
  expect(applied).toHaveLength(0);
});
test("student number verification is independent and rejects a dropped digit", async ({ page }) => {
  let attempted = false, rejected = false, hidden = false;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    const reply = personReply(body);
    if (body.mode === "person") {
      reply.calls[0].args.information.student_no = "TEST001";
      return output(reply.calls);
    }
    if (body.mode === "verify") {
      hidden = !Object.hasOwn(JSON.parse(body.context).person.information, "student_no");
      const checks = reply.calls[0].args.checks;
      checks[0].source_student_numbers = ["TEST0001"];
      if (!attempted) {
        attempted = true;
        return output([{ name: "finish_person", args: { checks } }]);
      }
      rejected = JSON.stringify(body.messages).includes("原件学号与目标人员不一致");
      return output([
        { name: "write_person", args: { information: { full_name: "甲", student_no: "TEST0001" }, mode: "append" } },
        { name: "finish_person", args: { checks } },
      ]);
    }
    return reply;
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(hidden).toBe(true);
  expect(rejected).toBe(true);
  const person = Object.values((await saved(page)).session.people)[0] as any;
  expect(person.information.student_no).toBe("TEST0001");
  expect(person.timetables.fall.entries).toHaveLength(1);
});

test("verification returns field, identity and coverage problems in one response", async ({ page }) => {
  let allProblems = false;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    const reply = personReply(body);
    if (body.mode === "verify") {
      const history = JSON.stringify(body.messages);
      allProblems ||= ["复核值与已存课程不一致", "原件姓名与目标人员不一致", "不完整材料须写明待定事项", "replace_weeks"]
        .every((text) => history.includes(text));
      const checks = reply.calls[0].args.checks;
      checks[0].source_person_names = ["乙"];
      checks[0].coverage = "partial";
      checks[0].verified_entries[0].teacher = "新教师";
    }
    return reply;
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.session?.people?.a?.status).toBe("failed");
  expect(allProblems).toBe(true);
  expect((await saved(page)).session.people.a.checks).toEqual({});
});
test("local corrections preserve untouched course fields and still require verification", async ({ page }) => {
  let corrected = false;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    const reply = personReply(body);
    if (body.mode === "verify") {
      const checks = reply.calls[0].args.checks;
      checks[0].verified_entries[0].teacher = "新教师";
      if (!corrected) {
        corrected = true;
        return output([
          { name: "amend_timetable", args: { key: "fall", entries: [{ index: 0, changes: { teacher: "新教师" } }], replace_weeks: [1, 2] } },
          { name: "finish_person", args: { checks } },
        ]);
      }
    }
    return reply;
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  const table = (await saved(page)).session.people.a.timetables.fall;
  expect(table.entries[0]).toMatchObject({ name: "数学", teacher: "新教师", weekday: 1, period_from: 1, period_to: 1, weeks: [1, 2] });
  expect(table.replace_weeks).toEqual([1, 2]);
});
test("verification reuses independent observations after an amendment, without resending the table", async ({ page }) => {
  let attempt = 0;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    const reply = personReply(body);
    if (body.mode === "verify") {
      const checks = reply.calls[0].args.checks;
      checks[0].verified_entries[0].teacher = "原件教师";
      if (attempt++ === 0) return reply; // Deliberate disagreement with extraction.
      checks[0].reuse_verified_entries = true;
      checks[0].verified_entries = [];
      return output([
        { name: "amend_timetable", args: { key: "fall", entries: [{ index: 0, changes: { teacher: "原件教师" } }] } },
        { name: "finish_person", args: { checks } },
      ]);
    }
    return reply;
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  const person = (await saved(page)).session.people.a;
  expect(attempt).toBe(2);
  expect(person.checks.fall.verified_entries).toHaveLength(1);
  expect(person.checks.fall.verified_entries[0].teacher).toBe("原件教师");
});

test("cached verification never accepts a later amendment that disagrees with the source observation", async ({ page }) => {
  let attempt = 0;
  let rejected = false;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    const reply = personReply(body);
    if (body.mode === "verify") {
      rejected ||= JSON.stringify(body.messages).includes("复核值与已存课程不一致");
      const checks = reply.calls[0].args.checks;
      checks[0].verified_entries[0].teacher = "原件教师";
      if (attempt++ === 0) return reply;
      checks[0].reuse_verified_entries = true;
      checks[0].verified_entries = [];
      return output([
        { name: "amend_timetable", args: { key: "fall", entries: [{ index: 0, changes: { teacher: "错误教师" } }] } },
        { name: "finish_person", args: { checks } },
      ]);
    }
    return reply;
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.session?.people?.a?.status).toBe("failed");
  expect(rejected).toBe(true);
  expect((await saved(page)).session.people.a.checks).toEqual({});
});

test("verification reuse requires observations from the current verification run", async ({ page }) => {
  let rejected = false;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    const reply = personReply(body);
    if (body.mode === "verify") {
      rejected ||= JSON.stringify(body.messages).includes("没有可复用的独立复核事实");
      reply.calls[0].args.checks[0].reuse_verified_entries = true;
      reply.calls[0].args.checks[0].verified_entries = [];
    }
    return reply;
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.session?.people?.a?.status).toBe("failed");
  expect(rejected).toBe(true);
  expect((await saved(page)).session.people.a.checks).toEqual({});
});

test("rewriting a timetable invalidates its cached source verification", async ({ page }) => {
  let first = true;
  let rejected = false;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    const reply = personReply(body);
    if (body.mode === "verify") {
      rejected ||= JSON.stringify(body.messages).includes("没有可复用的独立复核事实");
      const checks = reply.calls[0].args.checks;
      if (first) {
        first = false;
        checks[0].verified_entries[0].teacher = "复核教师";
        return reply;
      }
      checks[0].reuse_verified_entries = true;
      checks[0].verified_entries = [];
      return output([
        personReply({ ...body, mode: "person" }).calls[0],
        { name: "finish_person", args: { checks } },
      ]);
    }
    return reply;
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.session?.people?.a?.status).toBe("failed");
  expect(rejected).toBe(true);
  expect((await saved(page)).session.people.a.checks).toEqual({});
});

test("an invalid correction leaves every existing entry unchanged", async ({ page }) => {
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    const reply = personReply(body);
    if (body.mode === "verify") return output([
      { name: "amend_timetable", args: { key: "fall", entries: [
        { index: 0, changes: { teacher: "不得泄漏的修改" } },
        { index: 99, changes: { teacher: "无效索引" } },
      ] } },
      { name: "finish_person", args: reply.calls[0].args },
    ]);
    return reply;
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  const person = (await saved(page)).session.people.a;
  expect(person.timetables.fall.entries[0].teacher).toBeUndefined();
  expect(JSON.stringify(person.agent.messages)).toContain("修正课程索引不存在");
});
test("invalid field coverage cannot finish verification and model can repair it", async ({
  page,
}) => {
  let attempt = 0,
    errorSeen = false;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    if (body.mode === "verify") {
      if (!attempt++)
        return output([
          {
            name: "finish_person",
            args: { checks: [{ key: "fall", ...fields, verified_entries: [], checked_entries: [] }] },
          },
        ]);
      errorSeen = JSON.stringify(body.messages).includes(
        "核对索引必须覆盖全部课程",
      );
    }
    return personReply(body);
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(errorSeen).toBe(true);
});
test("failure is isolated, successful people remain saved and resume does not rerun them", async ({
  page,
}) => {
  let failing = true,
    aCalls = 0;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery();
    const c = JSON.parse(body.context);
    if (body.mode === "person" && c.person.key === "a") aCalls++;
    if (body.mode === "person" && c.person.key === "b" && failing)
      return output(
        Array.from({ length: 6 }, () => ({
          name: "read_document",
          args: { path: "a.txt" },
        })),
      );
    return personReply(body);
  });
  await upload(page);
  await expect.poll(async () => (await saved(page))?.status).toBe("paused");
  await expect
    .poll(async () => (await saved(page))?.session?.people.b?.status)
    .toBe("failed");
  await expect
    .poll(async () => (await saved(page))?.session?.people.a?.status)
    .toBe("done");
  failing = false;
  await page.reload();
  await page.getByText(/本机最近导入/).click();
  await page.getByRole("button", { name: /a.txt/ }).click();
  await page.getByRole("button", { name: "继续处理", exact: true }).click();
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(aCalls).toBe(1);
});
test("pause preserves pending model calls and resume executes them without a second extraction", async ({
  page,
}) => {
  let entered = false,
    release!: () => void,
    count = 0;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await setup(page, async (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    if (body.mode === "person") {
      count++;
      entered = true;
      await gate;
    }
    return personReply(body);
  });
  await upload(page, ["a"]);
  await expect.poll(() => entered).toBe(true);
  await page.getByRole("button", { name: "完成当前步骤后暂停" }).click();
  release();
  await expect.poll(async () => (await saved(page))?.status).toBe("paused");
  expect((await saved(page)).session.people.a.agent.pending).toHaveLength(2);
  await page.reload();
  await page.getByText(/本机最近导入/).click();
  await page.getByRole("button", { name: /a.txt/ }).click();
  await page.getByRole("button", { name: "继续处理", exact: true }).click();
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(count).toBe(1);
});
test("legacy checkpoints remain available but cannot run the removed protocol", async ({
  page,
}) => {
  let calls = 0;
  await setup(page, () => {
    calls++;
    return output([]);
  });
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const s = await import("/src/client/agent-import/store.ts");
    const job = await r.createJob("owner", []);
    delete job.session;
    await s.saveJob(job);
    await new r.ImportRunner(job, () => {}).run();
    return { error: job.error, retained: (await s.listJobs("owner")).length };
  });
  expect(result.error).toContain("旧版批次");
  expect(result.retained).toBe(1);
  expect(calls).toBe(0);
});

test("verification failures resume verification and clear the old error", async ({
  page,
}) => {
  let failing = true,
    extractions = 0;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    if (body.mode === "person") extractions++;
    if (body.mode === "verify" && failing)
      return output(
        Array.from({ length: 6 }, () => ({
          name: "finish_person",
          args: { checks: [] },
        })),
      );
    return personReply(body);
  });
  await upload(page, ["a"]);
  await expect
    .poll(async () => (await saved(page))?.session?.people.a?.status)
    .toBe("failed");
  expect((await saved(page)).session.people.a.resumeStatus).toBe("verifying");
  failing = false;
  await page.getByRole("button", { name: "继续处理", exact: true }).click();
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(extractions).toBe(1);
  expect((await saved(page)).session.people.a.agent.error).toBeUndefined();
});
test("manual changes invalidate global review and stale tabs cannot overwrite progress", async ({
  page,
}) => {
  await setup(page, (body) =>
    body.mode === "discover" ? discovery(["a"]) : personReply(body),
  );
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const s = await import("/src/client/agent-import/store.ts");
    const job = (await s.listJobs("owner"))[0],
      stale = structuredClone(job);
    const plan = Object.values(job.timetables)[0];
    await r.editProposalEntry(job, plan.id, 0, {
      ...plan.entries[0],
      teacher: "修订教师",
    });
    let staleError = "",
      lockedError = "";
    try {
      await r.setPersonIncluded(stale, plan.person.id, false);
    } catch (e) {
      staleError = e.message;
    }
    await navigator.locks.request("rota-import:" + job.id, async () => {
      try {
        await r.feedback(job, "不能覆盖运行中的批次");
      } catch (e) {
        lockedError = e.message;
      }
    });
    return {
      checked: job.importCheck,
      staleError,
      lockedError,
      stored: (await s.listJobs("owner"))[0].timetables[plan.id].entries[0]
        .teacher,
    };
  });
  expect(result.checked).toBeUndefined();
  expect(result.staleError).toContain("批次已发生变化");
  expect(result.lockedError).toContain("正在其他标签页运行");
  expect(result.stored).toBe("修订教师");
});

test("coordinator cannot omit cross-person teacher disagreements", async ({
  page,
}) => {
  let reviewTurns = 0,
    sawError = false;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery();
    if (body.mode === "reconcile") {
      const context = JSON.parse(body.context);
      if (!reviewTurns++) return output([{ name: "finish_import", args: {} }]);
      sawError = JSON.stringify(body.messages).includes(
        "跨课表教师差异尚未逐项核对",
      );
      return output([
        {
          name: "finish_import",
          args: {
            consistency_review: context.conflicts.map((g: any) => ({
              key: g.key,
              resolution: "unresolved",
              explanation: "任课教师不同，留待操作员确认",
              checked_variants: g.variants.map((v: any) => ({
                timetable_id: v.timetable_id,
                teacher: v.teacher,
              })),
            })),
          },
        },
      ]);
    }
    const reply = personReply(body);
    if (body.mode === "person") {
      reply.calls[0].args.timetables[0].entries[0].teacher =
        JSON.parse(body.context).person.key === "a" ? "张老师" : "李老师";
    }
    if (body.mode === "verify") {
      reply.calls[0].args.checks[0].verified_entries[0].teacher =
        JSON.parse(body.context).person.key === "a" ? "张老师" : "李老师";
    }
    return reply;
  });
  await upload(page);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(sawError).toBe(true);
  expect((await saved(page)).unresolved.join(" ")).toContain("任课教师不同");
});
test("image tool messages follow every tool result in a multi-call turn", async ({
  page,
}) => {
  let discoveryTurns = 0,
    roles: string[] = [];
  await setup(page, (body) => {
    if (body.mode !== "discover") return personReply(body);
    if (!discoveryTurns++)
      return output([
        { name: "view_image", args: { path: "note.png" } },
        { name: "read_document", args: { path: "a.txt" } },
      ]);
    const assistant = body.messages.findIndex(
      (m: any) => m.role === "assistant",
    );
    roles = body.messages.slice(assistant).map((m: any) => m.role);
    return output([
      { name: "dispatch_people", args: { people: [assignment("a")] } },
      { name: "save_calendars", args: { calendars: [calendar] } },
      {
        name: "mark_material",
        args: {
          path: "note.png",
          status: "irrelevant",
          reason: "合成空白图像",
        },
      },
      { name: "finish_discovery", args: {} },
    ]);
  });
  const data = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 20;
    c.height = 20;
    return c.toDataURL().split(",")[1];
  });
  await page.getByLabel("选择导入材料").setInputFiles([
    {
      name: "a.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("甲 学号 a 数学 周一 第1节 第1-2周"),
    },
    {
      name: "note.png",
      mimeType: "image/png",
      buffer: Buffer.from(data, "base64"),
    },
  ]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(roles).toEqual(["assistant", "tool", "tool", "user"]);
});

test("verification rejects source weeks that disagree with the saved entry", async ({ page }) => {
  let attempted = false, rejected = false;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    if (body.mode === "verify" && !attempted) {
      attempted = true;
      return output([{ name: "finish_person", args: { checks: [{ key: "fall", ...fields,
        verified_entries: [{ index: 0, name: "数学", weekday: 1, period_from: 1, period_to: 1, weeks: [1] }],
      }] } }]);
    }
    if (body.mode === "verify") rejected = JSON.stringify(body.messages).includes("复核值与已存课程不一致");
    return personReply(body);
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(rejected).toBe(true);
});

test("coordinator retains source evidence across person revision waves", async ({ page }) => {
  let revised = false, retained = false;
  const revisionModes: string[] = [];
  let independentlyRechecked = false;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    if (body.mode === "reconcile" && !revised) {
      revised = true;
      return output([
        { name: "read_document", args: { path: "a.txt" } },
        { name: "revise_person", args: { key: "a", instruction: "再次核对数学周次" } },
      ]);
    }
    if (revised && ["person", "verify"].includes(body.mode)) {
      revisionModes.push(body.mode);
      const context = JSON.parse(body.context);
      independentlyRechecked = context.person.timetables.fall.entries[0].weekday === undefined
        && body.messages.some((m: any) => typeof m.content === "string"
          && m.content.startsWith("预先读取的来源") && m.content.includes("a.txt"));
    }
    if (body.mode === "reconcile") retained = JSON.stringify(body.messages).includes("再次核对数学周次");
    return personReply(body);
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(retained).toBe(true);
  expect(revisionModes).toEqual(["verify"]);
  expect(independentlyRechecked).toBe(true);
});

test("source verification cannot copy the extraction's time and teacher fields", async ({ page }) => {
  let verificationContext: any;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    if (body.mode === "verify") verificationContext = JSON.parse(body.context);
    return personReply(body);
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  const entry = verificationContext.person.timetables.fall.entries[0];
  expect(entry).toEqual({ index: 0, name: "数学" });
});

test("coordinator can checkpoint a teacher review before final delivery", async ({ page }) => {
  let checkpointed = false;
  let preloaded = false;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery();
    if (body.mode === "reconcile") {
      const c = JSON.parse(body.context);
      preloaded ||= body.messages.some((m: any) => m.role === "user" && typeof m.content === "string"
        && m.content.startsWith("预先读取的来源") && m.content.includes("b.txt"));
      if (!checkpointed) {
        checkpointed = true;
        return output([{ name: "revise_person", args: { key: "a", instruction: "复查姓名，不改变已核对课程事实" } }, { name: "review_consistency", args: { reviews: c.conflicts.map((g: any) => ({
          key: g.key, resolution: "different_context", explanation: "原件已核对，两人分别由不同教师任教",
          checked_variant_indices: g.variants.map((v: any) => v.index),
        })) } }]);
      }
      return output([{ name: "finish_import", args: {} }]);
    }
    const reply = personReply(body);
    const teacher = JSON.parse(body.context).person.key === "a" ? "甲老师" : "乙老师";
    if (body.mode === "person") reply.calls[0].args.timetables[0].entries[0].teacher = teacher;
    if (body.mode === "verify") reply.calls[0].args.checks[0].verified_entries[0].teacher = teacher;
    return reply;
  });
  await upload(page);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect((await saved(page)).importCheck.consistency_review).toHaveLength(1);
  const review = (await saved(page)).importCheck.consistency_review[0];
  expect(review.checked_variant_indices).toBeUndefined();
  expect(review.checked_variants.map((v: any) => v.teacher).sort()).toEqual(["乙老师", "甲老师"].sort());
  expect(JSON.stringify((await saved(page)).session.coordinator.messages)).not.toContain("人员对象尚未完成");
  expect(preloaded).toBe(true);
});

test("operator feedback retains completed coordinator evidence", async ({ page }) => {
  await setup(page, (body) => body.mode === "discover" ? discovery(["a"]) : personReply(body));
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const s = await import("/src/client/agent-import/store.ts");
    const job = (await s.listJobs("owner"))[0];
    const before = job.session.coordinator.runId;
    await r.feedback(job, "请独立回看原件，不预设答案");
    const retained = { before, after: job.session.coordinator.runId, coverage: job.session.coordinator.coverage };
    job.session.coordinator.pending = [{ id: "stale", name: "finish_import", args: {} }];
    await s.saveJob(job);
    await r.feedback(job, "取消旧指令，重新核对");
    return { ...retained, pending: job.session.coordinator.pending, reset: job.session.coordinator.runId !== before };
  });
  expect(result.after).toBe(result.before);
  expect(Object.keys(result.coverage)).toContain("a.txt");
  expect(result.pending).toEqual([]);
  expect(result.reset).toBe(true);
});


test("verified missing timetable permits personnel-only submission without inventing a calendar", async ({ page }) => {
  const applied = await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"], false);
    const reply = personReply(body, false);
    if (body.mode === "person") {
      const table = reply.calls[0].args.timetables[0];
      table.entries = [];
      table.unresolved = ["原件属于他人，缺少本人课表"];
    }
    if (body.mode === "verify") {
      const check = reply.calls[0].args.checks[0];
      check.checked_entries = [];
      check.verified_entries = [];
      check.coverage = "missing";
    }
    return reply;
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  const job = await saved(page);
  expect(job.draft.person).toHaveLength(1);
  expect(job.draft.term).toHaveLength(0);
  expect(job.draft.timetable_entry).toHaveLength(0);
  const validation = await page.evaluate(async (id) => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const s = await import("/src/client/agent-import/store.ts");
    return r.checkJob((await s.loadJob(id))!);
  }, job.id);
  expect(validation.issues).toEqual([]);
  await page.getByRole("button", { name: "确认导入已知内容并保存待补清单" }).click();
  await expect.poll(() => applied.length).toBe(1);
  expect(Object.values(applied[0].review.checks).map((check: any) => check.coverage)).toEqual(["missing"]);
});


test("verified partial times persist in review while only known sessions are submitted", async ({ page }) => {
  const unknown = { name: "待补课程", weekday: 2, period_from: 3, period_to: 4, weeks: null, no_fixed_time: false };
  const applied = await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    const reply = personReply(body);
    if (body.mode === "person") {
      const table = reply.calls[0].args.timetables[0];
      table.entries.push(unknown);
      table.replace_weeks = [1, 2];
      table.unresolved = ["待补课程的周次被遮挡"];
    }
    if (body.mode === "verify") {
      const check = reply.calls[0].args.checks[0];
      check.checked_entries = [0, 1];
      check.verified_entries[1] = { ...unknown, index: 1 };
      check.coverage = "partial";
    }
    return reply;
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  const job = await saved(page);
  expect(job.draft.timetable_entry).toHaveLength(1);
  expect(job.summary).toContain("1 项时段待补");
  expect(job.unresolved.join(" ")).toContain("不能据此判定有空");
  await page.getByRole("button", { name: "确认导入已知内容并保存待补清单" }).click();
  await expect.poll(() => applied.length).toBe(1);
  expect(applied[0].review.timetables[0].entries[1]).toMatchObject(unknown);
  expect(applied[0].review.unresolved.join(" ")).toContain("待补课程");
});


test("failed automatic unpack cannot establish organization evidence", async ({ page }) => {
  let rejected = false;
  await setup(page, (body) => {
    rejected ||= JSON.stringify(body.messages).includes("证据来源尚未读取");
    return output([{ name: "dispatch_people", args: { people: [], organizations: [
      { id: "org", name: "部门", sources: evidence("broken.zip") },
    ] } }]);
  });
  await page.getByLabel("选择导入材料").setInputFiles({
    name: "broken.zip", mimeType: "application/zip", buffer: Buffer.from("not an archive"),
  });
  await expect.poll(async () => (await saved(page))?.error).toContain("连续工具错误");
  const job = await saved(page);
  expect(rejected).toBe(true);
  expect(job.session.coordinator.openedArchives ?? []).toEqual([]);
  expect(job.session.organizations).toEqual([]);
});


test("parallel consistency readers load only their assigned source images", async ({ page }) => {
  let batches = 0, firstScoped = false, reloaded = false;
  const courses = (key: string) => (key === "c" ? [5] : key === "b" ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5]);
  await setup(page, (body) => {
    if (body.mode === "discover") return output([
      { name: "dispatch_people", args: { people: ["a", "b", "c"].map((key) => ({ ...assignment(key), sources: [key + ".png"] })) } },
      { name: "save_calendars", args: { calendars: [{ ...calendar, sources: evidence("a.png") }] } },
      { name: "finish_discovery", args: {} },
    ]);
    const context = JSON.parse(body.context);
    if (body.mode === "reconcile") return output([{ name: "finish_import", args: {} }]);
    if (body.mode === "consistency") {
      const images = body.messages.filter((m: any) => m.role === "user" && Array.isArray(m.content) && m.content.some((p: any) => p.type === "image"));
      const hasC = images.some((m: any) => JSON.stringify(m.content.filter((p: any) => p.type === "text")).includes("c.png"));
      if (context.conflicts.some((g: any) => g.course === "课程0")) firstScoped = !hasC;
      if (context.conflicts.some((g: any) => g.course === "课程5")) reloaded = hasC;
      if (!context.conflicts.length) return output([{ name: "finish_import", args: {} }]);
      batches++;
      return output([{ name: "review_consistency", args: { reviews: context.conflicts.map((g: any) => ({
        key: g.key, resolution: "different_context", explanation: "合成教师差异已回看",
        checked_variant_indices: g.variants.map((v: any) => v.index),
      })) } }]);
    }
    const reply = personReply(body);
    const key = context.person.key;
    if (body.mode === "person") {
      reply.calls[0].args.information.full_name = key;
      const table = reply.calls[0].args.timetables[0];
      table.sources = evidence(key + ".png");
      table.entries = courses(key).map((n) => ({ name: "课程" + n, teacher: key + "老师", weekday: 1, period_from: 1, period_to: 1, weeks: [1, 2] }));
    }
    if (body.mode === "verify") {
      const check = reply.calls[0].args.checks[0];
      check.checked_entries = courses(key).map((_, i) => i);
      for (const entry of check.verified_entries) entry.teacher = key + "老师";
    }
    return reply;
  });
  const { readFile } = await import("node:fs/promises");
  const buffer = await readFile("test/fixtures/import/schedule.png");
  await page.getByLabel("选择导入材料").setInputFiles(["a", "b", "c"].map((key) => ({ name: key + ".png", mimeType: "image/png", buffer })));
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(batches).toBe(2);
  expect(firstScoped).toBe(true);
  expect(reloaded).toBe(true);
  expect((await saved(page)).importCheck.consistency_review).toHaveLength(6);
});


for (const scenario of ["recover", "timeout", "quota_exhausted"]) {
  test(`bounded queue recovery handles ${scenario} without repeating successful people`, async ({ page }) => {
    let aCalls = 0, bRequests = 0;
    let releaseA = () => {};
    const aWaiting = new Promise<void>((resolve) => { releaseA = resolve; });
    let freshRecovery = false;
    await setup(page, async (body) => {
      if (body.mode === "discover") return discovery();
      if (body.mode === "person" && JSON.parse(body.context).person.key === "a") aCalls++;
      if (scenario === "recover" && body.mode === "verify" && JSON.parse(body.context).person.key === "a") await aWaiting;
      return personReply(body);
    });
    await page.route("**/api/agent-imports/*/turn", async (route) => {
      const body = route.request().postDataJSON();
      if (body.mode === "person" && JSON.parse(body.context).person.key === "b") {
        bRequests++;
        if (bRequests === 3) {
          freshRecovery = !JSON.stringify(body.messages).includes("上一请求未返回有效结果");
          releaseA();
        }
        if (scenario !== "recover" || bRequests <= 2) {
          const code = scenario === "quota_exhausted" ? scenario : "timeout";
          return route.fulfill({ status: 502, json: { error: { code: "llm_error", message: code },
            metrics: { requestId: "test", durationMs: 1, purpose: "person", attempts: [{ code, durationMs: 1, status: "error" }] },
          } });
        }
      }
      await route.fallback();
    });
    await upload(page);
    await expect.poll(async () => {
      const job = await saved(page);
      return scenario === "recover" ? job?.status : job?.error && job.status;
    }, { timeout: 15000 }).toBe(scenario === "recover" ? "review" : "paused");
    expect(aCalls).toBe(1);
    if (scenario === "recover") expect(freshRecovery).toBe(true);
    expect(bRequests).toBe(scenario === "recover" ? 3 : scenario === "timeout" ? 4 : 1);
    expect((await saved(page)).session.people.a.status).toBe("done");
  });
}


test("scoped revision retains independent unchanged observations but requires target reread", async ({ page }) => {
  let revised = false, attemptedMissing = false, rejectedMissing = false;
  let reusable: number[] = [], hidden = false;
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery(["a"]);
    if (body.mode === "person") {
      const r = personReply(body);
      r.calls[0].args.timetables[0].entries.push({ name: "物理", weekday: 2, period_from: 1, period_to: 1, weeks: [1, 2] });
      return r;
    }
    if (body.mode === "reconcile" && !revised) {
      revised = true;
      return output([{ name: "revise_person", args: { key: "a", instruction: "重查数学教师", recheck_entries: [{ key: "fall", indices: [0] }] } }]);
    }
    if (body.mode === "verify") {
      const c = JSON.parse(body.context), table = c.person.timetables.fall;
      const entries = table.entries.map((e: any, index: number) => ({ index, name: e.name, weekday: index + 1, period_from: 1, period_to: 1, weeks: [1, 2] }));
      if (!revised) return output([{ name: "finish_person", args: { checks: [{ key: "fall", ...fields, checked_entries: [0, 1], verified_entries: entries }] } }]);
      reusable = table.reusable_verified_indices ?? [];
      hidden = table.entries.every((e: any) => e.weekday === undefined && e.teacher === undefined);
      if (!attemptedMissing) {
        attemptedMissing = true;
        return output([{ name: "finish_person", args: { checks: [{ key: "fall", ...fields, checked_entries: [0, 1], reuse_verified_entries: true, verified_entries: [] }] } }]);
      }
      rejectedMissing = JSON.stringify(body.messages).includes("复核值必须逐条覆盖课程");
      return output([
        { name: "amend_timetable", args: { key: "fall", entries: [{ index: 0, changes: { teacher: "新教师" } }] } },
        { name: "finish_person", args: { checks: [{ key: "fall", ...fields, checked_entries: [0, 1], reuse_verified_entries: true, verified_entries: [{ ...entries[0], teacher: "新教师" }] }] } },
      ]);
    }
    return personReply(body);
  });
  await upload(page, ["a"]);
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(reusable).toEqual([1]);
  expect(hidden).toBe(true);
  expect(rejectedMissing).toBe(true);
  expect((await saved(page)).draft.timetable_entry).toHaveLength(2);
  expect((await saved(page)).draft.timetable_entry.find((e: any) => e.name === "数学").teacher).toBe("新教师");
});


test("independent consistency batches overlap and defer person revisions until readers drain", async ({ page }) => {
  let active = 0, maxActive = 0, revised = false, readersDrained = false, revisionAfterDrain = false;
  let startedReaders = 0, releaseReaders!: () => void;
  const readersStarted = new Promise<void>((resolve) => { releaseReaders = resolve; });
  const entries = (key: string) => Array.from({ length: 6 }, (_, index) => ({
    name: "课程" + index, weekday: index + 1, period_from: 1, period_to: 1, weeks: [1, 2], teacher: key + "教师",
  }));
  await setup(page, async (body) => {
    if (body.mode === "discover") return discovery();
    const c = JSON.parse(body.context);
    if (body.mode === "person") {
      const reply = personReply(body); reply.calls[0].args.timetables[0].entries = entries(c.person.key); return reply;
    }
    if (body.mode === "verify") {
      if (revised && c.person.key === "a") revisionAfterDrain = readersDrained;
      return output([{ name: "finish_person", args: { checks: [{ key: "fall", ...fields, checked_entries: [0, 1, 2, 3, 4, 5], verified_entries: entries(c.person.key).map((entry, index) => ({ ...entry, index })) }] } }]);
    }
    if (body.mode === "consistency") {
      active++; maxActive = Math.max(maxActive, active);
      if (++startedReaders === 2) releaseReaders();
      await readersStarted;
      const last = c.conflicts.some((g: any) => g.course === "课程5");
      await new Promise((resolve) => setTimeout(resolve, last ? 250 : 80));
      active--;
      if (last) readersDrained = true;
      if (!last && !revised) {
        revised = true;
        return output([{ name: "revise_person", args: { key: "a", instruction: "局部复核课程0", recheck_entries: [{ key: "fall", indices: [0] }] } }]);
      }
      return output([{ name: "review_consistency", args: { reviews: c.conflicts.map((g: any) => ({ key: g.key, resolution: "different_context", explanation: "原件明确不同教师", checked_variant_indices: g.variants.map((v: any) => v.index) })) } }]);
    }
    return output([{ name: "finish_import", args: {} }]);
  });
  await upload(page);
  await expect.poll(async () => (await saved(page))?.status, { timeout: 10000 }).toBe("review");
  expect(maxActive).toBe(2);
  expect(revisionAfterDrain).toBe(true);
  expect((await saved(page)).importCheck.consistency_review).toHaveLength(6);
});


test("failed parallel reader preserves peer checkpoints and resumes without replaying them", async ({ page }) => {
  let fail = true, successfulBatchCalls = 0, rejectedForbiddenTool = false;
  const entries = (key: string) => Array.from({ length: 6 }, (_, index) => ({ name: "核对课" + index,
    weekday: index + 1, period_from: 1, period_to: 1, weeks: [1, 2], teacher: key + "教师" }));
  await setup(page, (body) => {
    if (body.mode === "discover") return discovery();
    const c = JSON.parse(body.context);
    if (body.mode === "person") {
      const reply = personReply(body); reply.calls[0].args.timetables[0].entries = entries(c.person.key); return reply;
    }
    if (body.mode === "verify") return output([{ name: "finish_person", args: { checks: [{ key: "fall", ...fields,
      checked_entries: [0, 1, 2, 3, 4, 5], verified_entries: entries(c.person.key).map((entry, index) => ({ ...entry, index })),
    }] } }]);
    if (body.mode === "consistency") {
      const small = c.conflicts.some((g: any) => g.course === "核对课5");
      if (small) rejectedForbiddenTool ||= JSON.stringify(body.messages).includes("当前对象不允许此工具");
      if (small && fail) return output([{ name: "finish_import", args: {} }]);
      if (!small) successfulBatchCalls++;
      return output([{ name: "review_consistency", args: { reviews: c.conflicts.map((g: any) => ({ key: g.key,
        resolution: "different_context", explanation: "已读取原件", checked_variant_indices: g.variants.map((v: any) => v.index),
      })) } }]);
    }
    return output([{ name: "finish_import", args: {} }]);
  });
  await upload(page);
  await expect.poll(async () => (await saved(page))?.error).toContain("部分跨人核对失败");
  await expect.poll(async () => (await saved(page))?.status).toBe("paused");
  expect(Object.keys((await saved(page)).session.consistencyCheckpoints)).toHaveLength(5);
  expect((await saved(page)).session.consistencyWorkers.filter((worker: any) => worker.done)).toHaveLength(1);
  expect(rejectedForbiddenTool).toBe(true);
  fail = false;
  await page.getByRole("button", { name: "继续处理", exact: true }).click();
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(successfulBatchCalls).toBe(1);
  expect((await saved(page)).importCheck.consistency_review).toHaveLength(6);
});


test("paused parallel readers persist pending calls and resume them after reload", async ({ page }) => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entries = (key: string) => Array.from({ length: 6 }, (_, index) => ({ name: "暂停课" + index,
    weekday: index + 1, period_from: 1, period_to: 1, weeks: [1, 2], teacher: key + "教师" }));
  await setup(page, async (body) => {
    if (body.mode === "discover") return discovery();
    const c = JSON.parse(body.context);
    if (body.mode === "person") {
      const reply = personReply(body); reply.calls[0].args.timetables[0].entries = entries(c.person.key); return reply;
    }
    if (body.mode === "verify") return output([{ name: "finish_person", args: { checks: [{ key: "fall", ...fields,
      checked_entries: [0, 1, 2, 3, 4, 5], verified_entries: entries(c.person.key).map((entry, index) => ({ ...entry, index })),
    }] } }]);
    if (body.mode === "consistency") {
      calls++;
      await gate;
      return output([{ name: "review_consistency", args: { reviews: c.conflicts.map((g: any) => ({ key: g.key,
        resolution: "different_context", explanation: "已读取原件", checked_variant_indices: g.variants.map((v: any) => v.index),
      })) } }]);
    }
    return output([{ name: "finish_import", args: {} }]);
  });
  await upload(page);
  await expect.poll(() => calls).toBe(2);
  await page.getByRole("button", { name: "完成当前步骤后暂停" }).click();
  release();
  await expect.poll(async () => (await saved(page))?.status).toBe("paused");
  expect((await saved(page)).session.consistencyWorkers.map((worker: any) => worker.agent.pending.length)).toEqual([1, 1]);
  await page.reload();
  await page.getByText(/本机最近导入/).click();
  await page.getByRole("button", { name: /a.txt/ }).click();
  await page.getByRole("button", { name: "继续处理", exact: true }).click();
  await expect.poll(async () => (await saved(page))?.status).toBe("review");
  expect(calls).toBe(2);
  expect((await saved(page)).importCheck.consistency_review).toHaveLength(6);
});
