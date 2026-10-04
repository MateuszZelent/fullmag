import type { resolveObjectMagneticTexturePanelModel } from "./ObjectMagneticTexturePanelModel";

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
