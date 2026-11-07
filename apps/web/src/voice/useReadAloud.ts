import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { synthesizeText } from "./client";
import { isLikelyEnglish, toSpeakable } from "./toSpeakable";

export type ReadAloudState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "playing" }
  | { readonly status: "error"; readonly message: string };

// Reply actions share one playback owner, including pending synthesis.
let stopCurrentPlayback: (() => void) | undefined;
export function useReadAloud(options?: { readonly environmentId?: EnvironmentId }) {
  const [state, setState] = useState<ReadAloudState>({ status: "idle" });
  const controller = useRef<AbortController | undefined>(undefined);
  const audio = useRef<HTMLAudioElement | undefined>(undefined);
  const objectUrl = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const cleanup = useCallback(() => {
    controller.current?.abort();
    controller.current = undefined;
    if (audio.current) {
      audio.current.onended = null;
      audio.current.onerror = null;
      audio.current.pause();
      audio.current.removeAttribute("src");
      audio.current.load();
      audio.current = undefined;
    }
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = undefined;
    }
  }, []);
  const stop = useCallback(() => {
    cleanup();
    if (mounted.current) setState({ status: "idle" });
  }, [cleanup]);
  const speak = useCallback(
    async (markdown: string) => {
      stopCurrentPlayback?.();
      stopCurrentPlayback = stop;
      const text = toSpeakable(markdown);
      if (!isLikelyEnglish(text)) {
        setState({ status: "error", message: "Kokoro has no voice for this language" });
        return;
      }
      if (!text) {
        setState({ status: "error", message: "No text to read aloud" });
        return;
      }
      if (text.length > 4000) {
        setState({ status: "error", message: "Read-aloud text exceeds 4000 characters" });
        return;
      }
      const active = new AbortController();
      controller.current = active;
      setState({ status: "loading" });
      try {
        const wav = await synthesizeText(text, active.signal, options?.environmentId);
        if (active.signal.aborted || !mounted.current) return;
        objectUrl.current = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
        const player = new Audio(objectUrl.current);
        audio.current = player;
        player.onended = stop;
        player.onerror = () => {
          cleanup();
          if (mounted.current) setState({ status: "error", message: "Could not play voice audio" });
        };
        await player.play();
        if (!active.signal.aborted && mounted.current) setState({ status: "playing" });
      } catch (error) {
        if (active.signal.aborted || !mounted.current) return;
        cleanup();
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Read-aloud failed",
        });
      }
    },
    [cleanup, options?.environmentId, stop],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cleanup();
      if (stopCurrentPlayback === stop) stopCurrentPlayback = undefined;
    };
  }, [cleanup, stop, options?.environmentId]);
  return { state, speak, stop };
}
