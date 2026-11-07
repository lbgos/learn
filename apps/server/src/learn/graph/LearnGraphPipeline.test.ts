import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, TextGenerationError } from "@t3tools/contracts";
import * as Graph from "@t3tools/learn/graph";
import * as Node from "@t3tools/learn/graph/node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Activity from "./LearnActivity.ts";
import * as Pipeline from "./LearnGraphPipeline.ts";
import * as Store from "./LearnGraphStore.ts";
import * as Threads from "./LearnGraphThreads.ts";
import * as Generation from "../LearnStructuredGeneration.ts";
import * as ComposerDefault from "../LearnComposerDefault.ts";
import * as Router from "../LearnModelRouter.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as Settings from "../../serverSettings.ts";

const threadId = ThreadId.make("teach");
const source = (messages: ReadonlyArray<Graph.TeacherProseMessage>): Threads.TeachSource => ({
  session: { id: threadId, title: "Mechanics", createdAt: "now", updatedAt: "now" },
  messages,
  sims: [],
  boards: [],
});
const findings = (messageId?: string) => ({
  propositions: [
    {
      id: "p1",
      name: "Force",
      statement: "Force causes acceleration",
      aliases: [],
      ...(messageId ? { messageId } : {}),
    },
    {
      id: "p2",
      name: "Motion",
      statement: "Acceleration changes velocity",
      aliases: [],
      ...(messageId ? { messageId } : {}),
    },
  ],
  chains: [{ premises: ["p1"], conclusion: "p2" }],
});
const generated = (respond: (role: string, prompt: string) => unknown) =>
  Generation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Router.LearnModelRouter, {
          snapshot: () => Effect.die("unused snapshot"),
          resolve: (role) =>
            Effect.succeed({ instanceId: ProviderInstanceId.make(role), model: "fake" }),
        }),
        Layer.succeed(ComposerDefault.LearnComposerDefault, { get: Effect.undefined }),
        Layer.mock(TextGeneration.TextGeneration)({
          generateStructured: (input) =>
            // oxlint-disable-next-line t3code/no-inline-schema-compile -- The fake decodes the structured schema supplied by each caller.
            Schema.decodeUnknownEffect(input.outputSchema)(
              respond(input.modelSelection.instanceId, input.prompt),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({ operation: "test", detail: "Invalid fixture", cause }),
              ),
            ),
        }),
      ),
    ),
  );
const layer = (
  root: string,
  load: Threads.LearnGraphThreads["Service"]["load"],
  respond: (role: string, prompt: string) => unknown,
) =>
  Pipeline.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Store.layerAt(root),
        Activity.layer,
        generated(respond),
        Layer.succeed(Threads.LearnGraphThreads, { load, events: Stream.never }),
        Settings.layerTest({ learn: { graph: { extractionChunkTokens: 500 } } }),
      ),
    ),
  );

it.layer(NodeServices.layer)("LearnGraphPipeline", (it) => {
  it.effect("extracts, retries validation, audits and merges only uncovered prose", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      let messages = [{ id: "m1", text: "Force and motion." }];
      const prompts: string[] = [];
      let attempts = 0;
      yield* Effect.gen(function* () {
        const pipeline = yield* Pipeline.LearnGraphPipeline;
        const store = yield* Store.LearnGraphStore;
        const result = yield* pipeline.runSession(threadId);
        assert.equal(result.nodes, 2);
        assert.equal(result.chains, 1);
        assert.equal(result.batches, 1);
        const ledgers = yield* store.read;
        assert.equal(ledgers.nodes[0]?.provenance[0]?.messageId, "m1");
        assert.equal(ledgers.chains[0]?.provenance[0]?.chatId, threadId);
        assert.equal(ledgers.coverage.length, 1);
        assert.include(prompts[1]!, "Your previous submission was rejected");
        assert.equal((yield* pipeline.runSession(threadId)).unchanged, true);
        assert.equal(attempts, 2);
        messages = [...messages, { id: "m2", text: "Further explanation." }];
        assert.equal((yield* pipeline.runSession(threadId)).batches, 1);
        assert.include(prompts.at(-1)!, "TEACHER [m2]");
        assert.notInclude(prompts.at(-1)!, "TEACHER [m1]");
        assert.deepEqual(yield* pipeline.coverageSummary(threadId), {
          coveredCount: 2,
          uncoveredCount: 0,
          coveredTokens: Node.coverageOf(messages, (yield* store.read).coverage, threadId)
            .coveredTokens,
          uncoveredTokens: 0,
        });
      }).pipe(
        Effect.provide(
          layer(
            root,
            () => Effect.succeed(source(messages)),
            (role, prompt) => {
              if (role === "audit") return { links: [] };
              prompts.push(prompt);
              attempts++;
              return findings(attempts === 1 ? "wrong-message" : messages.at(-1)!.id);
            },
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "automatic work respects threshold and extraction setting; manual work bypasses them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        let calls = 0;
        yield* Effect.gen(function* () {
          const pipeline = yield* Pipeline.LearnGraphPipeline;
          const settings = yield* Settings.ServerSettingsService;
          assert.isTrue((yield* pipeline.runSession(threadId, true)).unchanged);
          assert.equal(calls, 0);
          yield* settings.updateSettings({ learn: { graph: { extraction: false } } });
          assert.isTrue((yield* pipeline.runSession(threadId, true)).unchanged);
          assert.equal((yield* pipeline.runSession(threadId)).nodes, 2);
        }).pipe(
          Effect.provide(
            layer(
              root,
              () => Effect.succeed(source([{ id: "m1", text: "Short prose" }])),
              (role) => {
                calls++;
                return role === "audit" ? { links: [] } : findings("m1");
              },
            ),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "notes validate paths and size before I/O, guard unchanged content and delete provenance",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* Effect.gen(function* () {
          const pipeline = yield* Pipeline.LearnGraphPipeline;
          const store = yield* Store.LearnGraphStore;
          for (const relativePath of [
            "../a.md",
            "/a.md",
            "C:/a.md",
            "a/../../b.txt",
            "a\\b.md",
            "a.js",
            "a//b.md",
            "./a.md",
          ]) {
            assert.equal(
              (yield* pipeline.importNotes({ relativePath, content: "text" }).pipe(Effect.result))
                ._tag,
              "Failure",
            );
          }
          assert.equal(
            (yield* pipeline
              .importNotes({ relativePath: "a.md", content: "é".repeat(524289) })
              .pipe(Effect.result))._tag,
            "Failure",
          );
          assert.isFalse(yield* fs.exists(`${root}/notes`));
          const input = {
            relativePath: "physics/motion.md",
            content: "Force causes acceleration.",
          };
          const result = yield* pipeline.importNotes(input);
          assert.equal(result.nodes, 2);
          assert.equal(result.sourceId, Node.notesSourceId(input.relativePath));
          assert.equal(yield* fs.readFileString(`${root}/notes/physics/motion.md`), input.content);
          assert.isTrue((yield* pipeline.importNotes(input)).unchanged);
          assert.equal((yield* store.read).sources.length, 1);
          const preview = yield* pipeline.deletionPreview(result.sourceId);
          assert.equal(preview.nodesRemoved, 2);
          assert.equal(preview.chainsRemoved, 1);
          assert.equal(preview.coverageRemoved, 1);
          assert.deepEqual(yield* pipeline.deleteSource(result.sourceId), preview);
          const after = yield* store.read;
          assert.equal(after.nodes.length, 0);
          assert.equal(after.sources.length, 0);
          assert.equal(after.chains.length, 0);
        }).pipe(
          Effect.provide(
            layer(
              root,
              () => Effect.undefined,
              (role) => (role === "audit" ? { links: [] } : findings()),
            ),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("imports timestamped transcript Markdown through notes without rewriting it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const input = {
        relativePath: "transcripts/mTd3tBpfYmw.md",
        content:
          "# Mechanics\nchannel: Example | url: https://www.youtube.com/watch?v=mTd3tBpfYmw | duration: 00:20\nsource: youtube captions (auto, en)\n\n[00:00] Force causes acceleration.\n\nChanges: corrected acceleration.\n",
      };
      yield* Effect.gen(function* () {
        const pipeline = yield* Pipeline.LearnGraphPipeline;
        const result = yield* pipeline.importNotes(input);
        assert.equal(result.nodes, 2);
        assert.equal(result.sourceId, Node.notesSourceId(input.relativePath));
        assert.equal(
          yield* fs.readFileString(`${root}/notes/${input.relativePath}`),
          input.content,
        );
      }).pipe(
        Effect.provide(
          layer(
            root,
            () => Effect.undefined,
            (role, prompt) => {
              if (role === "extraction")
                assert.include(prompt, "[00:00] Force causes acceleration.");
              return role === "audit" ? { links: [] } : findings();
            },
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rejects notes paths redirected through a symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const outside = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${root}/notes`, { recursive: true });
      yield* fs.symlink(outside, `${root}/notes/escape`);
      yield* Effect.gen(function* () {
        const pipeline = yield* Pipeline.LearnGraphPipeline;
        assert.equal(
          (yield* pipeline
            .importNotes({ relativePath: "escape/a.md", content: "text" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.isFalse(yield* fs.exists(`${outside}/a.md`));
      }).pipe(
        Effect.provide(
          layer(
            root,
            () => Effect.undefined,
            () => {
              throw new Error("must not generate");
            },
          ),
        ),
      );
      const otherRoot = yield* fs.makeTempDirectoryScoped();
      yield* fs.symlink(outside, `${otherRoot}/notes`);
      yield* Effect.gen(function* () {
        const pipeline = yield* Pipeline.LearnGraphPipeline;
        const result = yield* pipeline
          .importNotes({ relativePath: "a.md", content: "text" })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.reason, "validation");
        assert.isFalse(yield* fs.exists(`${outside}/a.md`));
      }).pipe(
        Effect.provide(
          layer(
            otherRoot,
            () => Effect.undefined,
            () => {
              throw new Error("must not generate");
            },
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps partial notes visible and retries only unfinished chunks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      let reject = true;
      const prompts: string[] = [];
      const input = {
        relativePath: "partial.md",
        content: `${"A".repeat(1200)}\n${"B".repeat(1200)}`,
      };
      yield* Effect.gen(function* () {
        const pipeline = yield* Pipeline.LearnGraphPipeline;
        const store = yield* Store.LearnGraphStore;
        assert.equal((yield* pipeline.importNotes(input).pipe(Effect.result))._tag, "Failure");
        const partial = yield* store.read;
        assert.equal(partial.coverage.length, 1);
        assert.equal(partial.sources[0]?.filePath, input.relativePath);
        assert.isUndefined(partial.sources[0]?.contentFp);
        reject = false;
        prompts.length = 0;
        assert.equal((yield* pipeline.importNotes(input)).batches, 1);
        assert.equal(prompts.length, 1);
        assert.include(prompts[0]!, "B".repeat(1200));
        assert.equal(
          (yield* store.read).sources[0]?.contentFp,
          Node.notesContentFingerprint(input.content),
        );
        assert.isTrue((yield* pipeline.importNotes(input)).unchanged);
      }).pipe(
        Effect.provide(
          layer(
            root,
            () => Effect.undefined,
            (role, prompt) => {
              if (role === "audit") return { links: [] };
              prompts.push(prompt);
              return reject && prompt.includes("B".repeat(1200)) ? {} : findings();
            },
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("serializes simultaneous extractions of the same source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      let calls = 0;
      yield* Effect.gen(function* () {
        const pipeline = yield* Pipeline.LearnGraphPipeline;
        const results = yield* Effect.all(
          [pipeline.runSession(threadId), pipeline.runSession(threadId)],
          { concurrency: 2 },
        );
        assert.deepEqual(results.map((result) => result.batches).toSorted(), [0, 1]);
        assert.equal(calls, 2);
      }).pipe(
        Effect.provide(
          layer(
            root,
            () => Effect.succeed(source([{ id: "m1", text: "Force" }])),
            (role) => {
              calls++;
              return role === "audit" ? { links: [] } : findings("m1");
            },
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("feeds invalid audit links back on retry before merging provenance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      let attempts = 0;
      yield* Effect.gen(function* () {
        const store = yield* Store.LearnGraphStore;
        yield* store.transact(() => ({
          append: {
            nodes: [
              {
                id: "n_force",
                name: "Force",
                statement: "Force causes acceleration",
                aliases: [],
                createdAt: "now",
                provenance: [{ chatId: "previous", messageId: "old" }],
              },
            ],
          },
          rewrite: {},
          result: undefined,
        }));
        const result = yield* (yield* Pipeline.LearnGraphPipeline).runSession(threadId);
        assert.equal(result.nodes, 1);
        assert.equal(attempts, 2);
        const graph = Graph.getGraph(yield* store.read);
        assert.deepEqual(
          graph.nodes
            .find((node) => node.id === "n_force")
            ?.provenance.map((point) => point.chatId),
          ["previous", threadId],
        );
        assert.deepEqual(graph.chains[0]?.premises, ["n_force"]);
      }).pipe(
        Effect.provide(
          layer(
            root,
            () => Effect.succeed(source([{ id: "m1", text: "Force and motion." }])),
            (role, prompt) => {
              if (role !== "audit") return findings("m1");
              attempts++;
              if (attempts === 2) assert.include(prompt, "Your previous submission was rejected");
              return { links: [{ id: "p1", linkTo: attempts === 1 ? "n_missing" : "n_force" }] };
            },
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );
});
