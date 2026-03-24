import * as vscode from "vscode";
import { ChatSessionStatus } from "vscode";
import type {
  SessionConfigOption,
  SessionModelState,
  SessionModeState,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { AcpClient } from "../client";
import { createSessionUri, decodeVscodeResource } from "../chat/identifiers";
import { AcpTurnBuilder } from "./turn-builder";
import type { AcpAgentEntry } from "../types";
import type { AcpSessionDb, DiskSession } from "./session-db";

// ---------------------------------------------------------------------------
// Options type exposed to consumers
// ---------------------------------------------------------------------------

export type AcpOptions = {
  modes: SessionModeState | null;
  models: SessionModelState | null;
  thoughtLevelOptions: SessionConfigOption[] | null;
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Represents a single active ACP session.
 */
export class AcpSession {
  private _status: ChatSessionStatus = ChatSessionStatus.InProgress;
  private _title: string;
  private _updatedAt: number;
  private readonly _collectedNotifications: SessionNotification[] = [];
  pendingCancellation?: vscode.CancellationTokenSource;

  constructor(
    readonly agent: AcpAgentEntry,
    readonly vscodeResource: vscode.Uri,
    readonly client: AcpClient,
    readonly acpSessionId: string,
    readonly defaultChatOptions: { modeId: string; modelId: string },
    readonly cwd: string = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      process.cwd(),
  ) {
    this._title = `Session [${agent.id}] ${acpSessionId}`;
    this._updatedAt = Date.now();
  }

  get title(): string {
    return this._title;
  }
  set title(value: string) {
    this._title = value;
  }

  get updatedAt(): number {
    return this._updatedAt;
  }

  get status(): ChatSessionStatus {
    return this._status;
  }

  get collectedNotifications(): readonly SessionNotification[] {
    return this._collectedNotifications;
  }

  pushNotification(notification: SessionNotification): void {
    this._collectedNotifications.push(notification);
  }

  markInProgress(): void {
    this._status = ChatSessionStatus.InProgress;
    this._updatedAt = Date.now();
  }
  markCompleted(): void {
    this._status = ChatSessionStatus.Completed;
    this._updatedAt = Date.now();
  }
  markFailed(): void {
    this._status = ChatSessionStatus.Failed;
    this._updatedAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

/**
 * ACP session manager that creates, tracks, and persists sessions for a
 * single agent. Supports option change events and history restoration.
 */
export class AcpSessionManager implements vscode.Disposable {
  private readonly activeSessions = new Map<string, AcpSession>();
  private readonly sessionSubscriptions = new Map<
    string,
    vscode.Disposable[]
  >();
  private diskSessions: Map<string, DiskSession> | null = null;
  private lastKnownModelId: string | null = null;

  private cachedOptions: AcpOptions = {
    modes: null,
    models: null,
    thoughtLevelOptions: null,
  };

  // Events
  private readonly _onDidChangeSession = new vscode.EventEmitter<{
    original: AcpSession;
    modified: AcpSession;
  }>();
  readonly onDidChangeSession = this._onDidChangeSession.event;

  private readonly _onDidOptionsChange = new vscode.EventEmitter<void>();
  readonly onDidOptionsChange = this._onDidOptionsChange.event;

  private readonly _onDidCurrentModeChange = new vscode.EventEmitter<{
    resource: vscode.Uri;
    modeId: string;
  }>();
  readonly onDidCurrentModeChange = this._onDidCurrentModeChange.event;

  private readonly _onDidCurrentModelChange = new vscode.EventEmitter<{
    resource: vscode.Uri;
    modelId: string;
  }>();
  readonly onDidCurrentModelChange = this._onDidCurrentModelChange.event;

  private readonly _onDidUsageUpdate = new vscode.EventEmitter<{
    modelId: string;
    maxWindowSize: number;
  }>();
  readonly onDidUsageUpdate = this._onDidUsageUpdate.event;

  constructor(
    private readonly agent: AcpAgentEntry,
    private readonly logChannel: vscode.LogOutputChannel,
    private readonly sessionDb?: AcpSessionDb,
  ) {
    if (sessionDb) {
      sessionDb.onDataChanged(async () => {
        await this.loadDiskSessionsIfNeeded(true);
      });
    }
  }

  /**
   * Create or retrieve a session for the given VS Code resource URI.
   * For untitled resources, spawns a new ACP session.
   * For existing resources, loads the session from persistence.
   */
  async createOrGet(vscodeResource: vscode.Uri): Promise<{
    session: AcpSession;
    history?: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2>;
  }> {
    const decoded = decodeVscodeResource(vscodeResource);

    if (decoded.isUntitled) {
      const existing = this.activeSessions.get(decoded.sessionId);
      if (existing) return { session: existing };

      const client = new AcpClient(this.agent, this.logChannel);
      this.wireClientSubscriptions(decoded.sessionId, client);

      const cwd = getWorkspaceCwd();
      const acpResponse = await client.createSession(
        cwd,
        this.agent.mcpServers,
      );
      this.cachedOptions = this.buildOptions(client);
      this._onDidOptionsChange.fire();

      const session = new AcpSession(
        this.agent,
        vscodeResource,
        client,
        acpResponse.sessionId,
        {
          modeId: acpResponse.modes?.currentModeId ?? "",
          modelId: acpResponse.models?.currentModelId ?? "",
        },
        cwd,
      );
      this.activeSessions.set(decoded.sessionId, session);

      this._onDidChangeSession.fire({
        original: session,
        modified: session,
      });
      return { session };
    }

    // Non-untitled: try to load from disk
    const diskSession = await this.getDiskSession(vscodeResource);
    if (!diskSession) {
      throw new Error(
        `No existing session found for resource ${vscodeResource.toString()}`,
      );
    }

    const savedNotifications = diskSession.notifications;
    this.logChannel.info(
      `[acp:${this.agent.id}] Loading disk session ${diskSession.sessionId}, has ${savedNotifications?.length ?? 0} saved notifications`,
    );

    // Fast path: if we have locally saved notifications, skip the slow
    // loadSession attempt (which may not be supported by the agent) and
    // create a fresh session directly with the local history.
    if (savedNotifications?.length) {
      const client = new AcpClient(this.agent, this.logChannel);
      this.wireClientSubscriptions(decoded.sessionId, client);

      const cwd = diskSession.cwd || getWorkspaceCwd();
      const acpResponse = await client.createSession(
        cwd,
        this.agent.mcpServers,
      );
      this.cachedOptions = this.buildOptions(client);
      this._onDidOptionsChange.fire();

      const session = new AcpSession(
        this.agent,
        vscodeResource,
        client,
        acpResponse.sessionId,
        {
          modeId: acpResponse.modes?.currentModeId ?? "",
          modelId: acpResponse.models?.currentModelId ?? "",
        },
        cwd,
      );
      this.activeSessions.set(decoded.sessionId, session);

      const turnBuilder = new AcpTurnBuilder(
        `acp-${this.agent.id}`,
        this.logChannel,
      );
      for (const notification of savedNotifications) {
        turnBuilder.processNotification(notification);
      }
      const history = turnBuilder.getTurns();
      this.logChannel.info(
        `[acp:${this.agent.id}] Reconstructed ${history.length} history turns from local notifications.`,
      );
      return { session, history };
    }

    // Slow path: no local notifications, try agent's loadSession
    const client = new AcpClient(this.agent, this.logChannel);
    this.wireClientSubscriptions(decoded.sessionId, client);

    try {
      const response = await client.loadSession(
        diskSession.sessionId,
        diskSession.cwd,
        this.agent.mcpServers,
      );
      this.cachedOptions = this.buildOptions(client);
      this._onDidOptionsChange.fire();

      const session = new AcpSession(
        this.agent,
        vscodeResource,
        client,
        diskSession.sessionId,
        {
          modeId: response.modeId ?? "",
          modelId: response.modelId ?? "",
        },
        diskSession.cwd,
      );
      this.activeSessions.set(decoded.sessionId, session);

      const turnBuilder = new AcpTurnBuilder(
        `acp-${this.agent.id}`,
        this.logChannel,
      );
      for (const notification of response.notifications) {
        turnBuilder.processNotification(notification);
      }
      const history = turnBuilder.getTurns();
      this.logChannel.debug(
        `Resuming session with ${history.length} history turns from agent.`,
      );
      return { session, history };
    } catch (error) {
      // loadSession failed (agent may not support it, or session is stale).
      // Fall back to creating a fresh session so the tab still opens.
      this.logChannel.warn(
        `[acp:${this.agent.id}] Failed to load session ${diskSession.sessionId}, creating new session instead: ${error instanceof Error ? error.message : String(error)}`,
      );
      client.dispose();
      this.sessionSubscriptions
        .get(decoded.sessionId)
        ?.forEach((s) => s.dispose());
      this.sessionSubscriptions.delete(decoded.sessionId);

      const freshClient = new AcpClient(this.agent, this.logChannel);
      this.wireClientSubscriptions(decoded.sessionId, freshClient);

      const cwd = diskSession.cwd || getWorkspaceCwd();
      const acpResponse = await freshClient.createSession(
        cwd,
        this.agent.mcpServers,
      );
      this.cachedOptions = this.buildOptions(freshClient);
      this._onDidOptionsChange.fire();

      const session = new AcpSession(
        this.agent,
        vscodeResource,
        freshClient,
        acpResponse.sessionId,
        {
          modeId: acpResponse.modes?.currentModeId ?? "",
          modelId: acpResponse.models?.currentModelId ?? "",
        },
        cwd,
      );
      this.activeSessions.set(decoded.sessionId, session);
      return { session };
    }
  }

  getActive(vscodeResource: vscode.Uri | undefined): AcpSession | undefined {
    if (!vscodeResource) return undefined;
    const decoded = decodeVscodeResource(vscodeResource);
    return this.activeSessions.get(decoded.sessionId);
  }

  createSessionUri(session: AcpSession): vscode.Uri {
    const uri = createSessionUri(this.agent.id, session.acpSessionId);
    // Replace session entry if it already exists under a different key
    const entry = Array.from(this.activeSessions).find(
      (s) => s[1].acpSessionId === session.acpSessionId,
    );
    if (entry) {
      this.activeSessions.delete(entry[0]);
      const subs = this.sessionSubscriptions.get(entry[0]);
      if (subs) {
        this.sessionSubscriptions.delete(entry[0]);
        this.sessionSubscriptions.set(session.acpSessionId, subs);
      }
    }
    this.activeSessions.set(session.acpSessionId, session);
    return uri;
  }

  async syncSessionState(
    vscodeResource: vscode.Uri,
    modified: AcpSession,
  ): Promise<void> {
    const decoded = decodeVscodeResource(vscodeResource);
    const original = this.activeSessions.get(decoded.sessionId);
    if (!original) return;
    this.activeSessions.set(decoded.sessionId, modified);
    this._onDidChangeSession.fire({ original, modified });
  }

  async getOptions(): Promise<AcpOptions> {
    return this.cachedOptions;
  }

  async listSessions(): Promise<vscode.ChatSessionItem[]> {
    await this.loadDiskSessionsIfNeeded();
    if (!this.diskSessions) return [];

    const items: vscode.ChatSessionItem[] = [];
    for (const [sessionId, session] of this.diskSessions) {
      const resource = createSessionUri(this.agent.id, sessionId);
      items.push({
        label: session.title || session.sessionId,
        status: ChatSessionStatus.Completed,
        resource,
        timing: { created: Number(session.updatedAt) },
      });
    }
    return items;
  }

  closeSession(vscodeResource: vscode.Uri): void {
    const decoded = decodeVscodeResource(vscodeResource);
    const session = this.activeSessions.get(decoded.sessionId);
    if (!session) return;

    session.pendingCancellation?.cancel();
    session.pendingCancellation = undefined;
    session.markFailed();
    this._onDidChangeSession.fire({ original: session, modified: session });

    this.sessionSubscriptions
      .get(decoded.sessionId)
      ?.forEach((s) => s.dispose());
    this.sessionSubscriptions.delete(decoded.sessionId);
    session.client.dispose();
    this.activeSessions.delete(decoded.sessionId);
    this.logChannel.info(
      `[acp:${this.agent.id}] Closed session ${decoded.sessionId}`,
    );
  }

  reportContextWindowSize(
    session: AcpSession,
    args: { size: number; used: number },
  ): void {
    this._onDidUsageUpdate.fire({
      modelId: session.defaultChatOptions.modelId,
      maxWindowSize: args.size,
    });
  }

  dispose(): void {
    for (const [id, session] of this.activeSessions) {
      session.pendingCancellation?.cancel();
      this.sessionSubscriptions.get(id)?.forEach((s) => s.dispose());
      session.client.dispose();
    }
    this.activeSessions.clear();
    this.sessionSubscriptions.clear();
    this._onDidChangeSession.dispose();
    this._onDidOptionsChange.dispose();
    this._onDidCurrentModeChange.dispose();
    this._onDidCurrentModelChange.dispose();
    this._onDidUsageUpdate.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private wireClientSubscriptions(sessionKey: string, client: AcpClient): void {
    const subs: vscode.Disposable[] = [];
    subs.push(
      client.onDidStop(() => {
        this.logChannel.info(
          `[acp:${this.agent.id}] Agent process stopped for session ${sessionKey}`,
        );
      }),
    );
    subs.push(
      client.onSessionUpdate((update) =>
        this.handlePreChatSessionUpdate(update),
      ),
    );
    subs.push(
      client.onDidOptionsChanged(() => {
        const newOptions = this.buildOptions(client);
        this.detectAndFireModelChange(newOptions);
        this.cachedOptions = newOptions;
        this._onDidOptionsChange.fire();
      }),
    );
    this.sessionSubscriptions.set(sessionKey, subs);
  }

  private buildOptions(client: AcpClient): AcpOptions {
    return {
      modes: client.getSupportedModeState(),
      models: client.getSupportedModelState(),
      thoughtLevelOptions: client
        .getConfigOptions()
        .filter((o) => o.category === "thought_level"),
    };
  }

  private detectAndFireModelChange(newOptions: AcpOptions): void {
    const newModelId = newOptions.models?.currentModelId ?? null;
    if (newModelId !== null && newModelId !== this.lastKnownModelId) {
      this.lastKnownModelId = newModelId;
      for (const session of this.activeSessions.values()) {
        this._onDidCurrentModelChange.fire({
          resource: session.vscodeResource,
          modelId: newModelId,
        });
      }
    }
  }

  private handlePreChatSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate === "current_mode_update") {
      for (const session of this.activeSessions.values()) {
        if (session.acpSessionId === notification.sessionId) {
          this._onDidCurrentModeChange.fire({
            resource: session.vscodeResource,
            modeId: update.currentModeId,
          });
          break;
        }
      }
    }
  }

  private async getDiskSession(
    vscodeResource: vscode.Uri,
  ): Promise<DiskSession | undefined> {
    const decoded = decodeVscodeResource(vscodeResource);
    await this.loadDiskSessionsIfNeeded();
    return this.diskSessions?.get(decoded.sessionId);
  }

  private async loadDiskSessionsIfNeeded(
    reload: boolean = false,
  ): Promise<void> {
    if (!this.sessionDb) return;
    if (this.diskSessions && !reload) return;
    const cwd = getWorkspaceCwd();
    const data = await this.sessionDb.listSessions(this.agent.id, cwd);
    this.diskSessions = new Map(data.map((s) => [s.sessionId, s]));
  }
}

function getWorkspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}
