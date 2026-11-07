import {
  buildNewThreadLink,
  PROMPT_LINK_MAX_PROMPT_LENGTH,
  type PromptLinkRepository,
} from "@t3tools/shared/promptLinks";

import { configuredHostedAppUrl } from "~/hostedPairing";

/** A shareable link to a prompt on the hosted app, or null when the prompt cannot fit in one. */
export function promptLinkFor(
  prompt: string,
  context?: {
    readonly repository: PromptLinkRepository | null;
    readonly provider: string | null;
    readonly model: string | null;
  },
): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || trimmed.length > PROMPT_LINK_MAX_PROMPT_LENGTH) return null;
  return buildNewThreadLink({ prompt: trimmed, ...context, origin: configuredHostedAppUrl() });
}
