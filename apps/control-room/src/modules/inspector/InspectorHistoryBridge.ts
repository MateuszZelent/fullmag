import type { AuthoringHistoryRecord } from "@/kernel/authoring/AuthoringHistoryController";
import type { RequestOptions, SceneResource } from "@/kernel/api/apiTypes";

import type { InspectorEditSession } from "./InspectorEditSession";

export interface InspectorHistoryApi {
  model: {
    scene: (options?: RequestOptions) => Promise<SceneResource>;
  };
}

export interface InspectorHistoryRecorder {
  record: (record: AuthoringHistoryRecord) => void;
}

export interface InspectorHistoryFence {
  isHistoryGenerationCurrent?: () => boolean;
  isCurrent?: () => boolean;
  requestOptions?: RequestOptions;
}

function sceneRevision(scene: SceneResource): number | null {
  const revision = scene.scene_revision ?? scene.revision;
  return typeof revision === "number" && Number.isFinite(revision)
    ? revision
    : null;
}

async function captureScene(
  api: InspectorHistoryApi,
  requestOptions?: RequestOptions,
): Promise<SceneResource | null> {
  try {
    return await api.model.scene(requestOptions);
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
  fence?: InspectorHistoryFence,
): Promise<boolean> {
  if (!session) return false;
  const isCurrent = () => fence?.isCurrent?.() !== false;
  const isHistoryGenerationCurrent = () =>
    fence?.isHistoryGenerationCurrent?.() !== false;
  if (!isCurrent() || !isHistoryGenerationCurrent()) return false;
  if (session.mode !== "staged" || !api || !history) {
    const applied = (await session.apply()) === true;
    return applied && isCurrent();
  }

  const before = await captureScene(api, fence?.requestOptions);
  if (!isCurrent() || !isHistoryGenerationCurrent()) return false;
  const applied = await session.apply();
  if (!isCurrent()) return false;
  if (!isHistoryGenerationCurrent()) return false;
  if (!before) return applied === true;

  const after = await captureScene(api, fence?.requestOptions);
  if (!isCurrent()) return false;
  if (!isHistoryGenerationCurrent()) return false;
  if (!after) return applied === true;

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
  return applied === true;
}
