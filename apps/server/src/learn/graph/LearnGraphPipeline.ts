// Ported from learnharness (AGPL-3.0-only) src/agent/subagents/extraction.ts @ c549494.
import { ThreadId } from "@t3tools/contracts";
import * as Graph from "@t3tools/learn/graph";
import * as Node from "@t3tools/learn/graph/node";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Generation from "../LearnStructuredGeneration.ts";
import * as Activity from "./LearnActivity.ts";
import * as Store from "./LearnGraphStore.ts";
import * as Threads from "./LearnGraphThreads.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  LearnGraphError,
  LearnGraphExtractionResult,
  LearnGraphCoverage,
} from "@t3tools/contracts";

type ExtractionResult = typeof LearnGraphExtractionResult.Type;
function validateNotes(input: { relativePath: string; content: string }) {
  const parts = input.relativePath.split("/");
  return (
    input.relativePath.length > 0 &&
    !input.relativePath.includes("\\") &&
    !input.relativePath.includes("\0") &&
    !/^(?:\/|[A-Za-z]:)/.test(input.relativePath) &&
    parts.every((part) => part !== ".." && part !== "." && part !== "") &&
    /\.(?:md|txt)$/i.test(input.relativePath) &&
    Buffer.byteLength(input.content, "utf8") <= 1024 * 1024
  );
}
export class LearnGraphPipeline extends Context.Service<
  LearnGraphPipeline,
  {
    readonly runSession: (
      threadId: ThreadId,
      automatic?: boolean,
    ) => Effect.Effect<ExtractionResult, LearnGraphError>;
    readonly importNotes: (input: {
      relativePath: string;
      content: string;
    }) => Effect.Effect<ExtractionResult, LearnGraphError>;
    readonly deleteSource: (
      sourceId: string,
    ) => Effect.Effect<Graph.ChatDeletionStats, LearnGraphError>;
    readonly deletionPreview: (
      sourceId: string,
    ) => Effect.Effect<Graph.ChatDeletionStats, LearnGraphError>;
    readonly coverageSummary: (
      threadId: ThreadId,
    ) => Effect.Effect<typeof LearnGraphCoverage.Type, LearnGraphError>;
  }
>()("t3/learn/graph/LearnGraphPipeline") {}

const make = Effect.gen(function* () {
  const store = yield* Store.LearnGraphStore;
  const generation = yield* Generation.LearnStructuredGeneration;
  const activity = yield* Activity.LearnActivity;
  const threads = yield* Threads.LearnGraphThreads;
  const settings = yield* ServerSettingsService;
  const locks = yield* KeyedLock.make<string>();
  const auditLock = yield* Semaphore.make(1);
  const graphSettings = settings.getSettings.pipe(
    Effect.map((s) => s.learn.graph),
    Effect.mapError(
      (cause) => new LearnGraphError({ operation: "settings", reason: "unavailable", cause }),
    ),
  );
  const unchanged = (sourceId: string): ExtractionResult => ({
    sourceId,
    batches: 0,
    nodes: 0,
    chains: 0,
    unchanged: true,
  });
  const checked = <A>(result: Graph.SubmitResult<A>) =>
    result.ok
      ? Effect.succeed(result.value)
      : Effect.fail(new LearnGraphError({ operation: "validate", reason: "validation" }));
  const problems = <A>(result: Graph.SubmitResult<A>) => (result.ok ? [] : result.problems);
  const batch = Effect.fn("LearnGraphPipeline.batch")(function* (
    sourceId: string,
    input:
      | { kind: "session"; messages: ReadonlyArray<Graph.TeacherProseMessage>; title: string }
      | { kind: "notes"; text: string; filePath: string },
    coverage: ReadonlyArray<Graph.CoverageEntry>,
  ) {
    const before = yield* store.read;
    const graph = Graph.getGraph(before);
    const existingIds = new Set(graph.nodes.map((node) => node.id));
    const validation: Graph.ExtractorValidationOptions =
      input.kind === "session"
        ? { kind: "session", messageIds: new Set(input.messages.map((m) => m.id)), existingIds }
        : { kind: "notes", existingIds };
    const prompt = Graph.buildExtractorPrompt({ ...input, sourceId, graph });
    // Use the normalized boundary shape for both sources; validators enforce session message ids.
    const raw = yield* generation
      .run({
        role: "extraction",
        label: `graph:${sourceId}:extract`,
        prompt: `${prompt.systemPrompt}\n\n${prompt.prompt}`,
        schema: input.kind === "session" ? Graph.SessionExtractorSubmit : Graph.ExtractorSubmit,
        validate: (value) => problems(Graph.validateExtractorSubmit(value, validation)),
      })
      .pipe(
        Effect.mapError(
          (cause) => new LearnGraphError({ operation: "extract", reason: "generation", cause }),
        ),
      );
    const findings = yield* checked(Graph.validateExtractorSubmit(raw, validation));
    return yield* auditLock.withPermit(
      Effect.gen(function* () {
        // Audit against the latest graph; deletion cannot invalidate verdicts before the merge.
        const currentGraph = Graph.getGraph(yield* store.read);
        yield* checked(
          Graph.validateExtractorSubmit(raw, {
            ...validation,
            existingIds: new Set(currentGraph.nodes.map((node) => node.id)),
          }),
        );
        const candidates = Graph.auditCandidates(currentGraph, findings.propositions, {
          perFinding: 8,
          sourceId,
        });
        const auditPrompt = Graph.buildAuditorPrompt(findings.propositions, candidates);
        const rawVerdicts = yield* generation
          .run({
            role: "audit",
            label: `graph:${sourceId}:audit`,
            prompt: `${auditPrompt.systemPrompt}\n\n${auditPrompt.prompt}`,
            schema: Graph.AuditorSubmit,
            validate: (value) =>
              problems(Graph.validateAuditorSubmit(value, findings.propositions, candidates)),
          })
          .pipe(
            Effect.mapError(
              (cause) => new LearnGraphError({ operation: "audit", reason: "generation", cause }),
            ),
          );
        const verdicts = yield* checked(
          Graph.validateAuditorSubmit(rawVerdicts, findings.propositions, candidates),
        );
        const now = DateTime.formatIso(yield* DateTime.now);
        return yield* store.transact((current) => {
          const plan = Graph.mergeFindings(
            sourceId,
            findings,
            verdicts,
            current,
            { foldedAt: now, coverage },
            {
              now,
              newNodeId: Node.newGraphNodeId,
              newChainId: Node.newGraphChainId,
            },
          );
          return { ...plan, result: plan.stats };
        });
      }),
    );
  });
  const deletionPlan = (current: Graph.GraphLedgers, sourceId: string) => {
    const plan = Graph.planSessionDeletion(current, sourceId, "delete-nodes");
    return {
      ...plan,
      rewrite: {
        ...plan.rewrite,
        sources: current.sources.filter((source) => source.id !== sourceId),
      },
    };
  };
  return LearnGraphPipeline.of({
    runSession: Effect.fn("LearnGraphPipeline.runSession")((threadId, automatic = false) =>
      activity.run(
        { kind: "extraction", label: "Extract session", sourceId: threadId },
        locks.withLock(
          threadId,
          Effect.gen(function* () {
            const config = yield* graphSettings;
            if (automatic && !config.extraction) return unchanged(threadId);
            const source = yield* threads.load(threadId);
            if (!source) return unchanged(threadId);
            const ledgers = yield* store.read;
            const coverage = Node.coverageOf(source.messages, ledgers.coverage, threadId);
            if (automatic && coverage.uncoveredTokens < config.extractionChunkTokens)
              return unchanged(threadId);
            const batches = Graph.batchRuns(
              coverage.slots,
              coverage.uncovered,
              config.extractionChunkTokens,
            );
            const result = { ...unchanged(threadId), unchanged: batches.length === 0 };
            for (const slots of batches) {
              const now = DateTime.formatIso(yield* DateTime.now);
              const stats = yield* batch(
                threadId,
                {
                  kind: "session",
                  title: source.session.title,
                  messages: slots.map((slot) => slot.message),
                },
                slots.map((slot) => ({
                  chatId: threadId,
                  fp: slot.fp,
                  tokens: slot.tokens,
                  foldedAt: now,
                })),
              );
              result.batches++;
              result.nodes += stats.nodes;
              result.chains += stats.chains;
            }
            return result;
          }),
        ),
      ),
    ),
    importNotes: Effect.fn("LearnGraphPipeline.importNotes")((input) =>
      Effect.suspend(() => {
        if (!validateNotes(input))
          return Effect.fail(
            new LearnGraphError({ operation: "import-notes", reason: "validation" }),
          );
        const sourceId = Node.notesSourceId(input.relativePath);
        return activity.run(
          { kind: "notes-import", label: `Import ${input.relativePath}`, sourceId },
          locks.withLock(
            sourceId,
            Effect.gen(function* () {
              const config = yield* graphSettings;
              const fingerprint = Node.notesContentFingerprint(input.content);
              const ledgers = yield* store.read;
              if (
                ledgers.sources.find((source) => source.id === sourceId)?.contentFp === fingerprint
              )
                return unchanged(sourceId);
              yield* store.writeNotes(input.relativePath, input.content);
              const importedAt = DateTime.formatIso(yield* DateTime.now);
              // A stopped import keeps its committed chunks discoverable, but is never marked complete.
              yield* store.transact((current) => ({
                append: {},
                rewrite: {
                  sources: [
                    ...current.sources.filter((source) => source.id !== sourceId),
                    { id: sourceId, filePath: input.relativePath, importedAt },
                  ],
                },
                result: undefined,
              }));
              const chunks = Graph.chunkNotes(input.content, config.extractionChunkTokens);
              const messages = chunks.map((text, i) => ({ id: `chunk-${i}`, text }));
              const coverage = Node.coverageOf(messages, ledgers.coverage, sourceId);
              const result = { ...unchanged(sourceId), unchanged: false };
              for (const index of coverage.uncovered) {
                const slot = coverage.slots[index]!;
                const stats = yield* batch(
                  sourceId,
                  { kind: "notes", text: slot.message.text, filePath: input.relativePath },
                  [
                    {
                      chatId: sourceId,
                      fp: slot.fp,
                      tokens: slot.tokens,
                      foldedAt: DateTime.formatIso(yield* DateTime.now),
                    },
                  ],
                );
                result.batches++;
                result.nodes += stats.nodes;
                result.chains += stats.chains;
              }
              yield* store.transact((current) => ({
                append: {},
                rewrite: {
                  sources: [
                    ...current.sources.filter((source) => source.id !== sourceId),
                    {
                      id: sourceId,
                      filePath: input.relativePath,
                      importedAt,
                      contentFp: fingerprint,
                    },
                  ],
                },
                result: undefined,
              }));
              return result;
            }),
          ),
        );
      }),
    ),
    deletionPreview: Effect.fn("LearnGraphPipeline.deletionPreview")((sourceId) =>
      store.read.pipe(Effect.map((ledgers) => deletionPlan(ledgers, sourceId).stats)),
    ),
    deleteSource: Effect.fn("LearnGraphPipeline.deleteSource")((sourceId) =>
      locks.withLock(
        sourceId,
        auditLock.withPermit(
          store.transact((current) => {
            const plan = deletionPlan(current, sourceId);
            return { ...plan, result: plan.stats };
          }),
        ),
      ),
    ),
    coverageSummary: Effect.fn("LearnGraphPipeline.coverageSummary")(function* (threadId) {
      const source = yield* threads.load(threadId);
      const ledgers = yield* store.read;
      const { coveredTokens, uncoveredTokens, coveredCount, uncoveredCount } = Node.coverageOf(
        source?.messages ?? [],
        ledgers.coverage,
        threadId,
      );
      return { coveredTokens, uncoveredTokens, coveredCount, uncoveredCount };
    }),
  });
});
export const layer = Layer.effect(LearnGraphPipeline, make);
