import { questionToolNames } from "../../packages/learn/src/session/index.ts";
/** One model response in a sampled turn: its visible text, its tool calls and why it stopped. */
export interface Step {
  readonly text: string;
  /** Bare tool names, without the `mcp__t3-code__` prefix. */
  readonly calls: ReadonlyArray<{
    readonly tool: string;
    readonly input: unknown;
    readonly problems?: ReadonlyArray<string>;
  }>;
  readonly stopReason: string | null;
  readonly afterQuestionText?: string;
  readonly beforeQuestionText?: string;
  readonly afterQuestionCalls?: number;
}

/** An Anthropic Messages API content block. */
export type Block = Readonly<Record<string, unknown>>;

const blockText = (blocks: ReadonlyArray<Block>) =>
  blocks.flatMap((block) => (block.type === "text" ? [String(block.text)] : [])).join("\n");

/**
 * One model response as a step. `outcomes` holds what each tool_use block's call got, in block
 * order, or undefined where the backend did not simulate it; tool names lose `prefix`.
 */
export function stepFrom(
  content: ReadonlyArray<Block>,
  outcomes: ReadonlyArray<
    { readonly input: unknown; readonly problems: ReadonlyArray<string> } | undefined
  >,
  stopReason: string | null,
  prefix: string,
): Step {
  const uses = content.filter((block) => block.type === "tool_use");
  const asked = content.findIndex(
    (block) =>
      block.type === "tool_use" && questionToolNames.has(String(block.name).replace(prefix, "")),
  );
  const after = asked === -1 ? [] : content.slice(asked + 1);
  return {
    text: blockText(content),
    calls: uses.map((block, index) => ({
      tool: String(block.name).replace(prefix, ""),
      input: outcomes[index]?.input ?? block.input,
      problems: outcomes[index]?.problems ?? [],
    })),
    stopReason,
    afterQuestionCalls: after.filter((block) => block.type === "tool_use").length,
    beforeQuestionText: blockText(asked === -1 ? content : content.slice(0, asked)),
    afterQuestionText: blockText(after),
  };
}

export interface PacingExpect {
  /** Most question tools (ask, quiz, explain, problem) the turn may call. */
  readonly maxQuestions: number;
  readonly verdict?: {
    readonly tool: "grade_answer" | "correct_verdict";
    readonly questionId: string;
    readonly verdict: "correct" | "incorrect";
  };
  /** Visible words the whole turn may write. */
  readonly maxWords: number;
  /** Visible words the turn needs unless it poses a question, so an empty reply cannot pass. */
  readonly minWords: number;
  /** The turn's last paragraph may not ask the learner something. */
  readonly noTrailingQuestion?: boolean;
  /** Fewest question tools the turn must call. */
  readonly minQuestions?: number;
  /** Each must match the visible text or a posed question. */
  readonly require?: ReadonlyArray<RegExp>;
  readonly requireBeforeQuestion?: ReadonlyArray<RegExp>;
  /** None may match the visible text or a posed question, such as the committed answer. */
  readonly forbid?: ReadonlyArray<RegExp>;
  /** A posed question must carry this graph id in its target. */
  readonly target?: string;
  /** Tools the turn may not call, such as conclude, which reveals the solution. */
  readonly forbidTools?: ReadonlyArray<string>;
  /** A posed question, with its option labels, must match: the idea a recall question checks. */
  readonly askAbout?: RegExp;
  /** No posed question, with its option labels, may match. */
  readonly avoidAsking?: RegExp;
  /** The turn shows the learner something to use: a visual, sim or board item, or a quiz simPath. */
  readonly show?: boolean;
  /** A posed question must have this type, such as predict. */
  readonly questionType?: "predict" | "check";
  /** For each group, the turn calls at least one of its tools and the call is accepted. */
  readonly requireTools?: ReadonlyArray<ReadonlyArray<string>>;
  /** An accepted park_question call saves the learner's question at this plan node. */
  readonly parkAt?: string;
  /** The turn's first paragraph must match, such as naming an earlier question. */
  readonly opensWith?: RegExp;
}

/** Tools that put something in front of the learner. */
export const SHOW_TOOLS: ReadonlySet<string> = new Set([
  "html_render",
  "sim_show",
  "visual_show",
  "board_write",
]);
const field = (input: unknown, key: string) =>
  typeof input === "object" && input !== null && key in input
    ? (input as Record<string, unknown>)[key]
    : undefined;

const countWords = (text: string) => text.split(/\s+/).filter((word) => /\w/.test(word)).length;
/** A question and its choice labels, as the learner reads them. */
const readQuestion = (input: unknown) => {
  if (typeof input !== "object" || input === null) return "";
  const answer =
    "answer" in input && typeof input.answer === "object" && input.answer !== null
      ? input.answer
      : null;
  const options: ReadonlyArray<unknown> =
    answer !== null && "options" in answer && Array.isArray(answer.options) ? answer.options : [];
  return [
    "question" in input ? String(input.question) : "",
    ...options.map((option) =>
      typeof option === "object" && option !== null && "label" in option
        ? String(option.label)
        : "",
    ),
  ].join("\n");
};
// The reader's Continue button sends `Continue`; the tutor must not point the learner at it.
const CONTINUE_PROMPT =
  /\b(?:send|type|press|click|hit|tap|say|reply|write|enter)\b[^.!?\n]{0,30}\bcontinue\b|[`"'“‘*]Continue\b/i;

/** Grades one sampled turn: it ends, poses at most its question budget, and stays one chunk. */
export function grade(steps: ReadonlyArray<Step>, expect: PacingExpect) {
  const failures: string[] = [];
  const stop = steps.at(-1)?.stopReason ?? "no response";
  if (stop !== "end_turn") failures.push(`did not end its turn (${stop})`);
  if (
    expect.verdict &&
    !steps
      .flatMap((step) => step.calls)
      .some((call) => {
        const input = call.input;
        return (
          call.tool === expect.verdict?.tool &&
          typeof input === "object" &&
          input !== null &&
          "questionId" in input &&
          input.questionId === expect.verdict.questionId &&
          "verdict" in input &&
          input.verdict === expect.verdict.verdict &&
          "reason" in input &&
          typeof input.reason === "string" &&
          input.reason.trim().length > 0
        );
      })
  )
    failures.push("missing persisted verdict");
  for (const call of steps.flatMap((step) => step.calls))
    for (const problem of call.problems ?? []) failures.push(`${call.tool} refused: ${problem}`);
  const questions = steps
    .flatMap((step) => step.calls)
    .filter((call) => questionToolNames.has(call.tool) && !call.problems?.length);
  if (questions.length > expect.maxQuestions)
    failures.push(`posed ${questions.length} questions (max ${expect.maxQuestions})`);
  const asked = steps.findIndex((step) =>
    step.calls.some((call) => questionToolNames.has(call.tool)),
  );
  if (
    asked !== -1 &&
    (steps.slice(asked + 1).some((step) => step.calls.length > 0 || countWords(step.text) > 0) ||
      countWords(steps[asked]?.afterQuestionText ?? "") > 0 ||
      (steps[asked]?.afterQuestionCalls ?? 0) > 0)
  )
    failures.push("kept working after posing a question");
  const text = steps
    .map((step) => step.text.trim())
    .filter((part) => part !== "")
    .join("\n\n");
  const words = countWords(text);
  if (words > expect.maxWords) failures.push(`${words} words (max ${expect.maxWords})`);
  if (words < expect.minWords && questions.length === 0)
    failures.push(`${words} words and no question (min ${expect.minWords})`);
  const lastParagraph = text.split(/\n\s*\n/).at(-1) ?? "";
  if (expect.noTrailingQuestion && /\?[\s*_)"'”]*$/.test(lastParagraph))
    failures.push("ends by asking the learner a question");
  if (CONTINUE_PROMPT.test(text)) failures.push("tells the learner to send Continue");
  if (questions.length < (expect.minQuestions ?? 0))
    failures.push(`posed ${questions.length} questions (min ${expect.minQuestions})`);
  const posed = questions.map((call) =>
    typeof call.input === "object" && call.input !== null && "question" in call.input
      ? String(call.input.question)
      : "",
  );
  const said = [text, ...posed].join("\n");
  for (const pattern of expect.require ?? [])
    if (!pattern.test(said)) failures.push(`missing ${pattern.source}`);
  const beforeQuestion =
    asked === -1
      ? text
      : [
          ...steps.slice(0, asked).map((step) => step.text),
          steps[asked]?.beforeQuestionText ?? steps[asked]?.text ?? "",
        ].join("\n");
  for (const pattern of expect.requireBeforeQuestion ?? [])
    if (!pattern.test(beforeQuestion)) failures.push(`missing recap ${pattern.source}`);
  for (const pattern of expect.forbid ?? []) {
    const found = pattern.exec(said)?.[0];
    if (found !== undefined) failures.push(`says "${found}"`);
  }
  const target = expect.target;
  if (
    target !== undefined &&
    // Providers sometimes send the array JSON-encoded; the server heals that.
    !questions.some(
      (call) =>
        typeof call.input === "object" &&
        call.input !== null &&
        "target" in call.input &&
        JSON.stringify(call.input.target).includes(target),
    )
  )
    failures.push(`no question targets ${target}`);
  const { askAbout, avoidAsking } = expect;
  const read = questions.map((call) => readQuestion(call.input));
  if (askAbout !== undefined && !read.some((question) => askAbout.test(question)))
    failures.push(`no question asks about ${askAbout.source}`);
  const avoided = avoidAsking === undefined ? undefined : read.find((q) => avoidAsking.test(q));
  if (avoided !== undefined) failures.push(`asks "${avoided}"`);
  const calls = steps.flatMap((step) => step.calls);
  if (
    expect.show &&
    !calls.some(
      (call) => SHOW_TOOLS.has(call.tool) || (call.tool === "quiz" && field(call.input, "simPath")),
    )
  )
    failures.push("showed nothing to use");
  const { questionType } = expect;
  if (
    questionType !== undefined &&
    !questions.some((call) => field(call.input, "type") === questionType)
  )
    failures.push(`no ${questionType} question`);
  for (const group of expect.requireTools ?? [])
    if (!calls.some((call) => group.includes(call.tool) && !call.problems?.length))
      failures.push(`called none of ${group.join(", ")}`);
  if (
    expect.parkAt !== undefined &&
    !calls.some(
      (call) =>
        call.tool === "park_question" &&
        !call.problems?.length &&
        field(call.input, "nodeId") === expect.parkAt,
    )
  )
    failures.push(`parked nothing at ${expect.parkAt}`);
  const firstParagraph = text.split(/\n\s*\n/)[0] ?? "";
  if (expect.opensWith !== undefined && !expect.opensWith.test(firstParagraph))
    failures.push(`does not open with ${expect.opensWith.source}`);
  for (const tool of expect.forbidTools ?? [])
    if (steps.some((step) => step.calls.some((call) => call.tool === tool)))
      failures.push(`called ${tool}`);
  return { pass: failures.length === 0, failures, words, questions: questions.length };
}
