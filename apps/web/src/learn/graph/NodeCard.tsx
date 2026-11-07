// Ported from learnharness (AGPL-3.0-only) components/graph-view.tsx @ c549494.
import { FileTextIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { birthSessionOf, type GraphNode, type GraphSnapshot } from "@t3tools/learn/graph";
import type { GraphEvidence, LearnGraphData } from "./data";
import { Statement } from "./Statement";

export function NodeCard({
  node,
  snapshot,
  data,
  onClose,
  onError,
}: {
  node: GraphNode;
  snapshot: GraphSnapshot;
  data: LearnGraphData;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const [evidence, setEvidence] = useState<readonly GraphEvidence[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const sources = [...new Set(node.provenance.map((point) => point.chatId))];
  const sourceKey = JSON.stringify(sources.filter((id) => Object.hasOwn(snapshot.sessions, id)));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the node's evidence from the server
  useEffect(() => {
    let active = true;
    // oxlint-disable-next-line react/set-state-in-effect -- a new node or retry shows Loading until its fetch settles
    setState("loading");
    setEvidence([]);
    const ids = sources.filter((id) => Object.hasOwn(snapshot.sessions, id));
    if (ids.length === 0) {
      setState("ready");
      return;
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- keyed on data.evidence and sourceKey, not the per-render sources
    void data
      .evidence(ids)
      .then((items) => {
        if (!active) return;
        setEvidence(items);
        setState("ready");
      })
      .catch(() => {
        if (active) setState("error");
      });
    return () => {
      active = false;
    };
  }, [data.evidence, sourceKey, retry]);

  return (
    <div aria-label="Proposition details">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium leading-snug">{node.name}</div>
        <Button
          type="button"
          variant="ghost-muted"
          size="icon-sm"
          className="-mt-1.5 -mr-1.5"
          aria-label="Close proposition"
          onClick={onClose}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <div className="mt-1">
        <Statement>{node.statement}</Statement>
      </div>
      {/* Side labels, the same field layout as the reader's answered question. */}
      <div className="mt-3 grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-3">
        {node.aliases.length > 0 && (
          <>
            <div className="text-xs text-muted-foreground">Aliases</div>
            <Statement>{node.aliases.join(", ")}</Statement>
          </>
        )}
        <div className="text-xs text-muted-foreground">Sessions</div>
        {sources.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-1">
            {sources.map((id) => (
              <div key={id} className="flex items-center gap-1.5">
                {!Object.hasOwn(snapshot.sessions, id) ? (
                  // An imported-notes file: a static entry, never a link.
                  <>
                    <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate px-2 py-1.5 text-sm text-muted-foreground">
                      {snapshot.fileSources[id] ?? id}
                    </span>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-w-0 flex-1 justify-start"
                    onClick={() => void data.openSession(id).catch(onError)}
                  >
                    <span className="truncate">{snapshot.sessions[id] ?? id}</span>
                  </Button>
                )}
                {birthSessionOf(node) === id && (
                  <span className="shrink-0 text-xs text-muted-foreground">birth</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">None recorded.</div>
        )}
        <div className="text-xs text-muted-foreground">Evidence</div>
        <div className="flex min-w-0 flex-col gap-1" aria-live="polite">
          {state === "loading" && <p className="text-xs text-muted-foreground">Loading…</p>}
          {state === "error" && (
            <Button
              type="button"
              variant="ghost-muted"
              size="sm"
              onClick={() => setRetry((value) => value + 1)}
            >
              Unavailable. Retry
            </Button>
          )}
          {state === "ready" && evidence.length === 0 && (
            <p className="text-xs text-muted-foreground">None recorded.</p>
          )}
          {evidence.map((item) => (
            <Button
              variant="ghost"
              size="sm-multiline"
              key={`${item.sourceId}:${item.kind}:${item.kind === "simulation" ? item.path : item.name}`}
              type="button"
              className="w-full justify-start"
              onClick={() => void data.openEvidence(item).catch(onError)}
            >
              <span className="flex min-w-0 flex-col text-start">
                <span>
                  {item.kind === "simulation" ? "sim" : "board"} · {item.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {snapshot.sessions[item.sourceId] ?? item.sourceId}
                </span>
              </span>
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
