import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import { buildVisualDocument, visualCaptionError, visualRuntime } from "./visual.ts";

it("iframe bridge rejects foreign messages, bounds render requests and reports render failures", () => {
  const frames: Array<readonly [number, number]> = [];
  const sent: unknown[] = [];
  const parent = { postMessage: (message: unknown) => sent.push(message) };
  const window = {
    lbgosVisual: {
      steps: [{ label: "Pool" }, { label: "Assign" }],
      captions: ["Watch the pool.", "Watch the assignment."],
      render: (step: number, t: number) => {
        frames.push([step, t]);
        if (step === 1) throw new Error("render failed");
      },
    },
  };
  let receive: ((event: { source: unknown; data: unknown }) => void) | undefined;
  NodeVM.runInNewContext(visualRuntime, {
    window,
    parent,
    addEventListener: (_name: string, listener: NonNullable<typeof receive>) => {
      receive = listener;
    },
    Error,
  });
  expect(sent).toContainEqual({
    channel: "lbgos-visual",
    type: "ready",
    steps: window.lbgosVisual.steps,
    captions: window.lbgosVisual.captions,
  });
  const message = { channel: "lbgos-visual", type: "render", step: 0, t: 0.5 };
  receive?.({ source: {}, data: message });
  receive?.({ source: parent, data: { ...message, channel: "other" } });
  expect(frames).toEqual([[0, 1]]);
  receive?.({ source: parent, data: message });
  expect(frames.at(-1)).toEqual([0, 0.5]);
  receive?.({ source: parent, data: { ...message, t: Infinity } });
  expect(frames.at(-1)).toEqual([0, 0.5]);
  receive?.({ source: parent, data: { ...message, step: 1 } });
  expect(sent.at(-1)).toEqual({ channel: "lbgos-visual", type: "error", message: "render failed" });
});

it("requires short voiceovers for every step, without counting math or decimals as prose", () => {
  expect(visualCaptionError(undefined, 1)).toContain("every step");
  expect(visualCaptionError([], 1)).toContain("every step");
  expect(visualCaptionError([" "], 1)).toContain("characters");
  expect(visualCaptionError(["x".repeat(481)], 1)).toContain("characters");
  expect(visualCaptionError(["Watch. Follow. Stop."], 1)).toContain("two short sentences");
  expect(visualCaptionError(["Watch $x=0.5$. It approaches 1."], 1)).toBeUndefined();
  expect(visualCaptionError([String.raw`Watch \(x=0.5\). It approaches 1.`], 1)).toBeUndefined();
});

it("the runtime rejects missing, blank and verbose captions before rendering", () => {
  for (const captions of [undefined, [], [""], ["One. Two. Three."]]) {
    let rendered = false;
    const window = {
      lbgosVisual: {
        steps: [{ label: "Scene" }],
        captions,
        render() {
          rendered = true;
        },
      },
    };
    const sent: { type: string; message?: string }[] = [];
    NodeVM.runInNewContext(visualRuntime, {
      window,
      parent: { postMessage: (message: (typeof sent)[number]) => sent.push(message) },
      addEventListener() {},
      Error,
    });
    expect(rendered).toBe(false);
    expect(sent[0]?.type).toBe("error");
    expect(sent[0]?.message).toContain("caption");
  }
});

it("allows missing captions only in the legacy playback document", () => {
  let rendered = false;
  const window = {
    lbgosVisual: {
      steps: [{ label: "Old scene" }],
      render() {
        rendered = true;
      },
    },
  };
  const sent: unknown[] = [];
  const document = buildVisualDocument("", { allowMissingCaptions: true });
  const runtime = document.slice(
    document.lastIndexOf("<script>") + 8,
    document.lastIndexOf("</script>"),
  );
  NodeVM.runInNewContext(runtime, {
    window,
    parent: { postMessage: (message: unknown) => sent.push(message) },
    addEventListener() {},
    Error,
  });
  expect(rendered).toBe(true);
  expect(sent).toEqual([
    { channel: "lbgos-visual", type: "ready", steps: window.lbgosVisual.steps, captions: [] },
  ]);
});
