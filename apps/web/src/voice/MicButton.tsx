import { MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { EnvironmentId } from "@t3tools/contracts";
import type { DictationState } from "./dictation";
import { useDictation } from "./useDictation";

function MicButton({
  state,
  toggle,
}: {
  readonly state: DictationState;
  readonly toggle: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const startedAt = state.status === "listening" ? state.startedAt : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a 1 Hz wall clock drives the m:ss label while listening
  useEffect(() => {
    if (startedAt === undefined) return;
    // oxlint-disable-next-line react/set-state-in-effect -- the label starts from now, not from the last listen's tick
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000));
  const label =
    state.status === "listening"
      ? `Listening ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
      : state.status === "transcribing"
        ? "Transcribing"
        : state.status === "error"
          ? state.message
          : null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={toggle}
        disabled={state.status === "transcribing"}
        aria-label={state.status === "listening" ? "Stop dictation" : "Start dictation"}
        aria-pressed={state.status === "listening"}
      >
        {state.status === "listening" ? <SquareIcon className="fill-current" /> : <MicIcon />}
      </Button>
      {label === null ? null : (
        // Capped so a long error never pushes the model picker out of the footer.
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="status"
                className={cn(
                  "max-w-24 truncate text-xs sm:max-w-96",
                  state.status === "error" ? "text-error-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            }
          />
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
      )}
    </span>
  );
}

/** Mic toggle that owns its dictation session; transcripts go to `onText`. */
export function DictationButton({
  onText,
  environmentId,
}: {
  readonly onText: (text: string) => void;
  readonly environmentId?: EnvironmentId;
}) {
  const { state, toggle } = useDictation(
    environmentId === undefined ? { onText } : { onText, environmentId },
  );
  return <MicButton state={state} toggle={toggle} />;
}
