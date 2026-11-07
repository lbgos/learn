export interface VisualStep {
  readonly label: string;
  /** Milliseconds; the host defaults to 1500. */
  readonly duration?: number;
}
export type VisualMessage =
  | {
      readonly channel: "lbgos-visual";
      readonly type: "ready";
      readonly steps: readonly VisualStep[];
      readonly captions: readonly string[];
    }
  | { readonly channel: "lbgos-visual"; readonly type: "error"; readonly message: string };

/** A short voiceover per scene. Strip inline math before counting sentence endings. */
export function visualCaptionError(value: unknown, count: number): string | undefined {
  if (!Array.isArray(value) || value.length !== count)
    return "captions must contain one caption for every step.";
  for (const caption of value) {
    if (typeof caption !== "string" || !caption.trim() || caption.length > 480)
      return "Each caption needs 1..480 characters, about two short sentences.";
    const prose = caption.replace(/\$[^$]*\$|\\\([^]*?\\\)/g, "math");
    if ((prose.match(/[.!?]+(?:\s|$)/g) ?? []).length > 2)
      return "Each caption must be at most two short sentences.";
  }
}

/** Opaque-origin frames must also be checked by event.source in the host. */
export function readVisualMessage(value: unknown): VisualMessage | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("channel" in value) ||
    value.channel !== "lbgos-visual" ||
    !("type" in value)
  )
    return;
  if (value.type === "error" && "message" in value && typeof value.message === "string")
    return { channel: "lbgos-visual", type: "error", message: value.message };
  if (
    value.type !== "ready" ||
    !("steps" in value) ||
    !Array.isArray(value.steps) ||
    value.steps.length === 0 ||
    value.steps.length > 32 ||
    !("captions" in value) ||
    !Array.isArray(value.captions) ||
    (value.captions.length !== 0 &&
      visualCaptionError(value.captions, value.steps.length) !== undefined)
  )
    return;
  const steps: VisualStep[] = [];
  const candidates: readonly unknown[] = value.steps;
  for (const step of candidates) {
    if (
      typeof step !== "object" ||
      step === null ||
      !("label" in step) ||
      typeof step.label !== "string" ||
      !step.label.trim() ||
      step.label.length > 240
    )
      return;
    const duration = "duration" in step ? step.duration : undefined;
    if (
      duration !== undefined &&
      (typeof duration !== "number" ||
        !Number.isFinite(duration) ||
        duration < 100 ||
        duration > 30000)
    )
      return;
    steps.push({
      label: step.label,
      ...(duration === undefined ? {} : { duration }),
    });
  }
  return { channel: "lbgos-visual", type: "ready", steps, captions: value.captions as string[] };
}

// The same validator/render entry point is used by the iframe and visual_run.
function createVisualRuntime(allowMissingCaptions = false): string {
  return String.raw`(() => {
  const allowMissingCaptions = ${allowMissingCaptions};
  const channel = "lbgos-visual";
  const captionError = ${visualCaptionError.toString()};
  const send = (message) => parent.postMessage({ channel, ...message }, "*");
  window.__lbgosVisualCheck = (step, t) => {
    const errors = [];
    let steps = [];
    let captions = [];
    try {
      const visual = window.lbgosVisual;
      if (!visual || typeof visual.render !== "function" || !Array.isArray(visual.steps) || visual.steps.length === 0 || visual.steps.length > 32)
        throw new Error("window.lbgosVisual needs render(step, t) and 1..32 steps.");
      steps = visual.steps.map((s) => {
        if (!s || typeof s.label !== "string" || !s.label.trim() || s.label.length > 240)
          throw new Error("Each step needs a nonempty label of at most 240 characters.");
        if (s.duration !== undefined && (!Number.isFinite(s.duration) || s.duration < 100 || s.duration > 30000))
          throw new Error("Step duration must be 100..30000 milliseconds.");
        return { label: s.label, ...(s.duration === undefined ? {} : { duration: s.duration }) };
      });
      const missingCaptions = visual.captions === undefined || (Array.isArray(visual.captions) && visual.captions.length === 0);
      const error = allowMissingCaptions && missingCaptions ? undefined : captionError(visual.captions, steps.length);
      if (error) throw new Error(error);
      captions = missingCaptions ? [] : visual.captions.slice();
      if (!Number.isInteger(step) || step < 0 || step >= steps.length || !Number.isFinite(t) || t < 0 || t > 1)
        throw new Error("Render needs an existing zero-based step and t in [0,1].");
      const result = visual.render(step, t);
      if (result && typeof result.then === "function") throw new Error("render must be synchronous.");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return { steps, captions, errors };
  };
  addEventListener("message", (event) => {
    const m = event.data;
    if (event.source !== parent || !m || m.channel !== channel) return;
    if (m.type === "init") {
      const result = window.__lbgosVisualCheck(0, 1);
      if (result.errors.length) for (const message of result.errors) send({ type: "error", message });
      else send({ type: "ready", steps: result.steps, captions: result.captions });
      return;
    }
    if (m.type !== "render") return;
    const result = window.__lbgosVisualCheck(m.step, m.t);
    for (const message of result.errors) send({ type: "error", message });
  });
  const result = window.__lbgosVisualCheck(0, 1);
  if (result.errors.length) for (const message of result.errors) send({ type: "error", message });
  else send({ type: "ready", steps: result.steps, captions: result.captions });
})();`;
}

export const visualRuntime = createVisualRuntime();

/** Offline HTML, used both in the sandboxed viewer and headless checks. */
export function buildVisualDocument(
  html: string,
  options: { readonly allowMissingCaptions?: boolean } = {},
): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000;color:#fff}body>svg{display:block;width:100%;height:100%}*,*::before,*::after{animation:none!important;transition:none!important}</style><script>for (const name of ['requestAnimationFrame','setTimeout','setInterval']) window[name] = () => { throw new Error('The visual host owns playback; timers are not allowed.'); };</script>${html.replace(/<!doctype[^>]*>/i, "")}<script>${createVisualRuntime(options.allowMissingCaptions)}</script>`;
}
