import type { resolveObjectMagneticTexturePanelModel } from "./ObjectMagneticTexturePanelModel";

interface AuthoringScriptSyncApi {
  model: {
    syncAuthoringScript: (request: Record<string, never>) => Promise<unknown>;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function syncAuthoringScriptBestEffort(
  api: AuthoringScriptSyncApi,
): Promise<string | null> {
  try {
    await api.model.syncAuthoringScript({});
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
