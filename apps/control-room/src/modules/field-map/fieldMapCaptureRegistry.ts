import type { FieldMapPngCapture } from "./fieldMapPngCapture";

export type FieldMapCaptureProvider = () => Promise<FieldMapPngCapture>;

const captures = new Map<string, FieldMapCaptureProvider>();

/** Registers the mounted 2D surface for one exact session request scope. */
export function registerFieldMapCapture(
  sessionScopeKey: string,
  capture: FieldMapCaptureProvider,
): () => void {
  captures.set(sessionScopeKey, capture);
  return () => {
    if (captures.get(sessionScopeKey) === capture) captures.delete(sessionScopeKey);
  };
}

export function getRegisteredFieldMapCapture(
  sessionScopeKey: string,
): FieldMapCaptureProvider | null {
  return captures.get(sessionScopeKey) ?? null;
}
