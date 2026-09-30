import {
  _electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { access, mkdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { resolve } from "node:path";
import { redPng, textDocx, textPdf } from "../media-fixtures";

const origin = "http://127.0.0.1:18439";
const sentinel = "desktop-test-key-never-use-for-model-requests";
const password = "desktop-test-password-123";

async function portIsFree(): Promise<boolean> {
  return new Promise((done, reject) => {
    const socket = connect({ host: "127.0.0.1", port: 18439 });
    socket.once("connect", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") done(true);
      else reject(error);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error("无法确认桌面服务端口状态。"));
    });
  });
}

type RunningDesktop = { application: ElectronApplication; page: Page };
interface DesktopHarness {
  launch: () => Promise<RunningDesktop>;
  close: (running: RunningDesktop) => Promise<void>;
  screenshot: (page: Page, name: string) => Promise<void>;
}
const test = base.extend<{ desktop: DesktopHarness }>({
  desktop: async ({}, use, testInfo) => {
    const profile = testInfo.outputPath("profile");
    await mkdir(profile, { recursive: true });
    const running = new Set<RunningDesktop>();
    const applications = new Set<ElectronApplication>();
    let modelRequests = 0;
    const rendererErrors: string[] = [];
    const screenshot = async (page: Page, name: string) => {
      const path = testInfo.outputPath(`${name}.png`);
      const application = [...applications].find((app) =>
        app.windows().includes(page),
      );
      if (!application) throw new Error("找不到截图页面所属的桌面应用。");
      const window = await application.browserWindow(page);
      try {
        await window.evaluate((target) =>
          target.webContents.setBackgroundThrottling(false),
        );
        await page.evaluate(
          () =>
            new Promise<void>((resolvePainted) => {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolvePainted()),
              );
            }),
        );
        const png = await window.evaluate(async (target) => {
          const capture = await target.webContents.capturePage(undefined, {
            stayHidden: true,
            stayAwake: true,
          });
          if (capture.isEmpty()) throw new Error("桌面窗口返回了空截图。");
          return capture.toPNG().toString("base64");
        });
        await writeFile(path, Buffer.from(png, "base64"));
      } finally {
        await window.dispose();
      }
      await testInfo.attach(name, { path, contentType: "image/png" });
    };
    const close = async (instance: RunningDesktop) => {
      await instance.application.close();
      running.delete(instance);
      applications.delete(instance.application);
      await expect
        .poll(portIsFree, { message: "退出桌面应用后必须释放 18439 端口" })
        .toBe(true);
    };
    const launch = async () => {
      await expect
        .poll(portIsFree, {
          message: "桌面测试需要独占 18439 端口，请先关闭其他桌面实例",
        })
        .toBe(true);
      const executablePath = process.env.QWEN_DESKTOP_EXECUTABLE
        ? resolve(process.env.QWEN_DESKTOP_EXECUTABLE)
        : undefined;
      const entry = resolve("desktop-dist/main.mjs");
      await access(executablePath || entry);
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      for (const name of Object.keys(env))
        if (
          ["electron_run_as_node", "qianwen_api_key", "qwen_base_url"].includes(
            name.toLowerCase(),
          )
        )
          delete env[name];
      const application = await _electron.launch({
        executablePath,
        args: [
          ...(executablePath ? [] : [process.cwd()]),
          "--use-fake-device-for-media-stream",
        ],
        cwd: process.cwd(),
        chromiumSandbox: true,
        env: {
          ...env,
          QWEN_DESKTOP_USER_DATA: profile,
          QWEN_DESKTOP_TEST_HIDE: "1",
          Qianwen_api_key: sentinel,
          QWEN_BASE_URL: "http://127.0.0.1:1/compatible-mode/v1",
        },
        timeout: 45_000,
      });
      applications.add(application);
      // No model request is allowed in desktop acceptance tests, including failures.
      await application
        .context()
        .route(
          /\/api\/(chat|audio\/speech|audio\/transcriptions)(?:\?|$)/,
          (route) => {
            modelRequests++;
            return route.abort("blockedbyclient");
          },
        );
      const page = await application.firstWindow();
      const instance = { application, page };
      running.add(instance);
      page.on("pageerror", (error) => rendererErrors.push(error.message));
      await page.waitForURL(`${origin}/`);
      await expect(page.getByTestId("message-input")).toBeEnabled();
      await expect(page.locator(".workspace-loading")).toHaveCount(0);
      return instance;
    };
    try {
      await use({ launch, close, screenshot });
    } finally {
      for (const instance of running) {
        if (
          testInfo.status !== testInfo.expectedStatus &&
          !instance.page.isClosed()
        )
          await screenshot(instance.page, "desktop-failure").catch(
            () => undefined,
          );
      }
      for (const application of applications)
        if (application.process().exitCode === null)
          await application.close().catch(() => undefined);
      await expect.poll(portIsFree).toBe(true);
      expect(modelRequests, "桌面验收不得消费模型 API").toBe(0);
      expect(rendererErrors, "桌面渲染进程不能出现未捕获异常").toEqual([]);
    }
  },
});

async function requestMedia(page: Page, constraints: MediaStreamConstraints) {
  return page.evaluate(async (requested) => {
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia(requested);
      return {
        allowed: true,
        kinds: stream.getTracks().map((track) => track.kind),
        error: "",
      };
    } catch (error) {
      return {
        allowed: false,
        kinds: [],
        error: error instanceof DOMException ? error.name : String(error),
      };
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  }, constraints);
}

async function accountPanel(page: Page) {
  const panel = page.getByTestId("account-panel");
  if ((await panel.getAttribute("open")) === null)
    await panel.locator("summary").click();
  await expect(panel.locator(".account-panel")).toBeVisible();
  return panel;
}
async function verifySandbox(application: ElectronApplication) {
  const renderers = await application.evaluate(({ app, BrowserWindow }) => {
    const metrics = app.getAppMetrics();
    return BrowserWindow.getAllWindows().map((window) => ({
      pid: window.webContents.getOSProcessId(),
      sandboxed: metrics.find(
        (item) => item.pid === window.webContents.getOSProcessId(),
      )?.sandboxed,
    }));
  });
  expect(renderers.length).toBeGreaterThan(0);
  for (const renderer of renderers) {
    expect(renderer.pid).toBeGreaterThan(0);
    expect(
      renderer.sandboxed,
      "Windows renderer 必须实际运行在 OS 沙箱中",
    ).toBe(true);
  }
}

test("desktop starts sandboxed, keeps credentials outside the renderer, rejects outside requests and releases its port", async ({
  desktop,
}) => {
  const running = await desktop.launch();
  const { application, page } = running;
  await verifySandbox(application);
  const renderer = await page.evaluate(async () => {
    const global = window as unknown as Record<string, unknown>;
    const response = await fetch("/api/health");
    return {
      process: typeof global.process,
      require: typeof global.require,
      Buffer: typeof global.Buffer,
      healthStatus: response.status,
      health: await response.json(),
      html: document.documentElement.outerHTML,
      storage: JSON.stringify(localStorage),
    };
  });
  expect(renderer.process).toBe("undefined");
  expect(renderer.require).toBe("undefined");
  expect(renderer.Buffer).toBe("undefined");
  expect(renderer.healthStatus).toBe(200);
  expect(JSON.stringify(renderer)).not.toContain(sentinel);
  expect(Object.keys(renderer.health).join(" ")).not.toMatch(/api.?key|token/i);
  for (const path of ["/", "/api/health", "/api/account/session"])
    expect((await fetch(`${origin}${path}`)).status).toBe(403);
  expect(
    (
      await fetch(`${origin}/api/health`, {
        headers: { "X-Qianwen-Desktop-Token": "invalid-token" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${origin}/api/runs/test-run/cancel`, {
        method: "POST",
        headers: { "X-Qianwen-Client": "web", "X-Qianwen-Account": "guest" },
      })
    ).status,
  ).toBe(403);
  await desktop.screenshot(page, "desktop-welcome");
  await desktop.close(running);
});

test("real account, draft, uploaded PNG and parsed PDF/DOCX survive desktop restarts", async ({
  desktop,
}) => {
  let running = await desktop.launch();
  let page = running.page;
  const username = `desktop_${Date.now()}`;
  await page.getByTestId("message-input").fill("访客草稿：重启后仍然保留");
  let panel = await accountPanel(page);
  await panel.getByRole("button", { name: "创建账号", exact: true }).click();
  await panel.getByLabel("用户名", { exact: true }).fill(username);
  await panel.getByLabel("密码", { exact: true }).fill(password);
  await panel.getByRole("button", { name: "注册并登录", exact: true }).click();
  await expect(panel.locator(".account-identity")).toContainText(username);
  await page.getByRole("button", { name: "关闭账号面板" }).click();
  await expect(page.getByTestId("message-input")).toHaveValue("");
  await page.getByTestId("message-input").fill("账户草稿：请一起分析这些文件");
  await page.getByTestId("attachment-input").setInputFiles([
    { name: "桌面测试红色图片.png", mimeType: "image/png", buffer: redPng() },
    {
      name: "桌面测试资料.pdf",
      mimeType: "application/pdf",
      buffer: textPdf("DESKTOP_PDF_PARSED_7421"),
    },
    {
      name: "桌面测试说明.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: textDocx("DESKTOP_DOCX_PARSED_9357"),
    },
  ]);
  await expect(page.getByTestId("attachment-transfer")).toHaveCount(0);
  await expect(page.getByTestId("attachment-card")).toHaveCount(3);
  await expect(
    page.getByTestId("attachment-card").filter({ hasText: "桌面测试资料.pdf" }),
  ).toContainText("DESKTOP_PDF_PARSED_7421");
  await expect(
    page
      .getByTestId("attachment-card")
      .filter({ hasText: "桌面测试说明.docx" }),
  ).toContainText("DESKTOP_DOCX_PARSED_9357");
  expect(
    await page
      .getByAltText("桌面测试红色图片.png", { exact: true })
      .evaluate(
        (image: HTMLImageElement) =>
          image.complete && image.naturalWidth === 64,
      ),
  ).toBe(true);
  panel = await accountPanel(page);
  await panel
    .getByRole("button", { name: "上传本机会话", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "确认覆盖账户副本", exact: true })
    .click();
  await expect(panel.locator(".account-preview")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭账号面板" }).click();
  await desktop.screenshot(page, "desktop-real-documents");
  await desktop.close(running);

  running = await desktop.launch();
  page = running.page;
  await expect(page.getByTestId("message-input")).toHaveValue(
    "账户草稿：请一起分析这些文件",
  );
  await expect(page.getByTestId("attachment-card")).toHaveCount(3);
  await expect(
    page.getByTestId("account-panel").locator("summary"),
  ).toContainText(username);
  panel = await accountPanel(page);
  await panel
    .getByRole("button", { name: "下载账户会话", exact: true })
    .click();
  await expect(panel.locator(".account-preview")).toContainText("账户版本 1");
  await page.getByRole("button", { name: "关闭账号面板" }).click();
  panel = await accountPanel(page);
  await panel.getByRole("button", { name: "退出", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "登录", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "关闭账号面板" }).click();
  await expect(page.getByTestId("message-input")).toHaveValue(
    "访客草稿：重启后仍然保留",
  );
  await expect(page.getByTestId("attachment-card")).toHaveCount(0);
  await desktop.close(running);
  running = await desktop.launch();
  await expect(running.page.getByTestId("message-input")).toHaveValue(
    "访客草稿：重启后仍然保留",
  );
  await desktop.close(running);
});

test("only the main application can record audio and camera access is denied", async ({
  desktop,
}) => {
  const { page } = await desktop.launch();
  expect(await requestMedia(page, { audio: true })).toEqual({
    allowed: true,
    kinds: ["audio"],
    error: "",
  });
  expect(await requestMedia(page, { video: true })).toEqual({
    allowed: false,
    kinds: [],
    error: "NotAllowedError",
  });
  await page.getByRole("button", { name: "开始语音输入", exact: true }).click();
  await expect(page.getByTestId("voice-recorder")).toContainText("录音");
  await page.getByRole("button", { name: "取消语音输入", exact: true }).click();
  await expect(page.getByTestId("voice-recorder")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "开始语音输入", exact: true }),
  ).toBeEnabled();
});

test("images open in a sandboxed owned preview and external links cannot navigate the app", async ({
  desktop,
}) => {
  const { application, page } = await desktop.launch();
  await page.getByTestId("attachment-input").setInputFiles({
    name: "预览验证.png",
    mimeType: "image/png",
    buffer: redPng(),
  });
  const previewLink = page.getByRole("link", {
    name: "查看图片：预览验证.png",
  });
  await expect(previewLink).toBeVisible();
  const previewOpened = application.waitForEvent("window");
  await previewLink.click();
  const preview = await previewOpened;
  await expect(preview).toHaveURL(
    new RegExp(
      `^${origin.replaceAll(".", "\\.")}/api/attachments/[\\w-]+/content$`,
    ),
  );
  await expect(preview.locator("img")).toBeVisible();
  const previewWindow = await application.browserWindow(preview);
  await expect
    .poll(() => previewWindow.evaluate((window) => window.getTitle()))
    .toBe("图片预览 · QianwenChat");
  await verifySandbox(application);
  expect(await requestMedia(preview, { audio: true })).toEqual({
    allowed: false,
    kinds: [],
    error: "NotAllowedError",
  });
  await desktop.screenshot(preview, "desktop-image-preview");
  await preview.close();
  await expect(page.getByTestId("message-input")).toBeEnabled();
  await application.evaluate(({ shell }) => {
    const state = globalThis as unknown as {
      desktopTestExternalLinks: string[];
    };
    state.desktopTestExternalLinks = [];
    shell.openExternal = async (url: string) => {
      state.desktopTestExternalLinks.push(url);
    };
  });
  await page.evaluate(() => {
    window.open("https://example.com/desktop-acceptance", "_blank");
  });
  await expect
    .poll(() =>
      application.evaluate(
        () =>
          (globalThis as unknown as { desktopTestExternalLinks: string[] })
            .desktopTestExternalLinks,
      ),
    )
    .toEqual(["https://example.com/desktop-acceptance"]);
  await page.evaluate(() => {
    window.open("file:///C:/Windows/win.ini", "_blank");
  });
  expect(
    await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);
  expect(
    await application.evaluate(
      () =>
        (globalThis as unknown as { desktopTestExternalLinks: string[] })
          .desktopTestExternalLinks,
    ),
  ).toEqual(["https://example.com/desktop-acceptance"]);
  await expect(page).toHaveURL(`${origin}/`);
});
