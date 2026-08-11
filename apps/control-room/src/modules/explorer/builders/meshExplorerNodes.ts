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
import { canonicalVisualizationSceneObjectId } from "@/kernel/selection/selectionTypes";
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
    manifest: mesh?.manifestSourceSceneRevision != null
      ? { source_scene_revision: mesh.manifestSourceSceneRevision }
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

export function buildMeshPolicyNode(mesh: ModelTreeSnapshot["mesh"]): ExplorerNode {
  const status = meshRootStatus(mesh);
  const freshness = meshFreshnessState(mesh);
  const sharedDomainStatus = meshFreshnessStatus(freshness, status);
  const revision = mesh?.meshRevision ?? mesh?.buildRevision ?? "none";
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
        label: "Build Pipeline",
        parentId: "model:mesh",
        badge: `rev ${revision}`,
        icon: "activity",
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
    descriptor: domainMeta?.grid ?? { origin: fallbackOrigin, shape: fallbackShape, spacing: fallbackSpacing },
    gridFingerprint: null,
    membership: null,
    membershipStatus:
      presentationStatus === "error" ? "error" : presentationStatus === "loading" ? "loading" : presentationStatus === "stale" ? "stale" : "missing",
    origin: fallbackOrigin,
    shape: fallbackShape,
    spacing: fallbackSpacing,
    totalCells: fallbackShape.reduce((product, value) => product * value, 1),
  };
  const membership = grid.membership;
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
  const domainMeshId = "model:mesh:shared-domain";
  const regionsMeshId = "model:mesh:regions";
  const regionLegend = membership?.region_legend ?? [];
  const regionOwnersById = new Map<string, Set<string>>();
  for (const entry of regionLegend) {
    const owners = regionOwnersById.get(entry.region_id) ?? new Set<string>();
    owners.add(canonicalVisualizationSceneObjectId(entry.object_id));
    regionOwnersById.set(entry.region_id, owners);
  }
  const regionNodes = regionLegend.map((entry) => {
    const objectId = canonicalVisualizationSceneObjectId(entry.object_id);
    const owners = regionOwnersById.get(entry.region_id);
    return {
      // Preserve the legacy region-only id while the region is unambiguous.
      // Once multiple ferromagnetic owners publish the same region id, include
      // the owner so Explorer keys and selection identities cannot collide.
      id:
        owners?.size === 1
          ? `model:mesh:region:${encodeURIComponent(entry.region_id)}`
          : `model:mesh:region:${encodeURIComponent(objectId)}:${encodeURIComponent(entry.region_id)}`,
      kind: "mesh.grid.region" as const,
      label: entry.region_id,
      parentId: regionsMeshId,
      objectId,
      regionId: entry.region_id,
      badge: `${entry.numeric_id}`,
      icon: "layers" as const,
      status: "ready" as const,
    };
  });
  const structuredGridDetails: ExplorerNode[] = [
    {
      id: "model:mesh:grid",
      kind: "mesh.grid.descriptor",
      label: "Structured Grid",
      parentId: domainMeshId,
      badge: `${grid.shape.join(" × ")} / ${cellCount} cells`,
      icon: "mesh",
      status,
    },
    {
      id: "model:mesh:magnetic-support",
      kind: "mesh.grid.magnetic-support",
      label: "Magnetic Support",
      parentId: domainMeshId,
      badge: `${grid.shape.join(" × ")} cells`,
      icon: "layers",
      status,
    },
    {
      id: "model:mesh:active-unassigned",
      kind: "mesh.grid.active-unassigned",
      label: "Active / Unassigned Cells",
      parentId: domainMeshId,
      badge: "FDM membership",
      icon: "layers",
      status: membership ? "ready" : "stale",
    },
    {
      id: "model:mesh:mask",
      kind: "mesh.grid.mask",
      label: "Cell Mask",
      parentId: domainMeshId,
      badge: membership ? membership.encoding : "pending",
      icon: "shield",
      status,
    },
    {
      id: "model:mesh:provenance",
      kind: "mesh.grid.provenance",
      label: "Grid Provenance",
      parentId: domainMeshId,
      badge: grid.gridFingerprint ?? presentation?.generationId ?? domainMeta?.generation_id ?? "pending",
      icon: "activity",
      status: "ready",
    },
  ];
  const multilayerDetails = fdmMultilayerLayoutNodes(
    domainMeshId,
    multilayerLayout,
    multilayerLayoutStatus,
  );
  return {
    id: "model:mesh",
    // Mesh is the shared product-level summary for both FEM and FDM.  The
    // structured representation is a detail of its domain-mesh child, not a
    // second product-level "FDM Grid" node.
    kind: "mesh.root",
    label: "Mesh",
    parentId: "model:session",
    badge: `FDM · ${grid.shape.join(" × ")} / ${cellCount} cells`,
    icon: "mesh",
    status,
    contextCommands: ["workspace.focus-selection"],
    children: [
      {
        id: domainMeshId,
        kind: "mesh.shared-domain",
        label: "Domain Mesh",
        parentId: "model:mesh",
        badge: `structured grid · ${grid.shape.join(" × ")} / ${cellCount} cells`,
        icon: "mesh",
        status,
        children: [...structuredGridDetails, ...multilayerDetails],
      },
      {
        id: "model:mesh:builds",
        kind: "mesh.builds",
        label: "Build Pipeline",
        parentId: "model:mesh",
        badge: grid.gridFingerprint ?? presentation?.generationId ?? domainMeta?.generation_id ?? "execution artifact",
        icon: "activity",
        selectable: false,
        status,
      },
      {
        id: "model:mesh:quality",
        kind: "mesh.quality",
        label: "Quality Gates",
        parentId: "model:mesh",
        badge: "structured-grid checks",
        icon: "gauge",
        selectable: false,
        status: "ready",
      },
      {
        id: "model:mesh:size-fields",
        kind: "mesh.size-fields",
        label: "Realized Size Fields",
        parentId: "model:mesh",
        badge: "uniform spacing",
        icon: "settings",
        selectable: false,
        status: "ready",
      },
      {
        id: regionsMeshId,
        kind: "mesh.regions",
        label: "Regions And Mesh Parts",
        parentId: "model:mesh",
        badge: `${regionNodes.length} regions / structured cells`,
        icon: "layers",
        selectable: false,
        status: regionNodes.length > 0 ? "ready" : "stale",
        children: regionNodes,
      },
    ],
  };
}

function fdmMultilayerLayoutNodes(
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
  const common = layout.common_transform_layout;
  const commonNode: ExplorerNode = {
    id: `${parentId}:common-convolution-grid`,
    kind: "mesh.grid.common",
    label: "Common Convolution Grid",
    parentId,
    badge: common ? `${common.shape.join(" × ")} · diagnostic` : "not published",
    icon: "mesh",
    status: common ? status : "degraded",
    selectable: true,
    visualizationTargetId: "fdm-domain",
    nativeGrid: common ? tuple3(common.shape) : undefined,
    nativeCellSize: common ? tuple3(common.cell_size) : undefined,
    nativeOrigin: common ? tuple3(common.origin) : undefined,
  };
  const layerNodes: ExplorerNode[] = layout.layers.map((layer): ExplorerNode => {
    const layerParentId = `${parentId}:native-layers:${encodeURIComponent(layer.layer_id)}`;
    return {
      id: layerParentId,
      kind: "mesh.grid.layer" as const,
      label: layer.magnet_name,
      parentId: `${parentId}:native-layers`,
      layerId: layer.layer_id,
      objectId: layer.object_id,
      badge: `${layer.native_grid.join(" × ")} · ${layer.transfer_kind}`,
      icon: "layers" as const,
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
      children: [
        {
          id: `${layerParentId}:native-grid`,
          kind: "mesh.grid.layer.native-grid" as const,
          label: "Native Grid",
          parentId: layerParentId,
          layerId: layer.layer_id,
          objectId: layer.object_id,
          badge: `${layer.native_grid.join(" × ")} · ${layer.native_grid_fingerprint ?? "no fingerprint"}`,
          icon: "mesh" as const,
          status,
          visualizationTargetId: "fdm-domain",
          nativeGrid: tuple3(layer.native_grid),
          nativeCellSize: tuple3(layer.native_cell_size),
          nativeOrigin: tuple3(layer.native_origin),
          gridFingerprint: layer.native_grid_fingerprint,
        },
        {
          id: `${layerParentId}:active-mask`,
          kind: "mesh.grid.layer.mask" as const,
          label: "Active Mask",
          parentId: layerParentId,
          layerId: layer.layer_id,
          objectId: layer.object_id,
          badge: layer.active_mask_present ? `${layer.active_cell_count} active` : "dense / implicit",
          icon: "shield" as const,
          status,
          visualizationTargetId: "fdm-domain",
          activeMaskPresent: layer.active_mask_present,
          activeCellCount: layer.active_cell_count,
          inactiveCellCount: layer.inactive_cell_count,
        },
        {
          id: `${layerParentId}:transfer`,
          kind: "mesh.grid.layer.transfer" as const,
          label: "Transfer",
          parentId: layerParentId,
          layerId: layer.layer_id,
          objectId: layer.object_id,
          badge: layer.transfer_kind,
          icon: "activity" as const,
          status,
          visualizationTargetId: "fdm-domain",
          transferKind: layer.transfer_kind,
        },
        {
          id: `${layerParentId}:provenance`,
          kind: "mesh.grid.layer.provenance" as const,
          label: "Provenance",
          parentId: layerParentId,
          layerId: layer.layer_id,
          objectId: layer.object_id,
          badge: layout.layout_fingerprint ?? "unfingerprinted",
          icon: "activity" as const,
          status,
          visualizationTargetId: "fdm-domain",
          gridFingerprint: layer.native_grid_fingerprint,
        },
      ],
    };
  });
  return [
    commonNode,
    {
      id: `${parentId}:native-layers`,
      kind: "mesh.grid.layers",
      label: "Native Layers",
      parentId,
      badge: `${layout.layers.length}`,
      icon: "layers",
      status,
      selectable: false,
      children: layerNodes,
    },
  ];
}

/**
 * FDM exposes the same product-level Airbox entry as FEM when the declared
 * universe contains cells outside the realized magnetic support.  The mesh
 * child remains a structured-grid selection; the shared child labels are
 * retained for navigation, while the FDM lane renders them as read-only
 * execution facts instead of FEM element-size/topology controls.
 */

export type ExplorerDomainLane = "fdm" | "fem" | "unresolved";

export function resolveExplorerDomainLane(
  snapshot: ModelTreeSnapshot | null,
): ExplorerDomainLane {
  if (isFdmDomain(snapshot?.domainPresentation) || snapshot?.domainDiscretization === "fdm") {
    return "fdm";
  }
  if (isFemDomain(snapshot?.domainPresentation) || snapshot?.domainDiscretization === "fem") {
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
