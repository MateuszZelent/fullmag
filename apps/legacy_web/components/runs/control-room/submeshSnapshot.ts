import type { FemMeshPart, MeshQualityStats } from "@/lib/session/types";

export type VisibleSubmeshRole = FemMeshPart["role"];

export interface VisibleSubmeshSnapshotItem {
  id: string;
  role: VisibleSubmeshRole;
  objectId: string | null;
  isSelected: boolean;
  isFocused: boolean;
  isDimmed: boolean;
  markers: number[];
  domainCount: number;
  qualityStats: MeshQualityStats | null;
}

export interface VisibleSubmeshSnapshot {
  signature: string;
  generatedAtUnixMs: number;
  selectedEntityId: string | null;
  focusedEntityId: string | null;
  totalPartsCount: number;
  visiblePartsCount: number;
  items: VisibleSubmeshSnapshotItem[];
}

