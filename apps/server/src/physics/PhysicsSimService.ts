import { buildVisualDocument } from "@t3tools/physics/visual";
import { buildSimDocument } from "@t3tools/physics/sim";
import { renderBoardSvg, type Board } from "@t3tools/physics/board";
import {
  PhysicsVisualCheck,
  PhysicsSimMeasureRun,
  PhysicsSimMeta,
  PhysicsSimRunError,
  PhysicsSimRunResult,
  type PhysicsSimMeasureOptions,
  type PhysicsSimOptions,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HeadlessChrome from "../htmlRender/headlessChrome.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";
import * as PhysicsFiles from "./PhysicsFiles.ts";

const encodeOptions = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export class PhysicsSimError extends Schema.TaggedError<PhysicsSimError>()("PhysicsSimError", {
  operation: Schema.Literals(["run", "board-image", "visual"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    if (this.operation === "visual" && Array.isArray(this.cause))
      return `Visual validation failed: ${this.cause.join("; ")}`;
    return `Physics ${this.operation} failed. Check that the headless preview browser is installed and can run on this host.`;
  }
}
export interface PhysicsCapture {
  readonly screenshot: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
  readonly consoleMessages: readonly HeadlessChrome.ConsoleMessage[];
}
type SimCapture = Omit<PhysicsCapture, "screenshot"> & {
  readonly screenshot?: PhysicsCapture["screenshot"];
};

export interface VisualRunResult {
  readonly path: string;
  readonly passed: boolean;
  readonly steps: typeof PhysicsVisualCheck.Type.steps;
  readonly errors: readonly string[];
  readonly consoleMessages: readonly HeadlessChrome.ConsoleMessage[];
  readonly screenshots: readonly (PhysicsCapture["screenshot"] & {
    readonly step: number;
    readonly t: number;
  })[];
}

export class PhysicsSimService extends Context.Service<
  PhysicsSimService,
  {
    readonly run: (
      projectRoot: string,
      path: string,
      options: PhysicsSimOptions,
    ) => Effect.Effect<
      PhysicsSimRunResult & SimCapture,
      PhysicsSimError | PhysicsFiles.PhysicsFileError
    >;
    readonly runSource: (
      code: string,
      options: PhysicsSimOptions,
    ) => Effect.Effect<PhysicsSimRunResult & SimCapture, PhysicsSimError>;
    /** Headless run that records every crossing of one observable level, checked per step. */
    readonly measure: (
      projectRoot: string,
      path: string,
      options: PhysicsSimMeasureOptions,
    ) => Effect.Effect<
      typeof PhysicsSimMeasureRun.Type,
      PhysicsSimError | PhysicsFiles.PhysicsFileError
    >;
    readonly runVisualSource: (
      html: string,
      path: string,
    ) => Effect.Effect<VisualRunResult, PhysicsSimError>;
    readonly renderBoard: (board: Board) => Effect.Effect<PhysicsCapture, PhysicsSimError>;
  }
>()("t3/physics/PhysicsSimService") {}

const make = Effect.gen(function* () {
  const files = yield* PhysicsFiles.PhysicsFiles;
  const browser = yield* PreviewBrowser.PreviewBrowser;
  const environment = yield* HostProcess.Environment;
  const noSandbox = PreviewBrowserHost.sandboxDisabled(environment);
  const permit = yield* Semaphore.make(1);
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  /** One headless run under the run permit and watchdog; a timeout becomes a phased error. */
  const evaluate = Effect.fn("PhysicsSimService.evaluate")(function* <
    A extends PhysicsSimRunResult,
  >(
    code: string,
    options: PhysicsSimOptions & { readonly crossing?: PhysicsSimMeasureOptions["crossings"] },
    result: Schema.Decoder<A>,
    empty: Omit<A, keyof PhysicsSimRunResult>,
  ) {
    const html = buildSimDocument({ code, mode: "headless" });
    const duration = options.duration ?? 5;
    // Simulated seconds are computed, not played in real time. Allow startup
    // plus 100 ms per simulated second, capped at 15 s for the longest run.
    const timeoutMs = Math.min(15_000, 3_000 + Math.floor(duration) * 100);
    let progress: {
      phase: PhysicsSimRunResult["errors"][number]["phase"];
      hook: string;
      meta: PhysicsSimRunResult["meta"];
    } = {
      phase: "load",
      hook: "startup or module evaluation",
      meta: { title: "Simulation", view: "3d", params: {}, observables: [], plots: [] },
    };
    const decodeProgress = Schema.decodeUnknownOption(
      Schema.Struct({
        phase: PhysicsSimRunError.fields.phase,
        hook: Schema.String,
        meta: PhysicsSimMeta,
      }),
    );
    return yield* permit.withPermit(
      Effect.gen(function* () {
        const executable = yield* browser.executable;
        const capture = yield* HeadlessChrome.evaluateHtml({
          executable,
          noSandbox,
          html,
          width: 900,
          timeoutMs,
          onProgress: (value) => {
            const decoded = decodeProgress(value);
            if (Option.isSome(decoded)) progress = decoded.value;
          },
          expression: `window.__physicsHeadless.run(${encodeOptions({ ...options, duration: duration, samples: options.samples ?? 20 })})`,
          result,
        }).pipe(Effect.provideContext(services));
        return {
          ...capture.result,
          consoleMessages: capture.consoleMessages,
          screenshot: {
            mimeType: "image/png" as const,
            data: capture.png,
            width: capture.width,
            height: capture.height,
          },
        };
      }).pipe(
        Effect.catchTags({
          HtmlEvaluateTimeout: () =>
            Effect.succeed({
              meta: progress.meta,
              table: [],
              finalState: {},
              errors: [
                {
                  phase: progress.phase,
                  message: `Sim code did not finish within ${timeoutMs / 1000} s; check for an infinite loop in ${progress.hook}.`,
                },
              ],
              consoleMessages: [],
              ...empty,
            }),
        }),
        Effect.mapError((cause) => new PhysicsSimError({ operation: "run", cause })),
      ),
    );
  });
  const runSource = (code: string, options: PhysicsSimOptions) =>
    evaluate(code, options, PhysicsSimRunResult, {});
  const run = (root: string, path: string, options: PhysicsSimOptions) =>
    files.readSim(root, path).pipe(Effect.flatMap((sim) => runSource(sim.code, options)));
  const measure = (root: string, path: string, options: PhysicsSimMeasureOptions) =>
    files.readSim(root, path).pipe(
      Effect.flatMap((sim) =>
        evaluate(
          sim.code,
          {
            ...(options.params ? { params: options.params } : {}),
            duration: options.duration ?? 10,
            samples: 2,
            crossing: options.crossings,
          },
          PhysicsSimMeasureRun,
          { crossings: [] },
        ),
      ),
      // The measuring run returns no screenshot; callers get only numbers.
      Effect.map(({ meta, table, errors, finalState, crossings }) => ({
        meta,
        table,
        errors,
        finalState,
        crossings,
      })),
    );
  const runVisualSource = Effect.fn("PhysicsSimService.runVisualSource")(function* (
    source: string,
    path: string,
  ) {
    const html = buildVisualDocument(source);
    return yield* permit.withPermit(
      Effect.gen(function* () {
        const executable = yield* browser.executable;
        const capture = (step: number, t: number, width = 540, height = 820) =>
          HeadlessChrome.evaluateHtml({
            executable,
            noSandbox,
            html,
            width,
            height,
            timeoutMs: 8000,
            settleFrames: false,
            // Seek backwards before the requested frame to check deterministic rendering.
            expression: `(() => {
              const errors = [];
              let result;
              for (const t of [1, 0, ${t}]) {
                result = window.__lbgosVisualCheck(${step}, t);
                errors.push(...result.errors);
              }
              return { steps: result.steps, captions: result.captions, errors: [...new Set(errors)] };
            })()`,
            result: PhysicsVisualCheck,
          }).pipe(Effect.provideContext(services));
        const first = yield* capture(0, 0.5);
        const errors: string[] = [];
        const consoleMessages: HeadlessChrome.ConsoleMessage[] = [];
        const screenshots: VisualRunResult["screenshots"][number][] = [];
        const addFrame = (frame: typeof first, step: number, t: number) => {
          errors.push(
            ...frame.result.errors.map(
              (error) => `Step ${step}, t=${t}, ${frame.width}×${frame.height}: ${error}`,
            ),
          );
          consoleMessages.push(...frame.consoleMessages);
          screenshots.push({
            step,
            t,
            mimeType: "image/png",
            data: frame.png,
            width: frame.width,
            height: frame.height,
          });
        };
        addFrame(first, 0, 0.5);
        if (errors.length === 0) {
          addFrame(yield* capture(0, 1), 0, 1);
          for (let step = 1; step < first.result.steps.length; step++) {
            for (const t of [0.5, 1]) addFrame(yield* capture(step, t), step, t);
          }
          const last = first.result.steps.length - 1;
          addFrame(yield* capture(last, 1, 390, 700), last, 1);
        }
        errors.push(
          ...consoleMessages
            .filter((message) => message.level === "error")
            .map((message) => message.text),
        );
        return {
          path,
          passed: errors.length === 0,
          steps: first.result.steps,
          errors: [...new Set(errors)],
          consoleMessages,
          screenshots,
        };
      }).pipe(
        Effect.catchTags({
          HtmlEvaluateTimeout: () =>
            Effect.succeed({
              path,
              passed: false,
              steps: [],
              errors: ["Visual did not finish within 8 seconds. Check for an infinite loop."],
              consoleMessages: [],
              screenshots: [],
            }),
        }),
        Effect.mapError((cause) => new PhysicsSimError({ operation: "run", cause })),
      ),
    );
  });
  const renderBoard = Effect.fn("PhysicsSimService.renderBoard")(function* (board: Board) {
    const svg = yield* Effect.try({
      try: () => renderBoardSvg(board, { width: 1200, height: 800 }),
      catch: (cause) => new PhysicsSimError({ operation: "board-image", cause }),
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;background:#000;color:white}</style></head><body>${svg}</body></html>`;
    return yield* permit.withPermit(
      Effect.gen(function* () {
        const executable = yield* browser.executable;
        const capture = yield* HeadlessChrome.captureHtmlScreenshot({
          executable,
          noSandbox,
          html,
          width: 1200,
          urlFragment: "",
          appearance: "dark",
        }).pipe(Effect.provideContext(services));
        return {
          consoleMessages: capture.consoleMessages,
          screenshot: {
            mimeType: "image/png" as const,
            data: capture.png,
            width: 1200,
            height: capture.capturedHeight,
          },
        };
      }).pipe(Effect.mapError((cause) => new PhysicsSimError({ operation: "board-image", cause }))),
    );
  });
  return PhysicsSimService.of({ run, runSource, measure, renderBoard, runVisualSource });
});
export const layer = Layer.effect(PhysicsSimService, make);
