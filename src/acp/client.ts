import {
  AgentCapabilities,
  ClientCapabilities,
  ClientSideConnection,
  ContentBlock,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptResponse,
  PROTOCOL_VERSION,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModelState,
  SessionModeState,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionModelRequest,
  SetSessionModeRequest,
  ListSessionsResponse,
} from "@agentclientprotocol/sdk";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as vscode from "vscode";
import type { AcpAgentEntry } from "./types";

const CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

const CLIENT_INFO = {
  name: "vscode-unify-chat-provider",
  version: "1.0.0",
};

type ClientMode = "new_session" | "load_session";

/**
 * ACP client that manages a single agent child process,
 * communicating over the ACP ndjson protocol.
 *
 * Tracks modes, models, and config options reported by the agent.
 */
export class AcpClient implements vscode.Disposable {
  private agentProcess: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  private readyPromise: Promise<void> | null = null;
  private mode: ClientMode = "new_session";
  private _permissionLevel: string | undefined;

  private agentCapabilities?: InitializeResponse;
  private supportedModelState: SessionModelState | null = null;
  private supportedModeState: SessionModeState | null = null;
  private configOptions: SessionConfigOption[] = [];

  private readonly _onSessionUpdate =
    new vscode.EventEmitter<SessionNotification>();
  readonly onSessionUpdate: vscode.Event<SessionNotification> =
    this._onSessionUpdate.event;

  private readonly _onDidStop = new vscode.EventEmitter<void>();
  readonly onDidStop: vscode.Event<void> = this._onDidStop.event;

  private readonly _onDidOptionsChanged = new vscode.EventEmitter<void>();
  readonly onDidOptionsChanged: vscode.Event<void> =
    this._onDidOptionsChanged.event;

  constructor(
    private readonly agent: AcpAgentEntry,
    private readonly logChannel: vscode.LogOutputChannel,
  ) {}

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  async createSession(cwd: string): Promise<NewSessionResponse> {
    try {
      await this.ensureReady("new_session");
      if (!this.connection) throw new Error("ACP connection is not ready");

      const request: NewSessionRequest = {
        cwd,
        mcpServers: [],
      };
      const response = await this.connection.newSession(request);

      this.supportedModeState = response.modes ?? null;
      this.supportedModelState = response.models ?? null;
      this.configOptions = response.configOptions ?? [];
      this._onDidOptionsChanged.fire();

      return response;
    } catch (error) {
      this.stopProcess();
      throw error;
    }
  }

  async loadSession(
    sessionId: string,
    cwd: string,
  ): Promise<{
    modeId: string | undefined;
    modelId: string | undefined;
    notifications: SessionNotification[];
  }> {
    await this.ensureReady("load_session");
    if (!this.connection) throw new Error("ACP connection is not ready");

    const notifications: SessionNotification[] = [];
    const subscription = this.onSessionUpdate((notification) => {
      if (notification.sessionId === sessionId) {
        notifications.push(notification);
      }
    });

    try {
      const request: LoadSessionRequest = {
        sessionId,
        cwd,
        mcpServers: [],
      };
      const response: LoadSessionResponse =
        await this.connection.loadSession(request);

      this.supportedModelState = response.models ?? null;
      this.supportedModeState = response.modes ?? null;
      this.configOptions = response.configOptions ?? [];
      this._onDidOptionsChanged.fire();

      return {
        modelId: response.models?.currentModelId,
        modeId: response.modes?.currentModeId,
        notifications,
      };
    } catch (error) {
      this.stopProcess();
      throw error;
    } finally {
      subscription.dispose();
    }
  }

  async prompt(
    sessionId: string,
    prompt: ContentBlock[],
  ): Promise<PromptResponse> {
    await this.ensureReady(this.mode);
    if (!this.connection) throw new Error("ACP connection is not ready");
    return this.connection.prompt({ sessionId, prompt });
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.connection) return;
    try {
      await this.connection.cancel({ sessionId });
    } catch (error) {
      this.logChannel.appendLine(
        `[acp:${this.agent.id}] failed to cancel: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Options & config
  // ---------------------------------------------------------------------------

  getCapabilities(): AgentCapabilities {
    return this.agentCapabilities ?? {};
  }

  getSupportedModelState(): SessionModelState | null {
    return this.supportedModelState;
  }

  getSupportedModeState(): SessionModeState | null {
    return this.supportedModeState;
  }

  getConfigOptions(): SessionConfigOption[] {
    return this.configOptions;
  }

  async changeMode(sessionId: string, modeId: string): Promise<void> {
    await this.ensureReady(this.mode);
    if (!this.connection) throw new Error("ACP connection is not ready");
    const request: SetSessionModeRequest = { modeId, sessionId };
    await this.connection.setSessionMode(request);
  }

  async changeModel(sessionId: string, modelId: string): Promise<void> {
    await this.ensureReady(this.mode);
    if (!this.connection) throw new Error("ACP connection is not ready");

    const request: SetSessionModelRequest = { modelId, sessionId };
    await this.connection.unstable_setSessionModel(request);

    // Re-sync configOptions after model change; thought_level may change.
    const currentThoughtLevelOption = this.configOptions.find(
      (o) => o.category === "thought_level",
    );
    if (currentThoughtLevelOption) {
      try {
        const response = await this.connection.setSessionConfigOption({
          sessionId,
          configId: currentThoughtLevelOption.id,
          value: currentThoughtLevelOption.currentValue,
        } satisfies SetSessionConfigOptionRequest);
        this.configOptions = response.configOptions;
      } catch {
        this.configOptions = this.configOptions.filter(
          (o) => o.category !== "thought_level",
        );
      }
      this._onDidOptionsChanged.fire();
    }
  }

  async setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    await this.ensureReady(this.mode);
    if (!this.connection) throw new Error("ACP connection is not ready");
    const response = await this.connection.setSessionConfigOption({
      sessionId,
      configId,
      value,
    } satisfies SetSessionConfigOptionRequest);
    this.configOptions = response.configOptions;
    this._onDidOptionsChanged.fire();
  }

  async listNativeSessions(cursor?: string): Promise<ListSessionsResponse> {
    if (!this.connection) throw new Error("AcpClient not connected");
    return this.connection.unstable_listSessions({ cursor });
  }

  // ---------------------------------------------------------------------------
  // Permission
  // ---------------------------------------------------------------------------

  setPermissionLevel(level: string | undefined): void {
    this._permissionLevel = level;
    this.logChannel.warn(
      `[acp:${this.agent.id}] Permission level set to: ${JSON.stringify(level)}`,
    );
  }

  // ---------------------------------------------------------------------------
  // SDK callbacks
  // ---------------------------------------------------------------------------

  /** Called by the SDK connection when the agent requests permission. */
  async requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    this.logChannel.warn(
      `[acp:${this.agent.id}] requestPermission called, _permissionLevel=${JSON.stringify(this._permissionLevel)}, options=${JSON.stringify(request.options.map((o) => ({ id: o.optionId, kind: o.kind, name: o.name })))}`,
    );

    // Auto-approve when the user has opted into any elevated permission level.
    //
    // VS Code's request.permissionLevel can be:
    //   "autoApprove", "autopilot"           ← documented values
    //   "bypassPermissions", "dontAsk", etc. ← Copilot-style permission modes
    //   undefined                            ← user has not opted in
    //
    // Rather than maintaining an allowlist of known values, we invert the
    // check: auto-approve for any non-default level. Only undefined and
    // explicit "ask" / "default" values require manual approval.
    if (
      this._permissionLevel &&
      !this._isAskPermissionLevel(this._permissionLevel)
    ) {
      // Prefer "allow_always" over "allow_once" for a smoother experience
      const allowOption =
        request.options.find((o) => o.kind === "allow_always") ??
        request.options.find((o) => o.kind === "allow_once");
      if (allowOption) {
        this.logChannel.info(
          `[acp:${this.agent.id}] Auto-approving permission (level: ${this._permissionLevel}, option: ${allowOption.optionId})`,
        );
        return {
          outcome: { outcome: "selected", optionId: allowOption.optionId },
        };
      }
      this.logChannel.warn(
        `[acp:${this.agent.id}] Permission level is ${this._permissionLevel} but no allow option found in: ${JSON.stringify(request.options.map((o) => o.kind))}`,
      );
    }

    this.logChannel.warn(
      `[acp:${this.agent.id}] Permission request denied by user`,
    );
    return { outcome: { outcome: "cancelled" } };
  }

  /** Called by the SDK connection when the agent sends a session update. */
  async sessionUpdate(notification: SessionNotification): Promise<void> {
    const update = notification.update;
    if (
      update.sessionUpdate === "current_mode_update" &&
      this.supportedModeState
    ) {
      this.supportedModeState = {
        ...this.supportedModeState,
        currentModeId: update.currentModeId,
      };
      this._onDidOptionsChanged.fire();
    }
    this._onSessionUpdate.fire(notification);
  }

  dispose(): void {
    this.stopProcess();
    this._onSessionUpdate.dispose();
    this._onDidStop.dispose();
    this._onDidOptionsChanged.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the permission level means "always ask the user".
   * Any level NOT in this set is treated as "auto-approve".
   */
  private _isAskPermissionLevel(level: string): boolean {
    const normalized = level.toLowerCase();
    return (
      normalized === "default" ||
      normalized === "alwaysask" ||
      normalized === "always_ask" ||
      normalized === "ask"
    );
  }

  private async ensureReady(expectedMode: ClientMode): Promise<void> {
    // Check if we have a valid connection that's still alive
    if (this.readyPromise && this.mode === expectedMode) {
      try {
        // Test if the process is still alive by checking if it's killed
        if (this.agentProcess?.killed) {
          this.logChannel.debug(
            `Process is dead, recreating connection for mode: ${expectedMode}`,
          );
          this.invalidateConnection();
        } else {
          return this.readyPromise;
        }
      } catch (error) {
        this.logChannel.debug(
          `Connection test failed, recreating: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.invalidateConnection();
      }
    }

    // Stop any existing process and create new connection
    await this.stopProcessAsync();
    this.readyPromise = this.createConnection(expectedMode);
    try {
      await this.readyPromise;
    } catch (error) {
      this.readyPromise = null;
      throw error;
    }
  }

  private invalidateConnection(): void {
    this.agentProcess = null;
    this.connection = null;
    this.readyPromise = null;
  }

  private async createConnection(connectionMode: ClientMode): Promise<void> {
    this.ensureAgentRunning();
    const stdin = this.agentProcess?.stdin;
    const stdout = this.agentProcess?.stdout;
    if (!stdin || !stdout) {
      throw new Error("Failed to connect ACP client streams");
    }
    const stdinStream = Writable.toWeb(stdin);
    const stdoutStream = Readable.toWeb(stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(stdinStream, stdoutStream);
    this.connection = new ClientSideConnection(() => this, stream);

    const initResponse = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    });
    this.agentCapabilities = initResponse;
    this.mode = connectionMode;
  }

  private ensureAgentRunning(): void {
    if (this.agentProcess && !this.agentProcess.killed) return;

    const args = Array.from(this.agent.args);
    const proc = spawn(this.agent.command, args, {
      cwd: this.agent.cwd ?? process.cwd(),
      env: { ...process.env, ...this.agent.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stderr?.on("data", (data: Buffer) => {
      this.logChannel.debug(`agent:${this.agent.id} ${data.toString().trim()}`);
    });
    proc.on("exit", (code) => {
      this.logChannel.debug(
        `agent:${this.agent.id} exited with code ${code ?? "unknown"}`,
      );
      // Clear stale connection state so the next ensureReady() spawns a
      // fresh process instead of reusing a resolved-but-dead promise.
      this.agentProcess = null;
      this.connection = null;
      this.readyPromise = null;
      this._onDidStop.fire();
    });
    proc.on("error", (error) => {
      this.logChannel.debug(
        `agent:${this.agent.id} failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    this.agentProcess = proc;
  }

  private stopProcess(): void {
    if (this.agentProcess && !this.agentProcess.killed) {
      this.agentProcess.kill();
    }
    this.agentProcess = null;
    this.connection = null;
    this.readyPromise = null;
  }

  private async stopProcessAsync(): Promise<void> {
    if (this.agentProcess && !this.agentProcess.killed) {
      this.agentProcess.kill();
      await this.connection?.closed;
    }
    this.agentProcess = null;
    this.connection = null;
    this.readyPromise = null;
  }
}
