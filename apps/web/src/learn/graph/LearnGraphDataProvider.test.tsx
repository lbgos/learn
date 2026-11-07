// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, LEARN_ENDPOINTS } from "@t3tools/contracts";
import { LearnGraphDataProvider } from "./LearnGraphDataProvider";
import { useLearnGraphData, type LearnGraphData } from "./data";

const mocks = vi.hoisted(() => ({ request: vi.fn(), navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../state", () => ({
  useLearnSessions: () => ({ data: [] }),
}));
vi.mock("../http", () => ({ learnRequest: mocks.request }));
it("saves settled graph positions through the typed positions endpoint", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let completePoll: (value: unknown) => void = () => {};
  mocks.request.mockImplementation((_environment, endpoint) =>
    endpoint === LEARN_ENDPOINTS.graph
      ? new Promise((resolve) => {
          completePoll = resolve;
        })
      : Promise.resolve({}),
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  let data: LearnGraphData | undefined;
  function Consumer() {
    data = useLearnGraphData();
    return null;
  }
  const environmentId = EnvironmentId.make("learn-test");
  try {
    await act(() =>
      root.render(
        <LearnGraphDataProvider environmentId={environmentId}>
          <Consumer />
        </LearnGraphDataProvider>,
      ),
    );
    const snapshot = {
      nodes: [],
      chains: [],
      coverage: [],
      checkpoints: [],
      sources: [],
      positions: {},
    };
    await act(async () => completePoll({ revision: 7, snapshot }));
    const first = data?.snapshot;
    await act(async () => completePoll({ revision: 7, snapshot: { ...snapshot } }));
    expect(data?.snapshot).toBe(first);
    const positions = { node: { x: 12, y: -24 } };
    await data?.saveLayout(positions);
    expect(mocks.request).toHaveBeenCalledWith(environmentId, LEARN_ENDPOINTS.putPositions, {
      positions,
    });
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
