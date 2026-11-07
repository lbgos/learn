import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";
import { simRuntimeBundle } from "./runtimeBundle.ts";
import type { SimHeadless } from "./types.ts";

async function frame(mode: "interactive" | "headless") {
  const postMessage = vi.fn();
  const window = Object.assign(new EventTarget(), {
    parent: { postMessage },
    __physicsBoot: { code: "", mode, appearance: {} },
    __physicsHeadless: undefined as SimHeadless | undefined,
  });
  NodeVM.runInNewContext(simRuntimeBundle, {
    window,
    document: { getElementById: () => ({}), createElement: () => ({}) },
    URL,
    Blob,
    AbortController,
  });
  // No sim module is loaded in this VM; wait for its handled load error.
  await window.__physicsHeadless!.run({});
  postMessage.mockClear();
  return { window, postMessage };
}

function keydown(key: string, code: string, modifiers: Partial<KeyboardEvent> = {}) {
  return Object.assign(new Event("keydown", { cancelable: true }), {
    key,
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  });
}

it("forwards modified shortcuts and Escape from the bundled iframe runtime", async () => {
  const { window, postMessage } = await frame("interactive");
  for (const event of [
    keydown("k", "KeyK", { ctrlKey: true }),
    keydown("K", "KeyK", { metaKey: true, shiftKey: true }),
    keydown("ArrowLeft", "ArrowLeft", { altKey: true }),
    keydown("Escape", "Escape"),
  ]) {
    window.dispatchEvent(event);
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: "keydown",
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      },
      "*",
    );
    expect(event.defaultPrevented).toBe(true);
  }
  expect(postMessage).toHaveBeenCalledTimes(4);
});

it("leaves plain and Shift-only keys local to the sim", async () => {
  const { window, postMessage } = await frame("interactive");
  for (const event of [
    keydown("k", "KeyK"),
    keydown("ArrowLeft", "ArrowLeft"),
    keydown("K", "KeyK", { shiftKey: true }),
  ]) {
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(postMessage).not.toHaveBeenCalled();
});

it("does not forward or cancel keys in headless mode", async () => {
  const { window, postMessage } = await frame("headless");
  const event = keydown("k", "KeyK", { ctrlKey: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(postMessage).not.toHaveBeenCalled();
});
