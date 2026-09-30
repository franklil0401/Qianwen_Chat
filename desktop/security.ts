export const DESKTOP_APP_ID = "cn.franklil.qianwenchat";
export const DESKTOP_PORT = 18439;
export const DESKTOP_ORIGIN = `http://127.0.0.1:${DESKTOP_PORT}`;
export const DESKTOP_PARTITION = "persist:qianwen-desktop-v1";
export const DESKTOP_TOKEN_HEADER = "X-Qianwen-Desktop-Token";

function parseUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.username || url.password ? undefined : url;
  } catch {
    return undefined;
  }
}

export function isTrustedOrigin(
  value: string,
  origin = DESKTOP_ORIGIN,
): boolean {
  return parseUrl(value)?.origin === origin;
}

export function isAppNavigation(
  value: string,
  origin = DESKTOP_ORIGIN,
): boolean {
  const url = parseUrl(value);
  return Boolean(
    url &&
    url.origin === origin &&
    !url.search &&
    (url.pathname === "/" || url.pathname === "/index.html"),
  );
}

export function isImagePreview(
  value: string,
  origin = DESKTOP_ORIGIN,
): boolean {
  const url = parseUrl(value);
  return Boolean(
    url &&
    url.origin === origin &&
    !url.search &&
    !url.hash &&
    /^\/api\/attachments\/[\w-]{1,100}\/content$/.test(url.pathname),
  );
}

export type WindowTarget =
  { kind: "preview" | "external"; url: string } | { kind: "deny" };
export function classifyWindowTarget(
  value: string,
  origin = DESKTOP_ORIGIN,
): WindowTarget {
  const url = parseUrl(value);
  if (!url) return { kind: "deny" };
  if (isImagePreview(value, origin)) return { kind: "preview", url: url.href };
  if (url.origin !== origin && ["https:", "http:"].includes(url.protocol))
    return { kind: "external", url: url.href };
  return { kind: "deny" };
}

/** Never retain a renderer-supplied token or forward the app token to another origin. */
export function desktopRequestHeaders(
  headers: Record<string, string>,
  requestUrl: string,
  webContentsId: number | undefined,
  trustedWindowIds: ReadonlySet<number>,
  token: string,
  origin = DESKTOP_ORIGIN,
): Record<string, string> {
  const result = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== DESKTOP_TOKEN_HEADER.toLowerCase(),
    ),
  );
  if (
    webContentsId !== undefined &&
    trustedWindowIds.has(webContentsId) &&
    isTrustedOrigin(requestUrl, origin)
  )
    result[DESKTOP_TOKEN_HEADER] = token;
  return result;
}

export interface PermissionContext {
  permission: string;
  webContentsId?: number;
  mainWindowId?: number;
  documentUrl: string;
  requestingOrigin?: string;
  isMainFrame?: boolean;
  mediaType?: string;
  mediaTypes?: string[];
}
export function allowDesktopPermission(
  context: PermissionContext,
  origin = DESKTOP_ORIGIN,
): boolean {
  if (
    context.mainWindowId === undefined ||
    context.webContentsId !== context.mainWindowId ||
    !isAppNavigation(context.documentUrl, origin) ||
    context.isMainFrame === false
  )
    return false;
  if (
    context.requestingOrigin &&
    !isTrustedOrigin(context.requestingOrigin, origin)
  )
    return false;
  if (
    context.permission === "clipboard-sanitized-write" ||
    context.permission === "clipboard-write"
  )
    return true;
  if (context.permission !== "media") return false;
  if (context.mediaTypes)
    return (
      context.mediaTypes.length > 0 &&
      context.mediaTypes.every((value) => value === "audio")
    );
  return context.mediaType === "audio";
}

/** Keep diagnostics useful without copying arbitrary messages, URLs, headers or credentials. */
export function desktopErrorCode(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  return typeof code === "string" &&
    new Set([
      "EADDRINUSE",
      "EACCES",
      "EPERM",
      "ENOENT",
      "EEXIST",
      "SQLITE_CANTOPEN",
      "ERR_UNKNOWN_BUILTIN_MODULE",
      "ERR_MODULE_NOT_FOUND",
      "ERR_DLOPEN_FAILED",
      "ERR_CONNECTION_REFUSED",
      "ERR_FILE_NOT_FOUND",
    ]).has(code)
    ? code
    : "UNEXPECTED";
}

export function startupFailureMessage(error: unknown): string {
  switch (desktopErrorCode(error)) {
    case "EADDRINUSE":
      return `本地服务端口 ${DESKTOP_PORT} 正被其他程序使用。请关闭占用该端口的程序，再启动 QianwenChat。`;
    case "EACCES":
    case "EPERM":
    case "SQLITE_CANTOPEN":
    case "EEXIST":
      return "无法打开应用数据目录或本地数据库。请检查当前 Windows 用户对应用数据目录的读写权限。";
    case "ENOENT":
    case "ERR_MODULE_NOT_FOUND":
    case "ERR_DLOPEN_FAILED":
    case "ERR_FILE_NOT_FOUND":
      return "应用所需文件缺失或无法加载。请重新安装 QianwenChat；现有用户数据会保留。";
    case "ERR_UNKNOWN_BUILTIN_MODULE":
      return "应用运行时与本地数据库不兼容。请使用完整的 QianwenChat 安装包重新安装。";
    default:
      return "桌面应用启动失败。请重新启动，或在应用数据目录的 logs/desktop.log 中查看错误码。";
  }
}
