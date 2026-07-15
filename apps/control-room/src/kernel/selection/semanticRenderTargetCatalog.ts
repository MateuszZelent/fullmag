import type { MeshSharedDomainManifestResource } from "@/kernel/api/apiTypes";
import { manifestCarrierOwnershipAliases } from "@/kernel/visualization/visualizationDisplayResolution";

import {
  canonicalVisualizationPartTargetId,
  canonicalVisualizationSceneObjectId,
  isVisualizationAirboxIdentity,
  type VisualizationMeshPartLike,
} from "./selectionTypes";

export type SemanticRenderTargetKind = "airbox" | "object" | "part";

export interface SemanticRenderTargetAddress {
  carrierIds: readonly string[];
  explorerNodeId: string;
  explorerTabId: "model";
  label: string;
  targetId: string;
  targetKind: SemanticRenderTargetKind;
}

export interface SemanticRenderTargetCatalog {
  byCarrierId: ReadonlyMap<string, SemanticRenderTargetAddress>;
  byTargetId: ReadonlyMap<string, SemanticRenderTargetAddress>;
  entries: readonly SemanticRenderTargetAddress[];
}

type SemanticManifest = Pick<
  MeshSharedDomainManifestResource,
  "mesh_parts" | "object_segments"
>;

export function semanticRenderTargetCarriersFromManifest(
  manifest: SemanticManifest | null | undefined,
): VisualizationMeshPartLike[] {
  const seenMeshPartIds = new Set<string>();
  const meshParts = (manifest?.mesh_parts ?? []).filter((part) => {
    const id = part.id.trim();
    if (!id || isUniverseOuterBoundaryCarrier(part) || seenMeshPartIds.has(id)) {
      return false;
    }
    seenMeshPartIds.add(id);
    return true;
  });
  const meshOwnership = new Set<string>();
  for (const part of meshParts) {
    for (const alias of manifestCarrierOwnershipAliases(part)) {
      meshOwnership.add(alias);
    }
  }
  const degradedSegments = (manifest?.object_segments ?? []).flatMap(
    (segment, index) =>
      manifestCarrierOwnershipAliases(segment).some((alias) =>
        meshOwnership.has(alias),
      )
        ? []
        : [
            {
              ...segment,
              id: `segment:${segment.object_id}:${index}`,
              label: segment.object_id,
              role: "magnetic" as const,
            },
          ],
  );
  return [...meshParts, ...degradedSegments];
}

export function isUniverseOuterBoundaryCarrier(
  part: Pick<VisualizationMeshPartLike, "role">,
): boolean {
  return part.role?.trim().toLowerCase().replace(/[ -]+/g, "_") === "outer_boundary";
}

export function buildSemanticRenderTargetCatalog({
  parts,
  sceneObjectIds,
}: {
  parts: readonly VisualizationMeshPartLike[];
  sceneObjectIds: ReadonlySet<string>;
}): SemanticRenderTargetCatalog {
  const canonicalSceneObjectIds = new Set(
    [...sceneObjectIds]
      .map(canonicalVisualizationSceneObjectId)
      .filter((objectId) => !isVisualizationAirboxIdentity({ id: objectId })),
  );
  const mutableEntries = new Map<
    string,
    Omit<SemanticRenderTargetAddress, "carrierIds"> & { carrierIds: string[] }
  >();

  mutableEntries.set("airbox", {
    carrierIds: [],
    explorerNodeId: "model:airbox",
    explorerTabId: "model",
    label: "Airbox",
    targetId: "airbox",
    targetKind: "airbox",
  });

  for (const objectId of canonicalSceneObjectIds) {
    const targetId = `object:${objectId}`;
    mutableEntries.set(targetId, {
      carrierIds: [],
      explorerNodeId: `model:object:${objectId}`,
      explorerTabId: "model",
      label: objectId,
      targetId,
      targetKind: "object",
    });
  }

  for (const part of parts) {
    if (isUniverseOuterBoundaryCarrier(part)) continue;
    const targetId = semanticTargetIdForMeshPart(part, canonicalSceneObjectIds);
    const existing = mutableEntries.get(targetId);
    if (existing) {
      if (!existing.carrierIds.includes(part.id)) existing.carrierIds.push(part.id);
      continue;
    }

    mutableEntries.set(targetId, {
      carrierIds: [part.id],
      explorerNodeId: `model:mesh:unassigned:${encodeURIComponent(part.id)}`,
      explorerTabId: "model",
      label: part.label?.trim() || part.id,
      targetId,
      targetKind: "part",
    });
  }

  const entries = [...mutableEntries.values()].map(
    (entry): SemanticRenderTargetAddress => ({
      ...entry,
      carrierIds: [...entry.carrierIds],
    }),
  );
  const byTargetId = new Map(entries.map((entry) => [entry.targetId, entry]));
  const byCarrierId = new Map<string, SemanticRenderTargetAddress>();
  for (const entry of entries) {
    for (const carrierId of entry.carrierIds) byCarrierId.set(carrierId, entry);
  }

  return { byCarrierId, byTargetId, entries };
}

export function resolveSemanticTargetForMeshPart(
  catalog: SemanticRenderTargetCatalog,
  part: Pick<VisualizationMeshPartLike, "id">,
): SemanticRenderTargetAddress | null {
  return catalog.byCarrierId.get(part.id) ?? null;
}

function semanticTargetIdForMeshPart(
  part: VisualizationMeshPartLike,
  sceneObjectIds: ReadonlySet<string>,
): string {
  if (isVisualizationAirboxIdentity(part)) return "airbox";

  for (const candidate of [part.object_id, part.geometry_id]) {
    if (!candidate) continue;
    const objectId = canonicalVisualizationSceneObjectId(candidate);
    if (sceneObjectIds.has(objectId)) return `object:${objectId}`;
  }

  return canonicalPartTargetId(part.id);
}

function canonicalPartTargetId(carrierId: string): string {
  return canonicalVisualizationPartTargetId(carrierId);
}
