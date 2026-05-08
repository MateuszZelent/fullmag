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
}

export interface SliceMeshOverlay2D {
  topologyKey: string;
  segments: SliceMeshOverlaySegment2D[];
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

  return {
    topologyKey: key,
    segments: topology.segments.map((segment) => ({
      a: [segment.a[0], segment.a[1]],
      b: [segment.b[0], segment.b[1]],
    })),
  };
}
