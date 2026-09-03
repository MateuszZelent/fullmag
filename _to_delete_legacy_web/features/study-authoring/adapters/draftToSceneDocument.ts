/**
 * Layer C: Adapters – Draft → Scene Document (for backend push)
 *
 * Transforms the local authoring draft into a payload suitable
 * for the backend scene document API.
 */

import type { SceneDocument } from "@/lib/session/types";

/**
 * Compute a deterministic signature for a scene document.
 * Used for diffing local vs remote to determine if sync is needed.
 */
export function draftSignature(draft: SceneDocument | null): string | null {
  return draft ? JSON.stringify(draft) : null;
}

/**
 * Check if two scene documents are structurally equivalent.
 */
export function draftsEqual(a: SceneDocument | null, b: SceneDocument | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
