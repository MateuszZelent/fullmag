/**
 * Hook that tracks visible submesh state and reports snapshot changes.
 *
 * Extracted from FemMeshView3D to keep the main component under ~1000 lines.
 */
import { useEffect, useMemo, useRef } from "react";

import type {
  FemMeshPart,
  MeshQualityStats,
} from "../../../lib/session/types";
import type { VisibleSubmeshSnapshot } from "../../runs/control-room/submeshSnapshot";
import type { RenderLayer } from "./femMeshTypes";
import { markersForPart } from "@/features/viewport-fem/model/femTopologyCache";
import { combineMeshQualityStats } from "./femQualityUtils";

export interface PartQualitySummary {
  markers: number[];
  domainCount: number;
  stats: MeshQualityStats | null;
}

export interface UseFemSubmeshSnapshotArgs {
  meshParts: FemMeshPart[];
  elementMarkers: number[] | null;
  perDomainQuality: Record<number, MeshQualityStats> | null;
  hasMeshParts: boolean;
  visibleLayers: RenderLayer[];
  selectedEntityId: string | null;
  focusedEntityId: string | null;
  onVisibleSubmeshSnapshotChange?: (snapshot: VisibleSubmeshSnapshot | null) => void;
}

export function useFemSubmeshSnapshot({
  meshParts,
  elementMarkers,
  perDomainQuality,
  hasMeshParts,
  visibleLayers,
  selectedEntityId,
  focusedEntityId,
  onVisibleSubmeshSnapshotChange,
}: UseFemSubmeshSnapshotArgs) {
  const lastSubmeshSnapshotSignatureRef = useRef<string | null>(null);

  const partQualityById = useMemo(() => {
    const entries = new Map<string, PartQualitySummary>();
    for (const part of meshParts) {
      const markers = markersForPart(part, elementMarkers);
      const qualityEntries = markers
        .map((marker) => perDomainQuality?.[marker] ?? null)
        .filter((entry): entry is MeshQualityStats => Boolean(entry));
      entries.set(part.id, {
        markers,
        domainCount: qualityEntries.length,
        stats: combineMeshQualityStats(qualityEntries),
      });
    }
    return entries;
  }, [elementMarkers, meshParts, perDomainQuality]);

  useEffect(() => {
    if (!onVisibleSubmeshSnapshotChange) {
      return;
    }
    if (!hasMeshParts) {
      if (lastSubmeshSnapshotSignatureRef.current !== null) {
        lastSubmeshSnapshotSignatureRef.current = null;
        onVisibleSubmeshSnapshotChange(null);
      }
      return;
    }
    const items = visibleLayers.map((layer) => {
      const quality = partQualityById.get(layer.part.id) ?? null;
      return {
        id: layer.part.id,
        role: layer.part.role,
        objectId: layer.part.object_id ?? null,
        isSelected: layer.isSelected,
        isFocused: focusedEntityId === layer.part.id,
        isDimmed: layer.isDimmed,
        markers: quality?.markers ?? [],
        domainCount: quality?.domainCount ?? 0,
        qualityStats: quality?.stats ?? null,
      };
    });
    const signature = [
      `total=${meshParts.length}`,
      `visible=${visibleLayers.length}`,
      `selected=${selectedEntityId ?? ""}`,
      `focused=${focusedEntityId ?? ""}`,
      items
        .map(
          (item) =>
            `${item.id}:${item.isSelected ? 1 : 0}:${item.isFocused ? 1 : 0}:${item.isDimmed ? 1 : 0}`,
        )
        .join("|"),
    ].join("::");
    if (signature === lastSubmeshSnapshotSignatureRef.current) {
      return;
    }
    lastSubmeshSnapshotSignatureRef.current = signature;
    onVisibleSubmeshSnapshotChange({
      signature,
      generatedAtUnixMs: Date.now(),
      selectedEntityId,
      focusedEntityId,
      totalPartsCount: meshParts.length,
      visiblePartsCount: visibleLayers.length,
      items,
    });
  }, [
    focusedEntityId,
    hasMeshParts,
    meshParts.length,
    onVisibleSubmeshSnapshotChange,
    partQualityById,
    selectedEntityId,
    visibleLayers,
  ]);

  return { partQualityById };
}
