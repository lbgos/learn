// Ported from learnharness (AGPL-3.0-only) src/core/graph.ts @ c549494.
import { ThreadId } from "@t3tools/contracts";
import * as Graph from "@t3tools/learn/graph";
import * as Review from "@t3tools/learn/review";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Store from "./LearnGraphStore.ts";
import * as Pipeline from "./LearnGraphPipeline.ts";
import * as Threads from "./LearnGraphThreads.ts";
import * as Retrievals from "./LearnRetrievals.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  LearnGraphError,
  LearnGraphEvent,
  LearnGraphEvidence,
  type LearnReviewSummary,
} from "@t3tools/contracts";

const decodePositions = Schema.decodeEffect(Graph.Positions);

export class LearnGraphService extends Context.Service<
  LearnGraphService,
  {
    readonly snapshot: Effect.Effect<typeof LearnGraphEvent.Type, LearnGraphError>;
    readonly subscribe: Stream.Stream<typeof LearnGraphEvent.Type, LearnGraphError>;
    readonly evidence: (
      sourceIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<typeof LearnGraphEvidence.Type>, LearnGraphError>;
    readonly deleteSessionTraces: (
      threadId: ThreadId,
    ) => Effect.Effect<Graph.ChatDeletionStats, LearnGraphError>;
    readonly deleteSource: Pipeline.LearnGraphPipeline["Service"]["deleteSource"];
    readonly deletionPreview: Pipeline.LearnGraphPipeline["Service"]["deletionPreview"];
    readonly importNotes: Pipeline.LearnGraphPipeline["Service"]["importNotes"];
    readonly coverageSummary: Pipeline.LearnGraphPipeline["Service"]["coverageSummary"];
    readonly putPositions: (
      positions: Graph.GraphLedgers["positions"],
    ) => Effect.Effect<void, LearnGraphError>;
    readonly graphSessions: Effect.Effect<string, LearnGraphError>;
    readonly graphPropositions: (input: {
      session?: string | undefined;
      query?: string | undefined;
    }) => Effect.Effect<string, LearnGraphError>;
    readonly reviewSummary: Effect.Effect<typeof LearnReviewSummary.Type, LearnGraphError>;
    /** The most overdue propositions, for a teach session's warm-up. */
    readonly dueForReview: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<Graph.GraphNode>, LearnGraphError>;
  }
>()("t3/learn/graph/LearnGraphService") {}
const make = Effect.gen(function* () {
  const store = yield* Store.LearnGraphStore;
  const pipeline = yield* Pipeline.LearnGraphPipeline;
  const threads = yield* Threads.LearnGraphThreads;
  const settings = yield* ServerSettingsService;
  const retrievals = yield* Retrievals.LearnRetrievals;
  const loadSources = (sourceIds: ReadonlyArray<string>) =>
    Effect.forEach(
      [...new Set(sourceIds)].filter((id) => !id.startsWith("notes:")),
      (id) =>
        threads.load(ThreadId.make(id)).pipe(
          Effect.catchTags({
            LearnGraphError: (error) =>
              error.reason === "unavailable" ? Effect.undefined : Effect.fail(error),
          }),
        ),
      { concurrency: 4 },
    ).pipe(Effect.map((sources) => sources.filter((source) => source !== undefined)));
  const readView = Effect.gen(function* () {
    // Revision and ledgers must refer to the same store transaction. Retry on a concurrent write.
    while (true) {
      const revision = yield* store.revision;
      const ledgers = yield* store.read;
      const sources = yield* loadSources(
        [...ledgers.nodes, ...ledgers.chains].flatMap((item) =>
          item.provenance.map((point) => point.chatId),
        ),
      );
      if ((yield* store.revision) === revision)
        return { revision, ledgers, sessions: sources.map((source) => source.session) };
    }
  });
  const snapshot = readView.pipe(
    Effect.map(({ revision, ledgers, sessions }) => ({
      revision,
      snapshot: Graph.graphSnapshot(ledgers, sessions),
    })),
  );
  const enabled = settings.getSettings.pipe(
    Effect.map((s) => s.learn.graph.tutorGraphTools),
    Effect.mapError(
      (cause) => new LearnGraphError({ operation: "settings", reason: "unavailable", cause }),
    ),
  );
  const disabled = "The graph tools are turned off in Settings.";
  const reviewState = Effect.gen(function* () {
    const ledgers = yield* store.read;
    const graph = Graph.getGraph(ledgers);
    const record = yield* retrievals.record;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const reviews = Review.reviewPropositions(graph.nodes, record.retrievals);
    const due = Review.dueReviews(reviews.values(), nowMs);
    return { ledgers, graph, record, reviews, nowMs, due };
  });
  return LearnGraphService.of({
    snapshot,
    subscribe: store.changes.pipe(Stream.mapEffect(() => snapshot)),
    evidence: Effect.fn("LearnGraphService.evidence")((sourceIds) =>
      loadSources(sourceIds).pipe(
        Effect.map((sources) =>
          sources.map((source) => ({
            threadId: ThreadId.make(source.session.id),
            title: source.session.title,
            sims: source.sims,
            boards: source.boards,
          })),
        ),
      ),
    ),
    deleteSessionTraces: Effect.fn("LearnGraphService.deleteSessionTraces")((threadId) =>
      pipeline.deleteSource(threadId),
    ),
    deleteSource: pipeline.deleteSource,
    deletionPreview: pipeline.deletionPreview,
    importNotes: pipeline.importNotes,
    coverageSummary: pipeline.coverageSummary,
    putPositions: Effect.fn("LearnGraphService.putPositions")((positions) =>
      decodePositions(positions).pipe(
        Effect.mapError(
          (cause) => new LearnGraphError({ operation: "positions", reason: "validation", cause }),
        ),
        Effect.flatMap((positions) =>
          store.transact(() => ({ append: {}, rewrite: { positions }, result: undefined })),
        ),
      ),
    ),
    graphSessions: Effect.gen(function* () {
      if (!(yield* enabled)) return disabled;
      const { ledgers, sessions } = yield* readView;
      const rows = Graph.graphSessionIndex(ledgers, sessions);
      return rows.length
        ? rows.map((row) => `${row.id} | ${row.name} | ${row.propositions} propositions`).join("\n")
        : "The knowledge graph is empty.";
    }),
    graphPropositions: Effect.fn("LearnGraphService.graphPropositions")(function* (input) {
      if (!(yield* enabled)) return disabled;
      const { ledgers, graph, reviews, nowMs } = yield* reviewState;
      const sessionIds = input.session
        ? new Set(Graph.graphSessionPropositions(ledgers, input.session).map((node) => node.nodeId))
        : undefined;
      const nodes = graph.nodes.filter(
        (node) =>
          (!sessionIds || sessionIds.has(node.id)) &&
          (!input.query ||
            Graph.fuzzyScore(input.query, node.name, node.statement, ...node.aliases) !== null),
      );
      const ids = new Set(nodes.map((node) => node.id));
      const chains = graph.chains.filter(
        (chain) => ids.has(chain.conclusion) || chain.premises.some((id) => ids.has(id)),
      );
      return nodes.length
        ? [
            ...nodes.map(
              (node) =>
                `${node.id} | ${node.name}\n${node.statement}\nreview: ${Review.reviewStatus(reviews.get(node.id), nowMs)}`,
            ),
            ...chains.map(
              (chain) => `${chain.id} | ${chain.premises.join(" + ")} => ${chain.conclusion}`,
            ),
          ].join("\n\n")
        : "No matching propositions.";
    }),
    reviewSummary: reviewState.pipe(
      Effect.map(({ due, record }) => ({
        due: due.map((review) => review.nodeId),
        calibration: Review.calibration(record.answers),
      })),
    ),
    dueForReview: Effect.fn("LearnGraphService.dueForReview")(function* (limit) {
      const { graph, due } = yield* reviewState;
      const byId = new Map(graph.nodes.map((node) => [node.id, node]));
      return due.slice(0, limit).flatMap((review) => byId.get(review.nodeId) ?? []);
    }),
  });
});
export const layer = Layer.effect(LearnGraphService, make);
