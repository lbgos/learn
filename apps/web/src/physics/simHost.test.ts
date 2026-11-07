import type { SimMeta } from "@t3tools/physics/sim";
import { describe, expect, it } from "vite-plus/test";

import { SimHost } from "./simHost";

const meta: SimMeta = {
  title: "Pendulum",
  view: "2d",
  params: { length: { value: 1 } },
  observables: ["theta"],
  plots: [["theta"]],
};

/** A host wired to a stand-in iframe: `send` delivers a message from it, `posted` logs commands to it. */
function connectedHost() {
  const posted: unknown[] = [];
  const frameWindow = { postMessage: (message: unknown) => posted.push(message) };
  const host = new SimHost();
  host.attach({ contentWindow: frameWindow } as unknown as HTMLIFrameElement, "v1");
  const send = (data: unknown, source: object = frameWindow) =>
    host.handleMessage({ source, data } as unknown as MessageEvent<unknown>);
  return { host, send, posted };
}

describe("SimHost reload", () => {
  const withParams = (params: SimMeta["params"]): SimMeta => ({ ...meta, params });

  it("keeps the learner's values for parameters that still exist and fit", () => {
    const { host, send, posted } = connectedHost();
    send({
      type: "ready",
      meta: withParams({
        length: { value: 1, min: 0, max: 5 },
        mass: { value: 2 },
        drag: { value: 0.1 },
      }),
    });
    host.setParam("length", 3);
    host.setParam("mass", 7);
    host.setParam("drag", 0.4);
    host.load("v2");
    posted.length = 0;
    send({
      type: "ready",
      meta: withParams({
        length: { value: 1, min: 0, max: 2 }, // 3 is out of the new range
        mass: { value: 2 }, // kept
        gravity: { value: 9.8 }, // new
      }),
    });
    expect(host.getSnapshot().params).toEqual({ length: 1, mass: 7, gravity: 9.8 });
    expect(posted).toEqual([{ type: "setParams", params: { mass: 7 } }]);
  });

  it("does not carry values into a first boot", () => {
    const { host, send, posted } = connectedHost();
    send({ type: "ready", meta: withParams({ length: { value: 1 } }) });
    expect(host.getSnapshot().params).toEqual({ length: 1 });
    expect(posted).toEqual([]);
  });
});

describe("SimHost samples", () => {
  it("keeps rows that arrive before anything listens, so a late plot draws the t=0 point", () => {
    const { host, send } = connectedHost();
    expect(host.samples).toBeNull();
    send({ type: "ready", meta });
    send({ type: "samples", t: 0, rows: [[0, 0.5]] });
    const seen: number[] = [];
    host.onSamples(() => seen.push(host.samples?.length ?? 0));
    expect(host.samples?.series(1, 100)).toEqual({ x: [0], y: [0.5] });
    send({ type: "samples", t: 0.05, rows: [[0.05, 0.4]] });
    expect(seen).toEqual([2]);
  });

  it("starts a fresh buffer when the sim reloads", () => {
    const { host, send } = connectedHost();
    send({ type: "ready", meta });
    send({ type: "samples", t: 1, rows: [[1, 0.1]] });
    send({ type: "ready", meta });
    expect(host.samples?.length).toBe(0);
  });

  it("ignores messages from other windows", () => {
    const { host, send } = connectedHost();
    send({ type: "ready", meta });
    send({ type: "samples", t: 0, rows: [[0, 1]] }, {});
    expect(host.samples?.length).toBe(0);
  });
});

describe("SimHost keys", () => {
  const keydown = {
    type: "keydown",
    key: "k",
    code: "KeyK",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  };

  it("hands a key from its own iframe to listeners, with that iframe, and ignores other windows", () => {
    const { host, send } = connectedHost();
    const received: unknown[] = [];
    host.onKeyDown((key, frame) => received.push([key, frame]));
    send(keydown, {});
    expect(received).toEqual([]);
    send(keydown);
    expect(received).toHaveLength(1);
    expect((received[0] as unknown[])[0]).toEqual(keydown);
  });
});
