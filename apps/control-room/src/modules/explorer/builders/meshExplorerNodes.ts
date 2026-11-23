import type {
  ExplorerNode,
  ExplorerNodeStatus,
  ModelTreeSnapshot,
} from "../explorerTypes";
import type {
  DomainMetaResource,
  FdmMultilayerLayoutResource,
} from "@/kernel/api/apiTypes";
import type { FdmDomainPresentation } from "@/shared/domain/mesh/domainPresentation";
import { meshPipelineStatusIsActive } from "@/shared/domain/mesh/buildPipeline";
import {
  resolveMeshBuildFreshness,
  type MeshFreshnessState,
} from "@/shared/domain/mesh/meshBuildFreshness";
import {
  isFdmDomain,
  isFemDomain,
} from "@/shared/domain/mesh/domainPresentation";

export function meshRootStatus(mesh: ModelTreeSnapshot["mesh"]): ExplorerNodeStatus {
  if (mesh?.lastError) return "mesh-failed";
  if (meshPipelineStatusIsActive(mesh?.activeBuildStatus)) {
    return "mesh-building";
  }
  if (mesh?.meshName) return "mesh-ready";
  return "mesh-stale";
}

function meshRootBadge(mesh: ModelTreeSnapshot["mesh"]): string {
  if (
    mesh?.lastError &&
    mesh.latestBuildStatus &&
    mesh.meshName &&
    mesh.meshRevision != null
  ) {
    return `failed · retained ${mesh.meshName}`;
  }
  if (mesh?.lastError) return "failed";
  if (mesh?.activeBuildStatus) return mesh.activeBuildStatus;
  if (mesh?.meshName) return mesh.meshName;
  return "not built";
}

export function meshFreshnessState(mesh: ModelTreeSnapshot["mesh"]): MeshFreshnessState {
  return resolveMeshBuildFreshness({
    activeBuild: mesh?.activeBuildStatus
      ? { status: mesh.activeBuildStatus }
      : null,
    latestBuild: mesh?.latestBuildStatus
      ? {
          source_scene_revision: mesh.latestBuildSourceSceneRevision ?? null,
          status: mesh.latestBuildStatus,
        }
      : null,
    manifest:
      mesh?.manifestSourceSceneRevision != null ||
      mesh?.manifestValidatedSceneRevision != null
        ? {
            source_scene_revision: mesh.manifestSourceSceneRevision,
            validated_for_scene_revision: mesh.manifestValidatedSceneRevision,
          }
        : null,
    sceneRevision: mesh?.sourceSceneRevision ?? null,
    statusMeshRevision: mesh?.meshRevision ?? null,
  }).state;
}

export function meshFreshnessStatus(
  freshness: MeshFreshnessState,
  fallback: ExplorerNodeStatus,
): ExplorerNodeStatus {
  if (freshness === "building") return "mesh-building";
  if (freshness === "current") return "mesh-ready";
  if (freshness === "failed") return "mesh-failed";
  if (freshness === "not-built") return "mesh-stale";
  if (freshness === "stale") return "mesh-stale";
  return fallback;
}

function meshFreshnessBadge(freshness: MeshFreshnessState): string {
  if (freshness === "not-built") return "not built";
  return freshness;
}

function meshBuildPipelineBadge(mesh: ModelTreeSnapshot["mesh"]): string {
  const revision = mesh?.meshRevision ?? mesh?.buildRevision ?? "none";
  const sourceSceneRevision =
    mesh?.manifestSourceSceneRevision ?? mesh?.latestBuildSourceSceneRevision;
  if (
    mesh?.lastError &&
    mesh.latestBuildStatus &&
    mesh.meshRevision != null
  ) {
    return `failed · retained rev ${mesh.meshRevision}`;
  }
  return sourceSceneRevision != null
    ? `rev ${revision} · scene ${sourceSceneRevision}`
    : `rev ${revision}`;
}

export function buildMeshPolicyNode(mesh: ModelTreeSnapshot["mesh"]): ExplorerNode {
  const status = meshRootStatus(mesh);
  const freshness = meshFreshnessState(mesh);
  const sharedDomainStatus = meshFreshnessStatus(freshness, status);
  const partCount = mesh?.partCount ?? 0;
  const objectSegmentCount = mesh?.objectSegmentCount ?? 0;
  const regionCount = mesh?.regionCount ?? 0;
  const sizeFieldCount = mesh?.realizedSizeFieldCount ?? 0;
  const visualizationPartFallbacks = mesh?.visualizationPartFallbacks ?? [];

  return {
    id: "model:mesh",
    kind: "mesh.root",
    label: "Mesh",
    parentId: "model:session",
    badge: meshRootBadge(mesh),
    icon: "mesh",
    status,
    contextCommands: [
      "mesh.build-shared-domain",
      "mesh.open-overview",
      "mesh.open-builds",
      "mesh.open-quality",
    ],
    children: [
      {
        id: "model:mesh:shared-domain",
        kind: "mesh.shared-domain",
        label: "Domain Mesh",
        parentId: "model:mesh",
        badge: meshFreshnessBadge(freshness),
        icon: "mesh",
        status: sharedDomainStatus,
        contextCommands: ["mesh.build-shared-domain", "mesh.open-shared-domain"],
      },
      {
        id: "model:mesh:builds",
        kind: "mesh.builds",
        label: "Build History",
        parentId: "model:mesh",
        badge: meshBuildPipelineBadge(mesh),
        icon: "activity",
        selectable: true,
        status,
        contextCommands: ["mesh.build-shared-domain", "mesh.open-builds"],
      },
      {
        id: "model:mesh:quality",
        kind: "mesh.quality",
        label: "Quality Gates",
        parentId: "model:mesh",
        badge: mesh?.qualityStatus ?? "quality",
        icon: "gauge",
        status: mesh?.qualityStatus === "failed" ? "failed" : "ready",
        contextCommands: ["mesh.open-quality"],
      },
      {
        id: "model:mesh:size-fields",
        kind: "mesh.size-fields",
        label: "Realized Size Fields",
        parentId: "model:mesh",
        badge: `${sizeFieldCount}`,
        icon: "settings",
        status: sizeFieldCount > 0 ? "ready" : "stale",
        contextCommands: ["mesh.open-size-fields"],
      },
      {
        id: "model:mesh:regions",
        kind: "mesh.regions",
        label: "Regions And Mesh Parts",
        parentId: "model:mesh",
        badge: `${regionCount} regions / ${partCount} parts`,
        icon: "layers",
        status: partCount > 0 || objectSegmentCount > 0 ? "ready" : "stale",
        contextCommands: ["mesh.open-regions"],
      },
      ...(visualizationPartFallbacks.length > 0
        ? [
            {
              id: "model:mesh:unassigned",
              kind: "mesh.unassigned" as const,
              label: "Unassigned mesh parts",
              parentId: "model:mesh",
              badge: `${visualizationPartFallbacks.length}`,
              icon: "layers" as const,
              status: "warning" as const,
              children: visualizationPartFallbacks.map((part) => ({
                id: `model:mesh:unassigned:${encodeURIComponent(part.id)}`,
                kind: "mesh.unassigned.part" as const,
                label: part.label,
                meshPartId: part.id,
                visualizationTargetId: part.visualizationTargetId,
                parentId: "model:mesh:unassigned",
                badge: "orphan",
                icon: "mesh" as const,
                status: "warning" as const,
              })),
            },
          ]
        : []),
    ],
  };
}

export function buildFdmMeshPolicyNode(
  presentation: FdmDomainPresentation | null,
  domainMeta: DomainMetaResource | null | undefined,
  presentationStatus: ModelTreeSnapshot["domainPresentationStatus"] = "idle",
  multilayerLayout: FdmMultilayerLayoutResource | null | undefined = null,
  multilayerLayoutStatus: ModelTreeSnapshot["fdmMultilayerLayoutStatus"] = "idle",
): ExplorerNode {
  const fallbackShape = (domainMeta?.grid?.shape ?? [0, 0, 0]) as [number, number, number];
  const fallbackOrigin = (domainMeta?.grid?.origin ?? [0, 0, 0]) as [number, number, number];
  const fallbackSpacing = (domainMeta?.grid?.spacing ?? [0, 0, 0]) as [number, number, number];
  const grid = presentation?.fdmGrid ?? {
    descriptor: domainMeta?.grid ?? {
      origin: fallbackOrigin,
      shape: fallbackShape,
      spacing: fallbackSpacing,
    },
    gridFingerprint: null,
    membership: null,
    membershipStatus:
      presentationStatus === "error"
        ? "error"
        : presentationStatus === "loading"
          ? "loading"
          : presentationStatus === "stale"
            ? "stale"
            : "missing",
    origin: fallbackOrigin,
    shape: fallbackShape,
    spacing: fallbackSpacing,
    totalCells: fallbackShape.reduce((product, value) => product * value, 1),
  };
  const resolvedStatus = presentation?.resourceStatus ?? grid.membershipStatus;
  const status: ExplorerNodeStatus =
    !presentation && presentationStatus === "error"
      ? "degraded"
      : resolvedStatus === "realized"
        ? "mesh-ready"
        : resolvedStatus === "error"
          ? "mesh-failed"
          : resolvedStatus === "loading"
            ? "mesh-building"
            : resolvedStatus === "stale" || resolvedStatus === "incompatible"
              ? "mesh-stale"
              : resolvedStatus === "authoring-grid" || resolvedStatus === "missing"
                ? "mesh-stale"
                : presentationStatus === "error"
                  ? "degraded"
                  : presentationStatus === "loading"
                    ? "mesh-building"
                    : "ready";

  const cellCount = grid.totalCells;
  const structuredGridId = "model:mesh:grid";
  const layerChildren = fdmMultilayerDirectLayerNodes(
    structuredGridId,
    multilayerLayout,
    multilayerLayoutStatus,
  );

  return {
    id: "model:mesh",
    kind: "mesh.root",
    label: "Mesh",
    parentId: "model:session",
    badge: `FDM · ${grid.shape.join(" × ")} / ${cellCount} cells`,
    icon: "mesh",
    status,
    contextCommands: ["grid.build-fdm", "workspace.focus-selection"],
    children: [
      {
        id: structuredGridId,
        kind: "mesh.grid",
        label: "Structured Grid",
        parentId: "model:mesh",
        badge: `${grid.shape.join(" × ")} / ${cellCount} cells`,
        icon: "mesh",
        selectable: true,
        status,
        visualizationTargetId: "fdm-domain",
        contextCommands: ["grid.build-fdm"],
        ...(layerChildren.length > 0 ? { children: layerChildren } : {}),
      },
      {
        id: "model:mesh:builds",
        kind: "mesh.builds",
        label: "Build History",
        parentId: "model:mesh",
        badge:
          grid.gridFingerprint ??
          presentation?.generationId ??
          domainMeta?.generation_id ??
          "execution artifact",
        icon: "activity",
        selectable: true,
        status,
      },
    ],
  };
}

function fdmMultilayerDirectLayerNodes(
  parentId: string,
  layout: FdmMultilayerLayoutResource | null | undefined,
  resourceStatus: ModelTreeSnapshot["fdmMultilayerLayoutStatus"],
): ExplorerNode[] {
  if (!layout?.available) return [];
  const tuple3 = (values: readonly number[]): [number, number, number] => [
    values[0] ?? 0,
    values[1] ?? 0,
    values[2] ?? 0,
  ];
  const status: ExplorerNodeStatus =
    resourceStatus === "error"
      ? "degraded"
      : resourceStatus === "loading" || resourceStatus === "stale"
        ? "mesh-building"
        : "ready";

  const sortedLayers = [...layout.layers].sort(
    (left, right) => (left.native_origin[2] ?? 0) - (right.native_origin[2] ?? 0),
  );

  return sortedLayers.map((layer): ExplorerNode => ({
    id: `${parentId}:layer:${encodeURIComponent(layer.layer_id)}`,
    kind: "mesh.grid.layer",
    label: layer.magnet_name,
    parentId,
    layerId: layer.layer_id,
    objectId: layer.object_id,
    badge: `${layer.native_grid.join(" × ")} · ${layer.transfer_kind}`,
    icon: "layers",
    selectable: true,
    status,
    visualizationTargetId: "fdm-domain",
    nativeGrid: tuple3(layer.native_grid),
    nativeCellSize: tuple3(layer.native_cell_size),
    nativeOrigin: tuple3(layer.native_origin),
    gridFingerprint: layer.native_grid_fingerprint,
    transferKind: layer.transfer_kind,
    activeMaskPresent: layer.active_mask_present,
    activeCellCount: layer.active_cell_count,
    inactiveCellCount: layer.inactive_cell_count,
  }));
}

export type ExplorerDomainLane = "fdm" | "fem" | "unresolved";

export function resolveExplorerDomainLane(
  snapshot: ModelTreeSnapshot | null,
): ExplorerDomainLane {
  if (
    snapshot &&
    Object.prototype.hasOwnProperty.call(snapshot, "domainDiscretization")
  ) {
    if (snapshot.domainDiscretization === "fdm") return "fdm";
    if (snapshot.domainDiscretization === "fem") return "fem";
    return "unresolved";
  }
  if (isFdmDomain(snapshot?.domainPresentation)) {
    return "fdm";
  }
  if (isFemDomain(snapshot?.domainPresentation)) {
    return "fem";
  }
  return "unresolved";
}

export function buildUnresolvedMeshPolicyNode(
  presentationStatus: ModelTreeSnapshot["domainPresentationStatus"],
): ExplorerNode {
  const loading = presentationStatus === "loading";
  return {
    id: "model:mesh",
    kind: "mesh.root",
    label: "Mesh",
    parentId: "model:session",
    badge: loading ? "lane loading" : "lane unresolved",
    icon: "mesh",
    status: loading ? "queued" : "unavailable",
    children: [],
  };
}
