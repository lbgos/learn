import * as Effect from "effect/Effect";
import * as Cortex from "../../../learn/cortex/Cortex.ts";
import * as Access from "../../McpToolAccess.ts";
import { CortexToolkit } from "./tools.ts";
const handlers = {
  cortex_search: Access.readsAsCaller((input) =>
    Cortex.Cortex.pipe(Effect.flatMap((c) => c.call("cortex_search", input))),
  ),
  cortex_read: Access.readsAsCaller((input) =>
    Cortex.Cortex.pipe(Effect.flatMap((c) => c.call("cortex_read", input))),
  ),
  cortex_beliefs: Access.readsAsCaller((input) =>
    Cortex.Cortex.pipe(Effect.flatMap((c) => c.call("cortex_beliefs", input))),
  ),
  cortex_add_source: Access.actsAsCaller((input) =>
    Cortex.Cortex.pipe(Effect.flatMap((c) => c.call("cortex_add_source", input))),
  ),
  cortex_record: Access.actsAsCaller((input) =>
    Cortex.Cortex.pipe(Effect.flatMap((c) => c.call("cortex_record", input))),
  ),
} satisfies Access.Handlers<typeof CortexToolkit.tools>;
export const layer = Access.toLayer(CortexToolkit, handlers);
