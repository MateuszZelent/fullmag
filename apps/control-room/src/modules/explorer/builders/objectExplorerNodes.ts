import { isTransportConductorRole } from "@/shared/domain/physics/objectMagneticModel";
import { formatValueWithUnit } from "@/shared/domain/physics/displayUnits";
import { antennaRegionalSources } from "@/shared/domain/physics/antennaRegionalSource";
import type {
  ExplorerNode,
  ExplorerNodeStatus,
  ModelTreeObjectSnapshot,
  ModelTreePhysicsInteractionSnapshot,
} from "../explorerTypes";
import type { CurrentTransportListResource, SceneResource } from "@/kernel/api/apiTypes";
import type {
  FrozenSpinsDefinition,
  FrozenSpinsSelectionExpression,
} from "@/kernel/api/apiTypes";
import { antennaPortValidationMessages } from "@/shared/domain/physics/antennaPortValidation";
import { antennaStageValidationMessages } from "@/shared/domain/physics/antennaStageValidation";

import { buildGeometryTreeExplorerNodes } from "./geometryTreeExplorerNodes";
import { buildPhysicsGraphObjectNode } from "./physicsGraphTree";
import {
  compactExplorerNodes,
  meshStatusBadge,
  type ModelTreeResources,
  visualizationDebugNode,
} from "./explorerNodeContract";

type AntennaTargetResource = NonNullable<
  SceneResource["antenna_target_projections"]
>[number]["target"];

function planarMonitorObjectCreationInput(
  resources: ModelTreeResources,
  objectId: string,
) {
  const capability = resources.planarMonitorTargetCapabilities?.objects[objectId] ?? {
    enabled: false,
    reason: "Current-session planar monitor target capability is unavailable.",
  };
  return {
    capability,
    intent: {
      source: "explorer" as const,
      target: { kind: "object" as const, object_id: objectId },
    },
  };
}

function planarMonitorRegionCreationInput(
  resources: ModelTreeResources,
  objectId: string,
  regionId: string,
) {
  const key = `${objectId}\u0000${regionId}`;
  const capability = resources.planarMonitorTargetCapabilities?.regions[key] ?? {
    enabled: false,
    reason: "Current-session planar monitor target capability is unavailable.",
  };
  return {
    capability,
    intent: {
      source: "explorer" as const,
      target: { kind: "region" as const, object_id: objectId, region_id: regionId },
    },
  };
}

export function buildObjectExplorerNode(
  object: ModelTreeObjectSnapshot,
  resources: ModelTreeResources = {},
  physicsGraph?: unknown | null,
): ExplorerNode {
  const objectId = object.id;
  const parentId = `model:object:${objectId}`;
  const meshStatus = object.meshStatus ?? "primitive-only";
  const createObjectMonitorInput = planarMonitorObjectCreationInput(resources, objectId);
  if (object.objectRole === "antenna") {
    const regional = antennaRegionalSources(resources.scene ?? null, objectId);
    return {
      id: parentId,
      kind: "object.root",
      label: object.label,
      parentId: "model:objects",
      badge: object.geometryKind ?? "antenna",
      icon: "wave",
      objectId,
      objectRole: object.objectRole,
      status: "ready",
      contextCommands: [
        "planar-monitor.create",
        "geometry.focus-primitive",
        "geometry.delete-object",
        "workspace.focus-selection",
        "explorer.expand-all",
        "explorer.collapse-all",
      ],
      contextCommandInputs: { "planar-monitor.create": createObjectMonitorInput },
      children: [
        {
          id: `${parentId}:geometry`,
          kind: "object.antenna.geometry",
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
          badge: "composition",
          icon: "wave",
          objectId,
          selectable: true,
          status: "ready",
          contextCommands: ["workspace.focus-selection"],
          children: [
            {
              id: `${parentId}:antenna:regional`,
              kind: "object.antenna.regional",
              label: "Regional field drive",
              parentId: `${parentId}:antenna`,
              badge: regional.canonical ? regional.canonical.enabled === false ? "disabled" : "configured"
                : regional.legacy ? "migration required" : "not configured",
              statusReason: regional.canonical ? "Explicit prescribed regional magnetic field; it does not solve conductor current or the antenna Oersted field. Configuration is not proof of execution."
                : regional.legacy ? "Deprecated prescribed Zeeman-mask source; migrate it explicitly in the regional field inspector."
                : "No regional field source is assigned to this object. Assign an explicit geometry-mask RegionalFieldDrive before editing its waveform; the conductor solve is separate.",
              icon: "wave",
              objectId,
              objectRole: "antenna",
              status: regional.canonical ? regional.canonical.enabled === false ? "degraded" : "ready" : regional.legacy ? "warning" : "unavailable",
              contextCommands: ["workspace.focus-selection"],
            },
            ...antennaCompositionNodes(parentId, objectId, resources),
          ],
        },
        {
          id: `${parentId}:mesh`,
          kind: "object.mesh",
          label: "Mesh",
          parentId,
          badge: meshStatusBadge(meshStatus),
          icon: "mesh",
          objectId,
          objectRole: object.objectRole,
          status: meshStatus,
          statusReason: "Object mesh policy and build evidence. A saved policy does not certify a current antenna field-solve mesh.",
          contextCommands: ["mesh.build-selected", "mesh.open-object-report"],
        },
        {
          id: `${parentId}:visualization`,
          kind: "object.antenna.visualization",
          label: "Visualization",
          parentId,
          badge: "display",
          icon: "sparkles",
          objectId,
          objectRole: "antenna",
          status: "ready",
          contextCommands: ["workspace.focus-selection"],
          children: [
            visualizationDebugNode({
              kind: "object.visualization.debug",
              objectId,
              parentId: `${parentId}:visualization`,
            }),
          ],
        },
        ...physicsGraphObjectChildren(object, physicsGraph, resources.currentTransports),
      ],
    };
  }

  const magnetic = object.objectRole === undefined || object.objectRole === "magnet";
  const conductor = isTransportConductorRole(object.objectRole);
  const badge = conductor
    ? (object.objectRole === "electrode" ? "Electrode" : "Conductor")
    : object.geometryKind ?? "object";
  const geometryTreeChildren = buildGeometryTreeExplorerNodes(
    objectId,
    `${parentId}:geometry`,
    object.geometry,
  );

  return {
    id: parentId,
    kind: "object.root",
    label: object.label,
    parentId: "model:objects",
    badge,
    icon: conductor ? "activity" : "box",
    objectId,
    objectRole: object.objectRole,
    status: meshStatus,
    contextCommands: [
      "planar-monitor.create",
      "geometry.focus-primitive",
      "geometry.duplicate-objects",
      "geometry.split-by-plane",
      "geometry.delete-object",
      "mesh.build-selected",
      "workspace.focus-selection",
      "explorer.expand-all",
      "explorer.collapse-all",
    ],
    contextCommandInputs: { "planar-monitor.create": createObjectMonitorInput },
    children: compactExplorerNodes([
      {
        id: `${parentId}:geometry`,
        kind: "object.geometry",
        label: "Geometry",
        parentId,
        badge:
          geometryTreeChildren.length > 0
            ? `${object.geometryKind ?? "CSG"} (${geometryTreeChildren.length})`
            : object.geometryKind ?? "unresolved",
        icon: "braces",
        objectId,
        status: "ready",
        contextCommands: ["workspace.focus-selection"],
        ...(geometryTreeChildren.length > 0
          ? { children: geometryTreeChildren }
          : {}),
      },
      regionsNode(parentId, object, resources, magnetic),
      ...(magnetic
        ? [
            ...frozenSpinsNodes(parentId, object.id, null, resources),
            objectMaterialNode(parentId, object),
            object.hasAbsorbingBoundary
              ? {
                  id: `${parentId}:absorbing-boundary`,
                  kind: "object.absorbing-boundary" as const,
                  label: "Absorbing Boundary",
                  parentId,
                  icon: "wave" as const,
                  objectId,
                  status: "ready" as const,
                }
              : null,
            {
              id: `${parentId}:magnetic-texture`,
              kind: "object.magnetic-texture" as const,
              label: "Magnetic Texture",
              parentId,
              badge:
                object.magnetizationKind ??
                object.magnetizationLabel ??
                object.magnetization ??
                "unassigned",
              icon: "compass" as const,
              objectId,
              status: object.magnetization ? ("ready" as const) : ("degraded" as const),
              contextCommands: ["magnetization-texture.activate-load-file"],
            } satisfies ExplorerNode,
          ]
        : []),
      unifiedObjectPhysicsNode(parentId, object, physicsGraph, resources.currentTransports),
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
          magnetic ? modeVisualizationNode(`${parentId}:visualization`, object, resources) : null,
          visualizationDebugNode({
            kind: "object.visualization.debug",
            objectId,
            parentId: `${parentId}:visualization`,
          }),
        ]),
      },
      ...(magnetic ? objectExtensionNodes(parentId, object) : []),
    ]),
  };
}

function antennaCompositionNodes(
  parentId: string,
  objectId: string,
  resources: ModelTreeResources,
): ExplorerNode[] {
  const scene = resources.scene;
  const portModes = (scene?.antenna_port_modes ?? []).filter(
    (mode) => mode.source_object_id === objectId,
  );
  const solveStages = (scene?.antenna_field_solve_stages ?? []).filter(
    (stage) => stage.source_object_id === objectId,
  );
  const solveStageIds = new Set(solveStages.map((stage) => stage.id));
  const projections = (scene?.antenna_target_projections ?? []).filter(
    (projection) => solveStageIds.has(projection.solution.stage_id),
  );
  const projectionIds = new Set(projections.map((projection) => projection.id));
  const drives = (scene?.solved_antenna_drives ?? []).filter((drive) =>
    projectionIds.has(drive.projection_ref),
  );
  const spectra = (scene?.antenna_spectrum_requests ?? []).filter((request) =>
    solveStageIds.has(request.solution_ref.stage_id),
  );
  const antennaParentId = `${parentId}:antenna`;

  return [
    {
      id: `${antennaParentId}:terminals`,
      kind: "object.antenna.terminals",
      label: "Terminals and source",
      parentId: antennaParentId,
      badge: "source definition",
      icon: "activity",
      objectId,
      objectRole: "antenna",
      antennaResourceId: objectId,
      antennaResourceKind: "terminals",
      status: "warning",
      contextCommands: ["workspace.focus-selection"],
    },
    {
      id: `${antennaParentId}:conductor`,
      kind: "object.antenna.conductor",
      label: "Conductor",
      parentId: antennaParentId,
      badge: "3D conductor",
      icon: "box",
      objectId,
      objectRole: "antenna",
      antennaResourceId: objectId,
      antennaResourceKind: "conductor",
      status: "ready",
      contextCommands: ["workspace.focus-selection"],
    },
    ...portModes.map((mode, index) => {
      const validationMessages = antennaPortValidationMessages(mode, scene ?? null);
      const status = validationMessages.length === 0 ? "ready" as const : "warning" as const;
      return {
        id: `${antennaParentId}:port:${encodeURIComponent(mode.id)}`,
        kind: "object.antenna.port" as const,
        label: `Port ${index + 1}`,
        parentId: antennaParentId,
        badge: `${mode.branches.length} branches · ${validationMessages.length ? `${validationMessages.length} issues` : "configured"}`,
        statusReason: `Port ID: ${mode.id}. Transport ID: ${mode.current_transport_id}. ` + (validationMessages.length ? validationMessages.join("; ")
          : "Port inputs are configured. Current balance and field-source qualification still require execution."),
        icon: "activity" as const,
        objectId,
        objectRole: "antenna" as const,
        antennaResourceId: mode.id,
        antennaResourceKind: "port" as const,
        status,
        contextCommands: ["workspace.focus-selection"],
      };
    }),
    ...solveStages.map((stage, index) => {
      const validationMessages = antennaStageValidationMessages(stage, scene ?? null);
      const invalid = validationMessages.length > 0;
      return {
        id: `${antennaParentId}:solution:${encodeURIComponent(stage.id)}`,
        kind: "object.antenna.solution" as const,
        label: `Field solve ${index + 1}`,
        parentId: antennaParentId,
        badge: `${stage.outputs.length} outputs · ${invalid ? `${validationMessages.length} issues` : "configured"}`,
        statusReason: `Definition ID: ${stage.id}. Source object ID: ${stage.source_object_id}. Sampling: ${targetDescription(stage.field_sampling_domain, scene)}. ` + (invalid ? validationMessages.join("; ")
          : "Field-solve inputs are configured. This node does not establish that a result has been computed."),
        icon: "mesh" as const,
        objectId,
        objectRole: "antenna" as const,
        antennaResourceId: stage.id,
        antennaResourceKind: "solution" as const,
        status: invalid ? "validation-blocked" as const : "warning" as const,
        contextCommands: ["study.add-antenna-field-solve-stage", "workspace.focus-selection"],
        contextCommandInputs: {
          "study.add-antenna-field-solve-stage": { objectId, stageId: stage.id },
        },
      };
    }),
    ...projections.map((projection, index) => ({
      id: `${antennaParentId}:projection:${encodeURIComponent(projection.id)}`,
      kind: "object.antenna.projection" as const,
      label: `Projection ${index + 1} → ${targetDescription(projection.target, scene)}`,
      parentId: antennaParentId,
      badge: "authored binding",
      statusReason: `Projection ID: ${projection.id}. Source stage ID: ${projection.solution.stage_id}. Source output ID: ${projection.solution.output_id}. Target: ${projection.target.kind === "global" ? "global" : `${projection.target.object_id}${projection.target.kind === "region" ? ` / ${projection.target.region_id}` : ""}`}. Authored binding only; result publication and field qualification are not established by this node.`,
      icon: "triangle" as const,
      objectId,
      objectRole: "antenna" as const,
      antennaResourceId: projection.id,
      antennaResourceKind: "projection" as const,
      status: "warning" as const,
      contextCommands: ["workspace.focus-selection"],
    })),
    ...drives.map((drive) => ({
      id: `${antennaParentId}:drive:${encodeURIComponent(drive.id)}`,
      kind: "object.antenna.drive" as const,
      label: drive.name.trim() || "Unnamed current drive",
      parentId: antennaParentId,
      badge: `${formatValueWithUnit(drive.peak_current_a, "A")} · ${drive.waveform.kind === "piecewise_linear" ? "piecewise" : drive.waveform.kind === "sinc_pulse" ? "sinc" : drive.waveform.kind}`,
      statusReason: `Drive ID: ${drive.id}. Projection ID: ${drive.projection_ref}. Port ID: ${drive.port_mode_id}. Time origin: ${drive.time_origin}. Configured current scale and waveform; this node does not establish a published field or an executed Run.`,
      icon: "wave" as const,
      objectId,
      objectRole: "antenna" as const,
      antennaResourceId: drive.id,
      antennaResourceKind: "drive" as const,
      status: "warning" as const,
      contextCommands: ["workspace.focus-selection"],
    })),
    ...spectra.map((request, index) => ({
      id: `${antennaParentId}:spectrum:${encodeURIComponent(request.id)}`,
      kind: "object.antenna.spectrum" as const,
      label: `Source spectrum ${index + 1}`,
      parentId: antennaParentId,
      badge: `${request.component === "vector_power" ? "vector magnitude²" : request.component} · ${request.window}`,
      statusReason: `Spectrum request ID: ${request.id}. Source stage ID: ${request.solution_ref.stage_id}. Source output ID: ${request.solution_ref.output_id}. Transform: ${request.transform}. Spatial spectrum of the antenna source field. This is not a measured magnetization response or evidence of an excited mode.`,
      icon: "activity" as const,
      objectId,
      objectRole: "antenna" as const,
      antennaResourceId: request.id,
      antennaResourceKind: "spectrum" as const,
      status: "warning" as const,
      contextCommands: ["workspace.focus-selection"],
    })),
  ];
}

function targetDescription(target: AntennaTargetResource | null | undefined, scene: SceneResource | null | undefined): string {
  if (!target) return "Unspecified";
  if (target.kind === "global") return "Global";
  const matches = scene?.objects?.filter(object => object.id === target.object_id) ?? [];
  if (matches.length !== 1) return `${matches.length ? "Ambiguous" : "Missing"} object · ${target.object_id}${target.kind === "region" ? ` / ${target.region_id}` : ""}`;
  const object = matches[0], name = object.name?.trim();
  const duplicateName = name && (scene?.objects?.filter(item => item.name?.trim() === name).length ?? 0) > 1;
  const objectLabel = name ? duplicateName ? `${name} [${object.id}]` : name : `Object · ${object.id}`;
  if (target.kind === "object") return objectLabel;
  const regions = object.regions?.filter(region => region.region_id === target.region_id && (!region.owner_object || region.owner_object === object.id)) ?? [];
  if (regions.length !== 1) return `${objectLabel} / ${regions.length ? "Ambiguous" : "Missing"} region · ${target.region_id}`;
  const region = regions[0], regionName = region.name?.trim();
  const duplicateRegionName = regionName && (object.regions?.filter(item => item.name?.trim() === regionName).length ?? 0) > 1;
  return `${objectLabel} / ${regionName ? duplicateRegionName ? `${regionName} [${region.region_id}]` : regionName : target.region_id}`;
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
    ...(provenance?.representation
      ? { analysisFieldRepresentation: provenance.representation }
      : {}),
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
    ...(activeOverlay.frequencyHz !== undefined
      ? { frequencyHz: activeOverlay.frequencyHz }
      : {}),
    ...(provenance?.kContextKind
      ? { kContextKind: provenance.kContextKind }
      : {}),
    ...(activeOverlay.kPathCoordinateRadPerM !== undefined
      ? { kPathCoordinateRadPerM: activeOverlay.kPathCoordinateRadPerM }
      : {}),
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
    ...(activeOverlay.wavevectorKf ? { wavevectorKf: activeOverlay.wavevectorKf } : {}),
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
  resources: ModelTreeResources,
  magnetic: boolean,
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
      authoredRegionNode(`${parentId}:regions`, object, region, resources, magnetic),
    ),
  };
}

function authoredRegionNode(
  parentId: string,
  object: ModelTreeObjectSnapshot,
  region: NonNullable<ModelTreeObjectSnapshot["regions"]>[number],
  resources: ModelTreeResources,
  magnetic: boolean,
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
    objectRole: object.objectRole,
    regionId: region.id,
    status,
    contextCommands: [
      "planar-monitor.create",
      "regions.focus",
      "regions.duplicate",
      "regions.delete",
      "regions.priority-up",
      "regions.priority-down",
      "mesh.open-region-report",
      "mesh.open-regions",
    ],
    contextCommandInputs: {
      "planar-monitor.create": planarMonitorRegionCreationInput(resources, object.id, region.id),
    },
    children: [
      ...(magnetic ? frozenSpinsNodes(nodeId, object.id, region.id, resources) : []),
      ...(magnetic ? [{
        id: `${nodeId}:magnetic-parameters`,
        kind: "object.region.magnetic-parameters",
        label: "Material",
        parentId: nodeId,
        badge: regionMaterialBadge(region),
        icon: "magnet",
        objectId: object.id,
        regionId: region.id,
        status:
          region.materialOverrideCount > 0 || region.materialFieldCount > 0
            ? "ready"
            : "degraded",
      } satisfies ExplorerNode] : []),
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
      ...(magnetic ? [{
        id: `${nodeId}:texture`,
        kind: "object.region.texture",
        label: "Texture",
        parentId: nodeId,
        badge: region.textureOverrideActive ? "Override" : "Inherited",
        icon: "compass",
        objectId: object.id,
        regionId: region.id,
        status: "ready",
      } satisfies ExplorerNode] : []),
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
    ],
  };
}

function frozenSpinsNodes(
  parentId: string,
  objectId: string,
  regionId: string | null,
  resources: ModelTreeResources,
): ExplorerNode[] {
  return (resources.frozenSpins?.definitions ?? []).flatMap((definition) => {
    const owner = frozenSpinsSelectorOwner(definition.selector);
    if (
      !owner ||
      owner.objectId !== objectId ||
      (owner.regionId ?? null) !== regionId
    ) {
      return [];
    }
    return [frozenSpinsNode(parentId, definition, owner)];
  });
}

function frozenSpinsNode(
  parentId: string,
  definition: FrozenSpinsDefinition,
  owner: { objectId: string; regionId?: string },
): ExplorerNode {
  return {
    id: `${parentId}:frozen-spins:${encodeURIComponent(definition.id)}`,
    kind: "object.frozen-spins",
    label: "Frozen Spins",
    parentId,
    badge: definition.enabled === false ? "disabled" : definition.name,
    constraintId: definition.id,
    icon: "shield",
    objectId: owner.objectId,
    ...(owner.regionId ? { regionId: owner.regionId } : {}),
    status: definition.enabled === false ? "degraded" : "ready",
    contextCommands: ["workspace.focus-selection"],
  };
}

export function frozenSpinsSelectorOwner(
  expression: FrozenSpinsSelectionExpression,
): { objectId: string; regionId?: string } | null {
  if (expression.kind === "in_region") {
    return { objectId: expression.object_id, regionId: expression.region_id };
  }
  if (expression.kind === "in_object") {
    return { objectId: expression.object_id };
  }
  if (
    expression.kind === "and" ||
    expression.kind === "or" ||
    expression.kind === "xor"
  ) {
    const owners = expression.expressions.map(frozenSpinsSelectorOwner);
    if (owners.length === 0 || owners.some((owner) => owner === null)) return null;
    const first = owners[0]!;
    return owners.every(
      (owner) =>
        owner !== null &&
        owner.objectId === first.objectId &&
        (owner.regionId ?? null) === (first.regionId ?? null),
    )
      ? first
      : null;
  }
  // A negated selector denotes the complement of its child and therefore has
  // no unambiguous local owner in the object/region tree.
  if (expression.kind === "not") return null;
  return null;
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

function objectMaterialNode(
  parentId: string,
  object: ModelTreeObjectSnapshot,
): ExplorerNode {
  const materialLabel = object.materialLabel ?? object.material ?? "unassigned";
  return {
    id: `${parentId}:material`,
    kind: "object.material",
    label: "Material",
    parentId,
    badge: materialLabel,
    icon: "magnet",
    objectId: object.id,
    status: object.material ? "ready" : "degraded",
  };
}

function unifiedObjectPhysicsNode(
  parentId: string,
  object: ModelTreeObjectSnapshot,
  physicsGraph: unknown | null | undefined,
  currentTransports: CurrentTransportListResource | null | undefined,
): ExplorerNode | null {
  const interactions = object.physicsInteractions ?? [];
  const graphScopeNode = buildPhysicsGraphObjectNode(
    physicsGraph,
    { id: object.id, label: object.label },
    currentTransports,
  );
  const graphChildren = graphScopeNode?.children ?? [];
  if (interactions.length === 0 && graphChildren.length === 0) {
    return null;
  }

  const physicsNodeId = `${parentId}:physics`;
  const graphModuleKinds = new Set(
    graphChildren.map((child) => child.physicsModuleKind ?? child.physicsModuleId ?? ""),
  );
  const interactionNodes: ExplorerNode[] = interactions
    .filter((interaction) => !graphModuleKinds.has(interaction.id))
    .map((interaction) => ({
      id: `${physicsNodeId}:${interaction.id}`,
      kind: "physics.module" as const,
      label: interaction.label,
      parentId: physicsNodeId,
      badge: physicsInteractionBadge(interaction),
      icon: "activity" as const,
      objectId: object.id,
      physicsActivation: interaction.enabledCount > 0 ? "active" : "inactive",
      physicsModuleId: interaction.id,
      physicsModuleKind: interaction.id,
      physicsScopeKind: "object" as const,
      status: interaction.enabledCount > 0 ? ("ready" as const) : ("degraded" as const),
    }));

  const children = [
    ...interactionNodes,
    ...graphChildren.map((child) => ({ ...child, parentId: physicsNodeId })),
  ];
  const activeCount = children.filter((c) => c.status === "ready").length;

  return {
    id: physicsNodeId,
    kind: "object.physics",
    label: "Physics",
    parentId,
    badge: activeCount > 0 ? `${activeCount} active` : `${children.length}`,
    icon: "activity",
    objectId: object.id,
    selectable: true,
    status: "ready",
    children,
  };
}

function physicsInteractionBadge(
  interaction: ModelTreePhysicsInteractionSnapshot,
): string {
  if (interaction.objectCount === 0) return "default";
  if (interaction.enabledCount === interaction.objectCount) return "active";
  if (interaction.enabledCount === 0) return "disabled";
  return `${interaction.enabledCount}/${interaction.objectCount} active`;
}
