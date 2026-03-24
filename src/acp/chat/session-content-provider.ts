import * as vscode from "vscode";
import type {
  SessionConfigOption,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import { AcpChatParticipant } from "./participant";
import { AcpSessionManager, type AcpOptions } from "../session/session-manager";

const OPTION_MODE = "mode";
const OPTION_MODEL = "model";

/**
 * Provides session content for the native VS Code chat UI.
 *
 * When VS Code opens a session of type `acp-<agentId>`, it calls
 * `provideChatSessionContent` which creates or retrieves the ACP session
 * and returns a `ChatSession` with the request handler wired up.
 *
 * Also exposes agent-specific option groups (modes, models, thought-level)
 * so they appear as dropdowns in the chat UI.
 */
export class AcpChatSessionContentProvider
  implements vscode.ChatSessionContentProvider, vscode.Disposable
{
  private readonly _onDidChangeChatSessionOptions =
    new vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent>();
  readonly onDidChangeChatSessionOptions =
    this._onDidChangeChatSessionOptions.event;

  private readonly _onDidChangeChatSessionProviderOptions =
    new vscode.EventEmitter<void>();
  readonly onDidChangeChatSessionProviderOptions =
    this._onDidChangeChatSessionProviderOptions.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly sessionManager: AcpSessionManager,
    private readonly participant: AcpChatParticipant,
    private readonly logChannel: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      sessionManager.onDidOptionsChange(() => {
        this._onDidChangeChatSessionProviderOptions.fire();
      }),
    );

    this.disposables.push(
      sessionManager.onDidCurrentModeChange(({ resource, modeId }) => {
        this._onDidChangeChatSessionOptions.fire({
          resource,
          updates: [{ optionId: OPTION_MODE, value: modeId }],
        });
      }),
    );

    this.disposables.push(
      sessionManager.onDidCurrentModelChange(({ resource, modelId }) => {
        this._onDidChangeChatSessionOptions.fire({
          resource,
          updates: [{ optionId: OPTION_MODEL, value: modelId }],
        });
      }),
    );
  }

  async provideChatSessionContent(
    resource: vscode.Uri,
    _token: vscode.CancellationToken,
  ): Promise<vscode.ChatSession> {
    const { session, history } =
      await this.sessionManager.createOrGet(resource);

    this.logChannel.debug(
      `Providing chat session content for resource: ${resource.toString()}, acpSessionId: ${session.acpSessionId}, history length: ${history?.length ?? 0}`,
    );

    // Defer provider options notification so VS Code processes it after
    // session setup is complete. Firing inside createOrGet is too early
    // because provideChatSessionContent hasn't returned yet.
    setTimeout(() => {
      this._onDidChangeChatSessionProviderOptions.fire();
    }, 0);

    return {
      history: history ?? [],
      requestHandler: this.participant.requestHandler,
      options: {
        [OPTION_MODE]: session.defaultChatOptions.modeId,
        [OPTION_MODEL]: session.defaultChatOptions.modelId,
        ...this.buildThoughtLevelDefaults(
          session.client
            .getConfigOptions()
            .filter((o) => o.category === "thought_level"),
        ),
      },
    };
  }

  async provideChatSessionProviderOptions(
    _token: vscode.CancellationToken,
  ): Promise<vscode.ChatSessionProviderOptions> {
    const options = await this.sessionManager.getOptions();
    return this.buildOptionsGroups(options);
  }

  provideHandleOptionsChange(
    resource: vscode.Uri,
    updates: ReadonlyArray<vscode.ChatSessionOptionUpdate>,
    _token: vscode.CancellationToken,
  ): void {
    const session = this.sessionManager.getActive(resource);
    if (!session) {
      this.logChannel.warn(
        `No session found to handle provideHandleOptionsChange for ${resource.toString()}`,
      );
      return;
    }

    const knownThoughtLevelIds = new Set(
      session.client
        .getConfigOptions()
        .filter((o) => o.category === "thought_level")
        .map((o) => o.id),
    );

    for (const update of updates) {
      if (update.optionId === OPTION_MODE && update.value) {
        session.client.changeMode(session.acpSessionId, update.value);
      }

      if (update.optionId === OPTION_MODEL && update.value) {
        session.client.changeModel(session.acpSessionId, update.value);
      }

      if (
        knownThoughtLevelIds.has(update.optionId) &&
        update.value &&
        typeof update.value === "string"
      ) {
        session.client.setSessionConfigOption(
          session.acpSessionId,
          update.optionId,
          update.value,
        );
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidChangeChatSessionOptions.dispose();
    this._onDidChangeChatSessionProviderOptions.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private buildOptionsGroups(
    options: AcpOptions,
  ): vscode.ChatSessionProviderOptions {
    const groups: vscode.ChatSessionProviderOptionGroup[] = [];

    if (options.modes) {
      const modeItems: vscode.ChatSessionProviderOptionItem[] =
        options.modes.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description ?? undefined,
        }));
      groups.push({
        id: OPTION_MODE,
        name: vscode.l10n.t("Mode"),
        description: vscode.l10n.t("Select the mode for the chat session"),
        items: modeItems,
      });
    }

    if (options.models) {
      const modelItems: vscode.ChatSessionProviderOptionItem[] =
        options.models.availableModels.map((model) => ({
          id: model.modelId,
          name: model.name,
          description: model.description ?? undefined,
        }));
      groups.push({
        id: OPTION_MODEL,
        name: vscode.l10n.t("Model"),
        description: vscode.l10n.t("Select the model for the chat session"),
        items: modelItems,
      });
    }

    if (options.thoughtLevelOptions) {
      for (const configOption of options.thoughtLevelOptions) {
        const flatOptions = configOption.options.filter(
          (opt): opt is SessionConfigSelectOption => "value" in opt,
        );
        groups.push({
          id: configOption.id,
          name: vscode.l10n.t(configOption.name),
          description: configOption.description
            ? vscode.l10n.t(configOption.description)
            : undefined,
          items: flatOptions.map((opt) => ({
            id: opt.value,
            name: opt.name,
            description: opt.description ?? undefined,
          })),
        });
      }
    }

    return { optionGroups: groups };
  }

  private buildThoughtLevelDefaults(
    thoughtLevelOptions: SessionConfigOption[],
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const option of thoughtLevelOptions) {
      result[option.id] = option.currentValue;
    }
    return result;
  }
}
