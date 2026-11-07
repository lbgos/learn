import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { applyBoardOps } from "@t3tools/physics/board";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HeadlessChrome from "../../htmlRender/headlessChrome.ts";
import * as PhysicsFiles from "../../physics/PhysicsFiles.ts";
import * as PhysicsSimService from "../../physics/PhysicsSimService.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";

it.live(
  "rasterizes an SVG board image through the board_read screenshot path",
  (ctx) =>
    Effect.gen(function* () {
      const executable = (yield* HostProcess.Environment).T3CODE_TEST_HEADLESS_SHELL;
      if (!executable) return ctx.skip("T3CODE_TEST_HEADLESS_SHELL is required.");
      const layer = PhysicsSimService.layer.pipe(
        Layer.provide(PhysicsFiles.layer),
        Layer.provide(
          Layer.mock(PreviewBrowser.PreviewBrowser)({
            executable: Effect.succeed(executable),
            installed: Effect.succeedSome(executable),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="#ff0000"/></svg>';
        const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
        const { board } = applyBoardOps(
          { version: 1, revision: 0, items: [] },
          [{ type: "add", items: [{ kind: "image", src, w: 100, h: 100, x: 0, y: 0 }] }],
          "agent",
        );
        const service = yield* PhysicsSimService.PhysicsSimService;
        const capture = yield* service.renderBoard(board);
        const captureCheck = yield* HeadlessChrome.evaluateHtml({
          executable,
          noSandbox: true,
          html: "<!doctype html><body></body>",
          width: 1200,
          expression: `(async () => {
        const image = new Image();
        image.src = "data:image/png;base64,${capture.screenshot.data}";
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return Array.from(context.getImageData(600, 400, 1, 1).data);
      })()`,
          result: Schema.Array(Schema.Number),
        });
        expect(captureCheck.result).toEqual([255, 0, 0, 255]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  60_000,
);
