import type { KeybindingCommand } from "@t3tools/contracts";
import type { HtmlRenderShortcut } from "@t3tools/shared/htmlRender";

import { type HtmlRenderKey, isHtmlRenderShortcut } from "~/hooks/useHtmlRenderShortcuts";
import type { SimKeyDown } from "./simHost";

/** View-only commands a sim may pass on besides the ones an HTML render may. */
export const SIM_SHORTCUT_COMMANDS: readonly KeybindingCommand[] = ["whiteboard.toggle"];

/** The key as the shared HTML-render replay path takes it. */
export const simKeyToReplay = ({ key, code, ctrlKey, metaKey, altKey, shiftKey }: SimKeyDown) =>
  ({ key, code, ctrlKey, metaKey, altKey, shiftKey, repeat: false }) satisfies HtmlRenderKey;

/**
 * Whether a key the sim reported may reach the app. Sim code is untrusted and can report any key,
 * so this is the HTML-render allowlist (plus `SIM_SHORTCUT_COMMANDS`); a bare Escape is the one
 * key outside it, so a focused sim does not trap the app's own dismissals.
 */
export function isSimShortcut(
  key: HtmlRenderKey,
  lists: {
    shortcuts: readonly HtmlRenderShortcut[];
    blocked: readonly HtmlRenderShortcut[];
  },
): boolean {
  if (key.key === "Escape" && !key.ctrlKey && !key.metaKey && !key.altKey && !key.shiftKey) {
    return true;
  }
  return isHtmlRenderShortcut(key, lists);
}
