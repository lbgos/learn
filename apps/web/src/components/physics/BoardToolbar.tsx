import type { BoardColor } from "@t3tools/physics/board";
import {
  ArrowUpRightIcon,
  CircleIcon,
  EraserIcon,
  HandIcon,
  MaximizeIcon,
  MinusIcon,
  MousePointer2Icon,
  PencilIcon,
  Redo2Icon,
  SigmaIcon,
  SquareIcon,
  TypeIcon,
  Undo2Icon,
} from "lucide-react";
import type { ComponentType } from "react";

import { BOARD_COLORS } from "~/physics/boardRender";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { Tip } from "./Tip";
import type { BoardTool } from "./BoardCanvas";

/** Letter shortcuts for the tools, active while the board has focus. */
export const BOARD_TOOLS: ReadonlyArray<{
  readonly tool: BoardTool;
  readonly label: string;
  readonly key: string;
  readonly Icon: ComponentType<{ className?: string }>;
}> = [
  { tool: "select", label: "Select", key: "v", Icon: MousePointer2Icon },
  { tool: "pen", label: "Pen", key: "p", Icon: PencilIcon },
  { tool: "eraser", label: "Eraser", key: "e", Icon: EraserIcon },
  { tool: "text", label: "Text", key: "t", Icon: TypeIcon },
  { tool: "math", label: "Math", key: "m", Icon: SigmaIcon },
  { tool: "line", label: "Line", key: "l", Icon: MinusIcon },
  { tool: "arrow", label: "Arrow", key: "a", Icon: ArrowUpRightIcon },
  { tool: "rect", label: "Rectangle", key: "r", Icon: SquareIcon },
  { tool: "ellipse", label: "Ellipse", key: "o", Icon: CircleIcon },
  { tool: "pan", label: "Pan", key: "h", Icon: HandIcon },
];

const COLORS = Object.keys(BOARD_COLORS) as BoardColor[];

/** One compact row: tools, the six board colors, then undo, redo and fit. */
export function BoardToolbar(props: {
  readonly tool: BoardTool;
  readonly color: BoardColor;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onTool: (tool: BoardTool) => void;
  readonly onColor: (color: BoardColor) => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onFit: () => void;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-white/10 border-b px-1.5">
      {BOARD_TOOLS.map(({ tool, label, key, Icon }) => (
        <Tip key={tool} label={`${label} (${key.toUpperCase()})`}>
          <Toggle
            size="xs"
            variant="ghost"
            aria-label={label}
            pressed={props.tool === tool}
            onPressedChange={() => props.onTool(tool)}
          >
            <Icon />
          </Toggle>
        </Tip>
      ))}
      <span className="mx-1.5 h-4 w-px shrink-0 bg-white/10" />
      {COLORS.map((name) => (
        <button
          key={name}
          type="button"
          aria-label={name}
          aria-pressed={props.color === name}
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full"
          onClick={() => props.onColor(name)}
        >
          <span
            className={cn(
              "size-3 rounded-full",
              props.color === name && "ring-1 ring-white ring-offset-1 ring-offset-black",
            )}
            style={{ backgroundColor: BOARD_COLORS[name] }}
          />
        </button>
      ))}
      <span className="mx-1.5 h-4 w-px shrink-0 bg-white/10" />
      <Tip label="Undo (Ctrl+Z)">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Undo"
          disabled={!props.canUndo}
          onClick={props.onUndo}
        >
          <Undo2Icon />
        </Button>
      </Tip>
      <Tip label="Redo (Ctrl+Shift+Z)">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Redo"
          disabled={!props.canRedo}
          onClick={props.onRedo}
        >
          <Redo2Icon />
        </Button>
      </Tip>
      <Tip label="Fit to content">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Fit to content"
          onClick={props.onFit}
        >
          <MaximizeIcon />
        </Button>
      </Tip>
    </div>
  );
}
