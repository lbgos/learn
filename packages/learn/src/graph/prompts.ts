// Ported from learnharness (AGPL-3.0-only) src/agent/subagents/extraction.ts @ c549494.
import type { DerivedGraph } from "./derive.ts";
import type { TeacherProseMessage, ExtractedProposition } from "./model.ts";
import { messageViewLines } from "./coverage.ts";
import type { AuditCandidates } from "./extraction.ts";
export const SESSION_MESSAGE_ID_RULE =
  "For each new proposition, copy the message ID of the passage that most directly states or explains it into messageId.";

export const SESSION_PREAMBLE =
  "You are the extraction stage of a learning application. You read one stretch of a source — a teaching " +
  "session, rendered as the teacher's prose in reading order — and report what it teaches as findings " +
  "for the learner's global knowledge graph, building on everything already extracted from this source.";

export const NOTES_PREAMBLE =
  "You are the extraction stage of a learning application. You read one stretch of a source — the " +
  "author's personal notes, rendered in reading order — and report what it teaches as findings for the " +
  "learner's global knowledge graph, building on everything already extracted from this source.";

export const EXTRACTION_CORE = `THE GOAL: uncover the source's CORE IDEAS and show how everything derives from the foundations. The
source teaches by arguing — ideas worked out from other ideas, down to a foundation the rest stands on.
Your deliverable is twofold: the core ideas themselves, and the chains of reasoning that derive them.
Each chain is premises that JOINTLY entail a conclusion. Entailment is the only link that earns a
chain — where the real connection is historical or narrative (who argued what, how a debate or
exposition unfolds), there is no chain; keep the pieces as bare ideas or drop them. The direction of
the graph is upward: foundational ideas at the bottom, derived ideas above them, each chain showing
how its conclusion follows from what is more established — do not submit connections that carry no
derivation.

The graph holds TRUE ideas about the world, nothing else — never anything about the learner, the
teacher, or this reading: not "the learner understands X" but X. A misconception enters as its TRUE
correction. Each statement is one self-contained idea at full precision.

Extract the load-bearing ideas of the subject — what a reference on it would teach — not the full run
of the discourse. An idea earns its place only when the source's arguments run through it — examples,
notation glosses, and restatements that no argument needs are not core ideas. Every idea must stand
alone for a reader who never saw this source: names and statements may not lean on the source's own
scaffolding (claim numbering, axiom tags, arc labels); a claim that only matters as part of how this
document is organized is not knowledge — drop it.

When the prompt carries THE GRAPH SO FAR, you are continuing a source already partly extracted: build
on it. Reference an existing idea by its id ("n_…") instead of restating it, and prefer chains that
lean on established conclusions as premises — derive new material from what is already derived. Do
not re-derive a conclusion the graph already holds unless the route is genuinely different.

SUBMIT with one submit_findings call: every NEW core idea with a short name and a precise statement,
and every chain as premises + conclusion. A chain's premises and conclusion may be ids from this
submission OR existing ids from THE GRAPH SO FAR, verbatim. Premises within one chain are used
TOGETHER — independent arguments for the same conclusion are separate chains. A conclusion may
reappear, by id, as a premise of later chains. A bare idea that no argument uses rides the
propositions list alone. Include every field even when empty — "chains": [] when the source makes no
arguments. The tool's field descriptions carry the details.`;

const EXTRACTOR_INSTRUCTIONS = `${SESSION_PREAMBLE}\n\n${EXTRACTION_CORE}\n\n${SESSION_MESSAGE_ID_RULE}`;
const NOTES_EXTRACTOR_INSTRUCTIONS = `${NOTES_PREAMBLE}\n\n${EXTRACTION_CORE}`;

export function sourceDigest(graph: DerivedGraph, sourceId: string): string {
  const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
  const ours = graph.nodes.filter((n) => n.provenance.some((pt) => pt.chatId === sourceId));
  const ourChains = graph.chains.filter((c) => c.provenance.some((pt) => pt.chatId === sourceId));
  if (ours.length === 0 && ourChains.length === 0) return "";
  const lines: string[] = [];
  lines.push(
    "THE GRAPH SO FAR — everything already extracted from this source (reference these ids verbatim):",
  );
  for (const n of ours) lines.push(`  ${n.id} | ${n.name} | ${n.statement.replace(/\s+/g, " ")}`);
  if (ourChains.length > 0) {
    lines.push("DERIVATIONS ALREADY RECORDED (build on these; do not re-derive them):");
    for (const c of ourChains) {
      const names = c.premises.map((p) => nameOf.get(p) ?? p).join(" ∧ ");
      lines.push(
        `  [${c.premises.join(" + ")} ⇒ ${c.conclusion}]  ${names} ⇒ ${nameOf.get(c.conclusion) ?? c.conclusion}`,
      );
    }
  }
  return lines.join("\n");
}

const ORIGINAL_AUDITOR_INSTRUCTIONS = `You are the linking stage of a learning application's extraction pipeline. An extractor
has read a source (a teaching session, or the author's personal notes) and reported findings: propositions and
their reasoning chains. You NEVER see the source itself — the extractor is fully trusted, and you do not re-check
its work. Your job is IDENTITY: connecting those findings to the CURRENT knowledge graph, preparing the merge.

You explore the graph through your tools: list_sessions, list_propositions, and find (glob over names +
statements + aliases; each hit also says which session it was born in). The graph is SMALL and FINITE — a handful of
sessions — and your job is done as soon as you have SEEN the plausible candidates. FOLLOW THIS PROCEDURE:

1. GROUND yourself first: call list_sessions ONCE. This one call shows the entire space — every session that ever
   contributed propositions, and how many. Now you know the extent of what you are searching; nothing is hidden.
2. READ the plausibly-related sessions: for each session whose topic could overlap these findings, call
   list_propositions — every proposition born there, with full statement text. A few calls and you have read
   every realistic identity candidate in the graph.
3. find is your targeted sweep: use it for phrasings, synonyms, and neighboring ideas the session reads made you
   wonder about — its hits point back at sessions you can read whole.
4. SUBMIT. Once every plausibly-related session has been read (and stray finds come back empty), you are DONE.
   Do not re-search ground you have already seen; more patterns over the same nodes are wasted work.

IDENTITY — links, per proposition:
- For each proposition: does an EXISTING node — one you have now SEEN — already state this same proposition?
- If yes: add { "id": <its proposition id>, "linkTo": <that node's id> } to "links". The session's phrasings join
  its aliases and its provenance; the node keeps its existing name.
- If no: add nothing — a new node is created with the extractor's name as its label.
- EQUIVALENCE BIAS (owner ruling): paraphrases, rewordings, and compressions of the same claim MERGE. When two
  statements are the same claim at different precision or from different angles, LINK them. Only genuinely distinct
  propositions — different claims about the world — stay apart. You are NOT guarding against wrong merges; you are
  hunting for right ones.

Your deliverable is ONLY the identity verdicts: "links". NEVER restate the propositions —
the merger already has them. You NEVER create relations between propositions — they come from the
extractor alone, and the batch connects to the existing graph ONLY through the equivalences you identify. Your
entire deliverable is ONE submit_review call.

Include the "links" field even when empty — "links": [] when nothing links. NEVER omit it because it is empty.`;

const procedureStart = ORIGINAL_AUDITOR_INSTRUCTIONS.indexOf("You explore the graph");
const identityStart = ORIGINAL_AUDITOR_INSTRUCTIONS.indexOf("IDENTITY — links, per proposition:");
/** The identity doctrine is verbatim; candidate retrieval replaces the tool procedure. */
const AUDITOR_INSTRUCTIONS =
  ORIGINAL_AUDITOR_INSTRUCTIONS.slice(0, procedureStart) +
  "Decide from the candidates supplied for each finding. They are the plausible existing graph nodes, " +
  "including every node born in the same source. You have no exploration tools. Read these candidates " +
  "and submit identity links only to ids listed for that finding.\n\n" +
  ORIGINAL_AUDITOR_INSTRUCTIONS.slice(identityStart);
export type ExtractorPromptInput = {
  sourceId: string;
  graph: DerivedGraph;
  title?: string;
  part?: { i: number; n: number };
} & (
  | { kind: "session"; messages: ReadonlyArray<TeacherProseMessage> }
  | { kind: "notes"; text: string; filePath: string }
);
function proseView(messages: ReadonlyArray<TeacherProseMessage>, title?: string): string {
  return (title ? `# ${title}\n\n` : "") + messages.flatMap(messageViewLines).join("\n\n");
}
/** Provider adapters can pass systemPrompt and prompt directly to structured generation. */
export function buildExtractorPrompt(input: ExtractorPromptInput): {
  systemPrompt: string;
  prompt: string;
} {
  const digest = sourceDigest(input.graph, input.sourceId);
  const stretch = input.part ? `Stretch ${input.part.i}/${input.part.n}\n\n` : "";
  const source =
    input.kind === "session"
      ? proseView(input.messages, input.title)
      : `# ${input.filePath}\n\n${input.text}`;
  return {
    systemPrompt: input.kind === "session" ? EXTRACTOR_INSTRUCTIONS : NOTES_EXTRACTOR_INSTRUCTIONS,
    prompt: [digest, stretch + source].filter(Boolean).join("\n\n"),
  };
}
export function buildAuditorPrompt(
  findings: ReadonlyArray<ExtractedProposition>,
  candidates: AuditCandidates,
): { systemPrompt: string; prompt: string } {
  const lines: string[] = ["FINDINGS AND IDENTITY CANDIDATES"];
  for (const finding of findings) {
    lines.push(`\nFINDING ${finding.id} | ${finding.name} | ${finding.statement}`);
    if (finding.aliases.length) lines.push(`Aliases: ${JSON.stringify(finding.aliases)}`);
    const group = candidates.find((c) => c.findingId === finding.id);
    for (const node of group?.nodes ?? []) {
      lines.push(`  ${node.id} | ${node.name} | ${node.statement}`);
      if (node.aliases.length) lines.push(`    Aliases: ${JSON.stringify(node.aliases)}`);
    }
    if (!group?.nodes.length) lines.push("  (no existing candidates)");
  }
  return { systemPrompt: AUDITOR_INSTRUCTIONS, prompt: lines.join("\n") };
}
