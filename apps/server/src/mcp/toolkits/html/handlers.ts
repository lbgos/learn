import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HtmlPreviewToolkit, HtmlRenderToolkit, type HtmlToolkit } from "./tools.ts";

const INVALID_PAGE_ERRORS = new Set([
  "HtmlRenderImagesNotFoundError",
  "HtmlRenderImageTooLargeError",
  "HtmlRenderPageTooLargeError",
  "HtmlRenderViewportHeightError",
]);

const toFailure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: INVALID_PAGE_ERRORS.has(error._tag) ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const MAX_PAGE_BYTES = 512_000;
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** The page html_render shows: inline html, or a .html file inside the thread's workspace. */
const pageSource = Effect.fn("html_render.pageSource")(function* (
  threadId: ThreadId,
  input: { readonly html?: string | undefined; readonly path?: string | undefined },
) {
  if ((input.html === undefined) === (input.path === undefined))
    return yield* invalid("Pass exactly one of html or path.");
  if (input.html !== undefined) return input.html;
  const relative = input.path ?? "";
  const unreadable = invalid(
    `${relative} is not a readable .html file in this thread's workspace.`,
  );
  const root = yield* threadWorkspaceRoot(threadId);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (root === undefined || path.isAbsolute(relative) || !/\.html?$/i.test(relative))
    return yield* unreadable;
  const realRoot = yield* fs.realPath(root).pipe(Effect.mapError(() => unreadable));
  // Resolve links too, so a symlink cannot lead out of the workspace.
  const file = yield* fs
    .realPath(path.join(realRoot, relative))
    .pipe(Effect.mapError(() => unreadable));
  if (!file.startsWith(realRoot + path.sep)) return yield* unreadable;
  const info = yield* fs.stat(file).pipe(Effect.mapError(() => unreadable));
  if (info.type !== "File") return yield* unreadable;
  if (Number(info.size) > MAX_PAGE_BYTES)
    return yield* invalid(`${relative} is larger than ${MAX_PAGE_BYTES} bytes.`);
  return yield* fs.readFileString(file).pipe(Effect.mapError(() => unreadable));
});

const handlers = {
  // Local-file access limits this host browser to T3-launched agents.
  html_preview: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const htmlRender = yield* HtmlRender.HtmlRender;
      const { png, ...preview } = yield* htmlRender.preview(input).pipe(Effect.mapError(toFailure));
      return {
        ...preview,
        screenshot: {
          mimeType: "image/png" as const,
          data: png,
          width: preview.width,
          height: preview.capturedHeight,
        },
      };
    }),
  ),
  html_render: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "html_render");
      const htmlRender = yield* HtmlRender.HtmlRender;
      const html = yield* pageSource(thread.threadId, input);
      const reference = yield* htmlRender
        .publish({ threadId: thread.threadId, html, title: input.title, height: input.height })
        .pipe(Effect.mapError(toFailure));
      return {
        htmlRender: reference,
        message:
          "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof HtmlToolkit.tools>;

export const layerPreview = McpToolAccess.toLayer(HtmlPreviewToolkit, {
  html_preview: handlers.html_preview,
});

export const layerRender = McpToolAccess.toLayer(HtmlRenderToolkit, {
  html_render: handlers.html_render,
});
