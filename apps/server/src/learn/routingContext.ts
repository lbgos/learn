import type { LearnRole, ModelSelection } from "@t3tools/contracts";

export const LEARN_ROUTING_CONTEXT_KEY = "learn_routing";
export const LEARN_ROUTING_CONTEXT_MAX_BYTES = 8 * 1024;

export interface LearnRouteSnapshot {
  readonly role: LearnRole;
  readonly selection: ModelSelection | undefined;
  readonly availability: string;
}

const purposes = {
  tutor: "teach tutor, managed by session routing",
  planning: "probe/plan tutor, managed by session routing",
  practice: "practice tutor, managed by session routing",
  research: "research child work",
  transcript: "raw timestamped YouTube transcript",
  developer: "simulation and implementation child work",
  visual: "visual child work, needs vision",
  review: "review and test child work",
  extraction: "graph extraction, managed by graph services",
  audit: "graph audit, managed by graph services",
} satisfies Record<LearnRole, string>;

/** Bound each row without presenting a truncated target as usable. */
export function formatLearnRoutingContext(routes: readonly LearnRouteSnapshot[]): string {
  const header =
    "Learning routes at turn start. The server resolves learnRole again at dispatch. Configured does not guarantee model access or quota.";
  const rows = routes.slice(0, 10).map(({ role, selection, availability }) => {
    const route = selection === undefined ? "unset" : JSON.stringify(selection);
    const detail =
      route.length > 450
        ? "unavailable: route exceeds context limit"
        : `${route}; ${availability.slice(0, 100)}`;
    return `${role}: ${detail}; ${purposes[role]}`;
  });
  const text = [header, ...rows].join("\n");
  return new TextEncoder().encode(text).byteLength <= LEARN_ROUTING_CONTEXT_MAX_BYTES
    ? text
    : "Learning routing unavailable: context exceeds size limit. Do not substitute another route.";
}

/** Client notes cannot occupy the server-owned route key, even outside Learn. */
export function withLearnRoutingContext(
  entries: readonly { readonly key: string; readonly text: string }[],
  text: string | undefined,
) {
  return [
    ...entries.filter((entry) => entry.key !== LEARN_ROUTING_CONTEXT_KEY),
    ...(text === undefined ? [] : [{ key: LEARN_ROUTING_CONTEXT_KEY, text }]),
  ];
}
