import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  ChevronDown,
  Download,
  LogOut,
  RefreshCw,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import type { SavedState } from "./state";
import {
  AccountError,
  authenticateAccount,
  getAccountSession,
  getAccountWorkspace,
  logoutAccount,
  mergeAccountWorkspace,
  prepareAccountWorkspace,
  putAccountWorkspace,
  type AccountSession,
  type AccountUser,
  type AccountWorkspace,
} from "./account-client";
import "./account.css";

export interface AccountPanelProps {
  getState: () => SavedState;
  onApply: (state: SavedState) => void;
  disabled: boolean;
  onToast?: (text: string) => void;
  /** Called synchronously before the new account is shown. Initial failure calls null too. */
  onIdentityChange?: (userId: string | null) => void;
}
interface Preview {
  direction: "upload" | "download";
  remote: AccountWorkspace;
  local: SavedState;
  trimmed: boolean;
  stale?: boolean;
}
const messageCount = (state: SavedState | null) =>
  state?.conversations.reduce(
    (total, item) => total + item.messages.length,
    0,
  ) ?? 0;
const describe = (state: SavedState | null) =>
  state
    ? `${state.conversations.length} 个会话 · ${messageCount(state)} 条消息`
    : "尚无账户副本";

export default function AccountPanel(props: AccountPanelProps) {
  const latest = useRef(props);
  latest.current = props;
  const [user, setUser] = useState<AccountUser | null>(null);
  const currentUser = useRef<AccountUser | null>(null);
  const initialized = useRef(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [downloadMode, setDownloadMode] = useState<"merge" | "replace">(
    "merge",
  );
  const [layout, setLayout] = useState({ above: true, height: 500 });
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const active = useRef<AbortController | null>(null);
  const operation = useRef(0);
  const formId = useId();
  const locked = busy || props.disabled || !ready;

  function acceptSession(session: AccountSession) {
    const changed =
      !initialized.current || currentUser.current?.id !== session.user?.id;
    if (changed) {
      setPreview(null);
      // App saves the old bucket, changes its storage identity and replaces stateRef here.
      latest.current.onIdentityChange?.(session.user?.id ?? null);
    }
    initialized.current = true;
    currentUser.current = session.user;
    setUser(session.user);
    if (session.user) setMode("login");
    setReady(true);
  }
  async function run(
    task: (signal: AbortSignal, valid: () => boolean) => Promise<void>,
    initial = false,
  ) {
    if (busyRef.current && !initial) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const version = ++operation.current;
    const valid = () =>
      version === operation.current && !controller.signal.aborted;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const timeout = window.setTimeout(() => controller.abort(), 25_000);
    try {
      await task(controller.signal, valid);
    } catch (failure) {
      if (version !== operation.current) return;
      if (!initialized.current)
        acceptSession({ user: null, workspaceRevision: null });
      if (
        failure instanceof AccountError &&
        (failure.code === "identity_changed" || failure.status === 401)
      ) {
        setPreview(null);
        try {
          const session = await getAccountSession(controller.signal);
          if (valid()) acceptSession(session);
        } catch {
          /* Keep current local bucket until identity can be confirmed. */
        }
      }
      setError(
        controller.signal.aborted
          ? "账户请求超时，请重试。"
          : failure instanceof Error
            ? failure.message
            : "账户操作失败，请重试。",
      );
    } finally {
      window.clearTimeout(timeout);
      if (version === operation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  function refreshSession(initial = false) {
    return run(async (signal, valid) => {
      const session = await getAccountSession(signal);
      if (valid()) acceptSession(session);
    }, initial);
  }
  function positionPanel() {
    if (!details.current?.open || !summary.current) return;
    const rect = summary.current.getBoundingClientRect();
    const above = rect.top - 16,
      below = window.innerHeight - rect.bottom - 16;
    setLayout({
      above: above >= below,
      height: Math.max(80, Math.min(610, Math.max(above, below))),
    });
  }
  function closePanel() {
    if (details.current) details.current.open = false;
    setPassword("");
    setPreview(null);
  }
  useEffect(() => {
    void refreshSession(true);
    const focused = () => {
      if (!busyRef.current) void refreshSession();
    };
    const outside = (event: PointerEvent) => {
      if (
        details.current?.open &&
        event.target instanceof Node &&
        !details.current.contains(event.target)
      )
        closePanel();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || !details.current?.open)
        return;
      event.preventDefault();
      event.stopPropagation();
      closePanel();
      summary.current?.focus();
    };
    window.addEventListener("focus", focused);
    window.addEventListener("resize", positionPanel);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      operation.current++;
      active.current?.abort();
      busyRef.current = false;
      window.removeEventListener("focus", focused);
      window.removeEventListener("resize", positionPanel);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, []);

  function authenticate(event: FormEvent) {
    event.preventDefault();
    if (locked) return;
    void run(async (signal, valid) => {
      const attempt = password;
      setPassword("");
      const session = await authenticateAccount(
        mode,
        username,
        attempt,
        signal,
      );
      if (!valid()) return;
      acceptSession(session);
      setPreview(null);
      latest.current.onToast?.(
        mode === "register"
          ? "账号已创建，访客会话保留在访客空间。"
          : "已登录，切换到此账号的本机会话空间。",
      );
    });
  }
  function logout() {
    if (locked) return;
    void run(async (signal, valid) => {
      const session = await logoutAccount(signal);
      if (!valid()) return;
      acceptSession(session);
      setPreview(null);
      setPassword("");
      latest.current.onToast?.("已退出账号，恢复本机访客会话。");
    });
  }
  function loadPreview(direction: Preview["direction"]) {
    const account = currentUser.current;
    if (locked || !account) return;
    setPreview(null);
    void run(async (signal, valid) => {
      const original = latest.current.getState();
      const local = prepareAccountWorkspace(original);
      const remote = await getAccountWorkspace(account.id, signal);
      if (!valid() || currentUser.current?.id !== account.id) return;
      if (direction === "download" && !remote.state)
        throw new Error("该账号还没有会话副本，请先从一台浏览器上传。");
      setPreview({
        direction,
        remote,
        local,
        trimmed:
          original.conversations.length !== local.conversations.length ||
          messageCount(original) !== messageCount(local),
      });
      setDownloadMode("merge");
    });
  }
  function confirmSync() {
    const selected = preview,
      account = currentUser.current;
    if (
      locked ||
      !selected ||
      selected.stale ||
      !account ||
      selected.remote.userId !== account.id
    )
      return;
    void run(async (signal, valid) => {
      const current = latest.current.getState();
      if (
        JSON.stringify(prepareAccountWorkspace(current)) !==
        JSON.stringify(selected.local)
      ) {
        setPreview({ ...selected, stale: true });
        throw new Error("本机会话已变化，请刷新预览后重新确认。");
      }
      if (selected.direction === "upload") {
        try {
          const remote = await putAccountWorkspace(
            account.id,
            selected.remote.revision,
            selected.local,
            signal,
          );
          if (!valid()) return;
          setPreview(null);
          latest.current.onToast?.(
            `已上传到当前服务，账户副本版本 ${remote.revision}。`,
          );
        } catch (failure) {
          if (
            failure instanceof AccountError &&
            failure.code === "revision_conflict" &&
            valid()
          )
            setPreview({ ...selected, stale: true });
          throw failure;
        }
      } else {
        const downloaded = selected.remote.state!;
        const next =
          downloadMode === "replace"
            ? downloaded
            : mergeAccountWorkspace(current, downloaded);
        if (!valid()) return;
        latest.current.onApply(next);
        setPreview(null);
        latest.current.onToast?.(
          downloadMode === "replace"
            ? "已用账户副本替换此账号的本机会话。"
            : "账户会话已合并到本机，原有会话已保留。",
        );
      }
    });
  }
  return (
    <details
      className="account-control"
      ref={details}
      data-testid="account-panel"
      onToggle={positionPanel}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          closePanel();
      }}
    >
      <summary
        ref={summary}
        className="account-trigger"
        aria-label="账号与同步"
      >
        <UserRound size={16} aria-hidden="true" />
        <span>{user ? user.username : "账号与同步"}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div
        className={`account-panel ${layout.above ? "account-above" : "account-below"}`}
        style={{ maxHeight: layout.height }}
        aria-label="账号与会话同步"
      >
        <div className="account-heading">
          <strong>账号与会话同步</strong>
          <button type="button" aria-label="关闭账号面板" onClick={closePanel}>
            <X size={17} />
          </button>
        </div>
        <p className="account-note">
          账号与副本保存在当前服务。登录后手动上传或下载，同一服务的不同浏览器可同步。
        </p>
        {!ready ? (
          <p role="status">正在确认登录状态…</p>
        ) : user ? (
          <>
            <div className="account-identity">
              <span>
                当前账号 <strong>{user.username}</strong>
              </span>
              <button type="button" onClick={logout} disabled={locked}>
                <LogOut size={14} />
                退出
              </button>
            </div>
            <div className="account-sync-actions">
              <button
                type="button"
                disabled={locked}
                onClick={() => loadPreview("upload")}
              >
                <Upload size={15} />
                上传本机会话
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => loadPreview("download")}
              >
                <Download size={15} />
                下载账户会话
              </button>
            </div>
            <p className="account-note">
              登录不会上传访客会话。附件仅在原服务、原账号下有效；访客附件请登录后重新上传。
            </p>
          </>
        ) : (
          <form onSubmit={authenticate}>
            <fieldset disabled={locked}>
              <legend>
                {mode === "login" ? "登录当前服务" : "创建当前服务账号"}
              </legend>
              <label htmlFor={`${formId}-username`}>用户名</label>
              <input
                id={`${formId}-username`}
                name="username"
                autoComplete="username"
                minLength={3}
                maxLength={32}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                placeholder="3–32 位文字、数字、_ 或 -"
              />
              <label htmlFor={`${formId}-password`}>密码</label>
              <input
                id={`${formId}-password`}
                name="password"
                type="password"
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
                minLength={8}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                placeholder="8–128 位"
              />
              <div className="account-form-actions">
                <button className="account-primary" type="submit">
                  {mode === "login" ? "登录" : "注册并登录"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode(mode === "login" ? "register" : "login");
                    setPassword("");
                    setError("");
                  }}
                >
                  {mode === "login" ? "创建账号" : "已有账号，去登录"}
                </button>
              </div>
            </fieldset>
          </form>
        )}
        {preview && (
          <section className="account-preview" aria-label="同步操作预览">
            <strong>
              {preview.direction === "upload" ? "上传前确认" : "下载前确认"}
            </strong>
            <dl>
              <div>
                <dt>本机快照</dt>
                <dd>{describe(preview.local)}</dd>
              </div>
              <div>
                <dt>账户版本 {preview.remote.revision}</dt>
                <dd>{describe(preview.remote.state)}</dd>
              </div>
            </dl>
            {preview.remote.updatedAt !== null && (
              <p className="account-note">
                账户更新于 {new Date(preview.remote.updatedAt).toLocaleString()}
              </p>
            )}
            {preview.trimmed && (
              <p className="account-warning">
                快照保留当前及最近 50 个会话，每个最多 100
                条消息；更早历史不会上传。
              </p>
            )}
            {preview.direction === "upload" ? (
              <p>
                确认后将覆盖账户副本，其他浏览器需重新下载。此操作不删除本机会话。
              </p>
            ) : (
              <fieldset disabled={locked}>
                <legend>下载方式</legend>
                <label className="account-radio">
                  <input
                    type="radio"
                    name={`${formId}-download`}
                    checked={downloadMode === "merge"}
                    onChange={() => setDownloadMode("merge")}
                  />
                  合并，保留本机和账户的不同会话
                </label>
                <label className="account-radio">
                  <input
                    type="radio"
                    name={`${formId}-download`}
                    checked={downloadMode === "replace"}
                    onChange={() => setDownloadMode("replace")}
                  />
                  替换此账号的本机会话及草稿
                </label>
              </fieldset>
            )}
            {preview.stale && (
              <p className="account-warning" role="status">
                副本或本机会话已变化，需刷新预览并重新确认。
              </p>
            )}
            <div className="account-confirm-actions">
              <button
                type="button"
                disabled={locked}
                onClick={() => loadPreview(preview.direction)}
              >
                <RefreshCw size={14} />
                刷新预览
              </button>
              <button
                type="button"
                className="account-primary"
                disabled={locked || preview.stale}
                onClick={confirmSync}
              >
                {preview.direction === "upload"
                  ? "确认覆盖账户副本"
                  : downloadMode === "replace"
                    ? "确认替换本机会话"
                    : "确认合并到本机"}
              </button>
            </div>
          </section>
        )}
        {busy && (
          <p className="account-note" role="status">
            正在处理…
          </p>
        )}
        {props.disabled && ready && (
          <p className="account-note">请先停止生成或录音，再操作账号与同步。</p>
        )}
        {error && (
          <p className="account-error" role="alert">
            {error}
          </p>
        )}
        {error && !busy && (
          <button
            type="button"
            className="account-retry"
            disabled={props.disabled}
            onClick={() => void refreshSession()}
          >
            <RefreshCw size={14} />
            重新确认登录状态
          </button>
        )}
      </div>
    </details>
  );
}
