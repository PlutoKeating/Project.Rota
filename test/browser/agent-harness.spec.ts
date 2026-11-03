import { test, expect, type Page } from "@playwright/test";
import { emptySnapshot } from "../../src/shared/agent-import/model";
const base = emptySnapshot();
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
  expect(result.error).toContain("未生成交接摘要");
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
  expect(JSON.stringify(result.history)).toContain("请先用 observe_material");
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
