import * as vscode from "vscode";
import type { AcpAgentEntry } from "./types";
import { AcpSessionManager } from "./session/session-manager";
import { AcpLanguageModelProvider } from "./chat/language-model-provider";
import { AcpChatParticipant } from "./chat/participant";
import { AcpChatSessionContentProvider } from "./chat/session-content-provider";
import {
  createSessionType,
  createSessionUri,
  getAgentIdFromResource,
} from "./chat/identifiers";
import { randomUUID } from "node:crypto";
import { createAcpSessionDb, type AcpSessionDb } from "./session/session-db";

/**
 * Register all configured ACP agents as VS Code chat participants,
 * language model providers, and session content providers.
 *
 * Returns a map of agent-id -> AcpSessionManager for lifecycle management.
 */
export function registerAcpAgents(
  agents: AcpAgentEntry[],
  outputChannel: vscode.LogOutputChannel,
  context: vscode.ExtensionContext,
): Map<string, AcpSessionManager> {
  const managers = new Map<string, AcpSessionManager>();

  // Create shared session database for persistence
  const sessionDb = initializeSessionDatabase(context, outputChannel);
  if (sessionDb) {
    context.subscriptions.push(sessionDb);
  }

  // Register each agent with its components
  for (const agent of agents) {
    const manager = registerSingleAgent(agent, outputChannel, context, sessionDb);
    managers.set(agent.id, manager);
    outputChannel.info(`Registered ACP agent: ${agent.id} (${agent.label})`);
  }

  // Setup global session disposal handler
  setupGlobalSessionDisposal(managers, outputChannel, context);

  return managers;
}

function initializeSessionDatabase(
  context: vscode.ExtensionContext,
  outputChannel: vscode.LogOutputChannel,
): AcpSessionDb | undefined {
  try {
    return createAcpSessionDb(context, outputChannel);
  } catch (error) {
    outputChannel.warn(
      `Failed to initialize ACP session database: ${error instanceof Error ? error.message : String(error)}. Sessions will not be persisted.`,
    );
    return undefined;
  }
}

function registerSingleAgent(
  agent: AcpAgentEntry,
  outputChannel: vscode.LogOutputChannel,
  context: vscode.ExtensionContext,
  sessionDb: AcpSessionDb | undefined,
): AcpSessionManager {
  const sessionType = createSessionType(agent.id);

  // Session manager
  const sessionManager = new AcpSessionManager(agent, outputChannel, sessionDb);
  context.subscriptions.push(sessionManager);

  // Language model provider
  const lmProvider = new AcpLanguageModelProvider(agent, sessionManager, context);
  context.subscriptions.push(lmProvider);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(sessionType, lmProvider),
  );

  // Chat participant
  const participant = new AcpChatParticipant(sessionManager, outputChannel);
  context.subscriptions.push(participant);

  const participantInstance = vscode.chat.createChatParticipant(
    sessionType,
    participant.requestHandler,
  );
  context.subscriptions.push(participantInstance);

  // Chat session content provider
  const sessionContentProvider = new AcpChatSessionContentProvider(
    sessionManager,
    participant,
    outputChannel,
  );
  context.subscriptions.push(sessionContentProvider);
  context.subscriptions.push(
    vscode.chat.registerChatSessionContentProvider(
      sessionType,
      sessionContentProvider,
      participantInstance,
    ),
  );

  // Session item controller for listing persisted sessions in the sidebar
  if (sessionDb) {
    setupSessionItemController(agent, sessionManager, sessionDb, context, outputChannel);
  }

  return sessionManager;
}

function setupSessionItemController(
  agent: AcpAgentEntry,
  sessionManager: AcpSessionManager,
  sessionDb: AcpSessionDb,
  context: vscode.ExtensionContext,
  outputChannel: vscode.LogOutputChannel,
): void {
  try {
    const inProgressItems = new Map<string, vscode.ChatSessionItem>();
    const sessionType = createSessionType(agent.id);

    const controller = vscode.chat.createChatSessionItemController(
      sessionType,
      async (_token) => {
        const diskItems = await sessionManager.listSessions();
        const items = diskItems.map((i) => {
          const item = controller.createChatSessionItem(i.resource, i.label);
          item.status = i.status;
          if (i.timing) {
            item.timing = i.timing;
          }
          return item;
        });
        const merged = [...items, ...inProgressItems.values()];
        controller.items.replace(merged);
      },
    );
    context.subscriptions.push(controller);

    controller.newChatSessionItemHandler = async (ctx, _token) => {
      return handleNewChatSessionItem(ctx, sessionManager, controller, inProgressItems, agent);
    };

    // Update items when sessions change
    context.subscriptions.push(
      sessionManager.onDidChangeSession(async ({ modified }) => {
        await handleSessionChange(modified, controller, inProgressItems, sessionDb, agent, outputChannel);
      }),
    );
  } catch (error) {
    outputChannel.debug(
      `Could not register session item controller for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleNewChatSessionItem(
  ctx: any,
  sessionManager: AcpSessionManager,
  controller: any,
  inProgressItems: Map<string, vscode.ChatSessionItem>,
  agent: AcpAgentEntry,
): Promise<vscode.ChatSessionItem> {
  const sessionResource: vscode.Uri | undefined = ctx.request.sessionResource;
  const active = sessionManager.getActive(sessionResource);
  
  if (active) {
    const uri = sessionManager.createSessionUri(active);
    const item = controller.createChatSessionItem(uri, active.acpSessionId);
    item.status = vscode.ChatSessionStatus.InProgress;
    item.timing = {
      created: Date.now(),
      lastRequestStarted: Date.now(),
    };
    inProgressItems.set(active.acpSessionId, item);
    return item;
  }
  
  const resource = sessionResource ?? createSessionUri(agent.id, `untitled-${randomUUID()}`);
  const item = controller.createChatSessionItem(resource, ctx.request.prompt);
  item.status = vscode.ChatSessionStatus.InProgress;
  item.timing = {
    created: Date.now(),
    lastRequestStarted: Date.now(),
  };
  inProgressItems.set(resource.toString(), item);
  return item;
}

async function handleSessionChange(
  modified: any, // AcpSession type not available in this scope
  controller: any,
  inProgressItems: Map<string, vscode.ChatSessionItem>,
  sessionDb: AcpSessionDb,
  agent: AcpAgentEntry,
  outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  const key = inProgressItems.has(modified.acpSessionId)
    ? modified.acpSessionId
    : modified.vscodeResource.toString();
  const item = inProgressItems.get(key);
  if (!item) return;

  item.label = modified.title;
  item.status = modified.status;
  const existing = item.timing;
  
  if (modified.status === vscode.ChatSessionStatus.InProgress) {
    item.timing = {
      ...(existing ?? { created: Date.now() }),
      lastRequestStarted: Date.now(),
      lastRequestEnded: undefined,
    };
  } else {
    item.timing = {
      ...(existing ?? { created: Date.now() }),
      lastRequestEnded: Date.now(),
    };
  }

  if (
    modified.status !== vscode.ChatSessionStatus.InProgress &&
    modified.status !== vscode.ChatSessionStatus.NeedsInput
  ) {
    inProgressItems.delete(key);
    try {
      const notifications = [...modified.collectedNotifications];
      outputChannel.info(
        `[acp:${agent.id}] Persisting session ${modified.acpSessionId} with ${notifications.length} notifications`,
      );
      await sessionDb.upsertSession(modified.agent.id, {
        sessionId: modified.acpSessionId,
        cwd: modified.cwd,
        title: modified.title,
        updatedAt: modified.updatedAt,
        notifications,
      });
      
      const cts = new vscode.CancellationTokenSource();
      try {
        await controller.refreshHandler(cts.token);
      } finally {
        cts.dispose();
      }
    } catch (err) {
      outputChannel.error(
        `Failed to persist session ${modified.acpSessionId}: ${err}`,
      );
    }
  }
}

function setupGlobalSessionDisposal(
  managers: Map<string, AcpSessionManager>,
  outputChannel: vscode.LogOutputChannel,
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.chat.onDidDisposeChatSession((sessionUriStr: string) => {
      const uri = vscode.Uri.parse(sessionUriStr);
      const agentId = getAgentIdFromResource(uri);
      if (!agentId) return;
      managers.get(agentId)?.closeSession(uri);
      outputChannel.info(`ACP session disposed: ${sessionUriStr}`);
    }),
  );
}
