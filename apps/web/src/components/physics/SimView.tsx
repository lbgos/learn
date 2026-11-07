import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { replayFrameKey, useHtmlRenderShortcuts } from "~/hooks/useHtmlRenderShortcuts";
import type { SimHost, SimKeyDown } from "~/physics/simHost";
import { isSimShortcut, SIM_SHORTCUT_COMMANDS, simKeyToReplay } from "~/physics/simKeys";

/** Height the runtime reserves for its own plot canvas; the host draws plots itself. */
const runtimePlotsHeight = (groups: number) => Math.min(240, 100 * groups);

/**
 * The sandboxed sim iframe. The document is built from the first `code` and never rebuilt; later
 * source changes go through `host.load`, which keeps the WebGL context. The runtime draws its own
 * plots under the viewport, so the iframe is taller than its box and the overflow is clipped.
 * Keys the focused sim passes on replay as app shortcuts, the way a focused HTML render's do.
 */
export function SimView(props: { host: SimHost; code: string; threadRef: ScopedThreadRef }) {
  const { host, code, threadRef } = props;
  const bootCode = useRef(code);
  const loadedCode = useRef(code);
  const [srcDoc, setSrcDoc] = useState<string>();
  const meta = useSyncExternalStore(host.subscribe, () => host.getSnapshot().meta);

  // The three.js runtime is ~730 KB; it loads only when a sim mounts.
  useEffect(() => {
    let live = true;
    void import("@t3tools/physics/sim").then(({ buildSimDocument }) => {
      if (live) setSrcDoc(buildSimDocument({ code: bootCode.current, mode: "interactive" }));
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    window.addEventListener("message", host.handleMessage);
    return () => window.removeEventListener("message", host.handleMessage);
  }, [host]);

  const shortcutLists = useHtmlRenderShortcuts(threadRef, SIM_SHORTCUT_COMMANDS);
  const replayKey = useEffectEvent((key: SimKeyDown, frame: HTMLIFrameElement) => {
    const replay = simKeyToReplay(key);
    if (isSimShortcut(replay, shortcutLists)) replayFrameKey(frame, frame.contentWindow, replay);
  });
  useEffect(() => host.onKeyDown((key, frame) => replayKey(key, frame)), [host]);

  useEffect(() => {
    if (code === loadedCode.current) return;
    loadedCode.current = code;
    host.load(code);
  }, [code, host]);

  const attach = useCallback(
    (node: HTMLIFrameElement | null) => host.attach(node, bootCode.current),
    [host],
  );

  const extra = meta ? runtimePlotsHeight(meta.plots.length) : 0;
  return (
    <div className="relative size-full overflow-hidden bg-black">
      {srcDoc === undefined ? null : (
        <iframe
          ref={attach}
          title="Simulation"
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          className="absolute top-0 left-0 w-full border-0"
          style={{ height: `calc(100% + ${extra}px)` }}
        />
      )}
    </div>
  );
}
