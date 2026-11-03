import { test, expect } from "@playwright/test";
test("connectivity tests are concurrent, card-local and do not block editing or saving", async ({
  page,
}) => {
  let items = ["alpha", "beta"].map((id) => ({
    id,
    name: id,
    model: id,
    kind: "openai_compatible",
    baseUrl: "https://example.com/v1",
    enabled: true,
    apiKeySecret: null,
    params: { hasKey: true },
    updatedAt: "2026-11-03T00:00:00Z",
  }));
  await page.route("**/api/admin/model-config", async (route) => {
    if (route.request().method() === "PUT")
      items = route.request().postDataJSON().items;
    await route.fulfill({ json: { version: "fixture", items } });
  });
  await page.route("**/api/admin/model-catalog", (route) =>
    route.fulfill({
      json: {
        fetchedAt: new Date().toISOString(),
        stale: false,
        providers: [],
      },
    }),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route("**/api/admin/llm-providers/alpha/test", async (route) => {
    started = true;
    await gate;
    await route.fulfill({
      json: {
        ok: false,
        message: "请求被拒绝",
        status: 400,
        code: "unsupported_parameter",
        type: "invalid_request_error",
        details: JSON.stringify({
          error: {
            code: "unsupported_parameter",
            message: "full diagnostic ".repeat(100),
          },
        }),
      },
    });
  });
  await page.route("**/api/admin/llm-providers/beta/test", (route) =>
    route.fulfill({ json: { ok: true, message: "pong" } }),
  );
  await page.goto("/#/settings");
  await page.getByRole("button", { name: "模型服务", exact: true }).click();
  const alpha = page.locator('[data-model-id="alpha"]'),
    beta = page.locator('[data-model-id="beta"]');
  await alpha.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await beta.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(beta.getByText("连接成功", { exact: true })).toBeVisible();
  await alpha.getByLabel("启用", { exact: true }).uncheck();
  await alpha.getByRole("button", { name: "下移", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "添加供应商", exact: true }).first(),
  ).toBeEnabled();
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByText("已同步", { exact: true })).toBeVisible();
  await expect(alpha.getByRole("button", { name: /测试中/ })).toBeVisible();
  release();
  await expect(alpha.getByText("连接失败", { exact: true })).toBeVisible();
  await expect(alpha).toContainText("HTTP 400");
  await expect(alpha).toContainText("unsupported_parameter");
  expect((await alpha.locator("pre").textContent())!.length).toBeGreaterThan(
    1000,
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(beta.getByText("连接成功", { exact: true })).toBeVisible();
  const toasts = page.getByRole("button", {
    name: "模型配置已保存",
    exact: true,
  });
  while (await toasts.count()) await toasts.first().click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".impeccable/review/model-tests-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("main").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.screenshot({
    path: ".impeccable/review/model-tests-mobile.png",
    fullPage: true,
  });
  await alpha.evaluate((el) => {
    const main = document.querySelector("main")!;
    main.scrollTop += el.getBoundingClientRect().top - 80;
  });
  await page.screenshot({
    path: ".impeccable/review/model-tests-mobile-card.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
