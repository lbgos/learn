import {
  applySessionEvent,
  createSessionGate,
  prepareToolInput,
  sessionToolResultMessage,
  validateSessionCall,
  type SessionToolName,
  type SessionGate,
} from "../../packages/learn/src/session/index.ts";
import { LearnSessionCallRefused } from "../../apps/server/src/learn/session/LearnSessionService.ts";
import type { PacingCase } from "./cases.ts";
import { failure, success, type ToolOutcome } from "./results.ts";

const at = "2026-10-30T12:00:00.000Z";

/** The production gate after the case's prior turns, before the sampled message. */
export function historyGate(entry: PacingCase): SessionGate {
  let gate: SessionGate = {
    ...createSessionGate(entry.session, [], new Set(entry.session.due?.map((node) => node.id))),
    phase: entry.historyPhase ?? entry.session.phase,
    plan: entry.session.plan ?? null,
  };
  for (const [index, turn] of entry.turns.entries()) {
    const applied = applySessionEvent(
      gate,
      turn.role === "learner"
        ? { type: "learner-message", id: `history-${index}`, text: turn.text, at }
        : turn.call
          ? {
              type: "tool-call",
              id: turn.call.id,
              name: turn.call.tool,
              input: turn.call.input,
              at,
            }
          : { type: "learner-message", id: `history-${index}`, text: "", at },
    );
    if (applied.problems.length)
      throw new Error(`${entry.id} fixture: ${applied.problems.join("; ")}`);
    gate = applied.gate;
  }
  if (gate.phase !== entry.session.phase)
    throw new Error(
      `${entry.id} fixture: history ends in ${gate.phase}, not ${entry.session.phase}`,
    );
  return gate;
}

export function createEvalSession(entry: PacingCase) {
  let gate = applySessionEvent(historyGate(entry), {
    type: "learner-message",
    id: "current",
    text: entry.message,
    at,
  }).gate;
  return (name: SessionToolName, id: string, raw: unknown): ToolOutcome => {
    const input = prepareToolInput(name, raw);
    const problems = validateSessionCall(gate, name, input);
    if (problems.length)
      return failure(
        input,
        "invalid_request",
        new LearnSessionCallRefused({ tool: name, problems }).message,
        problems,
      );
    gate = applySessionEvent(gate, { type: "tool-call", id, name, input, at }).gate;
    return success(input, {
      learnSession: { id, name, input, at },
      message: sessionToolResultMessage(name, id),
    });
  };
}
