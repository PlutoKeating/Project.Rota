import { test, expect, type Page } from "@playwright/test";
import { emptySnapshot } from "../../src/shared/agent-import/model";
const evidence = (path: string) => [
  {
    source: path,
    locator: "全文",
    explanation: "合成测试材料",
    inferred: false,
  },
];
const fields = {
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
      { name: "finish_person", args: { checks: { fall: fields } } },
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
  await page
    .getByRole("button", { name: "审核无误，导入全部选中内容" })
    .click();
  await expect.poll(() => applied.length).toBe(1);
  expect(applied[0].review.timetables).toHaveLength(2);
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
    page.getByRole("button", { name: "审核无误，导入全部选中内容" }),
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
            args: { checks: { fall: { ...fields, checked_entries: [] } } },
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
          args: { checks: {} },
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
