import * as Schema from "effect/Schema";

export const BOARD_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const BOARD_SVG_MAX_BYTES = 512 * 1024;

function safeSvg(source: string): boolean {
  // Refuse declarations, active content and CSS escapes rather than interpreting XML entities or CSS.
  if (
    !/^\s*(?:<\?xml\s[^?]*\?>\s*)?<svg(?=[\s/>])(?:[^>]*\/>|[^>]*>[\s\S]*<\/svg>)\s*$/i.test(
      source,
    ) ||
    /<!|<\?(?!xml\s)|<(?:[\w.-]+:)?(?:script|foreignObject|style|animate\w*|set)\b|\bon[\w-]*\s*=|\bxml:base\s*=|javascript\s*:|@import|\\/i.test(
      source,
    )
  )
    return false;

  for (const match of source.matchAll(
    /\b(?:[\w.-]+:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
  )) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (!/^(?:#[\w.-]+|data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2})$/.test(value))
      return false;
  }
  // Character references in attributes can hide a resource URL from the checks below.
  for (const match of source.matchAll(/[\w:.-]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (/&/.test(match[1] ?? match[2] ?? "")) return false;
  }
  // SVG paint servers may refer to a local definition, never a remote stylesheet or resource.
  for (const match of source.matchAll(/url\s*\(([^)]*)\)/gi)) {
    if (!/^\s*(?:"#[\w.-]+"|'#[\w.-]+'|#[\w.-]+)\s*$/.test(match[1] ?? "")) return false;
  }
  return true;
}

function validImageSource(source: string): boolean {
  const header = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.exec(source);
  if (header === null) return false;
  const base64 = source.slice(header[0].length);
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return false;
  const bytes =
    (base64.length / 4) * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  const svg = header[1] === "svg+xml";
  if (bytes <= 0 || bytes > (svg ? BOARD_SVG_MAX_BYTES : BOARD_IMAGE_MAX_BYTES)) return false;
  if (!svg) return true;
  try {
    const decoded = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    return safeSvg(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } catch {
    return false;
  }
}

/** Embedded images only. SVG is checked before it reaches an image renderer. */
export const BoardImageSource = Schema.String.check(
  Schema.isMaxLength(Math.ceil(BOARD_IMAGE_MAX_BYTES / 3) * 4 + 64),
  Schema.makeFilter(validImageSource, {
    message: "Expected embedded raster data up to 2 MiB or safe SVG data up to 512 KiB.",
  }),
);
