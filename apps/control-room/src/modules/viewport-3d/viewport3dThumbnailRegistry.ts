import type { Viewport3DThumbnail } from "./viewport3dThumbnail";

export type Viewport3DThumbnailCapture = () => Promise<Viewport3DThumbnail | null>;

const captures = new Map<string, Viewport3DThumbnailCapture>();

/**
 * Mounted viewports register a capture here so kernel code can take a
 * thumbnail without reaching into the viewport. The returned function removes
 * the registration, and only if it is still the current one for that slot.
 */
export function registerViewport3DThumbnailCapture(
  slotId: string,
  capture: Viewport3DThumbnailCapture,
): () => void {
  captures.set(slotId, capture);
  return () => {
    if (captures.get(slotId) === capture) captures.delete(slotId);
  };
}

/** The first registered viewport that yields a thumbnail, newest first; `null` when none does. */
export async function captureRegisteredViewport3DThumbnail(): Promise<Viewport3DThumbnail | null> {
  for (const capture of [...captures.values()].reverse()) {
    try {
      const thumbnail = await capture();
      if (thumbnail) return thumbnail;
    } catch {
      continue;
    }
  }
  return null;
}
