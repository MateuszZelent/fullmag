import type { FieldSliceMeta } from "@/src/api/types";
import type { Slice2DToolbarState } from "@/src/features/slice2d";
import type { FemMeshPart, MeshEntityViewStateMap } from "../../../lib/session/types";
import type { ObjectViewMode } from "../../runs/control-room/shared";
import { type SlicePlane, collectSliceTopology } from "./femSliceGeometry";
import { type FemMeshData } from "./femMeshTypes";
import { defaultSliceQuery } from "./femSliceQuery";
import { getSliceTopologyCached, topologyCacheKey } from "./femSliceCache";
import { buildSliceVisibilityState } from "./femSliceUtils";

export interface SliceMeshOverlaySegment2D {
  a: [number, number];
  b: [number, number];
  partId?: string | null;
}

export interface SliceMeshOverlay2D {
  topologyKey: string;
  segments: SliceMeshOverlaySegment2D[];
}

export const SLICE_MESH_OVERLAY_SOFT_SEGMENT_CAP = 20_000;
export const SLICE_MESH_OVERLAY_HARD_SEGMENT_CAP = 50_000;

export function capSliceMeshOverlay2D(
  overlay: SliceMeshOverlay2D,
  hardCap = SLICE_MESH_OVERLAY_HARD_SEGMENT_CAP,
): SliceMeshOverlay2D {
  if (overlay.segments.length <= hardCap) {
    return overlay;
  }
  const stride = Math.ceil(overlay.segments.length / hardCap);
  return {
    topologyKey: `${overlay.topologyKey}:sampled:${stride}`,
    segments: Array.from(
      { length: hardCap },
      (_, index) => overlay.segments[Math.floor((index * overlay.segments.length) / hardCap)]!,
    ),
  };
}

export interface BuildExactSliceMeshOverlay2DArgs {
  meshData: FemMeshData;
  meta: FieldSliceMeta;
  toolbar: Slice2DToolbarState | null;
  meshParts: readonly FemMeshPart[];
  meshEntityViewState: MeshEntityViewStateMap;
  airSegmentVisible: boolean;
  objectViewMode: ObjectViewMode;
  visibleObjectIds: Iterable<string>;
  partRoleFilter?: ReadonlySet<FemMeshPart["role"]>;
}

function resolveExactSliceCutWorld(
  meta: FieldSliceMeta,
  toolbar: Slice2DToolbarState | null,
): number | null {
  if (typeof meta.cut_world === "number" && Number.isFinite(meta.cut_world)) {
    return meta.cut_world;
  }
  if (typeof toolbar?.positionWorld === "number" && Number.isFinite(toolbar.positionWorld)) {
    return toolbar.positionWorld;
  }
  return null;
}

function slicePlaneQuery(plane: SlicePlane, cutWorld: number) {
  return {
    ...defaultSliceQuery(),
    orientation: plane,
    positionMode: "world" as const,
    planeOffset: cutWorld,
    thicknessMode: "exact" as const,
    thicknessWorld: 0,
  };
}

export function buildExactSliceMeshOverlay2D(
  args: BuildExactSliceMeshOverlay2DArgs,
): SliceMeshOverlay2D | null {
  if (!args.meta.bounds) {
    return null;
  }
  const cutWorld = resolveExactSliceCutWorld(args.meta, args.toolbar);
  if (cutWorld == null) {
    return null;
  }

  const visibility = buildSliceVisibilityState({
    meshData: args.meshData,
    meshParts: args.meshParts,
    meshEntityViewState: args.meshEntityViewState,
    airSegmentVisible: args.airSegmentVisible,
    objectViewMode: args.objectViewMode,
    visibleObjectIds: args.visibleObjectIds,
    vectorDomainFilter: "full_domain",
  });

  const query = slicePlaneQuery(args.meta.plane, cutWorld);
  const key = topologyCacheKey(query, {
    planeWorldCoord: cutWorld,
    meshNodes: args.meshData.nodes as unknown as object,
    meshElements: args.meshData.elements as unknown as object,
    meshBoundaryFaces: args.meshData.boundaryFaces as unknown as object,
    visibleElements: visibility.visibleElements,
    visibleBoundaryFaces: visibility.visibleBoundaryFaces,
    visiblePartIds: visibility.visiblePartIds,
    boundsStrategy: "visible-context",
  });

  const topology = getSliceTopologyCached(key, () =>
    collectSliceTopology(
      args.meshData,
      args.meta.plane,
      cutWorld,
      visibility,
      "visible-context",
    ),
  ).value;
  const segments = args.partRoleFilter
    ? topology.segments.filter((segment) => {
        const part = segment.partId ? visibility.partById.get(segment.partId) : null;
        return part ? args.partRoleFilter?.has(part.role) === true : false;
      })
    : topology.segments;

  return {
    topologyKey: key,
    segments: segments.map((segment) => ({
      a: [segment.a[0], segment.a[1]],
      b: [segment.b[0], segment.b[1]],
      partId: segment.partId,
    })),
  };
}
