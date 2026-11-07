// Ported from learnharness (AGPL-3.0-only) components/graph-view.tsx @ c549494.
/**
 * The home knowledge-graph view. ./graph-canvas.ts draws on one Canvas 2D with one rAF loop and a
 * dirty flag, so it draws no frame while idle. This component fetches the snapshot, runs the
 * fallback layout, resolves theme colours to hex and feeds the renderer data, settings and visibility.
 */

import {
  type CSSProperties,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  GaugeIcon,
  ListTreeIcon,
  RepeatIcon,
  SearchIcon,
  SettingsIcon,
  UploadIcon,
  WaypointsIcon,
} from "lucide-react";
import type { LearnReviewSummary } from "@t3tools/contracts";
import { incrementalLayout, type GraphNode, type GraphSnapshot } from "@t3tools/learn/graph";
import { Alert, AlertDescription, AlertAction } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useStartLearnSession } from "../startSession";
import { ChainTableOverlay } from "./chain-table.tsx";
import { useLearnGraphData } from "./data";
import { DeleteSourceDialog } from "./DeleteSourceDialog";
import { GraphCanvasRenderer, type GraphCamera, type GraphRenderSettings } from "./graph-canvas.ts";
import { NodeCard } from "./NodeCard";
import {
  ARROW_LENGTH_LADDER,
  CHARGE_RANGE,
  CLUSTER_LABEL_SIZE_LADDER,
  CLUSTER_PULL_RANGE,
  DEPTH_BASE_RADIUS_RANGE,
  DEPTH_SPACING_RANGE,
  DEPTH_STRENGTH_RANGE,
  DEFAULT_RENDER_SETTINGS,
  EDGE_WIDTH_LADDER,
  GRAVITY_RANGE,
  LABEL_SIZE_LADDER,
  LABEL_ZOOM_LADDER,
  LINK_DISTANCE_RANGE,
  LINK_STRENGTH_RANGE,
  NODE_SIZE_LADDER,
  REGION_BITMAP_OPTIONS,
  REGION_BLUR_LADDER,
  fromLadderPosition,
  toLadderPosition,
  REGION_DILATION_LADDER,
  REGION_EDGE_ALPHA_LADDER,
  VELOCITY_DECAY_RANGE,
  fromOffSliderPosition,
  fromSliderPosition,
  labelZoomDisplay,
  sanitizeRenderSettings,
  toOffSliderPosition,
  toSliderPosition,
} from "./render-settings.ts";
import { selectionContext, useGraphSelectionStore } from "./selection";

/** The uniform node look (no state classes — canvas wants hex, not oklch):
 *  the accent color, until the state model lands. */
const NODE_COLOR_TOKEN = "--foreground";

/** Per-device graph camera persistence (zoom+pan view state). v1 in the
 *  key: the stored shape is the renderer's d3 transform {k, x, y}. */
const CAMERA_STORAGE_KEY = "lh.graph.camera.v1";

// Shape, defaults, sanitizer and slider mappings live in core/render-settings.ts.

type RenderSettings = GraphRenderSettings;

/**
 * Pure filter predicate for the search panel: a node is visible when the
 * query is empty or matches its name or statement (case-insensitive).
 * Exported for tests; the visibility feed just consumes its verdict.
 */
export function isNodeVisible(node: Pick<GraphNode, "name" | "statement">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return node.name.toLowerCase().includes(q) || node.statement.toLowerCase().includes(q);
}

/** Places nodes the ledger lacks on a deterministic ring around the known centroid (angle from
 *  an FNV-1a hash of the id, golden-angle offset), so they never pile at the origin. Mutates the map. */
function seedMissingNodePositions(
  nodes: readonly { id: string }[],
  positions: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
  if (positions.size === 0 || nodes.every((n) => positions.has(n.id))) return positions;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of positions.values()) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const radius = Math.max(maxX - minX, maxY - minY, 40) * 0.7 + 20;
  const missing = nodes.filter((n) => !positions.has(n.id));
  missing.forEach((n, i) => {
    // FNV-1a hash → [0,1) → angle; the golden-angle spiral offset
    // both spreads collisions and staggers long paths deterministically.
    let h = 0x811c9dc5;
    for (let c = 0; c < n.id.length; c++) {
      h ^= n.id.charCodeAt(c);
      h = (h * 0x01000193) >>> 0;
    }
    const angle = ((h / 0xffffffff) * 2 * Math.PI + i * 2.39996323) % (2 * Math.PI);
    positions.set(n.id, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
  });
  return positions;
}

/** Resolve a CSS variable (oklch in this app) to #rrggbb via the canvas. */
function cssColorToHex(css: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "#888888";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const { data } = ctx.getImageData(0, 0, 1, 1);
  return `#${[data[0]!, data[1]!, data[2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function tokenHex(cssVar: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  return value ? cssColorToHex(value) : "#888888";
}

interface Selection {
  node: GraphNode;
  /** The sources that touched this node: chat ids (deep-linkable sessions)
   *  and notes-source ids ("src_…" — imported files, static entries). */
  sourceIds: readonly string[];
  /** Node position in container pixels (at click time; camera moves
   *  dismiss the card, so it never needs re-anchoring). */
  anchor: { x: number; y: number };
}

/** One labeled range row for the rendering-settings panel. */
/** Compact size display for the log sliders: "2", "1.6", "0.75". */
function sizeDisplay(v: number): string {
  return `${v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100}`;
}

function SettingSlider({
  label,
  min,
  max,
  step,
  value,
  display,
  onChange,
  disabled,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** Value display override (e.g. "1.5×" for zoom) — defaults to the raw number. */
  display?: string;
  onChange: (v: number) => void;
  /** Dependency graying (user 2026-09-17): children dim + lock when
   *  their parent toggle/mode is off — consistently across sections. */
  disabled?: boolean;
}) {
  return (
    <label className={`flex flex-col${disabled ? " opacity-40" : ""}`}>
      <span className="flex items-center justify-between text-xs">
        {label}
        <span className="text-muted-foreground tabular-nums">{display ?? value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="settings-slider h-8 w-full sm:h-7"
        style={
          {
            "--settings-slider-progress": `${((value - min) / (max - min)) * 100}%`,
          } as CSSProperties
        }
      />
    </label>
  );
}

/**
 * The rendering-settings gear + its collapsible panel (owner, graph-view
 * round 2): its own container at the top right, separate from the search
 * box and the import button — clicking the gear expands/collapses the
 * panel, which drops below the button, right-aligned with it.
 */
function GraphSettingsControl({
  settings,
  changeSettings,
}: {
  settings: GraphRenderSettings;
  changeSettings: (update: (cur: RenderSettings) => RenderSettings) => void;
}) {
  const regionTuning = settings.regions;
  const physicsTuning = settings.physics;
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Graph display settings"
                  data-testid="graph-settings"
                />
              }
            />
          }
        >
          <SettingsIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Graph display settings</TooltipPopup>
      </Tooltip>
      {/* It stays below the gear; the viewport caps the height and scrolls. */}
      <PopoverPopup
        align="end"
        collisionPadding={12}
        collisionAvoidance={{ side: "none" }}
        padding="compact"
        className="w-72"
      >
        <div className="flex flex-col gap-2">
          {/* Size/zoom/region sliders: LADDER-mapped 0-100, step 10 (11
							    stops, every DEFAULT dead-center at 50, every value a nice
							    number — src/core/render-settings.ts). Physics keeps the
							    fine-grained log sliders (step 5). */}
          <SettingSlider
            label="Node size"
            min={0}
            max={100}
            step={10}
            value={toLadderPosition(settings.nodeSize, NODE_SIZE_LADDER)}
            display={sizeDisplay(settings.nodeSize)}
            onChange={(p) =>
              changeSettings((cur) => ({
                ...cur,
                nodeSize: fromLadderPosition(p, NODE_SIZE_LADDER),
              }))
            }
          />
          <SettingSlider
            label="Edge width"
            min={0}
            max={100}
            step={10}
            value={toLadderPosition(settings.edgeWidth, EDGE_WIDTH_LADDER)}
            display={sizeDisplay(settings.edgeWidth)}
            onChange={(p) =>
              changeSettings((cur) => ({
                ...cur,
                edgeWidth: fromLadderPosition(p, EDGE_WIDTH_LADDER),
              }))
            }
          />
          <SettingSlider
            label="Arrowhead size"
            min={0}
            max={100}
            step={10}
            value={toLadderPosition(settings.arrowLength, ARROW_LENGTH_LADDER)}
            display={sizeDisplay(settings.arrowLength)}
            onChange={(p) =>
              changeSettings((cur) => ({
                ...cur,
                arrowLength: fromLadderPosition(p, ARROW_LENGTH_LADDER),
              }))
            }
          />
          <SettingSlider
            label="Label size"
            min={0}
            max={100}
            step={10}
            value={toLadderPosition(settings.labelSize, LABEL_SIZE_LADDER)}
            display={sizeDisplay(settings.labelSize)}
            onChange={(p) =>
              changeSettings((cur) => ({
                ...cur,
                labelSize: fromLadderPosition(p, LABEL_SIZE_LADDER),
              }))
            }
          />
          {/* Display is absolute (ratio / 0.5): "1×" is the default, dead-center (owner, 2026-10-07). */}
          <SettingSlider
            label="Labels until zoom"
            min={0}
            max={100}
            step={10}
            value={toLadderPosition(settings.labelZoom, LABEL_ZOOM_LADDER)}
            display={labelZoomDisplay(settings.labelZoom)}
            onChange={(p) =>
              changeSettings((cur) => ({
                ...cur,
                labelZoom: fromLadderPosition(p, LABEL_ZOOM_LADDER),
              }))
            }
          />
          {/* Regions are the blurred cluster tints. Their switch skips the whole build (splat, blur,
             readback, blit), not only the paint. */}
          <div className="mt-2 flex flex-col gap-2 border-t pt-2">
            <span className="text-xs font-medium text-foreground">Regions</span>
            <label className="flex min-h-8 cursor-pointer items-center sm:min-h-7 justify-between text-xs">
              <span>Background colors</span>
              <Checkbox
                checked={settings.regions.enabled}
                onCheckedChange={(checked) =>
                  changeSettings((cur) => ({
                    ...cur,
                    regions: { ...cur.regions, enabled: checked },
                  }))
                }
              />
            </label>
            <SettingSlider
              label="Dilation"
              disabled={!regionTuning.enabled}
              min={0}
              max={100}
              step={10}
              value={toLadderPosition(regionTuning.dilation, REGION_DILATION_LADDER)}
              display={sizeDisplay(regionTuning.dilation)}
              onChange={(p) =>
                changeSettings((cur) => ({
                  ...cur,
                  regions: {
                    ...cur.regions,
                    dilation: fromLadderPosition(p, REGION_DILATION_LADDER),
                  },
                }))
              }
            />
            <SettingSlider
              label="Blur"
              disabled={!regionTuning.enabled}
              min={0}
              max={100}
              step={10}
              value={toLadderPosition(regionTuning.blur, REGION_BLUR_LADDER)}
              display={sizeDisplay(regionTuning.blur)}
              onChange={(p) =>
                changeSettings((cur) => ({
                  ...cur,
                  regions: { ...cur.regions, blur: fromLadderPosition(p, REGION_BLUR_LADDER) },
                }))
              }
            />
            <SettingSlider
              label="Edge alpha"
              disabled={!regionTuning.enabled}
              min={0}
              max={100}
              step={10}
              value={toLadderPosition(regionTuning.edgeAlpha, REGION_EDGE_ALPHA_LADDER)}
              display={sizeDisplay(regionTuning.edgeAlpha)}
              onChange={(p) =>
                changeSettings((cur) => ({
                  ...cur,
                  regions: {
                    ...cur.regions,
                    edgeAlpha: fromLadderPosition(p, REGION_EDGE_ALPHA_LADDER),
                  },
                }))
              }
            />
            <label
              className={`flex items-center justify-between gap-2 text-xs${!regionTuning.enabled ? " opacity-40" : ""}`}
            >
              <span>Bitmap resolution</span>
              <Select
                disabled={!regionTuning.enabled}
                value={regionTuning.bitmap}
                onValueChange={(value) =>
                  changeSettings((cur) => ({
                    ...cur,
                    regions: { ...cur.regions, bitmap: Number(value) },
                  }))
                }
              >
                <SelectTrigger size="compact" className="w-20 min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {REGION_BITMAP_OPTIONS.map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            {/* Cluster labels follow their own toggle, not Background colors; size is screen px. */}
            <label className="flex min-h-8 cursor-pointer items-center sm:min-h-7 justify-between text-xs">
              <span>Cluster labels</span>
              <Checkbox
                checked={settings.clusterLabels}
                onCheckedChange={(checked) =>
                  changeSettings((cur) => ({ ...cur, clusterLabels: checked }))
                }
              />
            </label>
            <SettingSlider
              label="Cluster label size"
              disabled={!settings.clusterLabels}
              min={0}
              max={100}
              step={10}
              value={toLadderPosition(settings.clusterLabelSize, CLUSTER_LABEL_SIZE_LADDER)}
              display={sizeDisplay(settings.clusterLabelSize)}
              onChange={(p) =>
                changeSettings((cur) => ({
                  ...cur,
                  clusterLabelSize: fromLadderPosition(p, CLUSTER_LABEL_SIZE_LADDER),
                }))
              }
            />
          </div>
          {/* Physics feeds the same engine as the server settle. A change rebuilds the sim from the
             current positions, so pins survive; cluster pull's far left is off. */}
          <div className="mt-2 flex flex-col gap-2 border-t pt-2">
            <span className="text-xs font-medium text-foreground">Physics</span>
            <SettingSlider
              label="Node repulsion"
              min={0}
              max={100}
              step={5}
              value={toSliderPosition(
                -physicsTuning.chargeStrength,
                -CHARGE_RANGE.max,
                -CHARGE_RANGE.min,
              )}
              display={`\u2212${Math.round(-physicsTuning.chargeStrength)}`}
              onChange={(p) =>
                changeSettings((cur) => ({
                  ...cur,
                  physics: {
                    ...cur.physics,
                    chargeStrength: -fromSliderPosition(p, -CHARGE_RANGE.max, -CHARGE_RANGE.min),
                  },
                }))
              }
            />
            <SettingSlider
              label="Edge attraction"
              min={0}
              max={100}
              step={5}
              value={toSliderPosition(
                physicsTuning.linkStrength,
                LINK_STRENGTH_RANGE.min,
                LINK_STRENGTH_RANGE.max,
              )}
              display={sizeDisplay(physicsTuning.linkStrength)}
              onChange={(p) =>
                changeSettings((cur) => ({
                  ...cur,
                  physics: {
                    ...cur.physics,
                    linkStrength: fromSliderPosition(
                      p,
                      LINK_STRENGTH_RANGE.min,
                      LINK_STRENGTH_RANGE.max,
                    ),
                  },
                }))
              }
            />
            <SettingSlider
              label="Edge length"
              min={0}
              max={100}
              step={5}
              value={toSliderPosition(
                physicsTuning.linkDistance,
                LINK_DISTANCE_RANGE.min,
                LINK_DISTANCE_RANGE.max,
              )}
              display={sizeDisplay(physicsTuning.linkDistance)}
              onChange={(p) =>
                changeSettings((cur) => ({
                  ...cur,
                  physics: {
                    ...cur.physics,
                    linkDistance: fromSliderPosition(
                      p,
                      LINK_DISTANCE_RANGE.min,
                      LINK_DISTANCE_RANGE.max,
                    ),
                  },
                }))
              }
            />
            <SettingSlider
              label="Central pull"
              min={0}
              max={100}
              step={5}
              value={toSliderPosition(physicsTuning.gravity, GRAVITY_RANGE.min, GRAVITY_RANGE.max)}
              display={sizeDisplay(physicsTuning.gravity)}
              onChange={(p) =>
                changeSettings((cur) => ({
                  ...cur,
                  physics: {
                    ...cur.physics,
                    gravity: fromSliderPosition(p, GRAVITY_RANGE.min, GRAVITY_RANGE.max),
                  },
                }))
              }
            />
            <SettingSlider
              label="Cluster pull"
              min={0}
              max={100}
              step={5}
              value={toOffSliderPosition(
                physicsTuning.clusterPull,
                CLUSTER_PULL_RANGE.min,
                CLUSTER_PULL_RANGE.max,
              )}
              display={
                physicsTuning.clusterPull <= 0 ? "off" : sizeDisplay(physicsTuning.clusterPull)
              }
              onChange={(p) =>
                changeSettings((cur) => ({
                  ...cur,
                  physics: {
                    ...cur.physics,
                    clusterPull: fromOffSliderPosition(
                      p,
                      CLUSTER_PULL_RANGE.min,
                      CLUSTER_PULL_RANGE.max,
                    ),
                  },
                }))
              }
            />
            <SettingSlider
              label="Friction"
              min={0}
              max={100}
              step={5}
              value={toSliderPosition(
                physicsTuning.velocityDecay,
                VELOCITY_DECAY_RANGE.min,
                VELOCITY_DECAY_RANGE.max,
              )}
              display={sizeDisplay(physicsTuning.velocityDecay)}
              onChange={(p) =>
                changeSettings((cur) => ({
                  ...cur,
                  physics: {
                    ...cur.physics,
                    velocityDecay: fromSliderPosition(
                      p,
                      VELOCITY_DECAY_RANGE.min,
                      VELOCITY_DECAY_RANGE.max,
                    ),
                  },
                }))
              }
            />
            {/* Depth anchor LAST (user 2026-09-17): general
							    forces first, then the mode + its conditional
							    controls at the very bottom — the grayed group reads
							    as a self-contained sub-section. */}
            <label className="flex items-center justify-between gap-2 text-xs">
              Depth anchor
              <Select
                value={physicsTuning.depthMode}
                onValueChange={(value) =>
                  changeSettings((cur) => ({
                    ...cur,
                    physics: { ...cur.physics, depthMode: value ?? cur.physics.depthMode },
                  }))
                }
              >
                <SelectTrigger size="compact" className="w-36 min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="vertical">Vertical (up)</SelectItem>
                  <SelectItem value="radial">Radial (outward)</SelectItem>
                </SelectPopup>
              </Select>
            </label>
            <SettingSlider
              label="Depth strength"
              disabled={physicsTuning.depthMode === "off"}
              min={0}
              max={100}
              step={5}
              value={toSliderPosition(
                physicsTuning.depthStrength,
                DEPTH_STRENGTH_RANGE.min,
                DEPTH_STRENGTH_RANGE.max,
              )}
              display={sizeDisplay(physicsTuning.depthStrength)}
              onChange={(p) =>
                changeSettings((cur) => ({
                  ...cur,
                  physics: {
                    ...cur.physics,
                    depthStrength: fromSliderPosition(
                      p,
                      DEPTH_STRENGTH_RANGE.min,
                      DEPTH_STRENGTH_RANGE.max,
                    ),
                  },
                }))
              }
            />
            <SettingSlider
              label="Depth spacing"
              disabled={physicsTuning.depthMode === "off"}
              min={0}
              max={100}
              step={5}
              value={toSliderPosition(
                physicsTuning.depthSpacing,
                DEPTH_SPACING_RANGE.min,
                DEPTH_SPACING_RANGE.max,
              )}
              display={sizeDisplay(physicsTuning.depthSpacing)}
              onChange={(p) =>
                changeSettings((cur) => ({
                  ...cur,
                  physics: {
                    ...cur.physics,
                    depthSpacing: fromSliderPosition(
                      p,
                      DEPTH_SPACING_RANGE.min,
                      DEPTH_SPACING_RANGE.max,
                    ),
                  },
                }))
              }
            />
            <SettingSlider
              label="Base ring radius"
              disabled={physicsTuning.depthMode !== "radial"}
              min={0}
              max={100}
              step={5}
              value={toSliderPosition(
                physicsTuning.depthBaseRadius,
                DEPTH_BASE_RADIUS_RANGE.min,
                DEPTH_BASE_RADIUS_RANGE.max,
              )}
              display={sizeDisplay(physicsTuning.depthBaseRadius)}
              onChange={(p) =>
                changeSettings((cur) => ({
                  ...cur,
                  physics: {
                    ...cur.physics,
                    depthBaseRadius: fromSliderPosition(
                      p,
                      DEPTH_BASE_RADIUS_RANGE.min,
                      DEPTH_BASE_RADIUS_RANGE.max,
                    ),
                  },
                }))
              }
            />
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Confidence bands against accuracy over every graded answer. */
function CalibrationControl({ buckets }: { buckets: LearnReviewSummary["calibration"] }) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Calibration"
                  data-testid="graph-calibration"
                />
              }
            />
          }
        >
          <GaugeIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Confidence against accuracy</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" collisionPadding={12} padding="compact" className="w-56">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-left">
              <th className="pb-1 font-medium">Confidence</th>
              <th className="pb-1 text-right font-medium">Answers</th>
              <th className="pb-1 text-right font-medium">Correct</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.from} className="border-t border-border/60">
                <td className="py-1">
                  {bucket.from}–{bucket.to}%
                </td>
                <td className="py-1 text-right">{bucket.answers}</td>
                <td className="py-1 text-right">
                  {bucket.answers === 0
                    ? "–"
                    : `${Math.round((100 * bucket.correct) / bucket.answers)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </PopoverPopup>
    </Popover>
  );
}

/** Import Notes always shows, since it works on an empty graph; search, chains and settings
 *  show only when the snapshot has nodes. */
function GraphChromeRow({
  isEmpty,
  query,
  onQuery,
  noMatch,
  importing,
  searchInputRef,
  fileInputRef,
  onImportFiles,
  settings,
  changeSettings,
  onOpenChains,
  dueCount,
  onReview,
  calibration,
}: {
  isEmpty: boolean;
  query: string;
  onQuery: (v: string) => void;
  /** The search panel's "No matching nodes." note (computed by the
   *  wrapper — it owns visibleIds + the snapshot). */
  noMatch: boolean;
  importing: boolean;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onImportFiles: (files: FileList | null) => void;
  settings: GraphRenderSettings;
  changeSettings: (update: (cur: RenderSettings) => RenderSettings) => void;
  /** Opens the chain table overlay (the chains-overlay plan,
   *  2026-09-29). */
  onOpenChains: () => void;
  dueCount: number;
  onReview: () => void;
  calibration: LearnReviewSummary["calibration"];
}) {
  return (
    <>
      {!isEmpty && dueCount > 0 && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                onClick={onReview}
                data-testid="graph-review"
                aria-label={`Review ${dueCount}`}
                className="shrink-0"
              />
            }
          >
            <RepeatIcon className="size-3.5" />
            <span className="max-sm:hidden">Review</span> {dueCount}
          </TooltipTrigger>
          <TooltipPopup side="bottom">Practice the propositions due for review</TooltipPopup>
        </Tooltip>
      )}
      {!isEmpty && (
        <div className="w-56 min-w-0 shrink max-sm:w-auto max-sm:flex-1">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon className="size-3.5 text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchInputRef}
              size="sm"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search nodes…"
              aria-label="Search nodes"
              spellCheck={false}
            />
          </InputGroup>
          {noMatch && <div className="pt-1 text-xs text-muted-foreground">No matching nodes.</div>}
        </div>
      )}
      {!isEmpty && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenChains}
                data-testid="open-chain-table"
                aria-label="Chains"
                className="shrink-0"
              />
            }
          >
            <ListTreeIcon className="size-3.5" />
            <span className="max-sm:hidden">Chains</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">Every reasoning chain</TooltipPopup>
        </Tooltip>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".md,.markdown,.txt"
        className="hidden"
        onChange={(e) => {
          onImportFiles(e.target.files);
          e.target.value = ""; // allow re-picking the same file
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              disabled={importing}
              onClick={() => fileInputRef.current?.click()}
              data-testid="import-notes"
              aria-label="Import notes"
              className="shrink-0"
            />
          }
        >
          <UploadIcon className="size-3.5" />
          <span className="max-sm:hidden">{importing ? "Importing…" : "Import notes…"}</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">Import notes into the graph</TooltipPopup>
      </Tooltip>
      {!isEmpty && calibration.some((bucket) => bucket.answers > 0) && (
        <div className="shrink-0">
          <CalibrationControl buckets={calibration} />
        </div>
      )}
      {!isEmpty && (
        <div className="shrink-0">
          <GraphSettingsControl settings={settings} changeSettings={changeSettings} />
        </div>
      )}
    </>
  );
}

/** A review session practises the most overdue propositions first. */
const REVIEW_BATCH = 10;

/** Per-device render settings. learnharness persists them through a
 *  server route; this port has no counterpart in the learn endpoints. */
const SETTINGS_STORAGE_KEY = "lh.graph.render-settings.v1";

function loadSettings(): GraphRenderSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return stored ? sanitizeRenderSettings(JSON.parse(stored)) : DEFAULT_RENDER_SETTINGS;
  } catch {
    return DEFAULT_RENDER_SETTINGS;
  }
}

export function GraphView() {
  const data = useLearnGraphData();
  const snapshot = data.snapshot;
  const startSession = useStartLearnSession();
  const { nodeIds: selectionIds, contextText } = useGraphSelectionStore((state) => state.current);
  const setGraphSelection = useGraphSelectionStore((state) => state.set);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  // The latest snapshot for the renderer's click callbacks (they are
  // constructed once, so they read through this ref, never a closure).
  const snapshotRef = useRef<GraphSnapshot | null>(null);
  // oxlint-disable-next-line react/refs -- the renderer's once-built callbacks read the latest snapshot here
  snapshotRef.current = snapshot;
  const dataRef = useRef(data);
  // oxlint-disable-next-line react/refs -- the renderer's once-built callbacks read the latest data here
  dataRef.current = data;

  // Search panel state: the query text + the settings section toggle.
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Render settings: sizes AND the region/physics sections. Defaults
  // render until the stored copy loads; every user change saves back,
  // debounced.
  const [settings, setSettings] = useState<GraphRenderSettings>(loadSettings);
  // The two nested sections, unpacked for the renderer feed effects
  // below (same names the old session state had).
  const regionTuning = settings.regions;
  const physicsTuning = settings.physics;
  // True once the user has moved a control this mount: mounting alone
  // never writes defaults over the stored copy.
  const userTouched = useRef(false);
  const changeSettings = (update: (cur: RenderSettings) => RenderSettings) => {
    userTouched.current = true;
    setSettings(update);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounced write of user-changed settings to localStorage; the timer clears on change or unmount
  useEffect(() => {
    if (!userTouched.current) return;
    const id = setTimeout(() => {
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
      } catch {
        // Storage full/blocked: settings persistence is best-effort.
      }
    }, 400);
    return () => clearTimeout(id);
  }, [settings]);

  // The renderer instance lives across snapshot refetches and settings
  // changes (its camera is never reset by either); `posRef` carries the
  // frozen layout out of the layout effect.
  const rendererRef = useRef<GraphCanvasRenderer | null>(null);
  const posRef = useRef<Map<string, { x: number; y: number }> | null>(null);

  // The id set that survives the current search — consumed by the
  // visibility feed and the "no matches" hint.
  const visibleIds = new Set<string>();
  for (const node of snapshot?.nodes ?? []) {
    if (isNodeVisible(node, query)) visibleIds.add(node.id);
  }

  // The chain table overlay (chains-overlay plan, 2026-09-29) —
  // component-local: a browsing surface, not graph state.
  const [chainsOpen, setChainsOpen] = useState(false);
  // The source whose "delete from the graph" dialog is open.
  const [deletingSource, setDeletingSource] = useState<string | null>(null);

  // Notes import: file picker → `importNotes` per file, one at a time (the
  // server runs the extraction pipeline per import). The graph refreshes
  // itself through the snapshot subscription when a run lands.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onImportFiles = (files: FileList | null) => {
    if (!files || files.length === 0 || importing) return;
    const picked = [...files];
    const unsupported = picked.find((file) => !/\.(md|markdown|txt)$/i.test(file.name));
    if (unsupported) {
      setError(`${unsupported.name}: choose .md or .txt files.`);
      return;
    }
    setImporting(true);
    setError(null);
    void (async () => {
      try {
        for (const file of picked) await dataRef.current.importNotes(file);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Import failed.");
      } finally {
        setImporting(false);
      }
    })();
  };

  // The server's positions ledger is the layout. The one-shot local layout runs only when the
  // ledger is absent (a graph never merged through the pipeline).
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the frozen layout into posRef for the imperative canvas renderer
  useEffect(() => {
    if (!snapshot || snapshot.nodes.length === 0) return;
    // The ledger path: every positioned node uses its resting position;
    // nodes the ledger doesn't know yet (raced mid-settle) fall through
    // to seeded scatter below.
    const ledger = snapshot.positions;
    if (ledger) {
      const positions = new Map<string, { x: number; y: number }>();
      for (const node of snapshot.nodes) {
        const p = ledger[node.id];
        if (p) positions.set(node.id, { x: p.x, y: p.y });
      }
      if (positions.size > 0) {
        // Hygiene (2026-09-23 fix wave): nodes the ledger doesn't know
        // yet (raced mid-settle) get seeded ring positions instead of
        // the old ?? 0 origin dump.
        posRef.current = seedMissingNodePositions(snapshot.nodes, positions);
        return () => {
          posRef.current = null;
        };
      }
    }
    // Bootstrap fallback: the ledger is absent (fresh graph) — run
    // the SAME engine the server settle uses (d3-force via
    // incrementalLayout, seeded deterministic) and freeze the result.
    // Deterministic for a given node set across remounts.
    posRef.current = incrementalLayout(snapshot.nodes, snapshot.edges, new Map());
    return () => {
      posRef.current = null;
    };
  }, [snapshot]);

  // Construct the renderer once the canvas exists; destroy when it goes
  // away (the empty-graph placeholder replaces it). The callbacks are
  // created once and read through refs, so they never go stale.
  const isEmpty = snapshot === null || snapshot.nodes.length === 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- creates the imperative canvas renderer on the canvas and destroys it when the canvas goes away
  useEffect(() => {
    if (isEmpty) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Keep learnharness's per-device camera. A manually moved view restores
    // verbatim; an auto-fitted view adapts to the current usable viewport.
    let initialCamera: GraphCamera | null = null;
    try {
      const stored = localStorage.getItem(CAMERA_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as {
          k?: unknown;
          x?: unknown;
          y?: unknown;
          fitted?: unknown;
          width?: unknown;
          height?: unknown;
        };
        if (
          typeof parsed.k === "number" &&
          Number.isFinite(parsed.k) &&
          parsed.k > 0 &&
          typeof parsed.x === "number" &&
          Number.isFinite(parsed.x) &&
          typeof parsed.y === "number" &&
          Number.isFinite(parsed.y)
        )
          initialCamera = {
            k: parsed.k,
            x: parsed.x,
            y: parsed.y,
            fitted: parsed.fitted === true,
            ...(typeof parsed.width === "number" &&
            Number.isFinite(parsed.width) &&
            parsed.width > 0 &&
            typeof parsed.height === "number" &&
            Number.isFinite(parsed.height) &&
            parsed.height > 0
              ? { width: parsed.width, height: parsed.height }
              : {}),
          };
      }
    } catch {
      // Corrupt entry → treat as absent; the renderer fits.
    }
    // Debounced camera writes: a pan emits hundreds of transforms per
    // second; one trailing write per quiet spell is plenty.
    let cameraTimer: ReturnType<typeof setTimeout> | null = null;
    let lastCamera: GraphCamera | null = null;
    const persistCamera = (t: { k: number; x: number; y: number }, fitted: boolean) => {
      lastCamera = {
        k: t.k,
        x: t.x,
        y: t.y,
        fitted,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      };
      if (cameraTimer) clearTimeout(cameraTimer);
      cameraTimer = setTimeout(() => {
        cameraTimer = null;
        try {
          localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(lastCamera));
        } catch {
          // Storage full/blocked: camera persistence is best-effort.
        }
      }, 250);
    };
    const renderer = new GraphCanvasRenderer(
      canvas,
      {
        onSelect: (nodeId, pos) => {
          const snap = snapshotRef.current;
          const node = snap?.nodes.find((n) => n.id === nodeId);
          if (!snap || !node) return;
          setSelected({
            node,
            sourceIds: snap.nodeSessions[node.id] ?? [],
            anchor: pos,
          });
        },
        onStageClick: () => setSelected(null),
        // Right-click has no action in this port (node deletion has no
        // learn endpoint; sessions are deleted from the chain table).
        onContext: () => {},
        // Any camera move detaches the card from its node — close
        // it, and (debounced) remember where the camera stands. The
        // context menu closes with it: a menu floating over a moved
        // graph is anchored to nothing.
        onCameraMove: (t, fitted) => {
          setSelected(null);
          persistCamera(t, fitted);
        },
        // Live physics settled: persist the new rest state. Fire-and-
        // forget — the next snapshot fetch carries the ledger anyway.
        onCommit: (positions) => {
          void dataRef.current
            .saveLayout(positions)
            .catch((err) => console.error("[graph] positions commit failed", err));
        },
      },
      initialCamera,
    );
    rendererRef.current = renderer;
    return () => {
      rendererRef.current = null;
      // Flush a pending camera write so an unmount <250ms after a
      // move still persists the user's last standpoint.
      if (cameraTimer && lastCamera) {
        clearTimeout(cameraTimer);
        cameraTimer = null;
        try {
          localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(lastCamera));
        } catch {
          // best-effort
        }
      }
      renderer.destroy();
    };
  }, [isEmpty]);

  // Feed #1 — data: positions + edges + clusters + resolved colors. Runs
  // after the layout effect (same commit, declaration order) and after
  // the construct effect, so the renderer exists and positions are fresh.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes snapshot data into the canvas renderer
  useEffect(() => {
    const renderer = rendererRef.current;
    const positions = posRef.current;
    if (!renderer || !snapshot || snapshot.nodes.length === 0 || !positions) return;
    renderer.setData({
      nodes: snapshot.nodes.map((n) => ({
        id: n.id,
        x: positions.get(n.id)?.x ?? 0,
        y: positions.get(n.id)?.y ?? 0,
        label: n.name,
      })),
      edges: snapshot.edges.map((e) => ({ from: e.from, to: e.to })),
      logicalEdges: snapshot.logicalEdges.map((e) => ({ from: e.from, to: e.to })),
      impLinks: snapshot.impLinks,
      clusters: snapshot.clusters.map((c) => ({
        id: c.id,
        label: c.label,
        members: [...c.members],
      })),
      colors: {
        node: tokenHex(NODE_COLOR_TOKEN),
        edge: tokenHex("--muted-foreground"),
        label: tokenHex("--muted-foreground"),
        hoverText: tokenHex("--foreground"),
      },
      // Match the app typography (Geist via the body's stack).
      fontFamily: getComputedStyle(document.body).fontFamily,
    });
  }, [snapshot]);

  // Feed #2 — settings: just marks the frame dirty. No rebuild, no
  // re-layout, no camera touch (the whole point of the new renderer).
  const deferredSettings = useDeferredValue(settings);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes render settings into the canvas renderer
  useEffect(() => {
    rendererRef.current?.setSettings(deferredSettings);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- isEmpty re-runs the feed once the renderer exists
  }, [deferredSettings, isEmpty]);

  // Feed #3 — visibility: hidden nodes drop out of rendering, picking,
  // hover, AND labels; edges drop when either endpoint is hidden.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes search visibility into the canvas renderer
  useEffect(() => {
    rendererRef.current?.setVisible(query.trim() ? visibleIds : null);
    // The open detail card cannot outlive its node's visibility.
    // oxlint-disable-next-line react/set-state-in-effect -- closes the card in the same pass that hides its node
    setSelected((sel) => (sel && visibleIds.has(sel.node.id) ? sel : null));
  }, [visibleIds, query]);

  // Feed #4 — region tuning. `isEmpty` in the deps (same as Feed #2):
  // the settings fetch resolves BEFORE the snapshot creates the renderer,
  // so the load-time run hits a null renderer and would never re-fire —
  // the renderer would silently keep the default tuning forever.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes region tuning into the canvas renderer
  useEffect(() => {
    rendererRef.current?.setRegionTuning(regionTuning);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- isEmpty re-runs the feed once the renderer exists
  }, [regionTuning, isEmpty]);

  // Feed #5 — physics tuning: rebuilds the live sim in place (drag pins
  // survive; a mid-settle change re-anneals, the honest response). Same
  // isEmpty dep as Feed #4 — see there.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes physics tuning into the canvas renderer
  useEffect(() => {
    rendererRef.current?.setPhysicsTuning(physicsTuning);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- isEmpty re-runs the feed once the renderer exists
  }, [physicsTuning, isEmpty]);

  // Position the detail card: below the clicked node, flipped above near
  // the bottom edge, clamped horizontally. Imperative (ref + layout effect,
  // before paint) because the flip needs the card's measured height.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- places the detail card before paint; the flip needs its measured height
  useLayoutEffect(() => {
    const card = cardRef.current;
    const container = containerRef.current;
    if (!selected || !card || !container) return;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const margin = 8;
    const gap = 12;
    const left = Math.min(
      Math.max(selected.anchor.x - width / 2, margin),
      Math.max(container.clientWidth - width - margin, margin),
    );
    let top = selected.anchor.y + gap;
    if (top + height > container.clientHeight - margin) {
      top = Math.max(selected.anchor.y - gap - height, margin);
    }
    card.style.left = `${left}px`;
    card.style.top = `${top + container.offsetTop}px`;
    card.style.visibility = "visible";
  }, [selected]);

  const selectionSet = new Set(selectionIds);
  const aliveIds = new Set(snapshot?.propositions.map((node) => node.id));
  const dueIds = data.review?.due.filter((id) => aliveIds.has(id)) ?? [];
  // A snapshot refresh (deletion, re-extraction) can drop picked nodes.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a server snapshot refresh prunes picks it dropped from the shared selection store
  useEffect(() => {
    if (!snapshot || selectionIds.length === 0) return;
    const alive = new Set(snapshot.propositions.map((node) => node.id));
    const kept = selectionIds.filter((id) => alive.has(id));
    const text = kept.length > 0 ? selectionContext(snapshot, kept) : "";
    if (kept.length !== selectionIds.length || text !== contextText) {
      setGraphSelection(kept, text);
    }
  }, [snapshot, selectionIds, contextText, setGraphSelection]);

  return (
    <div className="relative h-full w-full">
      {isEmpty ? (
        // The empty graph keeps the first action clear without zero-valued statistics.
        <div className="flex h-full w-full items-center justify-center px-4">
          <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
            <WaypointsIcon className="size-10 opacity-40" strokeWidth={1.25} />
            <div className="text-lg font-medium text-foreground">Knowledge graph</div>
            <p className="max-w-sm text-sm">
              {data.error
                ? "Graph unavailable. Retrying…"
                : data.loading
                  ? "Loading graph…"
                  : "Start a session or import notes to build your graph."}
            </p>
          </div>
        </div>
      ) : (
        <div ref={containerRef} className="absolute inset-x-0 bottom-0 top-12">
          {/* THE single canvas: every layer (hulls, edges, nodes, both
					    label systems, hover) draws into it, once per frame. */}
          <canvas ref={canvasRef} className="block h-full w-full touch-none" />
        </div>
      )}

      {/* One row on the header's 13px edges; the search shrinks in narrow windows. */}
      <div className="absolute right-3.25 top-2 z-10 flex max-w-[calc(100%-1.625rem)] flex-col items-end gap-2">
        <div className="relative z-20 flex min-w-0 items-start gap-2 max-sm:w-full">
          <GraphChromeRow
            isEmpty={isEmpty}
            query={query}
            onQuery={setQuery}
            noMatch={snapshot !== null && visibleIds.size === 0 && query.trim() !== ""}
            importing={importing}
            searchInputRef={searchInputRef}
            fileInputRef={fileInputRef}
            onImportFiles={onImportFiles}
            settings={settings}
            changeSettings={changeSettings}
            onOpenChains={() => setChainsOpen(true)}
            dueCount={dueIds.length}
            onReview={() => {
              if (!snapshot) return;
              const nodeIds = dueIds.slice(0, REVIEW_BATCH);
              startSession({
                kind: "practice",
                graphContext: { nodeIds, text: selectionContext(snapshot, nodeIds) },
              });
            }}
            calibration={data.review?.calibration ?? []}
          />
        </div>
        {(error ?? (isEmpty ? null : data.error)) && (
          <Alert className="max-w-80">
            <AlertDescription>{error ?? data.error}</AlertDescription>
            {error && (
              <AlertAction>
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="sm"
                  onClick={() => setError(null)}
                >
                  Dismiss
                </Button>
              </AlertAction>
            )}
          </Alert>
        )}
      </div>

      {selected && snapshot && !isEmpty && (
        <div
          ref={cardRef}
          // Positioned imperatively in the layout effect above; hidden
          // until placed so the flip never flashes in the wrong spot.
          style={{ visibility: "hidden", left: 0, top: 0 }}
          className="absolute z-10 max-h-[calc(100%-1rem)] w-80 max-w-[calc(100%-1rem)] overflow-y-auto rounded-xl border bg-popover p-4 text-left"
        >
          <NodeCard
            key={selected.node.id}
            node={selected.node}
            snapshot={snapshot}
            data={data}
            onClose={() => setSelected(null)}
            onError={(failure) =>
              setError(failure instanceof Error ? failure.message : "Graph action failed.")
            }
          />
        </div>
      )}
      {/* The chain table overlay (chains-overlay plan, 2026-09-29):
			    ABSOLUTE INSIDE the graph area — never a body portal — and the
			    LAST child of the root, so it paints after everything it covers. */}
      <ChainTableOverlay
        open={chainsOpen && !isEmpty}
        nodes={snapshot?.propositions ?? []}
        chains={snapshot?.chains ?? []}
        sessions={snapshot?.sessions ?? {}}
        fileSources={snapshot?.fileSources ?? {}}
        onClose={() => setChainsOpen(false)}
        selection={selectionSet}
        onSelectionChange={(ids) =>
          setGraphSelection(
            [...ids],
            snapshot && ids.size > 0 ? selectionContext(snapshot, ids) : "",
          )
        }
        onStart={(kind) => {
          if (!snapshot || selectionIds.length === 0) return;
          startSession({
            kind,
            graphContext: { nodeIds: selectionIds, text: selectionContext(snapshot, selectionIds) },
          });
        }}
        onDeleteSource={data.available ? setDeletingSource : undefined}
      />
      {deletingSource && snapshot && (
        <DeleteSourceDialog
          key={deletingSource}
          sourceId={deletingSource}
          title={
            snapshot.sessions[deletingSource] ??
            snapshot.fileSources[deletingSource] ??
            deletingSource
          }
          data={data}
          onClose={() => setDeletingSource(null)}
        />
      )}
    </div>
  );
}
