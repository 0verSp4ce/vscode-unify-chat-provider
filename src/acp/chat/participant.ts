import type {
  ContentBlock,
  SessionNotification,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import { AcpSessionManager } from "../session/session-manager";
import { extractReadableError, getContentText } from "../utils";

// ═══════════════════════════════════════════════════════════════════════════
// Tracked tool state
// ═══════════════════════════════════════════════════════════════════════════

/**
 * State kept between tool_call (start) and tool_call_update (complete).
 *
 * ACP updates are incremental patches — "only changed fields need to be
 * included" — so we must accumulate rawOutput and content across updates.
 * The "completed" update might only carry `status: "completed"` while
 * rawOutput was delivered in an earlier "in_progress" update.
 */
interface TrackedTool {
  title: string;
  kind?: ToolKind;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: Array<ToolCallContent> | null;
  subAgentInvocationId?: string;
  /** Consistent toolName for both start and complete pushes. */
  toolName: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Content extraction — thin helpers over ACP structured fields
// ═══════════════════════════════════════════════════════════════════════════

function getSubAgentInvocationId(
  data: ToolCall | ToolCallUpdate,
): string | undefined {
  const meta = data._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const id = (meta as Record<string, unknown>)["subAgentInvocationId"];
  return typeof id === "string" ? id : undefined;
}

/** Collect text from ACP ToolCallContent[]. */
function collectContentText(
  content: Array<ToolCallContent> | null | undefined,
): string | undefined {
  if (!content?.length) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "content" && item.content.type === "text") {
      parts.push(item.content.text);
    }
  }
  return parts.length ? parts.join("") : undefined;
}

/** Prefer structured content text; fall back to rawOutput (string or object). */
function getOutputText(
  content: Array<ToolCallContent> | null | undefined,
  rawOutput: unknown,
): string | undefined {
  // 1. Try structured content blocks first
  const fromContent = collectContentText(content);
  if (fromContent) return fromContent;

  // 2. rawOutput: string → use directly
  if (typeof rawOutput === "string") return rawOutput;

  // 3. rawOutput: object → try common shapes, then JSON.stringify
  if (rawOutput && typeof rawOutput === "object") {
    const obj = rawOutput as Record<string, unknown>;
    // { output: "..." } or { stdout: "..." } or { text: "..." }
    for (const key of ["output", "stdout", "text", "result"]) {
      const val = obj[key];
      if (typeof val === "string" && val) return val;
    }
    // Concatenate stdout + stderr if both present
    if (
      typeof obj["stdout"] === "string" ||
      typeof obj["stderr"] === "string"
    ) {
      const parts: string[] = [];
      if (typeof obj["stdout"] === "string") parts.push(obj["stdout"]);
      if (typeof obj["stderr"] === "string") parts.push(obj["stderr"]);
      const combined = parts.join("\n");
      if (combined) return combined;
    }
    // Last resort: stringify
    return JSON.stringify(rawOutput, null, 2);
  }

  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Input formatting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract shell command from rawInput.
 * Handles: string | { command: string } | { command: string[] }.
 *
 * Copilot Chat equivalent: `(toolUse.input as BashInput)?.command`
 */
function getCommandLine(rawInput: unknown): string {
  if (typeof rawInput === "string") return rawInput;
  if (rawInput && typeof rawInput === "object" && "command" in rawInput) {
    const cmd = (rawInput as Record<string, unknown>)["command"];
    if (typeof cmd === "string") return cmd;
    if (Array.isArray(cmd))
      return cmd.filter((s): s is string => typeof s === "string").join(" ");
  }
  return "";
}

/**
 * Pick the single most meaningful string from rawInput for display.
 * Used by Read (file_path), Glob/Grep (pattern), Fetch (url), etc.
 */
function pickInputField(rawInput: unknown, ...keys: string[]): string {
  if (typeof rawInput === "string") return rawInput;
  if (rawInput && typeof rawInput === "object") {
    const obj = rawInput as Record<string, unknown>;
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v) return v;
    }
  }
  return "";
}

/**
 * Generic input serialisation for ChatSimpleToolResultData.input.
 * Tries known fields first, falls back to JSON.
 */
function formatInputForDisplay(rawInput: unknown): string {
  if (rawInput === undefined || rawInput === null) return "";
  if (typeof rawInput === "string") return rawInput;
  const picked = pickInputField(
    rawInput,
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "command",
    "description",
  );
  if (picked) return picked;
  if (typeof rawInput === "object") {
    return JSON.stringify(rawInput, null, 2);
  }
  return String(rawInput);
}

// ═══════════════════════════════════════════════════════════════════════════
// Terminal output helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse "exit code: N" / "exited with N" from the tail of terminal output.
 *
 * Copilot Chat equivalent: regex in `completeBashInvocation`.
 */
function parseExitCode(text: string): {
  exitCode: number | undefined;
  cleanText: string;
} {
  const match = /(?:exit code|exited with)[:=\s]*(\d+)\s*$/i.exec(text);
  if (!match) return { exitCode: undefined, cleanText: text };
  return {
    exitCode: parseInt(match[1], 10),
    cleanText: text.slice(0, match.index).trimEnd(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool kind predicates
// ═══════════════════════════════════════════════════════════════════════════

// ACP ToolKind: "read" | "edit" | "delete" | "move" | "search" | "execute"
//             | "think" | "fetch" | "switch_mode" | "other"

function isTerminal(kind: ToolKind | undefined): boolean {
  return kind === "execute";
}
function isEdit(kind: ToolKind | undefined): boolean {
  return kind === "edit" || kind === "delete" || kind === "move";
}

/**
 * Map ACP ToolKind to a short tool name for ChatToolInvocationPart constructor.
 *
 * Copilot Chat passes `toolUse.name` which is always a short name like "Bash",
 * "Read", "Glob". ACP doesn't have a separate tool name, so derive from kind.
 */
function toolNameForKind(kind: ToolKind | undefined): string {
  switch (kind) {
    case "execute":
      return "Terminal";
    case "read":
      return "Read";
    case "search":
      return "Search";
    case "edit":
      return "Edit";
    case "delete":
      return "Delete";
    case "move":
      return "Move";
    case "fetch":
      return "Fetch";
    case "think":
      return "Think";
    case "switch_mode":
      return "SwitchMode";
    default:
      return "Tool";
  }
}

/**
 * Normalize line endings to \r\n for VS Code's terminal renderer.
 * First strip any existing \r to avoid \r\r\n, then convert all \n to \r\n.
 *
 * Copilot Chat: `text = text.replace(/\n/g, '\r\n')`  (line 96)
 * They can use the naive replace because Claude SDK output never has \r\n.
 * ACP output may already contain \r\n from actual terminal output.
 */
function normalizeTerminalLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

/**
 * Strip markdown code fences from terminal output.
 *
 * Some ACP agents wrap command output in markdown fences like:
 *   ```\noutput here\n```
 * The terminal renderer shows these as literal characters which looks broken.
 */
function stripMarkdownFences(text: string): string {
  return text.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
}

// ═══════════════════════════════════════════════════════════════════════════
// URI display helper — matches Copilot Chat's formatUriForMessage
// ═══════════════════════════════════════════════════════════════════════════

/** `[](file:///absolute/path)` — VS Code renders this as a clickable link. */
function fileLink(fsPath: string): string {
  return `[](${vscode.Uri.file(fsPath).toString()})`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool invocation creation — mirrors toolInvocationFormatter.ts exactly
//
// Copilot Chat creates TWO ChatToolInvocationPart per tool:
//   1. stream.push(incompleteInvocation)   ← handleAssistantMessage
//   2. stream.push(completeInvocation)      ← processToolResult
//
// Edit tools return undefined (no part pushed). Their UI comes from
// ExternalEditTracker → stream.externalEdit().
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create an INCOMPLETE invocation (tool just started, spinner shown).
 * Returns `undefined` for tools that should not render a card (edits).
 *
 * Copilot Chat: `createFormattedToolInvocation(item, false)`
 *   → claudeCodeAgent.ts:880  → formatXxxInvocation
 */
function createStartInvocation(
  tc: ToolCall,
  subAgentId: string | undefined,
  toolName: string,
): vscode.ChatToolInvocationPart | undefined {
  const kind = tc.kind;

  // ── Edit tools: return undefined (no card). ──
  // Copilot Chat: case Edit/MultiEdit/Write → return;  (line 225)
  if (isEdit(kind)) return undefined;

  // Copilot Chat: `new ChatToolInvocationPart(toolUse.name, toolUse.id)`
  const part = new vscode.ChatToolInvocationPart(toolName, tc.toolCallId);
  part.enablePartialUpdate = true;
  part.isComplete = false;
  part.isConfirmed = false;
  if (subAgentId) part.subAgentInvocationId = subAgentId;

  // ── Terminal (Bash): skip start invocation. ──
  // Unlike Copilot Chat (which processes entire conversation turns at once),
  // ACP streams events with delays between tool_call and tool_call_update.
  // If we push an incomplete terminal invocation here, VS Code creates an
  // "open container" and nests all subsequent agent messages inside it until
  // the complete invocation arrives — producing broken layout.
  // Only the complete invocation (with output) is pushed for terminals.
  if (isTerminal(kind)) return undefined;

  // ── Read / LS ──
  // Copilot Chat: formatReadInvocation → "Read [](uri)"
  if (kind === "read") {
    const p = pickInputField(tc.rawInput, "file_path", "path");
    part.invocationMessage = p
      ? new vscode.MarkdownString(`Read ${fileLink(p)}`)
      : tc.title || "Read";
    return part;
  }

  // ── Search (Glob / Grep) ──
  // Copilot Chat: formatGlobInvocation / formatGrepInvocation
  if (kind === "search") {
    const pattern = pickInputField(tc.rawInput, "pattern");
    part.invocationMessage = pattern
      ? new vscode.MarkdownString(`Searching for \`${pattern}\``)
      : tc.title || "Search";
    return part;
  }

  // ── Fetch ──
  if (kind === "fetch") {
    const url = pickInputField(tc.rawInput, "url");
    part.invocationMessage = url
      ? new vscode.MarkdownString(`Fetching \`${url}\``)
      : tc.title || "Fetch";
    return part;
  }

  // ── Think ──
  if (kind === "think") {
    part.invocationMessage = tc.title || "Thinking";
    part.presentation = "hiddenAfterComplete";
    return part;
  }

  // ── Default ──
  // Copilot Chat: formatGenericInvocation → "Used tool: name"
  part.invocationMessage = tc.title || "Tool";
  return part;
}

/**
 * Create a COMPLETE invocation (tool finished, result populated).
 * Returns `undefined` for edit tools (they use ExternalEditTracker).
 *
 * Uses accumulated state from TrackedTool because ACP updates are
 * incremental patches — rawOutput may have been delivered in an earlier
 * "in_progress" update, not repeated in the "completed" update.
 *
 * Copilot Chat:
 *   createFormattedToolInvocation(toolUse, true)     ← line 949
 *   completeToolInvocation(toolUse, toolResult, inv) ← line 958
 *   stream.push(invocation)                          ← line 966
 */
function createCompleteInvocation(
  tcu: ToolCallUpdate,
  tracked: TrackedTool | undefined,
): vscode.ChatToolInvocationPart | undefined {
  const title = tcu.title ?? tracked?.title ?? "Tool";
  const kind = tcu.kind ?? tracked?.kind;
  const rawInput = tcu.rawInput ?? tracked?.rawInput;
  const subAgentId =
    tracked?.subAgentInvocationId ?? getSubAgentInvocationId(tcu);
  const toolName = tracked?.toolName ?? toolNameForKind(kind);

  // Merge accumulated state: update fields take priority over tracked
  const effectiveRawOutput = tcu.rawOutput ?? tracked?.rawOutput;
  const effectiveContent = tcu.content ?? tracked?.content;

  // Edit tools: no card.
  if (isEdit(kind)) return undefined;

  const part = new vscode.ChatToolInvocationPart(toolName, tcu.toolCallId);
  part.enablePartialUpdate = true;
  part.isComplete = true;
  // Copilot Chat: isConfirmed=true for all non-denied tools (line 949+955).
  // isError handles the failure display separately.
  part.isConfirmed = true;
  part.isError = tcu.status === "failed";
  if (subAgentId) part.subAgentInvocationId = subAgentId;

  // ── Terminal (Bash) ──
  // Copilot Chat: completeBashInvocation
  if (isTerminal(kind)) {
    part.invocationMessage = "";
    const commandLine = getCommandLine(rawInput);
    const termData: vscode.ChatTerminalToolInvocationData = {
      commandLine: { original: commandLine },
      language: "bash",
    };
    const output = getOutputText(effectiveContent, effectiveRawOutput);
    if (output) {
      const stripped = stripMarkdownFences(output);
      const { exitCode, cleanText } = parseExitCode(stripped);
      termData.output = cleanText
        ? { text: normalizeTerminalLineEndings(cleanText) }
        : undefined;
      termData.state = exitCode !== undefined ? { exitCode } : undefined;
    }
    part.toolSpecificData = termData;
    return part;
  }

  // ── Read / LS ──
  // Copilot Chat: completeReadInvocation → ChatSimpleToolResultData
  if (kind === "read") {
    const p = pickInputField(rawInput, "file_path", "path");
    part.invocationMessage = p
      ? new vscode.MarkdownString(`Read ${fileLink(p)}`)
      : title;
    const output = getOutputText(effectiveContent, effectiveRawOutput);
    if (output) {
      part.toolSpecificData = {
        input: p,
        output,
      } satisfies vscode.ChatSimpleToolResultData;
    }
    return part;
  }

  // ── Search (Glob / Grep) ──
  // Copilot Chat: completeSearchInvocation → ChatSimpleToolResultData
  if (kind === "search") {
    const pattern = pickInputField(rawInput, "pattern");
    part.invocationMessage = pattern
      ? new vscode.MarkdownString(`Searched for \`${pattern}\``)
      : title;
    const output = getOutputText(effectiveContent, effectiveRawOutput);
    if (output) {
      part.toolSpecificData = {
        input: pattern,
        output,
      } satisfies vscode.ChatSimpleToolResultData;
    }
    return part;
  }

  // ── Fetch ──
  if (kind === "fetch") {
    const url = pickInputField(rawInput, "url");
    part.invocationMessage = url
      ? new vscode.MarkdownString(`Fetched \`${url}\``)
      : title;
    const output = getOutputText(effectiveContent, effectiveRawOutput);
    if (output) {
      part.toolSpecificData = {
        input: url,
        output,
      } satisfies vscode.ChatSimpleToolResultData;
    }
    return part;
  }

  // ── Think ──
  if (kind === "think") {
    part.invocationMessage = title;
    part.presentation = "hiddenAfterComplete";
    return part;
  }

  // ── Default / Generic ──
  // Copilot Chat: completeGenericInvocation → ChatSimpleToolResultData
  part.invocationMessage = title;
  const output = getOutputText(effectiveContent, effectiveRawOutput);
  if (output) {
    part.toolSpecificData = {
      input: formatInputForDisplay(rawInput),
      output,
    } satisfies vscode.ChatSimpleToolResultData;
  }
  return part;
}

// ═══════════════════════════════════════════════════════════════════════════
// AcpChatParticipant
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bridges ACP session updates to the VS Code Chat UI.
 *
 * Every rendering decision is modeled after vscode-copilot-chat's
 * `claudeCodeAgent.ts` + `toolInvocationFormatter.ts`:
 *
 * | ACP event           | VS Code rendering                              |
 * |---------------------|-------------------------------------------------|
 * | agent_message_chunk | stream.markdown(text)                           |
 * | agent_thought_chunk | stream.push(ChatResponseThinkingProgressPart)   |
 * | tool_call (execute) | nothing — complete-only to avoid nesting bug   |
 * | tool_call (edit)    | nothing — VS Code file watcher detects changes  |
 * | tool_call (other)   | stream.push(incomplete InvocationPart)          |
 * | tool_call_update ✓  | stream.push(complete InvocationPart)            |
 * | tool_call_update ✓  | (edit) nothing — file watcher handles diff       |
 */
export class AcpChatParticipant implements vscode.Disposable {
  requestHandler: vscode.ChatRequestHandler = this._handleRequest.bind(this);

  private readonly _tracked = new Map<string, TrackedTool>();

  constructor(
    private readonly sessionManager: AcpSessionManager,
    private readonly logChannel: vscode.LogOutputChannel,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // Request handler
  // ─────────────────────────────────────────────────────────────────────

  private async _handleRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    try {
      const sessionResource =
        context.chatSessionContext?.chatSessionItem.resource;
      if (!sessionResource) {
        stream.markdown(
          "> **Info:** ACP requests must be made from within an ACP chat session.",
        );
        return;
      }

      const session = this.sessionManager.getActive(sessionResource);
      if (!session) {
        stream.markdown(
          "> **Error:** ACP session is not initialized yet. Open or create an ACP session to continue.",
        );
        return;
      }

      if (token.isCancellationRequested) return;
      session.markInProgress();
      session.client.setPermissionLevel(request.permissionLevel);

      const cts = new vscode.CancellationTokenSource();
      session.replacePendingCancellation(cts);

      // ── Subscribe to session updates ──
      const subscription = session.client.onSessionUpdate((notification) => {
        try {
          if (
            !session.acpSessionId ||
            notification.sessionId !== session.acpSessionId
          )
            return;
          session.pushNotification(notification);
          if (token.isCancellationRequested) return;
          this._renderUpdate(notification, stream);
        } catch (err) {
          this.logChannel.error(
            `Error processing session update: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });

      const cancelReg = token.onCancellationRequested(() => {
        cts.cancel();
        if (session.acpSessionId) {
          session.client.cancel(session.acpSessionId).catch(() => {});
        }
      });

      try {
        const blocks = this._buildPromptBlocks(request);
        if (blocks.length === 0) {
          stream.markdown("> **Info:** Prompt cannot be empty.");
          session.markCompleted();
          return;
        }

        // Record user turn in notification history
        for (const block of blocks) {
          session.pushNotification({
            sessionId: session.acpSessionId,
            update: { sessionUpdate: "user_message_chunk", content: block },
          });
        }

        if (token.isCancellationRequested) return;
        const result = await session.client.prompt(
          session.acpSessionId,
          blocks,
        );

        if (token.isCancellationRequested) return;
        session.markCompleted();

        if (context.chatSessionContext?.isUntitled) {
          session.title =
            request.prompt.substring(0, Math.min(request.prompt.length, 50)) ||
            session.title;
        }
        await this.sessionManager.syncSessionState(sessionResource, session);

        this.logChannel.info(
          `ACP agent finished with stop reason: ${result.stopReason}`,
        );
      } catch (err) {
        if (token.isCancellationRequested) return;
        session.markFailed();
        await this.sessionManager.syncSessionState(sessionResource, session);
        stream.markdown(
          `> **Error:** ACP request failed. ${extractReadableError(err)}`,
        );
        this.logChannel.error(
          `ACP request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        session.clearPendingCancellation();
        cancelReg.dispose();
        subscription.dispose();
        this._tracked.clear();
      }
    } catch (err) {
      this.logChannel.error(
        `Unexpected error in _handleRequest: ${err instanceof Error ? err.message : String(err)}`,
      );
      stream.markdown(
        "> **Error:** An unexpected error occurred while processing your request.",
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Prompt building
  // ─────────────────────────────────────────────────────────────────────

  private _buildPromptBlocks(request: vscode.ChatRequest): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    const trimmed = request.prompt?.trim();
    if (trimmed) {
      const label = request.command ? `User (${request.command})` : "User";
      blocks.push({ type: "text", text: `${label}: ${trimmed}` });
    }

    if (request.references?.length) {
      for (const ref of request.references) {
        const desc = ref.modelDescription?.trim();
        const val = this._fmtRefValue(ref.value);
        const range = ref.range ? ` [${ref.range[0]}, ${ref.range[1]}]` : "";
        const parts = [`Reference (${ref.id})${range}`];
        if (desc) parts.push(desc);
        if (val) parts.push(val);
        blocks.push({ type: "text", text: parts.join(": ") });
      }
    }

    if (request.toolReferences?.length) {
      for (const tool of request.toolReferences) {
        const range = tool.range ? ` [${tool.range[0]}, ${tool.range[1]}]` : "";
        blocks.push({
          type: "text",
          text: `Tool reference (${tool.name})${range}`,
        });
      }
    }

    return blocks;
  }

  private _fmtRefValue(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (value instanceof vscode.Uri) {
      if (value.scheme === "file") {
        const rel = vscode.workspace.asRelativePath(value, false);
        return rel !== value.fsPath ? rel : value.fsPath;
      }
      return value.toString();
    }
    if (value instanceof vscode.Location) {
      const uri =
        value.uri.scheme === "file"
          ? vscode.workspace.asRelativePath(value.uri, false)
          : value.uri.toString();
      return `${uri}:${value.range.start.line + 1}:${value.range.start.character + 1}`;
    }
    if (value === undefined || value === null) return undefined;
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Rendering dispatch
  // ─────────────────────────────────────────────────────────────────────

  private _renderUpdate(
    notification: SessionNotification,
    stream: vscode.ChatResponseStream,
  ): void {
    const u = notification.update;
    try {
      switch (u.sessionUpdate) {
        // ── Text ──
        case "agent_message_chunk": {
          const text = getContentText(u.content);
          if (text?.trim()) stream.markdown(text);
          break;
        }

        // ── Thinking ──
        // Copilot Chat: stream.push(new ChatResponseThinkingProgressPart(thinking))
        case "agent_thought_chunk": {
          const text = getContentText(u.content);
          if (text?.trim()) {
            stream.push(new vscode.ChatResponseThinkingProgressPart(text));
          }
          break;
        }

        // ── Tool start ──
        case "tool_call":
          this._onToolCall(u as ToolCall, stream);
          break;

        // ── Tool progress / completion ──
        case "tool_call_update":
          this._onToolCallUpdate(u as ToolCallUpdate, stream);
          break;

        // ── Plan ──
        case "plan": {
          const entries = (
            u as {
              sessionUpdate: "plan";
              entries: Array<{ content: string; status?: string }>;
            }
          ).entries;
          if (entries?.length) {
            stream.markdown("## Plan\n");
            for (const e of entries) {
              const check = e.status === "completed" ? "x" : " ";
              stream.markdown(`- [${check}] ${e.content}\n`);
            }
          }
          break;
        }

        // ── Usage ──
        case "usage_update": {
          const usage = u as {
            sessionUpdate: "usage_update";
            size?: number;
            used?: number;
          };
          if (
            typeof usage.used === "number" &&
            typeof usage.size === "number"
          ) {
            stream.usage({
              promptTokens: usage.used,
              completionTokens: 0,
            });
          }
          break;
        }

        default:
          this.logChannel.debug(`Unknown session update: ${u.sessionUpdate}`);
      }
    } catch (err) {
      this.logChannel.error(
        `Render error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // tool_call handler
  //
  // Copilot Chat equivalent: handleAssistantMessage → for tool_use blocks
  //   1. createFormattedToolInvocation(item, false) → may return undefined
  //   2. invocation.enablePartialUpdate = true
  //   3. stream.push(invocation)
  //
  // Edit tools: Copilot Chat returns undefined (no card pushed).
  // In ACP the agent edits files directly; VS Code's file watcher
  // detects changes and shows the diff at the bottom automatically.
  // ─────────────────────────────────────────────────────────────────────

  private _onToolCall(tc: ToolCall, stream: vscode.ChatResponseStream): void {
    const subAgentId = getSubAgentInvocationId(tc);
    const toolName = toolNameForKind(tc.kind);

    // Track state for correlation with tool_call_update.
    // All fields are accumulated across incremental updates.
    this._tracked.set(tc.toolCallId, {
      title: tc.title || "Tool",
      kind: tc.kind,
      rawInput: tc.rawInput,
      subAgentInvocationId: subAgentId,
      toolName,
    });

    // ── Edit tools: skip entirely. No card, no externalEdit. ──
    // Copilot Chat: createFormattedToolInvocation returns undefined for Edit/Write.
    // ACP cannot use externalEdit() because the agent modifies files before
    // tool_call arrives (no PreToolUse hook to block execution).
    // VS Code's file watcher handles diff display.
    if (isEdit(tc.kind)) {
      return;
    }

    // ── All other tools: push incomplete invocation. ──
    // Copilot Chat: stream.push(invocation) at claudeCodeAgent.ts:886
    const invocation = createStartInvocation(tc, subAgentId, toolName);
    if (invocation) {
      stream.push(invocation);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // tool_call_update handler
  //
  // Copilot Chat equivalent: processToolResult
  //   1. createFormattedToolInvocation(toolUse, true) → complete invocation
  //   2. completeToolInvocation(toolUse, toolResult, invocation) → fill data
  //   3. stream.push(invocation)
  //
  // Edit tools: no UI action. File watcher already handles diff.
  // ─────────────────────────────────────────────────────────────────────

  private _onToolCallUpdate(
    tcu: ToolCallUpdate,
    stream: vscode.ChatResponseStream,
  ): void {
    const tracked = this._tracked.get(tcu.toolCallId);

    // ── Always accumulate incremental state. ──
    // ACP updates are patches: "only changed fields need to be included."
    // rawOutput may arrive in an "in_progress" update and NOT be repeated
    // in the final "completed" update. We must track everything.
    if (tracked) {
      if (tcu.rawInput !== undefined) tracked.rawInput = tcu.rawInput;
      if (tcu.rawOutput !== undefined) tracked.rawOutput = tcu.rawOutput;
      if (tcu.content !== undefined) tracked.content = tcu.content;
      if (tcu.kind != null) tracked.kind = tcu.kind;
      if (tcu.title != null) tracked.title = tcu.title;
    }

    // ── In-progress: state accumulated above, nothing more to do. ──
    if (tcu.status !== "completed" && tcu.status !== "failed") {
      return;
    }

    // Debug: log the completion data shape for diagnostics
    const kind = tcu.kind ?? tracked?.kind;
    const effectiveRawOutput = tcu.rawOutput ?? tracked?.rawOutput;
    const effectiveContent = tcu.content ?? tracked?.content;
    this.logChannel.debug(
      `[tool_call_update] id=${tcu.toolCallId} kind=${kind ?? "?"} status=${tcu.status} ` +
        `rawOutput type=${typeof effectiveRawOutput} ` +
        `content length=${effectiveContent?.length ?? 0} ` +
        `rawOutput preview=${typeof effectiveRawOutput === "string" ? effectiveRawOutput.substring(0, 200) : JSON.stringify(effectiveRawOutput)?.substring(0, 200)}`,
    );

    if (isEdit(kind)) {
      // Edit tools: nothing to do. VS Code file watcher shows diff.
      this._tracked.delete(tcu.toolCallId);
      return;
    }

    // All other tools: push complete invocation (second push, merges with start)
    const invocation = createCompleteInvocation(tcu, tracked);
    if (invocation) {
      stream.push(invocation);
    }
    this._tracked.delete(tcu.toolCallId);
  }

  // ─────────────────────────────────────────────────────────────────────

  dispose(): void {}
}
