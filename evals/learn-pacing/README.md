# Learn pacing

Replays short teach and practice sessions on Claude models and checks the tutor's pacing and feedback: after an answer it gives feedback and ends the turn, `Continue` yields one chunk, a typed follow-up gets a brief answer, answer requests, disputes and confidence mismatches get the responses the tutor text asks for, and `Resume` after a pause gets a recap sized to the break.

The model gets the Lab's `CLAUDE.md` (`apps/server/src/physics/templates/tutor.md`) the way Claude Code delivers it, as a project-instructions reminder at the start of the first user message. The system prompt is the runtime and orchestration text T3 appends for Claude; Claude Code's own preset is left out. Each learner message carries the session context block with the teach doctrine (`packages/learn/src/tutor/instructions.ts`) and the `learn_jobs` block; resume cases add the `learn_break` block. Tools are the session, job, `task_status`, physics and `html_render`/`html_preview` schemas, plus a `Read` that returns the Lab's stock sim and API files. All of it, and the tool results, come from this checkout.

With `--backend claude-code`, the sampled turn runs in the Claude Code CLI the way T3 runs a Lab tutor. The Agent SDK gets the Claude adapter's query options, the Lab directory holds `CLAUDE.md` and the stock files, and the T3 tools come from a local MCP server that returns production result text and `_meta`, so an accepted question ends the turn through `claude/endTurn` as it does in the app. The case's prior turns are first played into the same session against a local scripted endpoint, so only the sampled turn reaches Anthropic, on the host's Claude Code login. A run stops starting samples once a subscription limit refuses a request or weekly use passes half.

## Run

```sh
cd evals
pnpm learn-pacing --case right-answer-feedback-stops --samples 1 --out runs/check
pnpm learn-pacing --model claude-haiku-5-5 --model claude-sonnet-5-5 --out runs/pacing
pnpm learn-pacing --backend claude-code --model claude-sonnet-5-5 --case pushback-keeps-verdict --out runs/real
```

- `ANTHROPIC_API_KEY` in the repo root `.env` calls Anthropic directly. Without it, requests go to a CLIProxyAPI provider in `~/.codex/config.toml`: `vibeproxy` by default, another with `--proxy <name>`.
- CLIProxyAPI rewrites requests: it renames tools outside MCP, replaces the system text and turns on thinking. Judge stop and tool-call behavior on `claude-code`.
- Flags: `--case <ids>`, `--samples <n>` (default 3), `--concurrency <n>` (default 4), `--max-steps <n>` (default 6), `--baseline <results.jsonl>`, `--dry-run` (prints the first case's request, no model calls), `--backend api|claude-code` (default `api`). With `claude-code`: `--base-url <url>` sends the sampled turn to a local Messages endpoint instead of the login.
- Cost: a full run of 4 samples per case on Haiku 5.5 and Sonnet 5.5 used 1.78M input tokens (mostly cached) and 81k output tokens. `summary.md` records the tokens.

## Cases

Cases live in `cases.ts`. Each has the prior turns, the learner's message for the sampled turn and its checks (`PacingExpect` in `grade.ts`): a question-tool budget, a visible-word range, whether the turn may end by asking the learner something, patterns the reply must or must not contain, a graph id a posed question must target, patterns a posed question must or must not ask about, tools it may not call, tools it must call, a question type it must pose, and whether it must show the learner something to use (`html_render`, `sim_show`, `visual_show`, `board_write` or a quiz `simPath`). Every sample must end its turn, may not keep working after posing a question, and may not tell the learner to send `Continue` (the reader has a Continue button).

| Case                            | Kind  | What it checks                                                                                               |
| ------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| right-answer-feedback-stops     | bad   | Feedback on a right answer, no new question.                                                                 |
| wrong-answer-feedback-stops     | bad   | Feedback on a confident wrong answer, no repair question in the same turn.                                   |
| continue-one-chunk              | guard | `Continue` with a finished research result in `learn_jobs` yields one chunk.                                 |
| follow-up-brief                 | bad   | A typed follow-up gets at most 220 words and no question tool.                                               |
| answer-request-nudge            | bad   | A first request for the answer gets a nudge, not the committed answer.                                       |
| pushback-keeps-verdict          | bad   | A dispute of a correct verdict keeps it, briefly, without a new question.                                    |
| low-confidence-correct-reason   | bad   | A right answer at low confidence gets the reason it holds in at most 80 words.                               |
| hesitant-correct-brief          | bad   | A right answer with voiced doubts gets the verdict and at most 70 words, doubts left alone.                  |
| confident-wrong-names-gap       | bad   | A confident miss names the confidence gap and shows the right answer.                                        |
| already-know-one-check          | bad   | "I already know this" gets exactly one check.                                                                |
| practice-answer-request-no-leak | bad   | In practice, a first answer request neither reveals the result nor calls `conclude`.                         |
| warm-up-first-question          | bad   | A teach session with a due proposition opens with one recall question targeting it.                          |
| closing-recall                  | bad   | After the plan's last step, the tutor asks for a recall from memory.                                         |
| resume-long-break-recap         | bad   | `Resume` after a 47-minute break gets a recap of at most 110 words and one recall question on the last idea. |
| resume-short-break-carries-on   | guard | `Resume` after a 4-minute break gets the next chunk, without a recall question on the last idea.             |
| structure-step-shows-visual     | bad   | The fp16 spacing step, with nothing prepared, shows something to use with a predict question.                |
| motion-step-shows-sim           | bad   | The pendulum length step shows something to use, such as the Lab's sim, with a predict question.             |
| ready-visual-shown-at-step      | bad   | A visual `learn_jobs` lists as prepared for this step is shown with `html_render` and a predict question.    |
| plan-dispatches-visuals         | bad   | The `plan_init` turn also dispatches `make_visual` or `build_sim`.                                           |
| factual-question-stays-text     | guard | A factual follow-up gets a text answer, with no show tool and no job.                                        |

### Results

Passes per case, 4 samples each, through CLIProxyAPI on 2026-11-02. Tutor text before → after the study-science changes (base 78e385797, after 2cfc4f99c); both use the same tools and context block.

| Case                            | Haiku 5.5 | Sonnet 5.5 |
| ------------------------------- | --------- | ---------- |
| right-answer-feedback-stops     | 4/4 → 4/4 | 4/4 → 4/4  |
| wrong-answer-feedback-stops     | 4/4 → 4/4 | 4/4 → 4/4  |
| continue-one-chunk              | 2/4 → 4/4 | 4/4 → 4/4  |
| follow-up-brief                 | 4/4 → 4/4 | 4/4 → 4/4  |
| answer-request-nudge            | 0/4 → 4/4 | 0/4 → 4/4  |
| pushback-keeps-verdict          | 1/4 → 3/4 | 2/4 → 1/4  |
| low-confidence-correct-reason   | 2/4 → 4/4 | 4/4 → 4/4  |
| confident-wrong-names-gap       | 1/4 → 4/4 | 2/4 → 4/4  |
| already-know-one-check          | 4/4 → 3/4 | 2/4 → 3/4  |
| practice-answer-request-no-leak | 1/4 → 4/4 | 0/4 → 4/4  |
| warm-up-first-question          | 0/4 → 4/4 | 1/4 → 3/4  |
| closing-recall                  | 0/4 → 4/4 | 0/4 → 4/4  |

Sonnet keeps the verdict in every `pushback-keeps-verdict` sample; its misses run 221–279 words against the 220 cap.

Feedback on correct answers, base f87ff105e → after the change that caps it at two sentences and leaves voiced doubts alone. Passes pooled over every run on 2026-11-03 through CLIProxyAPI, 4–28 samples per cell; ¹ marks a case with no base run that day, which shows the 2026-11-02 result above. The base misses `low-confidence-correct-reason` on its 80-word cap (106–172 words).

| Case                            | Haiku 5.5     | Sonnet 5.5    |
| ------------------------------- | ------------- | ------------- |
| right-answer-feedback-stops     | 4/4¹ → 4/4    | 8/8 → 4/4     |
| wrong-answer-feedback-stops     | 4/4¹ → 4/4    | 4/4¹ → 4/4    |
| continue-one-chunk              | 4/4¹ → 12/12  | 7/8 → 12/12   |
| follow-up-brief                 | 4/4¹ → 4/4    | 4/4¹ → 4/4    |
| answer-request-nudge            | 7/8 → 11/12   | 8/8 → 11/12   |
| pushback-keeps-verdict          | 6/8 → 14/20   | 7/16 → 10/20  |
| low-confidence-correct-reason   | 0/4 → 12/12   | 0/4 → 12/12   |
| hesitant-correct-brief          | 0/4 → 11/12   | 0/4 → 12/12   |
| confident-wrong-names-gap       | 4/4¹ → 12/12  | 4/4¹ → 12/12  |
| already-know-one-check          | 24/24 → 26/28 | 8/16 → 7/12   |
| practice-answer-request-no-leak | 4/4¹ → 4/4    | 4/4¹ → 4/4    |
| warm-up-first-question          | 8/8 → 11/12   | 17/24 → 19/28 |
| closing-recall                  | 4/4¹ → 4/4    | 4/4¹ → 4/4    |

The Turn rules line "Gather what the chunk needs before you write it" keeps the `task_status` call ahead of the question in `continue-one-chunk`; without it, Sonnet scored 3/6 on 2026-10-31.

The feedback paragraph in `tutor.md` covers misses before correct answers; with correct answers first, Sonnet scored 2/8 on `pushback-keeps-verdict` and 4/8 on `continue-one-chunk` on 2026-11-03.

Resume after a pause, base 35136a7cf → the resume paragraph in `tutor.md`, both with the `learn_break` block. Passes pooled over every run on 2026-11-03 through CLIProxyAPI. With the base text, both models skip the recall and teach the next idea.

| Case                          | Haiku 5.5 | Sonnet 5.5 |
| ----------------------------- | --------- | ---------- |
| resume-long-break-recap       | 0/4 → 8/8 | 0/4 → 8/16 |
| resume-short-break-carries-on | 4/4 → 8/8 | 1/4 → 7/8  |

Every Sonnet miss calls another tool after posing its question: a second `quiz` (two retry an `answer` sent as a JSON string), an `ask`, or `task_status`. Two also run past 110 words.

Visuals at their step, base d1f3bd66a → the Lab text that prepares visuals at planning and lists them with their show call (`learn_jobs`, `html_render({ path })`). Passes pooled over runs on 2026-11-04 through CLIProxyAPI; the earlier cases above held or improved on the same day (3 samples each).

| Case                        | Haiku 5.5 | Sonnet 5.5 |
| --------------------------- | --------- | ---------- |
| structure-step-shows-visual | 0/4 → 0/6 | 0/4 → 0/6  |
| motion-step-shows-sim       | 0/4 → 0/6 | 0/4 → 0/6  |
| ready-visual-shown-at-step  | 1/4 → 4/4 | 4/4 → 4/4  |
| plan-dispatches-visuals     | 0/4 → 4/4 | 0/4 → 4/4  |
| factual-question-stays-text | 4/4 → 4/4 | 4/4 → 4/4  |

With nothing prepared, both models teach a structure or motion step in prose. A teach-doctrine line asking for a visual at such steps lifted Sonnet's `motion-step-shows-sim` to 3/4 but made Haiku keep teaching past the last node in `closing-recall` (4/12, against 11/12 without it), so the doctrine leaves visuals to the Lab text.
