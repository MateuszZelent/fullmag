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
import { legacyStatusFacets } from "./explorerNodeState";
import {
  meshFreshnessState,
  meshFreshnessStatus,
  meshRootStatus,
} from "./meshExplorerNodes";

// Presentation controls remain reachable before any solver publishes a mesh.
export function buildAirboxPresentationNode(): ExplorerNode {
  return {
    id: "model:airbox",
    kind: "airbox.root",
    label: "Airbox",
    parentId: "model:universe",
    badge: "no mesh",
    icon: "shield",
    status: "unavailable",
    visualizationTargetId: "airbox",
    children: [{
      id: "model:airbox:visualization",
      kind: "airbox.visualization",
      label: "Visualization",
      parentId: "model:airbox",
      badge: "display",
      icon: "sparkles",
      status: "ready",
      visualizationTargetId: "airbox",
      contextCommands: ["workspace.focus-selection"],
      children: [{
        ...visualizationDebugNode({
          kind: "airbox.visualization.debug",
          parentId: "model:airbox:visualization",
        }),
        visualizationTargetId: "airbox",
      }],
    }],
  };
}

export function buildFdmAirboxNode(
  presentation: FdmDomainPresentation,
  presentationStatus: ModelTreeSnapshot["domainPresentationStatus"] = "idle",
  multilayerLayout: FdmMultilayerLayoutResource | null | undefined = null,
  multilayerLayoutStatus: ModelTreeSnapshot["fdmMultilayerLayoutStatus"] = "idle",
): ExplorerNode | null {
  const multilayerTarget = resolveFdmMultilayerAirboxTarget(multilayerLayout);
  // A multilayer run publishes a verified target-only Airbox carrier even
  // while the ordinary structured-grid support presentation is still stale
  // or unavailable. Keep that carrier reachable in Explorer; otherwise the
  // viewport/debug inspector cannot qualify the published H_demag field.
  if (!presentation.universeOutsideMagneticSupport && !multilayerTarget) return null;
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
  const fdmStatusReason =
    presentation.resourceStatus === "error"
      ? "FDM Airbox descriptor or membership resource failed to load."
      : presentation.resourceStatus === "loading"
        ? "FDM Airbox descriptor or membership is still loading."
        : presentation.resourceStatus === "stale" || presentation.resourceStatus === "incompatible"
          ? "FDM Airbox membership does not match the current grid identity."
          : presentation.resourceStatus === "authoring-grid" || presentation.resourceStatus === "missing"
            ? "FDM descriptor is authored, but runtime membership is not materialized."
            : undefined;
  const fdmStateFacets = legacyStatusFacets(meshStatus);
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
    statusReason: fdmStatusReason,
    ...fdmStateFacets,
    visualizationTargetId: "airbox",
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
        statusReason: fdmStatusReason,
        ...fdmStateFacets,
        visualizationTargetId: "airbox",
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
            statusReason: fdmStatusReason,
            ...fdmStateFacets,
            visualizationTargetId: "airbox",
          },
          {
            id: "model:airbox:mesh:quality-gates",
            kind: "airbox.mesh.quality-gates",
            label: "Quality Gates",
            parentId: "model:airbox:mesh",
            badge: "read-only",
            icon: "gauge",
            status: meshStatus,
            statusReason: fdmStatusReason,
            ...fdmStateFacets,
            visualizationTargetId: "airbox",
          },
          {
            id: "model:airbox:mesh:statistics",
            kind: "airbox.mesh.statistics",
            label: "Statistics",
            parentId: "model:airbox:mesh",
            badge: "structured grid",
            icon: "activity",
            status: meshStatus,
            statusReason: fdmStatusReason,
            ...fdmStateFacets,
            visualizationTargetId: "airbox",
          },
          {
            id: "model:airbox:mesh:topology",
            kind: "airbox.mesh.topology",
            label: "Topology",
            parentId: "model:airbox:mesh",
            badge: "not applicable",
            icon: "mesh",
            status: "unsupported",
            statusReason: "Explicit FEM element topology is not applicable to the structured FDM grid.",
            ...legacyStatusFacets("unsupported"),
            visualizationTargetId: "airbox",
          },
          {
            id: "model:airbox:mesh:build",
            kind: "airbox.mesh.build",
            label: "Build & Provenance",
            parentId: "model:airbox:mesh",
            badge: "execution artifact",
            icon: "activity",
            status: meshStatus,
            statusReason: fdmStatusReason,
            ...fdmStateFacets,
            visualizationTargetId: "airbox",
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
        status: "ready",
        ...legacyStatusFacets("ready"),
        visualizationTargetId: "airbox",
        contextCommands: ["workspace.focus-selection"],
        children: [
          {
            ...visualizationDebugNode({
              kind: "airbox.visualization.debug",
              parentId: "model:airbox:visualization",
            }),
            ...legacyStatusFacets("ready"),
            visualizationTargetId: "airbox",
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
        ...legacyStatusFacets(multilayerTargetStatus),
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
  const statusReason = status === "mesh-ready"
    ? "Published FEM Airbox artifact is current with its source scene."
    : status === "mesh-building"
      ? "Shared-domain FEM mesh build is in progress."
      : status === "mesh-failed"
        ? snapshot?.mesh?.lastError ?? "Shared-domain FEM mesh build failed."
        : snapshot?.mesh?.manifestSourceSceneRevision == null
          ? "Published FEM mesh has no source-scene provenance; freshness is unknown."
          : "Published FEM Airbox artifact is stale for the current source scene.";
  const femStateFacets = legacyStatusFacets(status);
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
    statusReason,
    ...femStateFacets,
    children: [
      {
        id: "model:airbox:mesh",
        kind: "airbox.mesh",
        label: "Mesh",
        parentId: "model:airbox",
        badge: "mesh policy",
        icon: "mesh",
        status,
        statusReason,
        ...femStateFacets,
        contextCommands: ["workspace.focus-selection"],
        children: [
          {
            id: "model:airbox:mesh:parameters",
            kind: "airbox.mesh.parameters",
            label: "Parameters",
            parentId: "model:airbox:mesh",
            icon: "settings",
            status,
            statusReason,
            ...femStateFacets,
          },
          {
            id: "model:airbox:mesh:quality-gates",
            kind: "airbox.mesh.quality-gates",
            label: "Quality Gates",
            parentId: "model:airbox:mesh",
            icon: "gauge",
            status,
            statusReason,
            ...femStateFacets,
          },
          {
            id: "model:airbox:mesh:statistics",
            kind: "airbox.mesh.statistics",
            label: "Statistics",
            parentId: "model:airbox:mesh",
            icon: "activity",
            status,
            statusReason,
            ...femStateFacets,
          },
          {
            id: "model:airbox:mesh:topology",
            kind: "airbox.mesh.topology",
            label: "Topology",
            parentId: "model:airbox:mesh",
            icon: "mesh",
            status,
            statusReason,
            ...femStateFacets,
          },
          {
            id: "model:airbox:mesh:build",
            kind: "airbox.mesh.build",
            label: "Build & Provenance",
            parentId: "model:airbox:mesh",
            icon: "activity",
            status,
            statusReason,
            ...femStateFacets,
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
        statusReason,
        ...femStateFacets,
        contextCommands: ["workspace.focus-selection"],
        children: [
          {
            ...visualizationDebugNode({
              kind: "airbox.visualization.debug",
              parentId: "model:airbox:visualization",
            }),
            status,
            statusReason,
            ...femStateFacets,
          },
        ],
      },
    ],
  };
}

export function buildBoundaryFacesNode(
  snapshot: ModelTreeSnapshot | null,
): ExplorerNode {
  const evidenceStatus = snapshot?.mesh?.outerBoundaryEvidenceStatus ?? "unknown";
  const carrierCount = snapshot?.mesh?.outerBoundaryPartCount;
  const currentCarrierInventoryVerified =
    evidenceStatus === "verified" && typeof carrierCount === "number";
  const hasCurrentCarrier = evidenceStatus === "verified" &&
    typeof carrierCount === "number" && carrierCount > 0;
  const verifiedNoCarrier = currentCarrierInventoryVerified && carrierCount === 0;
  const status: ExplorerNodeStatus = hasCurrentCarrier
    ? meshFreshnessStatus(
        meshFreshnessState(snapshot?.mesh),
        meshRootStatus(snapshot?.mesh),
      )
    : verifiedNoCarrier
      ? "unavailable"
      : evidenceStatus === "loading"
        ? "mesh-building"
        : evidenceStatus === "stale"
          ? "mesh-stale"
          : evidenceStatus === "error"
            ? "mesh-failed"
            : "unavailable";
  const statusReason = verifiedNoCarrier
    ? "The current published FEM manifest has no Universe outer-boundary carrier."
    : evidenceStatus === "loading"
      ? "The mesh manifest or current scene is loading; boundary-carrier availability is not known yet."
      : evidenceStatus === "stale"
        ? "The boundary manifest does not match the current mesh revision or source scene."
        : evidenceStatus === "error"
          ? "The mesh manifest or current scene failed to load; boundary-carrier availability is unknown."
          : evidenceStatus === "unknown"
            ? "The current mesh topology identity is incomplete or non-FEM, so boundary-carrier availability cannot be verified."
            : undefined;

  return {
    id: "model:boundary-faces",
    kind: "boundary-faces.root",
    label: "Boundary Faces",
    parentId: "model:universe",
    badge:
      hasCurrentCarrier && status === "mesh-ready"
        ? "realized"
        : verifiedNoCarrier
          ? "no carrier"
          : evidenceStatus === "unknown"
            ? "identity unknown"
            : meshStatusBadge(status),
    icon: "mesh",
    status,
    statusReason,
  };
}
