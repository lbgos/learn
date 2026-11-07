import * as NodeURL from "node:url";
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { build } from "vite-plus";
import tailwind from "@tailwindcss/vite";
import * as HeadlessChrome from "../../../../server/src/htmlRender/headlessChrome";

const bundles = new Map();
async function panelDocument(legacy = false) {
  const source = await NodeFSP.readFile(
    new URL("../../../../server/src/physics/templates/assignment.html", import.meta.url),
    "utf8",
  );
  const example =
    source +
    `<script>
    if (${legacy}) delete window.lbgosVisual.captions;
    let lastStep = 0;
    let renderCount = 0;
    const render = window.lbgosVisual.render;
    window.lbgosVisual.render = (step, t) => { lastStep = step; renderCount++; render(step, t); };
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.type !== 'measure') return;
      const svg = document.querySelector('svg');
      const bounds = svg.getBoundingClientRect();
      const text = document.querySelector('#blocks text');
      parent.postMessage({type:'geometry',innerWidth,innerHeight,svgWidth:bounds.width,svgHeight:bounds.height,textSize:parseFloat(getComputedStyle(text).fontSize)*svg.getScreenCTM().a,step:lastStep,renderCount,loads:[...document.querySelectorAll('[id^="load-"]')].map(node=>node.textContent)}, '*');
    });
  </script>`;
  if (!bundles.has(legacy))
    bundles.set(
      legacy,
      build({
        configFile: false,
        root: NodeURL.fileURLToPath(new URL("../../..", import.meta.url)),
        logLevel: "silent",
        resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../..", import.meta.url)) } },
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
        oxc: { jsx: { development: false } },
        plugins: [
          tailwind(),
          {
            name: "visual-panel-fixture",
            enforce: "pre",
            resolveId(source, importer) {
              if (source.endsWith("virtual:visual-panel-fixture"))
                return "\0visual-panel-fixture.tsx";
              if (!importer?.endsWith("/VisualPanel.tsx")) return;
              if (source === "@effect/atom-react") return "\0visual-file";
              if (source === "~/physics/modelContext") return "\0visual-context";
              if (source === "~/physics/useModelContextNote") return "\0visual-note";
              if (source === "~/physics/state") return "\0visual-state";
              if (source === "./selection") return "\0visual-selection";
            },
            load(id) {
              if (id === "\0visual-file")
                return `import {AsyncResult} from 'effect/reactivity'; export const useAtomValue = () => AsyncResult.success({type:'file',code:${JSON.stringify(example)}});`;
              if (id === "\0visual-context")
                return "export const visualContextKey = () => ''; export const visualContextText = () => '';";
              if (id === "\0visual-note") return "export const useModelContextNote = () => {};";
              if (id === "\0visual-state")
                return "export const physicsEnvironment = {simEvents: () => null};";
              if (id === "\0visual-selection")
                return "export const visualSelectionKey = () => ''; export const useVisualSelection = () => undefined;";
              if (id !== "\0visual-panel-fixture.tsx") return;
              return `
            import React from 'react';
            import {createRoot} from 'react-dom/client';
            import {flushSync} from 'react-dom';
            import ${JSON.stringify(NodeURL.fileURLToPath(new URL("../../index.css", import.meta.url)))};
            import {VisualPanel} from ${JSON.stringify(NodeURL.fileURLToPath(new URL("./VisualPanel.tsx", import.meta.url)))};
            function App() {
              const [maximized, maximize] = React.useState(false);
              return <div style={{position:'fixed',inset:0,background:'#000',color:'#fff'}}>
                <button onClick={() => maximize(!maximized)}>Maximize</button>
                <section aria-label="Visual fixture" style={{position:'absolute',top:40,bottom:0,right:0,width:maximized?'100%':'min(540px, 100%)'}}>
                  <VisualPanel threadRef={{environmentId:'fixture',threadId:'fixture'}} threadStarted={false} projectId="fixture" path="visuals/assignment.html" active={true}/>
                </section>
              </div>;
            }
            flushSync(() => createRoot(document.getElementById('root')).render(<App/>));
          `;
            },
          },
        ],
        build: {
          write: false,
          minify: true,
          lib: { entry: "virtual:visual-panel-fixture", formats: ["iife"], name: "VisualTest" },
        },
      }),
    );
  const built = await bundles.get(legacy);
  const outputs = (Array.isArray(built) ? built : [built]).flatMap((item) =>
    "output" in item ? item.output : [],
  );
  const script = outputs
    .filter((item) => item.type === "chunk")
    .map((item) => item.code)
    .join("\n");
  const css = outputs
    .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
    .map((item) => String(item.source))
    .join("\n");
  return `<html class="dark"><style>${css}</style><style>html,body,#root{margin:0;width:100%;height:100%;background:#000;color:#fff}</style><div id="root"></div><script>${script.replaceAll("</script", "<\\/script")}</script></html>`;
}

const result = Schema.Struct({
  frameWidth: Schema.Number,
  frameHeight: Schema.Number,
  panelWidth: Schema.Number,
  panelHeight: Schema.Number,
  controlsHeight: Schema.Number,
  innerWidth: Schema.Number,
  innerHeight: Schema.Number,
  svgWidth: Schema.Number,
  svgHeight: Schema.Number,
  textSize: Schema.Number,
  step: Schema.Number,
  played: Schema.Boolean,
  idle: Schema.Boolean,
  loads: Schema.Array(Schema.String),
  captionVisible: Schema.Boolean,
  captionChanged: Schema.Boolean,
  mathRendered: Schema.Boolean,
});
it.live.each([
  [1440, 900, false],
  [1440, 900, true],
  [390, 844, false],
  [390, 844, true],
])(
  "fills the visual panel at %i×%i, maximized=%s",
  ([width, height, maximized]) =>
    Effect.gen(function* () {
      const environment = yield* HostProcess.Environment;
      const executable = environment.T3CODE_TEST_HEADLESS_SHELL;
      if (!executable) throw new Error("T3CODE_TEST_HEADLESS_SHELL is required");
      const html = yield* Effect.promise(panelDocument);
      const capture = yield* HeadlessChrome.evaluateHtml({
        executable,
        noSandbox: environment.T3CODE_SERVER_BROWSER_SANDBOX === "0",
        width,
        height,
        html,
        result,
        expression: `(async () => {
        const tick = () => new Promise(requestAnimationFrame);
        const button = label => [...document.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent) === label);
        for (let i=0;i<120 && button('Play')?.disabled;i++) await tick();
        if (!button('Play') || button('Play').disabled) throw new Error('Visual did not become ready');
        if (${maximized}) { button('Maximize').click(); await tick(); }
        const caption = () => document.querySelector('[aria-label="Step caption"]');
        const firstCaption = 'Watch the four matrices waiting in the pool.';
        button('Next step').click(); await tick();
        const captionChanged = caption().textContent.startsWith('Watch the two largest matrices');
        button('Previous step').click(); await tick();
        if (!caption().textContent.startsWith(firstCaption)) throw new Error('Previous step did not restore caption');
        button('Next step').click(); await tick();
        button('Play').click(); await tick();
        if (!button('Pause')) throw new Error('Play did not enter Pause state');
        let played = false;
        for (let i=0;i<300;i++) {
          await tick();
          const progress = Number(document.querySelector('input').value);
          played ||= progress > 0 && progress < 1;
          if (button('Play') && progress === 1) break;
        }
        if (!button('Play') || Number(document.querySelector('input').value) !== 1) throw new Error('Playback did not finish');
        const iframe = document.querySelector('iframe');
        const measure = () => new Promise(resolve => {
          const receive = event => {
            if (event.source !== iframe.contentWindow || event.data?.type !== 'geometry') return;
            removeEventListener('message', receive); resolve(event.data);
          };
          addEventListener('message', receive);
          // Opaque-origin sandbox: inspect geometry from inside the visual document.
          iframe.contentWindow.postMessage({type:'measure'}, '*');
        });
        const stopped = await measure();
        for (let i=0;i<5;i++) await tick();
        const idle = stopped.renderCount === (await measure()).renderCount;
        button('Next step').click(); await tick();
        const geometry = await measure();
        const frame = iframe.getBoundingClientRect();
        const panel = iframe.parentElement.getBoundingClientRect();
        const controls = iframe.nextElementSibling.getBoundingClientRect();
        const captionBounds = caption().getBoundingClientRect();
        for (let i=0;i<120 && !caption().querySelector('.katex');i++) await tick();
        return {...geometry,played,idle,captionChanged,captionVisible:captionBounds.top>=0 && captionBounds.bottom<=innerHeight && caption().scrollHeight<=caption().clientHeight,mathRendered:!!caption().querySelector('.katex'),frameWidth:frame.width,frameHeight:frame.height,panelWidth:panel.width,panelHeight:panel.height,controlsHeight:controls.height};
      })()`,
      });
      expect(capture.consoleMessages.filter((item) => item.level === "error")).toEqual([]);
      const measured = capture.result;
      expect(measured.frameWidth).toBe(maximized ? width : Math.min(540, width));
      expect(measured.frameHeight + measured.controlsHeight).toBe(measured.panelHeight);
      expect(measured.innerWidth).toBe(measured.frameWidth);
      // CSS caption line heights can leave a fractional iframe height; innerHeight rounds it.
      expect(Math.abs(measured.innerHeight - measured.frameHeight)).toBeLessThanOrEqual(0.5);
      expect(measured.svgWidth).toBe(measured.frameWidth);
      expect(Math.abs(measured.svgHeight - measured.frameHeight)).toBeLessThanOrEqual(0.5);
      expect(measured.textSize).toBeGreaterThanOrEqual(14);
      expect(measured.step).toBe(2);
      expect(measured.played).toBe(true);
      expect(measured.idle).toBe(true);
      expect(measured.captionVisible).toBe(true);
      expect(measured.captionChanged).toBe(true);
      expect(measured.mathRendered).toBe(true);
      expect(measured.loads).toEqual(["Load: 7 MB", "Load: 7 MB"]);
      const output = new URL("../../../node_modules/.cache/lbgos-visual-panel/", import.meta.url);
      yield* Effect.promise(() => NodeFSP.mkdir(output, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          new URL(`panel-${width}x${height}-${maximized ? "maximized" : "docked"}.png`, output),
          capture.png,
          "base64",
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.live.each([
  [1440, 900],
  [390, 844],
])(
  "keeps legacy assets without captions usable at %i×%i",
  ([width, height]) =>
    Effect.gen(function* () {
      const environment = yield* HostProcess.Environment;
      const executable = environment.T3CODE_TEST_HEADLESS_SHELL;
      if (!executable) throw new Error("T3CODE_TEST_HEADLESS_SHELL is required");
      const html = yield* Effect.promise(() => panelDocument(true));
      const capture = yield* HeadlessChrome.evaluateHtml({
        executable,
        noSandbox: environment.T3CODE_SERVER_BROWSER_SANDBOX === "0",
        width,
        height,
        html,
        result: Schema.Struct({
          captionHidden: Schema.Boolean,
          errorHidden: Schema.Boolean,
          played: Schema.Boolean,
          previousWorked: Schema.Boolean,
          finalStep: Schema.Boolean,
        }),
        expression: `(async () => {
          const tick = () => new Promise(requestAnimationFrame);
          const button = label => document.querySelector('button[aria-label="'+label+'"]');
          for (let i=0;i<120 && button('Play')?.disabled;i++) await tick();
          if (!button('Play') || button('Play').disabled) throw new Error('Legacy visual did not become ready');
          button('Next step').click(); await tick();
          button('Previous step').click(); await tick();
          const previousWorked = button('Previous step').disabled && !button('Next step').disabled;
          button('Next step').click(); await tick();
          button('Play').click(); await tick();
          let played = false;
          for (let i=0;i<300;i++) {
            await tick();
            const progress = Number(document.querySelector('input').value);
            played ||= progress > 0 && progress < 1;
            if (button('Play') && progress === 1) break;
          }
          button('Next step').click(); await tick();
          return { captionHidden: !document.querySelector('[aria-label="Step caption"]'), errorHidden: !document.querySelector('[role="alert"]'), played, previousWorked, finalStep: button('Next step').disabled && !button('Previous step').disabled };
        })()`,
      });
      expect(capture.result).toEqual({
        captionHidden: true,
        errorHidden: true,
        played: true,
        previousWorked: true,
        finalStep: true,
      });
      expect(capture.consoleMessages.filter((item) => item.level === "error")).toEqual([]);
      const output = new URL("../../../node_modules/.cache/lbgos-visual-panel/", import.meta.url);
      yield* Effect.promise(() => NodeFSP.mkdir(output, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(new URL(`legacy-${width}x${height}.png`, output), capture.png, "base64"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
