// Ported from learnharness (AGPL-3.0-only) src/agent/subagents/extraction.ts @ c549494.
import * as Schema from "effect/Schema";
import type { DerivedGraph } from "./derive.ts";
import { birthSessionOf } from "./session-clusters.ts";
import { fuzzyScore } from "./search.ts";
import { healStringifiedArrays } from "./argument-heal.ts";
import {
  type AuditVerdicts,
  NodeId,
  type ExtractedProposition,
  GraphNode,
  type SessionFindings,
} from "./model.ts";
const nonempty = Schema.String.check(Schema.isNonEmpty());
const propositionFields = {
  id: nonempty.annotate({
    description: 'Local id: "p1", "p2", … — referenced by chains in this call.',
  }),
  name: nonempty.annotate({
    description:
      "A very short label — established terminology, the term the discipline itself uses, a glossary " +
      "headword a textbook would print ('Will to power', 'Divine command theory'). Not a sentence, " +
      "needn't be unique or self-contained: this becomes the node's global label in the graph.",
  }),
  statement: nonempty.annotate({
    description:
      "One true, self-contained, world-facing core idea at full precision. Never about the " +
      'learner, the teacher, or the reading: not "the learner understands X" but "X". A misconception ' +
      "enters as its TRUE correction.",
  }),
  aliases: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "Verbatim phrasings the source used for the same proposition, if any.",
    }),
  ),
};
const endpoint = nonempty.annotate({
  description:
    'EITHER an existing graph idea id from THE GRAPH SO FAR, verbatim ("n_…"), OR the local id of a proposition in this submission ("p1", …).',
});
const chainSubmit = Schema.Struct({
  premises: Schema.Array(endpoint).check(Schema.isMinLength(1)).annotate({
    description:
      "Premise ids used TOGETHER: they jointly entail the conclusion; independent reasons are separate chains. At least one premise is required.",
  }),
  conclusion: endpoint,
});
const propositionsDescription =
  "Only the NEW core ideas this stretch contributes — ideas the prompt's THE GRAPH SO FAR already " +
  "holds are referenced by id in chains, never restated here.";
const chainsDescription =
  "Every argument this stretch makes — including arguments that join new ideas to established " +
  "ones; conclusions reusable by id as premises of later chains; bare ideas (no argument) ride " +
  "the propositions list alone; pass [] when none — never omit the field.";
export const ExtractorSubmit = Schema.Struct({
  propositions: Schema.Array(Schema.Struct(propositionFields)).annotate({
    description: propositionsDescription,
  }),
  chains: Schema.Array(chainSubmit).annotate({ description: chainsDescription }),
});
export const SessionExtractorSubmit = Schema.Struct({
  propositions: Schema.Array(
    Schema.Struct({
      ...propositionFields,
      messageId: nonempty.annotate({
        description:
          "The message id of the ONE passage in this stretch that most directly states or explains this " +
          'proposition — copy it EXACTLY from that passage\'s "TEACHER [id]" label.',
      }),
    }),
  ).annotate({ description: propositionsDescription }),
  chains: Schema.Array(chainSubmit).annotate({ description: chainsDescription }),
});
export const AuditorSubmit = Schema.Struct({
  links: Schema.Array(
    Schema.Struct({
      id: nonempty.annotate({ description: 'The proposition id from the findings ("p1", …).' }),
      linkTo: NodeId.annotate({
        description:
          "The id of the EXISTING graph node this proposition IS — your identity verdict. EQUIVALENCE BIAS: paraphrases, rewordings, and compressions of the same claim MERGE; only genuinely distinct propositions stay apart.",
      }),
    }),
  ).annotate({
    description:
      "Identity verdicts only. A proposition absent from here creates a new node. Pass [] when none — never omit the field.",
  }),
});
export type SubmitResult<T> = { ok: true; value: T } | { ok: false; problems: string[] };
export type ExtractorValidationOptions = {
  existingIds?: ReadonlySet<string>;
} & ({ kind: "session"; messageIds: ReadonlySet<string> } | { kind?: "notes" });
export function validateExtractorSubmit(
  raw: unknown,
  options: ExtractorValidationOptions = {},
): SubmitResult<SessionFindings> {
  let value: SessionFindings;
  try {
    const healed = healStringifiedArrays(raw);
    const parsed =
      options.kind === "session"
        ? Schema.decodeUnknownSync(SessionExtractorSubmit)(healed)
        : Schema.decodeUnknownSync(ExtractorSubmit)(healed);
    value = {
      chains: parsed.chains.map((c) => ({ premises: [...c.premises], conclusion: c.conclusion })),
      propositions: parsed.propositions.map((p) => ({
        id: p.id,
        name: p.name,
        statement: p.statement,
        aliases: [...(p.aliases ?? [])],
        ...("messageId" in p && typeof p.messageId === "string" ? { messageId: p.messageId } : {}),
      })),
    };
  } catch (error) {
    return { ok: false, problems: [String(error)] };
  }
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const proposition of value.propositions) {
    if (ids.has(proposition.id))
      problems.push(`propositions: duplicate local id "${proposition.id}".`);
    if (/^(n_|arg_)/.test(proposition.id))
      problems.push(
        `propositions: "${proposition.id}" uses a reserved graph namespace. Reference existing n_ ids in chains instead.`,
      );
    ids.add(proposition.id);
    if (
      options.kind === "session" &&
      (!proposition.messageId?.trim() || !options.messageIds.has(proposition.messageId))
    ) {
      problems.push(
        `propositions: "${proposition.id}" must copy messageId from a TEACHER [id] passage of THIS stretch.`,
      );
    }
  }
  const resolves = (id: string) =>
    ids.has(id) || (id.startsWith("n_") && options.existingIds?.has(id));
  for (const [index, chain] of value.chains.entries()) {
    if (!chain.premises.length)
      problems.push(`chains.${index}: premises must name at least one proposition.`);
    for (const id of new Set([...chain.premises, chain.conclusion])) {
      if (!resolves(id))
        problems.push(
          `chains.${index}: "${id}" is neither a submitted proposition nor an existing n_ idea from THE GRAPH SO FAR.`,
        );
    }
    if (chain.premises.includes(chain.conclusion))
      problems.push(`chains.${index}: a conclusion cannot be its own premise.`);
  }
  return problems.length ? { ok: false, problems } : { ok: true, value };
}
export const AuditCandidateGroup = Schema.Struct({
  findingId: nonempty,
  nodes: Schema.Array(GraphNode),
});
export type AuditCandidateGroup = typeof AuditCandidateGroup.Type;
export const AuditCandidates = Schema.Array(AuditCandidateGroup);
export type AuditCandidates = typeof AuditCandidates.Type;
type FindingWithSource = ExtractedProposition & {
  sourceId?: string;
  provenance?: ReadonlyArray<{ chatId: string }>;
};
/** sourceId is the current extraction source, not a property inferred from prose. */
export function auditCandidates(
  graph: DerivedGraph,
  findings: ReadonlyArray<FindingWithSource>,
  options: { perFinding: number; sourceId?: string } = { perFinding: 8 },
): AuditCandidates {
  const nodes = [...new Map(graph.nodes.map((n) => [n.id, n])).values()];
  const limit = Math.max(0, Math.floor(options.perFinding));
  return findings.map((finding) => {
    const queries = [finding.name, ...finding.aliases, finding.statement];
    const ranked = nodes
      .map((node, index) => ({
        node,
        index,
        score: Math.max(
          0,
          ...queries.map(
            (query) => fuzzyScore(query, node.name, ...node.aliases, node.statement) ?? 0,
          ),
        ),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, limit)
      .map((row) => row.node);
    const sources = new Set(
      [
        options.sourceId,
        finding.sourceId,
        ...(finding.provenance?.map((pt) => pt.chatId) ?? []),
      ].filter((id): id is string => id !== undefined),
    );
    const seen = new Set(ranked.map((n) => n.id));
    for (const node of nodes) {
      const birth = birthSessionOf(node);
      if (birth !== null && sources.has(birth) && !seen.has(node.id)) {
        ranked.push(node);
        seen.add(node.id);
      }
    }
    return { findingId: finding.id, nodes: ranked };
  });
}
export function validateAuditorSubmit(
  raw: unknown,
  findings: ReadonlyArray<ExtractedProposition>,
  candidates: AuditCandidates,
): SubmitResult<AuditVerdicts> {
  let value: AuditVerdicts;
  try {
    value = Schema.decodeUnknownSync(AuditorSubmit)(healStringifiedArrays(raw));
  } catch (error) {
    return { ok: false, problems: [String(error)] };
  }
  const problems: string[] = [];
  const findingIds = new Set(findings.map((p) => p.id));
  const seen = new Set<string>();
  for (const link of value.links) {
    if (!findingIds.has(link.id)) problems.push(`links: unknown finding id "${link.id}".`);
    if (seen.has(link.id)) problems.push(`links: duplicate verdict for "${link.id}".`);
    seen.add(link.id);
    if (
      !candidates
        .find((group) => group.findingId === link.id)
        ?.nodes.some((n) => n.id === link.linkTo)
    )
      problems.push(`links: "${link.linkTo}" is not a candidate for "${link.id}".`);
  }
  return problems.length ? { ok: false, problems } : { ok: true, value };
}
