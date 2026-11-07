import { MessageId, RunId } from "@t3tools/contracts";
import type { SessionEvent } from "@t3tools/learn/session";
import { describe, expect, it } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
import { at, call, choice, conclude, numberQuestion, problem } from "./fixtures.test-utils";
import { learnTimelineItems, type SessionKind } from "./logic";
import { learnPendingInput } from "./pending";
import {
  deriveLearnSlides,
  learnPendingCallId,
  learnReaderNext,
  learnReaderPendingInput,
  resolveLearnSlideIndex,
} from "./slides";

const run1 = RunId.make("run-1");
const run2 = RunId.make("run-2");
const prose = (
  id: string,
  runId: RunId,
  text: string,
  role: "assistant" | "user" = "assistant",
): TimelineEntry => ({
  id,
  kind: "message",
  createdAt: at,
  message: {
    id: MessageId.make(id),
    role,
    text,
    runId,
    streaming: false,
    createdAt: at,
    updatedAt: at,
  },
});
/** Learn rows as the timeline emits them, phase seams included; runs keyed by tool call id. */
function learnEntries(
  events: readonly SessionEvent[],
  kind: SessionKind = "teach",
  runs: Readonly<Record<string, RunId>> = {},
) {
  return learnTimelineItems(events, kind).map((learn): TimelineEntry => ({
    id: learn.id,
    kind: "learn",
    createdAt: at,
    runId: runs[learn.anchorId] ?? run1,
    learn,
  }));
}
const idle = { working: false, runningRunId: null, pendingCallId: null };
const ids = (slides: { readonly slides: readonly { readonly id: string }[] }) =>
  slides.slides.map((slide) => slide.id);

const sim = (id: string, runId: RunId): TimelineEntry => ({
  id,
  kind: "physics",
  createdAt: at,
  runId,
  physics: {
    kind: "sim",
    sim: {
      path: "sims/pendulum.sim.js",
      hash: "h",
      title: "Pendulum",
      ok: true,
      errors: [],
    },
  },
});

describe("learn reader slides", () => {
  it("shows a run's sim with the question it asked, or on its own slide when it asked none", () => {
    const learn = learnEntries([call(choice)]);
    const result = deriveLearnSlides(
      [prose("a", run1, "Predict first."), sim("s1", run1), ...learn, sim("s2", run2)],
      idle,
    );
    expect(result.slides).toMatchObject([
      { kind: "answer", media: [] },
      { kind: "learn", media: [{ id: "s1" }] },
      { kind: "answer", id: "answer:run-2", text: "", media: [{ id: "s2" }] },
    ]);
  });

  it("puts a run's prose before its question on the answer slide, and after it below it", () => {
    const learn = learnEntries([call(choice)]);
    // The learner's messages (Continue included) and job tool rows are not slides.
    const job: TimelineEntry = {
      id: "job",
      kind: "work",
      createdAt: at,
      entry: { id: "job", createdAt: at, runId: run1, label: "research", tone: "tool" },
    };
    const result = deriveLearnSlides(
      [
        prose("c", run1, "Continue", "user"),
        prose("a", run1, "Forces add."),
        job,
        ...learn,
        prose("b", run1, " Take your time. "),
      ],
      { ...idle, pendingCallId: choice.id },
    );
    expect(result.slides).toMatchObject([
      { kind: "answer", text: "Forces add.", generating: false },
      { kind: "learn", pending: true, item: { kind: "question" }, text: "Take your time." },
    ]);
    expect(result.landingIndex).toBe(0);
    expect(learnReaderNext(result.slides, 1, { ...idle, pendingCallId: choice.id })).toBeNull();
  });

  it("shows generating on the live run, or on a new slide before the run has prose", () => {
    const entries = [prose("a", run1, "Forces add.")];
    const before = deriveLearnSlides(entries, { ...idle, working: true });
    expect(before.slides.at(-1)).toMatchObject({ kind: "answer", text: "", generating: true });
    expect(before.landingIndex).toBe(1);
    const live = deriveLearnSlides([...entries, prose("b", run2, "Momentum")], {
      ...idle,
      working: true,
      runningRunId: run2,
    });
    expect(live.slides).toMatchObject([
      { generating: false },
      { kind: "answer", text: "Momentum", generating: true },
    ]);
    expect(live.landingIndex).toBe(1);
    // Next walks the slides; the last one offers Continue only to an idle tutor.
    expect(learnReaderNext(live.slides, 0, { ...idle, working: true })).toBe("next");
    expect(learnReaderNext(live.slides, 1, { ...idle, working: true })).toBeNull();
    expect(learnReaderNext(live.slides, 1, idle)).toBe("continue");
    expect(learnReaderNext([], 0, idle)).toBeNull();
  });

  it("shows the plan a run set on its answer slide, also when the run wrote no prose", () => {
    const done: SessionEvent = {
      type: "tool-call",
      id: "done",
      name: "probe_done",
      at,
      input: { assessment: { strands: [{ strand: "Force", assessment: "Ready" }] } },
    };
    const plan: SessionEvent = {
      type: "tool-call",
      id: "plan",
      name: "plan_init",
      at,
      input: { mermaid: "graph TD\nforce[Force] --> motion[Motion]" },
    };
    const revised: SessionEvent = {
      ...plan,
      id: "plan2",
      input: { mermaid: "graph TD\nforce[Force] --> mass[Mass]\nmass --> motion[Motion]" },
    };
    const learn = learnEntries([done, plan, revised], "teach", { plan2: run2 });
    expect(
      deriveLearnSlides([prose("a", run1, "Here is the route."), ...learn], idle),
    ).toMatchObject({
      slides: [
        { kind: "answer", text: "Here is the route.", plan: { planCallId: "plan" } },
        {
          kind: "answer",
          text: "",
          generating: false,
          plan: { planCallId: "plan2", nodes: [{ id: "force" }, { id: "mass" }, { id: "motion" }] },
        },
      ],
      landingIndex: 1,
    });
  });

  it("shows a parked question above the prose of the run that answers it", () => {
    const tool = (id: string, name: string, input: unknown): SessionEvent => ({
      type: "tool-call",
      id,
      name,
      at,
      input,
    });
    const learn = learnEntries(
      [
        tool("done", "probe_done", {
          assessment: { strands: [{ strand: "Force", assessment: "Ready" }] },
        }),
        tool("plan", "plan_init", { mermaid: "graph TD\nforce[Force] --> motion[Motion]" }),
        tool("p1", "park_question", { question: "Why sines?", nodeId: "motion" }),
        tool("a1", "answer_parked", { id: "p1" }),
      ],
      "teach",
      { a1: run2 },
    );
    expect(
      deriveLearnSlides([...learn, prose("b", run2, "Earlier you asked why.")], idle).slides,
    ).toMatchObject([
      { kind: "answer", plan: { planCallId: "plan" }, parked: [], recalled: [] },
      { kind: "answer", text: "Earlier you asked why.", recalled: ["Why sines?"] },
    ]);
  });

  it("keeps the open question last after a side reply and lands on the reply", () => {
    const events = [call(choice)];
    const question = learnEntries(events).find((entry) => entry.id.includes(choice.id));
    const pendingCallId = learnPendingCallId(learnPendingInput(events, "teach"));
    const result = deriveLearnSlides(
      [prose("a", run1, "Forces add."), question!, prose("b", run2, "Mass resists.")],
      { ...idle, pendingCallId },
    );
    expect(ids(result)).toEqual(["answer:run-1", "answer:run-2", question!.id]);
    expect(result.landingIndex).toBe(1);
    expect(learnReaderPendingInput(result.slides, 1)).toBe("held");
    expect(learnReaderPendingInput(result.slides, 2)).toBe("answer");
    // An owner outside the loaded slides keeps the composer's full question panel.
    const unowned = deriveLearnSlides([prose("b", run2, "Mass resists.")], {
      ...idle,
      pendingCallId,
    });
    expect(learnReaderPendingInput(unowned.slides, 0)).toBeUndefined();
  });

  it("lands on a question asked without prose, and owns paused practice by its conclusion", () => {
    const events = [problem, conclude];
    const learn = learnEntries(events, "practice", { [conclude.id]: run2 });
    const pendingCallId = learnPendingCallId(learnPendingInput(events, "practice"));
    const result = deriveLearnSlides(learn, { ...idle, pendingCallId });
    expect(result.slides).toMatchObject([
      { item: { kind: "problem" }, pending: false },
      { item: { kind: "conclusion" }, pending: true },
    ]);
    expect(result.landingIndex).toBe(1);
  });

  it("holds a chosen slide until a newer run moves the landing slide", () => {
    const learn = learnEntries([call(numberQuestion)]);
    const first = deriveLearnSlides([prose("a", run1, "Period"), ...learn], idle);
    const selection = { id: first.slides[1]!.id, landingId: "answer:run-1" };
    expect(resolveLearnSlideIndex(first, selection)).toBe(1);
    expect(resolveLearnSlideIndex(first, { ...selection, id: "gone" })).toBe(0);
    const next = deriveLearnSlides([prose("a", run1, "Period"), ...learn], {
      ...idle,
      working: true,
      runningRunId: run2,
    });
    expect(resolveLearnSlideIndex(next, selection)).toBe(2);
  });
});

it("puts an inline HTML explainer in its run's media like a sim", () => {
  const htmlRender = { attachmentId: "explainer", title: "Pendulum", height: 300 };
  const result = deriveLearnSlides(
    [
      prose("intro", run1, "Change the length."),
      { id: "visual", kind: "html-render", createdAt: at, runId: run1, htmlRender },
    ],
    idle,
  );
  expect(result.slides[0]).toMatchObject({ kind: "answer", media: [{ id: "visual", htmlRender }] });
  expect(
    deriveLearnSlides(
      [{ id: "visual", kind: "html-render", createdAt: at, runId: run1, htmlRender }],
      idle,
    ).slides,
  ).toHaveLength(1);
});
