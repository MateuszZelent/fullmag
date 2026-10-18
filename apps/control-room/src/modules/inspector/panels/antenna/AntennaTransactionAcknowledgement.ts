import type { AuthoringTransactionRequest, AuthoringTransactionResponse, SceneResource } from "@/kernel/api/apiTypes";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// Optional nulls may be omitted and the server may attach derived metadata.
function includesAuthored(actual: unknown, expected: unknown, path: string): boolean {
  if (actual === undefined && Array.isArray(expected) && expected.length === 0
    && ["current_transports[].domain", "current_transports[].materials", "current_transports[].boundaries"].includes(path)) return true;
  if (expected == null) return actual == null;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length
    && expected.every((value, index) => includesAuthored(actual[index], value, `${path}[]`));
  const authored = record(expected);
  if (!authored) return actual === expected;
  const committed = record(actual);
  return Boolean(committed && Object.entries(authored).every(([key, value]) => includesAuthored(committed[key], value, `${path}.${key}`)));
}

/** Reject an unverified transaction before semantic history or resource publication. */
export function committedAntennaTransactionScene(
  response: AuthoringTransactionResponse,
  request: AuthoringTransactionRequest,
  expectedSceneId: string,
): SceneResource {
  const scene = response.committed_scene;
  const baseRevision = request.base_revision;
  if (!expectedSceneId.trim() || !scene || scene.scene?.id !== expectedSceneId
    || typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || baseRevision < 0
    || !Number.isSafeInteger(response.scene_revision) || response.scene_revision <= baseRevision
    || scene.revision !== response.scene_revision
    || (scene.scene_revision != null && scene.scene_revision !== response.scene_revision)) {
    throw new Error("Antenna transaction ACK has an invalid model identity or revision. Refresh before retrying.");
  }
  if (request.kind !== "merge_patch" || !request.merge_patch) {
    throw new Error("Antenna transaction ACK requires the submitted merge patch.");
  }
  for (const [collection, expected] of Object.entries(request.merge_patch)) {
    const value = (scene as unknown as Record<string, unknown>)[collection];
    // SceneResource serializes these empty collections by omitting their keys.
    const omittedEmpty = value === undefined && Array.isArray(expected) && expected.length === 0
      && ["current_transports", "antenna_port_modes", "antenna_field_solve_stages", "antenna_target_projections", "solved_antenna_drives", "antenna_spectrum_requests"].includes(collection);
    const actual = omittedEmpty ? [] : value;
    const key = collection === "current_transports" ? "name" : "id";
    const ids = Array.isArray(actual) ? actual.map((item) => record(item)?.[key]) : [];
    if (!Array.isArray(expected) || !Array.isArray(actual) || ids.some((id) => typeof id !== "string" || !id.trim())
      || new Set(ids).size !== ids.length || !includesAuthored(actual, expected, collection)) {
      throw new Error(`Antenna transaction ACK omitted or changed submitted ${collection}. Refresh before retrying.`);
    }
  }
  return scene;
}
