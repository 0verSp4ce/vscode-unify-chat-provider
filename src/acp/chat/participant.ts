import type {
  ContentBlock,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import { AcpSessionManager } from "../session/session-manager";
import { extractReadableError } from "../utils";

/**
 * Simplified ACP chat participant that handles user requests
 * by forwarding them to the ACP agent process and streaming
 * responses back into the VS Code chat UI.
 */
export class AcpChatParticipant implements vscode.Disposable {
  requestHandler: vscode.ChatRequestHandler = this.handleRequest.bind(this);

  constructor(
    private readonly sessionManager: AcpSessionManager,
    private readonly logChannel: vscode.LogOutputChannel,
  ) {}

  private async handleRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const sessionResource =
      context.chatSessionContext?.chatSessionItem.resource;
    if (!sessionResource) {
      response.markdown(
        "> **Info:** ACP requests must be made from within an ACP chat session.",
      );
      return;
    }

    const session = this.sessionManager.getActive(sessionResource);
    if (!session) {
      response.markdown(
        "> **Error:** ACP session is not initialized yet. Open or create an ACP session to continue.",
      );
      return;
    }

    if (token.isCancellationRequested) return;
    session.markInProgress();

    // Cancel any pending request
    session.pendingCancellation?.cancel();
    const cancellation = new vscode.CancellationTokenSource();
    session.pendingCancellation = cancellation;

    // Subscribe to session updates
    const subscription = session.client.onSessionUpdate(
      async (notification) => {
        if (
          !session.acpSessionId ||
          notification.sessionId !== session.acpSessionId
        ) {
          return;
        }
        session.pushNotification(notification);
        if (token.isCancellationRequested) return;
        this.renderSessionUpdate(notification, response);
      },
    );

    const cancellationRegistration = token.onCancellationRequested(() => {
      cancellation.cancel();
      if (session.acpSessionId) {
        session.client.cancel(session.acpSessionId).catch(() => {});
      }
    });

    try {
      const promptBlocks = this.buildPromptBlocks(request);
      if (promptBlocks.length === 0) {
        response.markdown("> **Info:** Prompt cannot be empty.");
        session.markCompleted();
        return;
      }

      // Record user message as a synthetic notification for local history
      for (const block of promptBlocks) {
        session.pushNotification({
          sessionId: session.acpSessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: block,
          },
        });
      }

      if (token.isCancellationRequested) return;
      const result = await session.client.prompt(
        session.acpSessionId,
        promptBlocks,
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
    } catch (error) {
      if (token.isCancellationRequested) return;
      session.markFailed();
      await this.sessionManager.syncSessionState(sessionResource, session);
      response.markdown(
        `> **Error:** ACP request failed. ${extractReadableError(error)}`,
      );
    } finally {
      session.pendingCancellation = undefined;
      cancellationRegistration.dispose();
      subscription.dispose();
    }
  }

  private buildPromptBlocks(request: vscode.ChatRequest): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    const trimmed = request.prompt?.trim();
    if (trimmed) {
      blocks.push({ type: "text", text: `User: ${trimmed}` });
    }

    // Attach file references
    if (request.references?.length) {
      for (const ref of request.references) {
        const value = this.formatReferenceValue(ref.value);
        if (value) {
          blocks.push({
            type: "text",
            text: `Reference (${ref.id}): ${value}`,
          });
        }
      }
    }

    return blocks;
  }

  private formatReferenceValue(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (value instanceof vscode.Uri) {
      if (value.scheme === "file") {
        const relative = vscode.workspace.asRelativePath(value, false);
        return relative !== value.fsPath ? relative : value.fsPath;
      }
      return value.toString();
    }
    if (value instanceof vscode.Location) {
      const line = value.range.start.line + 1;
      const col = value.range.start.character + 1;
      const uri =
        value.uri.scheme === "file"
          ? vscode.workspace.asRelativePath(value.uri, false)
          : value.uri.toString();
      return `${uri}:${line}:${col}`;
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

  private renderSessionUpdate(
    notification: SessionNotification,
    response: vscode.ChatResponseStream,
  ): void {
    const update = notification.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = this.getContentText(update.content);
        if (text) response.markdown(text);
        break;
      }
      case "agent_thought_chunk": {
        const thinkingText = this.getContentText(update.content);
        if (thinkingText) {
          response.thinkingProgress({
            id: "agent_thought",
            text: thinkingText,
          });
        }
        break;
      }
      case "tool_call": {
        response.beginToolInvocation(
          update.toolCallId,
          update.title || "Tool",
          update.rawInput !== undefined
            ? { partialInput: update.rawInput }
            : undefined,
        );
        break;
      }
      case "tool_call_update": {
        if (update.status === "completed" || update.status === "failed") {
          const part = new vscode.ChatToolInvocationPart(
            update.title || "Tool",
            update.toolCallId,
          );
          part.isComplete = true;
          part.isConfirmed = update.status === "completed";
          part.isError = update.status === "failed";
          if (update.status === "completed") {
            part.presentation = "hiddenAfterComplete";
          }
          response.push(part);
        }
        break;
      }
      default:
        break;
    }
  }

  private getContentText(content?: ContentBlock): string | undefined {
    if (!content) return undefined;
    if (content.type === "text") return content.text;
    return undefined;
  }

  dispose(): void {
    // nothing to clean up
  }
}
