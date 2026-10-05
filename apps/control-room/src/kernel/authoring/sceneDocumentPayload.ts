import type { JsonObject, SceneResource } from "../api/apiTypes";

const SCENE_DOCUMENT_FIELDS = [
  "version", "revision", "scene", "universe", "objects", "couplings",
  "materials", "magnetization_assets", "field_drives", "monitors", "selections",
  "magnetization_constraints", "current_modules", "current_transports",
  "spin_transports", "spin_torques", "oersted_fields", "study", "outputs", "editor",
] as const;

/** Canonical SceneResource -> SceneDocument projection shared by history/save.
 * Resource-only metadata is excluded; the entire authored study is retained.
 */
export function sceneDocumentPayload(scene: SceneResource): JsonObject {
  const source = scene as unknown as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const field of SCENE_DOCUMENT_FIELDS) {
    if (source[field] !== undefined) payload[field] = JSON.parse(JSON.stringify(source[field]));
  }
  return payload as JsonObject;
}
