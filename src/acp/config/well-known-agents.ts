import type { AcpAgentConfig } from "../types";

/**
 * Predefined ACP agent definition used in the "Add from well-known list" UI.
 */
export interface WellKnownAcpAgent {
  /** Agent identifier (used as the key under `unifyChatProvider.agents`) */
  id: string;
  /** Human-readable display label */
  label: string;
  /** Short description shown as detail text in the picker */
  description: string;
  /** Default CLI executable */
  command: string;
  /** Default CLI arguments */
  args: string[];
  /** Category label used for grouping in UI (QuickPick separators) */
  category: string;
}

export const WELL_KNOWN_ACP_AGENTS: WellKnownAcpAgent[] = [
  // ── General ──────────────────────────────────────────────────────────
  {
    id: "augment",
    label: "Augment Code",
    description: "Augment Code AI assistant",
    command: "augment",
    args: ["acp"],
    category: "General",
  },
  {
    id: "claude",
    label: "Claude Code",
    description: "Anthropic Claude Code CLI",
    command: "claude",
    args: ["acp"],
    category: "General",
  },
  {
    id: "cline",
    label: "Cline",
    description: "Cline AI coding agent",
    command: "cline",
    args: ["acp"],
    category: "General",
  },
  {
    id: "codex",
    label: "Codex CLI",
    description: "OpenAI Codex CLI",
    command: "codex",
    args: ["--acp"],
    category: "General",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    description: "GitHub Copilot CLI",
    command: "copilot",
    args: ["acp"],
    category: "General",
  },
  {
    id: "geminicli",
    label: "Gemini CLI",
    description: "Google Gemini CLI",
    command: "gemini",
    args: ["acp"],
    category: "General",
  },
  {
    id: "kimi",
    label: "Kimi CLI",
    description: "Moonshot Kimi CLI",
    command: "kimi",
    args: ["acp"],
    category: "General",
  },
  {
    id: "vibe",
    label: "Mistral Vibe",
    description: "Mistral Vibe coding agent",
    command: "mistral",
    args: ["acp"],
    category: "General",
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "OpenCode AI coding agent",
    command: "opencode",
    args: ["acp"],
    category: "General",
  },
  {
    id: "qoder",
    label: "Qoder CLI",
    description: "Qoder AI coding agent",
    command: "qoder",
    args: ["--acp"],
    category: "General",
  },
  // ── IDE & Editor ─────────────────────────────────────────────────────
  {
    id: "junie",
    label: "JetBrains Junie",
    description: "JetBrains AI coding agent",
    command: "junie",
    args: ["acp"],
    category: "IDE & Editor",
  },
  {
    id: "minion",
    label: "Minion Code",
    description: "Minion Code AI assistant",
    command: "minion",
    args: ["acp"],
    category: "IDE & Editor",
  },
  {
    id: "pi",
    label: "Pi",
    description: "Pi AI coding agent",
    command: "pi",
    args: ["acp"],
    category: "IDE & Editor",
  },
  {
    id: "qwen",
    label: "Qwen Code",
    description: "Alibaba Qwen Code AI assistant",
    command: "qwen",
    args: ["acp"],
    category: "IDE & Editor",
  },
  {
    id: "vtcode",
    label: "VT Code",
    description: "VT Code AI assistant",
    command: "vtcode",
    args: ["acp"],
    category: "IDE & Editor",
  },
  // ── Agent Frameworks ─────────────────────────────────────────────────
  {
    id: "openhands",
    label: "OpenHands",
    description: "OpenHands AI agent framework",
    command: "openhands",
    args: ["acp"],
    category: "Agent Frameworks",
  },
  {
    id: "goose",
    label: "Goose",
    description: "Block Goose AI agent",
    command: "goose",
    args: ["acp"],
    category: "Agent Frameworks",
  },
  {
    id: "fastagent",
    label: "fast-agent",
    description: "fast-agent framework",
    command: "fast-agent",
    args: ["acp"],
    category: "Agent Frameworks",
  },
  {
    id: "cagent",
    label: "Docker cagent",
    description: "Docker's cagent AI agent",
    command: "cagent",
    args: ["acp"],
    category: "Agent Frameworks",
  },
  {
    id: "stakpak",
    label: "Stakpak",
    description: "Stakpak infrastructure agent",
    command: "stakpak",
    args: ["acp"],
    category: "Agent Frameworks",
  },
  // ── Other ────────────────────────────────────────────────────────────
  {
    id: "codeassistant",
    label: "Code Assistant",
    description: "Code Assistant AI helper",
    command: "code-assistant",
    args: ["acp"],
    category: "Other",
  },
  {
    id: "blackbox",
    label: "Blackbox AI",
    description: "Blackbox AI coding assistant",
    command: "blackbox",
    args: ["acp"],
    category: "Other",
  },
  {
    id: "agentpool",
    label: "AgentPool",
    description: "AgentPool multi-agent platform",
    command: "agentpool",
    args: ["acp"],
    category: "Other",
  },
];

/**
 * Convert a well-known agent definition to a persistable config.
 */
export function wellKnownAgentToConfig(
  agent: WellKnownAcpAgent,
): AcpAgentConfig {
  return {
    label: agent.label,
    command: agent.command,
    args: [...agent.args],
  };
}
