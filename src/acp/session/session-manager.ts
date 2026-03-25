import * as vscode from "vscode";
import { ChatSessionStatus } from "vscode";
import type {
  SessionConfigOption,
  SessionModelState,
  SessionModeState,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { AcpClient } from "../client";
import { createSessionUri, decodeVscodeResource, getWorkspaceCwd } from "../chat/identifiers";
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

const EMPTY_OPTIONS: AcpOptions = {
  modes: null,
  models: null,
  thoughtLevelOptions: null,
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Safety cap for in-memory notification collection per session. */
const MAX_COLLECTED_NOTIFICATIONS = 1000;
/** Time-based cleanup threshold (24 hours) */
const NOTIFICATION_CLEANUP_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Represents a single active ACP session.
 */
export class AcpSession {
  private _status: ChatSessionStatus = ChatSessionStatus.InProgress;
  private _title: string;
  private _updatedAt: number;
  private _collectedNotifications: SessionNotification[] = [];
  private _pendingCancellation?: vscode.CancellationTokenSource;
  private _lastCleanupTime: number = Date.now();
  private readonly logChannel: vscode.LogOutputChannel;

  constructor(
    readonly agent: AcpAgentEntry,
    readonly vscodeResource: vscode.Uri,
    readonly client: AcpClient,
    readonly acpSessionId: string,
    readonly defaultChatOptions: { modeId: string; modelId: string },
    readonly cwd: string = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      process.cwd(),
    logChannel?: vscode.LogOutputChannel,
  ) {
    this._title = `Session [${agent.id}] ${acpSessionId}`;
    this._updatedAt = Date.now();
    this.logChannel = logChannel ?? vscode.window.createOutputChannel('ACPSession', { log: true });
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
    const now = Date.now();
    
    // Perform periodic cleanup to prevent memory leaks
    if (now - this._lastCleanupTime > NOTIFICATION_CLEANUP_THRESHOLD_MS) {
      this.cleanupOldNotifications(now);
      this._lastCleanupTime = now;
    }
    
    // Enforce size limit with more aggressive trimming
    if (this._collectedNotifications.length >= MAX_COLLECTED_NOTIFICATIONS) {
      // Drop oldest 25% to maintain reasonable buffer while preventing unbounded growth
      const dropCount = Math.floor(MAX_COLLECTED_NOTIFICATIONS * 0.25);
      this._collectedNotifications = this._collectedNotifications.slice(dropCount);
      this._updatedAt = now;
    }
    
    this._collectedNotifications.push(notification);
  }

  /** Clean up notifications older than the threshold */
  private cleanupOldNotifications(currentTime: number): void {
    const cutoffTime = currentTime - NOTIFICATION_CLEANUP_THRESHOLD_MS;
    const initialLength = this._collectedNotifications.length;
    
    this._collectedNotifications = this._collectedNotifications.filter(
      notification => {
        // Check if notification has timestamp and is newer than cutoff
        // If no timestamp available, keep it but still enforce size limits elsewhere
        const timestamp = this.extractTimestampFromNotification(notification);
        return timestamp === null || timestamp >= cutoffTime;
      }
    );
    
    if (this._collectedNotifications.length < initialLength) {
      this._updatedAt = currentTime;
      this.logChannel.debug(
        `[acp:${this.agent.id}] Cleaned up ${initialLength - this._collectedNotifications.length} old notifications`
      );
    }
  }

  /** Extract timestamp from notification, returns null if not available */
  private extractTimestampFromNotification(notification: SessionNotification): number | null {
    // Try common timestamp fields that notifications might have
    if ('timestamp' in notification && typeof notification.timestamp === 'number') {
      return notification.timestamp;
    }
    if ('createdAt' in notification && typeof notification.createdAt === 'number') {
      return notification.createdAt;
    }
    if ('time' in notification && typeof notification.time === 'number') {
      return notification.time;
    }
    // If no timestamp found, return null to indicate unknown age
    return null;
  }

  /** Drain collected notifications, clearing the in-memory buffer. */
  drainCollectedNotifications(): SessionNotification[] {
    const drained = this._collectedNotifications;
    this._collectedNotifications = [];
    return drained;
  }

  // -- Cancellation management -----------------------------------------------

  /**
   * Replace the current pending cancellation with a new one, cancelling
   * any previously pending operation.
   */
  replacePendingCancellation(cts: vscode.CancellationTokenSource): void {
    this._pendingCancellation?.cancel();
    this._pendingCancellation = cts;
  }

  /** Clear the pending cancellation reference (without cancelling). */
  clearPendingCancellation(): void {
    this._pendingCancellation = undefined;
  }

  /** Cancel the pending operation and clear the reference. */
  cancelPending(): void {
    this._pendingCancellation?.cancel();
    this._pendingCancellation = undefined;
  }

  // -- Status helpers --------------------------------------------------------

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
  private loadingPromise: Promise<void> | null = null;
  private isCurrentlyLoading: boolean = false;

  /**
   * The client from the most recently created/loaded session.
   * Used to derive provider-level options on demand.
   * Note: This should not be cached across sessions as each session
   * may have different options state.
   */
  private lastActiveClient: AcpClient | null = null;

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
      sessionDb.onDataChanged(() => {
        this.loadDiskSessionsIfNeeded(true).catch(error => {
          this.logChannel.error(`Failed to reload disk sessions: ${error}`);
        });
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
      return this.handleUntitledResource(decoded.sessionId, vscodeResource);
    } else {
      return this.handleExistingResource(decoded.sessionId, vscodeResource);
    }
  }

  private async handleUntitledResource(
    sessionId: string,
    vscodeResource: vscode.Uri
  ): Promise<{ session: AcpSession }> {
    const existing = this.activeSessions.get(sessionId);
    if (existing) return { session: existing };

    const session = await this.spawnNewSession(
      sessionId,
      vscodeResource,
      getWorkspaceCwd(),
    );
    this._onDidChangeSession.fire({
      original: session,
      modified: session,
    });
    return { session };
  }

  private async handleExistingResource(
    sessionId: string,
    vscodeResource: vscode.Uri
  ): Promise<{
    session: AcpSession;
    history?: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2>;
  }> {
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
      return this.createSessionWithLocalHistory(diskSession, vscodeResource);
    }

    // Slow path: no local notifications, try agent's loadSession
    return this.loadExistingSession(sessionId, vscodeResource, diskSession);
  }

  private async createSessionWithLocalHistory(
    diskSession: DiskSession,
    vscodeResource: vscode.Uri
  ): Promise<{
    session: AcpSession;
    history: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2>;
  }> {
    const cwd = diskSession.cwd || getWorkspaceCwd();
    const session = await this.spawnNewSession(
      decodeVscodeResource(vscodeResource).sessionId,
      vscodeResource,
      cwd,
    );

    const history = this.buildHistoryFromNotifications(diskSession.notifications!);
    this.logChannel.info(
      `[acp:${this.agent.id}] Reconstructed ${history.length} history turns from local notifications.`,
    );
    return { session, history };
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

  /**
   * Build provider-level options on demand from the most recently active
   * client. Each session maintains its own options state to prevent
   * cross-session contamination.
   */
  getOptions(): AcpOptions {
    if (!this.lastActiveClient) return EMPTY_OPTIONS;
    
    // Validate that the client is still active and not disposed
    try {
      // Attempt to access a property to verify the client is still functional
      this.lastActiveClient.getSupportedModeState();
      return this.buildOptions(this.lastActiveClient);
    } catch (error) {
      this.logChannel.debug(
        `[acp:${this.agent.id}] Cached client is invalid, returning empty options: ${error instanceof Error ? error.message : String(error)}`
      );
      this.lastActiveClient = null;
      return EMPTY_OPTIONS;
    }
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

    session.cancelPending();
    session.markFailed();
    this._onDidChangeSession.fire({ original: session, modified: session });

    this.sessionSubscriptions
      .get(decoded.sessionId)
      ?.forEach((s) => s.dispose());
    this.sessionSubscriptions.delete(decoded.sessionId);

    if (session.client === this.lastActiveClient) {
      this.lastActiveClient = this.pickFallbackClient(decoded.sessionId);
    }
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
      session.cancelPending();
      this.sessionSubscriptions.get(id)?.forEach((s) => s.dispose());
      session.client.dispose();
    }
    this.activeSessions.clear();
    this.sessionSubscriptions.clear();
    this.lastActiveClient = null;
    this._onDidChangeSession.dispose();
    this._onDidOptionsChange.dispose();
    this._onDidCurrentModeChange.dispose();
    this._onDidCurrentModelChange.dispose();
    this._onDidUsageUpdate.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internal — session creation helpers
  // ---------------------------------------------------------------------------

  /**
   * Spawn a new ACP session: create client, wire events, call createSession,
   * and register the session in the active map.
   */
  private async spawnNewSession(
    sessionKey: string,
    vscodeResource: vscode.Uri,
    cwd: string,
  ): Promise<AcpSession> {
    const client = this.createClientForSession(sessionKey);
    const acpResponse = await client.createSession(cwd);
    this.setActiveClient(client);

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
      this.logChannel,
    );
    this.activeSessions.set(sessionKey, session);
    return session;
  }

  /**
   * Slow path: try agent's loadSession, fall back to spawnNewSession on error.
   */
  private async loadExistingSession(
    sessionKey: string,
    vscodeResource: vscode.Uri,
    diskSession: DiskSession,
  ): Promise<{
    session: AcpSession;
    history?: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2>;
  }> {
    const client = this.createClientForSession(sessionKey);

    try {
      const response = await client.loadSession(
        diskSession.sessionId,
        diskSession.cwd,
      );
      this.setActiveClient(client);

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
        this.logChannel,
      );
      this.activeSessions.set(sessionKey, session);

      const history = this.buildHistoryFromNotifications(response.notifications);
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
      this.disposeClientAndSubscriptions(sessionKey, client);

      const cwd = diskSession.cwd || getWorkspaceCwd();
      const session = await this.spawnNewSession(sessionKey, vscodeResource, cwd);
      return { session };
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — client helpers
  // ---------------------------------------------------------------------------

  private createClientForSession(sessionKey: string): AcpClient {
    const client = new AcpClient(this.agent, this.logChannel);
    this.wireClientSubscriptions(sessionKey, client);
    return client;
  }

  private setActiveClient(client: AcpClient): void {
    this.lastActiveClient = client;
    this._onDidOptionsChange.fire();
  }

  private disposeClientAndSubscriptions(sessionKey: string, client: AcpClient): void {
    client.dispose();
    this.sessionSubscriptions
      .get(sessionKey)
      ?.forEach((s) => s.dispose());
    this.sessionSubscriptions.delete(sessionKey);
  }

  /** Pick a fallback client from remaining sessions, or null. */
  private pickFallbackClient(excludeSessionKey: string): AcpClient | null {
    for (const [key, session] of this.activeSessions) {
      if (key !== excludeSessionKey) return session.client;
    }
    return null;
  }

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
        this.lastActiveClient = client;
        const newOptions = this.buildOptions(client);
        this.detectAndFireModelChange(newOptions);
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

  // ---------------------------------------------------------------------------
  // Internal — event handling
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Internal — history
  // ---------------------------------------------------------------------------

  private buildHistoryFromNotifications(
    notifications: SessionNotification[],
  ): Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> {
    const turnBuilder = new AcpTurnBuilder(`acp-${this.agent.id}`);
    for (const notification of notifications) {
      turnBuilder.processNotification(notification);
    }
    return turnBuilder.getTurns();
  }

  // ---------------------------------------------------------------------------
  // Internal — disk persistence
  // ---------------------------------------------------------------------------

  private async getDiskSession(
    vscodeResource: vscode.Uri,
  ): Promise<DiskSession | undefined> {
    const decoded = decodeVscodeResource(vscodeResource);
    await this.loadDiskSessionsIfNeeded();
    return this.diskSessions?.get(decoded.sessionId);
  }

  private async loadDiskSessionsIfNeeded(reload: boolean = false): Promise<void> {
    if (!this.sessionDb) return;
    if (this.diskSessions && !reload) return;
    
    // Prevent concurrent loading
    if (this.isCurrentlyLoading) {
      // Wait for existing loading to complete
      if (this.loadingPromise) {
        await this.loadingPromise;
      }
      return;
    }

    this.isCurrentlyLoading = true;
    const cwd = getWorkspaceCwd();
    
    try {
      this.loadingPromise = this.sessionDb.listSessions(this.agent.id, cwd).then(data => {
        this.diskSessions = new Map(data.map((s) => [s.sessionId, s]));
      }).catch(error => {
        this.logChannel.error(`Failed to load disk sessions: ${error}`);
        this.diskSessions = new Map();
      }).finally(() => {
        this.isCurrentlyLoading = false;
        this.loadingPromise = null;
      });
      
      await this.loadingPromise;
    } catch (error) {
      this.isCurrentlyLoading = false;
      this.loadingPromise = null;
      throw error;
    }
  }
}

// Removed duplicate getWorkspaceCwd function - now imported from identifiers.ts
