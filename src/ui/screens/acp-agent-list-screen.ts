import * as vscode from "vscode";
import { pickQuickItem, confirmDelete, showDeletedMessage } from "../component";
import type {
  AcpAgentListRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from "../router/types";
import { entryToDraft, createEmptyDraft } from "../../acp";
import type { AcpAgentEntry } from "../../acp";
import { t } from "../../i18n";

type AcpAgentListItem = vscode.QuickPickItem & {
  action?: "add" | "add-from-wellknown" | "back" | "agent";
  agentId?: string;
};

export async function runAcpAgentListScreen(
  ctx: UiContext,
  _route: AcpAgentListRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const acpStore = ctx.acpStore;
  if (!acpStore) return { kind: "pop" };

  const selection = await pickQuickItem<AcpAgentListItem>({
    title: t("Manage ACP Agents"),
    placeholder: t("Select an agent to edit, or add a new one"),
    ignoreFocusOut: false,
    items: buildAgentListItems(acpStore.agents),
    onExternalRefresh: (refreshItems) => {
      const disposable = acpStore.onDidChange(() => {
        refreshItems(buildAgentListItems(acpStore.agents));
      });
      return disposable;
    },
    onDidTriggerItemButton: async (event, qp) => {
      const item = event.item;
      if (item.action !== "agent" || !item.agentId) return;

      // Delete
      qp.ignoreFocusOut = true;
      const confirmed = await confirmDelete(item.agentId, "ACP agent");
      qp.ignoreFocusOut = false;

      if (!confirmed) return;
      await acpStore.removeAgent(item.agentId);
      showDeletedMessage(item.agentId, "ACP agent");
      qp.items = buildAgentListItems(acpStore.agents);
      return;
    },
  });

  if (!selection) return { kind: "pop" };

  if (selection.action === "back") {
    return { kind: "pop" };
  }

  if (selection.action === "add") {
    return {
      kind: "push",
      route: {
        kind: "acpAgentForm",
        draft: createEmptyDraft(),
      },
    };
  }

  if (selection.action === "add-from-wellknown") {
    return {
      kind: "push",
      route: { kind: "acpWellKnownAgentList" },
    };
  }

  if (selection.agentId) {
    const existing = acpStore.getAgent(selection.agentId);
    if (!existing) {
      vscode.window.showErrorMessage(
        t('ACP agent "{0}" not found.', selection.agentId),
      );
      return { kind: "stay" };
    }

    return {
      kind: "push",
      route: {
        kind: "acpAgentForm",
        draft: entryToDraft(existing),
        existing,
        originalId: existing.id,
      },
    };
  }

  return { kind: "stay" };
}

function buildAgentListItems(agents: AcpAgentEntry[]): AcpAgentListItem[] {
  const items: AcpAgentListItem[] = [
    {
      label: "$(add) " + t("Add ACP Agent..."),
      action: "add",
      alwaysShow: true,
    },
    {
      label: "$(star-empty) " + t("Add From Well-Known Agent List..."),
      action: "add-from-wellknown",
      alwaysShow: true,
    },
  ];

  for (const agent of agents) {
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });

    const cmdLine = [agent.command, ...agent.args].join(" ");

    items.push({
      label: agent.label,
      description: `[${agent.id}]`,
      detail: `${t("Command")}: ${cmdLine}`,
      action: "agent",
      agentId: agent.id,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon("trash"),
          tooltip: t("Delete agent"),
        },
      ],
    });
  }

  return items;
}
