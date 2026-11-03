import { test, expect } from "@playwright/test";
import JSZip from "jszip";
import { emptySnapshot, mutate } from "../../src/shared/agent-import/model";
const origin = "http://127.0.0.1:5178";
const base = emptySnapshot();
function calls() {
  const evidence = [
    {
      source: "说明.txt",
      locator: "全文",
      explanation: "文件内容明确记录",
      inferred: false,
    },
  ];
  const change = (entity: string, id: string, data: unknown) => ({
    name: "change_record",
    args: { entity, action: "create", id, data, evidence },
  });
  return [
    { name: "tree", args: {} },
    { name: "read_document", args: { path: "说明.txt" } },
    {
      name: "observe_material",
      args: {
        path: "说明.txt",
        content: "张同学，会计2601，新媒体部门，高等数学每周一第1节，共2周。",
        unresolved: [],
      },
    },
    {
      name: "mark_file",
      args: {
        path: "说明.txt",
        status: "done",
        reason: "已读取并记录名单及课表",
      },
    },
    change("organization", "org", { name: "新媒体" }),
    change("person", "p", { full_name: "张同学", class_name: "会计2601" }),
    change("membership", "m", { person_id: "p", org_id: "org" }),
    change("term", "term", {
      name: "2026 秋",
      start_date: "2026-09-07",
      week_count: 2,
    }),
    change("class_period", "period", {
      term_id: "term",
      period_index: 1,
      start_time: "08:00",
      end_time: "08:45",
    }),
    change("timetable_profile", "profile", {
      term_id: "term",
      name: "校内作息",
      periods: '[{"index":1,"start":"08:00","end":"08:45"}]',
    }),
    change("timetable_entry", "entry", {
      person_id: "p",
      term_id: "term",
      profile_id: "profile",
      name: "高等数学",
      weekday: 1,
      period_from: 1,
      period_to: 1,
      weeks: "[1,2]",
    }),
    { name: "validate_draft", args: {} },
    {
      name: "finish_review",
      args: {
        summary: "已整理新媒体人员和课表，请核对后导入。",
        unresolved: [],
      },
    },
  ].map((c, i) => ({ ...c, id: "tool-" + i }));
}
test("browser Agent reads files, stages relational preview and applies only after review", async ({
  page,
}) => {
  let applies = 0,
    turns = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = { items: [] };
    if (path === "/api/auth/me")
      data = {
        authenticated: true,
        user: { id: "owner", name: "测试管理员", role: "owner" },
      };
    else if (path === "/api/agent-imports/snapshot")
      data = { data: base, version: 0 };
    else if (path === "/api/agent-imports") data = { id: "batch-browser" };
    else if (path.endsWith("/turn")) {
      turns++;
      const list = calls();
      data = {
        messages: [
          {
            role: "assistant",
            content: list.map((c) => ({
              type: "tool-call",
              toolCallId: c.id,
              toolName: c.name,
              input: c.args,
            })),
          },
        ],
        calls: list,
        text: "正在核对材料",
        model: "测试模型",
      };
    } else if (path.endsWith("/apply")) {
      applies++;
      data = { ok: true };
    } else if (path.endsWith("/lease"))
      data = { expiresAt: Date.now() + 180000 };
    await route.fulfill({ json: data });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + "/#/imports");
  await expect(
    page.getByRole("heading", { name: "拖入一个压缩包，或选择文件" }),
  ).toBeVisible();
  await page.screenshot({
    path: ".impeccable/review/import-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".impeccable/review/import-mobile.png",
    fullPage: true,
  });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.locator("input[type=file]").setInputFiles({
    name: "说明.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "新媒体 张同学 会计2601；2026 秋，首周2026-09-07，2周。周一08:00–08:45高等数学。",
    ),
  });
  await expect(
    page.getByRole("button", { name: "审核无误，导入全部选中内容" }),
  ).toBeVisible({ timeout: 30000 });
  expect(applies).toBe(0);
  expect(turns).toBe(1);
  await page.getByText("张同学", { exact: false }).first().click();
  await expect(
    page.getByText("高等数学", { exact: true }).first(),
  ).toBeVisible();
  const include = page.getByRole("checkbox", { name: "包含此人的变更" });
  await include.uncheck();
  await expect(include).toBeVisible();
  await expect(include).not.toBeChecked();
  await include.check();
  await expect(include).toBeChecked();
  await page.screenshot({
    path: ".impeccable/review/import-review-mobile.png",
    fullPage: true,
  });
  await page.reload();
  await page.getByText("本机最近导入", { exact: false }).click();
  await page.getByRole("button", { name: /说明.txt/ }).click();
  await expect(
    page.getByRole("button", { name: "审核无误，导入全部选中内容" }),
  ).toBeVisible();
  expect(turns).toBe(1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".impeccable/review/import-review-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "审核无误，导入全部选中内容" })
    .click();
  await expect(
    page.getByText("已导入，材料将在完成后 8 小时清理"),
  ).toBeVisible();
  expect(applies).toBe(1);
});
test("real browser worker unpacks nested archives and reads spreadsheets and documents", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: { id: "owner", name: "测试", role: "owner" },
        items: [],
      },
    }),
  );
  await page.goto(origin + "/#/imports");
  const zip = new JSZip();
  zip.file("新媒体/说明.txt", "名单：张同学");
  const nested = new JSZip();
  nested.file("另一份.md", "# 课表说明");
  zip.file("子包.zip", await nested.generateAsync({ type: "uint8array" }));
  const bytes = Array.from(await zip.generateAsync({ type: "uint8array" }));
  const result = await page.evaluate(async (bytes) => {
    const store = await import("/src/client/agent-import/store.ts");
    const docs = await import("/src/client/agent-import/documents.ts");
    const job = { id: "file-test" } as any;
    await store.putMaterial(job.id, {
      path: "材料.zip",
      blob: new Blob([new Uint8Array(bytes)]),
      origin: "用户上传",
    });
    await docs.documentTool(job, "unpack", { path: "材料.zip" });
    await docs.documentTool(job, "unpack", { path: "材料.zip!/子包.zip" });
    const read = await docs.documentTool(job, "read_document", {
      path: "材料.zip!/新媒体/说明.txt",
    });
    return {
      paths: (await store.materials(job.id)).map((x: any) => x.path),
      read,
    };
  }, bytes);
  expect(result.paths).toContain("材料.zip!/子包.zip!/另一份.md");
  expect(JSON.stringify(result.read)).toContain("名单：张同学");
});
test("reads real synthetic legacy and modern Office files, PDF pages and image crops locally", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: { id: "owner", name: "测试", role: "owner" },
        items: [],
      },
    }),
  );
  await page.goto(origin + "/#/imports");
  const { readFile } = await import("node:fs/promises");
  const input = [];
  for (const extension of [
    "doc",
    "docx",
    "ppt",
    "pptx",
    "xls",
    "xlsx",
    "csv",
    "pdf",
    "png",
  ])
    input.push({
      path: "schedule." + extension,
      bytes: Array.from(
        await readFile("test/fixtures/import/schedule." + extension),
      ),
    });
  const outputs = await page.evaluate(async (files) => {
    const store = await import("/src/client/agent-import/store.ts"),
      docs = await import("/src/client/agent-import/documents.ts");
    const job = { id: "formats-test" } as any,
      results: Record<string, string> = {};
    for (const f of files) {
      await store.putMaterial(job.id, {
        path: f.path,
        blob: new Blob([new Uint8Array(f.bytes)]),
        origin: "合成测试材料",
      });
      const result = await docs.documentTool(job, "read_document", {
        path: f.path,
        page: 1,
        offset: 0,
      });
      results[f.path] = result.image
        ? "IMAGE:" + result.image.slice(0, 22)
        : JSON.stringify(result.result);
    }
    for (const extension of [
      "doc",
      "ppt",
      "xls",
      "docx",
      "pptx",
      "xlsx",
      "pdf",
      "png",
    ]) {
      const f = files.find((f) => f.path === "schedule." + extension)!;
      const path = "无扩展名-" + extension;
      await store.putMaterial(job.id, {
        path,
        blob: new Blob([new Uint8Array(f.bytes)]),
        origin: "合成测试材料",
      });
      const result = await docs.documentTool(job, "read_document", { path });
      results[path] = result.image
        ? "IMAGE:" + result.image.slice(0, 22)
        : JSON.stringify(result.result);
    }
    return results;
  }, input);
  for (const extension of ["doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv"])
    expect(outputs["schedule." + extension]).toMatch(/Alice|Mathematics/);
  expect(outputs["schedule.pdf"]).toContain("IMAGE:data:image/png;base64,");
  expect(outputs["schedule.png"]).toContain("IMAGE:data:image/png;base64,");
  for (const extension of ["doc", "docx", "ppt", "pptx", "xls", "xlsx"])
    expect(outputs["无扩展名-" + extension]).toMatch(/Alice|Mathematics/);
  for (const extension of ["pdf", "png"])
    expect(outputs["无扩展名-" + extension]).toContain(
      "IMAGE:data:image/png;base64,",
    );
});
test("expired completed material is deleted on reopening and other users cannot list drafts", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: { id: "owner", name: "测试", role: "owner" },
        items: [],
      },
    }),
  );
  await page.goto(origin + "/#/imports");
  const result = await page.evaluate(async () => {
    const s = await import("/src/client/agent-import/store.ts");
    await s.saveJob({
      id: "expired",
      owner: "owner",
      expiresAt: Date.now() - 1,
      createdAt: 1,
      status: "applied",
    } as any);
    await s.putMaterial("expired", {
      path: "secret.txt",
      origin: "test",
      blob: new Blob(["temporary"]),
    });
    await s.saveJob({
      id: "other",
      owner: "another-user",
      expiresAt: null,
      createdAt: 2,
      status: "paused",
    } as any);
    await s.cleanup();
    return {
      files: await s.materials("expired"),
      jobs: (await s.listJobs("owner")).map((x: any) => x.id),
    };
  });
  expect(result.files).toEqual([]);
  expect(result.jobs).not.toContain("expired");
  expect(result.jobs).not.toContain("other");
});

test("personal course editor exposes validation failures inside its dialog", async ({
  page,
}) => {
  const snapshot = emptySnapshot();
  for (const call of calls().filter((c) => c.name === "change_record")) {
    const args = call.args as any;
    mutate(snapshot, args.entity, "create", args.data, args.id);
  }
  const term = {
    id: "term",
    name: "2026 秋",
    startDate: "2026-09-07",
    weekCount: 2,
    status: "active",
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = { items: [] };
    if (path === "/api/auth/me")
      data = {
        authenticated: true,
        user: { id: "owner", name: "测试管理员", role: "owner" },
      };
    else if (path === "/api/agent-imports/snapshot") data = { data: snapshot };
    else if (path === "/api/terms") data = { items: [term] };
    else if (path === "/api/persons")
      data = { items: [{ id: "p", fullName: "张同学", status: "active" }] };
    else if (path.endsWith("/timetable"))
      data = { cells: [], termId: "term", personId: "p", week: 1 };
    await route.fulfill({ json: data });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/#/timetable");
  await page.getByRole("button", { name: "修改课程", exact: true }).click();
  await page.getByLabel("开始节次", { exact: true }).fill("4");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "课表节次超出作息范围",
  );
  await page.screenshot({
    path: ".impeccable/review/import-course-error-mobile.png",
    fullPage: true,
  });
  await page.getByLabel("开始节次", { exact: true }).fill("1");
});
