import { pipe } from "effect/Function";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";

import { pullRequestDetailToVcsStatus } from "@t3tools/client-runtime/state/pull-requests";
import {
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadLinkedPullRequest,
  type ThreadPullRequestLink,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { FolderGit2Icon, TerminalIcon } from "lucide-react";
import {
  pullRequestListLines,
  resolveThreadCurrentPullRequestLink,
  resolveThreadPullRequestBadge,
  resolveThreadPullRequestChains,
  type ThreadPullRequestBadge,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import { useRender } from "@base-ui/react/use-render";
import { type ReactNode, type AnimationEvent, type MouseEvent, type ReactElement } from "react";
import { cn } from "../lib/utils";
import { revealThreadTerminal } from "../lib/revealThreadTerminal";

import { useEnvironmentQuery } from "../state/query";
import { linkedPullRequestDetailAtom, useSharedPullRequestSummary } from "../state/pullRequests";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { pullRequestMatchesSearchQuery } from "./Sidebar.logic";

import type { SidebarThreadSummary } from "../types";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  PULL_REQUEST_STATE_PRESENTATION,
  PullRequestGlyph,
  type PullRequestGlyphIcon,
} from "./pullRequest/pullRequestIcons";
import { resolvePullRequestState } from "./pullRequest/pullRequestPresentation";

export interface PrStatusIndicator {
  label: string;
  colorClass: string;
  Icon: PullRequestGlyphIcon;
  tooltip: string;
  tooltipLead: string;
  tooltipTitle: string;
  url: string;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export type ThreadPr = VcsStatusResult["pr"];

export interface LinkedThreadPullRequestStatus {
  readonly pr: NonNullable<ThreadPr>;
  readonly sourceControlProvider: NonNullable<VcsStatusResult["sourceControlProvider"]>;
}

export function useLinkedThreadPullRequest(
  environmentId: EnvironmentId | null,
  linkedPullRequest: ThreadLinkedPullRequest | null | undefined,
  enabled = true,
  pullRequests?: ReadonlyArray<ThreadPullRequestLink>,
  branchPullRequest?: ThreadLinkedPullRequest | null,
): LinkedThreadPullRequestStatus | null {
  const supportsLinks = useSupportsMultiplePullRequests(environmentId);
  const current = supportsLinks ? resolveThreadCurrentPullRequestLink(pullRequests ?? []) : null;
  const currentStatus = current === null ? null : linkedPullRequestSnapshotStatus(current);
  const fallback =
    current === null ? ((!supportsLinks ? linkedPullRequest : null) ?? branchPullRequest) : null;
  // Preserve reference identity so sidebar renders do not touch the summary cache.
  const reference = fallback == null ? null : linkedPullRequestReference(fallback);
  // Mounted for its answers, which land in the shared summary read below.
  useEnvironmentQuery(
    !enabled || environmentId === null || reference === null
      ? null
      : linkedPullRequestDetailAtom({ environmentId, input: reference }),
  );
  const detail = useSharedPullRequestSummary(environmentId, reference);

  if (current !== null) return currentStatus;
  return detail === null
    ? null
    : {
        pr: pullRequestDetailToVcsStatus(detail),
        sourceControlProvider: {
          kind: detail.provider,
          name: sourceControlClients.get(detail.provider).label,
          baseUrl: "",
        },
      };
}

function linkedPullRequestReference(fallback: ThreadLinkedPullRequest) {
  const host = sourceControlClients.parseChangeRequestUrl(fallback.url)?.link.host;
  return { ...fallback, ...(host === undefined ? {} : { host }) };
}

function changeRequestTerminologyForUrl(url: string | undefined) {
  const host = url === undefined ? null : sourceControlClients.findByChangeRequestUrl(url);
  return (host ?? sourceControlClients.get(undefined)).changeRequest;
}

export function linkedPullRequestSnapshotStatus(
  link: ThreadPullRequestLink,
): LinkedThreadPullRequestStatus | null {
  const snapshot = link.snapshot;
  if (snapshot === null) return null;
  const kind = (
    sourceControlClients.findByChangeRequestUrl(link.url) ?? sourceControlClients.get(undefined)
  ).kind;
  return {
    pr: {
      number: link.number,
      url: link.url,
      title: snapshot.title,
      state: snapshot.state,
      isDraft: snapshot.isDraft,
      headRef: snapshot.headBranch,
      baseRef: snapshot.baseBranch,
      ...(snapshot.updatedAt === null ? {} : { updatedAt: snapshot.updatedAt }),
    },
    sourceControlProvider: { kind, name: kind, baseUrl: "" },
  };
}

export {
  resolveThreadPullRequestBadge,
  type ThreadPullRequestBadge,
} from "@t3tools/client-runtime/thread-pull-requests";

export interface ThreadPullRequestBadgePresentation {
  readonly Icon: PullRequestGlyphIcon;
  readonly toneClassName: string;
  readonly label: string;
  readonly text: string | number;
}

function resolveThreadPullRequestBadgePresentation({
  badge,
  number,
  url,
  status,
}: {
  readonly badge: ThreadPullRequestBadge | null;
  readonly number?: number | undefined;
  readonly url?: string | undefined;
  readonly status: PrStatusIndicator | null;
}): ThreadPullRequestBadgePresentation | null {
  const terminology = changeRequestTerminologyForUrl(url);
  if (badge?.kind === "stack") {
    const aggregate = PULL_REQUEST_STATE_PRESENTATION[badge.state];
    return {
      Icon: PullRequestGlyph.stack,
      toneClassName: aggregate.toneClassName,
      label: `Stack of ${badge.layers} ${terminology.plural}, ${aggregate.label.toLowerCase()}`,
      text: badge.layers,
    };
  }
  if (number === undefined || url === undefined) return null;

  const tooltip = status?.tooltip ?? `${terminology.shortLabel} #${number}, status pending`;
  if (badge?.kind === "pull-request" && badge.others > 0) {
    const aggregate = PULL_REQUEST_STATE_PRESENTATION[badge.state];
    return {
      Icon: aggregate.Icon,
      toneClassName: aggregate.toneClassName,
      label: `${tooltip}, and ${badge.others} more linked; overall ${aggregate.label.toLowerCase()}`,
      text: `+${badge.others + 1}`,
    };
  }
  return {
    Icon: status?.Icon ?? PullRequestGlyph.pullRequest,
    toneClassName: status?.colorClass ?? "text-muted-foreground",
    label: tooltip,
    text: number,
  };
}

export function ThreadPullRequestBadgeControl({
  render,
  badge,
  pullRequests,
  number,
  url,
  status,
  onOpenList,
  onOpenPullRequest,
}: {
  render: ReactElement<{ render?: useRender.RenderProp }>;
  badge: ThreadPullRequestBadge | null;
  pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  number?: number | undefined;
  url?: string | undefined;
  status: PrStatusIndicator | null;
  onOpenList: () => void;
  onOpenPullRequest: (event: MouseEvent<HTMLElement>, url?: string) => void;
}) {
  const presentation = resolveThreadPullRequestBadgePresentation({ badge, number, url, status });
  if (presentation === null) return null;
  return (
    <PullRequestBadge
      render={render}
      presentation={presentation}
      opensList={badge !== null && (badge.kind === "stack" || badge.others > 0)}
      url={url}
      number={number}
      status={status}
      pullRequests={pullRequests}
      onOpenList={onOpenList}
      onOpenPullRequest={onOpenPullRequest}
    />
  );
}

function PullRequestBadge({
  render,
  presentation,
  opensList,
  url,
  number,
  status,
  pullRequests,
  onOpenList,
  onOpenPullRequest,
}: {
  render: ReactElement<{ render?: useRender.RenderProp }>;
  presentation: NonNullable<ReturnType<typeof resolveThreadPullRequestBadgePresentation>>;
  opensList: boolean;
  url: string | undefined;
  number: number | undefined;
  status: PrStatusIndicator | null;
  pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  onOpenList: () => void;
  onOpenPullRequest: (event: MouseEvent<HTMLElement>, url?: string) => void;
}) {
  const onClick = opensList
    ? (event: MouseEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenList();
      }
    : onOpenPullRequest;
  const element = opensList ? (
    <button type="button" />
  ) : (
    <a href={url} target="_blank" rel="noopener noreferrer" />
  );
  const control = useRender({
    render,
    props: {
      render: element,
      "aria-label": presentation.label,
      onPointerDown: (event: MouseEvent<HTMLElement>) => event.stopPropagation(),
      onClick,
    },
  });
  return (
    <Tooltip key={opensList ? "list" : "link"}>
      <TooltipTrigger render={control}>
        <span
          className={cn("contents font-normal text-xs tabular-nums", presentation.toneClassName)}
        >
          <presentation.Icon aria-hidden className="size-3 shrink-0" />
          <span className="text-secondary-label">{presentation.text}</span>
        </span>
      </TooltipTrigger>
      <TooltipPopup
        side="top"
        sideOffset={0}
        variant="glass"
        className="pointer-events-auto w-80 max-w-[calc(100vw-2rem)] text-left whitespace-normal"
      >
        <div className="-mx-1 max-h-[calc(var(--available-height)-0.5rem-2px)] overflow-y-auto overscroll-contain">
          {visibleThreadPullRequests(pullRequests).length > 0 ? (
            <ThreadPullRequestsMiniList
              pullRequests={pullRequests}
              onOpenPullRequest={onOpenPullRequest}
            />
          ) : number !== undefined && url !== undefined ? (
            <ul className="flex flex-col gap-1">
              <ThreadPullRequestMiniListItem
                number={number}
                url={url}
                title={status?.tooltipTitle ?? presentation.label}
                presentation={presentation}
                onOpenPullRequest={onOpenPullRequest}
              />
            </ul>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

export function ThreadPullRequestsMiniList({
  pullRequests,
  onOpenPullRequest,
}: {
  pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  onOpenPullRequest?: (event: MouseEvent<HTMLAnchorElement>, url: string) => void;
}) {
  const lines = pipe(
    visibleThreadPullRequests(pullRequests),
    resolveThreadPullRequestChains,
    pullRequestListLines,
  );
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {lines.map((line) => {
        const snapshot = line.link.snapshot;
        const presentation =
          snapshot === null
            ? null
            : resolvePullRequestState({ state: snapshot.state, isDraft: snapshot.isDraft });
        return (
          <ThreadPullRequestMiniListItem
            key={`${line.link.host}/${line.link.repository}#${line.link.number}`}
            number={line.link.number}
            url={line.link.url}
            title={snapshot?.title ?? line.link.repository}
            presentation={presentation}
            depth={line.depth}
            onOpenPullRequest={onOpenPullRequest}
          >
            {line.stack ? (
              <span className="ml-auto shrink-0 pl-1 text-3xs">
                {line.stack.kind === "native" ? "stack" : "chain"} · {line.stack.size}
              </span>
            ) : null}
          </ThreadPullRequestMiniListItem>
        );
      })}
    </ul>
  );
}

function ThreadPullRequestMiniListItem({
  number,
  url,
  title,
  presentation,
  depth = 0,
  onOpenPullRequest,
  children,
}: {
  number: number;
  url: string;
  title: string;
  presentation: Pick<ThreadPullRequestBadgePresentation, "Icon" | "toneClassName"> | null;
  depth?: number;
  onOpenPullRequest?: ((event: MouseEvent<HTMLAnchorElement>, url: string) => void) | undefined;
  children?: ReactNode;
}) {
  const Icon = presentation?.Icon ?? PullRequestGlyph.pullRequest;
  const content = (
    <>
      <Icon
        aria-hidden
        className={cn("size-3 shrink-0", presentation?.toneClassName ?? "stroke-muted-foreground")}
      />
      <span className="shrink-0 font-mono tabular-nums">#{number}</span>
      <span className="min-w-0 truncate text-foreground/75">{title}</span>
      {children}
    </>
  );
  return (
    <li style={{ paddingLeft: `${Math.min(depth, 3) * 0.75}rem` }}>
      {onOpenPullRequest ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1 hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => onOpenPullRequest(event, url)}
        >
          {content}
        </a>
      ) : (
        <div className="flex min-w-0 items-center gap-2">{content}</div>
      )}
    </li>
  );
}

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): PrStatusIndicator | null {
  if (!pr) return null;
  const { shortLabel } = sourceControlClients.get(provider?.kind).changeRequest;
  const state = resolvePullRequestState({ state: pr.state, isDraft: pr.isDraft === true });

  const tooltipLead = `${shortLabel} #${pr.number} - ${state.label}`;
  return {
    label: `${shortLabel} ${state.label.toLowerCase()}`,
    colorClass: state.toneClassName,
    Icon: state.Icon,
    tooltip: `${tooltipLead}: ${pr.title}`,
    tooltipLead,
    tooltipTitle: pr.title,
    url: pr.url,
  };
}

export function ChangeRequestStatusIcon({
  state,
  isDraft = false,
  className,
}: Pick<NonNullable<ThreadPr>, "state"> & {
  readonly isDraft?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  const presentation = resolvePullRequestState({ state, isDraft });
  return <presentation.Icon className={className} />;
}

export function resolveDisplayedThreadPr(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
  linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  linkedPullRequestStatus?: LinkedThreadPullRequestStatus | null | undefined;
}): ThreadPr | null {
  const { threadBranch, gitStatus, linkedPullRequest, linkedPullRequestStatus } = input;
  if (linkedPullRequest != null) {
    return linkedPullRequestStatus?.pr ?? null;
  }
  if (
    threadBranch !== null &&
    gitStatus !== null &&
    gitStatus.refName === threadBranch &&
    gitStatus.pr != null
  ) {
    return gitStatus.pr;
  }

  return null;
}

export function resolveDisplayedThreadPrProvider(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
  linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  linkedPullRequestStatus?: LinkedThreadPullRequestStatus | null | undefined;
}): VcsStatusResult["sourceControlProvider"] | undefined {
  const { threadBranch, gitStatus, linkedPullRequest, linkedPullRequestStatus } = input;
  if (linkedPullRequest != null) {
    return linkedPullRequestStatus?.sourceControlProvider;
  }
  if (
    threadBranch !== null &&
    gitStatus !== null &&
    gitStatus.refName === threadBranch &&
    gitStatus.pr != null
  ) {
    return gitStatus.sourceControlProvider;
  }

  return undefined;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function synchronizeTerminalPulse(event: AnimationEvent<SVGSVGElement>) {
  if (event.animationName !== "status-pulse") return;

  for (const animation of event.currentTarget.getAnimations()) {
    if ("animationName" in animation && animation.animationName === "status-pulse") {
      animation.startTime = 0;
    }
  }
}

export function ThreadTerminalStatusButton({
  threadRef,
  terminalIds,
  onThreadActivate,
}: {
  threadRef: ScopedThreadRef;
  terminalIds: readonly string[];
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
}) {
  const terminalId = terminalIds[0];
  if (terminalId === undefined) return null;
  const status = terminalStatusFromRunningIds(terminalIds);
  const label =
    terminalIds.length === 1
      ? "1 terminal process running. Open terminal"
      : `${terminalIds.length} terminal processes running. Open terminal`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            data-testid={`sidebar-terminal-status-${threadRef.threadId}`}
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              status?.colorClass,
            )}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              revealThreadTerminal(threadRef, terminalId);
              onThreadActivate(threadRef);
            }}
          />
        }
      >
        <TerminalIcon
          className="size-3.5 motion-safe:animate-status-pulse"
          onAnimationStart={synchronizeTerminalPulse}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function ThreadWorktreeIndicator({
  thread,
}: {
  thread: Pick<SidebarThreadSummary, "id" | "branch" | "worktreePath">;
}) {
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath) {
    return null;
  }

  const displayPath = formatWorktreePathForDisplay(worktreePath);
  const tooltip = thread.branch
    ? `Worktree: ${displayPath} (${thread.branch})`
    : `Worktree: ${displayPath}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={tooltip}
            data-testid={`thread-worktree-${thread.id}`}
            className="inline-flex items-center justify-center"
          />
        }
      >
        <FolderGit2Icon className="size-3.5 shrink-0 text-icon-muted" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function settledPrHoverColorClass(state: ThreadPullRequestBadge["state"]): string {
  switch (state) {
    case "draft":
      return "group-hover/sidebar-row:text-zinc-500 dark:group-hover/sidebar-row:text-zinc-400/80";
    case "open":
      return "group-hover/sidebar-row:text-emerald-600 dark:group-hover/sidebar-row:text-emerald-300/90";
    case "merged":
      return "group-hover/sidebar-row:text-violet-600 dark:group-hover/sidebar-row:text-violet-300/90";
    case "closed":
      return "group-hover/sidebar-row:text-red-600 dark:group-hover/sidebar-row:text-red-300/90";
  }
}

// Search rows are already buttons, so this renders the sidebar badge's look without its controls.
export function ThreadSearchPullRequestNumber({
  thread,
  query,
  enabled = true,
  settled = false,
}: {
  thread: SidebarThreadSummary;
  query: string;
  enabled?: boolean;
  settled?: boolean;
}) {
  const matched = pullRequestMatchesSearchQuery(thread, query);
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const linked = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    enabled && matched,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  if (!matched) return null;
  const badge = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(thread.pullRequests)
    : null;
  const current = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;
  const pr = linked?.pr ?? null;
  // Stored references already carry a number, so the badge shows before PR details load.
  const stored =
    current ??
    [thread.linkedPullRequest, thread.branchPullRequest].find(
      (reference) =>
        reference != null && pullRequestMatchesSearchQuery({ linkedPullRequest: reference }, query),
    );
  const presentation = resolveThreadPullRequestBadgePresentation({
    badge,
    number: pr?.number ?? stored?.number,
    url: pr?.url ?? stored?.url,
    status: prStatusIndicator(pr, linked?.sourceControlProvider),
  });
  if (presentation === null) return null;
  const aggregate = badge !== null && (badge.kind === "stack" || badge.others > 0);
  const state = aggregate
    ? badge.state
    : pr === null
      ? null
      : pr.state === "open" && pr.isDraft
        ? "draft"
        : pr.state;
  return (
    <span
      aria-label={presentation.label}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums",
        settled
          ? cn("text-secondary-label transition-colors", state && settledPrHoverColorClass(state))
          : presentation.toneClassName,
      )}
    >
      {/* text-current opts out of the command palette's muted icon color. */}
      <presentation.Icon aria-hidden className="size-3 shrink-0 text-current" />
      <span>{presentation.text}</span>
    </span>
  );
}
