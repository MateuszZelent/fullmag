import type { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import type { MagnetizationApplyReceipt, MagnetizationApplyTarget } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";

import type { resolveObjectMagneticTexturePanelModel } from "./ObjectMagneticTexturePanelModel";

export function commitMagneticTextureApply(
  api: ControlRoomApi,
  context: Parameters<typeof runAuthoringMutationWithHistory>[0],
  target: MagnetizationApplyTarget,
  baseRevision: number | null,
) {
  const sessionScopeKey = context.sessionScopeKey;
  if (!sessionScopeKey || baseRevision === null) {
    throw new Error("The saved scene and session are required to apply magnetization.");
  }
  const label = target.kind === "region" ? target.region_id : target.object_id;
  return runAuthoringMutationWithHistory(context, `Apply magnetic texture ${label}`, (before) => {
    if (before.baseRevision !== null && before.baseRevision !== baseRevision) {
      throw new Error("The scene changed before Apply. Review the refreshed texture and try again.");
    }
    return api.model.applyMagnetization(target, { baseRevision, sessionScopeKey });
  });
}

export function magneticTextureApplyMessage(
  receipt: MagnetizationApplyReceipt,
  syncWarning: string | null,
): string {
  const state = receipt.status === "initial_state_ready"
    ? "Initial magnetization is ready."
    : `Initial magnetization is pending. ${receipt.reason ?? "Prepare the current mesh or grid to preview it."}`;
  return `Magnetic texture applied. ${state}${syncWarning ? ` Script sync skipped. ${syncWarning}` : ""}`;
}

interface AuthoringScriptSyncApi {
  model: {
    syncAuthoringScript: (
      request: Record<string, never>,
      options?: { sessionScopeKey?: string },
    ) => Promise<unknown>;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort script sync after an authoring change. For a session whose
 * script is a user file the API writes only the managed canonical copy and
 * leaves the user's source untouched, so this never rewrites user files.
 */
export async function syncAuthoringScriptBestEffort(
  api: AuthoringScriptSyncApi,
  sessionScopeKey?: string | null,
): Promise<string | null> {
  try {
    if (sessionScopeKey) {
      await api.model.syncAuthoringScript({}, { sessionScopeKey });
    } else {
      await api.model.syncAuthoringScript({});
    }
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

export type MagneticTexturePanelModel = ReturnType<
  typeof resolveObjectMagneticTexturePanelModel
>;

type MagneticTextureInspectorView =
  | "overview"
  | "asset"
  | "load"
  | "region"
  | "transform";

export function magneticTextureInspectorView(
  selectionKind: string | null,
): MagneticTextureInspectorView {
  switch (selectionKind) {
    case "object.magnetic-texture.asset":
      return "asset";
    case "object.magnetic-texture.load":
      return "load";
    case "object.region.texture":
    case "object.region-magnetic-texture":
      return "region";
    case "object.magnetic-texture.transform":
      return "transform";
    case "object.magnetic-texture":
    default:
      return "overview";
  }
}
