// Ported from learnharness (AGPL-3.0-only) src/store/graph.ts @ c549494.
import * as Graph from "@t3tools/learn/graph";
import { newGraphNodeId } from "@t3tools/learn/graph/node";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { LearnGraphError } from "@t3tools/contracts";
import * as Workspace from "../../physics/PhysicsWorkspaceService.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeExit(Schema.fromJsonString(Schema.Unknown));
const decodeLedgers = Schema.decodeUnknownEffect(Graph.GraphLedgers);
const validateLedgers = Schema.decodeEffect(Graph.GraphLedgers);
const decodeSource = Schema.decodeUnknownExit(Graph.NotesSource);
const isGraphError = Schema.is(LearnGraphError);

export class LearnGraphStore extends Context.Service<
  LearnGraphStore,
  {
    readonly read: Effect.Effect<Graph.GraphLedgers, LearnGraphError>;
    readonly revision: Effect.Effect<number>;
    readonly changes: Stream.Stream<number>;
    readonly transact: <A>(
      plan: (current: Graph.GraphLedgers) => Graph.LedgerPlan & { result: A },
    ) => Effect.Effect<A, LearnGraphError>;
    readonly writeNotes: (
      relativePath: string,
      content: string,
    ) => Effect.Effect<void, LearnGraphError>;
  }
>()("t3/learn/graph/LearnGraphStore") {}

export const layerAt = (workspaceRoot: string) =>
  Layer.effect(
    LearnGraphStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const semaphore = yield* Semaphore.make(1);
      const revision = yield* SubscriptionRef.make(0);
      const root = path.join(workspaceRoot, "learn", "graph");
      const file = (name: string) => path.join(root, name);
      const io = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isGraphError(cause) ? cause : new LearnGraphError({ operation, reason: "io", cause }),
          ),
        );
      const readOptional = (name: string) =>
        fs.readFileString(file(name)).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
          }),
        );
      const parse = (text: string): unknown => {
        const result = decodeJson(text);
        return result._tag === "Success" ? result.value : undefined;
      };
      const atomic = Effect.fn("LearnGraphStore.atomic")(function* (
        target: string,
        content: string,
      ) {
        const temporary = `${target}.${newGraphNodeId()}.tmp`;
        yield* fs.writeFileString(temporary, content).pipe(
          Effect.andThen(fs.rename(temporary, target)),
          Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)),
        );
      });
      const persist = Effect.fn("LearnGraphStore.persist")(function* (next: Graph.GraphLedgers) {
        yield* atomic(file("nodes.jsonl"), Graph.encodeLedger(Graph.GraphNode, next.nodes));
        yield* atomic(file("chains.jsonl"), Graph.encodeLedger(Graph.GraphChain, next.chains));
        yield* atomic(
          file("coverage.jsonl"),
          Graph.encodeLedger(Graph.CoverageEntry, next.coverage),
        );
        yield* atomic(
          file("sessions.jsonl"),
          Graph.encodeLedger(Graph.SessionCheckpoint, next.checkpoints),
        );
        yield* atomic(
          file("sources.json"),
          json(Object.fromEntries(next.sources.map((source) => [source.id, source]))),
        );
        yield* atomic(
          file("positions.json"),
          json({ positions: next.positions, updatedAt: DateTime.formatIso(yield* DateTime.now) }),
        );
        yield* atomic(file("format.json"), json({ version: Graph.CURRENT_GRAPH_FORMAT_VERSION }));
      });
      const recover = Effect.gen(function* () {
        const stamp = yield* readOptional("format.json");
        yield* Effect.try(() => Graph.assertGraphFormat(parse(stamp)));
        const pending = yield* readOptional("transaction.json");
        if (pending) {
          const next = yield* decodeLedgers(parse(pending));
          yield* persist(next);
          yield* fs.remove(file("transaction.json"));
          yield* SubscriptionRef.update(revision, (n) => n + 1);
        }
      });
      const read = Effect.gen(function* () {
        yield* recover;
        const nodes = Graph.decodeLedger(Graph.GraphNode, yield* readOptional("nodes.jsonl"));
        const chains = Graph.decodeLedger(Graph.GraphChain, yield* readOptional("chains.jsonl"));
        const coverage = Graph.decodeLedger(
          Graph.CoverageEntry,
          yield* readOptional("coverage.jsonl"),
        );
        const checkpoints = Graph.decodeLedger(
          Graph.SessionCheckpoint,
          yield* readOptional("sessions.jsonl"),
        );
        const rawSources = parse(yield* readOptional("sources.json"));
        const sourceValues: ReadonlyArray<unknown> =
          typeof rawSources === "object" && rawSources !== null ? Object.values(rawSources) : [];
        const sources = sourceValues.flatMap((source) => {
          const result = decodeSource(source);
          return result._tag === "Success" ? [result.value] : [];
        });
        const rawPositions = parse(yield* readOptional("positions.json"));
        const positions = Graph.decodePositions(
          typeof rawPositions === "object" && rawPositions !== null && "positions" in rawPositions
            ? rawPositions.positions
            : rawPositions,
        );
        return { nodes, chains, coverage, checkpoints, sources, positions };
      });
      return LearnGraphStore.of({
        read: io("read", semaphore.withPermit(Effect.uninterruptible(read))),
        revision: SubscriptionRef.get(revision),
        changes: SubscriptionRef.changes(revision),
        transact: Effect.fn("LearnGraphStore.transact")((plan) =>
          io(
            "write",
            semaphore.withPermit(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const current = yield* read;
                  const mutation = yield* Effect.try(() => plan(current));
                  const next = yield* validateLedgers(Graph.applyLedgerPlan(current, mutation));
                  yield* fs.makeDirectory(root, { recursive: true });
                  // The journal commits the complete plan. Recovery finishes every ledger before reads.
                  yield* atomic(file("transaction.json"), json(next));
                  yield* persist(next);
                  yield* fs.remove(file("transaction.json"));
                  yield* SubscriptionRef.update(revision, (n) => n + 1);
                  return mutation.result;
                }),
              ),
            ),
          ),
        ),
        writeNotes: Effect.fn("LearnGraphStore.writeNotes")((relativePath, content) =>
          io(
            "write-notes",
            Effect.gen(function* () {
              const target = path.join(workspaceRoot, "notes", relativePath);
              const notesRoot = path.join(workspaceRoot, "notes");
              yield* fs.makeDirectory(notesRoot, { recursive: true });
              const base = yield* fs.realPath(notesRoot);
              const lab = yield* fs.realPath(workspaceRoot);
              if (!base.startsWith(lab + path.sep))
                return yield* new LearnGraphError({
                  operation: "notes-path",
                  reason: "validation",
                });
              // Existing symlink components must not redirect imports outside notes/.
              let current = notesRoot;
              for (const part of relativePath.split("/")) {
                current = path.join(current, part);
                if (yield* fs.exists(current)) {
                  const real = yield* fs.realPath(current);
                  if (!real.startsWith(base + path.sep))
                    return yield* new LearnGraphError({
                      operation: "notes-path",
                      reason: "validation",
                    });
                }
              }
              yield* fs.makeDirectory(path.dirname(target), { recursive: true });
              yield* atomic(target, content);
            }),
          ),
        ),
      });
    }),
  );
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const workspace = yield* Workspace.PhysicsWorkspaceService;
    const lab = yield* workspace.ensureLab;
    return layerAt(lab.workspaceRoot);
  }),
);
