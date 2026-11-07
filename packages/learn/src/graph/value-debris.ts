// Ported from learnharness (AGPL-3.0-only) src/core/value-debris.ts @ c549494.
export function stripModelValueDebris(value: string): string {
  return value.replace(/^[\s:."'`]+/, "").replace(/[\s:."'`]+$/, "");
}
