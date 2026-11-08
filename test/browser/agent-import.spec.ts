import { test, expect } from "@playwright/test";
import JSZip from "jszip";
import { emptySnapshot, mutate } from "../../src/shared/agent-import/model";
const origin = "http://127.0.0.1:5178";
const base = emptySnapshot();
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
  mutate(snapshot, "person", "create", { full_name: "张同学" }, "p");
  mutate(
    snapshot,
    "term",
    "create",
    { name: "秋", start_date: "2026-09-07", week_count: 2 },
    "term",
  );
  mutate(
    snapshot,
    "timetable_profile",
    "create",
    {
      term_id: "term",
      name: "作息",
      periods: '[{"index":1,"start":"08:00","end":"08:45"}]',
    },
    "profile",
  );
  mutate(
    snapshot,
    "timetable_entry",
    "create",
    {
      id: "entry",
      person_id: "p",
      term_id: "term",
      profile_id: "profile",
      name: "高等数学",
      weekday: 1,
      period_from: 1,
      period_to: 1,
      weeks: "[1,2]",
    },
    "entry",
  );
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

test("calendar review shows known clocks, accepts missing fields, and creates a bound draft on mobile", async ({
  page,
}) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith("/auth/me")
      ? {
          authenticated: true,
          user: { id: "owner", role: "owner", name: "测试" },
        }
      : path.endsWith("/snapshot")
        ? { data: base }
        : path === "/api/agent-imports"
          ? { id: "calendar-ui" }
          : { status: "draft" };
    if (path.endsWith("/apply"))
      throw Error("This review must not submit data");
    await route.fulfill({ json: data });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/imports");
  await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const s = await import("/src/client/agent-import/store.ts");
    const t = await import("/src/shared/agent-import/timetable.ts");
    const job = await r.createJob("owner", []);
    const sources = [
      {
        source: "操作员意见",
        locator: "测试数据",
        explanation: "日历 UI 测试",
        inferred: false,
      },
    ];
    const staged = t.stageTimetable(
      job.draft,
      {},
      t.timetableProposalSchema.parse({
        id: "p",
        person: { id: "person", full_name: "甲" },
        term_name: "测试秋季",
        entries: [
          {
            name: "数学",
            weekday: 1,
            period_from: 1,
            period_to: 1,
            weeks: [1],
          },
        ],
        sources,
      }),
    );
    job.draft = staged.draft;
    job.evidence = staged.evidence;
    job.timetables = { p: staged.proposal };
    job.title = "日历界面测试";
    job.status = "review";
    job.calendars = {
      c: {
        id: "c",
        name: "测试秋季",
        term_id: null,
        start_date: "2026-08-31",
        week_count: null,
        minimum_weeks: 18,
        periods: [{ index: 1, start: "08:30", end: null }],
        timetable_ids: ["p"],
        sources,
        unresolved: ["总周数与下课时间待确认"],
      },
    };
    await s.saveJob(job);
  });
  await page.reload();
  await page.getByRole("button", { name: /日历界面测试/ }).click();
  await expect(
    page.getByText("第1节 08:30–下课待定", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "复核日期与作息", exact: true })
    .click();
  await expect(page.getByLabel("第一教学周周一", { exact: true })).toHaveValue(
    "2026-08-31",
  );
  await page.getByLabel("覆盖周数（留空按课程确定）", { exact: true }).fill("18");
  await page.getByLabel("第1节下课", { exact: true }).fill("09:15");
  await page.getByLabel("仍待确认的事项（每行一项）", { exact: true }).fill("");
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.getByRole("button", { name: "保存复核结果", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const result = await page.evaluate(async () => {
    const s = await import("/src/client/agent-import/store.ts");
    const j = (await s.listJobs("owner"))[0];
    return {
      bound: j.timetables?.p.bound,
      period: j.draft.class_period[0],
      courses: j.draft.timetable_entry.length,
    };
  });
  expect(result).toMatchObject({
    bound: true,
    period: { start_time: "08:30", end_time: "09:15" },
    courses: 1,
  });
});

test("reads GBK HTML exported under an xls extension without corrupting Chinese identities", async ({
  page,
}) => {
  await documentRoutes(page);
  const result = await page.evaluate(async () => {
    const s = await import("/src/client/agent-import/store.ts"),
      d = await import("/src/client/agent-import/documents.ts");
    const before = new TextEncoder().encode(
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=GBK"></head><body><table><tr><td>',
    );
    // GBK encoding of 姓名：测试甲, independent of the private real-data fixture.
    const name = new Uint8Array([
      0xd0, 0xd5, 0xc3, 0xfb, 0xa3, 0xba, 0xb2, 0xe2, 0xca, 0xd4, 0xbc, 0xd7,
    ]);
    const after = new TextEncoder().encode(
      "</td></tr></table><p>Outside &amp; table note</p><script>DO_NOT_READ</script></body></html>",
    );
    await s.putMaterial("gbk-test", {
      path: "export.xls",
      blob: new Blob([before, name, after]),
      origin: "synthetic",
    });
    return d.documentTool({ id: "gbk-test" } as any, "read_document", {
      path: "export.xls",
    });
  });
  expect(JSON.stringify(result)).toContain("姓名：测试甲");
  expect((result.result as any).content.outsideTables.text).toContain(
    "Outside & table note",
  );
  expect((result.result as any).content.outsideTables.text).not.toContain(
    "DO_NOT_READ",
  );
});

test("OCR reads local pixels without sending materials to an external service", async ({
  page,
}) => {
  await documentRoutes(page);
  const external: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.protocol.startsWith("http") && url.hostname !== "127.0.0.1")
      external.push(url.origin);
  });
  const result = await page.evaluate(async () => {
    const { putMaterial } = await import("/src/client/agent-import/store.ts");
    const { documentTool } = await import(
      "/src/client/agent-import/documents.ts"
    );
    const canvas = document.createElement("canvas");
    canvas.width = 700;
    canvas.height = 150;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 700, 150);
    ctx.fillStyle = "black";
    ctx.font = "48px sans-serif";
    ctx.fillText("ALPHA 12345", 30, 95);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/png"),
    );
    await putMaterial("ocr-test", {
      path: "letters.png",
      origin: "synthetic",
      blob,
    });
    return (
      await documentTool({ id: "ocr-test" } as any, "ocr_image", {
        path: "letters.png",
      })
    ).result as any;
  });
  expect(result.ocr.text).toContain("12345");
  expect(result.ocr.lines.length).toBeGreaterThan(0);
  expect(external).toEqual([]);
});

test("image crops clip the image edge and explain invalid coordinates", async ({
  page,
}) => {
  await documentRoutes(page);
  const result = await page.evaluate(async () => {
    const s = await import("/src/client/agent-import/store.ts"),
      d = await import("/src/client/agent-import/documents.ts");
    const canvas = document.createElement("canvas");
    canvas.width = 20;
    canvas.height = 10;
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!)),
    );
    await s.putMaterial("crop", {
      path: "edge.png",
      origin: "synthetic",
      blob,
    });
    const clipped = await d.documentTool({ id: "crop" } as any, "view_image", {
      path: "edge.png",
      crop: { x: 18, y: 8, width: 10, height: 10 },
    });
    let error = "";
    try {
      await d.documentTool({ id: "crop" } as any, "view_image", {
        path: "edge.png",
        crop: { x: 21, y: 8, width: 10, height: 10 },
      });
    } catch (e) {
      error = (e as Error).message;
    }
    let pageError = "";
    try {
      await d.documentTool({ id: "crop" } as any, "view_image", {
        path: "edge.png",
        page: 2,
      });
    } catch (e) {
      pageError = (e as Error).message;
    }
    return { clipped: clipped.result, error, pageError };
  });
  expect(result.clipped).toMatchObject({
    crop: { x: 18, y: 8, width: 2, height: 2 },
    clipped: true,
    renderedWidth: 2,
    renderedHeight: 2,
  });
  expect(result.error).toContain("20 × 10");
  expect(result.pageError).toContain("单张图片只有 page=1");
});

test("large restored image context fits the transport budget without dropping evidence", async ({
  page,
}) => {
  await documentRoutes(page);
  const result = await page.evaluate(async () => {
    const { fitImagePayload } = await import(
      "/src/client/agent-import/image-payload.ts"
    );
    const noise = (start: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2048;
      const ctx = canvas.getContext("2d")!;
      const pixels = ctx.createImageData(2048, 2048);
      let seed = start;
      for (let i = 0; i < pixels.data.length; i += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels.data[i] = seed & 255;
        pixels.data[i + 1] = (seed >>> 8) & 255;
        pixels.data[i + 2] = (seed >>> 16) & 255;
        pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
      return canvas.toDataURL("image/png");
    };
    const originals = [noise(1), noise(2), noise(3)];
    const messages = originals.map((image, i) => ({
      role: "user" as const,
      content: [
        { type: "text" as const, text: "source:" + i },
        { type: "image" as const, image },
      ],
    }));
    const fitted = await fitImagePayload(messages);
    const parts = fitted.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    );
    const images = parts.filter((p) => p.type === "image");
    return {
      before: JSON.stringify(messages).length,
      after: JSON.stringify(fitted).length,
      images: images.length,
      maxImage: Math.max(...images.map((p) => String(p.image).length)),
      sources: parts.filter(
        (p) => p.type === "text" && p.text.startsWith("source:"),
      ).length,
      originalUnchanged: messages.every((m, i) => m.content[1].image === originals[i]),
      warns: parts.filter(
        (p) => p.type === "text" && p.text.includes("按原图坐标裁剪"),
      ).length,
    };
  });
  expect(result.before).toBeGreaterThan(20 * 1024 * 1024);
  expect(result.after).toBeLessThan(12 * 1024 * 1024);
  expect(result.maxImage).toBeLessThanOrEqual(1500000);
  expect(result.images).toBe(3);
  expect(result.sources).toBe(3);
  expect(result.warns).toBe(3);
  expect(result.originalUnchanged).toBe(true);
});

async function documentRoutes(page: import("@playwright/test").Page) {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: { id: "owner", role: "owner", name: "测试" },
        items: [],
      },
    }),
  );
  await page.goto("/#/imports");
}

test("direct local models call the provider from the browser with the locally stored key", async ({ page }) => {
  await documentRoutes(page);
  const upstream: { auth: string | null; body: any }[] = [];
  let serverTurns = 0;
  await page.route("**/api/agent-imports/*/turn", (route) => {
    serverTurns++;
    return route.fulfill({ status: 500, json: {} });
  });
  await page.route("https://api.deepseek.com/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });
    upstream.push({ auth: request.headers()["authorization"] ?? null, body: request.postDataJSON() });
    return route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: { id: "r", object: "chat.completion", created: 1, model: "deepseek-flash", choices: [{ index: 0, message: { role: "assistant", content: null, reasoning_content: "ok", tool_calls: [{ id: "c1", type: "function", function: { name: "tree", arguments: '{"prefix":"","offset":0}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    });
  });
  const result = await page.evaluate(async () => {
    const { saveLocalModels, activeLocalModels, localTurn } = await import("/src/client/agent-import/local-models.ts");
    saveLocalModels({ direct: true, models: [{ id: "a", name: "DeepSeek", kind: "openai_compatible", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", apiKey: "sk-local-123", enabled: true }] });
    const reply: any = await localTurn({ mode: "discover", context: "{}", messages: [{ role: "user", content: "hi" }] });
    return { active: activeLocalModels().length, call: reply.calls[0].name, model: reply.model, stored: localStorage.getItem("rota:local-models")?.includes("sk-local-123") };
  });
  expect(result).toEqual({ active: 1, call: "tree", model: "DeepSeek / deepseek-flash", stored: true });
  expect(upstream).toHaveLength(1);
  expect(upstream[0].auth).toBe("Bearer sk-local-123");
  expect(upstream[0].body.tool_choice).toBe("auto");
  expect(serverTurns).toBe(0);
});
