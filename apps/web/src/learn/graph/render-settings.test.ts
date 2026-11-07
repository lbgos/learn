// Ported from learnharness (AGPL-3.0-only) tests/render-settings.test.ts @ c549494.
/**
 * Tests for src/core/render-settings.ts — the shared settings contract
 * (shape, defaults, sanitizer, ladder/slider mapping). Pure module, pure
 * tests: whatever JSON arrives from disk or the network goes through
 * sanitizeRenderSettings and must come out valid, never throw.
 */

import { describe, expect, it as test } from "vite-plus/test";
import {
  ARROW_LENGTH_LADDER,
  CHARGE_RANGE,
  CLUSTER_LABEL_SIZE_LADDER,
  CLUSTER_PULL_RANGE,
  DEFAULT_RENDER_SETTINGS,
  DEPTH_BASE_RADIUS_RANGE,
  DEPTH_SPACING_RANGE,
  DEPTH_STRENGTH_RANGE,
  EDGE_WIDTH_LADDER,
  GRAVITY_RANGE,
  LABEL_SIZE_LADDER,
  LABEL_ZOOM_LADDER,
  LINK_DISTANCE_RANGE,
  LINK_STRENGTH_RANGE,
  NODE_SIZE_LADDER,
  REGION_BLUR_LADDER,
  sanitizeRegionTuning,
  REGION_DILATION_LADDER,
  REGION_EDGE_ALPHA_LADDER,
  VELOCITY_DECAY_RANGE,
  DEFAULT_PHYSICS_TUNING,
  DEFAULT_REGION_TUNING,
  fromLadderPosition,
  fromOffSliderPosition,
  labelZoomDisplay,
  ladderIndex,
  sanitizeRenderSettings,
  snapToLadder,
  toLadderPosition,
  toOffSliderPosition,
  toSliderPosition,
} from "./render-settings.ts";

describe("sanitizeRenderSettings", () => {
  test("garbage in → full defaults out", () => {
    expect(sanitizeRenderSettings(null)).toEqual(DEFAULT_RENDER_SETTINGS);
    expect(sanitizeRenderSettings(undefined)).toEqual(DEFAULT_RENDER_SETTINGS);
    expect(sanitizeRenderSettings("junk")).toEqual(DEFAULT_RENDER_SETTINGS);
    expect(sanitizeRenderSettings(42)).toEqual(DEFAULT_RENDER_SETTINGS);
  });

  test("partial input → defaults fill the gaps", () => {
    const s = sanitizeRenderSettings({ sizeUnits: "world", nodeSize: 6 });
    expect(s.nodeSize).toBe(6);
    expect(s.edgeWidth).toBe(DEFAULT_RENDER_SETTINGS.edgeWidth);
    expect(s.labelSize).toBe(DEFAULT_RENDER_SETTINGS.labelSize);
    expect(s.labelZoom).toBe(DEFAULT_RENDER_SETTINGS.labelZoom);
    expect(s.clusterLabels).toBe(DEFAULT_RENDER_SETTINGS.clusterLabels);
    expect(s.clusterLabelSize).toBe(DEFAULT_RENDER_SETTINGS.clusterLabelSize); // old files → 14
  });

  test("out-of-range values snap to ladder ends; wrong types reset", () => {
    const s = sanitizeRenderSettings({
      sizeUnits: "world",
      nodeSize: 999,
      edgeWidth: 0,
      arrowLength: -5,
      labelZoom: 100,
      labelSize: "big" as unknown as number,
      clusterLabels: "yes" as unknown as boolean,
      clusterLabelSize: "huge" as unknown as number,
    });
    expect(s.nodeSize).toBe(NODE_SIZE_LADDER[NODE_SIZE_LADDER.length - 1]); // snapped to the ladder top
    expect(s.edgeWidth).toBe(EDGE_WIDTH_LADDER[0]); // snapped to the ladder floor
    expect(s.arrowLength).toBe(ARROW_LENGTH_LADDER[0]);
    expect(s.labelZoom).toBe(LABEL_ZOOM_LADDER[LABEL_ZOOM_LADDER.length - 1]);
    expect(s.labelSize).toBe(DEFAULT_RENDER_SETTINGS.labelSize); // NaN-safe reset
    expect(s.clusterLabels).toBe(DEFAULT_RENDER_SETTINGS.clusterLabels);
    expect(s.clusterLabelSize).toBe(DEFAULT_RENDER_SETTINGS.clusterLabelSize); // NaN-safe reset
  });

  test("the ladder law: any finite value snaps to the nearest stop", () => {
    // Stored artifacts like 2.18137...977 (px-at-fit survivors) become
    // nice numbers; nothing non-finite ever enters a file.
    expect(snapToLadder(2.18, NODE_SIZE_LADDER)).toBe(2);
    expect(snapToLadder(3.9, NODE_SIZE_LADDER)).toBe(4);
    expect(snapToLadder(0.63, NODE_SIZE_LADDER)).toBe(0.75); // 0.63 is nearer 0.75 than 0.5
    // Ties break low (deterministic, and the lower stop is the
    // conservative direction for every knob).
    expect(snapToLadder(1.25, NODE_SIZE_LADDER)).toBe(1);
    // The display cluster-label ladder snaps too.
    expect(
      sanitizeRenderSettings({ sizeUnits: "world", clusterLabelSize: 21 }).clusterLabelSize,
    ).toBe(20);
  });

  test("clusterLabelSize snaps to its own ladder", () => {
    // Default 14 is a stop (index 5) → dead-center slider.
    expect(DEFAULT_RENDER_SETTINGS.clusterLabelSize).toBe(
      CLUSTER_LABEL_SIZE_LADDER[ladderIndex(14, CLUSTER_LABEL_SIZE_LADDER)],
    );
    const s = sanitizeRenderSettings({ sizeUnits: "world", clusterLabelSize: 999 });
    expect(s.clusterLabelSize).toBe(
      CLUSTER_LABEL_SIZE_LADDER[CLUSTER_LABEL_SIZE_LADDER.length - 1],
    );
    const s2 = sanitizeRenderSettings({ sizeUnits: "world", clusterLabelSize: 1 });
    expect(s2.clusterLabelSize).toBe(CLUSTER_LABEL_SIZE_LADDER[0]);
  });

  test("the low ends accept small sizes (ladder floors)", () => {
    const s = sanitizeRenderSettings({
      sizeUnits: "world",
      nodeSize: 0.3,
      edgeWidth: 0.1,
      arrowLength: 0.2,
      labelSize: 0.3,
    });
    expect({
      nodeSize: s.nodeSize,
      edgeWidth: s.edgeWidth,
      arrowLength: s.arrowLength,
      labelSize: s.labelSize,
    }).toEqual({ nodeSize: 0.25, edgeWidth: 0.1, arrowLength: 0.25, labelSize: 0.5 });
  });

  test("a fully valid object passes through unchanged", () => {
    const valid = {
      sizeUnits: "world",
      nodeSize: 4,
      edgeWidth: 2,
      arrowLength: 3,
      labelZoom: 2,
      labelSize: 4,
      clusterLabels: false,
      clusterLabelSize: 20,
      regions: DEFAULT_REGION_TUNING,
      physics: DEFAULT_PHYSICS_TUNING,
    };
    expect(sanitizeRenderSettings(valid)).toEqual(valid); // every value a ladder member
  });

  test("supports settings are GONE (chains-primary, 2026-09-30): stale keys silently drop", () => {
    // Supports edges were retired; showSupports/supportsWidth no longer
    // exist. A legacy file carrying them loads without the keys — the
    // sanitizer drops unknown fields by construction.
    const cleaned = sanitizeRenderSettings({ showSupports: false, supportsWidth: 0.9 } as never);
    expect("showSupports" in cleaned).toBe(false);
    expect("supportsWidth" in cleaned).toBe(false);
  });

  test("the pre-2026-09-13 stored shape (flat, no regions/physics) still loads", () => {
    // data/render-settings.json on disk predates the nested sections —
    // those loads must get defaults, not crash, not shift anything.
    // It also predates sizeUnits — the sizes reset (below), the flat
    // fields keep their stored values (snapped to the nearest stop).
    const s = sanitizeRenderSettings({
      nodeSize: 4,
      edgeWidth: 1,
      arrowLength: 5,
      labelZoom: 0.5,
      clusterLabels: true,
    });
    expect(s.regions).toEqual(DEFAULT_REGION_TUNING);
    expect(s.physics).toEqual(DEFAULT_PHYSICS_TUNING);
    expect(s.nodeSize).toBe(DEFAULT_RENDER_SETTINGS.nodeSize); // legacy sizes reset
    expect(s.edgeWidth).toBe(1);
    expect(s.labelZoom).toBe(0.5); // 0.5 IS the dead-center stop now (owner, 2026-10-07)
  });

  test("the 2026-09-15 world-unit pivot: legacy files reset ONLY the size fields", () => {
    // Pre-pivot files stored sizes as "screen px at fit zoom" — a unit
    // whose meaning depended on the graph's own extent. Those values
    // cannot be carried into world units honestly → reset; everything
    // whose semantics did NOT change keeps its stored value.
    const s = sanitizeRenderSettings({
      nodeSize: 2,
      labelSize: 2,
      arrowLength: 2,
      edgeWidth: 3,
      labelZoom: 0.75,
      clusterLabelSize: 21,
      regions: { dilation: 28, blur: 8.1, bitmap: 512, edgeAlpha: 0.6, enabled: false },
      physics: { linkStrength: 2 },
    });
    expect(s.sizeUnits).toBe("world"); // the sanitizer always stamps
    expect(s.nodeSize).toBe(DEFAULT_RENDER_SETTINGS.nodeSize);
    expect(s.labelSize).toBe(DEFAULT_RENDER_SETTINGS.labelSize);
    expect(s.arrowLength).toBe(DEFAULT_RENDER_SETTINGS.arrowLength);
    expect(s.regions.dilation).toBe(DEFAULT_REGION_TUNING.dilation);
    // Unchanged semantics survive — snapped to the ladder:
    expect(s.edgeWidth).toBe(3);
    expect(s.labelZoom).toBe(0.75);
    expect(s.clusterLabelSize).toBe(20); // 21 snaps to 20
    expect(s.regions.blur).toBe(10); // 8.1 snaps to the new floor (owner, 2026-10-07)
    expect(s.regions.bitmap).toBe(512);
    expect(s.regions.edgeAlpha).toBe(0.6);
    expect(s.regions.enabled).toBe(false);
    expect(s.physics.linkStrength).toBe(2);
  });

  test("a stamped world-unit file keeps its size values", () => {
    const s = sanitizeRenderSettings({
      sizeUnits: "world",
      nodeSize: 6,
      arrowLength: 8,
      labelSize: 3,
    });
    expect(s.nodeSize).toBe(6);
    expect(s.arrowLength).toBe(8);
    expect(s.labelSize).toBe(3);
  });

  test("the 2026-09-17 defaults are the user's live-tuned bake", () => {
    // nodeSize 2, edgeWidth 1, arrowLength 2, labelSize 3, labelZoom
    // 0.5 (displays 1×), dilation 20, blur 40, edgeAlpha 0.2, bitmap
    // 256 — each dead-center on its re-centered ladder (owner, 2026-10-07).
    expect(DEFAULT_RENDER_SETTINGS.nodeSize).toBe(2);
    expect(DEFAULT_RENDER_SETTINGS.edgeWidth).toBe(1);
    expect(DEFAULT_RENDER_SETTINGS.arrowLength).toBe(2);
    expect(DEFAULT_RENDER_SETTINGS.labelSize).toBe(3);
    expect(DEFAULT_RENDER_SETTINGS.labelZoom).toBe(0.5); // displays 1× (owner, 2026-10-07)
    expect(DEFAULT_REGION_TUNING.dilation).toBe(20);
    expect(DEFAULT_REGION_TUNING.blur).toBe(40); // new default (owner, 2026-10-07)
    expect(DEFAULT_REGION_TUNING.edgeAlpha).toBe(0.2);
    expect(DEFAULT_REGION_TUNING.bitmap).toBe(256);
  });

  test("nested sections sanitize: garbage snaps inside them without touching the rest", () => {
    const s = sanitizeRenderSettings({
      sizeUnits: "world",
      nodeSize: 3,
      regions: { blur: -5, bitmap: 999, edgeAlpha: 9 },
      physics: { linkStrength: 99, gravity: 7, depthMode: "sideways" },
    });
    expect(s.nodeSize).toBe(3);
    expect(s.regions.blur).toBe(REGION_BLUR_LADDER[0]); // snapped to the ladder floor
    expect(s.regions.bitmap).toBe(512); // snaps to the nearest fixed option
    expect(s.regions.edgeAlpha).toBe(1); // snapped to the ladder top
    expect(s.regions.dilation).toBe(DEFAULT_REGION_TUNING.dilation);
    expect(s.physics.linkStrength).toBe(4); // sweep-validated cap
    expect(s.physics.gravity).toBe(0.48);
    expect(s.physics.depthMode).toBe("off"); // unknown mode → off
    expect(s.physics.chargeStrength).toBe(DEFAULT_PHYSICS_TUNING.chargeStrength);
  });

  test("the pre-wave stored shape (no labelSize) still loads", () => {
    // localStorage-era records lacked labelSize — must not shift anything.
    const s = sanitizeRenderSettings({
      sizeUnits: "world",
      nodeSize: 4,
      edgeWidth: 1,
      arrowLength: 5,
      labelZoom: 0.5,
      clusterLabels: true,
    });
    expect(s.labelSize).toBe(DEFAULT_RENDER_SETTINGS.labelSize);
    expect(s.nodeSize).toBe(4);
    expect(s.labelZoom).toBe(0.5); // 0.5 IS the dead-center stop now
  });
});

describe("ladder mapping (11 stops, default-centered)", () => {
  const LADDERS: [string, readonly number[], number][] = [
    ["nodeSize", NODE_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.nodeSize],
    ["edgeWidth", EDGE_WIDTH_LADDER, DEFAULT_RENDER_SETTINGS.edgeWidth],
    ["arrowLength", ARROW_LENGTH_LADDER, DEFAULT_RENDER_SETTINGS.arrowLength],
    ["labelSize", LABEL_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.labelSize],
    ["labelZoom", LABEL_ZOOM_LADDER, DEFAULT_RENDER_SETTINGS.labelZoom],
    ["clusterLabelSize", CLUSTER_LABEL_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.clusterLabelSize],
    ["regions.dilation", REGION_DILATION_LADDER, DEFAULT_REGION_TUNING.dilation],
    ["regions.blur", REGION_BLUR_LADDER, DEFAULT_REGION_TUNING.blur],
    ["regions.edgeAlpha", REGION_EDGE_ALPHA_LADDER, DEFAULT_REGION_TUNING.edgeAlpha],
  ];

  // The dead-center law is restored (owner, 2026-10-07 round 2): the
  // ladders themselves were re-centered so the new defaults — labelZoom
  // 0.5 (displays 1×) and regions.blur 40 — sit at stop #5 again.
  test("every ladder has 11 stops; every default is stop #5 (dead-center)", () => {
    for (const [_name, ladder, dflt] of LADDERS) {
      expect(ladder.length).toBe(11);
      expect(ladder[5]).toBe(dflt); // default at index 5 → position 50
    }
  });

  test("every value is a nice number (clean decimal, no float artifacts)", () => {
    // The worst-case granularity across all ladders is 1/40 (the
    // edge-alpha floor 0.025); everything else is eighths, quarters,
    // halves, or integers. Nothing like 2.18137...977 can ever persist.
    for (const [_name, ladder] of LADDERS) {
      for (const v of ladder) {
        expect(Number.isInteger(v * 40)).toBeTruthy();
        expect(String(v)).toBe(`${+v.toFixed(3)}`);
      }
    }
  });

  test("round-trips: positions 0-100 step 10 hit every stop and back", () => {
    for (const [_name, ladder] of LADDERS) {
      for (let i = 0; i < ladder.length; i++) {
        const p = i * 10;
        const stop = ladder[i] as number;
        expect(fromLadderPosition(p, ladder)).toBe(stop);
        expect(toLadderPosition(stop, ladder)).toBe(p);
      }
    }
  });

  test("off-ladder positions snap to the nearest stop; extremes clamp", () => {
    for (const [_name, ladder] of LADDERS) {
      expect(fromLadderPosition(-20, ladder)).toBe(ladder[0]);
      expect(fromLadderPosition(120, ladder)).toBe(ladder[ladder.length - 1]);
      // Round-half-up at the 55 midpoint (JS Math.round), so 54 → stop 5
      // and 58 → stop 6 — the slider readout never shows a non-member.
      expect(fromLadderPosition(54, ladder)).toBe(ladder[5]);
      expect(fromLadderPosition(58, ladder)).toBe(ladder[6]);
    }
  });

  test("display units are absolute (ratio / 0.5): 8× is the tuned default", () => {
    expect(labelZoomDisplay(0.5)).toBe("1×");
    expect(labelZoomDisplay(4)).toBe("8×"); // plain math (ratio/0.5) — 4 was the old default, 0.5 is the new one
    expect(labelZoomDisplay(0.75)).toBe("1.5×");
    expect(labelZoomDisplay(24)).toBe("48×");
    expect(labelZoomDisplay(0.25)).toBe("0.5×");
    expect(labelZoomDisplay(0.0625)).toBe("0.13×"); // rounded to 2 decimals
  });
});

describe("physics sliders (fine-grained log, unchanged 2026-09-17)", () => {
  test("every region/physics default sits dead-center at position 50", () => {
    // Physics keeps the log-slider law: default = geometric mean of the
    // range ends (repulsion maps |charge|; friction tolerates the
    // sub-0.5° drift).
    const pairs: [number, number, number][] = [
      [-CHARGE_RANGE.max, -CHARGE_RANGE.min, -DEFAULT_PHYSICS_TUNING.chargeStrength],
      [LINK_STRENGTH_RANGE.min, LINK_STRENGTH_RANGE.max, DEFAULT_PHYSICS_TUNING.linkStrength],
      [LINK_DISTANCE_RANGE.min, LINK_DISTANCE_RANGE.max, DEFAULT_PHYSICS_TUNING.linkDistance],
      [GRAVITY_RANGE.min, GRAVITY_RANGE.max, DEFAULT_PHYSICS_TUNING.gravity],
      [VELOCITY_DECAY_RANGE.min, VELOCITY_DECAY_RANGE.max, DEFAULT_PHYSICS_TUNING.velocityDecay],
      [DEPTH_STRENGTH_RANGE.min, DEPTH_STRENGTH_RANGE.max, DEFAULT_PHYSICS_TUNING.depthStrength],
      [DEPTH_SPACING_RANGE.min, DEPTH_SPACING_RANGE.max, DEFAULT_PHYSICS_TUNING.depthSpacing],
      [
        DEPTH_BASE_RADIUS_RANGE.min,
        DEPTH_BASE_RADIUS_RANGE.max,
        DEFAULT_PHYSICS_TUNING.depthBaseRadius,
      ],
    ];
    for (const [min, max, d] of pairs) {
      expect(Math.abs(toSliderPosition(d, min, max) - 50) < 0.6).toBeTruthy();
    }
    // Off-zone fields: the default sits at 50 INSIDE the on-part.
    expect(
      Math.abs(
        toOffSliderPosition(
          DEFAULT_PHYSICS_TUNING.clusterPull,
          CLUSTER_PULL_RANGE.min,
          CLUSTER_PULL_RANGE.max,
        ) - 50,
      ) < 0.6,
    ).toBeTruthy();
  });

  test("the 2026-09-17 charge bump: default −240, dead-center", () => {
    // User: "repulsion default too weak". −240 is the gm of [120, 480] —
    // the range stays inside the sweep-validated [30, 480].
    expect(DEFAULT_PHYSICS_TUNING.chargeStrength).toBe(-240);
    expect(Math.abs(toSliderPosition(240, 120, 480) - 50) < 1e-9).toBeTruthy();
  });

  test("off-slider mapping: position 0 ↔ value 0; the log part round-trips", () => {
    expect(toOffSliderPosition(0, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max)).toBe(0);
    expect(fromOffSliderPosition(0, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max)).toBe(0);
    const v = fromOffSliderPosition(
      toOffSliderPosition(0.15, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max),
      CLUSTER_PULL_RANGE.min,
      CLUSTER_PULL_RANGE.max,
    );
    expect(Math.abs(v - 0.15) < 1e-9).toBeTruthy();
    // One step in (position 5) sits just above the log floor:
    // min * (max/min)^(5/100), NOT the floor itself (that's position 0,
    // the off zone).
    const stepIn =
      CLUSTER_PULL_RANGE.min * (CLUSTER_PULL_RANGE.max / CLUSTER_PULL_RANGE.min) ** (5 / 100);
    expect(
      Math.abs(fromOffSliderPosition(5, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max) - stepIn) <
        1e-9,
    ).toBeTruthy();
  });

  test("blur is WORLD units (2026-09-15): free values, snapped to the ladder", () => {
    // The bitmap-px era ended: the old reach scaled with the graph's
    // span, so a value tuned on a big graph read far too sharp on a
    // small one. It's a canonical world reach now — any stored value
    // snaps to the nearest stop.
    expect(DEFAULT_REGION_TUNING.blur).toBe(40); // new default (owner, 2026-10-07)
    expect(sanitizeRegionTuning({ blur: 3.7 }).blur).toBe(10); // the new floor
    expect(sanitizeRegionTuning({ blur: 7.2 }).blur).toBe(10);
    expect(sanitizeRegionTuning({ blur: -5 }).blur).toBe(REGION_BLUR_LADDER[0]);
    expect(sanitizeRegionTuning({ blur: 999 }).blur).toBe(
      REGION_BLUR_LADDER[REGION_BLUR_LADDER.length - 1],
    );
    expect(sanitizeRegionTuning({ blur: 99 }).blur).toBe(100); // inside the span → nearest stop, not the top
    // Stored blur 0 (the old off zone) snaps back into the ladder.
    expect(sanitizeRegionTuning({ blur: 0 }).blur).toBe(REGION_BLUR_LADDER[0]);
  });

  test("enabled is the compute off switch: only an explicit false turns it off", () => {
    // Default on; old persisted files predate the field (missing → on);
    // garbage falls back to on (fail toward the tuned look).
    expect(DEFAULT_REGION_TUNING.enabled).toBe(true);
    expect(sanitizeRegionTuning({}).enabled).toBe(true);
    expect(sanitizeRegionTuning({ enabled: false }).enabled).toBe(false);
    expect(sanitizeRegionTuning({ enabled: true }).enabled).toBe(true);
    expect(sanitizeRegionTuning({ enabled: "no" as unknown as boolean }).enabled).toBe(true);
    // An explicit false survives even alongside garbage in other fields.
    expect(sanitizeRegionTuning({ enabled: false, blur: 99, bitmap: 99999 }).enabled).toBe(false);
  });
});
