import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { BoardImageSource, BOARD_IMAGE_MAX_BYTES, BOARD_SVG_MAX_BYTES } from "./imageSource.ts";
import { applyBoardOps } from "./model.ts";
import { renderBoardSvg } from "./render.ts";

const decode = Schema.decodeSync(BoardImageSource);
const source = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const wrap = (content: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">${content}</svg>`;

describe("board image sources", () => {
  it("accepts complete SVG figures, fragments and embedded PNG/JPEG", () => {
    for (const svg of [
      wrap('<rect width="100" height="100" fill="#000"/><text x="10" y="20">π &amp; θ</text>'),
      wrap('<defs><path id="axis" d="M0 0L10 10"/></defs><use href="#axis"/>'),
      wrap('<use xlink:href="#axis"/><path fill="url(#gradient)"/>'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      wrap('<image href="data:image/png;base64,aGVsbG8="/>'),
      wrap('<image xlink:href="data:image/jpeg;base64,aGVsbG8="/>'),
      `<?xml version="1.0"?>${wrap("")}`,
    ])
      expect(decode(source(svg))).toBe(source(svg));
  });

  it.each([
    "<script>alert(1)</script>",
    '<SCRIPT href="#x"/>',
    "<foreignObject><div>html</div></foreignObject>",
    "<s:script/>",
    '<path onclick="alert(1)"/>',
    '<path ONpointerenter = "alert(1)"/>',
    '<a href="javascript:alert(1)"/>',
    '<image href="https://example.com/a.png"/>',
    '<image xlink:href="//example.com/a.png"/>',
    '<image href="file:///etc/passwd"/>',
    '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>',
    '<image href="&#104;ttps://example.com/a.png"/>',
    '<image href="&#35;axis"/>',
    "<image href=//example.com/a.png/>",
    '<path style="fill: u&#114;l(https://example.com/a.svg)"/>',
    '<path fill="u&#114;l(https://example.com/a.svg)"/>',
    '<g xml:base="https://example.com/a.svg"><use href="#shape"/></g>',
    '<style>@import "https://example.com/a.css";</style>',
    '<path style="fill: url(https://example.com/a.svg)"/>',
    "<style>path { fill: u\\72l(https://example.com/a.svg) }</style>",
    '<set attributeName="href" to="https://example.com/a.svg"/>',
    '<animate attributeName="href" values="https://example.com/a.svg"/>',
  ])("rejects unsafe SVG content: %s", (content) => {
    expect(() => decode(source(wrap(content)))).toThrow();
  });

  it("rejects XML entities, incomplete SVG, invalid UTF-8 and malformed data URLs", () => {
    for (const value of [
      source('<!DOCTYPE svg [<!ENTITY x "https://example.com">]>' + wrap('<image href="&x;"/>')),
      source('<?xml-stylesheet href="https://example.com/a.css"?>' + wrap("")),
      source("<svg>"),
      source("<svg:other/>"),
      "data:image/svg+xml;base64,/w==",
      "data:image/svg+xml;base64,===A",
      "data:image/svg+xml;base64,AA=",
      "data:image/svg+xml;base64,",
      "data:image/svg+xml,<svg/>",
      "https://example.com/a.png",
    ])
      expect(() => decode(value)).toThrow();
  });

  it("caps decoded SVG at 512 KiB and raster data at 2 MiB at the schema boundary", () => {
    const svg = wrap("");
    const atLimit = source(wrap(" ".repeat(BOARD_SVG_MAX_BYTES - Buffer.byteLength(svg))));
    expect(decode(atLimit)).toBe(atLimit);
    expect(() => decode(source(wrap(" ".repeat(BOARD_SVG_MAX_BYTES))))).toThrow();
    const raster = `data:image/png;base64,${Buffer.alloc(BOARD_IMAGE_MAX_BYTES).toString("base64")}`;
    expect(decode(raster)).toBe(raster);
    expect(() =>
      decode(`data:image/png;base64,${Buffer.alloc(BOARD_IMAGE_MAX_BYTES + 1).toString("base64")}`),
    ).toThrow();
  });

  it("renders SVG as an image and allows replacing it by an update", () => {
    const first = source(wrap('<rect width="100" height="100" fill="red"/>'));
    const second = source(wrap('<rect width="100" height="100" fill="blue"/>'));
    const { board } = applyBoardOps(
      { version: 1, revision: 0, items: [] },
      [{ type: "add", items: [{ id: "figure", kind: "image", src: first, w: 100, h: 100 }] }],
      "agent",
    );
    const updated = applyBoardOps(
      board,
      [{ type: "update", id: "figure", patch: { src: second } }],
      "agent",
    ).board;
    const rendered = renderBoardSvg(updated);
    expect(rendered).toContain(`<image href="${second}" width="100" height="100"/>`);
    expect(rendered).not.toContain(first);
    expect(rendered).not.toContain('fill="blue"');
  });
});
