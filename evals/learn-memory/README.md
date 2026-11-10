# Learner memory

Measures which of the tutor's notes about the learner reach a turn without a tool call, and what `memory_search` finds. Notes go through the server's own store (`LearnMemoryStore` on an in-memory SQLite), core selection and per-turn recall, so the eval tests this checkout's code. No model is called, so a run is free.

`cases.ts` holds a made-up learner's notes in English, Russian and Ukrainian (goals, deadlines, preferences, recurring difficulties) and questions of five types: `single` (the note's words), `paraphrase` (the note's language, other words), `cross` (another language), `update` (a newer note replaces an older one that is still stored) and `abstain` (no note holds the answer). `distractors()` pads the set with seeded notes that look alike but answer nothing.

| Set | Notes                                |
| --- | ------------------------------------ |
| S1  | The gold notes alone.                |
| S2  | 500 notes, the gold ones among them. |
| S3  | 1,000 notes.                         |

| Arm | Search                                                                           |
| --- | -------------------------------------------------------------------------------- |
| B   | Words only, as the server runs without `LEARN_MEMORY_EMBED_URL`.                 |
| H   | Words fused with the embedder's vectors (`--embed`), as the server runs with it. |

## Run

```sh
cd evals
pnpm learn-memory --out runs/learn-memory
pnpm learn-memory --scale S2 --embed http://127.0.0.1:3982 --out runs/learn-memory-hybrid
```

`--embed` needs the embedder from `apps/cortex` (`pnpm --filter @lbgos/cortex embed`). Flags: `--scale S1|S2|S3` (repeatable; default S1 and S2), `--embed <url>`, `--case <id>` (repeatable). `rows.ndjson` has a row per question and arm, `summary.md` the table: per type, the share of questions whose gold notes reached the turn; recall@5 of `memory_search`; notes recalled on `abstain` questions (noise); the core's size; and p95 times for a turn's recall and for a search.

## Add a case

Add a note to `goldNotes` and a question to `questions` in `cases.ts`, with its `type`, the learner's `message` (and `lastReply` for a follow-up), the `gold` note keys and `older` for an update. Never use a real learner's notes.
