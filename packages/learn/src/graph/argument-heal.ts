// Ported from learnharness (AGPL-3.0-only) src/agent/subagents/submit-agent.ts @ c549494.
function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
/** Heal encoded array fields, then leave malformed values for schema validation. */
export function healStringifiedArrays(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  let out: Record<string, unknown> | undefined;
  for (const key of ["propositions", "chains", "links"]) {
    const value = raw[key];
    if (typeof value !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        out ??= { ...raw };
        out[key] = parsed;
      }
    } catch {
      /* truncated/invalid JSON remains invalid */
    }
  }
  return out ?? raw;
}
// Ported from learnharness (AGPL-3.0-only) src/core/argument-heal.ts @ c549494.
type PropertySchema = { type?: string; const?: unknown; anyOf?: PropertySchema[] };
const literalsOf = (prop: PropertySchema): unknown[] =>
  prop.anyOf ? prop.anyOf.flatMap(literalsOf) : "const" in prop ? [prop.const] : [];
const acceptsNull = (prop: PropertySchema): boolean =>
  prop.type === "null" || (prop.anyOf ?? []).some(acceptsNull);
/** Shared primitive heal for model-generated arguments, before decoding. */
export function healEncodedArguments(
  raw: unknown,
  schema: { properties?: Record<string, PropertySchema> },
): unknown {
  if (!isRecord(raw) || !schema.properties) return raw;
  let out: Record<string, unknown> | undefined;
  for (const [key, prop] of Object.entries(schema.properties)) {
    const value = raw[key];
    if (typeof value !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(value);
      const literals = literalsOf(prop);
      if (literals.includes(value)) continue;
      if (
        literals.includes(parsed) ||
        (acceptsNull(prop) && parsed === null) ||
        (prop.type === "boolean" && typeof parsed === "boolean") ||
        ((prop.type === "number" || prop.type === "integer") && typeof parsed === "number") ||
        (prop.type === "array" && Array.isArray(parsed))
      ) {
        out ??= { ...raw };
        out[key] = parsed;
      }
    } catch {
      /* leave for validation */
    }
  }
  return out ?? raw;
}
