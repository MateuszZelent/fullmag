import type { SceneResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import type {
  MagnetizationTextureTarget,
  MagnetizationTextureTargetInput,
} from "./types";

export function isExplicitRegionSelectionKind(
  kind: string | null | undefined,
): boolean {
  if (!kind) return false;
  return (
    kind === "object.region" ||
    kind === "object.region-magnetic-texture" ||
    kind.startsWith("object.region.") ||
    kind === "mesh.grid.region"
  );
}

export function parseRegionVisualizationTarget(
  visualizationTargetId: string | null | undefined,
): { objectId: string; regionId: string } | null {
  if (!visualizationTargetId?.startsWith("region:")) return null;
  const rest = visualizationTargetId.slice("region:".length);
  const colonIndex = rest.indexOf(":");
  if (colonIndex <= 0 || colonIndex >= rest.length - 1) return null;
  const objectId = rest.slice(0, colonIndex).trim();
  const regionId = decodeURIComponent(rest.slice(colonIndex + 1)).trim();
  return objectId && regionId ? { objectId, regionId } : null;
}

export function extractMagnetizationTargetInputFromSelection(
  selection: Selection | null | undefined,
): MagnetizationTextureTargetInput {
  if (!selection) return {};
  const ref = selection.ref as
    | (Selection["ref"] & {
        objectId?: string | null;
        regionId?: string | null;
        visualizationTargetId?: string | null;
      })
    | null;

  switch (ref?.type) {
    case "scene-object":
      return {
        kind: selection.kind,
        nodeId: selection.nodeId,
        objectId: ref.objectId ?? selection.objectId,
        regionId: ref.regionId ?? null,
      };
    case "frozen-spins":
    case "fdm-domain":
      return {
        kind: selection.kind,
        nodeId: selection.nodeId,
        objectId: ref.objectId ?? selection.objectId,
        regionId: ref.regionId ?? null,
      };
    case "mesh-part": {
      const parsedRegion = parseRegionVisualizationTarget(ref.visualizationTargetId);
      return {
        kind: selection.kind,
        nodeId: selection.nodeId,
        objectId: ref.objectId ?? parsedRegion?.objectId ?? selection.objectId,
        regionId: parsedRegion?.regionId ?? null,
      };
    }
    case "spin-transport":
    case "physics-module":
      return {
        kind: selection.kind,
        nodeId: selection.nodeId,
        objectId: selection.objectId,
        regionId: ref.regionId ?? null,
      };
    default:
      return {
        kind: selection.kind,
        nodeId: selection.nodeId,
        objectId: selection.objectId,
        regionId: null,
      };
  }
}

export function resolveMagnetizationTextureTarget(
  input: MagnetizationTextureTargetInput,
  scene?: SceneResource | null,
): MagnetizationTextureTarget | null {
  const objectId = normalizeId(input.objectId);
  if (!objectId) return null;

  const regionId = normalizeId(input.regionId);
  const explicitRegionKind = isExplicitRegionSelectionKind(input.kind);

  if (!scene?.objects) {
    if (regionId && explicitRegionKind) {
      return { kind: "region", objectId, regionId };
    }
    return { kind: "object", objectId };
  }

  const obj = scene.objects.find((candidate) => candidate.id === objectId) as
    | {
        id?: string;
        role?: string;
        regions?: readonly { region_id?: string }[];
        region_overrides?: Record<string, unknown>;
      }
    | undefined;
  if (!obj) return null;
  if (obj.role !== undefined && obj.role !== "magnet") {
    return null;
  }

  if (regionId) {
    const isAuthoredSubregion = Boolean(
      obj.regions?.some((r) => r.region_id === regionId),
    );
    const isLegacyRegionOverride = Boolean(
      obj.region_overrides &&
        Object.prototype.hasOwnProperty.call(obj.region_overrides, regionId),
    );
    if (isAuthoredSubregion || isLegacyRegionOverride) {
      return { kind: "region", objectId, regionId };
    }
    if (explicitRegionKind) {
      return null;
    }
  }

  return { kind: "object", objectId };
}

export function sameMagnetizationTextureTarget(
  left: MagnetizationTextureTarget | null,
  right: MagnetizationTextureTarget | null,
): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "object" && right.kind === "object") {
    return left.objectId === right.objectId;
  }
  if (left.kind === "region" && right.kind === "region") {
    return left.objectId === right.objectId && left.regionId === right.regionId;
  }
  return false;
}

function normalizeId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
