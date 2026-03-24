import * as vscode from "vscode";
import { pickQuickItem, showInput } from "../component";
import { editField } from "../field-editors";
import {
  buildFormItems,
  type FieldContext,
  type FormItem,
  type FormSchema,
} from "../field-schema";
import type {
  AcpAgentFormRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from "../router/types";
import { draftToConfig, WELL_KNOWN_ACP_AGENTS } from "../../acp";
import type { AcpAgentDraft } from "../../acp";
import { t } from "../../i18n";

// ---------------------------------------------------------------------------
// Field context
// ---------------------------------------------------------------------------

interface AcpAgentFieldContext extends FieldContext {
  isEditing: boolean;
  existingIds: string[];
}

// ---------------------------------------------------------------------------
// Form schema
// ---------------------------------------------------------------------------

const acpAgentFormSchema: FormSchema<AcpAgentDraft> = {
  sections: [
    { id: "primary", label: t("Primary Fields") },
    { id: "advanced", label: t("Advanced Fields") },
  ],
  fields: [
    // Agent ID
    {
      key: "id",
      type: "custom",
      label: t("Agent ID"),
      icon: "symbol-key",
      section: "primary",
      edit: async (draft, context) => {
        const ctx = context as AcpAgentFieldContext;
        if (ctx.isEditing) {
          vscode.window.showInformationMessage(
            t("Agent ID cannot be changed after creation."),
          );
          return;
        }
        const newId = await pickAgentId(draft.id, ctx.existingIds);
        if (newId !== undefined) {
          draft.id = newId;
          // Auto-fill from well-known agents when command is not yet set
          const known = WELL_KNOWN_ACP_AGENTS.find((a) => a.id === newId);
          if (known && !draft.command) {
            draft.command = known.command;
            draft.args = known.args.join(" ");
            if (!draft.label) {
              draft.label = known.label;
            }
          }
        }
      },
      getDescription: (draft, context) => {
        const ctx = context as AcpAgentFieldContext | undefined;
        if (!draft.id) return t("(required)");
        if (ctx?.isEditing) return `${draft.id} (${t("read-only")})`;
        return draft.id;
      },
    },
    // Label
    {
      key: "label",
      type: "text",
      label: t("Label"),
      icon: "tag",
      section: "primary",
      prompt: t("Display label for the agent"),
      placeholder: t("e.g. Claude Code"),
      transform: (v) => v.trim(),
      getDescription: (draft) => draft.label || t("(optional)"),
    },
    // Command
    {
      key: "command",
      type: "text",
      label: t("Command"),
      icon: "terminal",
      section: "primary",
      prompt: t("CLI executable that starts the ACP agent"),
      placeholder: t("e.g. claude, codex, gemini"),
      required: true,
      transform: (v) => v.trim(),
      getDescription: (draft) => draft.command || t("(required)"),
    },
    // Arguments
    {
      key: "args",
      type: "text",
      label: t("Arguments"),
      icon: "list-flat",
      section: "primary",
      prompt: t("Arguments passed to the CLI (space-separated)"),
      placeholder: t("e.g. acp --flag"),
      transform: (v) => v.trim(),
      getDescription: (draft) => draft.args || t("(none)"),
    },
    // Working Directory
    {
      key: "cwd",
      type: "text",
      label: t("Working Directory"),
      icon: "folder",
      section: "advanced",
      prompt: t("Working directory for the agent process"),
      placeholder: t("Leave blank for workspace root"),
      transform: (v) => v.trim(),
      getDescription: (draft) => draft.cwd || t("(workspace root)"),
    },
    // Environment
    {
      key: "env",
      type: "custom",
      label: t("Environment"),
      icon: "symbol-variable",
      section: "advanced",
      edit: async (draft) => {
        await editEnvVariables(draft);
      },
      getDescription: (draft) => {
        const count = draft.env
          ? draft.env.split("\n").filter(Boolean).length
          : 0;
        return count > 0 ? t("{0} variable(s)", count.toString()) : t("(none)");
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Screen handler
// ---------------------------------------------------------------------------

export async function runAcpAgentFormScreen(
  ctx: UiContext,
  route: AcpAgentFormRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const acpStore = ctx.acpStore;
  if (!acpStore) return { kind: "pop" };

  const draft = route.draft;
  const isEditing = route.existing !== undefined;
  const title = isEditing
    ? t("Edit ACP Agent: {0}", route.originalId ?? draft.id)
    : t("Add ACP Agent");

  const fieldContext: AcpAgentFieldContext = {
    isEditing,
    existingIds: acpStore.agents.map((a) => a.id),
  };

  const selection = await pickQuickItem<FormItem<AcpAgentDraft>>({
    title,
    placeholder: t("Select a field to edit"),
    ignoreFocusOut: true,
    items: buildFormItems(
      acpAgentFormSchema,
      draft,
      {
        isEditing,
        hasConfirm: true,
        hasExport: false,
      },
      fieldContext,
    ),
  });

  // Dismissed (Escape / click away)
  if (!selection || selection.action === "cancel") {
    return { kind: "pop" };
  }

  // Save
  if (selection.action === "confirm") {
    const errors = validateDraft(draft);
    if (errors.length > 0) {
      await vscode.window.showErrorMessage(errors.join("\n"), { modal: true });
      return { kind: "stay" };
    }

    if (isEditing && route.originalId && route.originalId !== draft.id) {
      await acpStore.removeAgent(route.originalId);
    }

    const config = draftToConfig(draft);
    await acpStore.upsertAgent(draft.id, config);

    vscode.window.showInformationMessage(
      isEditing
        ? t('ACP agent "{0}" updated.', draft.id)
        : t('ACP agent "{0}" added.', draft.id),
    );
    return { kind: "pop" };
  }

  // Delete
  if (selection.action === "delete" && isEditing && route.originalId) {
    const answer = await vscode.window.showWarningMessage(
      t('Delete ACP agent "{0}"?', route.originalId),
      { modal: true },
      t("Delete"),
    );
    if (answer === t("Delete")) {
      await acpStore.removeAgent(route.originalId);
      vscode.window.showInformationMessage(
        t('ACP agent "{0}" deleted.', route.originalId),
      );
      return { kind: "pop" };
    }
    return { kind: "stay" };
  }

  // Field edit – delegate to the generic editor
  const field = selection.field;
  if (field) {
    await editField(acpAgentFormSchema, draft, field, fieldContext);
  }

  return { kind: "stay" };
}

// ---------------------------------------------------------------------------
// Agent ID picker (custom field)
// ---------------------------------------------------------------------------

async function pickAgentId(
  current: string,
  existingIds: string[],
): Promise<string | undefined> {
  type IdItem = vscode.QuickPickItem & {
    agentId?: string;
    action?: "custom";
  };

  const existingSet = new Set(existingIds);

  const items: IdItem[] = [
    {
      label: `$(edit) ${t("Enter custom ID...")}`,
      action: "custom",
    },
    { label: "", kind: vscode.QuickPickItemKind.Separator },
  ];

  // Group well-known agents by category
  const byCategory = new Map<string, typeof WELL_KNOWN_ACP_AGENTS>();
  const categories: string[] = [];
  for (const agent of WELL_KNOWN_ACP_AGENTS) {
    if (!byCategory.has(agent.category)) {
      byCategory.set(agent.category, []);
      categories.push(agent.category);
    }
    byCategory.get(agent.category)!.push(agent);
  }

  for (const category of categories) {
    items.push({
      label: "",
      kind: vscode.QuickPickItemKind.Separator,
      description: t(category),
    });

    const group = byCategory.get(category);
    if (!group) continue;

    for (const agent of group) {
      items.push({
        label: agent.label,
        description: existingSet.has(agent.id)
          ? `[${agent.id}] — ${t("(already configured)")}`
          : `[${agent.id}]`,
        detail: `${agent.command} ${agent.args.join(" ")}`,
        picked: agent.id === current,
        agentId: agent.id,
      });
    }
  }

  const picked = await pickQuickItem<IdItem>({
    title: t("Select Agent ID"),
    placeholder: t("Choose from well-known agents or enter a custom ID"),
    matchOnDescription: true,
    items,
  });

  if (!picked) return undefined;

  if (picked.action === "custom") {
    const { showInput } = await import("../component");
    return showInput({
      prompt: t("Agent ID (used as the key in settings.json)"),
      placeHolder: t("e.g. my-agent"),
      value: current,
      validateInput: (v) => {
        if (!v.trim()) return t("Agent ID is required");
        if (/\s/.test(v.trim())) return t("Agent ID must not contain spaces");
        return null;
      },
    });
  }

  return picked.agentId;
}

// ---------------------------------------------------------------------------
// Environment variable list editor
// ---------------------------------------------------------------------------

type EnvItem = vscode.QuickPickItem & {
  action?: "add" | "back";
  envKey?: string;
};

/**
 * Parse the draft.env string into key-value pairs.
 */
function parseEnvEntries(
  envStr: string,
): Array<{ key: string; value: string }> {
  if (!envStr.trim()) return [];
  return envStr
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const eqIndex = line.indexOf("=");
      if (eqIndex <= 0) return { key: line.trim(), value: "" };
      return {
        key: line.substring(0, eqIndex).trim(),
        value: line.substring(eqIndex + 1).trim(),
      };
    });
}

/**
 * Serialize key-value pairs back to the draft.env string.
 */
function serializeEnvEntries(
  entries: Array<{ key: string; value: string }>,
): string {
  return entries.map((e) => `${e.key}=${e.value}`).join("\n");
}

function buildEnvListItems(
  entries: Array<{ key: string; value: string }>,
): EnvItem[] {
  const items: EnvItem[] = [
    { label: `$(arrow-left) ${t("Back")}`, action: "back" },
    {
      label: `$(add) ${t("Add Variable...")}`,
      action: "add",
      alwaysShow: true,
    },
  ];

  if (entries.length > 0) {
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    for (const entry of entries) {
      items.push({
        label: entry.key,
        description: entry.value,
        envKey: entry.key,
        buttons: [
          {
            iconPath: new vscode.ThemeIcon("trash"),
            tooltip: t("Delete"),
          },
        ],
      });
    }
  }

  return items;
}

async function editEnvVariables(draft: AcpAgentDraft): Promise<void> {
  const entries = parseEnvEntries(draft.env);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const picked = await pickQuickItem<EnvItem>({
      title: t("Environment Variables"),
      placeholder: t("Select a variable to edit, or add a new one"),
      ignoreFocusOut: true,
      items: buildEnvListItems(entries),
      onDidTriggerItemButton: async (event, qp) => {
        const item = event.item;
        if (!item.envKey) return;
        const idx = entries.findIndex((e) => e.key === item.envKey);
        if (idx >= 0) {
          entries.splice(idx, 1);
          draft.env = serializeEnvEntries(entries);
          qp.items = buildEnvListItems(entries);
        }
      },
    });

    if (!picked || picked.action === "back") return;

    if (picked.action === "add") {
      const result = await promptEnvEntry();
      if (result) {
        const existing = entries.findIndex((e) => e.key === result.key);
        if (existing >= 0) {
          entries[existing].value = result.value;
        } else {
          entries.push(result);
        }
        draft.env = serializeEnvEntries(entries);
      }
      continue;
    }

    // Edit existing entry
    if (picked.envKey) {
      const entry = entries.find((e) => e.key === picked.envKey);
      if (!entry) continue;
      const result = await promptEnvEntry(entry);
      if (result) {
        entry.key = result.key;
        entry.value = result.value;
        draft.env = serializeEnvEntries(entries);
      }
    }
  }
}

async function promptEnvEntry(current?: {
  key: string;
  value: string;
}): Promise<{ key: string; value: string } | undefined> {
  const key = await showInput({
    prompt: t("Variable name"),
    placeHolder: t("e.g. API_KEY"),
    value: current?.key ?? "",
    validateInput: (v) => {
      if (!v.trim()) return t("Variable name is required");
      if (/\s/.test(v.trim()))
        return t("Variable name must not contain spaces");
      return null;
    },
  });
  if (key === undefined) return undefined;

  const value = await showInput({
    prompt: t("Value for {0}", key),
    placeHolder: t("e.g. sk-..."),
    value: current?.value ?? "",
  });
  if (value === undefined) return undefined;

  return { key: key.trim(), value: value.trim() };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateDraft(draft: AcpAgentDraft): string[] {
  const errors: string[] = [];

  if (!draft.id.trim()) {
    errors.push(t("Agent ID is required"));
  } else if (/\s/.test(draft.id.trim())) {
    errors.push(t("Agent ID must not contain spaces"));
  }

  if (!draft.command.trim()) {
    errors.push(t("Command is required"));
  }

  return errors;
}
