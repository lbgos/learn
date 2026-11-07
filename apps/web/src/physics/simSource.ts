import type { PhysicsSimEvent } from "@t3tools/contracts";

/**
 * What a sim panel knows about its source file, folded from the `physics.simSubscribe` events.
 * The stream outlives a deleted or unreadable file, so a gap never discards the last good source:
 * the running sim stays and a status line explains the gap.
 */
export interface SimSource {
  /** The last source received; null until the first `file` event. */
  readonly file: { readonly code: string; readonly hash: string } | null;
  readonly status:
    | { readonly kind: "ok" }
    | { readonly kind: "missing" }
    | { readonly kind: "error"; readonly message: string };
}

export const initialSimSource: SimSource = { file: null, status: { kind: "ok" } };

export function reduceSimSource(state: SimSource, event: PhysicsSimEvent): SimSource {
  switch (event.type) {
    case "file":
      return { file: { code: event.code, hash: event.hash }, status: { kind: "ok" } };
    case "missing":
      return { file: state.file, status: { kind: "missing" } };
    case "error":
      return { file: state.file, status: { kind: "error", message: event.message } };
  }
}

/** The status line for a source that is not currently readable; null when it is. */
export function simSourceNotice(source: SimSource, path: string): string | null {
  switch (source.status.kind) {
    case "ok":
      return null;
    case "missing":
      return `File not found: ${path}. Waiting for it to come back`;
    case "error":
      return source.status.message;
  }
}
