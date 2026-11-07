import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  buildAnswer,
  createSessionGate,
  formatAnswerMessage,
  pendingQuestion,
  sessionEventsFromThread,
  sessionToolEventFromResult,
} from "./index.ts";
import type { SessionThreadItem } from "./thread.ts";

const at = "2026-10-24T12:00:00.000Z";
const input = { question: "Why?", correctAnswer: "The restoring force points toward equilibrium." };
const event = { id: "question-id", name: "explain", input, at };
const tool = (
  name = "mcp__t3-code__explain",
  output: unknown = { learnSession: event },
): SessionThreadItem => ({
  id: "provider-call-id",
  threadId: "thread",
  type: "dynamic_tool",
  toolName: name,
  status: "completed",
  ordinal: 1,
  updatedAt: DateTime.makeUnsafe(at),
  input: "truncated",
  output,
});
describe("thread session events", () => {
  it("preserves LaTeX exactly through tool result envelopes", () => {
    const math = { ...event, input: { ...input, question: String.raw`What is $\pi$?` } };
    const decoded = sessionToolEventFromResult({
      content: [{ type: "text", text: JSON.stringify({ learnSession: math }) }],
    });
    expect(decoded?.input).toEqual(math.input);
    const overescaped = {
      ...math,
      input: { ...math.input, question: String.raw`What is $\\pi$?` },
    };
    expect(
      sessionToolEventFromResult(JSON.stringify({ learnSession: overescaped }))?.input,
    ).toEqual(overescaped.input);
  });

  it("reads provider prefixes and result envelopes, retaining the handler id and complete input", () => {
    for (const prefix of [
      "",
      "mcp__t3-code__",
      "mcp__t3_code__",
      "t3-code.",
      "functions.mcp__lbgos-learn__",
      "t3-code/",
    ]) {
      for (const output of [
        { learnSession: event },
        JSON.stringify({ learnSession: event }),
        { structuredContent: { learnSession: event } },
        { content: [{ type: "text", text: JSON.stringify({ learnSession: event }) }] },
      ])
        expect(sessionEventsFromThread({ turnItems: [tool(`${prefix}explain`, output)] })).toEqual([
          { type: "tool-call", ...event },
        ]);
    }
  });
  it("pairs the same id in answer messages and deduplicates history and live rows", () => {
    const answer = formatAnswerMessage(
      buildAnswer(
        event.id,
        { kind: "explain", input },
        { text: "Force restores equilibrium.", confidence: 80 },
      ),
    );
    const question = tool();
    const message: SessionThreadItem = {
      id: "user-row",
      messageId: "message-id",
      threadId: "thread",
      type: "user_message",
      text: answer,
      ordinal: 2,
      updatedAt: at,
    };
    const row = { position: 1, visibility: "local", sourceThreadId: "thread", item: question };
    const history = [{ items: [row] }];
    const full = sessionEventsFromThread(
      { thread: { id: "thread" }, turnItems: [message, question], visibleTurnItems: [row] },
      history,
    );
    const client = sessionEventsFromThread(
      {
        projection: {
          thread: { id: "thread" },
          visibleTurnItems: [
            row,
            { position: 2, visibility: "local", sourceThreadId: "thread", item: message },
          ],
        },
      },
      history,
    );
    expect(full).toEqual(client);
    expect(full).toHaveLength(2);
    expect(pendingQuestion(full, { meta: { kind: "teach", mechanic: "recall" } })).toBeNull();
    expect(
      createSessionGate({ kind: "teach", mechanic: "recall" }, full).answers.has(event.id),
    ).toBe(true);
  });
  it("excludes failed, refused, unfinished, mismatched, inherited and child calls", () => {
    const items = [
      { ...tool(), id: "running", status: "running" },
      { ...tool(), id: "failed", status: "failed" },
      { ...tool("explain", { isError: true, learnSession: event }), id: "refused" },
      { ...tool("quiz"), id: "mismatch" },
      { ...tool("other_tool"), id: "other" },
      { ...tool(), id: "child", threadId: "child" },
    ];
    expect(
      sessionEventsFromThread({
        thread: { id: "thread" },
        turnItems: items,
        visibleTurnItems: [
          { position: 0, visibility: "inherited", sourceThreadId: "parent", item: tool() },
        ],
      }),
    ).toEqual([]);
  });
  it("maps chronological history pages without a full projection", () => {
    expect(
      sessionEventsFromThread({
        items: [{ position: 1, visibility: "local", sourceThreadId: "thread", item: tool() }],
      }),
    ).toEqual([{ type: "tool-call", ...event }]);
  });
  it("excludes rolled-back tools and learner answers from full and paged replay", () => {
    const discarded = { ...tool(), runId: "discarded" };
    const answer: SessionThreadItem = {
      id: "answer",
      type: "user_message",
      text: "[answer question-id] I don't know",
      runId: "discarded",
      updatedAt: at,
      ordinal: 2,
    };
    expect(
      sessionEventsFromThread(
        {
          runs: [{ id: "discarded", status: "rolled_back" }],
          turnItems: [discarded, answer],
        },
        [
          {
            items: [
              { position: 1, visibility: "local", sourceThreadId: "thread", item: discarded },
            ],
          },
        ],
      ),
    ).toEqual([]);
    const park = (id: string, runId: string): SessionThreadItem => ({
      ...tool("mcp__t3-code__park_question", {
        learnSession: {
          id,
          name: "park_question",
          input: { question: "Why?", nodeId: "b" },
          at,
        },
      }),
      id: `item-${id}`,
      runId,
    });
    expect(
      sessionEventsFromThread({
        runs: [
          { id: "discarded", status: "rolled_back" },
          { id: "kept", status: "completed" },
        ],
        turnItems: [park("dropped", "discarded"), park("parked", "kept")],
      }).map((event) => event.id),
    ).toEqual(["parked"]);
  });
});

it("keeps full commitments larger than ordinary tool-summary limits", () => {
  const large = {
    ...event,
    input: { ...input, correctAnswer: "A full derivation. ".repeat(2000) },
  };
  const output = { content: [{ type: "text", text: JSON.stringify({ learnSession: large }) }] };
  expect(sessionToolEventFromResult(output)).toEqual(large);
  expect(sessionEventsFromThread({ turnItems: [tool("explain", output)] })).toEqual([
    { type: "tool-call", ...large },
  ]);
});
