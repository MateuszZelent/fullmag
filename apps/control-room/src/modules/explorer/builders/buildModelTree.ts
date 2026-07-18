import type {
  ExplorerNode,
  ExplorerNodeStatus,
  ExplorerTabId,
  ModelTreeObjectSnapshot,
  ModelTreePhysicsInteractionSnapshot,
  ModelTreeCouplingSnapshot,
  ModelTreeFieldDriveSnapshot,
  ModelTreeSnapshot,
} from "../explorerTypes";

import { buildCrossSectionNodes } from "./crossSectionExplorerNodes";
import {
  buildFrequencyDomainDiagnosticsNode,
  buildFrequencyDomainJobsNode,
  buildPeriodicPairsResourceNode,
  buildFrequencyDomainResourceNodes,
  buildFrequencyDomainResultNode,
  type ExplorerTreeResources,
} from "./frequencyDomainExplorerNodes";
import { buildStudyNodes } from "./study/studyExplorerNodes";

import type { AnalysisFieldOverlayState } from "@/kernel/visualization/AnalysisFieldOverlayController";
import type { PlanarMonitorCollectionResource } from "@/kernel/api/apiTypes";
import type { PlanarMonitorDraft } from "@/kernel/workspace/crossSectionWorkspace";
import { isVisualizationAirboxIdentity } from "@/kernel/selection/selectionTypes";
import { meshPipelineStatusIsActive } from "@/shared/domain/mesh/buildPipeline";
import {
  buildEigenSpectrumChartModel,
  buildFrequencyResponseChartModel,
  frequencyDomainManifestPayload,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import {
  resolveMeshBuildFreshness,
  type MeshFreshnessState,
} from "@/shared/domain/mesh/meshBuildFreshness";

function formatLength(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e-3) return `${(value * 1e3).toFixed(1)} mm`;
  if (abs >= 1e-6) return `${(value * 1e6).toFixed(1)} um`;
  return `${(value * 1e9).toFixed(1)} nm`;
}

function formatSize(size: readonly [number, number, number] | null | undefined): string {
  if (!size) return "domain";
  return size.map(formatLength).join(" x ");
}

type ModelTreeResources = ExplorerTreeResources & {
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null;
  planarMonitorDraft?: PlanarMonitorDraft | null;
  planarMonitors?: PlanarMonitorCollectionResource | null;
};

export function buildPlanarMonitorNodes(
  resource: PlanarMonitorCollectionResource | null | undefined,
  draft: PlanarMonitorDraft | null | undefined = null,
): ExplorerNode {
  const monitors: ExplorerNode[] = (resource?.monitors ?? [])
    .map((monitor) => {
      const id = monitor.id;
      return {
        badge: monitor.operator.kind,
        contextCommands: [
          "field-map.select-monitor",
          "planar-monitor.show-frame-3d",
          "planar-monitor.duplicate",
          "planar-monitor.rename",
          "planar-monitor.delete",
          "field-map.export-data",
        ],
        contextCommandInputs: {
          "field-map.export-data": { monitorId: id },
          "field-map.select-monitor": { monitorId: id },
          "planar-monitor.delete": { monitorId: id },
          "planar-monitor.duplicate": { monitorId: id },
          "planar-monitor.rename": { monitorId: id },
          "planar-monitor.show-frame-3d": { monitorId: id },
        },
        icon: "layers" as const,
        id: `model:definitions:planar-monitors:${id}`,
        kind: "model.planar.monitor" as const,
        label: monitor.name,
        monitorId: id,
        parentId: "model:definitions:planar-monitors",
        status: "ready" as const,
      };
    });
  if (draft) {
    monitors.unshift({
      badge: `${draft.plane.toUpperCase()} ${draft.positionPercent}%`,
      contextCommands: ["workspace.focus-selection"],
      icon: "layers",
      id: "model:definitions:planar-monitors:draft",
      kind: "model.planar.monitor.draft",
      label: draft.name,
      parentId: "model:definitions:planar-monitors",
      status: "queued",
    });
  }
  return {
    badge: `${monitors.length}`,
    children: monitors,
    icon: "layers",
    id: "model:definitions:planar-monitors",
    kind: "model.planar.monitors",
    label: "Planar Monitors",
    parentId: "model:definitions",
    status: "ready",
  };
}

const MODE_VISUALIZATION_VIEWS = [
  "phase_rotated_real",
  "real",
  "imag",
  "abs",
  "phase",
] as const;

interface ModeVisualizationFieldNode {
  badge: string;
  fieldId: string;
  frequencyIndex?: number;
  frequencyHz?: number;
  id: string;
  label: string;
  modeIndex?: number;
  sampleIndex?: number;
  source: "eigen-mode" | "frequency-response";
}

function objectNodes(
  object: ModelTreeObjectSnapshot,
  resources: ModelTreeResources = {},
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
    ],
  };
}

function compactExplorerNodes(
  nodes: Array<ExplorerNode | null | undefined>,
): ExplorerNode[] {
  return nodes.filter((node): node is ExplorerNode => Boolean(node));
}

export function visualizationDebugNode({
  kind,
  parentId,
  objectId,
  regionId,
}: {
  kind:
    | "airbox.visualization.debug"
    | "object.visualization.debug"
    | "object.region.visualization.debug";
  parentId: string;
  objectId?: string;
  regionId?: string;
}): ExplorerNode {
  return {
    id: `${parentId}:debug`,
    kind,
    label: "Debug",
    parentId,
    badge: "debug",
    icon: "gauge",
    ...(objectId ? { objectId } : {}),
    ...(regionId ? { regionId } : {}),
    status: "ready",
  };
}

function modeVisualizationNode(
  parentId: string,
  object: ModelTreeObjectSnapshot,
  resources: ModelTreeResources,
): ExplorerNode | null {
  const activeOverlay = resources.activeAnalysisFieldOverlay ?? null;
  if (!activeOverlay) return null;

  const fields = modeVisualizationFields(resources);
  if (fields.length === 0) return null;

  const nodeId = `${parentId}:mode-visualization`;
  const primaryField =
    fields.find(
      (field) =>
        field.fieldId === activeOverlay.fieldId &&
        field.source === activeOverlay.source,
    ) ?? fields[0];
  return {
    id: nodeId,
    kind: "object.mode_visualization",
    label: "Mode visualization",
    parentId,
    badge: `${fields.length} field(s)`,
    analysisFieldSource: primaryField.source,
    ...(activeOverlay.query.view ? { analysisFieldView: activeOverlay.query.view } : {}),
    fieldId: primaryField.fieldId,
    icon: "wave",
    objectId: object.id,
    status: "ready",
    children: modeVisualizationGroupNodes(nodeId, object.id, fields, activeOverlay),
  };
}

function modeVisualizationGroupNodes(
  parentId: string,
  objectId: string,
  fields: readonly ModeVisualizationFieldNode[],
  activeOverlay: AnalysisFieldOverlayState,
): ExplorerNode[] {
  const eigenFields = fields.filter((field) => field.source === "eigen-mode");
  const responseFields = fields.filter(
    (field) => field.source === "frequency-response",
  );
  return compactExplorerNodes([
    modeVisualizationGroupNode({
      activeOverlay,
      fields: responseFields,
      id: `${parentId}:response`,
      label: "Driven response",
      objectId,
      parentId,
    }),
    modeVisualizationGroupNode({
      activeOverlay,
      fields: eigenFields,
      id: `${parentId}:eigen`,
      label: "Eigenmodes",
      objectId,
      parentId,
    }),
  ]);
}

function modeVisualizationGroupNode({
  activeOverlay,
  fields,
  id,
  label,
  objectId,
  parentId,
}: {
  activeOverlay: AnalysisFieldOverlayState;
  fields: readonly ModeVisualizationFieldNode[];
  id: string;
  label: string;
  objectId: string;
  parentId: string;
}): ExplorerNode | null {
  if (fields.length === 0) return null;
  const firstField = fields[0];
  return {
    id,
    kind: "object.mode_visualization.group",
    label,
    parentId,
    badge: `${fields.length}`,
    analysisFieldSource: firstField.source,
    fieldId: firstField.fieldId,
    icon: "folder",
    objectId,
    status: "ready",
    children: fields.map((field) =>
      modeVisualizationFieldNode(id, objectId, field, activeOverlay),
    ),
  };
}

function modeVisualizationFieldNode(
  parentId: string,
  objectId: string,
  field: ModeVisualizationFieldNode,
  activeOverlay: AnalysisFieldOverlayState,
): ExplorerNode {
  const active = activeOverlay.fieldId === field.fieldId &&
    activeOverlay.source === field.source;
  const id = `${parentId}:${field.id}`;
  return {
    id,
    kind: "object.mode_visualization.field",
    label: field.label,
    parentId,
    activeAnalysisField: active,
    badge: field.badge,
    analysisFieldSource: field.source,
    fieldId: field.fieldId,
    ...(field.frequencyIndex !== undefined
      ? { frequencyIndex: field.frequencyIndex }
      : {}),
    icon: "wave",
    ...(field.modeIndex !== undefined ? { modeIndex: field.modeIndex } : {}),
    objectId,
    ...(field.sampleIndex !== undefined ? { sampleIndex: field.sampleIndex } : {}),
    status: "ready",
    children: MODE_VISUALIZATION_VIEWS.map((view) =>
      modeVisualizationViewNode(id, objectId, field, view, activeOverlay),
    ),
  };
}

function modeVisualizationViewNode(
  parentId: string,
  objectId: string,
  field: ModeVisualizationFieldNode,
  view: string,
  activeOverlay: AnalysisFieldOverlayState,
): ExplorerNode {
  const active =
    activeOverlay.fieldId === field.fieldId &&
    activeOverlay.source === field.source &&
    (activeOverlay.query.view ?? "phase_rotated_real") === view;
  return {
    id: `${parentId}:view:${view}`,
    kind: "object.mode_visualization.view",
    label: modeVisualizationViewLabel(view),
    parentId,
    activeAnalysisField: active,
    analysisFieldSource: field.source,
    analysisFieldView: view,
    fieldId: field.fieldId,
    ...(field.frequencyIndex !== undefined
      ? { frequencyIndex: field.frequencyIndex }
      : {}),
    icon: "wave",
    ...(field.modeIndex !== undefined ? { modeIndex: field.modeIndex } : {}),
    objectId,
    ...(field.sampleIndex !== undefined ? { sampleIndex: field.sampleIndex } : {}),
    status: "ready",
  };
}

function modeVisualizationFields(
  resources: ModelTreeResources,
): ModeVisualizationFieldNode[] {
  return [
    ...modeVisualizationResponseFields(resources),
    ...modeVisualizationEigenFields(resources),
  ];
}

function modeVisualizationResponseFields(
  resources: ModelTreeResources,
): ModeVisualizationFieldNode[] {
  const manifestPayload = frequencyDomainManifestPayload(
    resources.frequencyDomainManifest,
  );
  const responseModel = buildFrequencyResponseChartModel(
    resources.frequencyDomainResponseSweep,
    manifestPayload,
  );
  const fields = new Map<string, ModeVisualizationFieldNode>();
  for (const point of responseModel.points) {
    if (!point.fieldId || point.frequencyIndex == null) continue;
    if (fields.has(point.fieldId)) continue;
    fields.set(point.fieldId, {
      badge: formatFrequencyHz(point.frequencyHz),
      fieldId: point.fieldId,
      frequencyHz: point.frequencyHz,
      frequencyIndex: point.frequencyIndex,
      id: `frequency:${point.frequencyIndex}`,
      label: formatFrequencyHz(point.frequencyHz),
      source: "frequency-response",
    });
  }
  return [...fields.values()];
}

function modeVisualizationEigenFields(
  resources: ModelTreeResources,
): ModeVisualizationFieldNode[] {
  return buildEigenSpectrumChartModel(resources.frequencyDomainSpectrum)
    .points.filter((point) => point.modeFieldId != null)
    .map((point) => ({
      badge: formatFrequencyHz(point.frequencyHz),
      fieldId: point.modeFieldId as string,
      frequencyHz: point.frequencyHz,
      id: `sample:${point.sampleIndex}:mode:${point.rawModeIndex}`,
      label: `Sample ${point.sampleIndex} Mode ${point.rawModeIndex}`,
      modeIndex: point.rawModeIndex,
      sampleIndex: point.sampleIndex,
      source: "eigen-mode" as const,
    }));
}

function modeVisualizationViewLabel(view: string): string {
  if (view === "real") return "Real";
  if (view === "imag") return "Imag";
  if (view === "abs") return "Complex (abs)";
  if (view === "phase") return "Phase";
  return "Phase-rotated real";
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

function meshStatusBadge(status: ExplorerNodeStatus): string {
  if (status === "primitive-only") return "primitive";
  if (status === "mesh-stale") return "mesh stale";
  if (status === "mesh-building") return "building";
  if (status === "mesh-ready") return "mesh ready";
  if (status === "mesh-failed") return "failed";
  if (status === "validation-blocked") return "blocked";
  if (status === "stale") return "out of date";
  return "default";
}

function meshRootStatus(mesh: ModelTreeSnapshot["mesh"]): ExplorerNodeStatus {
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

function meshFreshnessState(mesh: ModelTreeSnapshot["mesh"]): MeshFreshnessState {
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

function meshFreshnessStatus(
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

function meshPolicyNodes(mesh: ModelTreeSnapshot["mesh"]): ExplorerNode {
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
        label: "Shared-Domain Solver Mesh",
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

function couplingNodes(couplings: readonly ModelTreeCouplingSnapshot[]): ExplorerNode | null {
  if (couplings.length === 0) return null;
  return {
    id: "model:physics:couplings",
    kind: "physics.couplings",
    label: "Couplings",
    parentId: "model:session",
    badge: `${couplings.length}`,
    icon: "activity",
    status: "ready",
    contextCommands: ["workspace.focus-selection"],
    children: couplings.map((coupling) => ({
      id: `model:physics:couplings:${coupling.id}`,
      kind: "physics.coupling" as const,
      label: coupling.label,
      parentId: "model:physics:couplings",
      badge: coupling.realizationStatus ?? coupling.kind,
      icon: "activity" as const,
      couplingId: coupling.id,
      status: couplingStatus(coupling),
      contextCommands: [
        "workspace.focus-selection",
        "couplings.disable",
        "couplings.delete",
      ],
    })),
  };
}

function fieldDriveNodes(drives: readonly ModelTreeFieldDriveSnapshot[]): ExplorerNode | null {
  if (drives.length === 0) return null;
  return {
    id: "model:physics:field-drives",
    kind: "physics.field-drives",
    label: "Field drives",
    parentId: "model:session",
    badge: `${drives.length}`,
    icon: "wave",
    status: "ready",
    contextCommands: ["workspace.focus-selection"],
    children: drives.map((drive) => ({
      id: `model:physics:field-drives:${drive.id}`,
      kind: "physics.field-drive" as const,
      label: drive.label,
      parentId: "model:physics:field-drives",
      badge: `${drive.targetKind} · ${drive.waveformKind}`,
      icon: "wave" as const,
      fieldDriveId: drive.id,
      status: drive.enabled ? "ready" as const : "degraded" as const,
      contextCommands: ["workspace.focus-selection"],
    })),
  };
}

function couplingStatus(coupling: ModelTreeCouplingSnapshot): ExplorerNodeStatus {
  if (!coupling.enabled) return "degraded";
  if (coupling.realizationStatus?.includes("requires")) return "unsupported";
  if (coupling.realizationStatus?.includes("pending")) return "warning";
  return "ready";
}

function physicsInteractionBadge(
  interaction: ModelTreePhysicsInteractionSnapshot,
): string {
  if (interaction.objectCount === 0) return "default";
  if (interaction.enabledCount === interaction.objectCount) return "active";
  if (interaction.enabledCount === 0) return "disabled";
  return `${interaction.enabledCount}/${interaction.objectCount} active`;
}

export function buildModelTree(
  snapshot: ModelTreeSnapshot | null = null,
  resources: ModelTreeResources = {},
): ExplorerNode[] {
  const universe = snapshot?.universe ?? {
    id: "universe",
    label: "Universe",
    size: [2e-6, 1e-6, 5e-8] as const,
  };
  const objects = (snapshot?.objects ?? []).filter(
    (object) => !isVisualizationAirboxIdentity({ id: object.id, role: object.objectRole }),
  );
  const boundaryFacesStatus: ExplorerNodeStatus =
    (snapshot?.mesh?.outerBoundaryPartCount ?? 0) > 0
      ? meshFreshnessStatus(
          meshFreshnessState(snapshot?.mesh),
          meshRootStatus(snapshot?.mesh),
        )
      : "unavailable";
  const sessionChildren: ExplorerNode[] = [
    {
      badge: "authoring",
      children: [
        buildPlanarMonitorNodes(
          resources.planarMonitors,
          resources.planarMonitorDraft,
        ),
      ],
      icon: "braces",
      id: "model:definitions",
      kind: "definitions.root",
      label: "Definitions",
      parentId: "model:session",
      status: "ready",
    },
    {
      id: "model:universe",
      kind: "universe.root",
      label: universe.label,
      parentId: "model:session",
      badge: formatSize(universe.size),
      icon: "shield",
      status: "ready",
      children: [
        {
          id: "model:airbox",
          kind: "airbox.root",
          label: "Airbox",
          parentId: "model:universe",
          badge: "domain",
          icon: "shield",
          status: "ready",
          children: [
            {
              id: "model:airbox:mesh",
              kind: "airbox.mesh",
              label: "Mesh",
              parentId: "model:airbox",
              badge: "mesh policy",
              icon: "mesh",
              status: "ready",
              contextCommands: ["workspace.focus-selection"],
              children: [
                {
                  id: "model:airbox:mesh:parameters",
                  kind: "airbox.mesh.parameters",
                  label: "Parameters",
                  parentId: "model:airbox:mesh",
                  icon: "settings",
                  status: "ready",
                },
                {
                  id: "model:airbox:mesh:quality-gates",
                  kind: "airbox.mesh.quality-gates",
                  label: "Quality Gates",
                  parentId: "model:airbox:mesh",
                  icon: "gauge",
                  status: "ready",
                },
                {
                  id: "model:airbox:mesh:statistics",
                  kind: "airbox.mesh.statistics",
                  label: "Statistics",
                  parentId: "model:airbox:mesh",
                  icon: "activity",
                  status: "ready",
                },
                {
                  id: "model:airbox:mesh:topology",
                  kind: "airbox.mesh.topology",
                  label: "Topology",
                  parentId: "model:airbox:mesh",
                  icon: "mesh",
                  status: "ready",
                },
                {
                  id: "model:airbox:mesh:build",
                  kind: "airbox.mesh.build",
                  label: "Build & Provenance",
                  parentId: "model:airbox:mesh",
                  icon: "activity",
                  status: "ready",
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
              contextCommands: ["workspace.focus-selection"],
              children: [
                visualizationDebugNode({
                  kind: "airbox.visualization.debug",
                  parentId: "model:airbox:visualization",
                }),
              ],
            },
          ],
        },
        {
          id: "model:boundary-faces",
          kind: "boundary-faces.root",
          label: "Boundary Faces",
          parentId: "model:universe",
          badge:
            boundaryFacesStatus === "mesh-ready"
              ? "realized"
              : boundaryFacesStatus === "unavailable"
                ? "mesh required"
                : meshStatusBadge(boundaryFacesStatus),
          icon: "mesh",
          status: boundaryFacesStatus,
        },
      ],
    },
    {
      id: "model:objects",
      kind: "objects.root",
      label: "Objects",
      parentId: "model:session",
      badge: `${objects.length}`,
      icon: "layers",
      status: "ready",
      children: objects.map((object) => objectNodes(object, resources)),
    },
  ];

  const crossSectionBranch = buildCrossSectionNodes(
    snapshot?.crossSections ?? null,
  );
  if (crossSectionBranch) {
    sessionChildren.push(crossSectionBranch);
  }

  const couplingBranch = couplingNodes(snapshot?.couplings ?? []);
  if (couplingBranch) {
    sessionChildren.push(couplingBranch);
  }
  const fieldDriveBranch = fieldDriveNodes(snapshot?.fieldDrives ?? []);
  if (fieldDriveBranch) {
    sessionChildren.push(fieldDriveBranch);
  }

  sessionChildren.push(
    meshPolicyNodes(snapshot?.mesh ?? null),
    buildStudyNodes(snapshot?.study ?? null),
  );

  return [
    {
      id: "model:session",
      kind: "session.root",
      label: "Session Model",
      parentId: null,
      badge: "ProblemIR",
      icon: "folder",
      status: "ready",
      contextCommands: ["explorer.expand-all", "explorer.collapse-all"],
      children: sessionChildren,
    },
  ];
}

function branch(id: string, label: string, kind: ExplorerNode["kind"], status: ExplorerNodeStatus = "ready"): ExplorerNode {
  return {
    id,
    kind,
    label,
    parentId: null,
    icon: "folder",
    status,
    contextCommands: ["explorer.expand-all", "explorer.collapse-all"],
  };
}

export function buildExplorerTree(
  tabId: ExplorerTabId,
  resources: ExplorerTreeResources = {},
): ExplorerNode[] {
  if (tabId === "model") return buildModelTree(null, resources);
  if (tabId === "resources") {
    return [
      {
        ...branch("resources:root", "Session Resources", "resources.root"),
        children: [
          ...buildFrequencyDomainResourceNodes(
            resources.frequencyDomainManifest,
            resources.activeAnalysisFieldOverlay,
          ),
          {
            id: "resources:fields",
            kind: "resources.field",
            label: "Published fields",
            parentId: "resources:root",
            badge: "m, H_demag",
            icon: "wave",
            status: "ready",
          },
          {
            id: "resources:mesh",
            kind: "resources.mesh",
            label: "Mesh topology",
            parentId: "resources:root",
            badge: "revision 0",
            icon: "mesh",
            status: "stale",
            children: [buildPeriodicPairsResourceNode()],
          },
        ],
      },
    ];
  }
  if (tabId === "results") {
    return [
      {
        ...branch("results:root", "Results", "results.root"),
        children: [
          buildFrequencyDomainResultNode(
            resources.frequencyDomainManifest,
            resources.frequencyDomainBranches,
            resources.frequencyDomainDispersion,
            resources.frequencyDomainResponseSweep,
            resources.frequencyDomainSpectrum,
            resources.activeAnalysisFieldOverlay,
          ),
          {
            id: "results:field:m",
            kind: "results.field_quantity",
            label: "Magnetization",
            parentId: "results:root",
            badge: "A/m",
            icon: "wave",
            status: "ready",
          },
        ],
      },
    ];
  }
  if (tabId === "jobs") {
    return [
      {
        ...branch("jobs:root", "Jobs", "jobs.root"),
        children: [
          buildFrequencyDomainJobsNode(resources),
          {
            id: "jobs:command-queue",
            kind: "jobs.command",
            label: "Command queue",
            parentId: "jobs:root",
            badge: "idle",
            icon: "activity",
            status: "ready",
          },
        ],
      },
    ];
  }

  return [
    {
      ...branch("diagnostics:root", "Diagnostics", "diagnostics.root"),
      children: [
        buildFrequencyDomainDiagnosticsNode(resources.frequencyDomainManifest),
        {
          id: "diagnostics:resources",
          kind: "diagnostics.resource",
          label: "Resource cache",
          parentId: "diagnostics:root",
          badge: "revision-driven",
          icon: "database",
          status: "ready",
        },
      ],
    },
  ];
}

export function flattenExplorerNodes(nodes: readonly ExplorerNode[]): ExplorerNode[] {
  return nodes.flatMap((node) => [
    node,
    ...flattenExplorerNodes(node.children ?? []),
  ]);
}

export function collectExplorerNodeIds(nodes: readonly ExplorerNode[]): string[] {
  return flattenExplorerNodes(nodes).map((node) => node.id);
}

export function findExplorerNodePath(
  nodes: readonly ExplorerNode[],
  nodeId: string,
): string[] | null {
  for (const node of nodes) {
    if (node.id === nodeId) return [node.id];
    const childPath = findExplorerNodePath(node.children ?? [], nodeId);
    if (childPath) return [node.id, ...childPath];
  }
  return null;
}

export function filterExplorerNodes(
  nodes: readonly ExplorerNode[],
  query: string,
  pinnedNodeId?: string | null,
): ExplorerNode[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...nodes];

  return nodes.flatMap((node): ExplorerNode[] => {
    const childMatches = filterExplorerNodes(
      node.children ?? [],
      normalizedQuery,
      pinnedNodeId,
    );
    const selfMatches =
      node.label.toLowerCase().includes(normalizedQuery) ||
      node.kind.toLowerCase().includes(normalizedQuery) ||
      node.badge?.toLowerCase().includes(normalizedQuery);
    const pinned = node.id === pinnedNodeId;

    if (!selfMatches && !pinned && childMatches.length === 0) return [];
    return [{ ...node, children: childMatches.length ? childMatches : node.children }];
  });
}
