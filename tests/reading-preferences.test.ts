import { describe, expect, it } from "vitest";
import {
  parseReadingPreferences,
  readReadingPreferences,
  READING_PREFERENCES_KEY,
  resolveColorScheme,
  saveReadingPreferences,
} from "../src/ReadingPreferences";

describe("reading preferences persistence", () => {
  it("restores valid choices and writes only the dedicated versioned preference record", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(
      saveReadingPreferences({ theme: "dark", textSize: "large" }, storage),
    ).toBe(true);
    expect([...values.keys()]).toEqual([READING_PREFERENCES_KEY]);
    expect(JSON.parse(values.get(READING_PREFERENCES_KEY)!)).toEqual({
      version: 1,
      theme: "dark",
      textSize: "large",
    });
    expect(readReadingPreferences(storage)).toEqual({
      theme: "dark",
      textSize: "large",
    });
  });

  it("rejects malformed, future and oversized records without leaking unknown values", () => {
    for (const raw of [
      null,
      "{broken",
      "null",
      "[]",
      "1",
      JSON.stringify({ version: 2, theme: "dark", textSize: "large" }),
      " ".repeat(1001),
    ]) {
      expect(parseReadingPreferences(raw)).toEqual({
        theme: "system",
        textSize: "normal",
      });
    }
    expect(
      parseReadingPreferences(
        JSON.stringify({
          version: 1,
          theme: { malicious: true },
          textSize: "huge",
        }),
      ),
    ).toEqual({ theme: "system", textSize: "normal" });
    expect(
      parseReadingPreferences(
        JSON.stringify({
          version: 1,
          theme: "light",
          textSize: "invalid",
          unknown: "ignored",
        }),
      ),
    ).toEqual({ theme: "light", textSize: "normal" });
  });

  it("falls back safely when browser storage access is denied and reports writes that fail", () => {
    expect(
      readReadingPreferences({
        getItem() {
          throw new Error("Denied");
        },
      }),
    ).toEqual({ theme: "system", textSize: "normal" });
    expect(
      saveReadingPreferences(
        { theme: "light", textSize: "normal" },
        {
          setItem() {
            throw new Error("Quota exceeded");
          },
        },
      ),
    ).toBe(false);
  });

  it("follows system appearance only when the user selected system", () => {
    expect(resolveColorScheme("system", true)).toBe("dark");
    expect(resolveColorScheme("system", false)).toBe("light");
    expect(resolveColorScheme("light", true)).toBe("light");
    expect(resolveColorScheme("dark", false)).toBe("dark");
  });
});
