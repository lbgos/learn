import { MessageId, TurnItemId, type OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildQuestionMessage, practiceMessage } from "./learn/session/logic";
import { formatLearnerSignal } from "@t3tools/learn/session";
import { choice, call } from "./learn/session/fixtures.test-utils";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  timelineInputUnchanged,
} from "./session-logic";
import { deriveMessagesTimelineRows } from "./components/chat/MessagesTimeline.logic";
import { makeStreamingTimelineFixture } from "./test-fixtures";
import type { ChatMessage } from "./types";

const fixture = makeStreamingTimelineFixture();
const base = fixture.visibleTurnItems[0]!.item;
if (base.type !== "user_message") throw new Error("Expected user message fixture");
function row(item: OrchestrationV2ProjectedTurnItem["item"], position = 0) {
  return {
    position,
    visibility: "local",
    sourceThreadId: fixture.threadId,
    sourceItemId: item.id,
    item,
  } as const;
}
const question = row({
  ...base,
  type: "dynamic_tool",
  toolName: "mcp__t3-code__quiz",
  input: choice.input,
  output: {
    structuredContent: {
      learnSession: { id: choice.id, name: choice.name, input: choice.input, at: choice.at },
    },
  },
});
const text = buildQuestionMessage(choice, { values: ["gravity"], confidence: 90 });
const answer = row(
  {
    ...base,
    type: "user_message",
    id: TurnItemId.make("answer-item"),
    messageId: MessageId.make("answer-message"),
    text,
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource: "web",
  },
  1,
);
const localAnswer: ChatMessage = {
  runId: fixture.runId,
  id: MessageId.make("local-answer"),
  role: "user",
  text,
  createdAt: choice.at,
  updatedAt: choice.at,
  streaming: false,
};

describe("learn transcript projection", () => {
  it("emits each learning card once when projected rows repeat a tool result", () => {
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [question, { ...question, position: 1 }],
      optimisticMessages: [],
    });
    expect(entries).toHaveLength(1);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
  });

  it("keeps teaching text above a quiz visible after the post-tool reply settles", () => {
    const assistant = fixture.visibleTurnItems.find((row) => row.item.type === "assistant_message");
    if (!assistant || assistant.item.type !== "assistant_message")
      throw new Error("Expected assistant fixture");
    const definitionId = assistant.item.messageId;
    const definition = row({
      ...assistant.item,
      text: "The learning rate scales the gradient step.",
      streaming: false,
    });
    const followup = row(
      {
        ...assistant.item,
        id: TurnItemId.make("followup"),
        messageId: MessageId.make("followup"),
        text: "Try the check below.",
        streaming: false,
      },
      2,
    );
    for (const learnSessionKind of [undefined, "teach", "practice"] as const) {
      const entries = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [definition, question, followup],
        optimisticMessages: [],
        ...(learnSessionKind === undefined ? {} : { learnSessionKind }),
      });
      const initial = deriveTimelineEntriesFromVisibleTurnItemsWithState({
        visibleTurnItems: [definition, question, followup],
        optimisticMessages: [],
      });
      const afterMetadata = deriveTimelineEntriesFromVisibleTurnItemsWithState(
        {
          ...initial.input,
          ...(learnSessionKind === undefined ? {} : { learnSessionKind }),
        },
        initial,
      );
      expect(afterMetadata.entries).toEqual(entries);
      const rows = deriveMessagesTimelineRows({
        timelineEntries: afterMetadata.entries,
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(rows.some((entry) => entry.id === definitionId)).toBe(learnSessionKind !== undefined);
      expect(rows.some((entry) => entry.id === "followup")).toBe(true);
      expect(rows.some((entry) => entry.kind === "learn")).toBe(true);
    }
  });

  it("uses the server question id to fold an answer onto its call and hides its bubble", () => {
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [question, answer],
      optimisticMessages: [],
    });
    expect(entries).toMatchObject([
      {
        kind: "learn",
        learn: { kind: "question", anchorId: choice.id, answer: { verdict: "correct" } },
      },
    ]);
    expect(entries).toHaveLength(1);
  });
  it("shows window questions once the server state for earlier history arrives", () => {
    // The plan run is outside the loaded window; without its state, replay starts in probe and
    // refuses a check question on a plan node.
    const input = {
      visibleTurnItems: [
        row({
          ...question.item,
          input: { ...choice.input, type: "check", nodeId: "gravity" },
          output: {
            structuredContent: {
              learnSession: {
                id: choice.id,
                name: choice.name,
                input: { ...choice.input, type: "check", nodeId: "gravity" },
                at: choice.at,
              },
            },
          },
        } as OrchestrationV2ProjectedTurnItem["item"]),
      ],
      optimisticMessages: [],
      learnSessionKind: "teach" as const,
    };
    const before = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    expect(before.entries.some((entry) => entry.kind === "learn")).toBe(false);
    const seeded = {
      ...input,
      learnSessionState: {
        phase: "teach" as const,
        plan: { nodes: [{ id: "gravity", title: "Gravity" }], edges: [], version: 1 },
        position: { current: "gravity", visited: [] },
        questions: [],
        problem: null,
        conclusionId: null,
        problemDismissed: false,
        planBlock: null,
      },
    };
    expect(timelineInputUnchanged(before.input, seeded)).toBe(false);
    expect(
      deriveTimelineEntriesFromVisibleTurnItemsWithState(seeded, before).entries,
    ).toMatchObject([{ kind: "learn", learn: { kind: "question", anchorId: choice.id } }]);
  });
  it("replays earlier cards when a committed answer is appended", () => {
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      { visibleTurnItems: [question], optimisticMessages: [] },
      null,
    );
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      { visibleTurnItems: [question, answer], optimisticMessages: [] },
      previous,
    );
    expect(next.entries[0]).toMatchObject({
      kind: "learn",
      learn: { answer: { verdict: "correct" } },
    });
  });
  it("hides optimistic and history answers and uses supplied history to resolve loaded cards", () => {
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [question],
      learnSessionEvents: [
        call(choice),
        { type: "learner-message", id: "history-answer", at: choice.at, text },
      ],
      optimisticMessages: [localAnswer],
      anchoredMessages: [localAnswer],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "learn", learn: { answer: { verdict: "correct" } } });
  });
  it("folds optimistic answers before the committed projection catches up", () => {
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [question],
      optimisticMessages: [localAnswer],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "learn", learn: { answer: { verdict: "correct" } } });
  });
  it.each([
    ["hint", practiceMessage("p1", "hint", ""), "Give me a hint."],
    [
      "check",
      practiceMessage("p1", "check", "The period doubles."),
      "Check my answer.\n\nThe period doubles.",
    ],
    ["stuck", practiceMessage("p1", "stuck", ""), "I'm stuck."],
    ["work", practiceMessage("p1", "work", "My working"), "My working"],
    ["dismissed", practiceMessage("p1", "dismiss", ""), "Dismissed problem"],
    ["next problem", formatLearnerSignal({ type: "next-problem" }), "Next problem"],
  ])("renders %s without leaking its token across commit and history", (_name, wire, display) => {
    if (answer.item.type !== "user_message") throw new Error("Expected user message fixture");
    const input = { visibleTurnItems: [], optimisticMessages: [{ ...localAnswer, text: wire }] };
    const optimistic = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const committed = { ...answer.item, text: wire, messageId: localAnswer.id };
    const afterCommit = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      { visibleTurnItems: [row(committed)], optimisticMessages: input.optimisticMessages },
      optimistic,
    );
    const history = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [],
      optimisticMessages: [],
      anchoredMessages: input.optimisticMessages,
    });
    const reload = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [row(committed)],
      optimisticMessages: [],
    });
    for (const entries of [optimistic.entries, afterCommit.entries, history, reload]) {
      expect(entries.filter((entry) => entry.kind === "message")).toMatchObject([
        { message: { text: display } },
      ]);
    }
    expect(committed.text).toBe(wire);
    expect(input.optimisticMessages[0]!.text).toBe(wire);
  });

  it("does not mistake an appended graph-context message for the first user message", () => {
    if (answer.item.type !== "user_message") throw new Error("Expected user message fixture");
    const first = row({ ...answer.item, text: "Hello" });
    const late = row(
      {
        ...answer.item,
        id: TurnItemId.make("late"),
        messageId: MessageId.make("late"),
        text: "[graph context]\np1: Inertia",
      },
      1,
    );
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      { visibleTurnItems: [first], optimisticMessages: [] },
      null,
    );
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      { visibleTurnItems: [first, late], optimisticMessages: [] },
      previous,
    );
    expect(next.entries.map((entry) => entry.kind)).toEqual(["message", "message"]);
  });
  it("only collapses the first graph-context message, without hiding ordinary user messages", () => {
    if (answer.item.type !== "user_message") throw new Error("Expected user message fixture");
    const graph = row({ ...answer.item, text: "[graph context]\np1: Mass has inertia." });
    const ordinary = row(
      {
        ...answer.item,
        id: TurnItemId.make("ordinary"),
        messageId: MessageId.make("ordinary"),
        text: "Why?",
      },
      1,
    );
    expect(
      deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [graph, ordinary],
        optimisticMessages: [],
      }),
    ).toMatchObject([
      { kind: "learn", learn: { kind: "graph-context" } },
      { kind: "message", message: { text: "Why?" } },
    ]);
  });
});
