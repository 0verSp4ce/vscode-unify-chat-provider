import * as vscode from "vscode";
import type { AcpAgentConfig, AcpAgentEntry } from "../types";

const ACP_CONFIG_SECTION = "unifyChatProvider";
const ACP_AGENTS_KEY = "agents";

/**
 * Manages ACP agent configuration stored in VS Code user settings
 * under `unifyChatProvider.agents`.
 *
 * Follows the same read/write pattern as the main `ConfigStore`, intentionally
 * using only the **global** (user-level) scope.
 */
export class AcpConfigStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private _disposable: vscode.Disposable;
  private _signature: string;

  constructor() {
    this._signature = this.computeSignature();
    this._disposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(`${ACP_CONFIG_SECTION}.${ACP_AGENTS_KEY}`)) {
        return;
      }
      const next = this.computeSignature();
      if (next === this._signature) return;
      this._signature = next;
      this._onDidChange.fire();
    });
  }

  /** All configured (and normalized) ACP agents. */
  get agents(): AcpAgentEntry[] {
    const raw = this.readRawAgents();
    const entries: AcpAgentEntry[] = [];
    for (const [id, cfg] of Object.entries(raw)) {
      const entry = normalizeEntry(id, cfg);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /** Get a specific agent by ID, or `undefined` if not configured. */
  getAgent(id: string): AcpAgentEntry | undefined {
    return this.agents.find((a) => a.id === id);
  }

  /** Add or update an agent configuration. */
  async upsertAgent(id: string, config: AcpAgentConfig): Promise<void> {
    const raw = this.readRawAgents();
    raw[id] = config;
    await this.writeRawAgents(raw);
  }

  /** Remove an agent by ID. */
  async removeAgent(id: string): Promise<void> {
    const raw = this.readRawAgents();
    delete raw[id];
    await this.writeRawAgents(raw);
  }

  dispose(): void {
    this._disposable.dispose();
    this._onDidChange.dispose();
  }

  // ── Private ──────────────────────────────────────────────────────────

  private readRawAgents(): Record<string, AcpAgentConfig> {
    const config = vscode.workspace.getConfiguration(ACP_CONFIG_SECTION);
    const inspection =
      config.inspect<Record<string, AcpAgentConfig>>(ACP_AGENTS_KEY);
    const value = inspection?.globalValue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ...value };
    }
    return {};
  }

  private async writeRawAgents(
    agents: Record<string, AcpAgentConfig>,
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration(ACP_CONFIG_SECTION);
    await config.update(
      ACP_AGENTS_KEY,
      agents,
      vscode.ConfigurationTarget.Global,
    );
  }

  private computeSignature(): string {
    return JSON.stringify(this.readRawAgents());
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeEntry(id: string, raw: unknown): AcpAgentEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["command"] !== "string" || !obj["command"]) return null;

  return {
    id,
    label: typeof obj["label"] === "string" && obj["label"] ? obj["label"] : id,
    command: obj["command"],
    args: Array.isArray(obj["args"])
      ? (obj["args"] as unknown[]).filter(
          (a): a is string => typeof a === "string",
        )
      : [],
    cwd: typeof obj["cwd"] === "string" ? obj["cwd"] : undefined,
    env: normalizeStringRecord(obj["env"]),
    mcpServers: [],
  };
}

function normalizeStringRecord(
  raw: unknown,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
