import type { ThemeAppearance } from "@t3tools/shared/themePalettes";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { publicProxy } from "./publicProxy.ts";

export class HtmlRenderBrowserError extends Schema.TaggedError<HtmlRenderBrowserError>()(
  "HtmlRenderBrowserError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    output: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
    signal: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const exit =
      this.exitCode !== undefined
        ? ` (exit code ${this.exitCode})`
        : this.signal !== undefined
          ? ` (signal ${this.signal})`
          : "";
    return `Headless Chrome could not render the page: ${this.reason}${exit}.`;
  }
}

export class HtmlEvaluateTimeout extends Schema.TaggedError<HtmlEvaluateTimeout>()(
  "HtmlEvaluateTimeout",
  { timeoutMs: Schema.Number },
) {}

type BrowserFailure = HtmlRenderBrowserError;

export interface ConsoleMessage {
  readonly level: "log" | "info" | "warning" | "error";
  readonly text: string;
}

const MAX_CONSOLE_MESSAGES = 20;
const MAX_CONSOLE_TEXT_CHARS = 500;
const VIEWPORT_HEIGHT = 800;
const MAX_CAPTURE_HEIGHT = 4_000;
const CAPTURE_TIMEOUT = "20 seconds";
// Chrome blocks file access; images arrive inlined. Browser-only .localhost permits secure contexts and HTTP resources.
// publicProxy blocks local networks; pinning the main frame and forbidding popups keeps captures on the page.
const PAGE_ORIGIN = "http://t3-page.localhost";
const PAGE_URL = `${PAGE_ORIGIN}/page.html`;
const PAGE_NAME = "page.html";
const MEASURE_CONCURRENCY = 3;

const textEncoder = new TextEncoder();

// Pages reach 25 MiB; use Node's encoder.
const pageBody = (html: string) =>
  Buffer.from(Buffer.from(html, "utf8").toString("base64"), "latin1");

const CdpMessage = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.Number),
    method: Schema.optional(Schema.String),
    sessionId: Schema.optional(Schema.String),
    params: Schema.optional(Schema.Unknown),
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ message: Schema.String })),
  }),
);
const decodeCdpMessage = Schema.decodeUnknownOption(CdpMessage);
const encodeCdpCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const RemoteObject = Schema.Struct({
  type: Schema.String,
  value: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
});
const decodeConsoleApiCalled = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.String, args: Schema.Array(RemoteObject) }),
);
const decodeExceptionThrown = Schema.decodeUnknownOption(
  Schema.Struct({
    exceptionDetails: Schema.Struct({
      text: Schema.String,
      exception: Schema.optional(RemoteObject),
    }),
  }),
);
const decodeRequestPaused = Schema.decodeUnknownOption(
  Schema.Struct({
    requestId: Schema.String,
    request: Schema.Struct({ url: Schema.String }),
    frameId: Schema.optional(Schema.String),
    resourceType: Schema.optional(Schema.String),
  }),
);
const decodeLogEntryAdded = Schema.decodeUnknownOption(
  Schema.Struct({
    entry: Schema.Struct({
      level: Schema.String,
      text: Schema.String,
      url: Schema.optional(Schema.String),
    }),
  }),
);

const remoteObjectText = (value: typeof RemoteObject.Type) =>
  typeof value.value === "string"
    ? value.value
    : (value.description ?? (value.value === undefined ? value.type : String(value.value)));

const CONSOLE_LEVELS: Readonly<Record<string, ConsoleMessage["level"]>> = {
  log: "log",
  debug: "log",
  dir: "log",
  dirxml: "log",
  table: "log",
  trace: "log",
  info: "info",
  warning: "warning",
  error: "error",
  assert: "error",
};

const consoleMessageFromEvent = (method: string, params: unknown): ConsoleMessage | undefined => {
  if (method === "Runtime.consoleAPICalled") {
    const event = Option.getOrUndefined(decodeConsoleApiCalled(params));
    const level = event === undefined ? undefined : CONSOLE_LEVELS[event.type];
    return event && level ? { level, text: event.args.map(remoteObjectText).join(" ") } : undefined;
  }
  if (method === "Runtime.exceptionThrown") {
    const details = Option.getOrUndefined(decodeExceptionThrown(params))?.exceptionDetails;
    return details
      ? { level: "error", text: details.exception?.description ?? details.text }
      : undefined;
  }
  if (method === "Log.entryAdded") {
    const entry = Option.getOrUndefined(decodeLogEntryAdded(params))?.entry;
    return entry && (entry.level === "error" || entry.level === "warning")
      ? { level: entry.level, text: entry.url ? `${entry.text} ${entry.url}` : entry.text }
      : undefined;
  }
  return undefined;
};

// Wait for fonts and two paint frames to capture late layout.
const SETTLE_EXPRESSION =
  "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))";
// scrollHeight is at least viewport height; use the root box for shorter pages.
const MEASURE_EXPRESSION =
  "(() => { const root = document.documentElement; return root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height; })()";

const Ignored = Schema.Unknown;
const Navigation = Schema.Struct({ errorText: Schema.optional(Schema.String) });
const Measured = Schema.Struct({ result: Schema.Struct({ value: Schema.Finite }) });

// Effect's spawner names the signal that ended a child only in its error message.
const EXIT_SIGNAL = /signal: '(SIG[A-Z0-9]+)'/;

interface PageEvents {
  readonly mainFrameId: string;
  body: Uint8Array | undefined;
  loaded: Deferred.Deferred<void, BrowserFailure> | undefined;
  readonly consoleMessages: Array<ConsoleMessage>;
  omittedConsoleMessages: number;
  readonly onProgress?: ((value: unknown) => void) | undefined;
}

// CDP pipe uses fd 3 in, fd 4 out and NUL-delimited JSON.
const launchBrowser = Effect.fnUntraced(function* (input: {
  readonly executable: string;
  readonly noSandbox: boolean;
  readonly profileDirectory: string;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const proxyPort = yield* publicProxy.pipe(
    Effect.mapError(
      (cause) => new HtmlRenderBrowserError({ reason: "the preview proxy could not start", cause }),
    ),
  );
  const outgoing = yield* Queue.unbounded<Uint8Array>();
  const child = yield* spawner
    .spawn(
      ChildProcess.make(
        input.executable,
        [
          "--headless=new",
          "--remote-debugging-pipe",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-gpu",
          "--hide-scrollbars",
          "--mute-audio",
          "--block-new-web-contents",
          `--proxy-server=socks5://127.0.0.1:${proxyPort}`,
          // Loopback would otherwise skip the proxy.
          "--proxy-bypass-list=<-loopback>",
          // WebRTC would otherwise send UDP, which no proxy carries.
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          ...(input.noSandbox ? ["--no-sandbox"] : []),
          `--user-data-dir=${input.profileDirectory}`,
          "about:blank",
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          forceKillAfter: "2 seconds",
          additionalFds: {
            fd3: { type: "input", stream: Stream.fromQueue(outgoing) },
            fd4: { type: "output" },
          },
        },
      ),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new HtmlRenderBrowserError({ reason: "the browser could not be started", cause }),
      ),
      // Node throws some spawn errors synchronously, such as `spawn UNKNOWN`
      // when policy blocks the executable; `mapError` cannot catch those.
      Effect.catchDefect((cause) =>
        Effect.fail(
          new HtmlRenderBrowserError({ reason: "the browser could not be started", cause }),
        ),
      ),
    );

  let stderrTail = "";
  const stderrReader = yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.sync(() => {
        stderrTail = (stderrTail + text).slice(-2_048);
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  const pending = new Map<
    number,
    { readonly method: string; readonly reply: Deferred.Deferred<unknown, BrowserFailure> }
  >();
  const pages = new Map<string, PageEvents>();
  let disconnected: BrowserFailure | undefined;
  let nextId = 0;

  const post = (method: string, params: Record<string, unknown>, sessionId: string) =>
    Queue.offer(
      outgoing,
      new TextEncoder().encode(
        `${encodeCdpCommand({ id: ++nextId, method, params, sessionId })}\0`,
      ),
    ).pipe(Effect.asVoid);

  // Queue shared body bytes between JSON halves to avoid copies across capture widths.
  const fulfillPage = (sessionId: string, requestId: string, body: Uint8Array) =>
    Queue.offerAll(outgoing, [
      textEncoder.encode(
        `{"id":${++nextId},"sessionId":${JSON.stringify(sessionId)},"method":"Fetch.fulfillRequest","params":{"requestId":${JSON.stringify(requestId)},"responseCode":200,"responseHeaders":[{"name":"Content-Type","value":"text/html; charset=utf-8"}],"body":"`,
      ),
      body,
      textEncoder.encode('"}}\0'),
    ]).pipe(Effect.asVoid);

  // Incoming messages share the session span; frame acknowledgements are frequent.
  const receive = Effect.fnUntraced(function* (raw: string) {
    const message = Option.getOrUndefined(decodeCdpMessage(raw));
    if (message?.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (!waiter) return yield* Effect.void;
      return yield* message.error
        ? Deferred.fail(
            waiter.reply,
            new HtmlRenderBrowserError({
              reason: `${waiter.method} failed`,
              cause: message.error.message,
            }),
          )
        : Deferred.succeed(waiter.reply, message.result);
    }
    const sessionId = message?.sessionId;
    const page = sessionId === undefined ? undefined : pages.get(sessionId);
    if (sessionId === undefined || !page || !message?.method) return yield* Effect.void;
    if (message.method === "Runtime.bindingCalled" && page.onProgress) {
      const event = Option.getOrUndefined(
        Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String, payload: Schema.String }))(
          message.params,
        ),
      );
      if (event?.name === "__physicsProgress") {
        const value = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(event.payload);
        if (Option.isSome(value)) page.onProgress(value.value);
      }
      return yield* Effect.void;
    }
    if (message.method === "Page.loadEventFired") {
      return yield* page.loaded ? Deferred.succeed(page.loaded, undefined) : Effect.void;
    }
    if (message.method === "Fetch.requestPaused") {
      const paused = Option.getOrUndefined(decodeRequestPaused(message.params));
      if (!paused) return yield* Effect.void;
      const body = page.body;
      const url = paused.request.url.split("#", 1)[0]!;
      if (url === PAGE_URL && body !== undefined) {
        return yield* fulfillPage(sessionId, paused.requestId, body);
      }
      // Subframes may show other sites covered by Local Network Access; the main frame stays on T3's page.
      const otherSiteFrame =
        paused.resourceType === "Document" &&
        paused.frameId !== page.mainFrameId &&
        !url.startsWith(`${PAGE_ORIGIN}/`);
      return yield* otherSiteFrame
        ? post("Fetch.continueRequest", { requestId: paused.requestId }, sessionId)
        : post(
            "Fetch.failRequest",
            { requestId: paused.requestId, errorReason: "AccessDenied" },
            sessionId,
          );
    }
    const consoleMessage = consoleMessageFromEvent(message.method, message.params);
    if (!consoleMessage) return yield* Effect.void;
    if (page.consoleMessages.length >= MAX_CONSOLE_MESSAGES) {
      page.omittedConsoleMessages += 1;
      return yield* Effect.void;
    }
    const text = consoleMessage.text.replaceAll(PAGE_URL, PAGE_NAME);
    page.consoleMessages.push({
      level: consoleMessage.level,
      text:
        text.length > MAX_CONSOLE_TEXT_CHARS ? `${text.slice(0, MAX_CONSOLE_TEXT_CHARS)}…` : text,
    });
    return yield* Effect.void;
  });

  // Startup aborts close the pipe; let stderr drain to recover the reason.
  const disconnect = Effect.gen(function* () {
    yield* Fiber.await(stderrReader).pipe(Effect.timeout("1 second"), Effect.ignore);
    const exit = yield* child.exitCode.pipe(
      Effect.map((code): { exitCode?: number; signal?: string; cause?: unknown } => ({
        exitCode: code,
      })),
      Effect.catch((error) => {
        const signal = EXIT_SIGNAL.exec(String(error.cause))?.[1];
        return Effect.succeed(signal === undefined ? { cause: error } : { signal, cause: error });
      }),
      Effect.timeoutOption("1 second"),
    );
    const error = new HtmlRenderBrowserError({
      reason: "the browser exited unexpectedly",
      output: stderrTail,
      ...Option.getOrElse(exit, () => ({})),
    });
    disconnected = error;
    const waiters = [...pending.values()];
    pending.clear();
    yield* Effect.forEach(waiters, ({ reply }) => Deferred.fail(reply, error), { discard: true });
    yield* Effect.forEach(
      pages.values(),
      (page) => (page.loaded ? Deferred.fail(page.loaded, error) : Effect.void),
      { discard: true },
    );
  });

  // Chunks may split messages; screenshot replies span many chunks.
  let partial: Array<string> = [];
  yield* child.getOutputFd(4).pipe(
    Stream.decodeText(),
    Stream.runForEach((text) => {
      const complete: Array<string> = [];
      let start = 0;
      for (let end = text.indexOf("\0"); end !== -1; end = text.indexOf("\0", start)) {
        partial.push(text.slice(start, end));
        complete.push(partial.join(""));
        partial = [];
        start = end + 1;
      }
      if (start < text.length) partial.push(text.slice(start));
      return Effect.forEach(complete, receive, { discard: true });
    }),
    Effect.ignore,
    Effect.andThen(disconnect),
    Effect.forkScoped,
  );

  const send = Effect.fn("headlessChrome.send")(function* <A>(
    method: string,
    params: Record<string, unknown>,
    result: Schema.Decoder<A>,
    sessionId?: string,
  ) {
    if (disconnected) return yield* disconnected;
    const id = ++nextId;
    const reply = yield* Deferred.make<unknown, BrowserFailure>();
    pending.set(id, { method, reply });
    const message = encodeCdpCommand({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    yield* Queue.offer(outgoing, new TextEncoder().encode(`${message}\0`));
    return yield* Deferred.await(reply).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(result)),
      Effect.mapError((error) =>
        error._tag === "HtmlRenderBrowserError"
          ? error
          : new HtmlRenderBrowserError({
              reason: `${method} returned an unexpected result`,
              cause: error,
            }),
      ),
    );
  });

  const openPage = Effect.fnUntraced(function* (
    width: number,
    appearance: ThemeAppearance,
    onProgress?: (value: unknown) => void,
    height = VIEWPORT_HEIGHT,
  ) {
    const { targetId } = yield* send(
      "Target.createTarget",
      { url: "about:blank" },
      Schema.Struct({ targetId: Schema.String }),
    );
    const { sessionId } = yield* send(
      "Target.attachToTarget",
      { targetId, flatten: true },
      Schema.Struct({ sessionId: Schema.String }),
    );
    const events: PageEvents = {
      // A page target's id is its main frame's id.
      mainFrameId: targetId,
      body: undefined,
      loaded: undefined,
      consoleMessages: [],
      omittedConsoleMessages: 0,
      onProgress,
    };
    pages.set(sessionId, events);
    yield* send("Page.enable", {}, Ignored, sessionId);
    yield* send("Runtime.enable", {}, Ignored, sessionId);
    if (onProgress) {
      yield* send("Runtime.addBinding", { name: "__physicsProgress" }, Ignored, sessionId);
    }
    yield* send("Log.enable", {}, Ignored, sessionId);
    yield* send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-color-scheme", value: appearance }] },
      Ignored,
      sessionId,
    );
    // Previews have no use for WebRTC, whose ICE servers can make the browser
    // resolve names outside the proxy. Runs before page scripts in every frame.
    yield* send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: "delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;",
        runImmediately: true,
      },
      Ignored,
      sessionId,
    );
    // Intercept T3's page and all document navigations to keep the main frame on it.
    yield* send(
      "Fetch.enable",
      {
        patterns: [
          { urlPattern: `${PAGE_ORIGIN}/*` },
          { urlPattern: "*", resourceType: "Document" },
        ],
      },
      Ignored,
      sessionId,
    );
    yield* send(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 1, mobile: false },
      Ignored,
      sessionId,
    );

    /** Loads a page from `pageBody`, so callers loading it often encode it once. */
    const load = Effect.fnUntraced(function* (
      body: Uint8Array,
      urlFragment: string,
      settleFrames = true,
    ) {
      const loaded = yield* Deferred.make<void, BrowserFailure>();
      events.body = body;
      events.loaded = loaded;
      const navigation = yield* send(
        "Page.navigate",
        { url: `${PAGE_URL}${urlFragment}` },
        Navigation,
        sessionId,
      );
      if (navigation.errorText) {
        return yield* new HtmlRenderBrowserError({ reason: "the page could not be opened" });
      }
      yield* Deferred.await(loaded);
      yield* send(
        "Runtime.evaluate",
        {
          expression: settleFrames ? SETTLE_EXPRESSION : "document.fonts.ready.then(() => true)",
          awaitPromise: true,
        },
        Ignored,
        sessionId,
      );
      const measured = yield* send(
        "Runtime.evaluate",
        { expression: MEASURE_EXPRESSION, returnByValue: true },
        Measured,
        sessionId,
      );
      return Math.max(0, Math.ceil(measured.result.value));
    });

    /** Evaluates a bounded application operation after navigation; CDP values are decoded at the boundary. */
    const evaluate = <A>(expression: string, decoder: Schema.Decoder<A>) =>
      send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        Schema.Struct({
          result: Schema.Struct({ value: Schema.optional(Schema.Unknown) }),
          exceptionDetails: Schema.optional(Schema.Unknown),
        }),
        sessionId,
      ).pipe(
        Effect.flatMap((result) =>
          result.exceptionDetails === undefined
            ? Schema.decodeUnknownEffect(decoder)(result.result.value).pipe(
                Effect.mapError(
                  (cause) =>
                    new HtmlRenderBrowserError({
                      reason: "the page operation returned an unexpected result",
                      cause,
                    }),
                ),
              )
            : Effect.fail(
                new HtmlRenderBrowserError({
                  reason: "the page operation failed",
                  cause: result.exceptionDetails,
                }),
              ),
        ),
      );

    const screenshot = (height: number) =>
      send(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale: 1 },
        },
        Schema.Struct({ data: Schema.String }),
        sessionId,
      ).pipe(Effect.map(({ data }) => data));

    const consoleMessages = (): ReadonlyArray<ConsoleMessage> =>
      events.omittedConsoleMessages === 0
        ? [...events.consoleMessages]
        : [
            ...events.consoleMessages,
            {
              level: "warning",
              text: `${events.omittedConsoleMessages} more console messages were omitted.`,
            },
          ];

    const close = send("Target.closeTarget", { targetId }, Ignored).pipe(
      Effect.ensuring(Effect.sync(() => pages.delete(sessionId))),
      Effect.ignore,
    );

    return { load, evaluate, screenshot, consoleMessages, close };
  });

  return { openPage, kill: child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore) };
});

const scratchDirectory = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.acquireRelease(
    fileSystem.makeTempDirectory({ prefix: "t3-html-preview-" }),
    (directory) => fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new HtmlRenderBrowserError({ reason: "a temporary directory could not be created", cause }),
    ),
  );
});

export const captureHtmlScreenshot = Effect.fn("headlessChrome.captureHtmlScreenshot")(
  function* (input: {
    readonly executable: string;
    readonly noSandbox: boolean;
    readonly html: string;
    readonly width: number;
    readonly urlFragment: string;
    readonly appearance: ThemeAppearance;
  }) {
    const path = yield* Path.Path;
    const directory = yield* scratchDirectory;
    const browser = yield* launchBrowser({
      executable: input.executable,
      noSandbox: input.noSandbox,
      profileDirectory: path.join(directory, "profile"),
    });
    const page = yield* browser.openPage(input.width, input.appearance);
    const contentHeight = yield* page.load(pageBody(input.html), input.urlFragment);
    const capturedHeight = Math.max(1, Math.min(contentHeight, MAX_CAPTURE_HEIGHT));
    const png = yield* page.screenshot(capturedHeight);
    return { png, contentHeight, capturedHeight, consoleMessages: page.consoleMessages() };
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: CAPTURE_TIMEOUT,
    orElse: () =>
      Effect.fail(
        new HtmlRenderBrowserError({
          reason: `the page did not finish loading within ${CAPTURE_TIMEOUT}`,
        }),
      ),
  }),
);

/** Fresh load per width, since pages may lay out only at load. */
export const measureHtmlHeights = Effect.fn("headlessChrome.measureHtmlHeights")(function* (input: {
  readonly executable: string;
  readonly noSandbox: boolean;
  readonly html: string;
  readonly widths: ReadonlyArray<number>;
  readonly urlFragment: string;
}) {
  const path = yield* Path.Path;
  const directory = yield* scratchDirectory;
  const browser = yield* launchBrowser({
    executable: input.executable,
    noSandbox: input.noSandbox,
    profileDirectory: path.join(directory, "profile"),
  });
  const body = pageBody(input.html);
  return yield* Effect.forEach(
    input.widths,
    (width) =>
      browser.openPage(width, "dark").pipe(
        Effect.flatMap((page) =>
          page.load(body, input.urlFragment).pipe(Effect.ensuring(page.close)),
        ),
        Effect.map((height) => [width, height] as const),
      ),
    { concurrency: MEASURE_CONCURRENCY },
  );
}, Effect.scoped);

/** Runs a typed operation in the same isolated Chrome used by HTML previews, then captures its final frame. */
export const evaluateHtml = <A>(input: {
  readonly executable: string;
  readonly noSandbox: boolean;
  readonly html: string;
  readonly width: number;
  readonly appearance?: ThemeAppearance;
  /** Fixed CSS viewport and capture height; defaults to measuring the page at 800px tall. */
  readonly height?: number;
  readonly expression: string;
  readonly result: Schema.Decoder<A>;
  /** Deterministic visual artifacts forbid rAF, including the usual two-frame settle. */
  readonly settleFrames?: boolean;
  readonly timeoutMs?: number;
  readonly onProgress?: (value: unknown) => void;
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* scratchDirectory;
    const browser = yield* launchBrowser({
      executable: input.executable,
      noSandbox: input.noSandbox,
      profileDirectory: path.join(directory, "profile"),
    });
    return yield* Effect.gen(function* () {
      const page = yield* browser.openPage(
        input.width,
        input.appearance ?? "dark",
        input.onProgress,
        input.height,
      );
      const contentHeight = yield* page.load(pageBody(input.html), "", input.settleFrames);
      const result = yield* page.evaluate(input.expression, input.result);
      const capturedHeight = Math.max(
        1,
        Math.min(input.height ?? contentHeight, MAX_CAPTURE_HEIGHT),
      );
      const png = yield* page.screenshot(capturedHeight);
      return {
        result,
        png,
        width: input.width,
        height: capturedHeight,
        consoleMessages: page.consoleMessages(),
      };
    }).pipe(
      // A busy renderer cannot answer CDP. Kill our isolated browser before
      // scoped process cleanup, so a timeout never waits for a page reply.
      Effect.onInterrupt(() => browser.kill),
    );
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: input.timeoutMs ?? 20_000,
      orElse: () => Effect.fail(new HtmlEvaluateTimeout({ timeoutMs: input.timeoutMs ?? 20_000 })),
    }),
  );
