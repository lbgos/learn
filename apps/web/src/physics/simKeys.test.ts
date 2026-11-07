import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isSimShortcut, simKeyToReplay } from "./simKeys";

const key = (patch: Partial<ReturnType<typeof simKeyToReplay>>) => ({
  ...simKeyToReplay({
    type: "keydown",
    key: "k",
    code: "KeyK",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  }),
  ...patch,
});
const ctrlK = { key: "k", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };

afterEach(() => vi.unstubAllGlobals());

describe("keys passed on by a sim", () => {
  it("replays a bare Escape without any binding", () => {
    const escape = key({ key: "Escape", code: "Escape", ctrlKey: false });
    expect(isSimShortcut(escape, { shortcuts: [], blocked: [] })).toBe(true);
    expect(isSimShortcut({ ...escape, shiftKey: true }, { shortcuts: [], blocked: [] })).toBe(
      false,
    );
  });

  it("replays only chords that are allowed shortcuts and not another command's", () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    expect(isSimShortcut(key({}), { shortcuts: [ctrlK], blocked: [] })).toBe(true);
    expect(isSimShortcut(key({}), { shortcuts: [], blocked: [] })).toBe(false);
    expect(isSimShortcut(key({}), { shortcuts: [ctrlK], blocked: [ctrlK] })).toBe(false);
    expect(
      isSimShortcut(key({ key: "w", code: "KeyW" }), { shortcuts: [ctrlK], blocked: [] }),
    ).toBe(false);
  });
});
