import * as vscode from "vscode";
import type { AcpAgentEntry } from "../types";
import { createSessionType } from "./identifiers";
import { AcpSessionManager } from "../session/session-manager";

const ACP_DEFAULT_MAX_INPUT_TOKENS = 59_000;
const ACP_DEFAULT_MAX_OUTPUT_TOKENS = 1;
const GLOBAL_STATE_KEY_PREFIX = "acp.models.";
const GLOBAL_STATE_MAX_TOKENS_KEY_PREFIX = "acp.modelMaxTokens.";

type AcpModelInfo = vscode.LanguageModelChatInformation & {
  readonly isUserSelectable?: boolean;
  readonly targetChatSessionType?: string;
};

/**
 * Registers language models for an ACP agent so that VS Code knows about
 * them in the model picker. Dynamically updates the model list as the
 * agent reports available models.
 */
export class AcpLanguageModelProvider
  implements vscode.LanguageModelChatProvider<AcpModelInfo>, vscode.Disposable
{
  private readonly seedModelId: string;
  private readonly sessionType: string;
  private readonly globalStateKey: string;
  private readonly maxTokensStateKey: string;
  private models: AcpModelInfo[];
  private readonly modelMaxInputTokens: Map<string, number>;

  private readonly _onDidChangeLanguageModelChatInformation =
    new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation =
    this._onDidChangeLanguageModelChatInformation.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly agent: AcpAgentEntry,
    sessionManager: AcpSessionManager,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.seedModelId = `${agent.id}-default`;
    this.sessionType = createSessionType(agent.id);
    this.globalStateKey = `${GLOBAL_STATE_KEY_PREFIX}${agent.id}`;
    this.maxTokensStateKey = `${GLOBAL_STATE_MAX_TOKENS_KEY_PREFIX}${agent.id}`;

    // Load persisted max-token overrides
    const persistedMaxTokens = this.context.globalState.get<
      Record<string, number>
    >(this.maxTokensStateKey, {});
    this.modelMaxInputTokens = new Map(Object.entries(persistedMaxTokens));

    // Load persisted models
    const persisted = this.context.globalState.get<AcpModelInfo[]>(
      this.globalStateKey,
    );
    this.models = this.buildModelInfoList(persisted ?? []);

    this.disposables.push(
      sessionManager.onDidOptionsChange(async () => {
        const options = await sessionManager.getOptions();
        const modelState = options.models;
        if (!modelState) return;
        const realModels = modelState.availableModels.map((m) =>
          this.mapToModelInfo(m.modelId, m.name, m.description),
        );
        this.models = this.buildModelInfoList(realModels);
        await this.context.globalState.update(this.globalStateKey, realModels);
        this._onDidChangeLanguageModelChatInformation.fire();
      }),
    );

    this.disposables.push(
      sessionManager.onDidUsageUpdate(async ({ modelId, maxWindowSize }) => {
        this.modelMaxInputTokens.set(modelId, maxWindowSize);
        const persisted: Record<string, number> = {};
        this.modelMaxInputTokens.forEach((v, k) => {
          persisted[k] = v;
        });
        await this.context.globalState.update(
          this.maxTokensStateKey,
          persisted,
        );
        this.models = this.buildModelInfoList(
          this.models.filter((m) => m.id !== this.seedModelId),
        );
        this._onDidChangeLanguageModelChatInformation.fire();
      }),
    );
  }

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<AcpModelInfo[]> {
    return this.models;
  }

  provideLanguageModelChatResponse(
    _model: AcpModelInfo,
    _messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    _progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    _token: vscode.CancellationToken,
  ): Thenable<void> {
    return Promise.resolve();
  }

  provideTokenCount(
    _model: AcpModelInfo,
    _text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    return Promise.resolve(0);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidChangeLanguageModelChatInformation.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private buildModelInfoList(realModels: AcpModelInfo[]): AcpModelInfo[] {
    const seed = this.buildSeedModel();
    const filtered = realModels
      .filter((m) => m.id !== this.seedModelId)
      .map((m) => {
        const maxTokens =
          this.modelMaxInputTokens.get(m.id) ?? ACP_DEFAULT_MAX_INPUT_TOKENS;
        return {
          ...m,
          maxInputTokens: maxTokens - ACP_DEFAULT_MAX_OUTPUT_TOKENS,
          maxOutputTokens: ACP_DEFAULT_MAX_OUTPUT_TOKENS,
        };
      });
    return [seed, ...filtered];
  }

  private buildSeedModel(): AcpModelInfo {
    return {
      id: this.seedModelId,
      name: this.agent.label,
      family: `acp-${this.agent.id}`,
      version: "default",
      maxInputTokens:
        ACP_DEFAULT_MAX_INPUT_TOKENS - ACP_DEFAULT_MAX_OUTPUT_TOKENS,
      maxOutputTokens: ACP_DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: { toolCalling: true },
      isUserSelectable: false,
      targetChatSessionType: this.sessionType,
    };
  }

  private mapToModelInfo(
    modelId: string,
    name: string,
    description?: string | null,
  ): AcpModelInfo {
    return {
      id: modelId,
      name,
      family: `acp-${this.agent.id}`,
      version: modelId,
      maxInputTokens:
        (this.modelMaxInputTokens.get(modelId) ??
          ACP_DEFAULT_MAX_INPUT_TOKENS) - ACP_DEFAULT_MAX_OUTPUT_TOKENS,
      maxOutputTokens: ACP_DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: { toolCalling: true },
      tooltip: description ?? undefined,
      isUserSelectable: true,
      targetChatSessionType: this.sessionType,
    };
  }
}
