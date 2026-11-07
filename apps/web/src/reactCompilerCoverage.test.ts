// @effect-diagnostics nodeBuiltinImport:off - compiles real source files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { transform } from "oxc-transform-react";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

const webSourceFiles = NodeFS.readdirSync(NodePath.join(repoRoot, "apps/web/src"), {
  recursive: true,
})
  .map(String)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|browser)\.tsx?$/.test(file))
  .filter((file) => !file.endsWith(".gen.ts"))
  .map((file) => `apps/web/src/${file}`);

// Fork-owned surfaces (Lab, physics, voice) predate the compiler gate and still
// hold patterns it bails on (try/finally, refs written in render). They build unmemoized.
// Remove an entry when its file compiles.
const unmemoizedFiles = new Set([
  "apps/web/src/components/chat/usePendingThreadRequests.ts",
  "apps/web/src/components/physics/BoardCanvas.tsx",
  "apps/web/src/components/physics/PhysicsTimelineCards.tsx",
  "apps/web/src/components/physics/SimControls.tsx",
  "apps/web/src/components/physics/SimView.tsx",
  "apps/web/src/components/physics/SimulationPanel.tsx",
  "apps/web/src/components/physics/WhiteboardPanel.tsx",
  "apps/web/src/components/settings/LearningSettings.tsx",
  "apps/web/src/learn/graph/DeleteSourceDialog.tsx",
  "apps/web/src/learn/graph/graph-view.tsx",
  "apps/web/src/learn/visual/VisualPanel.tsx",
  "apps/web/src/voice/useDictation.ts",
  "apps/web/src/voice/useReadAloud.ts",
]);

// ChatView is ~9k lines. Compiling it takes ~9s on a fast machine and can pass the
// 15s project limit on loaded CI runners, so slow files get a 60s limit below.
const slowFiles = new Set(["apps/web/src/components/ChatView.tsx"]);

const compile = async (file: string) => {
  const absolute = NodePath.join(repoRoot, file);
  const result = await transform(absolute, NodeFS.readFileSync(absolute, "utf8"), {
    jsx: { runtime: "automatic", development: false, refresh: false },
    reactCompiler: { reportDiagnostics: true },
  });
  const bailouts = result.errors.map((error) => error.codeframe ?? error.message);
  expect(bailouts).toEqual([]);
};

// Lint reports most compiler bailouts, but not every one (try/finally, throw
// inside try). A skipped file still builds, just unmemoized, so check the output.
describe("React Compiler coverage", () => {
  it.each(webSourceFiles.filter((file) => !slowFiles.has(file) && !unmemoizedFiles.has(file)))(
    "compiles %s",
    compile,
  );
  // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- CPU-bound compile of a huge file, not a hidden wait.
  it.each([...slowFiles].filter((file) => !unmemoizedFiles.has(file)))(
    "compiles %s",
    compile,
    60_000,
  );
});
