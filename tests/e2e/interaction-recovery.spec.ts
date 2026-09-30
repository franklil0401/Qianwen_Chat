import { expect, test } from "@playwright/test";

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});
test.beforeEach(async ({ page }) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: { configured: true, model: "qwen-plus", tools: [] },
    }),
  );
});

test("switching composer during Chinese composition does not lock Enter and shortcuts", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/chat", async (route) => {
    requests++;
    const { runId, conversationId, messageId } = route.request().postDataJSON();
    await route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ runId, conversationId, messageId, type: "done", reason: "stop" })}\n\n`,
    });
  });
  await page.goto("/");
  const input = page.getByTestId("message-input");
  await input.fill("尚未完成的中文");
  await input.dispatchEvent("compositionstart");
  await page.getByRole("button", { name: "开启新对话", exact: true }).click();
  await expect(input).toBeFocused();
  await input.fill("新会话可以发送");
  await input.press("Enter");
  await expect.poll(() => requests).toBe(1);
  await expect(input).toHaveValue("");
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("assistant-message")).toHaveCount(0);
  await expect(input).toBeFocused();
});

test("a successful transcription can be inserted after shortening a full draft without another API request", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["microphone"]);
  let requests = 0;
  await page.route("**/api/audio/transcriptions", (route) => {
    requests++;
    return route.fulfill(
      requests === 1
        ? { json: { text: "已经识别成功的语音内容" } }
        : { status: 503, json: { error: "后续请求不可用" } },
    );
  });
  await page.goto("/");
  const input = page.getByTestId("message-input");
  await input.fill("字".repeat(15998));
  await page.getByRole("button", { name: "开始语音输入" }).click();
  await expect(page.getByTestId("voice-recorder")).toContainText("录音");
  await page.waitForTimeout(400); // Real fake-device audio needs one recording chunk.
  await page.getByRole("button", { name: "结束录音" }).click();
  await expect(page.getByLabel("录音预览")).toBeVisible();
  const insert = page.getByRole("button", {
    name: /^(转成文字|填入已识别文字)$/,
  });
  await insert.click();
  await expect(page.getByRole("alert")).toContainText("16,000");
  await expect(input).toHaveValue("字".repeat(15998));
  await input.fill("保留的草稿");
  await insert.click();
  await expect(input).toHaveValue("保留的草稿\n已经识别成功的语音内容");
  expect(requests).toBe(1);
  await expect(
    page.getByRole("button", { name: "开始语音输入" }),
  ).toBeEnabled();
});
