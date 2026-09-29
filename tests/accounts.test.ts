import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createAccountService,
  type AccountServiceOptions,
} from "../server/accounts";
import {
  mergeAccountWorkspace,
  prepareAccountWorkspace,
} from "../src/account-client";
import type { SavedState } from "../src/state";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const state = (text = "hello"): SavedState => ({
  version: 1,
  activeId: "conversation",
  conversations: [
    {
      id: "conversation",
      title: "测试",
      updatedAt: 1,
      messages: [
        {
          id: "message",
          role: "user",
          content: text,
          status: "done",
          createdAt: 1,
        },
      ],
    },
  ],
  useTools: true,
  thinking: false,
});
async function serve(options: AccountServiceOptions = {}) {
  const account = createAccountService({
    databasePath: ":memory:",
    ...options,
  });
  const app = express();
  app.use(account.middleware);
  app.use("/api/account", account.router);
  app.get("/owner", (req, res) => res.json({ owner: account.getOwner(req) }));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    account.close();
  };
  cleanup.push(close);
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close,
  };
}
function browser(base: string, saved = new Map<string, string>()) {
  let userId: string | undefined;
  return {
    cookies: saved,
    setUser(id: string) {
      userId = id;
    },
    async request(
      path: string,
      method = "GET",
      body?: unknown,
      extra: Record<string, string> = {},
    ) {
      const response = await fetch(
        base + (path === "/owner" ? path : `/api/account${path}`),
        {
          method,
          headers: {
            "X-Qianwen-Client": "web",
            "Content-Type": "application/json",
            ...(userId ? { "X-Qianwen-Account": userId } : {}),
            Cookie: [...saved]
              .map(([key, value]) => `${key}=${value}`)
              .join("; "),
            ...extra,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      for (const cookie of response.headers.getSetCookie()) {
        const [key, value] = cookie.split(";")[0].split("=");
        if (value) saved.set(key, value);
        else saved.delete(key);
      }
      const data = await response.json();
      if (data.user?.id) userId = data.user.id;
      return { response, data };
    },
  };
}
const register = (client: ReturnType<typeof browser>, username = "tester") =>
  client.request("/register", "POST", {
    username,
    password: "test-password-123",
  });

describe("persistent accounts and explicit workspace synchronization", () => {
  it("uses stable signed guest identities and replaces tampered cookies", async () => {
    const { base } = await serve();
    const client = browser(base);
    const first = await client.request("/owner");
    expect(first.data.owner).toMatch(/^guest:/);
    expect((await client.request("/owner")).data).toEqual(first.data);
    client.cookies.set("qianwen_guest", "x".repeat(32) + "." + "y".repeat(43));
    expect((await client.request("/owner")).data.owner).not.toBe(
      first.data.owner,
    );
    expect((await client.request("/workspace")).response.status).toBe(401);
  });
  it("validates credentials, hashes secrets, rotates sessions and logs out", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qianwen-accounts-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "accounts.sqlite");
    const { base } = await serve({ databasePath });
    const client = browser(base);
    expect(
      (
        await client.request("/register", "POST", {
          username: "ab",
          password: "short",
        })
      ).response.status,
    ).toBe(400);
    expect(
      (
        await client.request(
          "/register",
          "POST",
          { username: "tester", password: "password-123" },
          { "X-Qianwen-Client": "" },
        )
      ).response.status,
    ).toBe(403);
    const created = await register(client);
    expect(created.response.status).toBe(201);
    expect(created.data).toMatchObject({
      user: { username: "tester" },
      workspaceRevision: 0,
    });
    const cookies = created.response.headers.getSetCookie().join(";");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("SameSite=Lax");
    expect(JSON.stringify(created.data)).not.toMatch(
      /password|salt|hash|token/,
    );
    const oldToken = client.cookies.get("qianwen_session")!;
    const db = new DatabaseSync(databasePath);
    const row = db
      .prepare("SELECT salt, password_hash FROM accounts")
      .get() as { salt: string; password_hash: string };
    expect(row.salt).toHaveLength(32);
    expect(row.password_hash).toHaveLength(128);
    expect(row.password_hash).not.toContain("test-password");
    expect(
      JSON.stringify(db.prepare("SELECT * FROM account_sessions").all()),
    ).not.toContain(oldToken);
    db.close();
    expect((await register(browser(base), "TESTER")).response.status).toBe(409);
    expect(
      (
        await client.request("/login", "POST", {
          username: "tester",
          password: "wrong-password",
        })
      ).response.status,
    ).toBe(401);
    expect(
      (
        await client.request("/login", "POST", {
          username: "TESTER",
          password: "test-password-123",
        })
      ).response.status,
    ).toBe(200);
    expect(client.cookies.get("qianwen_session")).not.toBe(oldToken);
    const stolenOld = browser(base, new Map([["qianwen_session", oldToken]]));
    expect((await stolenOld.request("/session")).data.user).toBeNull();
    const guest = client.cookies.get("qianwen_guest");
    await client.request("/logout", "POST", {});
    expect((await client.request("/session")).data.user).toBeNull();
    expect(client.cookies.get("qianwen_guest")).toBe(guest);
  });
  it("reserves login attempts before hashing, throttles failures and resets after the window", async () => {
    let now = 10_000;
    const { base } = await serve({
      now: () => now,
      loginAttemptLimit: 2,
      attemptWindowMs: 1000,
    });
    const client = browser(base);
    await register(client);
    const bad = () =>
      client.request("/login", "POST", {
        username: "tester",
        password: "wrong-password",
      });
    const results = await Promise.all([bad(), bad(), bad()]);
    expect(results.map((item) => item.response.status).sort()).toEqual([
      401, 401, 429,
    ]);
    expect(
      results
        .find((item) => item.response.status === 429)!
        .response.headers.get("retry-after"),
    ).toBe("1");
    now += 1001;
    expect(
      (
        await client.request("/login", "POST", {
          username: "tester",
          password: "test-password-123",
        })
      ).response.status,
    ).toBe(200);
  });
  it("isolates accounts and atomically rejects a concurrent stale upload", async () => {
    const { base } = await serve();
    const alice = browser(base),
      bob = browser(base),
      aliceOther = browser(base);
    const account = await register(alice, "alice");
    await register(bob, "bobby");
    await aliceOther.request("/login", "POST", {
      username: "alice",
      password: "test-password-123",
    });
    expect((await alice.request("/workspace")).data).toMatchObject({
      revision: 0,
      state: null,
    });
    const responses = await Promise.all([
      alice.request("/workspace", "PUT", {
        expectedRevision: 0,
        state: state("first"),
      }),
      aliceOther.request("/workspace", "PUT", {
        expectedRevision: 0,
        state: state("second"),
      }),
    ]);
    expect(responses.map((item) => item.response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(
      responses.find((item) => item.response.status === 409)!.data,
    ).toMatchObject({ code: "revision_conflict", revision: 1 });
    const saved = (await aliceOther.request("/workspace")).data;
    expect(saved.revision).toBe(1);
    expect(saved.userId).toBe(account.data.user.id);
    expect((await bob.request("/workspace")).data.state).toBeNull();
    expect(
      (
        await bob.request("/workspace", "GET", undefined, {
          "X-Qianwen-Account": account.data.user.id,
        })
      ).data.code,
    ).toBe("identity_changed");
    const bobSession = bob.cookies.get("qianwen_session")!;
    alice.cookies.set("qianwen_session", bobSession);
    expect(
      (
        await alice.request("/workspace", "PUT", {
          expectedRevision: 0,
          state: state("must not write to bob"),
        })
      ).data.code,
    ).toBe("identity_changed");
    expect((await bob.request("/workspace")).data.state).toBeNull();
  });
  it("preserves guest signatures, sessions and workspaces across server restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qianwen-restart-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "accounts.sqlite");
    const first = await serve({ databasePath });
    const client = browser(first.base);
    const guest = (await client.request("/owner")).data.owner;
    const session = await register(client);
    await client.request("/workspace", "PUT", {
      expectedRevision: 0,
      state: state(),
    });
    await first.close();
    const second = await serve({ databasePath });
    const returned = browser(second.base, client.cookies);
    returned.setUser(session.data.user.id);
    expect((await returned.request("/session")).data.user.id).toBe(
      session.data.user.id,
    );
    expect((await returned.request("/workspace")).data.state).toEqual(state());
    await returned.request("/logout", "POST", {});
    expect((await returned.request("/owner")).data.owner).toBe(guest);
  });
  it("validates nested synced state, bounds messages and normalizes interrupted work", async () => {
    const { base } = await serve();
    const client = browser(base);
    await register(client);
    const invalid = state();
    invalid.conversations[0].messages[0].tools = [
      {
        id: "tool",
        name: "search_knowledge",
        arguments: "{}",
        status: "success",
        result: { type: "knowledge", query: "hi", items: null },
      } as never,
    ];
    expect(
      (
        await client.request("/workspace", "PUT", {
          expectedRevision: 0,
          state: invalid,
        })
      ).response.status,
    ).toBe(400);
    const excessive = state();
    excessive.conversations[0].messages = Array.from(
      { length: 101 },
      (_, index) => ({
        ...excessive.conversations[0].messages[0],
        id: `m${index}`,
      }),
    );
    expect(
      (
        await client.request("/workspace", "PUT", {
          expectedRevision: 0,
          state: excessive,
        })
      ).response.status,
    ).toBe(400);
    const pending = state();
    pending.conversations[0].messages[0].status = "streaming";
    pending.conversations[0].messages[0].tools = [
      { id: "t", name: "calculate", arguments: "", status: "running" },
    ];
    const uploaded = await client.request("/workspace", "PUT", {
      expectedRevision: 0,
      state: pending,
    });
    expect(uploaded.response.status).toBe(200);
    expect(uploaded.data.state.conversations[0].messages[0]).toMatchObject({
      status: "stopped",
      tools: [{ status: "cancelled" }],
    });
    expect(
      (
        await client.request("/workspace", "PUT", {
          expectedRevision: 1,
          state: { ...state(), arbitrary: "not allowed" },
        })
      ).response.status,
    ).toBe(400);
    expect((await client.request("/workspace")).data.revision).toBe(1);
  });
});

describe("account workspace preparation and merge", () => {
  it("retains attachment/search fields but strips recovery UI notices", () => {
    const current = state();
    current.webSearch = true;
    current.recoveryNotice = "notice";
    current.conversations[0].messages[0].attachments = [
      {
        id: "image",
        name: "image.png",
        kind: "image",
        mimeType: "image/png",
        size: 10,
        previewUrl: "/api/attachments/image/content",
      },
    ];
    current.conversations[0].messages[0].searchSources = [
      { id: "web", title: "文档", url: "https://example.com" },
    ];
    const prepared = prepareAccountWorkspace(current);
    expect(prepared.recoveryNotice).toBeUndefined();
    expect(prepared.webSearch).toBe(true);
    expect(prepared.conversations[0].messages[0].attachments).toEqual(
      current.conversations[0].messages[0].attachments,
    );
    expect(prepared.conversations[0].messages[0].searchSources).toEqual(
      current.conversations[0].messages[0].searchSources,
    );
  });
  it("deduplicates equal copies, preserves changed local histories and remaps branches", () => {
    const local = state("local");
    expect(mergeAccountWorkspace(local, local).conversations).toHaveLength(1);
    const reordered = state("local");
    const original = reordered.conversations[0];
    reordered.conversations[0] = {
      messages: original.messages,
      updatedAt: original.updatedAt,
      title: original.title,
      id: original.id,
    };
    expect(mergeAccountWorkspace(reordered, local).conversations).toHaveLength(
      1,
    );
    const remote = state("remote");
    remote.conversations.push({
      id: "branch",
      title: "branch",
      messages: [],
      updatedAt: 2,
      branchFrom: {
        conversationId: "conversation",
        messageId: "message",
        title: "parent",
        mode: "edit",
      },
    });
    const merged = mergeAccountWorkspace(local, remote, () => "new-id");
    expect(merged.conversations).toHaveLength(3);
    expect(merged.conversations[0].messages[0].content).toBe("local");
    expect(merged.conversations[1].id).toBe("new-id");
    expect(merged.conversations[2].branchFrom?.conversationId).toBe("new-id");
    expect(merged.activeId).toBe(local.activeId);
  });
  it("refuses a merge exceeding recovery capacity rather than trimming existing conversations", () => {
    const local = state();
    local.conversations = Array.from({ length: 50 }, (_, index) => ({
      ...local.conversations[0],
      id: `c${index}`,
    }));
    local.activeId = "c0";
    expect(() => mergeAccountWorkspace(local, state())).toThrow("超过 50");
    expect(local.conversations).toHaveLength(50);
  });
});
