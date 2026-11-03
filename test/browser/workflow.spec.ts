import { test, expect } from "@playwright/test";
test.beforeAll(async ({ request }) => {
  const health = await (await request.get("/api/health")).json();
  if (health.env !== "development")
    throw new Error(
      "Browser mutation tests require an isolated development service",
    );
  const providers = await (
    await request.get("/api/admin/llm-providers")
  ).json();
  for (const p of providers.items)
    await request.delete("/api/admin/llm-providers/" + p.id);
});
test("create work, inspect candidates and responsive navigation", async ({
  page,
  request,
}) => {
  const suffix = Date.now();
  const term = await request.post("/api/terms", {
    data: {
      name: `测试学期 ${suffix}`,
      startDate: "2026-11-02",
      weekCount: 4,
      periods: [{ periodIndex: 1, startTime: "08:00", endTime: "09:00" }],
    },
  });
  expect(term.ok()).toBeTruthy();
  const org = await (
    await request.post("/api/orgs", {
      data: { name: `测试部门 ${suffix}`, kind: "department" },
    })
  ).json();
  await request.post("/api/persons/import", {
    data: {
      orgId: org.id,
      items: [
        { fullName: "测试人员甲", studentNo: `${suffix}1` },
        { fullName: "测试人员乙", studentNo: `${suffix}2` },
      ],
    },
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "安排工作", exact: true })
    .first()
    .click();
  const panel = page.getByRole("dialog");
  await panel.getByPlaceholder("例如：迎新咨询值班").fill(`测试值班 ${suffix}`);
  await panel.locator("select").first().selectOption(org.id);
  await panel.locator("input[type=date]").fill("2026-11-03");
  await panel.getByRole("button", { name: "创建班次并开始排班" }).click();
  await expect(panel).not.toBeVisible();
  await page.getByLabel("部门", { exact: true }).selectOption(org.id);
  await expect(
    page.getByText(`测试值班 ${suffix}`, { exact: true }).first(),
  ).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: ".impeccable/review/desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "查看与安排" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("测试人员甲", { exact: true })).toBeVisible();
  await page.screenshot({
    path: ".impeccable/review/candidates.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "确认分配", exact: true }).click();
  await expect(page.getByRole("button", { name: "撤销分配" })).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).first().click();
  await page.getByText("已分配给选中的候选", { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: ".impeccable/review/mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.goto("/#/settings");
  await page.getByRole("button", { name: "模型服务", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "模型服务", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("连接第一个模型", { exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: ".impeccable/review/models-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: ".impeccable/review/models-desktop.png",
    fullPage: true,
  });
});

test("nested dialogs keep keyboard ownership and focus", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "安排工作", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "补充人员或部门" }).click();
  await page.getByRole("button", { name: "新建人员", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "安排工作", exact: true }),
  ).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "安排工作", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "新建人员", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("catalog selection, encrypted key and model priority", async ({
  page,
  request,
}) => {
  await page.route("**/api/admin/model-catalog", (route) =>
    route.fulfill({
      json: {
        fetchedAt: "2026-11-03T00:00:00Z",
        stale: false,
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            kind: "openai_compatible",
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-fixture-a",
                name: "Fixture A",
                vision: true,
                context: 128000,
              },
              {
                id: "gpt-fixture-b",
                name: "Fixture B",
                vision: true,
                context: 128000,
              },
            ],
          },
        ],
      },
    }),
  );
  await page.goto("/#/settings");
  await page.getByRole("button", { name: "模型服务", exact: true }).click();
  await page
    .getByRole("button", { name: "添加供应商", exact: true })
    .first()
    .click();
  await page.getByLabel("供应商", { exact: true }).selectOption("openai");
  await page
    .getByLabel("API 密钥", { exact: true })
    .fill("test-only-not-a-real-key");
  const choices = page.locator("input[type=checkbox]");
  await choices.nth(1).check();
  await choices.nth(2).check();
  await page.getByRole("button", { name: "加入 2 个模型" }).click();
  await expect(page.getByText("密钥待保存").first()).toBeVisible();
  expect(
    (await (await request.get("/api/admin/llm-providers")).json()).items,
  ).toHaveLength(0);
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(
    page.getByText("密钥已加密", { exact: false }).first(),
  ).toBeVisible();
  const models = await (await request.get("/api/admin/llm-providers")).json();
  expect(JSON.stringify(models)).not.toContain("test-only-not-a-real-key");
  await page.getByRole("button", { name: "下移", exact: true }).first().click();
  await expect(page.getByText("有未保存更改", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByText("已同步", { exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/admin/model-order")).json()).ids.length,
    )
    .toBe(2);

  const successToasts = page.getByRole("button", {
    name: "模型配置已保存",
    exact: true,
  });
  while (await successToasts.count()) await successToasts.first().click();
  await page.getByRole("button", { name: "切换明暗主题" }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: ".impeccable/review/models-populated-dark.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: ".impeccable/review/models-populated-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  for (const p of models.items)
    await request.delete("/api/admin/llm-providers/" + p.id);
});
