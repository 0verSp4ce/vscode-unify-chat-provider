import type {
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
  ContentBlock,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

/**
 * Builds VS Code chat turns (request/response pairs) from a stream of ACP
 * session notification events, enabling history reconstruction for resumed
 * sessions.
 */
export class AcpTurnBuilder {
  private currentUserMessage = "";
  private currentUserReferences: vscode.ChatPromptReference[] = [];
  private currentAgentParts: vscode.ExtendedChatResponsePart[] = [];
  private agentMessageChunks: string[] = [];
  private turns: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> = [];
  private readonly toolCallParts = new Map<
    string,
    { part: vscode.ChatToolInvocationPart; invocationMessage?: string }
  >();

  constructor(
    private readonly participantId: string,
  ) {}

  processNotification(notification: SessionNotification): void {
    const update = notification.update;

    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        this.flushPendingAgentMessage();
        this.captureUserMessageChunk(update.content);
        break;
      }

      case "agent_message_chunk": {
        this.flushPendingUserMessage();
        this.captureAgentMessageChunk(update.content);
        break;
      }

      case "agent_thought_chunk": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        const thought = this.getContentText(update.content);
        if (thought?.trim()) {
          this.currentAgentParts.push(
            new vscode.ChatResponseProgressPart(thought.trim()),
          );
        }
        break;
      }

      case "tool_call": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        this.appendToolCall(update as ToolCall);
        break;
      }

      case "tool_call_update": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        this.appendToolUpdate(update as ToolCallUpdate);
        break;
      }

      // Ignore non-content notification types for history purposes
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
        break;
    }
  }

  getTurns(): Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> {
    this.flushPendingUserMessage();
    this.flushPendingAgentMessage();
    return [...this.turns];
  }

  // ---------------------------------------------------------------------------
  // User message accumulation
  // ---------------------------------------------------------------------------

  private captureUserMessageChunk(content?: ContentBlock): void {
    const text = this.getContentText(content);
    if (!text) return;
    const parsed = this.parseUserChunk(text);
    if (parsed.userMessages) {
      this.currentUserMessage += parsed.userMessages;
    }
    if (parsed.references.length) {
      this.currentUserReferences.push(...parsed.references);
    }
  }

  // ---------------------------------------------------------------------------
  // Agent message accumulation
  // ---------------------------------------------------------------------------

  private captureAgentMessageChunk(content?: ContentBlock): void {
    const text = this.getContentText(content);
    if (text) this.agentMessageChunks.push(text);
  }

  // ---------------------------------------------------------------------------
  // Tool handling
  // ---------------------------------------------------------------------------

  private appendToolCall(update: ToolCall): void {
    const title = update.title ?? "Tool";
    const rawInputStr =
      typeof update.rawInput === "string" ? update.rawInput : undefined;
    const invocation = new vscode.ChatToolInvocationPart(
      title,
      update.toolCallId,
    );
    invocation.originMessage = title;
    if (rawInputStr) {
      invocation.invocationMessage = rawInputStr;
    }
    this.toolCallParts.set(update.toolCallId, {
      part: invocation,
      invocationMessage: rawInputStr,
    });
    this.currentAgentParts.push(invocation);
  }

  private appendToolUpdate(update: ToolCallUpdate): void {
    const tracked = this.toolCallParts.get(update.toolCallId);
    if (!tracked) return;
    const part = tracked.part;

    const rawInputStr =
      typeof update.rawInput === "string" ? update.rawInput : undefined;

    if (update.status !== "completed" && update.status !== "failed") {
      if (rawInputStr) {
        part.invocationMessage = rawInputStr;
        tracked.invocationMessage = rawInputStr;
      }
      return;
    }

    part.isConfirmed = update.status === "completed";
    part.isError = update.status === "failed";
    part.isComplete = true;
    const invocationMessage = rawInputStr ?? tracked.invocationMessage;
    if (invocationMessage) {
      part.invocationMessage = invocationMessage;
    }
    // Do NOT set presentation = "hiddenAfterComplete" in history reconstruction:
    // the live renderer already hides completed calls during the active turn;
    // in restored history we want to keep them visible so the conversation is
    // fully auditable.
    this.toolCallParts.delete(update.toolCallId);
  }

  // ---------------------------------------------------------------------------
  // Flush helpers
  // ---------------------------------------------------------------------------

  private flushPendingUserMessage(): void {
    const hasText = this.currentUserMessage.trim().length > 0;
    const hasRefs = this.currentUserReferences.length > 0;
    if (!hasText && !hasRefs) return;
    this.turns.push(
      new vscode.ChatRequestTurn2(
        this.currentUserMessage,
        undefined,
        this.currentUserReferences,
        this.participantId,
        [],
        undefined,
        undefined,
        undefined,
      ),
    );
    this.currentUserMessage = "";
    this.currentUserReferences = [];
  }

  private flushAgentMessageChunksToMarkdown(): void {
    if (!this.agentMessageChunks.length) return;
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(this.agentMessageChunks.join(""));
    this.agentMessageChunks = [];
    this.currentAgentParts.push(new vscode.ChatResponseMarkdownPart(markdown));
  }

  private flushPendingAgentMessage(): void {
    this.flushAgentMessageChunksToMarkdown();
    if (!this.currentAgentParts.length) return;
    const responseTurn = new vscode.ChatResponseTurn2(
      this.currentAgentParts,
      {},
      this.participantId,
    );
    this.turns.push(responseTurn);
    this.currentAgentParts = [];
  }

  // ---------------------------------------------------------------------------
  // Text extraction
  // ---------------------------------------------------------------------------

  private getContentText(content?: ContentBlock): string | undefined {
    if (!content) return undefined;
    if (content.type === "text") return content.text;
    return undefined;
  }

  /**
   * Parse a user message chunk. Handles these formats produced by buildPromptBlocks:
   *   "User: <text>"           — plain text message
   *   "Reference (<id>): <value>" — file path, URI string, or JSON object
   */
  private parseUserChunk(raw: string): {
    userMessages: string;
    references: vscode.ChatPromptReference[];
  } {
    const REF_PREFIX = "Reference ";

    if (raw.startsWith("User:")) {
      return {
        userMessages: raw.replace(/^User:\s*/, "").trim(),
        references: [],
      };
    }

    if (raw.startsWith(REF_PREFIX)) {
      // Match "Reference (<id>): <rest>" — use non-greedy on id, greedy on value
      const match = raw.match(/^Reference \(([^)]*)\): ([\s\S]*)$/);
      if (match) {
        const id = match[1];
        const value = match[2].trim();
        const ref = this.parseReferenceValue(id, value);
        if (ref) {
          return { userMessages: "", references: [ref] };
        }
      }
    }

    return { userMessages: raw, references: [] };
  }

  /**
   * Reconstruct a ChatPromptReference from the serialized value produced by
   * formatReferenceValue in participant.ts.
   *
   * Handled cases:
   * 1. JSON object with a "reference.fsPath" or "reference.external" field (image/media)
   * 2. Relative or absolute file path
   * 3. URI string (e.g. "file:///..." or other schemes)
   */
  private parseReferenceValue(
    id: string,
    value: string,
  ): vscode.ChatPromptReference | undefined {
    // Case 1: JSON-serialised object (e.g. image reference from formatReferenceValue)
    if (value.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          // Image references produced by VS Code have shape:
          // { mimeType: string, reference: { fsPath: string, external: string, ... } }
          const refObj = obj["reference"];
          if (refObj && typeof refObj === "object") {
            const refRecord = refObj as Record<string, unknown>;
            const fsPath = refRecord["fsPath"];
            const external = refRecord["external"];
            const scheme = refRecord["scheme"];
            if (typeof fsPath === "string") {
              const uri = vscode.Uri.file(fsPath);
              return { id, name: id, value: uri };
            }
            if (typeof external === "string") {
              try {
                const uri = vscode.Uri.parse(external, true);
                return { id, name: id, value: uri };
              } catch {
                // fall through
              }
            }
            if (typeof scheme === "string" && typeof refRecord["path"] === "string") {
              try {
                const uri = vscode.Uri.from({
                  scheme,
                  path: refRecord["path"] as string,
                });
                return { id, name: id, value: uri };
              } catch {
                // fall through
              }
            }
          }
          // Generic JSON object — return as a string value reference
          return { id, name: id, value };
        }
      } catch {
        // not valid JSON, fall through to path/URI handling
      }
    }

    // Case 2: URI string (has a scheme like "file://" or "untitled://")
    if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(value)) {
      try {
        const uri = vscode.Uri.parse(value, true);
        return { id, name: id, value: uri };
      } catch {
        // fall through
      }
    }

    // Case 3: file path (relative or absolute)
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (workspaceRoot) {
      const uri = vscode.Uri.joinPath(workspaceRoot, value);
      return { id, name: value, value: uri };
    }
    // No workspace — treat as absolute path
    try {
      const uri = vscode.Uri.file(value);
      return { id, name: value, value: uri };
    } catch {
      return { id, name: value, value };
    }
  }
}
