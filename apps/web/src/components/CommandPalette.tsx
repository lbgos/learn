"use client";

import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon, SettingsIcon, SquarePenIcon, TextSearchIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import {
  dispatchCommandPalette,
  useCommandPaletteMount,
  useCommandPaletteStore,
} from "../commandPaletteStore";
import { ComposerHandleContext } from "../composerHandleContext";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { resolveShortcutCommand } from "../keybindings";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { usePhysicsPaletteItems } from "../physics/usePhysicsPaletteItems";
import { useThreadShells } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
  filterCommandPaletteGroups,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { openThreadFind } from "./chat/threadFindStore";
import { searchSettings, SETTINGS_SECTION_LABELS } from "./settings/settingsSearch";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { toastManager } from "./ui/toast";

const setOpen = (open: boolean) => dispatchCommandPalette({ _tag: "SetOpen", open });

export function CommandPalette({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  useCommandPaletteMount();
  const { open, openIntent, session } = useCommandPaletteStore();
  const [query, setQuery] = useState(openIntent?.kind === "search" ? openIntent.query : "");
  const [submenu, setSubmenu] = useState<CommandPaletteSubmenuItem | null>(null);
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const threads = useThreadShells();
  const settings = useAvailableSettingsSearchItems();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const target = activeThread
    ? {
        threadRef: scopeThreadRef(activeThread.environmentId, activeThread.id),
        projectId: activeThread.projectId,
        draft: false,
      }
    : activeDraftThread
      ? {
          threadRef: scopeThreadRef(activeDraftThread.environmentId, activeDraftThread.threadId),
          projectId: activeDraftThread.projectId,
          draft: true,
        }
      : null;
  const physicsItems = usePhysicsPaletteItems(target);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for the palette, usage and theme shortcuts while mounted
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: false,
          terminalOpen: false,
          previewFocus: false,
          previewOpen: false,
          modelPickerOpen: composerHandleRef.current?.isModelPickerOpen() ?? false,
        },
      });
      if (
        command !== "commandPalette.toggle" &&
        command !== "usage.open" &&
        command !== "theme.select"
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (command === "theme.select") {
        setOpen(false);
        void navigate({ to: "/settings/appearance" });
      } else if (command === "usage.open") {
        setOpen(false);
        void navigate({ to: "/usage" });
      } else {
        setQuery("");
        setSubmenu(null);
        dispatchCommandPalette({ _tag: "SetOpen", open: !useCommandPaletteStore.getState().open });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, navigate]);

  // Every intent bumps `session`, so an already open palette starts over from the new one.
  const [seenSession, setSeenSession] = useState(session);
  if (seenSession !== session) {
    setSeenSession(session);
    setQuery(openIntent?.kind === "search" ? openIntent.query : "");
    setSubmenu(null);
  }

  const actions: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
    {
      kind: "action",
      value: "action:new-thread",
      title: "New thread",
      searchTerms: ["new thread", "chat", "create"],
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.newLocal",
      run: async () => {
        await startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
      },
    },
    ...physicsItems,
    {
      kind: "action",
      value: "action:settings",
      title: "Settings",
      searchTerms: ["settings", "preferences", "providers", "appearance", "notifications"],
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/settings/general" });
      },
    },
    {
      kind: "action",
      value: "action:usage",
      title: "Usage",
      searchTerms: ["usage", "limits", "tokens", "cost"],
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/usage" });
      },
    },
  ];
  if (activeThread) {
    actions.push({
      kind: "action",
      value: "find-current-thread",
      title: "Find in current thread",
      searchTerms: ["find", "search", "messages"],
      icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openThreadFind(
          scopedThreadKey(scopeThreadRef(activeThread.environmentId, activeThread.id)),
        );
      },
    });
  }
  const threadItems: CommandPaletteActionItem[] = threads
    .filter((thread) => thread.archivedAt === null)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((thread) => ({
      kind: "action",
      value: `thread:${thread.environmentId}:${thread.id}`,
      title: thread.title,
      searchTerms: [thread.title, thread.id],
      icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
        });
      },
    }));
  const settingItems: CommandPaletteActionItem[] = searchSettings(query, settings).map((item) => ({
    kind: "action",
    value: `setting:${item.id}`,
    title: item.title,
    description: `Settings · ${SETTINGS_SECTION_LABELS[item.to]}`,
    searchTerms: [item.title, ...(item.searchTerms ?? [])],
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: item.to, hash: item.targetId ?? item.id, hashScrollIntoView: false });
    },
  }));
  const rootGroups: CommandPaletteGroup[] = [
    { value: "actions", label: "Actions", items: actions },
    { value: "threads", label: "Recent threads", items: threadItems.slice(0, RECENT_THREAD_LIMIT) },
  ];
  const groups = filterCommandPaletteGroups({
    activeGroups: submenu?.groups ?? rootGroups,
    query,
    isInSubmenu: submenu !== null,
    projectSearchItems: [],
    settingsSearchItems: settingItems,
    threadSearchItems: threadItems,
  });
  const executeItem = (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => {
    if (item.kind === "submenu") {
      setSubmenu(item);
      setQuery("");
      return;
    }
    setOpen(false);
    void item.run().catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Command failed",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <div className="contents" inert={open}>
          {children}
        </div>
        {open ? (
          <CommandDialogPopup
            aria-label="Command palette"
            data-command-palette="true"
            data-testid="command-palette"
            onBackdropPointerDown={() => setOpen(false)}
            finalFocus={() => {
              composerHandleRef.current?.focusAtEnd();
              return false;
            }}
          >
            <CommandPaletteContent
              key={submenu?.value ?? "root"}
              items={groups}
              filter={null}
              onValueChange={setQuery}
              value={query}
              inputProps={{
                onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
                  if (submenu && event.key === "Backspace" && query.length === 0) setSubmenu(null);
                },
                placeholder: submenu ? "Search simulations" : "Search threads and commands",
              }}
              showBackHint={submenu !== null}
              footerActionLabel="Select"
            >
              <CommandPaletteResults
                groups={groups}
                keybindings={keybindings}
                isActionsOnly={query.startsWith(">")}
                onExecuteItem={executeItem}
              />
            </CommandPaletteContent>
          </CommandDialogPopup>
        ) : null}
      </CommandDialog>
    </ComposerHandleContext>
  );
}
