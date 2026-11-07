import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { physicsEnvironment } from "./state";

const DEBOUNCE_MS = 1_000;

/**
 * Keeps one model-context note in step with `text`, at most once a second, and removes it when
 * the surface unmounts or its key changes. Empty text removes the note.
 */
export function useModelContextNote(target: {
  readonly environmentId: EnvironmentId;
  /** Undefined for a draft thread, which the server does not know yet; the note is skipped. */
  readonly threadId: ThreadId | undefined;
  readonly key: string;
  readonly text: string;
}): void {
  const { environmentId, threadId, key, text } = target;
  const setContext = useAtomCommand(physicsEnvironment.setModelContext, { reportFailure: false });
  const sent = useRef("");

  useEffect(() => {
    if (threadId === undefined || text === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = text;
      void setContext({ environmentId, input: { threadId, key, text } });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [environmentId, key, setContext, text, threadId]);

  useEffect(
    () => () => {
      if (threadId === undefined || sent.current === "") return;
      sent.current = "";
      void setContext({ environmentId, input: { threadId, key, text: "" } });
    },
    [environmentId, key, setContext, threadId],
  );
}
