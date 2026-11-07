// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { emptyGraphLedgers } from "@t3tools/learn/graph";
import { LearnGraphDataContext, type LearnGraphData } from "./data";
import { createFixtureLearnGraphData, fixtureLedgers, useFixtureLearnGraphData } from "./fixture";
import { GraphHome } from "./GraphHome";
import { DeleteSourceDialog } from "./DeleteSourceDialog";
import { selectionContext, useGraphSelectionStore } from "./selection";

const mocks = vi.hoisted(() => ({ start: vi.fn(), setVisible: vi.fn(), save: vi.fn() }));
vi.mock("../startSession", () => ({ useStartLearnSession: () => mocks.start }));
// Canvas pixels and pointer behavior are verified in the live browser.
vi.mock("./graph-canvas.ts", () => ({
  GraphCanvasRenderer: class {
    constructor(
      _canvas: HTMLCanvasElement,
      callbacks: { onCommit: (positions: Record<string, { x: number; y: number }>) => void },
    ) {
      mocks.save.mockImplementation(callbacks.onCommit);
    }
    setData() {}
    setSettings() {}
    setRegionTuning() {}
    setPhysicsTuning() {}
    destroy() {}
    setVisible(ids: ReadonlySet<string> | null) {
      mocks.setVisible(ids);
    }
  },
}));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useGraphSelectionStore.getState().clear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function button(text: string) {
  const element = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === text || item.getAttribute("aria-label") === text,
  );
  if (!element) throw new Error(`Missing button ${text}`);
  return element;
}
async function click(element: HTMLElement) {
  await act(() => element.click());
}
function Home({ fixture }: { fixture: ReturnType<typeof createFixtureLearnGraphData> }) {
  return (
    <LearnGraphDataContext value={useFixtureLearnGraphData(fixture)}>
      <GraphHome />
    </LearnGraphDataContext>
  );
}
it("shows the empty graph with notes import and leaves session creation to the home composer", async () => {
  const fixture = createFixtureLearnGraphData(emptyGraphLedgers());
  await act(() => root.render(<Home fixture={fixture} />));
  expect(host.textContent).toContain("Start a session or import notes");
  expect(button("Import notes")).toBeDefined();
  expect(host.textContent).not.toContain("New teach");
  expect(host.textContent).not.toContain("New practice");
});
it("shares cluster picks with the composer and starts practice through A's draft hook", async () => {
  const fixture = createFixtureLearnGraphData();
  await act(() => root.render(<Home fixture={fixture} />));
  await click(button("Chains"));
  const check = host.querySelector('[role="checkbox"]');
  if (!(check instanceof HTMLElement)) throw new Error("Missing cluster selection");
  await click(check);
  const selected = useGraphSelectionStore.getState().current;
  expect(selected.nodeIds.length).toBeGreaterThan(0);
  expect(selected.contextText).toContain("[graph context]\n");
  await click(button("Practice"));
  expect(mocks.start).toHaveBeenCalledWith({
    kind: "practice",
    graphContext: { nodeIds: selected.nodeIds, text: selected.contextText },
  });
  await click(button("Clear"));
  expect(useGraphSelectionStore.getState().current).toEqual({ nodeIds: [], contextText: "" });
});
it("starts practice on due propositions still in the graph and hides review when none are due", async () => {
  const calibration = [{ from: 80, to: 100, answers: 2, correct: 1 }];
  const fixture = createFixtureLearnGraphData(fixtureLedgers(), {
    due: ["n_gone", "n_mass", "n_force"],
    calibration,
  });
  await act(() => root.render(<Home fixture={fixture} />));
  await click(button("Review 2"));
  const snapshot = fixture.getSnapshot().snapshot;
  if (!snapshot) throw new Error("Missing snapshot");
  expect(mocks.start).toHaveBeenCalledWith({
    kind: "practice",
    graphContext: {
      nodeIds: ["n_mass", "n_force"],
      text: selectionContext(snapshot, ["n_mass", "n_force"]),
    },
  });
  expect(button("Calibration")).toBeDefined();
  await act(() =>
    root.render(
      <Home fixture={createFixtureLearnGraphData(fixtureLedgers(), { due: [], calibration })} />,
    ),
  );
  expect(host.querySelector('[data-testid="graph-review"]')).toBeNull();
});
it("imports notes, resets the file picker, and reports unsupported files", async () => {
  const fixture = createFixtureLearnGraphData();
  await act(() => root.render(<Home fixture={fixture} />));
  const picker = host.querySelector('input[type="file"]');
  if (!(picker instanceof HTMLInputElement)) throw new Error("Missing notes picker");
  const file = new File(["# Notes"], "mechanics.md", { type: "text/markdown" });
  Object.defineProperty(picker, "files", { configurable: true, value: [file] });
  await act(() => picker.dispatchEvent(new Event("change", { bubbles: true })));
  expect(fixture.calls.imports).toEqual([file]);
  expect(picker.value).toBe("");
  Object.defineProperty(picker, "files", {
    configurable: true,
    value: [new File(["bad"], "notes.html")],
  });
  await act(() => picker.dispatchEvent(new Event("change", { bubbles: true })));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("choose .md or .txt files");
  expect(fixture.calls.imports).toHaveLength(1);
});
it("persists the renderer's settled positions through the graph data provider", async () => {
  const fixture = createFixtureLearnGraphData();
  await act(() => root.render(<Home fixture={fixture} />));
  const positions = { n_force: { x: 10, y: 30 } };
  await act(() => mocks.save(positions));
  expect(fixture.calls.layouts).toEqual([positions]);
});
it("waits for the deletion preview and preserves data on cancel", async () => {
  const fixture = createFixtureLearnGraphData();
  const close = vi.fn();
  let release:
    | ((stats: Awaited<ReturnType<LearnGraphData["previewDeletion"]>>) => void)
    | undefined;
  const preview = new Promise<Awaited<ReturnType<LearnGraphData["previewDeletion"]>>>((resolve) => {
    release = resolve;
  });
  await act(() =>
    root.render(
      <DeleteSourceDialog
        sourceId="session-mechanics"
        title="Mechanics"
        data={{ ...fixture.getSnapshot(), previewDeletion: () => preview }}
        onClose={close}
      />,
    ),
  );
  expect(button("Delete").disabled).toBe(true);
  await act(async () => {
    release?.({ nodesRemoved: 2, chainsRemoved: 1, coverageRemoved: 0, checkpointsRemoved: 0 });
  });
  expect(document.body.textContent).toContain("2 propositions and 1 chains");
  await click(button("Cancel"));
  expect(close).toHaveBeenCalledTimes(1);
  expect(fixture.calls.deletions).toEqual([]);
});
it("retries a failed preview and removes graph traces after confirmation", async () => {
  const fixture = createFixtureLearnGraphData();
  const data = fixture.getSnapshot();
  const previewDeletion = vi
    .fn(data.previewDeletion)
    .mockRejectedValueOnce(new Error("Preview failed"));
  const close = vi.fn();
  await act(() =>
    root.render(
      <DeleteSourceDialog
        sourceId="session-mechanics"
        title="Mechanics"
        data={{ ...data, previewDeletion }}
        onClose={close}
      />,
    ),
  );
  expect(button("Delete").disabled).toBe(true);
  await click(button("Retry preview"));
  await click(button("Delete"));
  expect(fixture.calls.deletions).toEqual([
    { sourceId: "session-mechanics", mode: "delete-nodes" },
  ]);
  expect(fixture.getSnapshot().snapshot?.propositions.map((node) => node.id)).toEqual([
    "n_acceleration",
  ]);
  expect(close).toHaveBeenCalledTimes(1);
});
