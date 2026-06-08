import type {
  JsonObject,
  JsonValue,
  ObjectPatchRequest,
  RegionPatchRequest,
} from "@/kernel/api/apiTypes";
import type { components } from "@/kernel/api/generated/openapi-v2-types";

export type MagnetizationTextureTarget =
  | { kind: "object"; objectId: string }
  | { kind: "region"; objectId: string; regionId: string };

export interface MagnetizationTextureTargetInput {
  kind?: string | null;
  nodeId?: string | null;
  objectId?: string | null;
  regionId?: string | null;
}

type MagnetizationTextureAssignment =
  | "missing"
  | "object"
  | "object-inherited"
  | "region-override";

export interface MagnetizationAssetDraft {
  [key: string]: JsonValue | undefined;
  id: string;
  kind: string;
  mapping?: JsonObject;
  name: string;
  preset_kind?: string;
  preset_params?: JsonObject;
  preset_version?: number;
  texture_transform?: JsonObject;
  ui_label?: string;
}

export interface MagnetizationTextureModel {
  asset: MagnetizationAssetDraft | null;
  assignment: MagnetizationTextureAssignment;
  baseRevision: number | null;
  effectiveMagnetizationRef: string | null;
  objectMagnetizationRef: string | null;
  regionMagnetizationRef: string | null;
  target: MagnetizationTextureTarget;
}

export type MagnetizationAssignmentPatch =
  | { path: "object"; payload: ObjectPatchRequest }
  | { path: "region"; payload: RegionPatchRequest };

export type RegionTextureOverridePatch =
  components["schemas"]["SceneObjectRegionPatch"];
