import express, {
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { validateWorkspace } from "../shared/workspace";
import { openAccountStore, type AccountRow } from "./account-store";

const SESSION_COOKIE = "qianwen_session";
const GUEST_COOKIE = "qianwen_guest";
const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
const WORKSPACE_BYTES = 6 * 1024 * 1024;
const credentials = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(32)
      .regex(/^[\p{L}\p{N}_-]+$/u),
    password: z.string().min(8).max(128),
  })
  .strict();
type User = { id: string; username: string };
type Identity = { user: User | null; guestId: string; sessionHash?: string };
export interface AccountServiceOptions {
  databasePath?: string;
  secureCookies?: boolean;
  validateWorkspace?: (value: unknown) => ReturnType<typeof validateWorkspace>;
  now?: () => number;
  loginAttemptLimit?: number;
  attemptWindowMs?: number;
}
const hashToken = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function passwordHash(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolveHash, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, result) => (error ? reject(error) : resolveHash(result)),
    ),
  );
}
function readCookies(req: Request) {
  const result = new Map<string, string>();
  for (const pair of (req.headers.cookie ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0 && !result.has(pair.slice(0, at).trim()))
      result.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  return result;
}

/** Mount middleware before all identity-aware API routes; mount router at /api/account. */
export function createAccountService(options: AccountServiceOptions = {}) {
  const store = openAccountStore(
    options.databasePath ?? resolve(".local/accounts.sqlite"),
  );
  const now = options.now ?? Date.now;
  const validate = options.validateWorkspace ?? validateWorkspace;
  const identities = new WeakMap<Request, Identity>();
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: options.secureCookies ?? false,
    path: "/api",
  };
  const signGuest = (id: string) =>
    createHmac("sha256", store.guestSecret).update(id).digest("base64url");
  function guestId(value?: string) {
    if (!value || !/^[\w-]{32}\.[\w-]{43}$/.test(value)) return undefined;
    const [id, signature] = value.split(".");
    return timingSafeEqual(Buffer.from(signature), Buffer.from(signGuest(id)))
      ? id
      : undefined;
  }
  const middleware: RequestHandler = (req, res, next) => {
    try {
      const cookies = readCookies(req);
      let guest = guestId(cookies.get(GUEST_COOKIE));
      if (!guest) {
        guest = randomBytes(24).toString("base64url");
        res.cookie(GUEST_COOKIE, `${guest}.${signGuest(guest)}`, {
          ...cookieOptions,
          maxAge: 365 * 24 * 60 * 60 * 1000,
        });
      }
      const token = cookies.get(SESSION_COOKIE);
      const sessionHash =
        token && /^[\w-]{43}$/.test(token) ? hashToken(token) : undefined;
      const user = sessionHash
        ? (store.session(sessionHash, now()) ?? null)
        : null;
      identities.set(req, { user, guestId: guest, sessionHash });
      if (token && !user) res.clearCookie(SESSION_COOKIE, cookieOptions);
      next();
    } catch (error) {
      next(error);
    }
  };
  const identity = (req: Request) => {
    const value = identities.get(req);
    if (!value)
      throw new Error("Account middleware must run before account routes.");
    return value;
  };
  const responseSession = (user: User | null) => ({
    user,
    workspaceRevision: user ? store.workspace(user.id).revision : null,
  });
  function startSession(req: Request, res: Response, account: AccountRow) {
    const previous = identity(req).sessionHash;
    if (previous) store.deleteSession(previous);
    const token = randomBytes(32).toString("base64url");
    store.setSession(hashToken(token), account.id, now() + SESSION_AGE, now());
    res.cookie(SESSION_COOKIE, token, {
      ...cookieOptions,
      maxAge: SESSION_AGE,
    });
    return responseSession({ id: account.id, username: account.username });
  }
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("X-Qianwen-Client") !== "web"
    ) {
      res.status(403).json({ error: "请求校验失败，请刷新页面后重试。" });
      return;
    }
    next();
  });
  router.use(express.json({ limit: "6mb" }));
  router.get("/session", (req, res) =>
    res.json(responseSession(identity(req).user)),
  );
  for (const action of ["register", "login"] as const) {
    router.post(`/${action}`, async (req, res) => {
      const parsed = credentials.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error:
            "用户名需为 3–32 位文字、数字、下划线或连字符，密码需为 8–128 位。",
        });
        return;
      }
      const { username, password } = parsed.data;
      const normalized = username.toLocaleLowerCase("en-US");
      const windowMs = options.attemptWindowMs ?? 15 * 60 * 1000;
      const client = req.ip ?? req.socket.remoteAddress ?? "local";
      const key = `${action}:${hashToken(client + "\0" + normalized)}`;
      const ipWait = store.consumeAttempt(
        `ip:${hashToken(client)}`,
        now(),
        windowMs,
        40,
      );
      const wait =
        ipWait ||
        store.consumeAttempt(
          key,
          now(),
          windowMs,
          options.loginAttemptLimit ?? 5,
        );
      if (wait) {
        res.setHeader("Retry-After", String(wait));
        res.status(429).json({ error: "尝试次数过多，请稍后再试。" });
        return;
      }
      if (action === "register") {
        const salt = randomBytes(16).toString("hex");
        const hash = (await passwordHash(password, salt)).toString("hex");
        const account = store.create(username, normalized, salt, hash, now());
        if (!account) {
          res
            .status(409)
            .json({ error: "该用户名已注册，请登录或使用其他用户名。" });
          return;
        }
        store.clearAttempt(key);
        res.status(201).json(startSession(req, res, account));
      } else {
        const account = store.byUsername(normalized);
        const hash = await passwordHash(
          password,
          account?.salt ?? "0".repeat(32),
        );
        const expected = Buffer.from(
          account?.password_hash ?? "0".repeat(128),
          "hex",
        );
        if (!timingSafeEqual(hash, expected) || !account) {
          res.status(401).json({ error: "用户名或密码不正确。" });
          return;
        }
        store.clearAttempt(key);
        res.json(startSession(req, res, account));
      }
    });
  }
  router.post("/logout", (req, res) => {
    const current = identity(req);
    if (current.sessionHash) store.deleteSession(current.sessionHash);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.json(responseSession(null));
  });
  router.use("/workspace", (req, res, next) => {
    if (!identity(req).user) {
      res.status(401).json({ error: "请先登录，再同步账户会话。" });
      return;
    }
    if (req.get("X-Qianwen-Account") !== identity(req).user!.id) {
      res.status(409).json({
        code: "identity_changed",
        error: "当前登录账号已变化，请确认账号后重新操作。",
      });
      return;
    }
    next();
  });
  router.get("/workspace", (req, res) => {
    const row = store.workspace(identity(req).user!.id);
    res.json({
      userId: identity(req).user!.id,
      revision: row.revision,
      updatedAt: row.updated_at,
      state: row.state_json ? validate(JSON.parse(row.state_json)) : null,
    });
  });
  router.put("/workspace", (req, res) => {
    const body = z
      .object({
        expectedRevision: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER - 1),
        state: z.unknown(),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "同步请求格式不正确。" });
      return;
    }
    let state: ReturnType<typeof validateWorkspace>;
    try {
      state = validate(body.data.state);
    } catch {
      res.status(400).json({ error: "会话数据格式不正确，未覆盖账户副本。" });
      return;
    }
    const serialized = JSON.stringify(state);
    if (
      Buffer.byteLength(serialized, "utf8") > WORKSPACE_BYTES ||
      state.conversations.length > 50 ||
      state.conversations.some((item) => item.messages.length > 100)
    ) {
      res.status(413).json({
        error: "账户副本最多 50 个会话、每个 100 条消息，总大小不超过 6 MB。",
      });
      return;
    }
    const userId = identity(req).user!.id;
    if (
      !store.updateWorkspace(
        userId,
        body.data.expectedRevision,
        serialized,
        now(),
      )
    ) {
      res.status(409).json({
        code: "revision_conflict",
        revision: store.workspace(userId).revision,
        error: "账户副本已被其他页面更新，请刷新预览后重新确认。",
      });
      return;
    }
    const row = store.workspace(userId);
    res.json({
      userId,
      revision: row.revision,
      updatedAt: row.updated_at,
      state,
    });
  });
  router.use(
    (
      error: unknown,
      _req: Request,
      res: Response,
      _next: express.NextFunction,
    ) => {
      const kind =
        error && typeof error === "object" && "type" in error
          ? error.type
          : undefined;
      if (kind === "entity.too.large") {
        res
          .status(413)
          .json({ error: "同步数据超过 6 MB，请整理会话后重试。" });
        return;
      }
      if (error instanceof SyntaxError) {
        res.status(400).json({ error: "请求 JSON 格式不正确。" });
        return;
      }
      res.status(500).json({ error: "账户服务暂时无法完成操作，请稍后重试。" });
    },
  );
  return {
    router,
    middleware,
    getOwner(req: Request) {
      const current = identity(req);
      return current.user
        ? `user:${current.user.id}`
        : `guest:${current.guestId}`;
    },
    close: store.close,
  };
}
