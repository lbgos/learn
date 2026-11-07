import type { GraphNode, GraphChain, GraphLedgers, SessionFindings } from "./model.ts";
import { emptyGraphLedgers } from "./model.ts";
export const point = (chatId: string, messageId = "") => ({ chatId, messageId });
export const node = (id: string, chatId = "s1", overrides: Partial<GraphNode> = {}): GraphNode => ({
  id,
  name: id,
  statement: `Statement ${id}`,
  aliases: [],
  createdAt: "2026-01-01",
  provenance: [point(chatId)],
  ...overrides,
});
export const chain = (
  id: string,
  premises: string[],
  conclusion: string,
  chatId = "s1",
): GraphChain => ({
  id,
  premises,
  conclusion,
  provenance: [point(chatId)],
  createdAt: "2026-01-01",
});
export const ledgers = (overrides: Partial<GraphLedgers> = {}): GraphLedgers => ({
  ...emptyGraphLedgers(),
  ...overrides,
});
export const findings = (): SessionFindings => ({
  propositions: [
    { id: "p1", name: "Force", statement: "Force changes momentum.", aliases: [], messageId: "m1" },
    {
      id: "p2",
      name: "Motion",
      statement: "Momentum is conserved without a net force.",
      aliases: [],
    },
  ],
  chains: [{ premises: ["p1"], conclusion: "p2" }],
});
export function context() {
  let n = 0;
  let c = 0;
  return { now: "2026-10-24", newNodeId: () => `n_new${++n}`, newChainId: () => `arg_new${++c}` };
}
