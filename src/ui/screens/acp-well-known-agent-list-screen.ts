import * as vscode from "vscode";
import { pickQuickItem } from "../component";
import type {
  AcpWellKnownAgentListRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from "../router/types";
import {
  WELL_KNOWN_ACP_AGENTS,
  wellKnownAgentToConfig,
  entryToDraft,
  type WellKnownAcpAgent,
} from "../../acp";
import { t } from "../../i18n";

type WellKnownAgentItem = vscode.QuickPickItem & {
  action?: "back";
  agent?: WellKnownAcpAgent;
};

export async function runAcpWellKnownAgentListScreen(
  ctx: UiContext,
  _route: AcpWellKnownAgentListRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const acpStore = ctx.acpStore;
  if (!acpStore) return { kind: "pop" };

  const existingIds = new Set(acpStore.agents.map((a) => a.id));

  const byCategory = new Map<string, WellKnownAcpAgent[]>();
  const categories: string[] = [];
  for (const agent of WELL_KNOWN_ACP_AGENTS) {
    if (!byCategory.has(agent.category)) {
      byCategory.set(agent.category, []);
      categories.push(agent.category);
    }
    byCategory.get(agent.category)!.push(agent);
  }

  const items: WellKnownAgentItem[] = [
    { label: `$(arrow-left) ${t("Back")}`, action: "back" },
    { label: "", kind: vscode.QuickPickItemKind.Separator },
  ];

  for (const category of categories) {
    items.push({
      label: "",
      kind: vscode.QuickPickItemKind.Separator,
      description: t(category),
    });

    const group = byCategory.get(category);
    if (!group) continue;

    for (const agent of group) {
      const alreadyConfigured = existingIds.has(agent.id);
      items.push({
        label: agent.label,
        description: alreadyConfigured
          ? t("(already configured)")
          : `[${agent.id}]`,
        detail: `${agent.description} — ${agent.command} ${agent.args.join(" ")}`,
        agent,
      });
    }
  }

  const picked = await pickQuickItem<WellKnownAgentItem>({
    title: t("Add From Well-Known ACP Agent List"),
    placeholder: t("Select an ACP agent"),
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
    items,
  });

  if (!picked || picked.action === "back" || !picked.agent) {
    return { kind: "pop" };
  }

  const agent = picked.agent;

  // If already configured, go to edit mode
  if (existingIds.has(agent.id)) {
    const existing = acpStore.getAgent(agent.id);
    if (existing) {
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
  }

  // Create config and go to form for review
  const config = wellKnownAgentToConfig(agent);

  return {
    kind: "push",
    route: {
      kind: "acpAgentForm",
      draft: {
        id: agent.id,
        label: config.label ?? agent.id,
        command: config.command,
        args: config.args ? config.args.join(" ") : "",
        cwd: "",
        env: "",
      },
    },
  };
}
