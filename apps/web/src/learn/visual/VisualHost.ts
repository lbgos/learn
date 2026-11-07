import { readVisualMessage, type VisualStep } from "@t3tools/physics/visual";

export interface VisualState {
  readonly steps: readonly VisualStep[];
  readonly captions: readonly string[];
  readonly step: number;
  readonly t: number;
  readonly playing: boolean;
  readonly error: string | null;
}

/** Host owns the only animation clock. No frame is requested after a step finishes. */
export class VisualHost {
  private target: Window | null = null;
  private frame: number | null = null;
  private listeners = new Set<() => void>();
  private state: VisualState = {
    steps: [],
    captions: [],
    step: 0,
    t: 1,
    playing: false,
    error: null,
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  private update(patch: Partial<VisualState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  attach(target: Window, step = 0) {
    this.pause();
    this.target = target;
    this.update({ steps: [], captions: [], step, t: 1, error: null });
  }
  connect() {
    this.target?.postMessage({ channel: "lbgos-visual", type: "init" }, "*");
  }
  detach() {
    this.pause();
    this.target = null;
  }
  receive(event: Pick<MessageEvent<unknown>, "source" | "data">) {
    if (this.target === null || event.source !== this.target) return;
    const message = readVisualMessage(event.data);
    if (!message) return;
    if (message.type === "error") {
      this.pause();
      this.update({ error: message.message });
    } else {
      this.update({ steps: message.steps, captions: message.captions, error: null });
      this.seek(this.state.step, 1);
    }
  }
  seek(step: number, t = 1) {
    if (!Number.isFinite(step) || !Number.isFinite(t)) return;
    this.pause();
    this.update({
      step: Math.max(
        0,
        Math.min(this.state.steps.length ? this.state.steps.length - 1 : 31, Math.trunc(step)),
      ),
      t: Math.max(0, Math.min(1, t)),
    });
    this.render();
  }
  private render() {
    if (this.state.steps.length === 0 || this.state.error) return;
    this.target?.postMessage(
      { channel: "lbgos-visual", type: "render", step: this.state.step, t: this.state.t },
      "*",
    );
  }
  pause = () => {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.state.playing) this.update({ playing: false });
  };
  play = () => {
    if (!this.target || this.state.steps.length === 0 || this.state.error) return;
    this.pause();
    const duration = this.state.steps[this.state.step]?.duration ?? 1500;
    const start = performance.now();
    this.update({ playing: true, t: 0 });
    this.render();
    const tick = (now: number) => {
      this.frame = null;
      // A queued frame's timestamp can precede the click's performance.now().
      const t = Math.max(0, Math.min(1, (now - start) / duration));
      this.update({ t, playing: t < 1 });
      this.render();
      if (t < 1) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  };
}
