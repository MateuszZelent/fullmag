import type { AuthoringHistoryRecord } from "@/kernel/authoring/AuthoringHistoryController";
import type { SceneResource } from "@/kernel/api/apiTypes";

import type { InspectorEditSession } from "./InspectorEditSession";

export interface InspectorHistoryApi {
  model: {
    scene: () => Promise<SceneResource>;
  };
}

export interface InspectorHistoryRecorder {
  record: (record: AuthoringHistoryRecord) => void;
}

function sceneRevision(scene: SceneResource): number | null {
  const revision = scene.scene_revision ?? scene.revision;
  return typeof revision === "number" && Number.isFinite(revision)
    ? revision
    : null;
}

async function captureScene(api: InspectorHistoryApi): Promise<SceneResource | null> {
  try {
    return await api.model.scene();
  } catch {
    // Applying a valid Inspector draft must not be turned into a false failure
    // only because the optional history snapshot could not be read.
    return null;
  }
}

/**
 * Apply one Inspector session and record one semantic history entry when the
 * canonical scene revision advances. The panel remains the owner of its
 * draft; this bridge only brackets the already validated Apply callback with
 * authoritative scene snapshots.
 */
export async function applyInspectorSessionWithHistory(
  session: InspectorEditSession | null,
  api: InspectorHistoryApi | null,
  history: InspectorHistoryRecorder | null,
  label = "Inspector changes",
): Promise<boolean> {
  if (!session) return false;
  if (session.mode !== "staged" || !api || !history) {
    return (await session.apply()) === true;
  }

  const before = await captureScene(api);
  const applied = await session.apply();
  if (applied !== true || !before) return applied === true;

  const after = await captureScene(api);
  if (!after) return true;

  const beforeRevision = sceneRevision(before);
  const afterRevision = sceneRevision(after);
  if (
    beforeRevision !== null &&
    afterRevision !== null &&
    afterRevision !== beforeRevision
  ) {
    history.record({
      after,
      before,
      committedRevision: afterRevision,
      label,
    });
  }
  return true;
}
