import { BOARD_IMAGE_MAX_BYTES } from "@t3tools/physics/board";

const MAX_WIDTH = 640;

/** Board images are raster data URLs capped at 2 MiB; a sim snapshot is scaled and re-encoded to fit. */
export async function fitBoardImage(
  dataUrl: string,
): Promise<{ src: string; w: number; h: number }> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const scale = Math.min(1, MAX_WIDTH / image.naturalWidth);
  const w = Math.round(image.naturalWidth * scale);
  const h = Math.round(image.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(image, 0, 0, w, h);
  const maxLength = Math.floor(((BOARD_IMAGE_MAX_BYTES - 3) / 3) * 4);
  for (const [type, quality] of [
    ["image/png", undefined],
    ["image/jpeg", 0.9],
    ["image/jpeg", 0.6],
  ] as const) {
    const src = canvas.toDataURL(type, quality);
    if (src.length <= maxLength) return { src, w, h };
  }
  throw new Error("Snapshot is too large for a board image.");
}
