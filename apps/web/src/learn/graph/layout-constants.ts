// Ported from learnharness (AGPL-3.0-only) src/core/layout.ts @ c549494.
// The force-layout defaults `@t3tools/learn/graph` keeps private; the renderer
// and the render-settings sliders must agree with the engine's own values.

export const LINK_DISTANCE = 40;
/** −120 → −240 upstream (2026-09-17): repulsion default was too weak. */
export const CHARGE_STRENGTH = -240;
/** The live sim reuses the server settle's equilibrium gravity. */
export const INCREMENTAL_GRAVITY = 0.12;
/** Default cluster-centroid pull strength. */
export const CLUSTER_PULL_STRENGTH = 0.15;
