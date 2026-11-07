import { useEffect, useState } from "react";
import { HostedEmptyState } from "../components/HostedEmptyState";
import ChatView from "../components/ChatView";
import { ToggleGroup, Toggle } from "../components/ui/toggle-group";
import { createFileRoute } from "@tanstack/react-router";
import { useLabProjectRef } from "../learn/labProject";
import { useLearnDraftStore } from "../learn/startSession";
import { useGraphSelection } from "../learn/graph/selection";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { SidebarInset } from "../components/ui/sidebar";
import { useAllEnvironmentShellsBootstrapped } from "../state/entities";
import { GraphHome } from "../learn/graph/GraphHome";
import { LearnGraphDataProvider } from "../learn/graph/LearnGraphDataProvider";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }

  if (!bootstrapped) return null;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <LearnGraphDataProvider environmentId={primaryEnvironmentId}>
        <LearningHome />
      </LearnGraphDataProvider>
    </SidebarInset>
  );
}

/** ChatView owns the native composer, attachments, model picker and first-send bootstrap. */
function LearningHome() {
  const project = useLabProjectRef();
  const [kind, setKind] = useState<"teach" | "practice">(
    () => useLearnDraftStore.getState().preferredKind,
  );
  const [draftId, setDraftId] = useState<DraftId | null>(null);
  const selection = useGraphSelection();
  const draft = useComposerDraftStore((state) => (draftId ? state.getDraftSession(draftId) : null));
  useEffect(() => {
    if (!project) return;
    const id = newDraftId();
    useComposerDraftStore.getState().setProjectDraftThreadId(project, id, {
      threadId: newThreadId(),
      envMode: "local",
      environmentSelection: "manual",
    });
    setDraftId(id);
  }, [project]);
  useEffect(() => {
    if (!draftId) return;
    useLearnDraftStore.getState().set(draftId, {
      kind,
      ...(selection.nodeIds.length
        ? { graphContext: { nodeIds: selection.nodeIds, text: selection.contextText } }
        : {}),
    });
  }, [draftId, kind, selection]);
  if (!draft || !draftId) return <GraphHome />;
  return (
    <ChatView
      routeKind="draft"
      draftId={draftId}
      threadId={draft.threadId}
      environmentId={draft.environmentId}
      learnHome={<GraphHome kind={kind} />}
      learnHomeControls={
        <div className="flex items-center gap-3">
          <ToggleGroup
            variant="default"
            size="sm"
            aria-label="Session kind"
            value={[kind]}
            onValueChange={(values) => {
              const value = values[0];
              if (value === "teach" || value === "practice") setKind(value);
            }}
          >
            <Toggle value="teach" variant="segmented">
              Teach
            </Toggle>
            <Toggle value="practice" variant="segmented">
              Practice
            </Toggle>
          </ToggleGroup>
          {selection.nodeIds.length ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {selection.nodeIds.length} nodes selected
            </span>
          ) : null}
        </div>
      }
    />
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
