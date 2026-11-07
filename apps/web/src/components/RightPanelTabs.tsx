import type {
  EnvironmentId,
  PreviewSessionSnapshot,
  PullRequestState,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { Atom, PenLine, Plus, X, FileText, GitCompareArrows } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import type { DesktopPreviewOverlay } from "~/previewStateStore";
import { isLearningSurface, type RightPanelSurface } from "~/rightPanelStore";
import { resolveShortcutCommand, type ShortcutMatchContext } from "~/keybindings";
import { cn } from "~/lib/utils";
import type { PreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

export interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  open?: boolean;
  keybindings: ResolvedKeybindingsConfig;
  getShortcutContext: () => ShortcutMatchContext;
  /** Forwarded to PreviewPanelShell so this surface persists its own width. */
  widthStorageKey?: string;
  /** Forwarded to PreviewPanelShell as the initial width before a user resize. */
  defaultWidth?: number;
  inlineSize?: PreviewPanelInlineSize;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  /** Fallback environment for surfaces that do not carry their own. */
  environmentId: EnvironmentId | null;
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  /**
   * Maps a server session tab id to the desktop runtime tab id the Electron
   * preview manager is keyed by. Session ids are only unique within one server
   * process, so desktop operations must not be addressed with them.
   */
  previewRuntimeTabId?: ((tabId: string) => string) | undefined;
  terminalLabelsById: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onRenameDevice?: (surfaceId: string, title: string) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  /** Tabs are draggable only when the owner can persist the new order. */
  onMoveSurface?: (surfaceId: string, toIndex: number) => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddBrowser: () => void;
  /**
   * Separate from `onAddBrowser` on purpose: that one is passed directly as a
   * DOM click handler, and a `(profileId?: string)` signature would silently
   * accept the MouseEvent as a profile id.
   */
  onAddBrowserInProfile: (profileId: string) => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddPullRequests: () => void;
  onAddDevice: () => void;
  /** lbgos learn surfaces; surfaces that offer neither leave these out. */
  onAddWhiteboard?: () => void;
  onAddSimulation?: () => void;
  browserAvailable: boolean;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  pullRequestsAvailable: boolean;
  deviceAvailable: boolean;
  whiteboardAvailable?: boolean;
  simulationAvailable?: boolean;
  pullRequestStatusSeeds?: Readonly<Record<string, PullRequestTabStatusSeed>>;
  children: ReactNode;
}

export interface PullRequestTabStatus {
  projectId: string;
  repository: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
}

export type PullRequestTabStatusSeed = Pick<PullRequestTabStatus, "state" | "isDraft">;

export function RightPanelTabs(props: RightPanelTabsProps) {
  const surfaces = props.surfaces.filter(isLearningSurface);
  const [menuOpen, setMenuOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.open === false) setMenuOpen(false);
  }, [props.open]);
  const onNewSurfaceKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const command = resolveShortcutCommand(event, props.keybindings, {
      context: { ...props.getShortcutContext(), rightPanelOpen: true },
    });
    if (command !== "rightPanel.new") return;
    if (
      !menuOpen &&
      document.querySelector(
        '[data-slot="dialog-popup"], [data-slot="command-dialog-popup"], [data-slot="menu-popup"]',
      )
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      addButtonRef.current?.focus();
      setMenuOpen(true);
    }
  });
  useEffect(() => {
    if (props.open === false) return;
    document.addEventListener("keydown", onNewSurfaceKeyDown, true);
    return () => document.removeEventListener("keydown", onNewSurfaceKeyDown, true);
  }, [props.open]);

  const actions = [
    {
      label: "Board",
      available: props.whiteboardAvailable === true,
      run: props.onAddWhiteboard,
      icon: PenLine,
    },
    {
      label: "Sim",
      available: props.simulationAvailable === true,
      run: props.onAddSimulation,
      icon: Atom,
    },
  ];
  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.open !== undefined ? { open: props.open } : {})}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
      {...(props.widthStorageKey !== undefined ? { widthStorageKey: props.widthStorageKey } : {})}
      {...(props.defaultWidth !== undefined ? { defaultWidth: props.defaultWidth } : {})}
      {...(props.inlineSize !== undefined ? { inlineSize: props.inlineSize } : {})}
    >
      <div
        className="flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 px-2"
        data-right-panel-tab-list
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {surfaces.map((surface) => {
            const title =
              surface.kind === "simulation"
                ? surface.path.startsWith("visuals/")
                  ? "Visual"
                  : "Sim"
                : surface.kind === "file"
                  ? (surface.relativePath.split("/").at(-1) ?? "File")
                  : surface.kind === "diff"
                    ? "Diff"
                    : "Board";
            const Icon =
              surface.kind === "simulation"
                ? Atom
                : surface.kind === "file"
                  ? FileText
                  : surface.kind === "diff"
                    ? GitCompareArrows
                    : PenLine;
            return (
              <div
                key={surface.id}
                className={cn(
                  "flex shrink-0 items-center gap-1 px-1 text-xs",
                  surface.id === props.activeSurfaceId && "bg-accent text-foreground",
                )}
                data-active-tab={surface.id === props.activeSurfaceId}
              >
                <button
                  type="button"
                  className="flex cursor-pointer items-center gap-1 py-1"
                  onClick={() => props.onActivate(surface)}
                >
                  <Icon className="size-3.5" />
                  {title}
                </button>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Close ${title}`}
                  onClick={() => props.onCloseSurface(surface)}
                >
                  <X className="size-3" />
                </Button>
              </div>
            );
          })}
        </div>
        {props.open !== false ? (
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger
              ref={addButtonRef}
              render={
                <Button aria-label="Add panel surface" size="icon-xs" variant="ghost-muted" />
              }
            >
              <Plus className="size-3.5" />
            </MenuTrigger>
            <MenuPopup
              align="end"
              onKeyDownCapture={(event) => {
                const action =
                  event.key.toLowerCase() === "w"
                    ? actions[0]
                    : event.key.toLowerCase() === "s"
                      ? actions[1]
                      : undefined;
                if (!action?.available || event.metaKey || event.ctrlKey || event.altKey) return;
                event.preventDefault();
                action.run?.();
                setMenuOpen(false);
              }}
            >
              {actions.map((action) => (
                <MenuItem
                  key={action.label}
                  disabled={!action.available}
                  onClick={() => {
                    action.run?.();
                    setMenuOpen(false);
                  }}
                >
                  <action.icon />
                  {action.label}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
        {props.layoutControls}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {surfaces.length > 0 ? (
          props.children
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-3">
            {actions.map((action) => (
              <Button
                key={action.label}
                variant="ghost"
                disabled={!action.available}
                onClick={() => action.run?.()}
              >
                <action.icon className="size-4" />
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </PreviewPanelShell>
  );
}
