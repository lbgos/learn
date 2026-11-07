import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { AtomIcon, PenLineIcon } from "lucide-react";

import type {
  CommandPaletteActionItem,
  CommandPaletteSubmenuItem,
} from "~/components/CommandPalette.logic";
import { ADDON_ICON_CLASS, ITEM_ICON_CLASS } from "~/components/CommandPalette.logic";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { physicsEnvironment } from "./state";

/**
 * "Open whiteboard" and "Open simulation…" (one entry per sim in the thread's project).
 * Draft threads count too: `draft` leaves the thread id out of the workspace lookup.
 */
export function usePhysicsPaletteItems(
  target: {
    readonly threadRef: ScopedThreadRef;
    readonly projectId: ProjectId;
    readonly draft: boolean;
  } | null,
): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const workspace = useEnvironmentQuery(
    target
      ? physicsEnvironment.workspace({
          environmentId: target.threadRef.environmentId,
          input: {
            projectId: target.projectId,
            ...(target.draft ? {} : { threadId: target.threadRef.threadId }),
          },
        })
      : null,
  );
  if (!target) return [];
  const { threadRef } = target;
  const items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
    {
      kind: "action",
      value: "action:open-whiteboard",
      searchTerms: ["whiteboard", "board", "draw", "sketch"],
      title: "Open whiteboard",
      icon: <PenLineIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "whiteboard.toggle",
      run: async () => {
        useRightPanelStore.getState().openWhiteboard(threadRef);
      },
    },
  ];
  const sims = workspace.data?.sims ?? [];
  if (sims.length > 0) {
    items.push({
      kind: "submenu",
      value: "action:open-simulation",
      searchTerms: ["simulation", "sim", "physics", "open"],
      title: "Open simulation…",
      icon: <AtomIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <AtomIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: "simulations",
          label: "Simulations",
          items: sims.map((sim) => ({
            kind: "action" as const,
            value: `sim:${sim.path}`,
            searchTerms: [sim.path, sim.title ?? "", "simulation"],
            title: sim.title ?? sim.path,
            description: sim.path,
            icon: <AtomIcon className={ITEM_ICON_CLASS} />,
            run: async () => {
              useRightPanelStore.getState().openSimulation(threadRef, sim.path);
            },
          })),
        },
      ],
    });
  }
  return items;
}
