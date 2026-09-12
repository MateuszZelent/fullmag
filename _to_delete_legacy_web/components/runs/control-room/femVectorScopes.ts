import type {
  FemMeshPart,
  MeshEntityViewStateMap,
} from "@/lib/session/types";
import { defaultMeshEntityViewState } from "@/lib/session/types";
import type { FieldSampleScopeKind } from "@/src/api/types";
import type { DecodedFieldVector } from "@/src/api/codecs/types";

export type FemVectorScope =
  | { kind: "full"; id?: null }
  | { kind: Extract<FieldSampleScopeKind, "object" | "part" | "airbox" | "selection">; id?: string | null };

type FemFieldDomain = "magnetic_only" | "full_domain" | "surface_only";
type FemVectorDomainFilter = "auto" | "magnetic_only" | "full_domain" | "airbox_only";

export interface ScopedFemVectorFrame {
  scope: FemVectorScope;
  field: DecodedFieldVector;
}

export interface DenseFemVectorField {
  values: Float64Array;
  activeMask: boolean[] | null;
  nComp: number;
  grid: [number, number, number];
}

function partVisible(part: FemMeshPart, state: MeshEntityViewStateMap): boolean {
  return state[part.id]?.visible ?? defaultMeshEntityViewState(part).visible;
}

export function deriveFemVectorScopes(args: {
  meshParts: FemMeshPart[];
  meshEntityViewState: MeshEntityViewStateMap;
  airMeshVisible: boolean;
  vectorDomainFilter?: FemVectorDomainFilter | null;
  selectedFieldDomain?: FemFieldDomain | null;
}): FemVectorScope[] {
  const { meshParts, meshEntityViewState, vectorDomainFilter, selectedFieldDomain } = args;
  if (meshParts.length === 0) {
    return [{ kind: "full" }];
  }

  if (
    selectedFieldDomain === "full_domain" ||
    selectedFieldDomain === "surface_only" ||
    vectorDomainFilter === "full_domain"
  ) {
    return [{ kind: "full" }];
  }

  const visibleObjectIds = new Set<string>();
  for (const part of meshParts) {
    if (part.role !== "magnetic_object" || !partVisible(part, meshEntityViewState)) {
      continue;
    }
    if (!part.object_id) {
      return [{ kind: "full" }];
    }
    visibleObjectIds.add(part.object_id);
  }

  if (visibleObjectIds.size === 0) {
    return [{ kind: "full" }];
  }

  return Array.from(visibleObjectIds)
    .sort()
    .map((id) => ({ kind: "object", id }));
}

function nodeIndicesForObject(meshParts: FemMeshPart[], objectId: string): number[] {
  const indices: number[] = [];
  const seen = new Set<number>();
  for (const part of meshParts) {
    if (part.role !== "magnetic_object" || part.object_id !== objectId) {
      continue;
    }
    if (part.node_indices.length > 0) {
      for (const nodeIndex of part.node_indices) {
        if (!seen.has(nodeIndex)) {
          seen.add(nodeIndex);
          indices.push(nodeIndex);
        }
      }
      continue;
    }
    for (let offset = 0; offset < part.node_count; offset += 1) {
      const nodeIndex = part.node_start + offset;
      if (!seen.has(nodeIndex)) {
        seen.add(nodeIndex);
        indices.push(nodeIndex);
      }
    }
  }
  return indices.sort((a, b) => a - b);
}

export function buildDenseFemVectorField(args: {
  nNodes: number;
  meshParts: FemMeshPart[];
  frames: ScopedFemVectorFrame[];
}): DenseFemVectorField | null {
  const { nNodes, meshParts, frames } = args;
  if (nNodes <= 0 || frames.length === 0) {
    return null;
  }

  if (frames.length === 1 && frames[0]?.scope.kind === "full") {
    const field = frames[0].field;
    return {
      values: field.values,
      activeMask: null,
      nComp: field.nComp,
      grid: field.grid,
    };
  }

  const dense = new Float64Array(nNodes * 3);
  const activeMask = new Array<boolean>(nNodes).fill(false);
  let wroteAny = false;

  for (const frame of frames) {
    if (frame.scope.kind !== "object" || !frame.scope.id || frame.field.nComp < 3) {
      return null;
    }
    const nodeIndices = nodeIndicesForObject(meshParts, frame.scope.id);
    const pointCount = Math.floor(frame.field.values.length / frame.field.nComp);
    if (nodeIndices.length === 0 || pointCount === 0) {
      continue;
    }
    const copyCount = Math.min(nodeIndices.length, pointCount);
    for (let sourceIndex = 0; sourceIndex < copyCount; sourceIndex += 1) {
      const targetNodeIndex = nodeIndices[sourceIndex];
      if (targetNodeIndex < 0 || targetNodeIndex >= nNodes) {
        continue;
      }
      dense[targetNodeIndex * 3] = frame.field.values[sourceIndex * frame.field.nComp] ?? 0;
      dense[targetNodeIndex * 3 + 1] = frame.field.values[sourceIndex * frame.field.nComp + 1] ?? 0;
      dense[targetNodeIndex * 3 + 2] = frame.field.values[sourceIndex * frame.field.nComp + 2] ?? 0;
      activeMask[targetNodeIndex] = true;
      wroteAny = true;
    }
  }

  if (!wroteAny) {
    return null;
  }

  return {
    values: dense,
    activeMask,
    nComp: 3,
    grid: [nNodes, 1, 1],
  };
}
