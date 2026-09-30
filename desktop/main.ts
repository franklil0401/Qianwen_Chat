import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  session,
  shell,
  type Session,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { createApp as createAppType } from "../server/app.ts";
import {
  allowDesktopPermission,
  classifyWindowTarget,
  desktopErrorCode,
  desktopRequestHeaders,
  DESKTOP_APP_ID,
  DESKTOP_ORIGIN,
  DESKTOP_PARTITION,
  DESKTOP_PORT,
  isAppNavigation,
  isImagePreview,
  startupFailureMessage,
} from "./security";

const hiddenForTesting = process.env.QWEN_DESKTOP_TEST_HIDE === "1";
const token = randomBytes(32).toString("base64url");
const trustedWindows = new Set<number>();
const previews = new Map<string, BrowserWindow>();
let mainWindow: BrowserWindow | null = null;
let browserSession: Session | undefined;
let httpServer: Server | undefined;
let disposeService: (() => void | Promise<void>) | undefined;
let userDataDirectory = "";
let logFile = "";
let quitAllowed = false;
let shutdownPromise: Promise<void> | undefined;
let serviceStopPromise: Promise<void> | undefined;
let fatalStarted = false;

function log(event: string, error?: unknown) {
  const line = `${new Date().toISOString()} ${event}${error === undefined ? "" : ` code=${desktopErrorCode(error)}`}\n`;
  if (logFile) {
    try {
      appendFileSync(logFile, line, "utf8");
    } catch {
      /* Logging cannot prevent exit. */
    }
  }
  if (error !== undefined)
    process.stderr.write(
      `[QianwenChat] ${event}: ${desktopErrorCode(error)}\n`,
    );
}

function closePreviews() {
  for (const window of previews.values())
    if (!window.isDestroyed()) window.close();
}
function windowPreferences() {
  return {
    session: browserSession,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    devTools: !app.isPackaged,
    spellcheck: false,
  };
}
function registerWindow(window: BrowserWindow) {
  const id = window.webContents.id;
  trustedWindows.add(id);
  window.once("closed", () => trustedWindows.delete(id));
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) event.preventDefault();
  });
}

async function openExternal(value: string) {
  try {
    await shell.openExternal(value);
  } catch (error) {
    log("external-open-failed", error);
  }
}
function openPreview(url: string) {
  if (!isImagePreview(url) || !mainWindow || mainWindow.isDestroyed()) return;
  const existing = previews.get(url);
  if (existing && !existing.isDestroyed()) {
    if (!hiddenForTesting) {
      existing.show();
      existing.focus();
    }
    return;
  }
  if (previews.size >= 4) {
    const first = previews.values().next().value;
    first?.close();
  }
  const preview = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 400,
    minHeight: 300,
    parent: mainWindow,
    title: "图片预览 · QianwenChat",
    show: false,
    backgroundColor: "#20212c",
    autoHideMenuBar: true,
    webPreferences: windowPreferences(),
  });
  previews.set(url, preview);
  registerWindow(preview);
  preview.setMenu(null);
  preview.on("page-title-updated", (event) => event.preventDefault());
  preview.webContents.on("will-navigate", (event, destination) => {
    if (destination !== url) event.preventDefault();
  });
  preview.webContents.on("will-redirect", (event, destination) => {
    if (destination !== url) event.preventDefault();
  });
  preview.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  preview.once("closed", () => {
    if (previews.get(url) === preview) previews.delete(url);
  });
  preview.once("ready-to-show", () => {
    if (!hiddenForTesting && !preview.isDestroyed()) preview.show();
  });
  void preview.loadURL(url).catch((error) => {
    log("preview-load-failed", error);
    if (!preview.isDestroyed()) preview.close();
  });
}

function permissionDocument(contents: WebContents | null) {
  return {
    webContentsId: contents?.id,
    mainWindowId:
      mainWindow?.isDestroyed() === false
        ? mainWindow.webContents.id
        : undefined,
    documentUrl: contents?.isDestroyed() === false ? contents.getURL() : "",
  };
}
function configureSession() {
  browserSession = session.fromPartition(DESKTOP_PARTITION);
  browserSession.webRequest.onBeforeSendHeaders(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      callback({
        requestHeaders: desktopRequestHeaders(
          details.requestHeaders,
          details.url,
          details.webContentsId,
          trustedWindows,
          token,
        ),
      });
    },
  );
  browserSession.webRequest.onCompleted(
    { urls: [`${DESKTOP_ORIGIN}/api/account/*`] },
    (details) => {
      if (
        details.method === "POST" &&
        details.statusCode >= 200 &&
        details.statusCode < 300 &&
        /^\/api\/account\/(register|login|logout)$/.test(
          new URL(details.url).pathname,
        )
      )
        closePreviews();
    },
  );
  browserSession.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) =>
      allowDesktopPermission({
        ...permissionDocument(contents),
        permission,
        requestingOrigin,
        isMainFrame: details.isMainFrame,
        mediaType: details.mediaType,
      }),
  );
  browserSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      const mediaTypes =
        "mediaTypes" in details && Array.isArray(details.mediaTypes)
          ? details.mediaTypes
          : undefined;
      const requestingOrigin =
        "securityOrigin" in details &&
        typeof details.securityOrigin === "string"
          ? details.securityOrigin
          : details.requestingUrl;
      callback(
        allowDesktopPermission({
          ...permissionDocument(contents),
          permission,
          requestingOrigin,
          isMainFrame: details.isMainFrame,
          mediaTypes,
        }),
      );
    },
  );
  browserSession.setDevicePermissionHandler(() => false);
  browserSession.setDisplayMediaRequestHandler((_request, callback) =>
    callback({}),
  );
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "应用",
      submenu: [
        {
          label: "重新加载",
          accelerator: "CmdOrCtrl+R",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed())
              mainWindow.webContents.reload();
          },
        },
        {
          label: "打开数据目录",
          click: () => {
            void shell.openPath(userDataDirectory).then((error) => {
              if (error) log("data-directory-open-failed", new Error());
            });
          },
        },
        { type: "separator" },
        { label: "退出", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { role: "resetZoom", label: "实际大小" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "配置说明",
          click: () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            void dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "配置说明",
              message: process.env.Qianwen_api_key?.trim()
                ? "已检测到模型 API 配置"
                : "尚未检测到模型 API 配置",
              detail:
                "模型调用读取 Windows 用户或系统环境变量 Qianwen_api_key。配置或修改后，请退出并重新启动应用。\n\n若从开始菜单启动仍提示未配置，可注销并重新登录 Windows 后再试。\n\n会话、账号与附件保存在当前 Windows 用户的数据目录。桌面版与浏览器版数据独立，可通过会话备份导入导出迁移。",
              buttons: ["知道了"],
            });
          },
        },
        {
          label: "关于 QianwenChat",
          click: () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            void dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "关于 QianwenChat",
              message: `QianwenChat ${app.getVersion()}`,
              detail:
                "面试项目：支持流式输出、打断、工具调用、图片与文档问答、语音及本地账号同步。",
              buttons: ["知道了"],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createMainWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 640,
    title: "QianwenChat",
    show: false,
    backgroundColor: "#f5f5f9",
    webPreferences: windowPreferences(),
  });
  mainWindow = window;
  registerWindow(window);
  window.on("page-title-updated", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler((details) => {
    const destination = classifyWindowTarget(details.url);
    if (destination.kind === "preview") openPreview(destination.url);
    else if (destination.kind === "external")
      void openExternal(destination.url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isAppNavigation(url)) return;
    event.preventDefault();
    const destination = classifyWindowTarget(url);
    if (destination.kind === "preview") openPreview(destination.url);
    else if (destination.kind === "external")
      void openExternal(destination.url);
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isAppNavigation(url)) event.preventDefault();
  });
  window.once("ready-to-show", () => {
    if (!hiddenForTesting && !window.isDestroyed()) window.show();
  });
  window.once("closed", () => {
    mainWindow = null;
    closePreviews();
    app.quit();
  });
  window.on("query-session-end", () => {
    browserSession?.flushStorageData();
    void stopService();
  });
  window.on("session-end", () => {
    void stopService();
  });
  buildMenu();
  await window.loadURL(DESKTOP_ORIGIN);
}

function stopService() {
  if (!serviceStopPromise) {
    const dispose = disposeService;
    disposeService = undefined;
    try {
      serviceStopPromise = Promise.resolve(dispose?.()).catch((error) =>
        log("service-stop-failed", error),
      );
    } catch (error) {
      log("service-stop-failed", error);
      serviceStopPromise = Promise.resolve();
    }
  }
  httpServer?.closeAllConnections();
  return serviceStopPromise;
}
async function closeWindows() {
  const windows = BrowserWindow.getAllWindows();
  await Promise.all(
    windows.map(
      (window) =>
        new Promise<void>((resolveClosed) => {
          if (window.isDestroyed()) {
            resolveClosed();
            return;
          }
          const timer = setTimeout(() => {
            if (!window.isDestroyed()) window.destroy();
            resolveClosed();
          }, 1500);
          window.once("closed", () => {
            clearTimeout(timer);
            resolveClosed();
          });
          window.close();
        }),
    ),
  );
}
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = Promise.resolve().then(async () => {
    await closeWindows();
    browserSession?.flushStorageData();
    if (browserSession) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        browserSession.cookies
          .flushStore()
          .catch((error) => log("cookies-flush-failed", error)),
        new Promise<void>((resolveTimeout) => {
          timer = setTimeout(resolveTimeout, 1500);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    await stopService();
    if (httpServer?.listening)
      await new Promise<void>((resolveClosed) =>
        httpServer!.close(() => resolveClosed()),
      );
    log("shutdown-complete");
  });
  return shutdownPromise;
}

async function fatal(error: unknown) {
  if (fatalStarted) return;
  fatalStarted = true;
  log("startup-or-runtime-failed", error);
  await app.whenReady();
  if (!hiddenForTesting)
    await dialog
      .showMessageBox({
        type: "error",
        title: "QianwenChat 无法启动",
        message: startupFailureMessage(error),
        detail: `错误码：${desktopErrorCode(error)}`,
        buttons: ["退出"],
      })
      .catch(() => undefined);
  await shutdown().catch(() => undefined);
  quitAllowed = true;
  app.exit(1);
}

async function start() {
  app.setName("QianwenChat");
  const overridden = process.env.QWEN_DESKTOP_USER_DATA;
  if (overridden && !isAbsolute(overridden))
    throw Object.assign(new Error(), { code: "EACCES" });
  userDataDirectory = overridden || join(app.getPath("appData"), "QianwenChat");
  const browserData = join(userDataDirectory, "browser");
  mkdirSync(browserData, { recursive: true });
  mkdirSync(join(userDataDirectory, "logs"), { recursive: true });
  logFile = join(userDataDirectory, "logs", "desktop.log");
  app.setPath("userData", userDataDirectory);
  app.setPath("sessionData", browserData);
  if (process.platform === "win32") app.setAppUserModelId(DESKTOP_APP_ID);
  if (!app.requestSingleInstanceLock()) {
    quitAllowed = true;
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed() && !hiddenForTesting) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on("before-quit", (event) => {
    if (quitAllowed) return;
    event.preventDefault();
    if (shutdownPromise) return;
    void shutdown().finally(() => {
      quitAllowed = true;
      app.quit();
    });
  });
  app.on("window-all-closed", () => {
    if (!shutdownPromise && !fatalStarted) app.quit();
  });
  process.on("uncaughtException", (error) => {
    void fatal(error);
  });
  process.on("unhandledRejection", (error) => {
    void fatal(error);
  });
  await app.whenReady();
  configureSession();
  // Kept as a separate Node-target bundle so frontend and server resource paths remain stable.
  const { createApp } = (await import(
    new URL("./server/app.mjs", import.meta.url).href
  )) as { createApp: typeof createAppType };
  const application = createApp({
    desktopToken: token,
    dataDir: join(userDataDirectory, "service-data"),
    staticDir: fileURLToPath(new URL("../dist/", import.meta.url)),
    publicOrigin: "",
  });
  disposeService = application.locals.dispose as () => void | Promise<void>;
  httpServer = createServer(application);
  await new Promise<void>((resolveListening, reject) => {
    httpServer!.once("error", reject);
    httpServer!.listen(DESKTOP_PORT, "127.0.0.1", () => {
      httpServer!.off("error", reject);
      resolveListening();
    });
  });
  httpServer.on("error", (error) => {
    void fatal(error);
  });
  await createMainWindow();
  log("startup-ready");
}

void start().catch((error) => {
  void fatal(error);
});
