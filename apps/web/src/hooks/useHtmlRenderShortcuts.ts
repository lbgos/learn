import { useAtomValue } from "@effect/atom-react";
import {
  type KeybindingCommand,
  type KeybindingShortcut,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ScopedThreadRef,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import { type HtmlRenderShortcut, readHtmlRenderKeyDown } from "@t3tools/shared/htmlRender";
import {
  isMacPlatform,
  matchesKeybindingShortcut,
  normalizeEventKey,
} from "@t3tools/shared/keybindings";
import { useMemo } from "react";

import { shortcutConflictKey } from "~/keybindings";
import { primaryServerKeybindingsAtom, serverEnvironment } from "~/state/server";

/**
 * Shortcuts that still work while a focused HTML render holds the keyboard.
 * The page reports the keys, and a page script can report any key it likes,
 * so only commands that change what the reader sees are here, never one that
 * changes a thread.
 */
const HTML_RENDER_SHORTCUT_COMMANDS: ReadonlySet<KeybindingCommand> = new Set([
  "commandPalette.toggle",
  "filePicker.toggle",
  "projectSearch.toggle",
  "chat.find",
  "sidebar.toggle",
  "rightPanel.toggle",
  "rightPanel.toggleMaximized",
  "threadPanel.toggle",
  "terminal.toggle",
  "preview.toggle",
  "navigation.back",
  "navigation.forward",
  "thread.previous",
  "thread.next",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
  // Share Cmd/Ctrl+digit with thread jumps, and act only while the picker is open.
  ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
]);

const NO_COMMANDS: readonly KeybindingCommand[] = [];

/** A key a framed page reported; the shape `readHtmlRenderKeyDown` returns. */
export type HtmlRenderKey = NonNullable<ReturnType<typeof readHtmlRenderKeyDown>>;

/**
 * The chords a framed page may pass on to the app (`shortcuts`), and every other binding's chord
 * (`blocked`). The app resolves a replayed key in its live context, so every allowed binding
 * counts whatever its `when`, and a key that any binding gives to another command stays with the
 * page. Only Cmd/Ctrl chords: a printable key would type into the composer instead.
 * `extraCommands` adds view-only commands for frames that are more than a document; pass a stable
 * array.
 */
export function useHtmlRenderShortcuts(
  threadRef: ScopedThreadRef | undefined,
  extraCommands: readonly KeybindingCommand[] = NO_COMMANDS,
): { shortcuts: HtmlRenderShortcut[]; blocked: HtmlRenderShortcut[] } {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // Chat also resolves project scripts from the thread's own environment.
  const environmentKeybindings = useAtomValue(
    serverEnvironment.configValueAtom(threadRef?.environmentId ?? null),
  )?.keybindings;
  return useMemo(() => {
    const allowedCommands = new Set([...HTML_RENDER_SHORTCUT_COMMANDS, ...extraCommands]);
    const mac = isMacPlatform(navigator.platform);
    const resolve = (shortcut: KeybindingShortcut): HtmlRenderShortcut => ({
      key: shortcut.key,
      metaKey: shortcut.metaKey || (shortcut.modKey && mac),
      ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
      shiftKey: shortcut.shiftKey,
      altKey: shortcut.altKey,
    });
    const blocked = [...keybindings, ...(environmentKeybindings ?? [])]
      .filter((binding) => !allowedCommands.has(binding.command))
      .map((binding) => resolve(binding.shortcut));
    const shortcuts = new Map<string, HtmlRenderShortcut>();
    for (const { command, shortcut } of keybindings) {
      if (
        allowedCommands.has(command) &&
        (shortcut.metaKey || shortcut.ctrlKey || shortcut.modKey)
      ) {
        shortcuts.set(shortcutConflictKey(shortcut), resolve(shortcut));
      }
    }
    return { shortcuts: [...shortcuts.values()], blocked };
  }, [environmentKeybindings, extraCommands, keybindings]);
}

/**
 * Whether a key a page reported may be replayed. The page reports the key and code, and a page
 * script can report any pair, so a key that could match another command's binding is never
 * replayed. A named key (Backspace, Enter) must be the shortcut's own, since some app handlers
 * read `event.key` directly. A dead key matches by its code.
 */
export function isHtmlRenderShortcut(
  key: HtmlRenderKey,
  {
    shortcuts,
    blocked,
  }: { shortcuts: readonly HtmlRenderShortcut[]; blocked: readonly HtmlRenderShortcut[] },
): boolean {
  const matches = (shortcut: HtmlRenderShortcut) =>
    matchesKeybindingShortcut(key, { ...shortcut, modKey: false }, navigator.platform);
  const allowed = shortcuts.filter(matches);
  return (
    allowed.length > 0 &&
    !blocked.some(matches) &&
    (key.key.length === 1 ||
      key.key === "Dead" ||
      allowed.some((shortcut) => shortcut.key === normalizeEventKey(key.key)))
  );
}

/**
 * Replays a key a framed page passed on, on the frame element, so it bubbles to the app's window
 * listeners as if pressed there. A focused frame takes every key, so app shortcuts would stop
 * until the reader clicked out. Gated like a link: the message must come from this frame, the
 * frame must have focus, and the reader must have just used the app.
 */
export function replayFrameKey(
  frame: HTMLIFrameElement,
  source: MessageEventSource | null,
  key: HtmlRenderKey,
): void {
  if (
    source !== frame.contentWindow ||
    document.activeElement !== frame ||
    navigator.userActivation?.isActive === false
  ) {
    return;
  }
  frame.dispatchEvent(new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }));
}
