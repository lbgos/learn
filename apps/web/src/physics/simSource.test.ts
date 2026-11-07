import type { PhysicsSimEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { initialSimSource, reduceSimSource, simSourceNotice } from "./simSource";

const fold = (events: readonly PhysicsSimEvent[]) =>
  events.reduce(reduceSimSource, initialSimSource);

describe("sim source events", () => {
  it("keeps the last source through a deletion and takes the new one when the file returns", () => {
    const gone = fold([{ type: "file", hash: "a", code: "v1" }, { type: "missing" }]);
    expect(gone.file).toEqual({ hash: "a", code: "v1" });
    expect(simSourceNotice(gone, "sims/x.sim.js")).toBe(
      "File not found: sims/x.sim.js. Waiting for it to come back",
    );

    const back = reduceSimSource(gone, { type: "file", hash: "b", code: "v2" });
    expect(back.file).toEqual({ hash: "b", code: "v2" });
    expect(simSourceNotice(back, "sims/x.sim.js")).toBeNull();
  });

  it("reports a transient error without dropping the source, and clears it on the next file", () => {
    const failed = fold([
      { type: "file", hash: "a", code: "v1" },
      { type: "error", message: "EACCES" },
    ]);
    expect(failed.file?.code).toBe("v1");
    expect(simSourceNotice(failed, "sims/x.sim.js")).toBe("EACCES");
    expect(reduceSimSource(failed, { type: "file", hash: "a", code: "v1" }).status.kind).toBe("ok");
  });

  it("can start missing, before any source was ever read", () => {
    const state = fold([{ type: "missing" }]);
    expect(state.file).toBeNull();
    expect(simSourceNotice(state, "sims/x.sim.js")).toContain("File not found");
  });
});
