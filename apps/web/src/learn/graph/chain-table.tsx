// Ported from learnharness (AGPL-3.0-only) components/chain-table.tsx @ c549494.
/**
 * The chains overlay: every reasoning chain, grouped by its conclusion's birth session.
 * A chain line reads `A ∧ B ⟹ C` with KaTeX glyphs. Selection is a flat node-id set and never
 * shifts layout; the floating bar shows the derived chains and starts a learn session.
 * Read-only toward the graph; a cluster row deletes its source.
 */

import { useEffect, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  DumbbellIcon,
  FolderIcon,
  FolderOpenIcon,
  GraduationCapIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  chainsForSelection,
  formatChainLine,
  fuzzyScore,
  type GraphChain,
  type GraphNode,
} from "@t3tools/learn/graph";
import { MarkdownMath } from "../../components/MarkdownMath";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group";

/** The sortable columns (owner ruling: all three — consistency). */
export type ChainSortCol = "name" | "props" | "created";
export interface ChainSort {
  col: ChainSortCol;
  /** 1 = ascending (A→Z, oldest-first, smallest-first), -1 = descending. */
  dir: 1 | -1;
}

/** A cluster's chains share the conclusion's birth (owner ruling). This
 *  record is assembled per render from the visible chains. */
interface ClusterGroup {
  key: string;
  birth: string | null;
  label: string | null;
  kind: "chat" | "notes" | null;
  chains: ReturnType<typeof chainsForSelection>;
  nodeIds: string[];
  newestCreatedAt: string;
}

type Chain = ReturnType<typeof chainsForSelection>[number];

// A chain is visible when ANY member matches on name, aliases, or statement; chains rank by
// best member score.
function filterChains(
  chains: readonly Chain[],
  byId: ReadonlyMap<string, GraphNode>,
  query: string,
) {
  const scored = chains
    .map((chain) => {
      let best: number | null = null;
      for (const id of [...chain.premises, chain.conclusion]) {
        const node = byId.get(id);
        if (!node) continue;
        const s = fuzzyScore(query, node.name, node.statement, ...node.aliases);
        if (s === null) continue;
        if (best === null || s > best) best = s;
      }
      return best === null ? null : { chain, best };
    })
    .filter((r): r is { chain: Chain; best: number } => r !== null);
  return scored
    .sort((a, b) => b.best - a.best || (a.chain.id < b.chain.id ? -1 : 1))
    .map(({ chain }) => chain);
}

// Groups the visible chains by their CONCLUSION's birth (owner ruling).
// Unlabeled births (provenance gone / never named) form one honest
// muted group, sorted last under name-sort.
function groupChains(
  visibleChains: readonly Chain[],
  byId: ReadonlyMap<string, GraphNode>,
  sessions: Record<string, string>,
  fileSources: Record<string, string>,
  sort: ChainSort,
) {
  const map = new Map<string, ClusterGroup>();
  for (const chain of visibleChains) {
    const conclusion = byId.get(chain.conclusion);
    const birth = conclusion?.provenance[0]?.chatId ?? null;
    const key = birth ?? "\0unlabeled";
    let group = map.get(key);
    if (!group) {
      const label = birth === null ? null : (sessions[birth] ?? fileSources[birth] ?? null);
      const kind =
        birth === null
          ? null
          : sessions[birth] !== undefined
            ? "chat"
            : fileSources[birth] !== undefined
              ? "notes"
              : null;
      group = { key, birth, label, kind, chains: [], nodeIds: [], newestCreatedAt: "" };
      map.set(key, group);
    }
    group.chains.push(chain);
    for (const id of [...chain.premises, chain.conclusion]) {
      if (!group.nodeIds.includes(id)) group.nodeIds.push(id);
      const createdAt = byId.get(id)?.createdAt ?? "";
      if (createdAt > group.newestCreatedAt) group.newestCreatedAt = createdAt;
    }
  }
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  const list = [...map.values()];
  // Sort law (owner ruling: all three columns sortable — consistency):
  // the active column orders BOTH cluster rows and chains within; name
  // is the universal tiebreak (asc). Unlabeled clusters sort last under
  // name-sort (￿ sentinel).
  const nameKey = (g: ClusterGroup) => g.label ?? "\uffff";
  const cmpName = (a: ClusterGroup, b: ClusterGroup) =>
    collator.compare(nameKey(a), nameKey(b)) * (sort.col === "name" ? sort.dir : 1);
  const cmpProps = (a: ClusterGroup, b: ClusterGroup) =>
    sort.dir === -1 ? b.nodeIds.length - a.nodeIds.length : a.nodeIds.length - b.nodeIds.length;
  const cmpCreated = (a: ClusterGroup, b: ClusterGroup) =>
    sort.dir === -1
      ? b.newestCreatedAt.localeCompare(a.newestCreatedAt)
      : a.newestCreatedAt.localeCompare(b.newestCreatedAt);
  list.sort((a, b) =>
    sort.col === "created"
      ? cmpCreated(a, b) || cmpName(a, b)
      : sort.col === "props"
        ? cmpProps(a, b) || cmpName(a, b)
        : cmpName(a, b),
  );
  for (const group of list) {
    const chainName = (chain: Chain) => byId.get(chain.conclusion)?.name ?? chain.conclusion;
    const chainSize = (chain: Chain) => chain.premises.length + 1;
    const chainDate = (chain: Chain) => byId.get(chain.conclusion)?.createdAt ?? "";
    const cName = (a: Chain, b: Chain) =>
      collator.compare(chainName(a), chainName(b)) * (sort.col === "name" ? sort.dir : 1);
    const cProps = (a: Chain, b: Chain) =>
      sort.dir === -1 ? chainSize(b) - chainSize(a) : chainSize(a) - chainSize(b);
    const cDate = (a: Chain, b: Chain) =>
      sort.dir === -1
        ? chainDate(b).localeCompare(chainDate(a))
        : chainDate(a).localeCompare(chainDate(b));
    group.chains.sort((a, b) =>
      sort.col === "created"
        ? cDate(a, b) || cName(a, b)
        : sort.col === "props"
          ? cProps(a, b) || cName(a, b)
          : cName(a, b),
    );
  }
  return list;
}

/** The table body. The overlay wrapper below owns its query, sort and expansion. */
function ChainTableBody({
  nodes,
  chains: storedChains,
  sessions,
  fileSources,
  query,
  onQuery,
  sort,
  onSort,
  selection,
  expandedClusters,
  expandedChains,
  onToggleCluster,
  onToggleChain,
  onToggleNodes,
  onClear,
  onStart,
  onDeleteSource,
  onClose,
}: {
  nodes: readonly GraphNode[];
  chains: readonly GraphChain[];
  sessions: Record<string, string>;
  fileSources: Record<string, string>;
  query: string;
  onQuery: (v: string) => void;
  sort: ChainSort;
  onSort: (col: ChainSortCol) => void;
  selection: ReadonlySet<string>;
  expandedClusters: ReadonlySet<string>;
  expandedChains: ReadonlySet<string>;
  onToggleCluster: (key: string) => void;
  onToggleChain: (id: string) => void;
  /** Selection is ALWAYS a flat node-id set — cluster, chain, and single
   *  proposition checks all reduce to this. */
  onToggleNodes: (ids: string[], next: boolean) => void;
  onClear: () => void;
  /** Starts a learn session from the picked nodes. */
  onStart: (kind: "teach" | "practice") => void;
  /** Opens the delete dialog for a cluster's source (absent = no action). */
  onDeleteSource?: ((sourceId: string) => void) | undefined;
  onClose: () => void;
}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chains = chainsForSelection(nodes, storedChains);
  const searching = query.trim() !== "";

  const visibleChains = searching ? filterChains(chains, byId, query) : chains;
  const groups = groupChains(visibleChains, byId, sessions, fileSources, sort);
  const derived = chainsForSelection(
    [...selection].map((id) => byId.get(id)).filter((n): n is GraphNode => n !== undefined),
    storedChains,
  );

  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const dateOf = (id: string) => byId.get(id)?.createdAt.slice(0, 10) ?? "";
  // Rows without a delete button keep its column, so every row and the header line up.
  const deleteColumn = onDeleteSource ? <span aria-hidden className="w-8 shrink-0 sm:w-7" /> : null;
  const dirIcon = (col: ChainSortCol) =>
    sort.col !== col ? null : sort.dir === 1 ? (
      <ChevronUpIcon className="size-3" />
    ) : (
      <ChevronDownIcon className="size-3" />
    );

  return (
    <div data-testid="chain-table" className="relative flex h-full min-h-0 flex-col">
      {/* Counts, search and close only: a title always names a session. */}
      <div className="flex h-12 shrink-0 items-center gap-2 px-3 pl-12 sm:pl-3">
        <span className="min-w-0 shrink-0 truncate text-xs text-muted-foreground sm:flex-1">
          {chains.length} {chains.length === 1 ? "chain" : "chains"} · {nodes.length}{" "}
          {nodes.length === 1 ? "node" : "nodes"}
        </span>
        <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon className="size-3.5 text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              size="sm"
              value={query}
              data-testid="chain-table-search"
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search nodes…"
              aria-label="Search nodes"
              spellCheck={false}
            />
          </InputGroup>
        </div>
        <Button
          type="button"
          variant="ghost-muted"
          size="icon-sm"
          data-testid="chain-table-close"
          onClick={onClose}
          aria-label="Close chains"
        >
          <XIcon className="size-4" />
        </Button>
      </div>

      {/* Rules sit only between cluster groups; indent steps carry the hierarchy
          (chains pl-12, statements pl-21). All three columns sort. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* The TOP rule (owner round 5: the table is framed — a line under
			    the header, a line under the last group, lines between groups). */}
        <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-border/60 bg-background px-3 text-xs text-muted-foreground">
          <button
            type="button"
            data-testid="sort-name"
            onClick={() => onSort("name")}
            aria-sort={sort.col === "name" ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
            className="flex h-8 sm:h-7 flex-1 items-center gap-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring hover:text-foreground"
          >
            Name {dirIcon("name")}
          </button>
          <button
            type="button"
            data-testid="sort-props"
            onClick={() => onSort("props")}
            aria-sort={
              sort.col === "props" ? (sort.dir === 1 ? "ascending" : "descending") : "none"
            }
            className="flex h-8 sm:h-7 w-14 shrink-0 items-center justify-end gap-1 text-right outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring hover:text-foreground"
          >
            Props {dirIcon("props")}
          </button>
          <button
            type="button"
            data-testid="sort-created"
            onClick={() => onSort("created")}
            aria-sort={
              sort.col === "created" ? (sort.dir === 1 ? "ascending" : "descending") : "none"
            }
            className="flex h-8 sm:h-7 w-24 shrink-0 items-center justify-end gap-1 text-right outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring hover:text-foreground"
          >
            Created {dirIcon("created")}
          </button>
          {deleteColumn}
        </div>

        {groups.length === 0 && (
          <div
            data-testid="chain-table-nomatch"
            className="px-4 pt-3 text-xs text-muted-foreground"
          >
            No matching chains.
          </div>
        )}

        {groups.map((group) => {
          const open = searching || expandedClusters.has(group.key);
          const selectedCount = group.nodeIds.filter((id) => selection.has(id)).length;
          return (
            <div
              key={group.key}
              data-testid={`cluster-group-${group.key}`}
              // The horizontal rules (owner rulings, rounds 2 + 5): between
              // cluster groups AND under the last one — the table is framed
              // top (header) and bottom. Never on individual rows.
              className="relative border-b border-border/60"
            >
              {/* The tree thread at the expander column (center 37px) runs from the cluster
                  checkbox bottom (top-[23px]) to the last checkbox bottom (bottom-[8px]).
                  Both offsets were measured live. */}
              {open && group.chains.length > 0 && (
                <div
                  data-testid={`cluster-thread-${group.key}`}
                  className="pointer-events-none absolute bottom-[8px] left-[37px] top-[23px] w-px bg-border/50"
                />
              )}
              {/* The cluster row: birth-session group header. */}
              <div className="flex items-center gap-1 px-3 py-1.5">
                <RowCheckbox
                  checked={selectedCount === group.nodeIds.length && group.nodeIds.length > 0}
                  indeterminate={selectedCount > 0 && selectedCount < group.nodeIds.length}
                  onToggle={(next) => onToggleNodes(group.nodeIds, next)}
                  testid={`cluster-checkbox-${group.key}`}
                  label={`Select everything born in ${group.label ?? "unlabeled"}`}
                />
                <Expander
                  open={open}
                  onClick={() => onToggleCluster(group.key)}
                  testid={`cluster-toggle-${group.key}`}
                  label={`Expand cluster ${group.label ?? "unlabeled"}`}
                />
                <span className="flex shrink-0 items-center justify-center text-muted-foreground">
                  {open ? (
                    <FolderOpenIcon className="size-3.5" />
                  ) : (
                    <FolderIcon className="size-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {group.label ?? <span className="text-muted-foreground/60">unlabeled</span>}
                  {group.kind === "notes" && (
                    <span className="ml-2 text-xs text-muted-foreground">notes</span>
                  )}
                </span>
                <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {group.nodeIds.length}
                </span>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {group.newestCreatedAt.slice(0, 10)}
                </span>
                {onDeleteSource && group.birth === null ? deleteColumn : null}
                {onDeleteSource && group.birth !== null && (
                  <Button
                    type="button"
                    variant="ghost-destructive"
                    size="icon-sm"
                    data-testid={`cluster-delete-${group.key}`}
                    aria-label={`Delete ${group.label ?? "source"} from the graph`}
                    onClick={() => onDeleteSource(group.birth!)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                )}
              </div>

              {/* The chain rows — clearly indented under the folder
							    (owner ruling); visible only when the cluster is open
							    (searching auto-expands). */}
              {open &&
                group.chains.map((chain) => {
                  const memberIds = [...chain.premises, chain.conclusion];
                  const chainOpen = expandedChains.has(chain.id);
                  const selectedInChain = memberIds.filter((id) => selection.has(id)).length;
                  return (
                    <div
                      key={chain.id}
                      data-testid={`chain-block-${chain.id}`}
                      className="relative"
                    >
                      {/* The same thread one level down: center 73px, from the chain checkbox bottom
                          (top-[22px]) to the last statement checkbox bottom (bottom-[8px]). */}
                      {chainOpen && memberIds.length > 0 && (
                        <div
                          data-testid={`chain-thread-${chain.id}`}
                          className="pointer-events-none absolute bottom-[8px] left-[73px] top-[22px] w-px bg-border/50"
                        />
                      )}
                      <div
                        data-testid={`chain-row-${chain.id}`}
                        aria-label={formatChainLine(
                          chain,
                          Object.fromEntries(
                            [...byId.entries()].map(([id, n]) => [id, { name: n.name }]),
                          ),
                        )}
                        className="flex items-center gap-1 py-1 pl-12 pr-3"
                      >
                        <RowCheckbox
                          checked={selectedInChain === memberIds.length && memberIds.length > 0}
                          indeterminate={selectedInChain > 0 && selectedInChain < memberIds.length}
                          onToggle={(next) => onToggleNodes(memberIds, next)}
                          testid={`chain-checkbox-${chain.id}`}
                          label={`Select chain ${nameOf(chain.conclusion)}`}
                        />
                        <Expander
                          open={chainOpen}
                          onClick={() => onToggleChain(chain.id)}
                          testid={`chain-toggle-${chain.id}`}
                          label={`Expand chain ${nameOf(chain.conclusion)}`}
                        />
                        {/* Premises join with ∧ and the conclusion follows ⟹, as KaTeX glyphs in the
                            foreground colour. A lone chip has no glyphs; the row's aria-label keeps
                            the plain-text form. */}
                        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1 text-sm leading-tight">
                          {memberIds.map((id, i) => {
                            const isConclusion = i === memberIds.length - 1;
                            return (
                              <span key={id} className="flex items-center">
                                {i > 0 &&
                                  (isConclusion ? (
                                    <span
                                      data-testid={`chain-implies-${chain.id}`}
                                      className="px-1.5 text-foreground"
                                    >
                                      <MarkdownMath tex="\implies" display={false} />
                                    </span>
                                  ) : (
                                    <span
                                      data-testid={`chain-and-${chain.id}-${i}`}
                                      className="px-1.5 text-foreground"
                                    >
                                      <MarkdownMath tex="\land" display={false} />
                                    </span>
                                  ))}
                                <span
                                  data-testid={`prop-chip-${id}`}
                                  className="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5"
                                >
                                  {nameOf(id)}
                                </span>
                              </span>
                            );
                          })}
                        </span>
                        <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {memberIds.length}
                        </span>
                        <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {dateOf(chain.conclusion)}
                        </span>
                        {deleteColumn}
                      </div>

                      {/* Statement text only: names already live in the chain line. */}
                      {chainOpen &&
                        memberIds.map((id) => {
                          const node = byId.get(id);
                          if (!node) return null;
                          return (
                            <div
                              key={id}
                              data-testid={`prop-row-${id}`}
                              className="flex items-start gap-2 py-1 pl-21 pr-3"
                            >
                              <RowCheckbox
                                checked={selection.has(id)}
                                onToggle={(next) => onToggleNodes([id], next)}
                                testid={`prop-checkbox-${id}`}
                                label={`Select node ${node.name}`}
                              />
                              <span className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
                                {node.statement}
                              </span>
                              <span className="w-14 shrink-0" />
                              <span className="w-24 shrink-0" />
                              {deleteColumn}
                            </div>
                          );
                        })}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>

      {/* The floating selection bar (owner ruling: never shifts layout —
			    the Google-Photos pattern). Appears only when something is
			    selected; floats over the table's bottom edge. */}
      {selection.size > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center pb-4">
          <div
            data-testid="chain-selection-bar"
            className="pointer-events-auto flex flex-wrap items-center gap-3 border bg-background px-4 py-2"
          >
            <span data-testid="chain-selected-summary" className="text-xs font-medium">
              {selection.size} {selection.size === 1 ? "node" : "nodes"} → {derived.length}{" "}
              {derived.length === 1 ? "chain" : "chains"}
            </span>
            <Button
              type="button"
              variant="ghost-muted"
              size="sm"
              data-testid="chain-clear"
              onClick={onClear}
            >
              Clear
            </Button>
            <span
              data-testid="chain-action-divider"
              aria-hidden="true"
              className="h-4 w-px bg-border/70"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="chain-teach"
              onClick={() => onStart("teach")}
            >
              <GraduationCapIcon aria-hidden="true" className="size-3.5" />
              Teach
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="chain-practice"
              onClick={() => onStart("practice")}
            >
              <DumbbellIcon aria-hidden="true" className="size-3.5" />
              Practice
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The rotating chevron — collapsed points right, expanded rotates down
 *  (owner ruling: the affordance must read on every expandable row). */
function Expander({
  open,
  onClick,
  testid,
  label,
}: {
  open: boolean;
  onClick: () => void;
  testid: string;
  label: string;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      aria-label={label}
      aria-expanded={open}
      // The hit area reaches past the 14px glyph without moving the row's fixed thread lines.
      className="relative flex h-5 w-3.5 shrink-0 items-center justify-center rounded text-muted-foreground/70 outline-none transition-colors before:absolute before:-inset-y-1.5 before:-start-0.5 before:-end-3 before:content-[''] pointer-coarse:before:-start-1.5 pointer-coarse:before:-end-3.5 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <ChevronRightIcon className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
    </button>
  );
}

/** The checkbox — checked/indeterminate (partial chains/clusters). */
function RowCheckbox({
  checked,
  indeterminate = false,
  onToggle,
  testid,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onToggle: (next: boolean) => void;
  testid: string;
  label: string;
}) {
  return (
    // The label's pseudo-element widens the 16px box to a 28px target without moving the row.
    <label className="relative flex shrink-0 cursor-pointer before:absolute before:-inset-1.5 before:content-[''] pointer-coarse:before:-inset-2">
      <Checkbox
        checked={checked}
        indeterminate={indeterminate}
        onCheckedChange={onToggle}
        data-testid={testid}
        aria-label={label}
      />
    </label>
  );
}

/** The graph view's overlay: owns query, sort and expansion. It mounts opaque inside the
 *  graph area, so the live canvas behind it never re-blurs. Esc and the X close it.
 *  The caller owns the selection, shared with the home composer. */
export function ChainTableOverlay({
  open,
  nodes,
  chains: storedChains,
  sessions,
  fileSources,
  onClose,
  selection,
  onSelectionChange,
  onStart,
  onDeleteSource,
}: {
  open: boolean;
  nodes: readonly GraphNode[];
  chains: readonly GraphChain[];
  sessions: Record<string, string>;
  fileSources: Record<string, string>;
  onClose: () => void;
  selection: ReadonlySet<string>;
  onSelectionChange: (next: ReadonlySet<string>) => void;
  onStart: (kind: "teach" | "practice") => void;
  onDeleteSource?: ((sourceId: string) => void) | undefined;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ChainSort>({ col: "name", dir: 1 });
  const [expandedClusters, setExpandedClusters] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedChains, setExpandedChains] = useState<ReadonlySet<string>>(() => new Set());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document Esc listener while the overlay is open
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const toggleNodes = (ids: string[], next: boolean) => {
    const s = new Set(selection);
    for (const id of ids) {
      if (next) s.add(id);
      else s.delete(id);
    }
    onSelectionChange(s);
  };
  const toggleIn = (set: ReadonlySet<string>, id: string) => {
    const s = new Set(set);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    return s;
  };

  return (
    <div
      data-testid="chain-table-overlay"
      className="absolute inset-0 z-40 flex flex-col bg-background"
    >
      <ChainTableBody
        nodes={nodes}
        chains={storedChains}
        sessions={sessions}
        fileSources={fileSources}
        query={query}
        onQuery={setQuery}
        sort={sort}
        onSort={(col) =>
          setSort((prev) =>
            prev.col === col
              ? { col, dir: prev.dir === 1 ? -1 : 1 }
              : { col, dir: col === "name" ? 1 : -1 },
          )
        }
        selection={selection}
        expandedClusters={expandedClusters}
        expandedChains={expandedChains}
        onToggleCluster={(key) => setExpandedClusters((prev) => toggleIn(prev, key))}
        onToggleChain={(id) => setExpandedChains((prev) => toggleIn(prev, id))}
        onToggleNodes={toggleNodes}
        onClear={() => onSelectionChange(new Set())}
        onStart={onStart}
        onDeleteSource={onDeleteSource}
        onClose={onClose}
      />
    </div>
  );
}
