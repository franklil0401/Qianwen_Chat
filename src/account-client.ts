import { z } from "zod";
import { validateWorkspace } from "../shared/workspace";
import { createSnapshot, type SavedState } from "./state";

const userSchema = z
  .object({
    id: z.string().min(1).max(100),
    username: z.string().min(1).max(32),
  })
  .strict();
const sessionSchema = z
  .object({
    user: userSchema.nullable(),
    workspaceRevision: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type AccountSession = z.infer<typeof sessionSchema>;
export type AccountUser = NonNullable<AccountSession["user"]>;
export interface AccountWorkspace {
  userId: string;
  revision: number;
  updatedAt: number | null;
  state: SavedState | null;
}
export class AccountError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  accountId?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/account/${path}`, {
      method,
      credentials: "same-origin",
      signal,
      headers: {
        "X-Qianwen-Client": "web",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(accountId ? { "X-Qianwen-Account": accountId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new AccountError("无法连接账户服务，请确认本地服务正在运行。", 0);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new AccountError("账户服务响应不完整，请重试。", response.status);
  }
  if (!response.ok) {
    const failure = z
      .object({ error: z.string().max(1000), code: z.string().optional() })
      .safeParse(data);
    throw new AccountError(
      failure.success ? failure.data.error : "账户操作失败，请重试。",
      response.status,
      failure.success ? failure.data.code : undefined,
    );
  }
  return data;
}
export async function getAccountSession(signal?: AbortSignal) {
  return sessionSchema.parse(
    await request("session", "GET", undefined, undefined, signal),
  );
}
export async function authenticateAccount(
  mode: "login" | "register",
  username: string,
  password: string,
  signal?: AbortSignal,
) {
  return sessionSchema.parse(
    await request(mode, "POST", { username, password }, undefined, signal),
  );
}
export async function logoutAccount(signal?: AbortSignal) {
  return sessionSchema.parse(
    await request("logout", "POST", {}, undefined, signal),
  );
}
function parseWorkspace(data: unknown, accountId: string): AccountWorkspace {
  const parsed = z
    .object({
      userId: z.string(),
      revision: z.number().int().nonnegative(),
      updatedAt: z.number().finite().nonnegative().nullable(),
      state: z.unknown(),
    })
    .strict()
    .parse(data);
  if (parsed.userId !== accountId)
    throw new AccountError(
      "当前登录账号已变化，请重新确认账号。",
      409,
      "identity_changed",
    );
  return {
    ...parsed,
    state: parsed.state === null ? null : validateWorkspace(parsed.state),
  };
}
export async function getAccountWorkspace(
  accountId: string,
  signal?: AbortSignal,
) {
  return parseWorkspace(
    await request("workspace", "GET", undefined, accountId, signal),
    accountId,
  );
}
export async function putAccountWorkspace(
  accountId: string,
  expectedRevision: number,
  state: SavedState,
  signal?: AbortSignal,
) {
  return parseWorkspace(
    await request(
      "workspace",
      "PUT",
      { expectedRevision, state },
      accountId,
      signal,
    ),
    accountId,
  );
}
export function prepareAccountWorkspace(state: SavedState): SavedState {
  const result = validateWorkspace(createSnapshot(state));
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    6 * 1024 * 1024
  )
    throw new Error("会话超过 6 MB，请整理后再上传。");
  return result;
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : item,
  );
}
/** Keep both changed copies on ID collision, while identical repeated downloads are idempotent. */
export function mergeAccountWorkspace(
  current: SavedState,
  downloaded: SavedState,
  makeId: () => string = () => crypto.randomUUID(),
): SavedState {
  const incoming = validateWorkspace(downloaded);
  const existing = new Map(
    current.conversations.map((item) => [item.id, item]),
  );
  const occupied = new Set([
    ...existing.keys(),
    ...incoming.conversations.map((item) => item.id),
  ]);
  const mapping = new Map<string, string>();
  const additions = incoming.conversations.filter(
    (item) => canonical(existing.get(item.id)) !== canonical(item),
  );
  for (const item of additions) {
    let id = item.id;
    if (existing.has(id)) {
      let attempts = 0;
      do {
        id = makeId();
        if (++attempts > 100) throw new Error("无法分配会话标识，请重试。");
      } while (occupied.has(id) || !/^[\w-]{1,100}$/.test(id));
    }
    occupied.add(id);
    mapping.set(item.id, id);
  }
  if (current.conversations.length + additions.length > 50)
    throw new Error("合并后超过 50 个会话，请先整理本机会话或选择替换。");
  const conversations = [
    ...current.conversations,
    ...additions.map((item) => ({
      ...item,
      id: mapping.get(item.id)!,
      branchFrom: item.branchFrom
        ? {
            ...item.branchFrom,
            conversationId:
              mapping.get(item.branchFrom.conversationId) ??
              item.branchFrom.conversationId,
          }
        : undefined,
    })),
  ];
  const result = { ...current, conversations };
  // Do not silently trim existing histories while merging.
  if (
    new TextEncoder().encode(JSON.stringify(createSnapshot(result)))
      .byteLength >
    6 * 1024 * 1024
  )
    throw new Error("合并后超过本机恢复容量，请先整理会话。");
  return result;
}
