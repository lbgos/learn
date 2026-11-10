import {
  LEARN_ENDPOINTS,
  MEMORY_NOTE_MAX_LENGTH,
  MEMORY_PAGE_MAX,
  type EnvironmentId,
  type LearnMemoryDreams,
  type MemoryNote,
  type MemoryNotesPage,
} from "@t3tools/contracts";
import { PinIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { useScopedSettingsWriteAllowed } from "../components/settings/useScopedSettings";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Toggle } from "../components/ui/toggle";
import { learnRequest } from "./http";

/** Notes the list shows at first, and how many more each "Show more" adds. */
const NOTES_PAGE = 50;
const CHANGES_SHOWN = 8;
const E = LEARN_ENDPOINTS;

const OP_WORDS: Record<LearnMemoryDreams["changes"][number]["op"], string> = {
  add: "Added",
  pin: "Pinned",
  unpin: "Unpinned",
  confirm: "Confirmed",
  rewrite: "Corrected",
  merge: "Merged",
  stale: "Marked stale",
  contradicted: "Marked contradicted",
  delete: "Deleted",
  expire: "Expired",
};

/** The first `limit` notes as the server orders them, read again whenever `revision` changes. */
function useNotes(
  environmentId: EnvironmentId,
  request: { query: string; retired: boolean; limit: number; revision: number },
) {
  const [page, setPage] = useState<MemoryNotesPage | null>(null);
  const { query, retired, limit, revision } = request;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads notes from the server; revision marks an edit
  useEffect(() => {
    const controller = new AbortController();
    const read = async () => {
      const notes: MemoryNote[] = [];
      let total = 0;
      // The server pages at most MEMORY_PAGE_MAX notes per request.
      for (let offset = 0; offset < limit; offset += MEMORY_PAGE_MAX) {
        const next = await learnRequest(
          environmentId,
          E.memoryNotes,
          {
            offset,
            limit: Math.min(MEMORY_PAGE_MAX, limit - offset),
            ...(query.trim() ? { query: query.trim() } : {}),
            ...(retired ? { retired: true } : {}),
          },
          controller.signal,
        );
        notes.push(...next.notes);
        total = next.total;
        if (notes.length >= total) break;
      }
      return { notes, total };
    };
    read().then(setPage, () => undefined);
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a revision bump means the notes changed on the server, so they are read again.
  }, [environmentId, query, retired, limit, revision]);
  return page;
}

/** The nightly check's state, read again every few seconds while a run is in progress. */
function useDreams(environmentId: EnvironmentId, revision: number) {
  const [dreams, setDreams] = useState<LearnMemoryDreams | null>(null);
  const running = dreams?.running === true;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the check's state from the server; a running check is read again until it ends
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        learnRequest(environmentId, E.memoryDreams, {}, controller.signal).then(
          setDreams,
          () => undefined,
        ),
      running ? 3000 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a revision bump or a run that ends means the state changed on the server, so it is read again.
  }, [environmentId, revision, running]);
  return [dreams, setDreams] as const;
}

type Act = (request: () => Promise<unknown>) => void;

function NoteRow({
  environmentId,
  note,
  retired,
  canWrite,
  act,
}: {
  environmentId: EnvironmentId;
  note: MemoryNote;
  retired: boolean;
  canWrite: boolean;
  act: Act;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const meta = [
    note.status === "fresh" ? null : note.status,
    note.source.at.slice(0, 10),
    note.source.by === "user" ? "you" : note.source.by,
    note.until ? `until ${note.until}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex items-start gap-2 py-1.5">
      <div className="min-w-0 flex-1">
        {draft === null ? (
          <button
            type="button"
            className="block w-full text-left text-sm"
            disabled={!canWrite || retired}
            onClick={() => setDraft(note.text)}
          >
            {note.text}
          </button>
        ) : (
          <Input
            nativeInput
            size="sm"
            autoFocus
            aria-label="Note text"
            value={draft}
            maxLength={MEMORY_NOTE_MAX_LENGTH}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => {
              if (draft !== note.text)
                act(() => learnRequest(environmentId, E.memoryEdit, { id: note.id, text: draft }));
              setDraft(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setDraft(null);
            }}
          />
        )}
        <p className="text-muted-foreground text-xs">{meta}</p>
      </div>
      {retired ? null : (
        <Toggle
          size="sm"
          aria-label="Pin"
          pressed={note.pinned !== undefined}
          disabled={!canWrite}
          onPressedChange={(pinned) =>
            act(() => learnRequest(environmentId, E.memorySet, { id: note.id, pinned }))
          }
        >
          <PinIcon />
        </Toggle>
      )}
      <Button
        size="xs"
        variant={retired ? "outline" : "ghost-destructive"}
        disabled={!canWrite}
        onClick={() =>
          act(() =>
            retired
              ? learnRequest(environmentId, E.memorySet, { id: note.id, retired: false })
              : learnRequest(environmentId, E.memoryEdit, { id: note.id, text: "" }),
          )
        }
      >
        {retired ? "Restore" : "Forget"}
      </Button>
    </li>
  );
}

/**
 * The tutor's notes about the learner and the nightly check that tidies them: search, add, edit,
 * pin, forget, restore what the tutor or the check removed, and undo the check's changes.
 */
function LearnMemorySection({
  environmentId,
  canWrite,
}: {
  environmentId: EnvironmentId;
  canWrite: boolean;
}) {
  const [query, setQuery] = useState("");
  const [retired, setRetired] = useState(false);
  const [limit, setLimit] = useState(NOTES_PAGE);
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);
  const page = useNotes(environmentId, { query, retired, limit, revision });
  const [dreams, setDreams] = useDreams(environmentId, revision);
  const act: Act = (request) => {
    setError(null);
    request().then(
      () => setRevision((value) => value + 1),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : "Request failed."),
    );
  };
  const lastRun = dreams?.lastRun;
  return (
    <SettingsSection id="learning-memory" title="Memory" variant="plain">
      <SettingsRow
        id="learning-memory-check"
        title={<label htmlFor="learning-memory-check-control">Nightly check</label>}
        description={
          dreams?.running
            ? "Checking now."
            : lastRun
              ? `Last ${lastRun.at.slice(0, 16).replace("T", " ")}: ${lastRun.summary}${lastRun.errors.length ? `. ${lastRun.errors.join(" ")}` : ""}`
              : "Merges, corrects and retires notes at 03:30 on the Review route, after a backup."
        }
        control={
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite || dreams === null || dreams.running}
              onClick={() => {
                setError(null);
                learnRequest(environmentId, E.memoryDreamsRun, {}).then(setDreams, (cause) =>
                  setError(cause instanceof Error ? cause.message : "Request failed."),
                );
              }}
            >
              Run now
            </Button>
            <Switch
              size="sm"
              id="learning-memory-check-control"
              aria-label="Nightly check"
              checked={dreams?.enabled ?? false}
              disabled={!canWrite || dreams === null}
              onCheckedChange={(enabled) =>
                act(() => learnRequest(environmentId, E.memoryDreamsSet, { enabled }))
              }
            />
          </div>
        }
      />
      <div className="flex flex-col gap-2 py-2">
        <div className="flex gap-2">
          <Input
            nativeInput
            size="sm"
            aria-label="Search notes"
            placeholder={retired ? "Search removed notes" : "Search notes"}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setLimit(NOTES_PAGE);
            }}
          />
          <Toggle
            size="sm"
            pressed={retired}
            onPressedChange={(pressed) => {
              setRetired(pressed);
              setLimit(NOTES_PAGE);
            }}
          >
            Removed
          </Toggle>
        </div>
        {retired ? null : (
          <Input
            nativeInput
            size="sm"
            aria-label="Add a note"
            placeholder="Add a note"
            value={adding}
            maxLength={MEMORY_NOTE_MAX_LENGTH}
            disabled={!canWrite}
            onChange={(event) => setAdding(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !adding.trim()) return;
              const text = adding;
              setAdding("");
              act(() => learnRequest(environmentId, E.memoryEdit, { id: null, text }));
            }}
          />
        )}
        {error ? <p className="text-destructive text-xs">{error}</p> : null}
        {page === null ? null : (
          <>
            <p className="text-muted-foreground text-xs">
              {page.total} {page.total === 1 ? "note" : "notes"}
            </p>
            <ul className="divide-y divide-border">
              {page.notes.map((note) => (
                <NoteRow
                  key={note.id}
                  environmentId={environmentId}
                  note={note}
                  retired={retired}
                  canWrite={canWrite}
                  act={act}
                />
              ))}
            </ul>
            {page.notes.length < page.total ? (
              <Button size="xs" variant="ghost" onClick={() => setLimit(limit + NOTES_PAGE)}>
                Show {Math.min(NOTES_PAGE, page.total - page.notes.length)} more
              </Button>
            ) : null}
          </>
        )}
      </div>
      {dreams && dreams.changes.length > 0 ? (
        <ul className="divide-y divide-border">
          {dreams.changes.slice(0, CHANGES_SHOWN).map((change) => (
            <li key={change.id} className="flex items-start gap-2 py-1.5">
              <p className="min-w-0 flex-1 text-sm">
                {OP_WORDS[change.op]}: {(change.after[0] ?? change.before[0])?.text}
                {change.reason ? (
                  <span className="text-muted-foreground"> ({change.reason})</span>
                ) : null}
              </p>
              <Button
                size="xs"
                variant="outline"
                disabled={!canWrite || change.undone === true}
                onClick={() =>
                  act(() =>
                    learnRequest(environmentId, E.memoryDreamsUndo, { id: change.id }).then(
                      setDreams,
                    ),
                  )
                }
              >
                {change.undone ? "Undone" : "Undo"}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsSection>
  );
}

/** Settings → Memory: the learner's notes on the selected environment. */
export function LearnMemorySettingsPanel() {
  const { environment, scope } = useSettingsScope();
  const writable = useScopedSettingsWriteAllowed();
  const environmentWide = scope.kind === "all" || scope.kind === "environment";
  return (
    <SettingsPageContainer width="wide">
      {environment && environmentWide ? (
        <LearnMemorySection
          key={environment.environmentId}
          environmentId={environment.environmentId}
          canWrite={writable}
        />
      ) : (
        <p className="text-sm">Select an environment to see its learner notes.</p>
      )}
    </SettingsPageContainer>
  );
}
