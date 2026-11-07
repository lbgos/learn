import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  migratePersistedRightPanelState,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const ref = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread"));
const other = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("other"));
const board = { id: "board:main", kind: "whiteboard", name: "main" } as const;
const sim = {
  id: "sim:sims/pendulum.sim.js",
  kind: "simulation",
  path: "sims/pendulum.sim.js",
} as const;

beforeEach(() => {
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

describe("learner right panels", () => {
  it("opens boards and simulations without duplicate tabs and keeps threads separate", () => {
    const store = useRightPanelStore.getState();
    store.openWhiteboard(ref);
    store.openSimulation(ref, sim.path);
    store.openWhiteboard(ref);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces,
    ).toEqual([board, sim]);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)).toEqual(
      board,
    );
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, other).surfaces,
    ).toEqual([]);
  });

  it("closes the active tab and returns to the other learning tab", () => {
    const store = useRightPanelStore.getState();
    store.openWhiteboard(ref);
    store.openSimulation(ref, sim.path);
    store.closeSurface(ref, sim.id);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)).toEqual(
      board,
    );
    store.closeAllSurfaces(ref);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref),
    ).toBeNull();
  });

  it("drops developer tabs opened at runtime and keeps the learning selection", () => {
    const store = useRightPanelStore.getState();
    store.openTerminal(ref, "term-1");
    store.openBrowser(ref, "tab_a");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref),
    ).toMatchObject({ isOpen: false, surfaces: [] });
    store.openWhiteboard(ref);
    store.openTerminal(ref, "term-1");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref),
    ).toMatchObject({ isOpen: true, activeSurfaceId: board.id, surfaces: [board] });
  });

  it("opens file previews and turn diffs", () => {
    const store = useRightPanelStore.getState();
    store.openFile(ref, "notes.md", 3);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref),
    ).toMatchObject({ kind: "file", relativePath: "notes.md" });
    store.open(ref, "diff");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)).toEqual({
      kind: "diff",
      id: "diff",
    });
  });

  it("migrates saved developer tabs to a valid learning selection", () => {
    const migrated = migratePersistedRightPanelState({
      byThreadKey: {
        [scopedThreadKey(ref)]: {
          isOpen: true,
          activeSurfaceId: "browser:new",
          surfaces: [{ id: "browser:new", kind: "preview", resourceId: null }, board, sim],
        },
      },
    });
    expect(selectThreadRightPanelState(migrated.byThreadKey, ref).surfaces).toEqual([board, sim]);
    expect(selectActiveRightPanelSurface(migrated.byThreadKey, ref)).toEqual(board);
  });

  it("discards malformed learning resources during migration", () => {
    const migrated = migratePersistedRightPanelState({
      byThreadKey: {
        [scopedThreadKey(ref)]: {
          isOpen: true,
          activeSurfaceId: "board:other",
          surfaces: [null, {}, { id: "board:other", kind: "whiteboard", name: "main" }],
        },
      },
    });
    expect(selectThreadRightPanelState(migrated.byThreadKey, ref).surfaces).toEqual([]);
    expect(selectActiveRightPanelSurface(migrated.byThreadKey, ref)).toBeNull();
  });
});
