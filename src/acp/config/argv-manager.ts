import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ACP_CLIENT_EXTENSION_ID } from "../definitions";
import { t } from "../../i18n";

/**
 * Checks the VS Code `argv.json` for the proposed API entry and guides
 * the user to configure it manually when needed.
 *
 * Typical argv.json locations:
 *  - macOS:   ~/Library/Application Support/Code/argv.json
 *  - Linux:   ~/.config/Code/argv.json
 *  - Windows: %APPDATA%/Code/argv.json
 */
export class AcpArgvManager {
  private _hasNotifiedThisSession = false;

  /** Resolve the path to VS Code's `argv.json`, or `undefined` on failure. */
  getArgvPath(): string | undefined {
    const appName = vscode.env.appName;
    const home = process.env["HOME"] ?? process.env["USERPROFILE"];
    if (!home) return undefined;

    let base: string;
    if (process.platform === "darwin") {
      base = path.join(home, "Library", "Application Support");
    } else if (process.platform === "win32") {
      const appData = process.env["APPDATA"];
      if (!appData) return undefined;
      base = appData;
    } else {
      base = process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config");
    }

    const configDir = resolveConfigDir(base, appName);
    return configDir ? path.join(configDir, "argv.json") : undefined;
  }

  /** Check whether the ACP extension's proposed API is already enabled. */
  isProposedApiEnabled(): boolean {
    const argvPath = this.getArgvPath();
    if (!argvPath) return false;

    try {
      const content = readFileOrUndefined(argvPath);
      if (!content) return false;
      const parsed = parseArgvJson(content);
      const list = parsed["enable-proposed-api"];
      if (!Array.isArray(list)) return false;
      return list.includes(ACP_CLIENT_EXTENSION_ID);
    } catch {
      return false;
    }
  }

  /**
   * If the proposed API is not yet enabled, show a notification guiding
   * the user to add the entry manually. Only notifies once per session.
   */
  async promptIfNeeded(): Promise<void> {
    if (this._hasNotifiedThisSession) return;
    if (this.isProposedApiEnabled()) return;

    this._hasNotifiedThisSession = true;

    const argvPath = this.getArgvPath();
    const snippet = `"enable-proposed-api": ["${ACP_CLIENT_EXTENSION_ID}"]`;

    const copyAction = t("Copy to Clipboard");
    const openAction = argvPath ? t("Open argv.json") : undefined;
    const actions = openAction ? [copyAction, openAction] : [copyAction];

    const selection = await vscode.window.showWarningMessage(
      t(
        "ACP agents require the proposed API to be enabled. Please add the following to your argv.json and restart: {0}",
        snippet,
      ),
      ...actions,
    );

    if (selection === copyAction) {
      await vscode.env.clipboard.writeText(snippet);
      vscode.window.showInformationMessage(t("Copied to clipboard."));
    } else if (selection === openAction && argvPath) {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(argvPath),
      );
      await vscode.window.showTextDocument(doc);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Well-known VS Code configuration directory names. */
const CONFIG_DIR_CANDIDATES = [
  "Code",
  "Code - Insiders",
  "Code - Exploration",
  "Code - OSS",
  "VSCodium",
  "Cursor",
  "Windsurf",
];

/** Resolve the VS Code configuration directory from a platform base path. */
function resolveConfigDir(base: string, appName: string): string | undefined {
  const lowerAppName = appName.toLowerCase();

  // Prefer a candidate whose name appears in the current app name
  for (const candidate of CONFIG_DIR_CANDIDATES) {
    if (lowerAppName.includes(candidate.toLowerCase())) {
      const dir = path.join(base, candidate);
      if (fs.existsSync(dir)) return dir;
    }
  }

  // Fallback: return the first existing candidate
  for (const candidate of CONFIG_DIR_CANDIDATES) {
    const dir = path.join(base, candidate);
    if (fs.existsSync(dir)) return dir;
  }

  return undefined;
}

function readFileOrUndefined(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

/** Parse JSONC (JSON with comments) by stripping comments first. */
function parseArgvJson(content: string): Record<string, unknown> {
  const stripped = content
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  try {
    const result = JSON.parse(stripped) as unknown;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}
