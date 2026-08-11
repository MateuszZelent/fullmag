import type {
  ExplorerNode,
  ExplorerNodeStatus,
  ModelTreeSnapshot,
} from "../explorerTypes";
import type { FdmMultilayerLayoutResource } from "@/kernel/api/apiTypes";
import type { FdmDomainPresentation } from "@/shared/domain/mesh/domainPresentation";
import { meshPipelineStatusIsActive } from "@/shared/domain/mesh/buildPipeline";
import { resolveFdmMultilayerAirboxTarget } from "@/shared/domain/mesh/fdmMultilayerAirboxTarget";

import {
  meshStatusBadge,
  visualizationDebugNode,
} from "./explorerNodeContract";
import {
  meshFreshnessState,
  meshFreshnessStatus,
  meshRootStatus,
} from "./meshExplorerNodes";

export function buildFdmAirboxNode(
  presentation: FdmDomainPresentation,
  presentationStatus: ModelTreeSnapshot["domainPresentationStatus"] = "idle",
  multilayerLayout: FdmMultilayerLayoutResource | null | undefined = null,
  multilayerLayoutStatus: ModelTreeSnapshot["fdmMultilayerLayoutStatus"] = "idle",
): ExplorerNode | null {
  if (!presentation.universeOutsideMagneticSupport) return null;
  const grid = presentation.fdmGrid;
  const meshStatus: ExplorerNodeStatus =
    presentation.resourceStatus === "error"
      ? "mesh-failed"
      : presentation.resourceStatus === "loading"
        ? "mesh-building"
      : presentation.resourceStatus === "stale" || presentation.resourceStatus === "incompatible"
          ? "mesh-stale"
        : presentation.resourceStatus === "authoring-grid" || presentation.resourceStatus === "missing"
          ? "mesh-stale"
          : presentationStatus === "error"
            ? "degraded"
            : "mesh-ready";
  const cellCount = grid.totalCells;
  const multilayerTarget = resolveFdmMultilayerAirboxTarget(multilayerLayout);
  const multilayerTargetStatus: ExplorerNodeStatus =
    multilayerLayoutStatus === "loading" || multilayerLayoutStatus === "stale"
      ? "stale"
      : multilayerLayoutStatus === "error"
        ? "degraded"
        : "ready";
  return {
    id: "model:airbox",
    kind: "airbox.root",
    label: "Airbox",
    parentId: "model:universe",
    badge: "FDM universe",
    icon: "shield",
    status: meshStatus,
    visualizationTargetId: "fdm-universe-outside-support",
    contextCommands: ["workspace.focus-selection"],
    children: [
      {
        id: "model:airbox:mesh",
        kind: "airbox.mesh",
        label: "Mesh",
        parentId: "model:airbox",
        badge: `${grid.shape.join(" × ")} / ${cellCount} cells`,
        icon: "mesh",
        status: meshStatus,
        visualizationTargetId: "fdm-universe-outside-support",
        contextCommands: ["workspace.focus-selection"],
        children: [
          {
            id: "model:airbox:mesh:parameters",
            kind: "airbox.mesh.parameters",
            label: "Parameters",
            parentId: "model:airbox:mesh",
            badge: "read-only",
            icon: "settings",
            status: meshStatus,
            visualizationTargetId: "fdm-universe-outside-support",
          },
          {
            id: "model:airbox:mesh:quality-gates",
            kind: "airbox.mesh.quality-gates",
            label: "Quality Gates",
            parentId: "model:airbox:mesh",
            badge: "read-only",
            icon: "gauge",
            status: meshStatus,
            visualizationTargetId: "fdm-universe-outside-support",
          },
          {
            id: "model:airbox:mesh:statistics",
            kind: "airbox.mesh.statistics",
            label: "Statistics",
            parentId: "model:airbox:mesh",
            badge: "structured grid",
            icon: "activity",
            status: meshStatus,
            visualizationTargetId: "fdm-universe-outside-support",
          },
          {
            id: "model:airbox:mesh:topology",
            kind: "airbox.mesh.topology",
            label: "Topology",
            parentId: "model:airbox:mesh",
            badge: "not applicable",
            icon: "mesh",
            status: "unsupported",
            visualizationTargetId: "fdm-universe-outside-support",
          },
          {
            id: "model:airbox:mesh:build",
            kind: "airbox.mesh.build",
            label: "Build & Provenance",
            parentId: "model:airbox:mesh",
            badge: "execution artifact",
            icon: "activity",
            status: meshStatus,
            visualizationTargetId: "fdm-universe-outside-support",
          },
        ],
      },
      {
        id: "model:airbox:visualization",
        // Keep the product kind aligned with FEM.  The target marker routes
        // this FDM selection to the structured-grid outside-support adapter.
        kind: "airbox.visualization",
        label: "Visualization",
        parentId: "model:airbox",
        badge: "display",
        icon: "sparkles",
        status: "ready",
        visualizationTargetId: "fdm-universe-outside-support",
        contextCommands: ["workspace.focus-selection"],
        children: [
          {
            ...visualizationDebugNode({
              kind: "airbox.visualization.debug",
              parentId: "model:airbox:visualization",
            }),
            visualizationTargetId: "fdm-universe-outside-support",
          },
        ],
      },
      ...(multilayerTarget ? [{
        id: "model:airbox:multilayer-target",
        kind: "airbox.multilayer.target" as const,
        label: "Multilayer H_demag target",
        parentId: "model:airbox",
        badge: `${multilayerTarget.cells.join(" × ")} · H_demag`,
        icon: "activity" as const,
        status: multilayerTargetStatus,
        visualizationTargetId: "airbox",
        nativeGrid: multilayerTarget.cells,
        nativeCellSize: multilayerTarget.cellSize,
        nativeOrigin: multilayerTarget.origin,
        gridFingerprint: multilayerTarget.carrierFingerprint,
        contextCommands: ["workspace.focus-selection"],
      }] : []),
    ],
  };
}


export function buildFemAirboxNode(
  snapshot: ModelTreeSnapshot | null,
  legacyAirboxObjectPresent: boolean,
): ExplorerNode | null {
  const applicable = Boolean(
    snapshot?.airbox?.authoredPolicy ||
      snapshot?.airbox?.realizedCarrier ||
      snapshot?.airbox?.resolvedTarget ||
      legacyAirboxObjectPresent,
  );
  if (!applicable) return null;

  const status: ExplorerNodeStatus = snapshot?.mesh?.lastError
    ? "mesh-failed"
    : meshPipelineStatusIsActive(snapshot?.mesh?.activeBuildStatus)
      ? "mesh-building"
      : snapshot?.airbox?.realizedCarrier
        ? meshFreshnessStatus(
            meshFreshnessState(snapshot?.mesh),
            meshRootStatus(snapshot?.mesh),
          )
        : "mesh-stale";
  const badge = snapshot?.airbox?.realizedCarrier
    ? "realized"
    : snapshot?.airbox?.authoredPolicy
      ? "authored"
      : snapshot?.airbox?.resolvedTarget
        ? "resolved"
        : "legacy carrier";

  return {
    id: "model:airbox",
    kind: "airbox.root",
    label: "Airbox",
    parentId: "model:universe",
    badge,
    icon: "shield",
    status,
    children: [
      {
        id: "model:airbox:mesh",
        kind: "airbox.mesh",
        label: "Mesh",
        parentId: "model:airbox",
        badge: "mesh policy",
        icon: "mesh",
        status,
        contextCommands: ["workspace.focus-selection"],
        children: [
          {
            id: "model:airbox:mesh:parameters",
            kind: "airbox.mesh.parameters",
            label: "Parameters",
            parentId: "model:airbox:mesh",
            icon: "settings",
            status,
          },
          {
            id: "model:airbox:mesh:quality-gates",
            kind: "airbox.mesh.quality-gates",
            label: "Quality Gates",
            parentId: "model:airbox:mesh",
            icon: "gauge",
            status,
          },
          {
            id: "model:airbox:mesh:statistics",
            kind: "airbox.mesh.statistics",
            label: "Statistics",
            parentId: "model:airbox:mesh",
            icon: "activity",
            status,
          },
          {
            id: "model:airbox:mesh:topology",
            kind: "airbox.mesh.topology",
            label: "Topology",
            parentId: "model:airbox:mesh",
            icon: "mesh",
            status,
          },
          {
            id: "model:airbox:mesh:build",
            kind: "airbox.mesh.build",
            label: "Build & Provenance",
            parentId: "model:airbox:mesh",
            icon: "activity",
            status,
          },
        ],
      },
      {
        id: "model:airbox:visualization",
        kind: "airbox.visualization",
        label: "Visualization",
        parentId: "model:airbox",
        badge: "display",
        icon: "sparkles",
        status,
        contextCommands: ["workspace.focus-selection"],
        children: [
          visualizationDebugNode({
            kind: "airbox.visualization.debug",
            parentId: "model:airbox:visualization",
          }),
        ],
      },
    ],
  };
}

export function buildBoundaryFacesNode(
  snapshot: ModelTreeSnapshot | null,
): ExplorerNode {
  const status: ExplorerNodeStatus =
    (snapshot?.mesh?.outerBoundaryPartCount ?? 0) > 0
      ? meshFreshnessStatus(
          meshFreshnessState(snapshot?.mesh),
          meshRootStatus(snapshot?.mesh),
        )
      : "unavailable";

  return {
    id: "model:boundary-faces",
    kind: "boundary-faces.root",
    label: "Boundary Faces",
    parentId: "model:universe",
    badge:
      status === "mesh-ready"
        ? "realized"
        : status === "unavailable"
          ? "mesh required"
          : meshStatusBadge(status),
    icon: "mesh",
    status,
  };
}

