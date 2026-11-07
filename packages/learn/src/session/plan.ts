// Ported from learnharness (AGPL-3.0-only) src/agent/tools/mermaid-plan.ts, src/core/plan-tree.ts @ c549494.
import * as Schema from "effect/Schema";
import { PlanTree, type PlanNode, type PlanEdge } from "./contracts.ts";

class PlanTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanTreeError";
  }
}
const decodeTree = Schema.decodeUnknownSync(PlanTree);
export function emptyTree(): PlanTree {
  return { nodes: [], edges: [], version: 0 };
}
export function createTree(
  nodes: readonly PlanNode[],
  edges: readonly PlanEdge[],
  version = 1,
): PlanTree {
  const tree = decodeTree({ nodes, edges, version });
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new PlanTreeError(`Duplicate node id "${node.id}".`);
    ids.add(node.id);
  }
  const adjacency = new Map<string, string[]>();
  const seenEdges = new Set<string>();
  for (const { from, to } of edges) {
    if (!ids.has(from) || !ids.has(to))
      throw new PlanTreeError(`Edge ${from} --> ${to} references an unknown node.`);
    if (from === to) throw new PlanTreeError(`Self-loop ${from} --> ${to}.`);
    const key = `${from}\0${to}`;
    if (seenEdges.has(key)) throw new PlanTreeError(`Duplicate edge ${from} --> ${to}.`);
    seenEdges.add(key);
    const stack = [to];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (id === from)
        throw new PlanTreeError(`Edge ${from} --> ${to} creates a cycle; the plan must be a DAG.`);
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(adjacency.get(id) ?? []));
    }
    adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
  }
  return tree;
}

export type PlanParseResult =
  | { readonly ok: true; readonly problems: []; readonly plan: PlanTree }
  | { readonly ok: false; readonly problems: string[] };
const endpointPattern = /^([^\s()[\]]+)\s*(?:\[([^[\]]*)\]|\(\s*"([^"]*)"\s*\)|\(([^()]*)\))?$/;
export function parseMermaidPlan(mermaid: string): PlanParseResult {
  const lines = mermaid.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() && !line.trim().startsWith("%%"));
  if (first < 0)
    return {
      ok: false,
      problems: ["line 1: empty plan; expected graph TD and at least one node."],
    };
  const problems: string[] = [];
  if (!/^(graph|flowchart)\s+(td|tb|lr|rl|bt)\s*$/i.test(lines[first]!.trim())) {
    problems.push(`line ${first + 1}: expected graph TD or flowchart with a direction.`);
  }
  const nodes = new Map<string, string>();
  const edges: PlanEdge[] = [];
  const seen = new Set<string>();
  const edgeLines = new Map<string, number>();
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("%%")) continue;
    const endpoints: string[] = [];
    let valid = true;
    for (const part of line.split(/-->|==>|-\.->/)) {
      const match = part.trim().match(endpointPattern);
      if (!match?.[1]) {
        problems.push(
          `line ${i + 1}: cannot parse ${part.trim()}; use slug[Title] and a --> b edges.`,
        );
        valid = false;
        continue;
      }
      const id = match[1];
      if (!/^[a-z0-9]+([_-][a-z0-9]+)*$/.test(id)) {
        problems.push(
          `line ${i + 1}: node id ${id} must be a lowercase slug (a-z, 0-9, hyphens or underscores).`,
        );
        valid = false;
        continue;
      }
      let label = (match[2] ?? match[3] ?? match[4] ?? "").trim();
      if (
        (label.startsWith('"') && label.endsWith('"')) ||
        (label.startsWith("'") && label.endsWith("'"))
      )
        label = label.slice(1, -1).trim();
      if (!nodes.has(id) || (nodes.get(id) === id && label)) nodes.set(id, label || id);
      endpoints.push(id);
    }
    if (!valid) continue;
    for (let k = 0; k + 1 < endpoints.length; k++) {
      const from = endpoints[k]!;
      const to = endpoints[k + 1]!;
      const key = `${from}\0${to}`;
      if (!seen.has(key)) {
        edges.push({ from, to });
        seen.add(key);
        edgeLines.set(key, i + 1);
      }
    }
  }
  if (nodes.size === 0 && problems.length === 0)
    problems.push(`line ${first + 1}: the plan needs at least one node.`);
  if (problems.length) return { ok: false, problems };
  const planNodes = [...nodes].map(([id, title]) => ({ id, title }));
  const accepted: PlanEdge[] = [];
  for (const edge of edges) {
    try {
      createTree(planNodes, [...accepted, edge]);
      accepted.push(edge);
    } catch (error) {
      problems.push(
        `line ${edgeLines.get(`${edge.from}\0${edge.to}`)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return problems.length
    ? { ok: false, problems }
    : { ok: true, problems: [], plan: createTree(planNodes, accepted) };
}
