/**
 * ACP (Agent Client Protocol) agent configuration types.
 *
 * These types describe the data written into VS Code's `settings.json`
 * under `unifyChatProvider.agents`, which the vscode-acp-provider extension reads.
 */

/**
 * Agent configuration entry persisted to `unifyChatProvider.agents.<agentId>`.
 */
export interface AcpAgentConfig {
  /** Display label shown in the chat UI */
  label?: string;
  /** CLI executable that starts the ACP agent */
  command: string;
  /** Arguments passed to the CLI */
  args?: string[];
  /** Working directory for the agent process */
  cwd?: string;
  /** Environment variables merged with the VS Code shell */
  env?: Record<string, string>;
}

/**
 * Normalized agent entry with all optional fields resolved.
 */
export interface AcpAgentEntry {
  /** Unique agent identifier (the key under `unifyChatProvider.agents`) */
  id: string;
  /** Display label (defaults to id when not set) */
  label: string;
  /** CLI executable that starts the ACP agent */
  command: string;
  /** Arguments passed to the CLI */
  args: string[];
  /** Working directory for the agent process */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
}

/**
 * Mutable draft used by the UI when adding / editing an agent.
 *
 * String fields hold the raw user input and are parsed on save.
 */
export interface AcpAgentDraft {
  id: string;
  label: string;
  command: string;
  /** Space-separated arguments (parsed into an array on save) */
  args: string;
  cwd: string;
  /** KEY=VALUE pairs, one per line (parsed into a record on save) */
  env: string;
}
