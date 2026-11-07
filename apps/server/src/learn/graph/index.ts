import * as Store from "./LearnGraphStore.ts";
import * as Layer from "effect/Layer";
import * as Activity from "./LearnActivity.ts";
import * as Threads from "./LearnGraphThreads.ts";
import * as Pipeline from "./LearnGraphPipeline.ts";
import * as Service from "./LearnGraphService.ts";
import * as Reactor from "./LearnGraphReactor.ts";

/** Requires existing workspace/orchestrator/settings/generation services, LearnGraphStore and LearnSessionKinds. */
export const layerServices = Layer.mergeAll(Service.layer, Reactor.layer).pipe(
  Layer.provideMerge(
    Pipeline.layer.pipe(Layer.provideMerge(Layer.mergeAll(Activity.layer, Threads.layer))),
  ),
);

export const layer = layerServices.pipe(Layer.provideMerge(Store.layer));
