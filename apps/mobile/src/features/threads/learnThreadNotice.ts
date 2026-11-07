import { LearnSessionToolResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isSessionResult = Schema.is(LearnSessionToolResult);

export function isLearnThread(
  items: ReadonlyArray<{ readonly type: string; readonly output?: unknown }>,
): boolean {
  return items.some((item) => item.type === "dynamic_tool" && isSessionResult(item.output));
}
