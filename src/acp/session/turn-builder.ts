import type {
  ContentBlock,
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
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
    _logger: vscode.LogOutputChannel,
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
    if (update.status === "completed") {
      part.presentation = "hiddenAfterComplete";
    }
    this.toolCallParts.delete(update.toolCallId);
  }

  // ---------------------------------------------------------------------------
  // Flush helpers
  // ---------------------------------------------------------------------------

  private flushPendingUserMessage(): void {
    if (!this.currentUserMessage.trim()) return;
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
   * Parse a user message chunk. Tries colon-separated format first
   * (produced by our own buildPromptBlocks), then falls back to raw text.
   */
  private parseUserChunk(raw: string): {
    userMessages: string;
    references: vscode.ChatPromptReference[];
  } {
    const REF = "Reference ";

    if (raw.startsWith("User:")) {
      const refStart = raw.indexOf(REF);
      return {
        userMessages: raw
          .substring(0, refStart > 0 ? refStart : raw.length)
          .replace(/^User:\s*/, "")
          .trim(),
        references: [],
      };
    }

    if (raw.startsWith(REF)) {
      const match = raw.match(/Reference\s\((.*)\):\s(.*)/);
      if (match) {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        const ref = match[1];
        const fileRelative = match[2];
        const fileUri = workspaceRoot
          ? vscode.Uri.joinPath(workspaceRoot, ref)
          : vscode.Uri.file(ref);
        return {
          userMessages: "",
          references: [
            { id: fileRelative, name: fileRelative, value: fileUri },
          ],
        };
      }
    }

    return { userMessages: raw, references: [] };
  }
}
