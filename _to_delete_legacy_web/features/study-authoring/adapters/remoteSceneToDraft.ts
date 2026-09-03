/**
 * Layer C: Adapters – Remote Scene → Draft
 *
 * Explicit adapter from backend session snapshot to local authoring draft.
 * This is one of only two allowed transformations between canonical representations.
 */

import type { SceneDocument, ModelBuilderGraphV2, ScriptBuilderState } from "@/lib/session/types";
import { buildSceneDocumentFromScriptBuilder } from "@/lib/session/sceneDocument";
import { buildModelBuilderGraphV2, serializeModelBuilderGraphV2 } from "@/lib/session/modelBuilderGraph";

/**
 * Hydrate a SceneDraft from the remote session state.
 * Called once per session hydration — not on every SSE tick.
 */
export function remoteSceneToDraft(
  remoteScene: SceneDocument | null,
  remoteGraph: ModelBuilderGraphV2 | null,
  scriptBuilder: ScriptBuilderState | null,
): SceneDocument | null {
  const graph = remoteGraph ?? (scriptBuilder ? buildModelBuilderGraphV2(scriptBuilder) : null);
  if (!graph) return null;

  const hydratedScene =
    remoteScene ??
    buildSceneDocumentFromScriptBuilder({
      revision: graph.revision,
      initial_state: graph.study.initial_state,
      ...serializeModelBuilderGraphV2(graph),
    });

  // Preserve runtime selection from graph
  hydratedScene.study.requested_backend =
    remoteScene?.study.requested_backend ?? graph.study.requested_backend;
  hydratedScene.study.requested_device =
    remoteScene?.study.requested_device ?? graph.study.requested_device;
  hydratedScene.study.requested_precision =
    remoteScene?.study.requested_precision ?? graph.study.requested_precision;
  hydratedScene.study.requested_mode =
    remoteScene?.study.requested_mode ?? graph.study.requested_mode;

  return hydratedScene;
}
