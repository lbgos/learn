import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type EnvironmentId } from "@t3tools/contracts";
import { SquareIcon, Volume2Icon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../components/ui/button";
import { primaryServerSettingsAtom, serverEnvironment } from "../state/server";
import { useReadAloud } from "./useReadAloud";

/**
 * Read-aloud action for an assistant message, following Settings → Learning → read-aloud:
 * hidden when off, a button when manual, and in auto mode it also speaks once when the
 * message finishes streaming while on screen (history never auto-plays).
 */
export function AssistantReadAloud({
  markdown,
  streaming,
  environmentId,
  autoEligible = true,
}: {
  readonly markdown: string;
  readonly streaming: boolean;
  readonly environmentId?: EnvironmentId | undefined;
  readonly autoEligible?: boolean;
}) {
  const settings = useAtomValue(
    environmentId === undefined
      ? primaryServerSettingsAtom
      : serverEnvironment.settingsValueAtom(environmentId),
  );
  const mode = (settings ?? DEFAULT_SERVER_SETTINGS).learn.voice.readAloud;
  if (mode === "off") return null;
  return (
    <ReadAloudButton
      markdown={markdown}
      streaming={streaming}
      autoSpeak={mode === "auto" && autoEligible}
      {...(environmentId === undefined ? {} : { environmentId })}
    />
  );
}

function ReadAloudButton({
  markdown,
  environmentId,
  streaming = false,
  autoSpeak = false,
}: {
  readonly markdown: string;
  readonly environmentId?: EnvironmentId;
  readonly streaming?: boolean;
  readonly autoSpeak?: boolean;
}) {
  const { state, speak, stop } = useReadAloud(
    environmentId === undefined ? undefined : { environmentId },
  );
  const wasStreaming = useRef(streaming);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts audio playback once when the server finishes streaming this reply; no handler sees that moment
  useEffect(() => {
    const finished = wasStreaming.current && !streaming;
    wasStreaming.current = streaming;
    if (finished && autoSpeak) void speak(markdown);
  }, [autoSpeak, markdown, speak, streaming]);
  if (streaming) return null;
  const active = state.status === "playing" || state.status === "loading";
  return (
    <span className="-ms-2.5 inline-flex items-center gap-1">
      <Button
        variant="ghost-muted"
        size="sm"
        onClick={() => (active ? stop() : void speak(markdown))}
        aria-label={active ? "Stop read-aloud" : "Read aloud"}
        aria-pressed={active}
      >
        {active ? <SquareIcon /> : <Volume2Icon />}
        <span>
          {state.status === "loading"
            ? "Loading speech"
            : state.status === "playing"
              ? "Stop reading"
              : state.status === "error"
                ? state.message
                : "Read aloud"}
        </span>
      </Button>
    </span>
  );
}
