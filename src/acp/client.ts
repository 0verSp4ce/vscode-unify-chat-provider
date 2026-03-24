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
  McpServer,
  McpServerStdio,
} from "@agentclientprotocol/sdk";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as vscode from "vscode";
import type { AcpAgentEntry, AcpMcpServerConfig } from "./types";

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

  async createSession(
    cwd: string,
    mcpServers: AcpMcpServerConfig[],
  ): Promise<NewSessionResponse> {
    try {
      await this.ensureReady("new_session");
      if (!this.connection) throw new Error("ACP connection is not ready");

      const request: NewSessionRequest = {
        cwd,
        mcpServers: serializeMcpServers(mcpServers),
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
    mcpServers: AcpMcpServerConfig[],
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
        mcpServers: serializeMcpServers(mcpServers),
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
  // SDK callbacks
  // ---------------------------------------------------------------------------

  /** Called by the SDK connection when the agent requests permission. */
  async requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const firstOption = request.options[0];
    if (!firstOption) {
      return { outcome: { outcome: "cancelled" } };
    }
    return {
      outcome: { outcome: "selected", optionId: firstOption.optionId },
    };
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

  private async ensureReady(expectedMode: ClientMode): Promise<void> {
    if (this.readyPromise) {
      if (this.mode === expectedMode) {
        return this.readyPromise;
      }
    }

    await this.stopProcessAsync();
    this.readyPromise = this.createConnection(expectedMode);
    try {
      await this.readyPromise;
    } catch (error) {
      this.readyPromise = null;
      throw error;
    }
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

// ---------------------------------------------------------------------------
// MCP server serialization helpers
// ---------------------------------------------------------------------------

function serializeMcpServers(
  mcpServers: AcpMcpServerConfig[] | undefined,
): McpServer[] {
  if (!mcpServers?.length) return [];
  return mcpServers
    .filter((c) => c.type === "stdio")
    .map(
      (c): McpServerStdio => ({
        name: c.name,
        command: c.command,
        args: Array.from(c.args ?? []),
        env: c.env
          ? Object.entries(c.env).map(([name, value]) => ({ name, value }))
          : [],
      }),
    );
}
