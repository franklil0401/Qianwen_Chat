import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Keyboard,
  Monitor,
  Moon,
  Settings2,
  Sun,
  Type,
} from "lucide-react";
import "./reading-preferences.css";

export type ColorPreference = "light" | "dark" | "system";
export type ReadingSize = "normal" | "large";
export interface ReadingSettings {
  theme: ColorPreference;
  textSize: ReadingSize;
}

export const READING_PREFERENCES_KEY = "qianwen-reading-preferences-v1";
const defaults = (): ReadingSettings => ({
  theme: "system",
  textSize: "normal",
});
type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function parseReadingPreferences(raw: string | null): ReadingSettings {
  if (!raw || raw.length > 1000) return defaults();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return defaults();
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1) return defaults();
    return {
      theme:
        value.theme === "light" || value.theme === "dark"
          ? value.theme
          : "system",
      textSize: value.textSize === "large" ? "large" : "normal",
    };
  } catch {
    return defaults();
  }
}

export function readReadingPreferences(
  storage?: StorageReader,
): ReadingSettings {
  try {
    const source =
      storage ??
      (typeof window === "undefined" ? undefined : window.localStorage);
    return parseReadingPreferences(
      source?.getItem(READING_PREFERENCES_KEY) ?? null,
    );
  } catch {
    return defaults();
  }
}

export function saveReadingPreferences(
  settings: ReadingSettings,
  storage?: StorageWriter,
): boolean {
  try {
    const target =
      storage ??
      (typeof window === "undefined" ? undefined : window.localStorage);
    if (!target) return false;
    target.setItem(
      READING_PREFERENCES_KEY,
      JSON.stringify({
        version: 1,
        theme: settings.theme,
        textSize: settings.textSize,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function resolveColorScheme(
  theme: ColorPreference,
  systemDark: boolean,
): "light" | "dark" {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

function prefersDark(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

/** Mount once per application. Preferences are independent of chat persistence. */
export function useReadingPreferences() {
  const [settings, setSettings] = useState<ReadingSettings>(() =>
    readReadingPreferences(),
  );
  const [systemDark, setSystemDark] = useState(prefersDark);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const resolvedTheme = resolveColorScheme(settings.theme, systemDark);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    changed();
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.colorScheme = resolvedTheme;
    document.documentElement.dataset.textSize = settings.textSize;
  }, [resolvedTheme, settings.textSize]);

  useEffect(() => {
    setStorageUnavailable(!saveReadingPreferences(settings));
  }, [settings]);

  return {
    settings,
    resolvedTheme,
    storageUnavailable,
    setTheme: (theme: ColorPreference) =>
      setSettings((value) => ({ ...value, theme })),
    setTextSize: (textSize: ReadingSize) =>
      setSettings((value) => ({ ...value, textSize })),
  };
}

/** Place one instance in the sidebar footer; no App state or props are required. */
export default function ReadingPreferences() {
  const { settings, resolvedTheme, storageUnavailable, setTheme, setTextSize } =
    useReadingPreferences();
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const groupId = useId();

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (
        details.current?.open &&
        event.target instanceof Node &&
        !details.current.contains(event.target)
      ) {
        details.current.open = false;
      }
    };
    const closeWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || !details.current?.open)
        return;
      event.preventDefault();
      // Closing settings must not also reach App's global stop-generation shortcut.
      event.stopPropagation();
      details.current.open = false;
      summary.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithEscape, true);
    };
  }, []);

  return (
    <details
      ref={details}
      className="reading-settings"
      data-testid="reading-settings"
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          event.currentTarget.open = false;
        }
      }}
    >
      <summary
        ref={summary}
        aria-label="阅读设置与快捷键"
        className="reading-settings-trigger"
      >
        <Settings2 size={16} aria-hidden="true" />
        <span>阅读设置</span>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="reading-settings-panel" aria-label="阅读偏好设置">
        <div className="reading-settings-heading">按你的习惯阅读</div>
        <fieldset>
          <legend>外观</legend>
          <div className="reading-options">
            {(
              [
                { value: "light", label: "浅色", Icon: Sun },
                { value: "dark", label: "深色", Icon: Moon },
                { value: "system", label: "跟随系统", Icon: Monitor },
              ] as const
            ).map(({ value, label, Icon }) => (
              <label className="reading-option" key={value}>
                <input
                  type="radio"
                  name={`${groupId}-theme`}
                  value={value}
                  checked={settings.theme === value}
                  onChange={() => setTheme(value)}
                />
                <Icon size={16} aria-hidden="true" />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <p className="reading-option-note" role="status">
            {settings.theme === "system"
              ? `跟随系统，当前为${resolvedTheme === "dark" ? "深色" : "浅色"}`
              : `已使用${resolvedTheme === "dark" ? "深色" : "浅色"}外观`}
          </p>
        </fieldset>
        <fieldset>
          <legend>
            <Type size={15} aria-hidden="true" /> 内容字号
          </legend>
          <div className="reading-options reading-size-options">
            {(
              [
                { value: "normal", label: "标准字号", text: "标准" },
                { value: "large", label: "大号字号", text: "大号" },
              ] as const
            ).map(({ value, label, text }) => (
              <label
                className={`reading-option reading-size-${value}`}
                key={value}
              >
                <input
                  type="radio"
                  aria-label={label}
                  name={`${groupId}-size`}
                  value={value}
                  checked={settings.textSize === value}
                  onChange={() => setTextSize(value)}
                />
                <span>{text}</span>
              </label>
            ))}
          </div>
          <p className="reading-preview">让回答、工具结果和引用都看得清楚。</p>
        </fieldset>
        <section className="reading-shortcuts" aria-label="键盘快捷键">
          <h3>
            <Keyboard size={16} aria-hidden="true" /> 键盘快捷键
          </h3>
          <dl>
            <div>
              <dt>
                <kbd>Enter</kbd>
              </dt>
              <dd>输入框内发送</dd>
            </div>
            <div>
              <dt>
                <kbd>Shift + Enter</kbd>
              </dt>
              <dd>输入框内换行</dd>
            </div>
            <div>
              <dt>
                <kbd>Ctrl / ⌘ + K</kbd>
              </dt>
              <dd>开启新对话</dd>
            </div>
            <div>
              <dt>
                <kbd>Ctrl / ⌘ + /</kbd>
              </dt>
              <dd>聚焦输入框</dd>
            </div>
            <div>
              <dt>
                <kbd>Esc</kbd>
              </dt>
              <dd>关闭浮层；否则停止生成</dd>
            </div>
          </dl>
        </section>
        {storageUnavailable && (
          <p className="reading-storage-notice" role="status">
            设置已在当前页面生效，浏览器暂时无法保存。
          </p>
        )}
      </div>
    </details>
  );
}
