import type {
  ExplorerNode,
  ExplorerNodeStatus,
  ModelTreeObjectSnapshot,
  ModelTreePhysicsInteractionSnapshot,
} from "../explorerTypes";
import type { CurrentTransportListResource } from "@/kernel/api/apiTypes";

import { buildPhysicsGraphObjectNode } from "./physicsGraphTree";
import {
  compactExplorerNodes,
  meshStatusBadge,
  type ModelTreeResources,
  visualizationDebugNode,
} from "./explorerNodeContract";

export function buildObjectExplorerNode(
  object: ModelTreeObjectSnapshot,
  resources: ModelTreeResources = {},
  physicsGraph?: unknown | null,
): ExplorerNode {
  const objectId = object.id;
  const parentId = `model:object:${objectId}`;
  const meshStatus = object.meshStatus ?? "primitive-only";
  if (object.objectRole === "antenna") {
    return {
      id: parentId,
      kind: "object.root",
      label: object.label,
      parentId: "model:objects",
      badge: object.geometryKind ?? "antenna",
      icon: "wave",
      objectId,
      status: "ready",
      contextCommands: [
        "geometry.focus-primitive",
        "geometry.delete-object",
        "workspace.focus-selection",
        "explorer.expand-all",
        "explorer.collapse-all",
      ],
      children: [
        {
          id: `${parentId}:geometry`,
          kind: "object.geometry",
          label: "Geometry",
          parentId,
          badge: object.geometryKind ?? "unresolved",
          icon: "braces",
          objectId,
          status: "ready",
          contextCommands: ["workspace.focus-selection"],
        },
        {
          id: `${parentId}:antenna`,
          kind: "object.antenna",
          label: "Antenna",
          parentId,
          badge: "Zeeman mask",
          icon: "wave",
          objectId,
          status: "ready",
          contextCommands: ["workspace.focus-selection"],
        },
        {
          id: `${parentId}:visualization`,
          kind: "object.visualization",
          label: "Visualization",
          parentId,
          badge: "display",
          icon: "sparkles",
          objectId,
          status: "ready",
          contextCommands: ["workspace.focus-selection"],
          children: compactExplorerNodes([
            modeVisualizationNode(`${parentId}:visualization`, object, resources),
            visualizationDebugNode({
              kind: "object.visualization.debug",
              objectId,
              parentId: `${parentId}:visualization`,
            }),
          ]),
        },
        ...physicsGraphObjectChildren(object, physicsGraph, resources.currentTransports),
      ],
    };
  }

  return {
    id: parentId,
    kind: "object.root",
    label: object.label,
    parentId: "model:objects",
    badge: object.geometryKind ?? "object",
    icon: "box",
    objectId,
    status: meshStatus,
    contextCommands: [
      "geometry.focus-primitive",
      "geometry.delete-object",
      "mesh.build-selected",
      "workspace.focus-selection",
      "explorer.expand-all",
      "explorer.collapse-all",
    ],
    children: [
      {
        id: `${parentId}:geometry`,
        kind: "object.geometry",
        label: "Geometry",
        parentId,
        badge: object.geometryKind ?? "unresolved",
        icon: "braces",
        objectId,
        status: "ready",
        contextCommands: ["workspace.focus-selection"],
      },
      regionsNode(parentId, object),
      magneticParametersNode(parentId, object),
      {
        id: `${parentId}:magnetic-texture`,
        kind: "object.magnetic-texture",
        label: "Magnetic Texture",
        parentId,
        badge:
          object.magnetizationKind ??
          object.magnetizationLabel ??
          object.magnetization ??
          "unassigned",
        icon: "wave",
        objectId,
        status: object.magnetization ? "ready" : "degraded",
        contextCommands: ["magnetization-texture.activate-load-file"],
        children: magneticTextureChildren(parentId, object),
      },
      {
        id: `${parentId}:mesh`,
        kind: "object.mesh",
        label: "Mesh",
        parentId,
        badge: meshStatusBadge(meshStatus),
        icon: "mesh",
        objectId,
        status: meshStatus,
        contextCommands: ["mesh.build-selected", "mesh.open-object-report"],
      },
      {
        id: `${parentId}:visualization`,
        kind: "object.visualization",
        label: "Visualization",
        parentId,
        badge: "display",
        icon: "sparkles",
        objectId,
        status: "ready",
        contextCommands: ["workspace.focus-selection"],
        children: compactExplorerNodes([
          modeVisualizationNode(`${parentId}:visualization`, object, resources),
          visualizationDebugNode({
            kind: "object.visualization.debug",
            objectId,
            parentId: `${parentId}:visualization`,
          }),
        ]),
      },
      ...objectExtensionNodes(parentId, object),
      ...physicsGraphObjectChildren(object, physicsGraph, resources.currentTransports),
    ],
  };
}

function physicsGraphObjectChildren(
  object: ModelTreeObjectSnapshot,
  physicsGraph: unknown | null | undefined,
  currentTransports: CurrentTransportListResource | null | undefined,
): ExplorerNode[] {
  const node = buildPhysicsGraphObjectNode(physicsGraph, {
    id: object.id,
    label: object.label,
  }, currentTransports);
  return node ? [node] : [];
}

function modeVisualizationNode(
  parentId: string,
  object: ModelTreeObjectSnapshot,
  resources: ModelTreeResources,
): ExplorerNode | null {
  const activeOverlay = resources.activeAnalysisFieldOverlay ?? null;
  if (!activeOverlay) return null;
  const nodeId = `${parentId}:mode-visualization`;
  const provenance = activeOverlay.provenance;
  return {
    id: nodeId,
    kind: "object.mode_visualization",
    label: "Active Analysis Overlay",
    parentId,
    badge: activeOverlay.source === "eigen-mode" ? "Modal" : "Driven",
    analysisFieldSource: activeOverlay.source,
    ...(activeOverlay.query.view ? { analysisFieldView: activeOverlay.query.view } : {}),
    ...(provenance?.runId ? { analysisRunId: provenance.runId } : {}),
    ...(provenance?.stageId ? { analysisStageId: provenance.stageId } : {}),
    ...(provenance?.artifactRevision !== undefined
      ? { artifactRevision: provenance.artifactRevision }
      : {}),
    ...(provenance?.equilibriumId ? { equilibriumId: provenance.equilibriumId } : {}),
    fieldId: activeOverlay.fieldId,
    ...(activeOverlay.frequencyIndex !== undefined
      ? { frequencyIndex: activeOverlay.frequencyIndex }
      : {}),
    ...(provenance?.kContextKind
      ? { kContextKind: provenance.kContextKind }
      : {}),
    modeVisualizationRootFieldId: activeOverlay.fieldId,
    modeVisualizationRootSource: activeOverlay.source,
    icon: "wave",
    ...(activeOverlay.modeIndex !== undefined
      ? { modeIndex: activeOverlay.modeIndex }
      : {}),
    objectId: object.id,
    ...(provenance?.resourceRef ? { resourceRef: provenance.resourceRef } : {}),
    ...(activeOverlay.sampleIndex !== undefined
      ? { sampleIndex: activeOverlay.sampleIndex }
      : {}),
    status: "ready",
    ...(provenance?.studyProduct ? { studyProduct: provenance.studyProduct } : {}),
  };
}

function objectExtensionNodes(
  parentId: string,
  object: ModelTreeObjectSnapshot,
): ExplorerNode[] {
  return (object.extensions ?? []).map((extension) => ({
    id: `${parentId}:extensions:${extension.id}`,
    kind: "object.extension.topological-charge",
    label: extension.label,
    parentId,
    badge: "extension",
    icon: "activity",
    objectId: object.id,
    extensionId: extension.id,
    status: extension.status ?? "ready",
    contextCommands: ["workspace.focus-selection"],
  }));
}

function regionsNode(
  parentId: string,
  object: ModelTreeObjectSnapshot,
): ExplorerNode {
  const regions = object.regions ?? [];
  return {
    id: `${parentId}:regions`,
    kind: "object.regions",
    label: "Regions",
    parentId,
    badge: `${regions.length}`,
    icon: "layers",
    objectId: object.id,
    status: "ready",
    contextCommands: ["workspace.focus-selection", "mesh.open-regions"],
    children: regions.map((region) =>
      authoredRegionNode(`${parentId}:regions`, object, region),
    ),
  };
}

function authoredRegionNode(
  parentId: string,
  object: ModelTreeObjectSnapshot,
  region: NonNullable<ModelTreeObjectSnapshot["regions"]>[number],
): ExplorerNode {
  const nodeId = `${parentId}:${region.id}`;
  const status = region.enabled ? "ready" : "degraded";
  return {
    id: nodeId,
    kind: "object.region",
    label: region.label,
    parentId,
    badge: region.realizationStatus ?? region.source,
    icon: "circle",
    objectId: object.id,
    regionId: region.id,
    status,
    contextCommands: [
      "regions.focus",
      "regions.duplicate",
      "regions.delete",
      "regions.priority-up",
      "regions.priority-down",
      "mesh.open-region-report",
      "mesh.open-regions",
    ],
    children: [
      {
        id: `${nodeId}:geometry`,
        kind: "object.region.geometry",
        label: "Geometry",
        parentId: nodeId,
        badge: region.shapeKind ?? "selector",
        icon: "braces",
        objectId: object.id,
        regionId: region.id,
        status,
      },
      {
        id: `${nodeId}:magnetic-parameters`,
        kind: "object.region.magnetic-parameters",
        label: "Magnetic Parameters",
        parentId: nodeId,
        badge: regionMaterialBadge(region),
        icon: "magnet",
        objectId: object.id,
        regionId: region.id,
        status:
          region.materialOverrideCount > 0 || region.materialFieldCount > 0
            ? "ready"
            : "degraded",
        children: regionMaterialFieldNodes(nodeId, object, region),
      },
      {
        id: `${nodeId}:mesh`,
        kind: "object.region.mesh",
        label: "Mesh",
        parentId: nodeId,
        badge: region.meshLifecycleStatus ??
          (region.meshPolicyActive ? "configured" : "inherits object"),
        icon: "mesh",
        objectId: object.id,
        regionId: region.id,
        status: explorerStatusFromRegionMeshLifecycle(region),
        contextCommands: ["mesh.open-region-report", "mesh.open-regions"],
      },
      {
        id: `${nodeId}:texture`,
        kind: "object.region.texture",
        label: "Texture",
        parentId: nodeId,
        badge: region.textureOverrideActive ? "override" : "inherits object",
        icon: "wave",
        objectId: object.id,
        regionId: region.id,
        status: region.textureOverrideActive ? "ready" : "degraded",
      },
      {
        id: `${nodeId}:visualization`,
        kind: "object.region.visualization",
        label: "Visualization",
        parentId: nodeId,
        badge: "display",
        icon: "sparkles",
        objectId: object.id,
        regionId: region.id,
        status,
        children: [
          visualizationDebugNode({
            kind: "object.region.visualization.debug",
            objectId: object.id,
            parentId: `${nodeId}:visualization`,
            regionId: region.id,
          }),
        ],
      },
      {
        id: `${nodeId}:regions`,
        kind: "object.region.regions",
        label: "Regions",
        parentId: nodeId,
        badge: "inherits none",
        icon: "layers",
        objectId: object.id,
        regionId: region.id,
        status: "degraded",
      },
      {
        id: `${nodeId}:diagnostics`,
        kind: "object.region.diagnostics",
        label: "Diagnostics",
        parentId: nodeId,
        badge: region.realizationPolicy ?? region.realizationStatus ?? "authored",
        icon: "gauge",
        objectId: object.id,
        regionId: region.id,
        status: region.realizationStatus ? "warning" : "ready",
      },
    ],
  };
}

function explorerStatusFromRegionMeshLifecycle(
  region: NonNullable<ModelTreeObjectSnapshot["regions"]>[number],
): ExplorerNodeStatus {
  switch (region.meshLifecycleStatus) {
    case "current":
      return "mesh-ready";
    case "pending":
      return "mesh-building";
    case "failed":
      return "mesh-failed";
    case "stale":
    case "draft":
      return "mesh-stale";
    case "unsupported":
      return "validation-blocked";
    case "configured":
    default:
      return region.meshPolicyActive ? "stale" : "degraded";
  }
}

function regionMaterialBadge(
  region: NonNullable<ModelTreeObjectSnapshot["regions"]>[number],
): string {
  const parts: string[] = [];
  if (region.materialOverrideCount > 0) {
    parts.push(`${region.materialOverrideCount} override`);
  }
  if (region.materialFieldCount > 0) {
    parts.push(`${region.materialFieldCount} field`);
  }
  return parts.length > 0 ? parts.join(" / ") : "inherits object";
}

function regionMaterialFieldNodes(
  parentId: string,
  object: ModelTreeObjectSnapshot,
  region: NonNullable<ModelTreeObjectSnapshot["regions"]>[number],
): ExplorerNode[] {
  return (object.materialFields ?? []).flatMap((field) =>
    field.regionId === region.id
      ? [{
      id: `${parentId}:magnetic-parameters:${field.id}`,
      kind: "object.region.magnetic-parameters" as const,
      label: field.label,
      parentId: `${parentId}:magnetic-parameters`,
      badge: field.realizationStatus ?? "field",
      icon: "settings" as const,
      objectId: object.id,
      regionId: region.id,
      status: "ready" as const,
      }]
      : [],
  );
}

function magneticParametersNode(
  parentId: string,
  object: ModelTreeObjectSnapshot,
): ExplorerNode {
  const materialLabel = object.materialLabel ?? object.material ?? "unassigned";
  const interactions = object.physicsInteractions ?? [];
  const optionalInteractionCount = interactions.filter(
    (interaction) => interaction.id !== "exchange" && interaction.id !== "demag",
  ).length;

  return {
    id: `${parentId}:magnetic-parameters`,
    kind: "object.magnetic-parameters",
    label: "Magnetic Parameters",
    parentId,
    badge: optionalInteractionCount > 0 ? `+${optionalInteractionCount}` : "core",
    icon: "magnet",
    objectId: object.id,
    status: object.material ? "ready" : "degraded",
    children: [
      {
        id: `${parentId}:magnetic-parameters:material`,
        kind: "object.material",
        label: `Material: ${materialLabel}`,
        parentId: `${parentId}:magnetic-parameters`,
        badge: materialParametersBadge(object.materialPropertyKeys ?? []),
        icon: "magnet",
        objectId: object.id,
        status: object.material ? "ready" : "degraded",
      },
      ...interactions.map((interaction) => ({
        id: `${parentId}:magnetic-parameters:${interaction.id}`,
        kind: "object.physics" as const,
        label: interaction.label,
        parentId: `${parentId}:magnetic-parameters`,
        badge: physicsInteractionBadge(interaction),
        icon: "activity" as const,
        objectId: object.id,
        status: interaction.enabledCount > 0 ? "ready" as const : "degraded" as const,
      })),
    ],
  };
}

function materialParametersBadge(keys: readonly string[]): string {
  if (keys.length === 0) return "parameters";
  return keys.slice(0, 3).join(", ");
}

function magneticTextureChildren(
  parentId: string,
  object: ModelTreeObjectSnapshot,
): ExplorerNode[] {
  const textureParent = `${parentId}:magnetic-texture`;
  const children: ExplorerNode[] = [
    {
      id: `${textureParent}:asset`,
      kind: "object.magnetic-texture.asset",
      label: object.magnetizationLabel ?? object.magnetization ?? "No texture assigned",
      parentId: textureParent,
      badge: object.magnetization ?? "unassigned",
      icon: "wave",
      objectId: object.id,
      status: object.magnetization ? "ready" : "degraded",
    },
  ];

  if (object.textureLoadEnabled) {
    children.push({
      id: `${textureParent}:load`,
      kind: "object.magnetic-texture.load",
      label: "Load texture",
      parentId: textureParent,
      badge: "h5/zarr",
      icon: "file",
      objectId: object.id,
      status: "ready",
      contextCommands: ["study.load-field-state"],
    });
  }

  if (object.textureTransformAvailable) {
    children.push({
      id: `${textureParent}:transform`,
      kind: "object.magnetic-texture.transform",
      label: "Texture Transform",
      parentId: textureParent,
      badge: "m0",
      icon: "braces",
      objectId: object.id,
      status: "ready",
    });
  }

  return children;
}


function physicsInteractionBadge(
  interaction: ModelTreePhysicsInteractionSnapshot,
): string {
  if (interaction.objectCount === 0) return "default";
  if (interaction.enabledCount === interaction.objectCount) return "active";
  if (interaction.enabledCount === 0) return "disabled";
  return `${interaction.enabledCount}/${interaction.objectCount} active`;
}
