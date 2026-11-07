import { simRuntimeBundle } from "./sim/runtimeBundle.ts";
import type { SimAppearance } from "./sim/types.ts";

export { simRuntimeBundle };
export type * from "./sim/types.ts";

/** Inject into sandbox="allow-scripts" srcdoc. Check event.source against iframe.contentWindow;
 * its opaque origin is intentionally "null". All scripts, Three.js and styles are local. */
export function buildSimDocument(options: {
  code: string;
  mode: "interactive" | "headless";
  appearance?: SimAppearance;
}): string {
  const boot = JSON.stringify({ ...options, appearance: options.appearance ?? {} })
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'"><title>Physics simulation</title><style>html,body,#physics-root{margin:0;width:100%;height:100%;overflow:hidden;background:#000;color:#fff}canvas{display:block;touch-action:none}#physics-root>canvas{width:100%;height:auto}#physics-root{position:relative}#physics-probes{position:absolute;inset:0;pointer-events:none;font:11px/1.35 ui-monospace,monospace;color:#fff}#physics-probes>div{position:absolute;left:0;top:0;white-space:pre}.probe{background:rgba(0,0,0,.7);padding:1px 3px}.probe-marker{width:6px;height:6px;box-sizing:border-box;border:1px solid #fff;border-radius:50%}</style></head><body><div id="physics-root"></div><script>window.__physicsBoot=${boot};</script><script>${simRuntimeBundle.replaceAll("</script", "<\\/script")}</script></body></html>`;
}
