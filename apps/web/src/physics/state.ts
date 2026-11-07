import { applyBoardDelta, type Board } from "@t3tools/physics/board";
import * as Stream from "effect/Stream";
import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Physics Lab RPCs: workspace listing, sim source, boards, and the model-context note. */
export const physicsEnvironment = {
  workspace: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:physics:workspace",
    tag: WS_METHODS.physicsListWorkspace,
    staleTimeMs: 5_000,
  }),
  readSim: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:physics:read-sim",
    tag: WS_METHODS.physicsReadSim,
    staleTimeMs: 5_000,
  }),
  /** The sim file now and on every change: `{ code, hash }`. */
  simEvents: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:physics:sim-events",
    tag: WS_METHODS.physicsSimSubscribe,
    idleTtlMs: 0,
  }),
  readBoard: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:physics:read-board",
    tag: WS_METHODS.physicsBoardRead,
    staleTimeMs: 2_000,
    idleTtlMs: 60_000,
  }),
  boardEvents: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:physics:board-events",
    tag: WS_METHODS.physicsBoardSubscribe,
    transform: (stream) =>
      stream.pipe(
        Stream.scan(
          (): { board: Board; revision: number } => ({
            board: { version: 1, revision: 0, items: [] },
            revision: 0,
          }),
          (previous, event) => {
            const board = "board" in event ? event.board : applyBoardDelta(previous.board, event);
            return { board, revision: board.revision };
          },
        ),
      ),
    idleTtlMs: 0,
  }),
  ensureLab: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:physics:ensure-lab",
    tag: WS_METHODS.physicsEnsureLab,
  }),
  fetchBoard: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:physics:fetch-board",
    tag: WS_METHODS.physicsBoardRead,
  }),
  applyBoardOps: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:physics:apply-board-ops",
    tag: WS_METHODS.physicsBoardApplyOps,
  }),
  setModelContext: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:physics:set-model-context",
    tag: WS_METHODS.physicsSetModelContext,
  }),
};
