import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

export interface DiskSession {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
  notifications?: SessionNotification[];
}

export interface AcpSessionDb extends vscode.Disposable {
  onDataChanged: vscode.Event<void>;
  listSessions(agent: string, cwd: string): Promise<DiskSession[]>;
  upsertSession(agent: string, info: DiskSession): Promise<void>;
  deleteSession(agent: string, sessionId: string): Promise<void>;
  deleteAllSessions(cwd: string): Promise<void>;
  hasSession(agent: string, sessionId: string): Promise<boolean>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_type TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd TEXT,
  title TEXT,
  updated_at DATETIME NOT NULL,
  UNIQUE(agent_type, session_id)
);`;

export function createAcpSessionDb(
  context: vscode.ExtensionContext,
  logger: vscode.LogOutputChannel,
): AcpSessionDb {
  return new SqliteSessionDb(context, logger);
}

class SqliteSessionDb implements AcpSessionDb {
  private db?: DatabaseSync;

  private readonly _onDataChanged = new vscode.EventEmitter<void>();
  readonly onDataChanged = this._onDataChanged.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: vscode.LogOutputChannel,
  ) {
    this.init();
  }

  private init(): void {
    const acpDir = path.join(this.context.globalStorageUri.fsPath, ".acp");
    if (!fs.existsSync(acpDir)) {
      fs.mkdirSync(acpDir, { recursive: true });
    }
    const dbPath = path.join(acpDir, "acp-sessions.db");
    this.logger.info(`Using ACP session database at: ${dbPath}`);
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    // Add notifications column if it doesn't exist
    const columns = this.db!.prepare(
      "PRAGMA table_info(sessions)",
    ).all() as Array<{ name: string }>;
    const hasNotifications = columns.some((c) => c.name === "notifications");
    if (!hasNotifications) {
      this.db!.exec("ALTER TABLE sessions ADD COLUMN notifications TEXT");
      this.logger.info("Migrated sessions table: added notifications column");
    }
  }

  async listSessions(agent: string, cwd: string): Promise<DiskSession[]> {
    const rows = this.db!.prepare(
      "SELECT session_id AS sessionId, cwd, title, updated_at AS updatedAt, notifications FROM sessions WHERE agent_type=? AND cwd=? ORDER BY updated_at DESC",
    ).all(agent, cwd) as Array<{
      sessionId: string;
      cwd: string;
      title: string;
      updatedAt: number;
      notifications: string | null;
    }>;
    return rows.map((row) => ({
      sessionId: row.sessionId,
      cwd: row.cwd,
      title: row.title,
      updatedAt: row.updatedAt,
      notifications: deserializeNotifications(row.notifications),
    }));
  }

  async upsertSession(agent: string, info: DiskSession): Promise<void> {
    const notificationsJson = info.notifications
      ? JSON.stringify(info.notifications)
      : null;
    const existing = this.db!.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE agent_type=? AND session_id=?",
    ).get(agent, info.sessionId) as { count: number };

    if (existing.count > 0) {
      const resp = this.db!.prepare(
        "UPDATE sessions SET cwd=?, title=?, updated_at=?, notifications=? WHERE agent_type=? AND session_id=?",
      ).run(
        info.cwd,
        info.title,
        info.updatedAt,
        notificationsJson,
        agent,
        info.sessionId,
      );
      if (resp.changes > 0) this._onDataChanged.fire();
    } else {
      const resp = this.db!.prepare(
        "INSERT OR IGNORE INTO sessions (agent_type, session_id, cwd, title, updated_at, notifications) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        agent,
        info.sessionId,
        info.cwd,
        info.title,
        info.updatedAt,
        notificationsJson,
      );
      if (resp.changes > 0) this._onDataChanged.fire();
    }
  }

  async deleteSession(agent: string, sessionId: string): Promise<void> {
    const resp = this.db!.prepare(
      "DELETE FROM sessions WHERE agent_type=? AND session_id=?",
    ).run(agent, sessionId);
    if (resp.changes > 0) this._onDataChanged.fire();
  }

  async deleteAllSessions(cwd: string): Promise<void> {
    const resp = this.db!.prepare("DELETE FROM sessions WHERE cwd=?").run(cwd);
    if (resp.changes > 0) this._onDataChanged.fire();
  }

  async hasSession(agent: string, sessionId: string): Promise<boolean> {
    const row = this.db!.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE agent_type=? AND session_id=?",
    ).get(agent, sessionId) as { count: number };
    return row.count > 0;
  }

  dispose(): void {
    this.db?.close();
    this._onDataChanged.dispose();
  }
}

function deserializeNotifications(
  raw: string | null,
): SessionNotification[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as SessionNotification[];
  } catch {
    // corrupted data, ignore
  }
  return undefined;
}
