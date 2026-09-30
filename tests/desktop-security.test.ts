import { describe, expect, it } from "vitest";
import {
  allowDesktopPermission,
  classifyWindowTarget,
  desktopErrorCode,
  desktopRequestHeaders,
  DESKTOP_ORIGIN,
  DESKTOP_TOKEN_HEADER,
  isAppNavigation,
  isImagePreview,
  startupFailureMessage,
} from "../desktop/security";

describe("desktop request and window boundaries", () => {
  it("only sends the app token to controlled windows at the exact loopback origin", () => {
    const headers = {
      Cookie: "session",
      "x-qianwen-desktop-token": "forged",
      "X-Qianwen-Client": "web",
    };
    const ids = new Set([1, 2]);
    expect(
      desktopRequestHeaders(
        headers,
        `${DESKTOP_ORIGIN}/api/health`,
        1,
        ids,
        "actual",
      ),
    ).toEqual({
      Cookie: "session",
      "X-Qianwen-Client": "web",
      [DESKTOP_TOKEN_HEADER]: "actual",
    });
    for (const url of [
      "https://example.com",
      "http://127.0.0.1:18440/api/health",
      "http://localhost:18439/",
      "http://user@127.0.0.1:18439/",
    ])
      expect(
        desktopRequestHeaders(headers, url, 1, ids, "actual"),
      ).not.toHaveProperty(DESKTOP_TOKEN_HEADER);
    expect(
      desktopRequestHeaders(headers, DESKTOP_ORIGIN, 3, ids, "actual"),
    ).not.toHaveProperty(DESKTOP_TOKEN_HEADER);
    expect(
      desktopRequestHeaders(headers, DESKTOP_ORIGIN, undefined, ids, "actual"),
    ).not.toHaveProperty("x-qianwen-desktop-token");
    expect(headers["x-qianwen-desktop-token"]).toBe("forged");
  });
  it("allows only the app document and validated local attachment previews", () => {
    expect(isAppNavigation(`${DESKTOP_ORIGIN}/#answer`)).toBe(true);
    expect(isAppNavigation(`${DESKTOP_ORIGIN}/index.html`)).toBe(true);
    for (const path of ["/api/health", "/?redirect=evil", "/elsewhere"])
      expect(isAppNavigation(DESKTOP_ORIGIN + path)).toBe(false);
    const preview = `${DESKTOP_ORIGIN}/api/attachments/image-123/content`;
    expect(isImagePreview(preview)).toBe(true);
    expect(classifyWindowTarget(preview)).toEqual({
      kind: "preview",
      url: preview,
    });
    for (const suffix of ["?next=evil", "#fragment", "/more"])
      expect(isImagePreview(preview + suffix)).toBe(false);
    expect(
      isImagePreview(
        `${DESKTOP_ORIGIN}/api/attachments/${"x".repeat(101)}/content`,
      ),
    ).toBe(false);
    expect(
      classifyWindowTarget(`${DESKTOP_ORIGIN}/api/account/session`),
    ).toEqual({ kind: "deny" });
  });
  it("opens only ordinary external HTTP(S) links without embedded credentials", () => {
    expect(classifyWindowTarget("https://example.com/docs#part")).toEqual({
      kind: "external",
      url: "https://example.com/docs#part",
    });
    expect(classifyWindowTarget("http://example.com")).toMatchObject({
      kind: "external",
    });
    for (const url of [
      "file:///C:/Windows/System32/cmd.exe",
      "javascript:alert(1)",
      "data:text/html,hello",
      "mailto:a@example.com",
      "https://user:secret@example.com",
      "not a url",
    ])
      expect(classifyWindowTarget(url)).toEqual({ kind: "deny" });
  });
  it("grants microphone and clipboard writes only to the trusted main document", () => {
    const context = {
      webContentsId: 1,
      mainWindowId: 1,
      documentUrl: DESKTOP_ORIGIN,
      requestingOrigin: DESKTOP_ORIGIN,
      isMainFrame: true,
    };
    expect(
      allowDesktopPermission({
        ...context,
        permission: "media",
        mediaType: "audio",
      }),
    ).toBe(true);
    expect(
      allowDesktopPermission({
        ...context,
        permission: "media",
        mediaTypes: ["audio"],
      }),
    ).toBe(true);
    expect(
      allowDesktopPermission({
        ...context,
        permission: "clipboard-sanitized-write",
      }),
    ).toBe(true);
    for (const mediaTypes of [["video"], ["audio", "video"], []])
      expect(
        allowDesktopPermission({ ...context, permission: "media", mediaTypes }),
      ).toBe(false);
    for (const permission of [
      "clipboard-read",
      "display-capture",
      "geolocation",
      "notifications",
    ])
      expect(allowDesktopPermission({ ...context, permission })).toBe(false);
    expect(
      allowDesktopPermission({
        ...context,
        permission: "media",
        mediaType: "unknown",
      }),
    ).toBe(false);
    expect(
      allowDesktopPermission({
        ...context,
        permission: "media",
        mediaType: "audio",
        webContentsId: 2,
      }),
    ).toBe(false);
    expect(
      allowDesktopPermission({
        ...context,
        permission: "media",
        mediaType: "audio",
        requestingOrigin: "https://example.com",
      }),
    ).toBe(false);
    expect(
      allowDesktopPermission({
        ...context,
        permission: "media",
        mediaType: "audio",
        isMainFrame: false,
      }),
    ).toBe(false);
  });
  it("never copies arbitrary startup messages or credentials into public diagnostics", () => {
    const error = Object.assign(
      new Error("secret-provider-key https://api.example/?token=secret"),
      { code: "EADDRINUSE" },
    );
    expect(desktopErrorCode(error)).toBe("EADDRINUSE");
    expect(startupFailureMessage(error)).toContain("18439");
    expect(startupFailureMessage(error)).not.toContain("secret");
    expect(
      desktopErrorCode({ code: "secret-provider-key", message: "secret" }),
    ).toBe("UNEXPECTED");
    expect(startupFailureMessage({ message: "secret" })).not.toContain(
      "secret",
    );
  });
});
