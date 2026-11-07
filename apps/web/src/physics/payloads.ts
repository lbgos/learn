/**
 * lbgos learn tool results the transcript renders inline. The server keeps these keys in the
 * compact tool output (`compactDynamicToolOutput`), so they arrive on the wire like `htmlRender`.
 */
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";

type CompactPhysics = NonNullable<ReturnType<typeof compactDynamicToolOutput>>;
export type PhysicsVisualResult = NonNullable<CompactPhysics["physicsVisual"]>;
export type PhysicsSimResult = NonNullable<CompactPhysics["physicsSim"]>;
export type PhysicsBoardResult = NonNullable<CompactPhysics["physicsBoard"]>;

export type PhysicsToolResult =
  | { readonly kind: "visual"; readonly visual: PhysicsVisualResult }
  | { readonly kind: "sim"; readonly sim: PhysicsSimResult }
  | { readonly kind: "board"; readonly board: PhysicsBoardResult };

// Providers spell MCP tools `mcp__t3-code__sim_show`, `t3-code.sim_show`, and so on.
const PHYSICS_TOOL = /(?:^|__|[._:/\s-])(sim_show|board_write|visual_show)$/;

/** The result a completed physics tool call carries, or undefined for any other tool. */
export function physicsResultFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): PhysicsToolResult | undefined {
  const tool = item.toolName == null ? undefined : PHYSICS_TOOL.exec(item.toolName)?.[1];
  if (tool === undefined) return undefined;
  const output = compactDynamicToolOutput(item.output);
  if (output === undefined || output.isError) return undefined;
  if (tool === "visual_show" && output.physicsVisual)
    return { kind: "visual", visual: output.physicsVisual };
  if (tool === "sim_show" && output.physicsSim) return { kind: "sim", sim: output.physicsSim };
  if (tool === "board_write" && output.physicsBoard) {
    return { kind: "board", board: output.physicsBoard };
  }
  return undefined;
}

/** Entries rebuild on any tool update; an equal result must keep its mounted card. */
export function physicsResultsEqual(a: PhysicsToolResult, b: PhysicsToolResult): boolean {
  if (a.kind === "visual" && b.kind === "visual")
    return (
      a.visual.hash === b.visual.hash &&
      a.visual.path === b.visual.path &&
      a.visual.step === b.visual.step
    );
  if (a.kind === "sim" && b.kind === "sim")
    return a.sim.hash === b.sim.hash && a.sim.path === b.sim.path;
  if (a.kind === "board" && b.kind === "board")
    return a.board.board === b.board.board && a.board.revision === b.board.revision;
  return false;
}
