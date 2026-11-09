import type { ControlRoomApi } from "../api/ControlRoomApi";
import { sceneDocumentPayload } from "../authoring/sceneDocumentPayload";
import {
  confirmedSessionResourceIdentity,
  sessionResourceIdentitiesEqual,
  sessionResourceIdentityFromStatus,
  sessionRequestScopeKey,
  type SessionResourceIdentity,
} from "../resources/sessionResourceIdentity";
import type { ProjectAuthoringSessionBinding } from "./ProjectDocumentController";

/** Bind only the session acknowledged by an explicit create/restore operation.
 * A status/collection failure can be retried read-only; a captured epoch can
 * never be silently replaced by the new current session or API client.
 */
export function createProjectAuthoringSessionBinding(
  api: Pick<ControlRoomApi, "sessions" | "model" | "resourceCacheScope">,
  projectId: string,
  acceptedSessionId: string,
): ProjectAuthoringSessionBinding {
  if (!projectId || !acceptedSessionId) throw new Error("A confirmed project and workspace are required.");
  const apiScope = api.resourceCacheScope;
  let pinned: SessionResourceIdentity | null = null;
  const verifyCurrent = async (expectedSceneRevision?: number) => {
    if (expectedSceneRevision !== undefined &&
        (!Number.isSafeInteger(expectedSceneRevision) || expectedSceneRevision < 0)) {
      throw new Error("The project's scene revision is unavailable. Save was stopped.");
    }
    if (api.resourceCacheScope !== apiScope) throw new Error("The API connection changed. Save was stopped.");
    const scope = sessionRequestScopeKey(pinned);
    const [collection, status] = await Promise.all([
      api.sessions.list(),
      api.sessions.current.status(scope ? { sessionScopeKey: scope } : undefined),
    ]);
    const current = confirmedSessionResourceIdentity(sessionResourceIdentityFromStatus(status), collection);
    if (api.resourceCacheScope !== apiScope || !current || current.sessionId !== acceptedSessionId ||
        (pinned !== null && !sessionResourceIdentitiesEqual(pinned, current))) {
      throw new Error("The project's workspace changed. Save could not confirm the current scene.");
    }
    if (expectedSceneRevision !== undefined && status.resources.scene_revision !== expectedSceneRevision) {
      throw new Error("The scene changed during Save. Save again to include the latest edits.");
    }
    pinned ??= Object.freeze({ ...current });
  };
  return {
    projectId,
    verifyCurrent,
    async readSceneDocument() {
      await verifyCurrent();
      const scope = sessionRequestScopeKey(pinned);
      if (!scope) throw new Error("The project's workspace scope is unavailable.");
      const scene = await api.model.scene({ sessionScopeKey: scope });
      const revision = scene.revision ?? scene.scene_revision;
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 ||
          (scene.revision != null && scene.scene_revision != null && scene.revision !== scene.scene_revision)) {
        throw new Error("The project's scene revision is unavailable. Save was stopped.");
      }
      await verifyCurrent(revision);
      return { ...sceneDocumentPayload(scene), revision };
    },
  };
}
