import { expect, test, type Page } from "@playwright/test";

const guestState = (draft: string) => ({
  version: 1,
  activeId: "guest-chat",
  useTools: true,
  thinking: false,
  conversations: [
    {
      id: "guest-chat",
      title: "访客保留会话",
      updatedAt: 1,
      messages: [],
      draft: { text: draft, sources: [] },
    },
  ],
});
const password = "account-e2e-pass-123";
async function seedGuest(page: Page, draft: string) {
  await page.addInitScript((state) => {
    if (!localStorage.getItem("qianwen-workspace-v1"))
      localStorage.setItem("qianwen-workspace-v1", JSON.stringify(state));
  }, guestState(draft));
}
async function openPanel(page: Page) {
  const details = page.getByTestId("account-panel");
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").click();
  await expect(details.locator(".account-panel")).toBeVisible();
  return details;
}
async function login(page: Page, username: string, register = false) {
  const panel = await openPanel(page);
  await expect(
    panel.getByRole("button", { name: "创建账号", exact: true }),
  ).toBeEnabled();
  if (register)
    await panel.getByRole("button", { name: "创建账号", exact: true }).click();
  await panel.getByLabel("用户名", { exact: true }).fill(username);
  await panel.getByLabel("密码", { exact: true }).fill(password);
  await panel
    .getByRole("button", {
      name: register ? "注册并登录" : "登录",
      exact: true,
    })
    .click();
  await expect(panel.locator(".account-identity")).toContainText(username);
  await expect(
    panel.getByRole("button", { name: "上传本机会话", exact: true }),
  ).toBeEnabled();
}
async function closePanel(page: Page) {
  await page.getByRole("button", { name: "关闭账号面板" }).click();
}
async function previewUpload(page: Page) {
  const panel = await openPanel(page);
  await panel
    .getByRole("button", { name: "上传本机会话", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "确认覆盖账户副本" }),
  ).toBeEnabled();
  return panel;
}

test("real accounts isolate guest drafts, synchronize across browsers, and reject stale uploads", async ({
  page,
  browser,
  baseURL,
}) => {
  const username = `sync_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const another = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 },
  });
  const second = await another.newPage();
  let modelCalls = 0;
  for (const tab of [page, second])
    await tab.route("**/api/chat", (route) => {
      modelCalls++;
      return route.abort();
    });
  try {
    await seedGuest(page, "访客草稿不能丢失");
    await seedGuest(second, "第二浏览器访客草稿");
    await page.goto("/");
    await expect(page.getByTestId("message-input")).toHaveValue(
      "访客草稿不能丢失",
    );
    await login(page, username, true);
    await closePanel(page);
    await expect(page.getByTestId("message-input")).toHaveValue("");
    await page.getByTestId("message-input").fill("账号会话从第一台浏览器上传");
    let panel = await previewUpload(page);
    await expect(panel.locator(".account-preview")).toContainText(
      "尚无账户副本",
    );
    await panel.getByRole("button", { name: "确认覆盖账户副本" }).click();
    await expect(panel.locator(".account-preview")).toHaveCount(0);
    const session = await (
      await page.request.get("/api/account/session")
    ).json();
    const firstSnapshot = await (
      await page.request.get("/api/account/workspace", {
        headers: { "X-Qianwen-Account": session.user.id },
      })
    ).json();
    expect(firstSnapshot.revision).toBe(1);
    expect(
      firstSnapshot.state.conversations.some(
        (item: { draft?: { text: string } }) =>
          item.draft?.text === "访客草稿不能丢失",
      ),
    ).toBe(false);

    await second.goto("/");
    await login(second, username);
    let otherPanel = await openPanel(second);
    await otherPanel
      .getByRole("button", { name: "下载账户会话", exact: true })
      .click();
    await expect(otherPanel.locator(".account-preview")).toContainText(
      "账户版本 1",
    );
    await otherPanel.getByLabel("替换此账号的本机会话及草稿").check();
    await otherPanel.getByRole("button", { name: "确认替换本机会话" }).click();
    await expect(otherPanel.locator(".account-preview")).toHaveCount(0);
    await closePanel(second);
    await expect(second.getByTestId("message-input")).toHaveValue(
      "账号会话从第一台浏览器上传",
    );

    panel = await previewUpload(page);
    await expect(panel.locator(".account-preview")).toContainText("账户版本 1");
    await second.getByTestId("message-input").fill("来自第二台浏览器的新草稿");
    otherPanel = await previewUpload(second);
    await otherPanel.getByRole("button", { name: "确认覆盖账户副本" }).click();
    await expect(otherPanel.locator(".account-preview")).toHaveCount(0);
    await panel.getByRole("button", { name: "确认覆盖账户副本" }).click();
    await expect(panel.locator(".account-error")).toContainText(
      "已被其他页面更新",
    );
    await expect(
      panel.getByRole("button", { name: "确认覆盖账户副本" }),
    ).toBeDisabled();
    const afterConflict = await (
      await page.request.get("/api/account/workspace", {
        headers: { "X-Qianwen-Account": session.user.id },
      })
    ).json();
    expect(afterConflict.revision).toBe(2);
    expect(afterConflict.state.conversations[0].draft.text).toBe(
      "来自第二台浏览器的新草稿",
    );
    await panel.getByRole("button", { name: "刷新预览", exact: true }).click();
    await expect(panel.locator(".account-preview")).toContainText("账户版本 2");
    await expect(
      panel.getByRole("button", { name: "确认覆盖账户副本" }),
    ).toBeEnabled();
    await closePanel(page);

    panel = await openPanel(page);
    await panel.getByRole("button", { name: "退出", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "登录", exact: true }),
    ).toBeEnabled();
    await closePanel(page);
    await expect(page.getByTestId("message-input")).toHaveValue(
      "访客草稿不能丢失",
    );
    await login(page, username);
    await closePanel(page);
    await expect(page.getByTestId("message-input")).toHaveValue(
      "账号会话从第一台浏览器上传",
    );
    expect(modelCalls).toBe(0);
  } finally {
    await another.close();
  }
});

test("account forms and sync confirmations remain reachable at a short desktop height", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 520 });
  await page.route("**/api/chat", (route) => route.abort());
  await page.goto("/");
  const panel = await openPanel(page);
  await panel.getByRole("button", { name: "创建账号", exact: true }).click();
  await panel.getByLabel("用户名", { exact: true }).fill(`short_${Date.now()}`);
  await panel.getByLabel("密码", { exact: true }).fill(password);
  await panel.getByRole("button", { name: "注册并登录", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "上传本机会话" }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: "上传本机会话" }).click();
  const confirm = panel.getByRole("button", { name: "确认覆盖账户副本" });
  await confirm.scrollIntoViewIfNeeded();
  await expect(confirm).toBeInViewport();
  const bounds = await panel.locator(".account-panel").boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(520);
  await confirm.click();
  await expect(panel.locator(".account-preview")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panel).not.toHaveAttribute("open", "");
  await openPanel(page);
  await expect(panel.locator(".account-identity")).toBeVisible();
});

test("a login changed in another tab cannot upload the displayed account's workspace to the new account", async ({
  page,
}) => {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const firstUser = `first_${suffix}`,
    secondUser = `other_${suffix}`;
  await page.route("**/api/chat", (route) => route.abort());
  await page.goto("/");
  await login(page, firstUser, true);
  await closePanel(page);
  await page.getByTestId("message-input").fill("只属于第一个账号的草稿");
  const changed = await page.request.post("/api/account/register", {
    headers: { "X-Qianwen-Client": "web" },
    data: { username: secondUser, password },
  });
  expect(changed.status()).toBe(201);
  const secondSession = await changed.json();
  // The browser cookie changed while the first account remains displayed in this tab.
  const panel = await openPanel(page);
  await panel
    .getByRole("button", { name: "上传本机会话", exact: true })
    .click();
  await expect(panel.locator(".account-identity")).toContainText(secondUser);
  await expect(panel.locator(".account-error")).toContainText("登录账号已变化");
  await expect(panel.locator(".account-preview")).toHaveCount(0);
  const remote = await (
    await page.request.get("/api/account/workspace", {
      headers: { "X-Qianwen-Account": secondSession.user.id },
    })
  ).json();
  expect(remote.state).toBeNull();
  expect(remote.revision).toBe(0);
  await closePanel(page);
  await expect(page.getByTestId("message-input")).toHaveValue("");
  await openPanel(page);
  await panel.getByRole("button", { name: "退出", exact: true }).click();
  await login(page, firstUser);
  await closePanel(page);
  await expect(page.getByTestId("message-input")).toHaveValue(
    "只属于第一个账号的草稿",
  );
});
