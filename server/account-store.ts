import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export interface AccountRow {
  id: string;
  username: string;
  salt: string;
  password_hash: string;
}
export interface WorkspaceRow {
  revision: number;
  updated_at: number | null;
  state_json: string | null;
}

export function openAccountStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS account_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, normalized_username TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS account_session_expiry ON account_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS account_workspaces (
      user_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 0, state_json TEXT, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS account_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, started_at INTEGER NOT NULL);`);
  db.prepare(
    "INSERT OR IGNORE INTO account_meta (key, value) VALUES (?, ?)",
  ).run("guest_secret", randomBytes(32).toString("hex"));
  const guestSecret = (
    db
      .prepare("SELECT value FROM account_meta WHERE key = ?")
      .get("guest_secret") as { value: string }
  ).value;
  return {
    guestSecret,
    byUsername(name: string) {
      return db
        .prepare(
          "SELECT id, username, salt, password_hash FROM accounts WHERE normalized_username = ?",
        )
        .get(name) as unknown as AccountRow | undefined;
    },
    create(
      username: string,
      normalized: string,
      salt: string,
      hash: string,
      now: number,
    ): AccountRow | null {
      const id = randomUUID();
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          db
            .prepare("SELECT id FROM accounts WHERE normalized_username = ?")
            .get(normalized)
        ) {
          db.exec("ROLLBACK");
          return null;
        }
        db.prepare("INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)").run(
          id,
          username,
          normalized,
          salt,
          hash,
          now,
        );
        db.prepare("INSERT INTO account_workspaces (user_id) VALUES (?)").run(
          id,
        );
        db.exec("COMMIT");
        return { id, username, salt, password_hash: hash };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    session(tokenHash: string, now: number) {
      return db
        .prepare(
          "SELECT a.id, a.username FROM account_sessions s JOIN accounts a ON a.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
        )
        .get(tokenHash, now) as { id: string; username: string } | undefined;
    },
    setSession(hash: string, userId: string, expires: number, now: number) {
      db.prepare("DELETE FROM account_sessions WHERE expires_at <= ?").run(now);
      db.prepare("INSERT INTO account_sessions VALUES (?, ?, ?)").run(
        hash,
        userId,
        expires,
      );
    },
    deleteSession(hash: string) {
      db.prepare("DELETE FROM account_sessions WHERE token_hash = ?").run(hash);
    },
    workspace(userId: string): WorkspaceRow {
      return db
        .prepare(
          "SELECT revision, state_json, updated_at FROM account_workspaces WHERE user_id = ?",
        )
        .get(userId) as unknown as WorkspaceRow;
    },
    updateWorkspace(
      userId: string,
      expected: number,
      state: string,
      now: number,
    ) {
      return (
        db
          .prepare(
            "UPDATE account_workspaces SET revision = revision + 1, state_json = ?, updated_at = ? WHERE user_id = ? AND revision = ?",
          )
          .run(state, now, userId, expected).changes === 1
      );
    },
    consumeAttempt(
      key: string,
      now: number,
      windowMs: number,
      limit: number,
    ): number {
      db.prepare("DELETE FROM account_attempts WHERE started_at <= ?").run(
        now - windowMs,
      );
      const row = db
        .prepare("SELECT count, started_at FROM account_attempts WHERE key = ?")
        .get(key) as { count: number; started_at: number } | undefined;
      if (row && row.count >= limit)
        return Math.max(1, Math.ceil((row.started_at + windowMs - now) / 1000));
      db.prepare(
        "INSERT INTO account_attempts VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1",
      ).run(key, now);
      return 0;
    },
    clearAttempt(key: string) {
      db.prepare("DELETE FROM account_attempts WHERE key = ?").run(key);
    },
    close() {
      db.close();
    },
  };
}
