import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { startPcmCapture, type CaptureSource } from "./capture";
import { transcribePcm } from "./client";
import { createDictation, type DictationState } from "./dictation";

export type { DictationState } from "./dictation";
export function useDictation(options: {
  readonly onText: (text: string) => void;
  readonly language?: string;
  readonly environmentId?: EnvironmentId;
  readonly capture?: CaptureSource;
}) {
  const [state, setState] = useState<DictationState>({ status: "idle" });
  const onText = useRef(options.onText);
  onText.current = options.onText;
  const controller = useRef<ReturnType<typeof createDictation> | undefined>(undefined);
  useEffect(() => {
    const active = createDictation({
      capture: options.capture ?? startPcmCapture,
      transcribe: (pcm, signal) =>
        transcribePcm(pcm, options.language, signal, options.environmentId),
      onText: (text) => onText.current(text),
      onState: setState,
    });
    controller.current = active;
    setState({ status: "idle" });
    return () => {
      active.dispose();
      controller.current = undefined;
    };
  }, [options.capture, options.language, options.environmentId]);
  const start = useCallback(() => controller.current?.start(), []);
  const stop = useCallback(() => controller.current?.stop(), []);
  const toggle = useCallback(() => controller.current?.toggle(), []);
  return { state, start, stop, toggle };
}
