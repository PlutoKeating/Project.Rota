import { test, expect, type Page } from "@playwright/test";
import { emptySnapshot } from "../../src/shared/agent-import/model";
const base = emptySnapshot();
const checks = (indexes: number[]) => ({
  identity: "身份逐字一致",
  courses_and_times: "逐条对照名称星期节次周次",
  teachers_and_locations: "原件未提供教师地点，不填造值",
  calendar: "日历未提供",
  coverage: "complete",
  coverage_reason: "合成材料完整",
  checked_entries: indexes,
});

function reply(calls: any[]) {
  return {
    calls,
    messages: [
      {
        role: "assistant",
        content: calls.map((c) => ({
          type: "tool-call",
          toolCallId: c.id,
          toolName: c.name,
          input: c.args,
        })),
      },
    ],
    text: "",
    model: "synthetic / harness",
    providerId: "test",
  };
}
async function routes(page: Page, turn: (body: any) => any) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: any = { status: "draft" };
    if (path.endsWith("/auth/me"))
      data = {
        authenticated: true,
        user: { id: "owner", role: "owner", name: "测试" },
      };
    else if (path.endsWith("/snapshot")) data = { data: base };
    else if (path === "/api/agent-imports") data = { id: "long-batch" };
    else if (path.endsWith("/turn"))
      data = turn(route.request().postDataJSON());
    else if (path.endsWith("/apply"))
      throw Error("Agent must never submit formal data");
    await route.fulfill({ json: data });
  });
  await page.goto("/#/imports");
}
test("30 materials survive repeated handoffs, page reload, and history retrieval", async ({
  page,
}) => {
  let step = 0,
    compactions = 0;
  await routes(page, (body) => {
    if (body.mode === "compact") {
      compactions++;
      return reply([
        {
          id: "handoff-" + compactions,
          name: "save_handoff",
          args: {
            summary:
              "已逐份核对材料，识别成果保存在 observe_material；日期仍待核实，不得捏造。",
            nextSteps: ["继续处理尚未标记的材料，最后查询首份材料历史。"],
          },
        },
      ]);
    }
    const i = Math.floor(step / 2);
    step++;
    if (i < 30)
      return reply(
        step % 2 === 1
          ? [
              {
                id: "read-" + i,
                name: "read_document",
                args: { path: i + ".txt" },
              },
            ]
          : [
              {
                id: "observe-" + i,
                name: "observe_material",
                args: {
                  kind: "other",
                  path: i + ".txt",
                  content:
                    `人员${i}的来源和逐项课程事实：` +
                    "具体教学周与课程时段需要复核。".repeat(350),
                  unresolved: ["首周日期未提供"],
                },
              },
              {
                id: "mark-" + i,
                name: "mark_file",
                args: {
                  path: i + ".txt",
                  status: "done",
                  reason: "识别成果已独立保存",
                },
              },
            ],
      );
    return reply([
      { id: "old-read", name: "read_history", args: { key: "tool:1:read-0" } },
      { id: "validate", name: "validate_draft", args: {} },
      {
        id: "finish",
        name: "finish_review",
        args: { summary: "已保存30份材料，等待日期核实。", unresolved: [] },
      },
    ]);
  });
  const first = await page.evaluate(async () => {
    const runtime = await import("/src/client/agent-import/runtime.ts");
    const job = await runtime.createJob(
      "owner",
      Array.from(
        { length: 30 },
        (_, i) => new File([`人员${i}课程事实`], i + ".txt"),
      ),
    );
    const runner = new runtime.ImportRunner(job, (j) => {
      if (Object.keys(j.observations ?? {}).length >= 15) runner.stop();
    });
    await runner.run();
    return {
      status: job.status,
      count: Object.keys(job.observations ?? {}).length,
    };
  });
  expect(first).toEqual({ status: "paused", count: 15 });
  await page.reload();
  const final = await page.evaluate(async () => {
    const store = await import("/src/client/agent-import/store.ts"),
      runtime = await import("/src/client/agent-import/runtime.ts");
    const job = (await store.listJobs("owner"))[0];
    await new runtime.ImportRunner(job, () => {}).run();
    return {
      status: job.status,
      count: Object.keys(job.observations ?? {}).length,
      unresolved: job.unresolved,
      history: await store.readHistory(job.id, 0, "tool:61:old-read"),
      files: (await store.materials(job.id)).filter(
        (f: any) => f.status === "done",
      ).length,
    };
  });
  expect(compactions).toBeGreaterThanOrEqual(3);
  expect(final.status).toBe("review");
  expect(final.count).toBe(30);
  expect(final.files).toBe(30);
  expect(final.unresolved).toHaveLength(30);
  expect(JSON.stringify(final.history)).toContain("人员0课程事实");
});
test("successful repeated reads pause instead of running forever", async ({
  page,
}) => {
  let turns = 0;
  await routes(page, () =>
    reply([{ id: "repeat-" + ++turns, name: "tree", args: {} }]),
  );
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const job = await r.createJob("owner", [new File(["事实"], "材料.txt")]);
    await new r.ImportRunner(job, () => {}).run();
    return {
      status: job.status,
      error: job.error,
      messages: JSON.stringify(job.messages),
    };
  });
  expect(turns).toBe(12);
  expect(result.status).toBe("paused");
  expect(result.error).toContain("没有新增识别成果");
  expect(result.messages).toContain("连续 6 轮");
});
test("failed handoff preserves context and draft; pending archive checkpoint is replayable", async ({
  page,
}) => {
  await routes(page, () => reply([]));
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts"),
      s = await import("/src/client/agent-import/store.ts");
    const job = await r.createJob("owner", [new File(["事实"], "材料.txt")]);
    job.messages = [
      { role: "user", content: "唯一且尚未汇总的材料事实".repeat(6000) },
    ];
    job.checkpoint = {
      key: "interrupted",
      kind: "tool",
      data: { result: "尚未归档的结果" },
    };
    // Simulate a process dying after the primary draft transaction, before the history write.
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("rota-agent-import");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("jobs", "readwrite");
      tx.objectStore("jobs").put(job);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const restored = (await s.listJobs("owner"))[0];
    await new r.ImportRunner(restored, () => {}).run();
    const saved = (await s.listJobs("owner"))[0];
    const history = await s.readHistory(job.id, 0, "interrupted");
    const before = JSON.stringify(saved.messages);
    await s.deleteJob(job.id);
    return {
      error: saved.error,
      size: before.length,
      history,
      after: await s.readHistory(job.id),
      jobs: await s.listJobs("owner"),
    };
  });
  expect(result.error).toContain("连续 12 轮");
  expect(result.size).toBeGreaterThan(48000);
  expect(JSON.stringify(result.history)).toContain("尚未归档的结果");
  expect(result.after).toEqual([]);
  expect(result.jobs).toEqual([]);
});
test("missing dates do not block saving facts; two unread observations enforce incremental work", async ({
  page,
}) => {
  let turn = 0;
  await routes(page, () =>
    reply(
      ++turn === 1
        ? [
            ...[0, 1, 2].map((i) => ({
              id: "read-" + i,
              name: "read_document",
              args: { path: i + ".txt" },
            })),
            { id: "validate", name: "validate_draft", args: {} },
          ]
        : [
            {
              id: "finish",
              name: "finish_review",
              args: { summary: "尚有待处理", unresolved: [] },
            },
          ],
    ),
  );
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts"),
      s = await import("/src/client/agent-import/store.ts");
    const job = await r.createJob(
      "owner",
      [0, 1, 2].map((i) => new File(["课程内容"], i + ".txt")),
    );
    const runner = new r.ImportRunner(job, (j) => {
      if (j.pending.length === 0 && j.turns === 1) runner.stop();
    });
    await runner.run();
    return {
      reads: job.unrecordedReads,
      history: await s.readHistory(job.id, 0, "tool:1:read-2"),
    };
  });
  expect(result.reads).toEqual(["0.txt", "1.txt"]);
  expect(JSON.stringify(result.history)).toContain("请先用 save_timetable");
});
test("503 is retried once, diagnosed as transport failure, and never misreported as migration", async ({
  page,
}) => {
  let requests = 0;
  await routes(page, () => reply([]));
  await page.route("**/api/agent-imports/*/turn", (route) => {
    requests++;
    return route.fulfill({
      status: 503,
      contentType: "text/html",
      body: "upstream unavailable",
    });
  });
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const job = await r.createJob("owner", [new File(["课程"], "资料.txt")]);
    await new r.ImportRunner(job, () => {}).run();
    return { status: job.status, error: job.error, metrics: job.metrics };
  });
  expect(requests).toBe(2);
  expect(result.status).toBe("paused");
  expect(result.error).not.toContain("迁移");
  expect(result.error).toContain("/turn");
  expect(result.metrics).toHaveLength(2);
  expect(result.metrics?.[0].attempts[0].httpStatus).toBe(503);
});
test("incomplete structural draft can reach review but cannot be committed", async ({
  page,
}) => {
  await routes(page, () =>
    reply([
      {
        id: "term",
        name: "change_record",
        args: {
          entity: "term",
          action: "create",
          id: "t",
          data: { name: "尚缺作息", start_date: "2026-09-07", week_count: 18 },
          evidence: [
            {
              source: "操作员意见",
              locator: "测试输入",
              explanation: "合成测试日期",
              inferred: false,
            },
          ],
        },
      },
      {
        id: "blocked",
        name: "mark_file",
        args: { path: "资料.txt", status: "blocked", reason: "缺少作息依据" },
      },
      { id: "validate", name: "validate_draft", args: {} },
      {
        id: "finish",
        name: "finish_review",
        args: { summary: "等待补充作息后复核", unresolved: ["作息未知"] },
      },
    ]),
  );
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const job = await r.createJob("owner", [
      new File(["缺少作息"], "资料.txt"),
    ]);
    await new r.ImportRunner(job, () => {}).run();
    let error = "";
    try {
      await r.applyJob(job);
    } catch (e) {
      error = (e as Error).message;
    }
    return { status: job.status, unresolved: job.unresolved, error };
  });
  expect(result.status).toBe("review");
  expect(result.unresolved).toContain("缺少全局节次");
  expect(result.error).toContain("缺少全局节次");
});
test("reused provider call IDs remain distinct and long history pages are not re-truncated", async ({
  page,
}) => {
  let turn = 0;
  await routes(page, () =>
    reply(
      ++turn <= 2
        ? [{ id: "same", name: "read_document", args: { path: turn + ".txt" } }]
        : [
            {
              id: "retrieve",
              name: "read_history",
              args: { key: "tool:1:same", offset: 0 },
            },
          ],
    ),
  );
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts"),
      s = await import("/src/client/agent-import/store.ts");
    const job = await r.createJob("owner", [
      new File(["甲".repeat(24000)], "1.txt"),
      new File(["乙".repeat(24000)], "2.txt"),
    ]);
    const runner = new r.ImportRunner(job, (j) => {
      if (j.turns === 3 && j.pending.length === 0) runner.stop();
    });
    await runner.run();
    const latest = job.messages
      .filter((m: any) => m.role === "tool")
      .at(-1) as any;
    return {
      a: JSON.stringify(await s.readHistory(job.id, 0, "tool:1:same")),
      b: JSON.stringify(await s.readHistory(job.id, 0, "tool:2:same")),
      page: latest.content[0].output.value,
    };
  });
  expect(result.a).toContain("甲".repeat(100));
  expect(result.b).toContain("乙".repeat(100));
  expect(result.page.text).toHaveLength(12000);
  expect(result.page.nextOffset).toBe(12000);
  expect(result.page.historyKey).toBeUndefined();
});

test("reads GBK HTML exported under an xls extension without corrupting Chinese identities", async ({
  page,
}) => {
  await routes(page, () => reply([]));
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

test("retains structured courses and membership when no calendar or clock profile exists", async ({
  page,
}) => {
  await routes(page, () =>
    reply([
      { id: "read", name: "read_document", args: { path: "资料.txt" } },
      {
        id: "save",
        name: "save_timetable",
        args: {
          id: "schedule",
          person: { id: "person", full_name: "测试甲" },
          organization_ids: [],
          term_name: "2026秋",
          entries: [
            {
              name: "数学",
              weekday: 1,
              period_from: 3,
              period_to: 4,
              weeks: [7, 8],
            },
          ],
          sources: [
            {
              source: "资料.txt",
              locator: "全文",
              explanation: "材料明确提供星期节次周次，未提供钟点",
              inferred: false,
            },
          ],
          completed_sources: ["资料.txt"],
          unresolved: ["作息未知"],
        },
      },
      {
        id: "append",
        name: "save_timetable",
        args: {
          mode: "append",
          id: "schedule",
          person: { id: "person", full_name: "测试甲" },
          organization_ids: [],
          term_name: "2026秋",
          entries: [
            {
              name: "物理",
              weekday: 7,
              period_from: 1,
              period_to: 2,
              weeks: [8],
            },
          ],
          sources: [
            {
              source: "资料.txt",
              locator: "全文",
              explanation: "明确列出的另一项课程",
              inferred: false,
            },
          ],
          completed_sources: ["资料.txt"],
          unresolved: ["作息未知"],
        },
      },
    ]),
  );
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const job = await r.createJob("owner", [
      new File(["测试甲，周一3-4节，第7、8周数学。"], "资料.txt"),
    ]);
    const runner = new r.ImportRunner(job, (j) => {
      if (j.turns === 1 && !j.pending.length) runner.stop();
    });
    await runner.run();
    return {
      proposal: job.timetables?.schedule,
      formal: job.draft.timetable_entry,
      issues: (await r.checkJob(job)).issues,
    };
  });
  expect(result.proposal?.entries).toHaveLength(2);
  expect(result.proposal?.entries[0]).toMatchObject({
    name: "数学",
    weekday: 1,
    weeks: [7, 8],
  });
  expect(result.formal).toHaveLength(0);
  expect(result.issues.some((i: any) => i.message.includes("作息"))).toBe(true);
  await page.reload();
  await page.locator("summary").filter({ hasText: "本机最近导入" }).click();
  await page.getByRole("button", { name: /资料.txt/ }).click();
  await page.locator("summary").filter({ hasText: "测试甲" }).click();
  await expect(page.getByRole("cell", { name: /^数学/ })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "7、8", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "修改课程" }).first().click();
  await page.getByLabel("课程名称", { exact: true }).fill("数学（已核对）");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: /^数学（已核对）/ }),
  ).toBeVisible();
});

test("OCR reads local pixels without sending materials to an external service", async ({
  page,
}) => {
  await routes(page, () => reply([]));
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

test("OCR cannot bypass the partial-save checkpoint and resumes after facts are saved", async ({
  page,
}) => {
  const evidence = [
    {
      source: "folder/table.png",
      locator: "第一行",
      explanation: "合成图已核对",
      inferred: false,
    },
    {
      source: "folder",
      locator: "目录名",
      explanation: "保留目录来源",
      inferred: true,
    },
  ];
  await routes(page, () =>
    reply([
      { id: "blocked", name: "ocr_image", args: { path: "folder/table.png" } },
      {
        id: "save",
        name: "save_timetable",
        args: {
          id: "partial",
          person: { id: "p", full_name: "测试甲" },
          term_name: "待确认",
          entries: [
            {
              name: "数学",
              weekday: 1,
              period_from: 1,
              period_to: 2,
              weeks: [1],
            },
          ],
          sources: evidence,
          completed_sources: [],
          unresolved: ["下半页未核对"],
        },
      },
      { id: "resume", name: "ocr_image", args: { path: "folder/table.png" } },
    ]),
  );
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts"),
      s = await import("/src/client/agent-import/store.ts");
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 100;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 400, 100);
    ctx.fillStyle = "black";
    ctx.font = "40px sans-serif";
    ctx.fillText("12345", 20, 65);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!)),
    );
    const job = await r.createJob("owner", [
      new File([blob], "folder/table.png"),
    ]);
    const file = (await s.materials(job.id))[0];
    await s.putMaterial(job.id, { ...file, inspected: true, pagesRead: [1] });
    job.unrecordedReads = ["folder/table.png"];
    job.unrecordedImageViews = { "folder/table.png": 3 };
    const runner = new r.ImportRunner(job, (j) => {
      if (j.turns === 1 && !j.pending.length) runner.stop();
    });
    await runner.run();
    return {
      log: job.log,
      views: job.unrecordedImageViews,
      entries: job.timetables?.partial.entries,
      files: await s.materials(job.id),
    };
  });
  expect(
    result.log.some((l: any) => l.text.includes("先用 save_timetable")),
  ).toBe(true);
  expect(result.views?.["folder/table.png"]).toBe(1);
  expect(result.entries).toHaveLength(1);
  expect(result.files[0].status).not.toBe("done");
});

test("an unfinished old file cannot postpone handoff while new people keep opening", async ({
  page,
}) => {
  await routes(page, () =>
    reply([{ id: "next", name: "read_document", args: { path: "next.txt" } }]),
  );
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts"),
      s = await import("/src/client/agent-import/store.ts");
    const job = await r.createJob("owner", [
      new File(["说明"], "old.txt"),
      new File(["下一人"], "next.txt"),
    ]);
    job.unrecordedReads = ["old.txt"];
    job.messages.push({ role: "user", content: "旧材料证据".repeat(10000) });
    const runner = new r.ImportRunner(job, (j) => {
      if (j.turns === 1 && !j.pending.length) runner.stop();
    });
    await runner.run();
    return {
      log: job.log,
      files: await s.materials(job.id),
      messages: job.messages,
    };
  });
  expect(
    result.log.some((l: any) => l.text.includes("需要先完成当前材料")),
  ).toBe(true);
  expect(
    result.files.find((f: any) => f.path === "next.txt")?.inspected,
  ).not.toBe(true);
  expect(JSON.stringify(result.messages)).toContain("旧材料证据");
});

test("image crops clip the image edge and explain invalid coordinates", async ({
  page,
}) => {
  await routes(page, () => reply([]));
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

test("focused source verification requires fresh reads, repairs omissions, and survives reload", async ({
  page,
}) => {
  let works = 0,
    verifications = 0;
  const sources = [
    {
      source: "资料.txt",
      locator: "全文",
      explanation: "原文两条课程",
      inferred: false,
    },
  ];
  await routes(page, (body) => {
    if (JSON.parse(body.context).verification) {
      verifications++;
      return reply(
        verifications === 1
          ? [
              {
                id: "premature",
                name: "confirm_timetable_check",
                args: {
                  id: "p-plan",
                  summary: "还没重新读取，不应被接受",
                  checks: checks([0]),
                },
              },
              {
                id: "read-again",
                name: "read_document",
                args: { path: "资料.txt" },
              },
            ]
          : [
              {
                id: "repair",
                name: "revise_timetable",
                args: {
                  id: "p-plan",
                  term_name: "原件确认的学期标题",
                  person: { class_name: "测试班" },
                  append: [
                    {
                      name: "物理",
                      weekday: 2,
                      period_from: 3,
                      period_to: 4,
                      weeks: [1],
                    },
                  ],
                  sources,
                },
              },
              {
                id: "confirmed",
                name: "confirm_timetable_check",
                args: {
                  id: "p-plan",
                  checks: checks([0, 1]),
                  summary:
                    "重新读取原件，已补齐漏掉的物理课，日期作息继续待确认",
                },
              },
            ],
      );
    }
    works++;
    return reply(
      works === 1
        ? [
            { id: "read", name: "read_document", args: { path: "资料.txt" } },
            {
              id: "save",
              name: "save_timetable",
              args: {
                id: "p-plan",
                person: { id: "p", full_name: "测试甲" },
                term_name: "待确认",
                entries: [
                  {
                    name: "数学",
                    weekday: 1,
                    period_from: 1,
                    period_to: 2,
                    weeks: [1],
                  },
                ],
                sources,
                completed_sources: ["资料.txt"],
              },
            },
            {
              id: "read-before-verification",
              name: "read_document",
              args: { path: "资料.txt" },
            },
          ]
        : [
            {
              id: "calendar",
              name: "save_calendar",
              args: {
                id: "c",
                name: "待定学期",
                start_date: null,
                week_count: null,
                periods: [],
                timetable_ids: ["p-plan"],
                sources,
                unresolved: ["材料未提供"],
              },
            },
            {
              id: "global",
              name: "confirm_import_check",
              args: {
                calendar_review: "已保存未知日历字段",
                identity_review: "单人无冲突",
                unresolved: ["日期作息待定"],
              },
            },
            { id: "validate", name: "validate_draft", args: {} },
            {
              id: "finish",
              name: "finish_review",
              args: {
                summary: "两条课程已核对，作息待确认",
                unresolved: ["学期作息未知"],
              },
            },
          ],
    );
  });
  const paused = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const job = await r.createJob("owner", [
      new File(["测试甲：第一周周一1-2节数学；周二3-4节物理。"], "资料.txt"),
    ]);
    const runner = new r.ImportRunner(job, (j) => {
      if (j.turns === 2 && !j.pending.length) runner.stop();
    });
    await runner.run();
    return {
      verification: job.verification,
      checks: job.timetableChecks,
      log: job.log,
    };
  });
  expect(
    paused.log.some((l: any) => l.text.includes("需要先完成当前材料")),
  ).toBe(true);
  expect(paused.verification?.seen["资料.txt"]).toEqual([1]);
  expect(paused.checks?.["p-plan"]).toBeUndefined();
  expect(paused.log.some((l: any) => l.text.includes("完整覆盖来源"))).toBe(
    true,
  );
  await page.reload();
  const done = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts"),
      s = await import("/src/client/agent-import/store.ts");
    const job = (await s.listJobs("owner"))[0];
    await new r.ImportRunner(job, () => {}).run();
    const history = [];
    for (let offset = 0; ; offset += 10) {
      const rows = await s.readHistory(job.id, offset);
      history.push(...rows);
      if (rows.length < 10) break;
    }
    return {
      history,
      status: job.status,
      verification: job.verification,
      plan: job.timetables?.["p-plan"],
      check: job.timetableChecks?.["p-plan"],
      messages: job.messages,
    };
  });
  expect(done.status).toBe("review");
  expect(done.plan?.term_name).toBe("原件确认的学期标题");
  expect(done.plan?.person.class_name).toBe("测试班");
  expect(done.verification).toBeUndefined();
  expect(done.plan?.entries.map((e: any) => e.name)).toEqual(["数学", "物理"]);
  expect(done.check?.summary).toContain("补齐");
  expect(JSON.stringify(done.history)).toContain("已完成课表");
  expect(JSON.stringify(done.messages)).toContain("跨课表差异逐项核对已完成");
});

test("proxy validation feedback cannot execute a rejected tool", async ({
  page,
}) => {
  await routes(page, () =>
    reply([
      {
        id: "blocked",
        name: "note",
        args: { key: "should-not-exist", text: "not allowed" },
        validationError: "当前阶段不允许此工具",
      },
    ]),
  );
  const job = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const job = await r.createJob("owner", [new File(["资料"], "a.txt")]);
    const runner = new r.ImportRunner(job, (j) => {
      if (j.turns === 1 && !j.pending.length) runner.stop();
    });
    await runner.run();
    return job;
  });
  expect(job.notes["should-not-exist"]).toBeUndefined();
  expect(job.log.some((l: any) => l.text.includes("工具未执行"))).toBe(true);
});

test("handoff tool mistakes are corrected without executing them or dropping context", async ({
  page,
}) => {
  let count = 0;
  await routes(page, (body) => {
    expect(body.mode).toBe("compact");
    return reply(
      ++count === 1
        ? [
            {
              id: "wrong",
              name: "note",
              args: { key: "bad", text: "not run" },
              validationError: "只能交接",
            },
          ]
        : [
            {
              id: "handoff",
              name: "save_handoff",
              args: {
                summary:
                  "已保存真实成果与来源，未确定日期继续待定，不捏造任何缺失信息。",
                nextSteps: ["继续"],
              },
            },
          ],
    );
  });
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const job = await r.createJob("owner", [new File(["资料"], "a.txt")]);
    job.messages.push({ role: "user", content: "真实原文".repeat(14000) });
    const runner = new r.ImportRunner(job, (j) => {
      if (j.handoff) runner.stop();
    });
    await runner.run();
    return {
      handoff: job.handoff,
      notes: job.notes,
      status: job.status,
      error: job.error,
    };
  });
  expect(count).toBe(2);
  expect(result.handoff.summary).toContain("真实成果");
  expect(result.notes.bad).toBeUndefined();
  expect(result.error).toBeUndefined();
});

test("spreadsheet reading and source verification require the last column, and render real cell grids", async ({
  page,
}) => {
  await routes(page, () => reply([]));
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts"),
      s = await import("/src/client/agent-import/store.ts"),
      d = await import("/src/client/agent-import/documents.ts"),
      v = await import("/src/client/agent-import/verification.ts");
    const job = await r.createJob("owner", [
      new File(
        ["A,B,C,D,E,F,G,H,周日\n1,2,3,4,5,6,7,8,最后一列课程\n"],
        "sheet.csv",
      ),
    ]);
    job.verification = {
      id: "test",
      workMessages: [],
      required: [{ path: "sheet.csv", pages: 1 }],
      seen: {},
    };
    const left = await d.documentTool(job, "read_document", {
      path: "sheet.csv",
      range: "A1:H2",
    });
    v.recordVerificationRead(job, "sheet.csv", left.result);
    const partial = {
      material: (await s.materials(job.id))[0].pagesRead,
      verification: [...(job.verification.seen["sheet.csv"] ?? [])],
    };
    const right = await d.documentTool(job, "render_sheet", {
      path: "sheet.csv",
      range: "I1:I2",
    });
    v.recordVerificationRead(job, "sheet.csv", right.result);
    return {
      partial,
      pages: (await s.materials(job.id))[0].pagesRead,
      seen: job.verification.seen["sheet.csv"],
      image: right.image,
      content: right.result,
    };
  });
  expect(result.partial.material).toEqual([]);
  expect(result.partial.verification).toEqual([]);
  expect(result.pages).toEqual([1]);
  expect(result.seen).toEqual([1]);
  expect(result.image).toMatch(/^data:image\/png;base64,/);
  expect(result.image!.length).toBeGreaterThan(1000);
  expect(JSON.stringify(result.content)).toContain("最后一列课程");
});

test("source coverage never outruns the document text delivered to the model", async ({
  page,
}) => {
  await routes(page, () =>
    reply([
      { id: "read-long", name: "read_document", args: { path: "long.txt" } },
    ]),
  );
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const job = await r.createJob("owner", [
      new File(["资料".repeat(9000) + "尾部课程证据"], "long.txt"),
    ]);
    const runner = new r.ImportRunner(job, (j) => {
      if (j.turns === 1 && !j.pending.length) runner.stop();
    });
    await runner.run();
    return job.messages;
  });
  expect(JSON.stringify(result)).toContain("尾部课程证据");
  expect(JSON.stringify(result)).not.toContain("完整结果已归档");
});

test("conflicting update and removal explains recovery without mutating the draft", async ({
  page,
}) => {
  const sources = [
    {
      source: "rows.txt",
      locator: "全文",
      explanation: "测试原件",
      inferred: false,
    },
  ];
  await routes(page, () =>
    reply([
      { id: "read", name: "read_document", args: { path: "rows.txt" } },
      {
        id: "save",
        name: "save_timetable",
        args: {
          id: "plan",
          person: { id: "p", full_name: "测试" },
          term_name: "待定",
          entries: [{ name: "甲" }, { name: "乙" }],
          sources,
        },
      },
      {
        id: "wipe",
        name: "save_timetable",
        args: {
          id: "plan",
          person: { id: "p", full_name: "测试" },
          term_name: "待定",
          entries: [],
          sources,
          mode: "replace",
        },
      },
      {
        id: "bad",
        name: "revise_timetable",
        args: {
          id: "plan",
          updates: [{ index: 1, patch: { name: "错误修改" } }],
          remove: [1],
          sources,
        },
      },
      { id: "inspect", name: "read_timetables", args: { id: "plan" } },
      {
        id: "correct",
        name: "revise_timetable",
        args: { id: "plan", remove: [1], sources },
      },
      {
        id: "remove-last",
        name: "revise_timetable",
        args: { id: "plan", remove: [0], sources },
      },
    ]),
  );
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const job = await r.createJob("owner", [new File(["甲乙"], "rows.txt")]);
    const runner = new r.ImportRunner(job, (j) => {
      if (j.turns === 1 && !j.pending.length) runner.stop();
    });
    await runner.run();
    return { plans: job.timetables, messages: job.messages };
  });
  expect(result.plans.plan.entries).toEqual([]);
  const outputs = result.messages
    .filter((m: any) => m.role === "tool")
    .flatMap((m: any) => m.content);
  expect(
    outputs.find((o: any) => o.toolCallId === "wipe").output.value.error,
  ).toContain("不能用空 entries 覆盖");
  expect(
    outputs.find((o: any) => o.toolCallId === "bad").output.value.error,
  ).toContain("只保留 remove");
  expect(
    outputs.find((o: any) => o.toolCallId === "inspect").output.value.entries[1]
      .name,
  ).toBe("乙");
});

test("fresh partial image regions count as progress before a page is complete", async ({
  page,
}) => {
  let tile = 0;
  await routes(page, () =>
    reply([
      {
        id: "tile-" + tile,
        name: "view_image",
        args: {
          path: "wide.png",
          crop: { x: 10 * tile++, y: 0, width: 10, height: 10 },
        },
      },
    ]),
  );
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts"),
      s = await import("/src/client/agent-import/store.ts");
    const canvas = document.createElement("canvas");
    canvas.width = 140;
    canvas.height = 10;
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!)),
    );
    const job = await r.createJob("owner", [new File([blob], "wide.png")]);
    job.verification = {
      id: "plan",
      workMessages: [],
      required: [{ path: "wide.png", pages: 1 }],
      seen: {},
    };
    const runner = new r.ImportRunner(job, (j) => {
      if (j.turns === 13 && !j.pending.length) runner.stop();
    });
    await runner.run();
    return {
      turns: job.turns,
      error: job.error,
      pages: (await s.materials(job.id))[0].pagesRead,
    };
  });
  expect(result.turns).toBe(13);
  expect(result.error).toBeUndefined();
  expect(result.pages).toEqual([]);
});

test("exhausted provider quota pauses with saved progress instead of immediate retry", async ({
  page,
}) => {
  let requests = 0;
  await routes(page, () => reply([]));
  await page.route("**/api/agent-imports/*/turn", (route) => {
    requests++;
    return route.fulfill({
      status: 502,
      json: {
        error: "供应商额度已用尽",
        code: "llm_error",
        metrics: {
          requestId: "quota",
          durationMs: 1,
          purpose: "work",
          attempts: [
            {
              providerId: "test",
              model: "test",
              durationMs: 1,
              status: "error",
              code: "quota_exhausted",
              httpStatus: 429,
              retryAfterMs: 444558000,
            },
          ],
        },
      },
    });
  });
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const job = await r.createJob("owner", [new File(["课程"], "资料.txt")]);
    await new r.ImportRunner(job, () => {}).run();
    return { status: job.status, metrics: job.metrics };
  });
  expect(requests).toBe(1);
  expect(result.status).toBe("paused");
  expect(result.metrics?.[0].attempts[0].code).toBe("quota_exhausted");
});

for (const failureCode of ["timeout", "output_truncated", "invalid_tool_call"])
  test(`${failureCode} model responses retry with smaller output and persist recovery across reload`, async ({
    page,
  }) => {
    const requests: any[] = [];
    await routes(page, () => reply([]));
    await page.route("**/api/agent-imports/*/turn", (route) => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({
        status: 502,
        json: {
          error: "模型请求超时",
          code: "llm_error",
          metrics: {
            requestId: "timeout-" + requests.length,
            durationMs: 1,
            purpose: "work",
            attempts: [
              {
                providerId: "test",
                model: "test",
                durationMs: 1,
                status: "error",
                code: failureCode,
              },
            ],
          },
        },
      });
    });
    await page.evaluate(async () => {
      const r = await import("/src/client/agent-import/runtime.ts");
      const job = await r.createJob("owner", [new File(["课程"], "资料.txt")]);
      await new r.ImportRunner(job, () => {}).run();
    });
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0].messages)).not.toContain("最多保存 8 条");
    expect(JSON.stringify(requests[1].messages)).toContain("最多保存 8 条");
    await page.reload();
    const saved = await page.evaluate(async () => {
      const s = await import("/src/client/agent-import/store.ts");
      const job = (await s.listJobs("owner"))[0];
      return {
        status: job.status,
        messages: job.messages,
        people: job.draft.person.length,
      };
    });
    expect(saved.status).toBe("paused");
    expect(saved.people).toBe(0);
    expect(
      saved.messages.filter((m: any) =>
        String(m.content).includes("最多保存 8 条"),
      ),
    ).toHaveLength(1);
  });

test("large restored image context fits the transport budget without dropping evidence", async ({
  page,
}) => {
  await routes(page, () => reply([]));
  const result = await page.evaluate(async () => {
    const { fitImagePayload } = await import(
      "/src/client/agent-import/image-payload.ts"
    );
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2048;
    const ctx = canvas.getContext("2d")!;
    const pixels = ctx.createImageData(2048, 2048);
    let seed = 123456;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels.data[i] = seed & 255;
      pixels.data[i + 1] = (seed >>> 8) & 255;
      pixels.data[i + 2] = (seed >>> 16) & 255;
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const image = canvas.toDataURL("image/png");
    const messages = Array.from({ length: 3 }, (_, i) => ({
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
      originalUnchanged: messages.every((m) => m.content[1].image === image),
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

test("partial calendar survives reload and operator completion binds actual occupied events", async ({
  page,
}) => {
  const sources = [
    {
      source: "calendar.txt",
      locator: "全文",
      explanation: "第9周日期可推首周，只有上课钟点",
      inferred: true,
    },
  ];
  let count = 0;
  await routes(page, () => {
    count++;
    return reply(
      count === 1
        ? [
            {
              id: "read",
              name: "read_document",
              args: { path: "calendar.txt" },
            },
            {
              id: "save",
              name: "save_timetable",
              args: {
                id: "p",
                person: { id: "person", full_name: "甲" },
                term_name: "秋季",
                entries: [
                  {
                    name: "数学",
                    weekday: 1,
                    period_from: 1,
                    period_to: 1,
                    weeks: [9],
                    teacher: "教师甲",
                  },
                ],
                sources,
              },
            },
            {
              id: "calendar",
              name: "save_calendar",
              args: {
                id: "c",
                name: "秋季",
                start_date: "2026-08-31",
                week_count: null,
                minimum_weeks: 18,
                periods: [{ index: 1, start: "08:30", end: null }],
                timetable_ids: ["p"],
                sources,
                unresolved: ["下课钟点和总周数待确认"],
              },
            },
          ]
        : [],
    );
  });
  await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const job = await r.createJob("owner", [
      new File(["第9周周一2026-10-26；第1节08:30"], "calendar.txt"),
    ]);
    const runner = new r.ImportRunner(job, (j) => {
      if (j.turns === 1 && !j.pending.length) runner.stop();
    });
    await runner.run();
  });
  await page.reload();
  const result = await page.evaluate(async () => {
    const s = await import("/src/client/agent-import/store.ts");
    const r = await import("/src/client/agent-import/runtime.ts");
    const m = await import("/src/shared/agent-import/model.ts");
    const j = (await s.listJobs("owner"))[0];
    const before = structuredClone(j.calendars!.c);
    const termsBefore = j.draft.term.length;
    await r.editCalendar(j, {
      ...before,
      week_count: 18,
      periods: [{ index: 1, start: "08:30", end: "09:15" }],
      unresolved: [],
    });
    const after = m.materialize(j.draft, j.base);
    return {
      before,
      termsBefore,
      plan: j.timetables!.p,
      terms: after.term,
      events: after.timetable_event,
      issues: m.validateTransition(j.base, after),
    };
  });
  expect(result.before.start_date).toBe("2026-08-31");
  expect(result.before.week_count).toBeNull();
  expect(result.before.periods[0].end).toBeNull();
  expect(result.termsBefore).toBe(0);
  expect(result.plan.bound).toBe(true);
  expect(result.terms).toHaveLength(1);
  expect(result.events).toHaveLength(1);
  expect(result.events[0].starts_at).toContain("2026-10-26");
  expect(result.issues).toEqual([]);
});

test("operator scope changes preserve a completed batch check but cannot bless unrelated unreviewed changes", async ({
  page,
}) => {
  await routes(page, () => reply([]));
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const q = await import("/src/client/agent-import/readiness.ts");
    const t = await import("/src/shared/agent-import/timetable.ts");
    const job = await r.createJob("owner", []);
    const staged = t.stageTimetable(
      job.draft,
      {},
      t.timetableProposalSchema.parse({
        id: "p",
        person: { id: "person", full_name: "甲" },
        term_name: "未知",
        entries: [],
        sources: [
          {
            source: "操作员意见",
            locator: "复核",
            explanation: "无课表",
            inferred: false,
          },
        ],
      }),
    );
    job.draft = staged.draft;
    job.timetables = { p: staged.proposal };
    job.importCheck = {
      signature: q.importSignature(job),
      calendar_review: "已审",
      identity_review: "已审",
      unresolved: [],
    };
    await r.setPersonIncluded(job, "person", false);
    const excludedRequiresCheck = q.needsImportCheck(job),
      summary = job.summary;
    job.calendars = {
      c: {
        id: "c",
        name: "新线索",
        term_id: null,
        start_date: null,
        week_count: null,
        minimum_weeks: null,
        periods: [],
        timetable_ids: ["p"],
        sources: staged.proposal.sources,
        unresolved: [],
      },
    };
    await r.setPersonIncluded(job, "person", true);
    const changedRequiresCheck = q.needsImportCheck(job);
    await r.editRecord(job, "person", "person", {
      full_name: "操作员修订姓名",
    });
    return {
      excludedRequiresCheck,
      summary,
      changedRequiresCheck,
      editRequiresCheck: q.needsImportCheck(job),
    };
  });
  expect(result.excludedRequiresCheck).toBe(false);
  expect(result.summary).toContain("新增人员 0");
  expect(result.changedRequiresCheck).toBe(true);
  expect(result.editRequiresCheck).toBe(true);
});

test("editing a generated profile synchronizes its calendar evidence before rebuilding occupancy", async ({
  page,
}) => {
  await routes(page, () => reply([]));
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const t = await import("/src/shared/agent-import/timetable.ts");
    const c = await import("/src/shared/agent-import/calendar.ts");
    const m = await import("/src/shared/agent-import/model.ts");
    const job = await r.createJob("owner", []);
    const sources = [
      {
        source: "操作员意见",
        locator: "测试",
        explanation: "完整来源",
        inferred: false,
      },
    ];
    const proposal = c.calendarSchema.parse({
      id: "c",
      name: "秋季",
      start_date: "2026-08-31",
      week_count: 18,
      periods: [{ index: 1, start: "08:30", end: "09:15" }],
      timetable_ids: ["p"],
      sources,
    });
    const generated = c.stageCalendar(job.draft, {}, proposal);
    const plan = t.stageTimetable(
      generated.draft,
      generated.evidence,
      t.timetableProposalSchema.parse({
        id: "p",
        person: { id: "person", full_name: "甲" },
        term_name: "秋季",
        term_id: generated.termId,
        profile_id: generated.profileId,
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
    job.draft = plan.draft;
    job.evidence = plan.evidence;
    job.calendars = { c: proposal };
    job.timetables = { p: plan.proposal };
    await r.editRecord(job, "timetable_profile", generated.profileId, {
      periods: JSON.stringify([{ index: 1, start: "09:00", end: "09:45" }]),
    });
    return {
      calendar: job.calendars.c,
      issues: c.calendarBindingIssues(job),
      event: m.materialize(job.draft, job.base).timetable_event[0],
    };
  });
  expect(result.calendar.periods).toEqual([
    { index: 1, start: "09:00", end: "09:45" },
  ]);
  expect(result.issues).toEqual([]);
  expect(new Date(String(result.event.starts_at)).toISOString()).toBe(
    "2026-08-31T01:00:00.000Z",
  );
});

test("global review requires durable explanations for cross-person teacher differences", async ({
  page,
}) => {
  let turn = 0;
  await routes(page, () => {
    turn++;
    const confirm = {
      calendar_review: "未知字段已保存",
      identity_review: "两人独立",
      unresolved: [],
    };
    return reply(
      turn === 1
        ? [
            { id: "index", name: "read_course_consistency", args: {} },
            { id: "reject", name: "confirm_import_check", args: confirm },
          ]
        : [
            {
              id: "detail",
              name: "read_course_consistency",
              args: { key: "teacher:数学" },
            },
            {
              id: "record",
              name: "record_consistency_check",
              args: {
                key: "teacher:数学",
                resolution: "different_context",
                explanation: "合成原件明确为不同班级各自任课教师",
                checked_variants: [
                  { timetable_id: "a", teacher: "a" },
                  { timetable_id: "b", teacher: "b" },
                ],
              },
            },
            {
              id: "read-proof",
              name: "read_document",
              args: { path: "依据.txt" },
            },
            {
              id: "record-after-read",
              name: "record_consistency_check",
              args: {
                key: "teacher:数学",
                resolution: "different_context",
                explanation: "两班教师不同",
                checked_variants: [
                  { timetable_id: "a", teacher: "a" },
                  { timetable_id: "b", teacher: "b" },
                ],
              },
            },
            { id: "index2", name: "read_course_consistency", args: {} },
            { id: "accept", name: "confirm_import_check", args: confirm },
            { id: "validate", name: "validate_draft", args: {} },
            {
              id: "finish",
              name: "finish_review",
              args: { summary: "核对完毕", unresolved: [] },
            },
          ],
    );
  });
  await page.goto("/#/imports");
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const s = await import("/src/client/agent-import/store.ts");
    const v = await import("/src/client/agent-import/verification.ts");
    const job = await r.createJob("owner", [
      new File(["甲班数学教师a；乙班数学教师b"], "依据.txt"),
    ]);
    for (const file of await s.materials(job.id))
      await s.putMaterial(job.id, { ...file, status: "done" });
    job.timetables = {};
    job.timetableChecks = {};
    for (const id of ["a", "b"]) {
      const p: any = {
        id,
        person: { id, full_name: id },
        organization_ids: [],
        term_name: "秋",
        entries: [
          {
            name: "数学",
            teacher: id,
            weekday: 1,
            period_from: 1,
            period_to: 2,
            weeks: [1],
          },
        ],
        sources: [
          {
            source: "依据.txt",
            locator: "全文",
            explanation: "合成来源",
            inferred: false,
          },
        ],
        unresolved: [],
        bound: false,
      };
      job.timetables[id] = p;
      job.timetableChecks[id] = {
        signature: v.proposalSignature(p),
        summary: "合成已核对",
        at: Date.now(),
      };
    }
    job.calendars = {
      c: {
        id: "c",
        name: "秋",
        term_id: null,
        start_date: null,
        week_count: null,
        minimum_weeks: null,
        periods: [],
        timetable_ids: ["a", "b"],
        sources: [],
        unresolved: [],
      },
    };
    const runner = new r.ImportRunner(job, () => {});
    await runner.run();
    const rows = [
      ...(await s.readHistory(job.id, 0)),
      ...(await s.readHistory(job.id, 10)),
    ];
    return {
      status: job.status,
      reviews: job.importCheck?.consistency_review,
      tools: rows.filter((x) => x.kind === "tool").map((x) => x.data),
    };
  });
  expect(result.status).toBe("review");
  expect(result.reviews).toHaveLength(1);
  expect(
    result.tools.some(
      (x: any) =>
        x.name === "confirm_import_check" && x.result.error?.includes("跨课表"),
    ),
  ).toBe(true);
  expect(
    result.tools.some(
      (x: any) =>
        x.name === "record_consistency_check" &&
        x.result.error?.includes("须在本轮"),
    ),
  ).toBe(true);
  const indexes = result.tools.filter(
    (x: any) => x.name === "read_course_consistency" && !x.args.key,
  ) as any[];
  expect(indexes.map((x) => x.result.total)).toEqual([1, 0]);
});

test("a large invalid tool batch gets a model repair turn before pausing", async ({
  page,
}) => {
  let turns = 0;
  await routes(page, () =>
    reply(
      ++turns === 1
        ? Array.from({ length: 9 }, (_, i) => ({
            id: `bad-${i}`,
            name: "query_records",
            args: { entity: "not-an-entity" },
          }))
        : [
            { id: "validate", name: "validate_draft", args: {} },
            {
              id: "finish",
              name: "finish_review",
              args: { summary: "空批次", unresolved: [] },
            },
          ],
    ),
  );
  await page.goto("/#/imports");
  const result = await page.evaluate(async () => {
    const r = await import("/src/client/agent-import/runtime.ts");
    const job = await r.createJob("owner", []);
    await new r.ImportRunner(job, () => {}).run();
    return { status: job.status, pending: job.pending.length };
  });
  expect(result).toEqual({ status: "review", pending: 0 });
  expect(turns).toBe(2);
});

for (const allNetworkFailures of [false, true])
  test(`transport retries have their own bounded budget (${allNetworkFailures ? "exhausted" : "recovered"})`, async ({
    page,
  }) => {
    let requests = 0;
    await routes(page, () => reply([]));
    await page.route("**/api/agent-imports/*/turn", (route) => {
      requests++;
      if (!allNetworkFailures && requests === 4)
        return route.fulfill({
          json: reply([
            { id: "validate", name: "validate_draft", args: {} },
            {
              id: "finish",
              name: "finish_review",
              args: { summary: "恢复成功", unresolved: [] },
            },
          ]),
        });
      return route.fulfill({
        status: 502,
        json: {
          error: "临时失败",
          code: "llm_error",
          metrics: {
            requestId: `retry-${requests}`,
            durationMs: 1,
            purpose: "work",
            attempts: [
              {
                providerId: "test",
                model: "test",
                durationMs: 1,
                status: "error",
                code:
                  !allNetworkFailures && requests === 1
                    ? "timeout"
                    : "network_error",
              },
            ],
          },
        },
      });
    });
    const status = await page.evaluate(async () => {
      const r = await import("/src/client/agent-import/runtime.ts");
      const job = await r.createJob("owner", []);
      await new r.ImportRunner(job, () => {}).run();
      return job.status;
    });
    expect(requests).toBe(4);
    expect(status).toBe(allNetworkFailures ? "paused" : "review");
  });
