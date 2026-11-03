import { test, expect } from "@playwright/test";
test("local draft, animated handle sorting, save failure and one-request persistence", async ({
  page,
  request,
}) => {
  expect((await (await request.get("/api/health")).json()).env).toBe(
    "development",
  );
  const before = await (await request.get("/api/admin/model-config")).json();
  const fixtures = ["draft-a", "draft-b", "draft-c"].map((id) => ({
    id,
    name: id,
    kind: "cloudflare_ai",
    model: "@cf/test/" + id,
    enabled: true,
    params: { vision: true },
  }));
  const seed = await request.put("/api/admin/model-config", {
    data: { expectedVersion: before.version, items: fixtures },
  });
  expect(seed.ok()).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#/settings");
  await page.getByRole("button", { name: "模型服务", exact: true }).click();
  const rows = page.locator("[data-model-id]");
  await expect(rows).toHaveCount(3);
  let writes = 0;
  page.on("request", (r) => {
    if (
      r.method() !== "GET" &&
      /\/admin\/(model-config|llm-providers|model-order)/.test(r.url())
    )
      writes++;
  });
  await rows.first().getByLabel("启用", { exact: true }).uncheck();
  const handle = rows.first().getByRole("button", { name: /拖动排序/ });
  const h = (await handle.boundingBox())!;
  const target = (await rows.nth(2).boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2, target.y + target.height / 2, {
    steps: 12,
  });
  await expect
    .poll(() => rows.nth(1).evaluate((el) => getComputedStyle(el).transform))
    .not.toBe("none");
  await page.screenshot({
    path: ".impeccable/review/models-drag.png",
    fullPage: true,
  });
  await page.mouse.up();
  await expect(rows.last()).toHaveAttribute("data-model-id", "draft-a");
  await expect(page.getByText("有未保存更改", { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  await page.waitForTimeout(350);
  const keyHandle = rows.first().getByRole("button", { name: /拖动排序/ });
  await keyHandle.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  await page.keyboard.press("Space");
  await expect(rows.first()).toHaveAttribute("data-model-id", "draft-c");
  expect(writes).toBe(0);
  await page.route("**/api/admin/model-config", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "暂时无法保存" } }),
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("草稿仍保留");
  await expect(rows.first()).toHaveAttribute("data-model-id", "draft-c");
  await page.unroute("**/api/admin/model-config");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByText("已同步", { exact: true })).toBeVisible();
  expect(writes).toBe(2);
  const saved = await (await request.get("/api/admin/model-config")).json();
  expect(saved.items.map((p: any) => p.id)).toEqual([
    "draft-c",
    "draft-b",
    "draft-a",
  ]);
  expect(saved.items[2].enabled).toBe(false);
  await page
    .getByRole("button", { name: "模型配置已保存", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await rows.first().getByRole("button", { name: "下移", exact: true }).click();
  await expect(rows.first()).toHaveAttribute("data-model-id", "draft-b");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.locator("main").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: ".impeccable/review/models-draft-mobile.png",
    fullPage: true,
  });
  await page.locator("main").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.screenshot({
    path: ".impeccable/review/models-draft-mobile-bottom.png",
    fullPage: true,
  });
  await expect(
    rows.last().getByRole("button", { name: "删除", exact: true }),
  ).toBeInViewport();
  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "放弃更改", exact: true }).click();
  await expect(page.getByText("已同步", { exact: true })).toBeVisible();
  await expect(rows.first()).toHaveAttribute("data-model-id", "draft-c");
  const latest = await (await request.get("/api/admin/model-config")).json();
  await request.put("/api/admin/model-config", {
    data: { expectedVersion: latest.version, items: before.items },
  });
});

test("touch grip sorts while the rest of the card remains scrollable", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    baseURL: "http://127.0.0.1:5173",
  });
  const page = await context.newPage();
  await page.route("**/api/admin/model-config", (route) =>
    route.fulfill({
      json: {
        version: "test",
        items: ["touch-a", "touch-b"].map((id) => ({
          id,
          name: id,
          model: id,
          kind: "cloudflare_ai",
          enabled: true,
          params: null,
          apiKeySecret: null,
          baseUrl: null,
          updatedAt: "2026-11-03T00:00:00Z",
        })),
      },
    }),
  );
  await page.goto("/#/settings");
  await page.getByRole("button", { name: "模型服务", exact: true }).click();
  const rows = page.locator("[data-model-id]");
  await expect(rows).toHaveCount(2);
  await page.locator("main").evaluate((el) => {
    el.scrollTop = 350;
  });
  const first = (await rows
    .first()
    .getByRole("button", { name: /拖动排序/ })
    .boundingBox())!;
  const second = (await rows.last().boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const x = first.x + first.width / 2,
    y = first.y + first.height / 2;
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest("button")
          ?.getAttribute("aria-label"),
      { x, y },
    ),
  ).toContain("拖动排序");
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x, y: y + ((second.y + second.height / 2 - y) * i) / 12 },
      ],
    });
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(100);
  await page.screenshot({
    path: ".impeccable/review/touch-during.png",
    fullPage: true,
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(rows.first()).toHaveAttribute("data-model-id", "touch-b");
  await page.waitForTimeout(350);
  await page.screenshot({
    path: ".impeccable/review/models-touch.png",
    fullPage: true,
  });
  await context.close();
});
