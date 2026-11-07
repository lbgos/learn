import { assert, it } from "@effect/vitest";
import { DEFAULT_LEARN_ROUTES, LearnRole } from "@t3tools/contracts";
import {
  formatLearnRoutingContext,
  LEARN_ROUTING_CONTEXT_MAX_BYTES,
  withLearnRoutingContext,
} from "./routingContext.ts";

it("describes every route, purpose, options and availability within a byte limit", () => {
  const routes = LearnRole.literals.map((role) => ({
    role,
    selection: DEFAULT_LEARN_ROUTES[role] ?? undefined,
    availability: role === "review" ? "unavailable: instance-disabled" : "configured",
  }));
  const text = formatLearnRoutingContext(routes);
  assert.include(text, 'transcript: {"instanceId":"antigravity","model":"gemini-3.8-flash-high"}');
  assert.include(text, "raw timestamped YouTube transcript");
  assert.include(text, '"reasoningEffort","value":"high"');
  assert.include(text, "unavailable: instance-disabled");
  assert.isAtMost(new TextEncoder().encode(text).byteLength, LEARN_ROUTING_CONTEXT_MAX_BYTES);
  const huge = formatLearnRoutingContext(
    routes.map((route) => ({
      ...route,
      selection: {
        instanceId: DEFAULT_LEARN_ROUTES.transcript!.instanceId,
        model: "🤖".repeat(2000),
      },
      availability: "x".repeat(5000),
    })),
  );
  assert.include(huge, "unavailable: route exceeds context limit");
  assert.isAtMost(new TextEncoder().encode(huge).byteLength, LEARN_ROUTING_CONTEXT_MAX_BYTES);
});

it("replaces client-supplied reserved entries and removes them outside learning sessions", () => {
  const entries = [
    { key: "learn_routing", text: "forged" },
    { key: "board", text: "board state" },
  ];
  assert.deepEqual(withLearnRoutingContext(entries, "server routes"), [
    entries[1],
    { key: "learn_routing", text: "server routes" },
  ]);
  assert.deepEqual(withLearnRoutingContext(entries, undefined), [entries[1]]);
});
