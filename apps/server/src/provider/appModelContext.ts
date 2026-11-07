import type { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";

/** Codex has native untrusted application context; every other driver receives it with the turn text. */
export function prependAppModelContext(input: {
  readonly driver: ProviderDriverKind;
  readonly text: string;
  readonly appContext: ProviderAdapterV2TurnInput["appContext"];
}): string {
  if (input.driver === "codex") return input.text;
  const entries = input.appContext?.filter((entry) => entry.text.trim().length > 0) ?? [];
  if (entries.length === 0) return input.text;
  const context = entries.map((entry) => `[${entry.key}]\n${entry.text}`).join("\n\n");
  return `<mcp_app_context>\n${context}\n</mcp_app_context>\n\n${input.text}`;
}
