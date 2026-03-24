import type { AcpAgentConfig, AcpAgentDraft, AcpAgentEntry } from "./types";

/**
 * Extension identifier that needs the proposed API enabled in argv.json.
 */
export const ACP_CLIENT_EXTENSION_ID = "smallmain.vscode-unify-chat-provider";

// ---------------------------------------------------------------------------
// Draft conversion helpers
// ---------------------------------------------------------------------------

/**
 * Create an empty draft for the "Add Agent" form.
 */
export function createEmptyDraft(): AcpAgentDraft {
  return {
    id: "",
    label: "",
    command: "",
    args: "",
    cwd: "",
    env: "",
  };
}

/**
 * Convert a normalized entry to a mutable draft for editing.
 */
export function entryToDraft(entry: AcpAgentEntry): AcpAgentDraft {
  return {
    id: entry.id,
    label: entry.label,
    command: entry.command,
    args: entry.args.join(" "),
    cwd: entry.cwd ?? "",
    env: entry.env ? formatEnvForDisplay(entry.env) : "",
  };
}

/**
 * Convert a draft back to a persistable config.
 * Only includes non-empty optional fields.
 */
export function draftToConfig(draft: AcpAgentDraft): AcpAgentConfig {
  const config: AcpAgentConfig = {
    command: draft.command.trim(),
  };

  const label = draft.label.trim();
  if (label) {
    config.label = label;
  }

  const args = parseArgsString(draft.args);
  if (args.length > 0) {
    config.args = args;
  }

  const cwd = draft.cwd.trim();
  if (cwd) {
    config.cwd = cwd;
  }

  const env = parseEnvString(draft.env);
  if (Object.keys(env).length > 0) {
    config.env = env;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseArgsString(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/);
}

function parseEnvString(input: string): Record<string, string> {
  const trimmed = input.trim();
  if (!trimmed) return {};

  const result: Record<string, string> = {};
  for (const line of trimmed.split("\n")) {
    const eqIndex = line.indexOf("=");
    if (eqIndex > 0) {
      const key = line.substring(0, eqIndex).trim();
      const value = line.substring(eqIndex + 1).trim();
      if (key) {
        result[key] = value;
      }
    }
  }
  return result;
}

function formatEnvForDisplay(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}
