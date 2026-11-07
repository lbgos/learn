// Ported from learnharness (AGPL-3.0-only) components/delete-session-dialog.tsx @ c549494.
import { useEffect, useRef, useState } from "react";
import type { ChatDeletionStats } from "@t3tools/learn/graph";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import type { LearnGraphData } from "./data";

/** The graph endpoint removes traces only; session deletion belongs to the sidebar. */
export function DeleteSourceDialog({
  sourceId,
  title,
  data,
  onClose,
}: {
  sourceId: string;
  title: string;
  data: LearnGraphData;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<ChatDeletionStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const deleting = useRef(false);
  useEffect(() => {
    let active = true;
    setError(null);
    setPreview(null);
    void data
      .previewDeletion(sourceId)
      .then((result) => {
        if (active) setPreview(result);
      })
      .catch((failure: unknown) => {
        if (active)
          setError(failure instanceof Error ? failure.message : "Deletion preview failed.");
      });
    return () => {
      active = false;
    };
  }, [sourceId, data.previewDeletion, retry]);

  const confirm = async () => {
    if (!preview || deleting.current) return;
    deleting.current = true;
    setBusy(true);
    setError(null);
    try {
      await data.deleteSource(sourceId, "delete-nodes");
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Delete failed.");
    } finally {
      deleting.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !deleting.current) onClose();
      }}
    >
      <DialogPopup showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete source from graph?</DialogTitle>
          <DialogDescription>{title}</DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-4 text-sm">
          <p>This removes its graph traces. The session stays in the sidebar.</p>
          {preview && (
            <p className="mt-3">
              {preview.nodesRemoved} propositions and {preview.chainsRemoved} chains will be
              removed. Shared propositions survive.
            </p>
          )}
          {!preview && !error && (
            <p className="mt-3" role="status">
              Loading preview…
            </p>
          )}
          {error && (
            <div className="mt-3" role="alert">
              {error}
              {!preview && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Retry preview
                </Button>
              )}
            </div>
          )}
        </div>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!preview || busy}
            onClick={() => void confirm()}
          >
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
