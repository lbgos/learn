import { expect, it } from "vite-plus/test";
import { formatSessionContext } from "../session/context.ts";
import { practiceInstructions, teachInstructions } from "./instructions.ts";

it.each(["teach", "practice"] as const)(
  "loads only %s instructions in the initial context",
  (kind) => {
    const context = formatSessionContext({
      kind,
      phase: "probe",
      mechanic: "choice",
      includeInstructions: true,
    });
    expect(context).toContain(kind === "teach" ? teachInstructions : practiceInstructions);
    expect(context).not.toContain(kind === "teach" ? practiceInstructions : teachInstructions);
    expect(formatSessionContext({ kind, phase: "probe", mechanic: "choice" })).not.toContain("#");
  },
);
