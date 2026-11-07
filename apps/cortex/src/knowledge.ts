import { adviseSchema, graphSchema } from "./schema.ts";
import { hash } from "./source.ts";
import type { CortexIndex } from "./index.ts";
import type { Vault } from "./vault.ts";

const words = (text: string) => new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
function overlap(concept: string, statement: string) {
  const tokens = words(concept);
  const candidate = words(statement);
  return tokens.size ? [...tokens].filter((token) => candidate.has(token)).length / tokens.size : 0;
}
function currentObservations(vault: Vault) {
  const observations = vault.events.filter((event) => event.type === "observation");
  const superseded = new Set(observations.flatMap((event) => event.observation.supersedes ?? []));
  return observations.filter((event) => !superseded.has(event.id));
}

export async function advise(vault: Vault, index: CortexIndex, input: unknown) {
  const { text, concepts: supplied } = adviseSchema.parse(input);
  // These are candidate labels only. A caller can supply concepts after reading the transcript.
  const concepts =
    supplied ??
    [
      ...new Set(
        text
          .split(/\n|[.!?]\s/u)
          .map((line) => line.replace(/^(?:#+\s*|\[[\d:]+\]\s*)/u, "").trim())
          .filter((line) => line && !/^(?:channel|source):/u.test(line))
          .map((line) => line.slice(0, 80)),
      ),
    ].slice(0, 8);
  if (!concepts.length) throw new Error("Supply concepts or meaningful transcript text");
  const observations = currentObservations(vault);
  const evidence = [];
  for (const concept of concepts) {
    const matching = observations
      .map((event) => ({
        event,
        overlap: Math.max(
          overlap(concept, event.observation.statement),
          ...(event.observation.concepts ?? []).map((tag) => overlap(concept, tag)),
        ),
      }))
      .filter((item) => item.overlap >= 0.6)
      .sort((a, b) => b.overlap - a.overlap || b.event.seq - a.event.seq);
    const understanding = matching.find(
      ({ event }) =>
        event.observation.type === "understanding" &&
        event.observation.stance === "affirm" &&
        (event.observation.confidence ?? 0) >= 0.7,
    );
    const exposure = matching.find(({ event }) => event.observation.type === "exposure");
    const dispute = matching.find(
      ({ event }) =>
        event.observation.type === "belief" &&
        ["reject", "uncertain"].includes(event.observation.stance),
    );
    const understood = understanding !== undefined;
    const exposed = exposure !== undefined;
    const disputed = dispute !== undefined;
    // Include the records that determined the score, even if newer endorsements rank first.
    const selected = [...new Set([understanding, exposure, dispute, ...matching])]
      .filter((item) => item !== undefined)
      .slice(0, 3);
    const passages = await index.search({ query: concept, k: 1 });
    evidence.push({
      concept,
      understood,
      exposed,
      disputed,
      observations: selected.map(({ event, overlap: score }) => ({
        id: event.id,
        type: event.observation.type,
        statement: event.observation.statement.slice(0, 300),
        stance: event.observation.stance,
        confidence: event.observation.confidence,
        sourceRef: event.observation.sourceRef,
        overlap: score,
      })),
      passages: passages.map((passage) => ({ ...passage, snippet: passage.snippet.slice(0, 300) })),
    });
  }
  const understood = evidence.filter((item) => item.understood).length;
  const exposed = evidence.filter((item) => item.exposed).length;
  const disputed = evidence.filter((item) => item.disputed).length;
  const newConcepts = evidence.filter((item) => !item.understood).map((item) => item.concept);
  const score = understood / concepts.length;
  const recommendation = score >= 0.8 && disputed === 0 ? "skip" : "watch";
  const reasons = [
    `${understood}/${concepts.length} concepts match current affirmative understanding with confidence >= 0.7`,
    `${exposed}/${concepts.length} have explicit exposure; source imports alone do not count`,
    `${disputed} concepts match rejected or uncertain beliefs; ${newConcepts.length} lack demonstrated understanding`,
  ];
  return {
    recommendation,
    line: `${recommendation}: ${reasons.join("; ")}. New concepts: ${newConcepts.join(", ") || "none"}.`,
    reasons,
    newConcepts,
    score,
    evidence,
    rule: "Skip at >= 80% understood and no disputed beliefs. Token overlap >= 60%; retrieval ranks are not mastery or semantic entailment. The calling agent judges relevance and conflicts.",
    conceptsFrom: supplied ? "caller" : "first nonempty lines or sentences; review these labels",
  };
}

export function graph(vault: Vault, input: unknown) {
  const { after, limit } = graphSchema.parse(input);
  const events = vault.events.filter((event) => event.seq > after).slice(0, limit);
  const nodes = new Map<string, { id: string; kind: string; label: string; data?: unknown }>();
  const edges: Array<{ from: string; to: string; kind: string }> = [];
  const superseded = new Map(
    vault.events.flatMap((event) =>
      event.type === "observation" && event.observation.supersedes
        ? [[event.observation.supersedes, event.id] as const]
        : [],
    ),
  );
  const sourceNode = (id: string) => {
    const source = vault.source(id);
    nodes.set(id, {
      id,
      kind: "source",
      label: source.metadata.title,
      data: { ...source.metadata, revision: source.revision },
    });
    return source;
  };
  const link = (id: string, concepts: readonly string[]) => {
    for (const label of concepts) {
      const conceptId = `concept:${hash(label.toLocaleLowerCase().trim()).slice(0, 24)}`;
      nodes.set(conceptId, { id: conceptId, kind: "concept", label });
      edges.push({ from: id, to: conceptId, kind: "about" });
    }
  };
  for (const event of events) {
    if (event.type === "source.added") {
      link(event.sourceId, sourceNode(event.sourceId).metadata.concepts ?? []);
    } else {
      const observation = event.observation;
      nodes.set(event.id, {
        id: event.id,
        kind: observation.type,
        label: observation.statement.slice(0, 300),
        data: {
          ...observation,
          statement: undefined,
          supersededBy: superseded.get(event.id) ?? null,
        },
      });
      link(event.id, observation.concepts ?? []);
      if (observation.sourceRef) {
        const id = observation.sourceRef.sourceId;
        link(id, sourceNode(id).metadata.concepts ?? []);
        edges.push({ from: id, to: event.id, kind: "evidence" });
      }
    }
  }
  const next = events.at(-1)?.seq ?? after;
  return {
    nodes: [...nodes.values()],
    edges: edges.filter(
      (edge, i) =>
        edges.findIndex(
          (other) => other.from === edge.from && other.to === edge.to && other.kind === edge.kind,
        ) === i,
    ),
    nextAfter: vault.events.some((event) => event.seq > next) ? next : null,
    conceptPolicy:
      "Explicit source and observation tags only. Imports never imply belief or understanding. Merge pages by node id.",
  };
}
