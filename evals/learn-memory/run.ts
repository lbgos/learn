#!/usr/bin/env node
// An eval script, not server code: it times retrieval and writes result files.
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalConsoleInEffect:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { type MemoryNote, noteId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as Memory from "../../apps/server/src/learn/memory/LearnMemoryStore.ts";
import * as MemoryEmbedder from "../../apps/server/src/learn/memory/MemoryEmbedder.ts";
import {
  DENSE_MIN,
  mergeRanked,
  MIN_MATCH,
  pickRecalled,
  RECALL_MIN,
  recallQueries,
} from "../../apps/server/src/learn/memory/memory.ts";
import { distractors, type GoldKey, goldNotes, NOW, type Question, questions } from "./cases.ts";
import { allVisible, mean, percentile, recallAt } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    scale: { type: "string", multiple: true },
    embed: { type: "string" },
    case: { type: "string", multiple: true },
    "dense-recall": { type: "string" },
    "dense-search": { type: "string" },
  },
});
if (!values.out) throw new Error("--out <dir> is required");
const out = values.out;
const scales = values.scale ?? ["S1", "S2"];
const SIZES: Record<string, number> = { S1: Object.keys(goldNotes).length, S2: 500, S3: 1000 };
const now = Date.parse(NOW);
const denseRecall = Number(values["dense-recall"] ?? DENSE_MIN.recall);
const denseSearch = Number(values["dense-search"] ?? DENSE_MIN.search);

/** A gold note's id is its key, so rows and summaries name it. */
const asNote = (id: string, note: { text: string; at: string; until?: string; pinned?: boolean }) =>
  ({
    id,
    text: note.text,
    status: "fresh",
    source: { by: "tutor", at: `${note.at}T12:00:00.000Z` },
    ...(note.until ? { until: note.until } : {}),
    ...(note.pinned ? { pinned: "auto" } : {}),
  }) satisfies MemoryNote;

const notesFor = (scale: string): MemoryNote[] => [
  ...Object.entries(goldNotes).map(([key, note]) => asNote(key, note)),
  ...distractors(SIZES[scale] ?? 500).map((note) => asNote(noteId(note.text, note.at), note)),
];

interface Row {
  readonly scale: string;
  readonly arm: "B" | "H";
  readonly id: string;
  readonly type: Question["type"];
  /** Every gold note reached the turn (core or recall) without a tool call. */
  readonly reach: boolean;
  /** For an update: the older note reached the turn too. */
  readonly olderToo?: boolean;
  readonly recall5: number;
  readonly recalled: number;
  readonly turnMs: number;
  readonly searchMs: number;
}

const evaluate = Effect.fn("evaluateLearnMemory")(function* (scale: string, arm: "B" | "H") {
  const memory = yield* Memory.LearnMemoryStore;
  yield* memory.edit(() => notesFor(scale));
  if (arm === "H") {
    const synced = yield* memory.syncVectors;
    if (!synced || synced.vectors !== synced.notes) throw new Error("Embedder did not answer.");
  }
  const core = yield* memory.core(NOW);
  const coreIds = new Set(core.shown.map((note) => note.id));
  const rows: Row[] = [];
  for (const question of questions.filter((q) => !values.case || values.case.includes(q.id))) {
    const started = performance.now();
    const ranked = yield* Effect.forEach(
      recallQueries(question.message, question.lastReply),
      (query) =>
        memory.search(query, {
          limit: 20,
          min: RECALL_MIN,
          now,
          scan: false,
          dense: arm === "H" ? denseRecall : undefined,
        }),
    );
    const recalled = pickRecalled(mergeRanked(ranked), coreIds);
    const turnMs = performance.now() - started;
    const visible = new Set([...coreIds, ...recalled.map(({ note }) => note.id)]);
    const searchStarted = performance.now();
    const searched = yield* memory.search(question.message, {
      limit: 5,
      min: MIN_MATCH,
      now,
      dense: arm === "H" ? denseSearch : undefined,
    });
    const searchMs = performance.now() - searchStarted;
    rows.push({
      scale,
      arm,
      id: question.id,
      type: question.type,
      reach: allVisible(visible, question.gold),
      ...(question.older ? { olderToo: visible.has(question.older satisfies GoldKey) } : {}),
      recall5: recallAt(
        searched.map(({ entry }) => entry.note.id),
        question.gold,
        5,
      ),
      recalled: recalled.length,
      turnMs,
      searchMs,
    });
  }
  return { rows, coreChars: core.shown.reduce((sum, note) => sum + note.text.length + 3, 0) };
});

const embedder = values.embed
  ? Layer.effect(MemoryEmbedder.MemoryEmbedder, MemoryEmbedder.make(values.embed)).pipe(
      Layer.provide(FetchHttpClient.layer),
    )
  : undefined;
const storeLayer = (arm: "B" | "H") => {
  const store = Layer.effect(Memory.LearnMemoryStore, Memory.makeMemoryStore).pipe(
    Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  return arm === "H" && embedder ? store.pipe(Layer.provide(embedder)) : store;
};

const pct = (value: number) => value.toFixed(2);
const TYPES: ReadonlyArray<Question["type"]> = [
  "single",
  "paraphrase",
  "cross",
  "update",
  "abstain",
];

const main = Effect.gen(function* () {
  const all: Row[] = [];
  const lines = [
    "| Set | Arm | single | paraphrase | cross | update | recall@5 (non-abstain) | recalled on abstain | core chars | turn p95 ms | search p95 ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const scale of scales)
    for (const arm of embedder ? (["B", "H"] as const) : (["B"] as const)) {
      const { rows, coreChars } = yield* evaluate(scale, arm).pipe(Effect.provide(storeLayer(arm)));
      all.push(...rows);
      const reach = (type: Question["type"]) =>
        pct(mean(rows.filter((row) => row.type === type).map((row) => Number(row.reach))));
      const answerable = rows.filter((row) => row.type !== "abstain");
      lines.push(
        `| ${scale} | ${arm} | ${TYPES.slice(0, 4).map(reach).join(" | ")} | ${pct(mean(answerable.map((row) => row.recall5)))} | ${mean(rows.filter((row) => row.type === "abstain").map((row) => row.recalled)).toFixed(2)} | ${coreChars} | ${percentile(
          rows.map((row) => row.turnMs),
          95,
        ).toFixed(1)} | ${percentile(
          rows.map((row) => row.searchMs),
          95,
        ).toFixed(1)} |`,
      );
    }
  NodeFS.mkdirSync(out, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(out, "rows.ndjson"),
    all.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const summary = [
    "# Learner memory recall",
    "",
    "Columns single to update: share of questions whose gold notes reached the turn (core plus recall) without a tool call.",
    `Dense floors: recall ${denseRecall}, search ${denseSearch}.`,
    "",
    ...lines,
    "",
  ].join("\n");
  NodeFS.writeFileSync(NodePath.join(out, "summary.md"), summary);
  console.log(summary);
});

Effect.runPromise(main).catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
