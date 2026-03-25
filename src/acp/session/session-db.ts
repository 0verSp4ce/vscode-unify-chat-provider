import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
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
  return new AsyncSqliteSessionDb(context, logger);
}

class AsyncSqliteSessionDb implements AcpSessionDb {
  private db: Database.Database | null = null;
  private dbPath: string;
  private isInitialized: boolean = false;

  private readonly _onDataChanged = new vscode.EventEmitter<void>();
  readonly onDataChanged = this._onDataChanged.event;

  constructor(
    context: vscode.ExtensionContext,
    private readonly logger: vscode.LogOutputChannel,
  ) {
    const acpDir = path.join(context.globalStorageUri.fsPath, ".acp");
    if (!fs.existsSync(acpDir)) {
      fs.mkdirSync(acpDir, { recursive: true });
    }
    this.dbPath = path.join(acpDir, "acp-sessions.db");
    this.logger.info(`Using ACP session database at: ${this.dbPath}`);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized && this.db) return;
    
    try {
      this.db = new Database(this.dbPath);
      this.db.exec(SCHEMA);
      await this.migrate();
      this.isInitialized = true;
    } catch (error) {
      this.logger.error(`Failed to initialize database: ${error}`);
      throw error;
    }
  }

  private async migrate(): Promise<void> {
    if (!this.db) return;
    
    try {
      const columns = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
      const hasNotifications = columns.some((c) => c.name === "notifications");
      if (!hasNotifications) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN notifications TEXT");
        this.logger.info("Migrated sessions table: added notifications column");
      }
    } catch (error) {
      this.logger.error(`Migration failed: ${error}`);
      throw error;
    }
  }

  async listSessions(agent: string, cwd: string): Promise<DiskSession[]> {
    await this.ensureInitialized();
    if (!this.db) throw new Error("Database not initialized");

    try {
      const stmt = this.db.prepare(
        "SELECT session_id AS sessionId, cwd, title, updated_at AS updatedAt, notifications FROM sessions WHERE agent_type=? AND cwd=? ORDER BY updated_at DESC"
      );
      const rows = stmt.all(agent, cwd) as Array<{
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
    } catch (error) {
      this.logger.error(`Failed to list sessions: ${error}`);
      throw error;
    }
  }

  async upsertSession(agent: string, info: DiskSession): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) throw new Error("Database not initialized");

    try {
      const notificationsJson = info.notifications
        ? JSON.stringify(info.notifications)
        : null;
        
      const stmt = this.db.prepare(
        `INSERT INTO sessions (agent_type, session_id, cwd, title, updated_at, notifications)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_type, session_id) DO UPDATE SET
           cwd=excluded.cwd, title=excluded.title,
           updated_at=excluded.updated_at, notifications=excluded.notifications`
      );
      
      const resp = stmt.run(
        agent,
        info.sessionId,
        info.cwd,
        info.title,
        info.updatedAt,
        notificationsJson,
      );
      
      if (resp.changes > 0) this._onDataChanged.fire();
    } catch (error) {
      this.logger.error(`Failed to upsert session: ${error}`);
      throw error;
    }
  }

  async deleteSession(agent: string, sessionId: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) throw new Error("Database not initialized");

    try {
      const stmt = this.db.prepare(
        "DELETE FROM sessions WHERE agent_type=? AND session_id=?"
      );
      const resp = stmt.run(agent, sessionId);
      
      if (resp.changes > 0) this._onDataChanged.fire();
    } catch (error) {
      this.logger.error(`Failed to delete session: ${error}`);
      throw error;
    }
  }

  async deleteAllSessions(cwd: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) throw new Error("Database not initialized");

    try {
      const stmt = this.db.prepare("DELETE FROM sessions WHERE cwd=?");
      const resp = stmt.run(cwd);
      if (resp.changes > 0) this._onDataChanged.fire();
    } catch (error) {
      this.logger.error(`Failed to delete all sessions: ${error}`);
      throw error;
    }
  }

  async hasSession(agent: string, sessionId: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.db) throw new Error("Database not initialized");

    try {
      const stmt = this.db.prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE agent_type=? AND session_id=?"
      );
      const row = stmt.get(agent, sessionId) as { count: number };
      return row.count > 0;
    } catch (error) {
      this.logger.error(`Failed to check session existence: ${error}`);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch (error) {
        this.logger.error(`Failed to close database: ${error}`);
      }
    }
    this.db = null;
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
