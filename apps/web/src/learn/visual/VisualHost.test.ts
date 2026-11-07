import { afterEach, expect, it, vi } from "vite-plus/test";
import { readVisualMessage } from "@t3tools/physics/visual";
import { VisualHost } from "./VisualHost";

afterEach(() => vi.unstubAllGlobals());
const ready = {
  channel: "lbgos-visual",
  type: "ready",
  steps: [{ label: "Pool" }, { label: "Assignment", duration: 1000 }],
  captions: [
    "Watch the pool. These matrices are waiting.",
    "Watch the assignment. Each matrix moves to a GPU.",
  ],
};
function fixture(step = 0) {
  const target = { postMessage: vi.fn() };
  const host = new VisualHost();
  host.attach(target as unknown as Window, step);
  return {
    target,
    host,
    receive: (data: unknown) => host.receive({ source: target as unknown as Window, data }),
  };
}
it("accepts only the attached frame and validated messages, then seeks the requested step", () => {
  const f = fixture(1);
  f.host.receive({ source: null, data: ready });
  f.receive({ ...ready, steps: [{ label: "" }] });
  f.receive({ ...ready, steps: [{ label: "x", duration: Infinity }] });
  expect(f.host.getSnapshot().steps).toEqual([]);
  f.receive({ ...ready, captions: ["Missing a scene."] });
  f.receive({ ...ready, captions: ["One. Two. Three.", "Watch."] });
  expect(f.host.getSnapshot().steps).toEqual([]);
  f.receive(ready);
  expect(f.host.getSnapshot().step).toBe(1);
  expect(f.host.getSnapshot().captions).toEqual(ready.captions);
  expect(f.target.postMessage).toHaveBeenLastCalledWith(
    { channel: "lbgos-visual", type: "render", step: 1, t: 1 },
    "*",
  );
  f.host.seek(0, 0.5);
  expect(f.host.getSnapshot()).toMatchObject({ step: 0, t: 0.5, playing: false });
  expect(readVisualMessage({ ...ready, channel: "other" })).toBeUndefined();
  expect(readVisualMessage({ ...ready, steps: [] })).toBeUndefined();
});
it("plays exactly one step, stops requesting frames and cancels on error or detach", () => {
  const callbacks: FrameRequestCallback[] = [];
  const request = vi.fn((callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const f = fixture(1);
  f.receive(ready);
  f.host.play();
  callbacks.shift()?.(performance.now() + 2000);
  expect(f.host.getSnapshot()).toMatchObject({ step: 1, t: 1, playing: false });
  expect(request).toHaveBeenCalledTimes(1);
  f.host.play();
  f.receive({ channel: "lbgos-visual", type: "error", message: "bad render" });
  expect(cancel).toHaveBeenCalled();
  expect(f.host.getSnapshot()).toMatchObject({ error: "bad render", playing: false });
  f.host.detach();
  f.receive(ready);
  expect(f.host.getSnapshot().error).toBe("bad render");
});
it("clamps an early animation-frame timestamp and renders through the current step once", () => {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(performance, "now").mockReturnValue(100);
  const f = fixture(1);
  f.receive(ready);
  f.host.play();
  callbacks.shift()?.(90);
  expect(f.host.getSnapshot()).toMatchObject({ step: 1, t: 0, playing: true });
  callbacks.shift()?.(600);
  expect(f.host.getSnapshot()).toMatchObject({ step: 1, t: 0.5, playing: true });
  callbacks.shift()?.(1100);
  expect(f.host.getSnapshot()).toMatchObject({ step: 1, t: 1, playing: false });
  expect(f.target.postMessage).toHaveBeenLastCalledWith(
    { channel: "lbgos-visual", type: "render", step: 1, t: 1 },
    "*",
  );
  expect(callbacks).toEqual([]);
  vi.restoreAllMocks();
});

it("keeps legacy visuals without captions seekable and playable", () => {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const f = fixture();
  f.receive({ ...ready, captions: [] });
  expect(f.host.getSnapshot()).toMatchObject({ steps: ready.steps, captions: [], error: null });
  f.host.seek(1);
  f.host.play();
  callbacks.shift()?.(performance.now() + 2000);
  expect(f.host.getSnapshot()).toMatchObject({ step: 1, t: 1, playing: false, error: null });
});
