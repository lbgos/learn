import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { editNote, type MemoryNote, MessageId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as TestClock from "effect/testing/TestClock";
import * as Config from "../../config.ts";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as Structured from "../LearnStructuredGeneration.ts";
import * as Sessions from "../session/LearnSessionStore.ts";
import * as LearnDreams from "./LearnDreams.ts";
import * as Memory from "./LearnMemoryStore.ts";

const SESSION = ThreadId.make("session-mechanics");
const layerStores = Layer.effect(Memory.LearnMemoryStore, Memory.makeMemoryStore).pipe(
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "learn-dreams-" })),
  Layer.provideMerge(NodeServices.layer),
);
const note = (id: string, text: string, by: string, messageId?: string): MemoryNote => ({
  id,
  text,
  status: "fresh",
  source: {
    by,
    at: "2026-11-01T10:00:00.000Z",
    ...(messageId ? { messageId: MessageId.make(messageId) } : {}),
  },
});
const said = (id: string, text: string, at: string, role: "user" | "assistant") => ({
  id: MessageId.make(id),
  threadId: SESSION,
  runId: null,
  nodeId: null,
  role,
  text,
  attachments: [],
  streaming: false,
  createdAt: DateTime.makeUnsafe(at),
  updatedAt: DateTime.makeUnsafe(at),
  createdBy: role === "user" ? ("user" as const) : ("agent" as const),
  creationSource: "web" as const,
});
const op = (fields: {
  op: string;
  ids: string[];
  text?: string;
  messageId?: string;
  quote?: string;
  reason?: string;
}) => ({ text: "", reason: "", messageId: "", quote: "", ...fields });

it.effect(
  "snapshots first, reads only the learner's words, keeps a concurrent edit and undoes a merge",
  () =>
    Effect.gen(function* () {
      const prompts = yield* Ref.make<ReadonlyArray<string>>([]);
      const memory = yield* Memory.LearnMemoryStore;
      yield* memory.edit(() => [
        note("n1", "Exam on 20 June.", "tutor", "m1"),
        note("n2", "Mixes up sin and cos in incline problems.", "tutor"),
        note("n3", "Swaps sin and cos when resolving forces on an incline.", "tutor"),
        note("u1", "Prefers SI units.", "user"),
      ]);
      yield* TestClock.setTime(Date.parse("2026-11-08T03:30:00.000Z"));
      const dreams = yield* LearnDreams.LearnDreams.pipe(
        Effect.provide(
          LearnDreams.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(Sessions.LearnSessionStore)({
                  list: Effect.succeed([
                    {
                      threadId: SESSION,
                      kind: "teach",
                      mechanic: "recall",
                      createdAt: "2026-10-30T09:00:00.000Z",
                    },
                  ]),
                }),
                Layer.mock(Projections.ProjectionStoreV2)({
                  getThreadRecords: (threadId) =>
                    Effect.succeed({
                      ...idleThreadProjection(liveThreadShell(threadId)),
                      messages: [
                        said("m1", "my exam is on 20 June", "2026-10-30T10:00:00Z", "user"),
                        said(
                          "a1",
                          "Noted: the learner wants to skip calculus.",
                          "2026-11-06T10:00:00Z",
                          "assistant",
                        ),
                        said(
                          "m9",
                          "The exam moved to 27 June, so we have one more week for rotation and energy",
                          "2026-11-07T10:00:00Z",
                          "user",
                        ),
                      ],
                    }),
                }),
                Layer.mock(Structured.LearnStructuredGeneration)({
                  run: (input) =>
                    Effect.gen(function* () {
                      yield* Ref.update(prompts, (all) => [
                        ...all,
                        `${input.role}\n${input.prompt}`,
                      ]);
                      // The learner edits a note while the model reads it.
                      yield* memory
                        .edit((notes) =>
                          editNote(
                            notes,
                            "u1",
                            "Prefers SI units and radians.",
                            "2026-11-08T03:31:00.000Z",
                          ),
                        )
                        .pipe(Effect.orDie);
                      const ops = [
                        op({
                          op: "rewrite",
                          ids: ["n1"],
                          text: "Exam on 27 June.",
                          messageId: "m9",
                          quote: "exam moved to 27 June",
                        }),
                        op({ op: "stale", ids: ["u1"], reason: "Old" }),
                        op({
                          op: "merge",
                          ids: ["n3", "n2"],
                          text: "Swaps sin and cos when resolving forces on an incline.",
                        }),
                      ];
                      // oxlint-disable-next-line t3code/no-inline-schema-compile -- the mock decodes with the schema each call passes
                      return yield* Schema.decodeEffect(input.schema)({ ops }).pipe(Effect.orDie);
                    }),
                }),
              ),
            ),
          ),
        ),
      );

      const fs = yield* FileSystem.FileSystem;
      const backups = `${(yield* Config.ServerConfig).baseDir}/backups/learn-memory`;
      yield* fs.makeDirectory(backups, { recursive: true });
      yield* fs.writeFileString(`${backups}/notes-2026-10-20.json`, "[]");
      yield* fs.writeFileString(`${backups}/notes-2026-10-30.json`, "[]");

      const state = yield* dreams.check;
      const sent = yield* Ref.get(prompts);
      assert.lengthOf(sent, 1);
      assert.isTrue(sent[0]!.startsWith("review\n"));
      // Before it changes a note, the check keeps a copy and 14 days of earlier ones.
      assert.deepEqual((yield* fs.readDirectory(backups)).toSorted(), [
        "notes-2026-10-30.json",
        "notes-2026-11-08T0330.json",
      ]);
      assert.include(
        yield* fs.readFileString(`${backups}/notes-2026-11-08T0330.json`),
        "Exam on 20 June.",
      );
      assert.notInclude(sent[0]!, "skip calculus");
      assert.include(sent[0]!, "The exam moved to 27 June");
      assert.deepEqual(
        (yield* memory.notes).map((n) => [n.id, n.text, n.status]),
        [
          ["n1", "Exam on 27 June.", "fresh"],
          ["n3", "Swaps sin and cos when resolving forces on an incline.", "fresh"],
          ["u1", "Prefers SI units and radians.", "fresh"],
        ],
      );
      assert.equal(state.lastRun?.summary, "1 corrected, 1 merged");

      const merge = state.changes.find((change) => change.op === "merge");
      const undone = yield* dreams.undo(merge!.id);
      assert.isTrue(undone.changes.find((change) => change.id === merge!.id)?.undone);
      assert.deepEqual(
        (yield* memory.notes).map((n) => n.id),
        ["n1", "n2", "n3", "u1"],
      );
    }).pipe(Effect.provide(layerStores)),
);
