import type { ProviderDriverKind } from "@t3tools/contracts";
import { resolveModelShortName } from "@t3tools/client-runtime/provider-clients";
import { formatModelSlugName } from "@t3tools/shared/model";

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  aliases?: ReadonlyArray<string> | undefined;
  isDefault?: boolean | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getProviderRowLabel(
  providerDisplayName: string,
  subProvider: string | undefined,
): string {
  const provider = providerDisplayName.trim();
  const sub = subProvider?.trim();
  if (!sub) {
    return providerDisplayName;
  }
  if (provider && new RegExp(`^${escapeRegExp(provider)}\\s+\\S`, "i").test(sub)) {
    return sub;
  }
  return `${providerDisplayName} · ${sub}`;
}

export function getTriggerDisplayModelName(
  model: ModelEsque,
  driverKind: ProviderDriverKind | null | undefined,
): string {
  const shortName = resolveModelShortName(model, driverKind);
  return getDisplayModelName({ ...model, shortName }, { preferShortName: true });
}

// Brand spellings that capitalizing a slug word cannot produce.
const SLUG_WORD_SPELLINGS: Readonly<Record<string, string>> = {
  deepseek: "DeepSeek",
  glm: "GLM",
  minimax: "MiniMax",
};

/**
 * A readable name for a model slug the provider catalog does not list, such as a thread's
 * model while its provider is offline: "opencode-go/deepseek-v4.1-flash" → "DeepSeek V4.1 Flash".
 */
export function formatUnlistedModelName(slug: string): string {
  const name = slug.slice(slug.lastIndexOf("/") + 1);
  const known = formatModelSlugName(name);
  if (known !== name) return known;
  const words = name.split("-").filter((word) => word !== "");
  if (words.length === 0) return slug;
  return words
    .map(
      (word) =>
        SLUG_WORD_SPELLINGS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}
