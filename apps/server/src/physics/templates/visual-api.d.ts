/** Inline explainers: self-contained visuals/<slug>.html with native controls and
 * inline SVG/canvas. They do not need window.lbgosVisual. Compute diagrams and
 * readouts from control values; redraw only on input/change and resize.
 * Use numbered captions above responsive panels, plain values with units,
 * transparent background and var(--foreground) on the host's #000 background.
 * No decorative cards/pills, timers, CSS animations or continuous frame loops.
 * Check with html_preview at 728px and 360px. Return { path, title, height } to
 * the tutor, who shows it with html_render({ path }) in the learner's thread.
 * The interfaces below apply only to visual_run/visual_show step animations. */

interface LbgosVisualStep {
  /** One sentence of the explanation. Steps are zero-based. */
  label: string;
  /** Playback duration in milliseconds, 100..30000; defaults to 1500. */
  duration?: number;
}
interface LbgosVisual {
  /** 1..32 ordered steps. */
  steps: LbgosVisualStep[];
  /** One or two short sentences per step: what to watch and what it means.
   * Inline LaTeX uses $...$ or \\( ... \\). Captions appear in the host, not the canvas. */
  captions: string[];
  /** Synchronous, deterministic redraw. t is 0..1; seeking backwards must work.
   * Do not use timers, requestAnimationFrame, CSS animations or transitions.
   * The host renders on seek and only requests animation frames while playing. */
  render(step: number, t: number): void;
}
interface Window {
  lbgosVisual: LbgosVisual;
}
