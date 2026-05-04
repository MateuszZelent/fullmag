
import type {
  BackendCapabilities,
  MeshWorkspaceManifestRegionState,
  ModelBuilderGraphV2,
  SceneDocument,
  ScriptBuilderCurrentModuleEntry,
  ScriptBuilderExcitationAnalysisEntry,
  ScriptBuilderGeometryEntry,
  ScriptBuilderMagneticInteractionEntry,
  ScriptBuilderStageState,
  VisualizationPreset,
  VisualizationPresetRef,
} from "@/lib/session/types";
import { buildScriptBuilderFromSceneDocument } from "@/lib/session/sceneDocument";
import { ensureObjectPhysicsStack } from "@/lib/session/magneticPhysics";
import { buildDefaultScriptBuilderMagnetization } from "@/lib/session/magnetizationCanonical";
import {
  buildPhysicsCapabilityView,
  type PhysicsCapabilityViewEntry,
} from "@/lib/session/physicsCatalog";
import type { DirtyState, GeometryGraphDocument, BuilderSelectionTarget } from "@/features/geometry-builder/model/types";
import type { PrimitiveNode } from "@/features/geometry-builder/model/types";
import type { NodeStatus, TreeNodeData } from "./types";
import {
  buildFlatStudyStageTreeNodes,
  buildStudyPipelineTreeNodes,
} from "./studyTreeBuilders";
import { buildResultRootChildren } from "./resultTreeBuilders";
import {
  buildAuthoringPrimitiveObjectNode,
  buildObjectNode,
  buildUniverseChildren,
} from "./objectTreeBuilders";

function hasNonZeroField(field: readonly number[] | null | undefined): boolean {
  return Boolean(field && field.some((component) => Math.abs(Number(component) || 0) > 0));
}

function normalizePhysicsStack(
  stack: readonly ScriptBuilderMagneticInteractionEntry[],
): ScriptBuilderMagneticInteractionEntry[] {
  const byKind = new Map<string, ScriptBuilderMagneticInteractionEntry>();
  for (const entry of stack) {
    const current = byKind.get(entry.kind);
    if (!current) {
      byKind.set(entry.kind, entry);
      continue;
    }
    byKind.set(entry.kind, {
      ...current,
      enabled: current.enabled || entry.enabled,
      params: current.params ?? entry.params,
    });
  }
  return Array.from(byKind.values());
}

function enrichPhysicsCapabilityEntries(
  entries: PhysicsCapabilityViewEntry[],
  opts: {
    zeemanField?: readonly number[] | null;
    exchangeEnabled?: boolean;
    demagEnabled?: boolean;
    interfacialDmiFromMaterial?: boolean;
    metadata?: Record<string, unknown> | null;
    sceneDocument?: SceneDocument | null;
  },
): PhysicsCapabilityViewEntry[] {
  return entries.map((entry) => {
    let active = entry.active;
    let available = entry.available;
    if (entry.id === "zeeman") {
      active = hasNonZeroField(opts.zeemanField);
      if (active) {
        available = true;
      }
    } else if (entry.id === "exchange") {
      active = opts.exchangeEnabled ?? entry.active;
      if (opts.exchangeEnabled === true) {
        available = true;
      }
    } else if (entry.id === "demag") {
      active = opts.demagEnabled ?? entry.active;
      if (opts.demagEnabled === true) {
        available = true;
      }
    } else if (entry.id === "interfacial_dmi") {
      active = entry.active || opts.interfacialDmiFromMaterial === true;
    } else if (entry.id === "thermal_noise") {
      const thermalFromScene = opts.sceneDocument?.study.thermal_noise;
      active = opts.metadata?.thermal_active === true
        || (thermalFromScene?.enabled === true);
    } else if (entry.id === "spin_transfer_torque") {
      const sttFromScene = opts.sceneDocument?.study.spin_torque_modules;
      active = opts.metadata?.stt_active === true
        || (Array.isArray(sttFromScene) && sttFromScene.length > 0);
    } else if (entry.id === "spin_orbit_torque") {
      active = opts.metadata?.sot_active === true;
    } else if (entry.id === "oersted") {
      const oerstedFromScene = opts.sceneDocument?.study.oersted;
      active = opts.metadata?.oersted_active === true
        || (oerstedFromScene?.enabled === true);
    }
    return { ...entry, active, available };
  });
}

function physicsModuleNodeStatus(entry: PhysicsCapabilityViewEntry): NodeStatus {
  if (entry.active && !entry.available) return "error";
  if (entry.active) return "ready";
  if (entry.available) return "pending";
  return "pending";
}

function physicsModuleNodeBadge(entry: PhysicsCapabilityViewEntry): string {
  if (entry.active && !entry.available) return "active · unsupported";
  if (entry.active) return "active";
  if (entry.available) return "available";
  return "unavailable";
}


/* ── Main builder + sub-builders ───────────────────────────────────── */

export function buildFullmagModelTree(opts: {
  graph?: ModelBuilderGraphV2 | null;
  sceneDocument?: SceneDocument | null;
  studyLabel?: string | null;
  backend?: string;
  showUniverse?: boolean;
  universeMode?: string | null;
  universeDeclaredSize?: [number, number, number] | null;
  universeEffectiveSize?: [number, number, number] | null;
  universeCenter?: [number, number, number] | null;
  universePadding?: [number, number, number] | null;
  universeRole?: string | null;
  domainMeshMode?: string | null;
  airPartElementCount?: number | null;
  airPartNodeCount?: number | null;
  geometryKind?: string;
  materialName?: string;
  materialMsat?: number | null;
  materialAex?: number | null;
  materialAlpha?: number | null;
  meshStatus?: NodeStatus;
  meshElements?: number;
  meshNodes?: number;
  meshFeOrder?: number | null;
  meshName?: string | null;
  solverStatus?: NodeStatus;
  solverIntegrator?: string;
  solverRelaxAlgorithm?: string;
  demagRealization?: string | null;
  physicsTerms?: string[];
  capabilities?: BackendCapabilities | null;
  metadata?: Record<string, unknown> | null;
  exchangeEnabled?: boolean;
  demagEnabled?: boolean;
  zeemanField?: number[] | null;
  convergenceStatus?: NodeStatus;
  scalarRowCount?: number;
  onGeometryClick?: () => void;
  onRegionsClick?: () => void;
  onMeshClick?: () => void;
  onMaterialClick?: () => void;
  onPhysicsClick?: () => void;
  onSolverClick?: () => void;
  onResultsClick?: () => void;
  /** When false, the Outputs/Results branch is hidden. */
  showResultsSection?: boolean;
  /** Result quantities available for spatial/field previews. */
  resultsFieldQuantities?: Array<{
    id: string;
    label: string;
    kind: string;
    unit?: string | null;
  }>;
  /** Result quantities available as derived/global scalars. */
  resultsScalarQuantities?: Array<{
    id: string;
    label: string;
    kind: string;
    unit?: string | null;
  }>;
  /** User-created/custom result analyses (added from ribbon and interactions). */
  resultWorkspaceEntries?: Array<{
    id: string;
    label: string;
    icon?: string;
    badge?: string | null;
    status?: NodeStatus;
    group?: "auto" | "pinned";
    createdAtUnixMs?: number;
  }>;
  initialStatePath?: string | null;
  initialStateFormat?: string | null;
  geometries?: ScriptBuilderGeometryEntry[];
  currentModules?: ScriptBuilderCurrentModuleEntry[];
  excitationAnalysis?: ScriptBuilderExcitationAnalysisEntry | null;
  /** Number of eigenmodes computed. When >0 an Eigenmodes branch appears under Outputs. */
  eigenModeCount?: number | null;
  /** Short summary labels for each computed eigenmode (e.g. "0 · 12.3 GHz · ip"). */
  eigenModeSummaries?: { index: number; label: string }[];
  eigenHasDispersion?: boolean;
  /** Whether time-domain vortex data is available (scalarRows with mx/my/mz). */
  hasVortexData?: boolean;
  visualizationProjectPresets?: VisualizationPreset[];
  visualizationLocalPresets?: VisualizationPreset[];
  activeVisualizationPresetRef?: VisualizationPresetRef | null;
  activeStudyStageIndex?: number | null;
  completedStudyStageIndexes?: number[];
  studyStageStatuses?: string[];
  pipelineStageIndexesByNodeId?: Record<string, number[]>;
  geometryAuthoringGraph?: GeometryGraphDocument | null;
  geometryAuthoringDirty?: DirtyState | null;
  meshManifestSceneRevision?: number | null;
  meshManifestRealizationRevision?: number | null;
  meshManifestRegionCount?: number | null;
  meshManifestRegions?: MeshWorkspaceManifestRegionState[];
  onGeometryAuthoringSelect?: (target: BuilderSelectionTarget) => void;
}): TreeNodeData[] {
  const graph = opts.graph ?? null;
  const sceneDocument = opts.sceneDocument ?? null;
  const sceneBuilder = sceneDocument
    ? buildScriptBuilderFromSceneDocument(sceneDocument)
    : null;
  const graphUniverse = graph?.universe.value ?? null;
  const graphObjects =
    graph?.objects.items.map((objectNode) => ({
      id: `obj-${objectNode.id}`,
      objectId: objectNode.id,
      name: objectNode.name,
        label: objectNode.label,
        geometry: objectNode.geometry,
        tree: objectNode.tree,
    })) ??
    [];
  const sceneObjects = sceneDocument?.objects ?? [];
  const sceneTreeObjects =
    sceneObjects.length > 0
      ? sceneObjects.map((object, index) => ({
          id: `obj-${object.name || object.id}`,
          objectId: object.id,
          name: object.name || object.id,
          label: object.name || object.id,
          geometry:
            sceneBuilder?.geometries[index] ?? {
              name: object.name || object.id,
              region_name: object.region_name,
              geometry_kind: object.geometry.geometry_kind,
              geometry_params: object.geometry.geometry_params,
              bounds_min: object.geometry.bounds_min ?? null,
              bounds_max: object.geometry.bounds_max ?? null,
              material: {
                Ms: null,
                Aex: null,
                alpha: 0.01,
                Dind: null,
              },
              physics_stack: ensureObjectPhysicsStack(null),
              magnetization: buildDefaultScriptBuilderMagnetization(),
              mesh: object.mesh_override,
            },
          tree: {
            geometry: `geo-${object.name || object.id}`,
            material: `mat-${object.name || object.id}`,
            region: `reg-${object.name || object.id}`,
            mesh: `geo-${object.name || object.id}-mesh`,
          },
          meshDirty: object.tags?.includes("mesh:dirty") ?? false,
        }))
      : [];
  const geos = sceneTreeObjects.map((objectNode) => objectNode.geometry).length > 0
    ? sceneTreeObjects.map((objectNode) => objectNode.geometry)
    : graphObjects.map((objectNode) => objectNode.geometry).length > 0
      ? graphObjects.map((objectNode) => objectNode.geometry)
    : opts.geometries ?? [];
  const objects = sceneTreeObjects.length > 0
    ? sceneTreeObjects
    : graphObjects.length > 0
      ? graphObjects
    : geos.map((geometry) => ({
        id: `obj-${geometry.name}`,
        objectId: geometry.name,
        name: geometry.name,
        label: geometry.name,
        geometry,
        tree: {
          geometry: `geo-${geometry.name}`,
          material: `mat-${geometry.name}`,
          region: `reg-${geometry.name}`,
          mesh: `geo-${geometry.name}-mesh`,
        },
      }));
  const modules = graph?.current_modules.modules ?? opts.currentModules ?? [];
  const excitationAnalysis =
    graph?.current_modules.excitation_analysis ?? opts.excitationAnalysis ?? null;
  const visualizationProjectPresets = opts.visualizationProjectPresets ?? [];
  const visualizationLocalPresets = opts.visualizationLocalPresets ?? [];
  const activeVisualizationPresetRef = opts.activeVisualizationPresetRef ?? null;
  const studyStages = graph?.study.stages ?? [];
  const studyPipeline = graph?.study.study_pipeline ?? null;
  const activeStudyStageIndex = opts.activeStudyStageIndex ?? null;
  const completedStudyStageIndexes = new Set(opts.completedStudyStageIndexes ?? []);
  const studyStageStatuses =
    opts.studyStageStatuses && opts.studyStageStatuses.length > 0
      ? opts.studyStageStatuses
      : Array.from({ length: studyStages.length }, (_, index) =>
          activeStudyStageIndex === index
            ? "running"
            : completedStudyStageIndexes.has(index)
              ? "completed"
              : "pending",
        );
  const pipelineStageIndexesByNodeId = new Map(
    Object.entries(opts.pipelineStageIndexesByNodeId ?? {}),
  );
  const showResultsSection = opts.showResultsSection ?? true;
  const resultFieldQuantities = opts.resultsFieldQuantities ?? [];
  const resultScalarQuantities = opts.resultsScalarQuantities ?? [];
  const resultWorkspaceEntries = opts.resultWorkspaceEntries ?? [];
  const showUniverse = Boolean(
    graphUniverse ||
      opts.showUniverse ||
      opts.universeDeclaredSize ||
      opts.universeEffectiveSize,
  );
  const universeMode = opts.universeMode ?? graphUniverse?.mode ?? null;
  const universeDeclaredSize = opts.universeDeclaredSize ?? graphUniverse?.size ?? null;
  const universeCenter = opts.universeCenter ?? graphUniverse?.center ?? null;
  const universePadding = opts.universePadding ?? graphUniverse?.padding ?? null;
  const geometryAuthoringDirty = opts.geometryAuthoringDirty ?? null;
  const geometryAuthoringMeshDirty = Boolean(
    geometryAuthoringDirty?.geometryDraftDirty ||
      geometryAuthoringDirty?.geometryRealizationDirty ||
      geometryAuthoringDirty?.meshDirty,
  );
  const meshManifestSceneRevision = opts.meshManifestSceneRevision ?? null;
  const meshManifestRealizationRevision = opts.meshManifestRealizationRevision ?? null;
  const meshManifestRegions = opts.meshManifestRegions ?? [];
  const meshManifestStale = Boolean(
    sceneDocument &&
      meshManifestSceneRevision != null &&
      sceneDocument.revision !== meshManifestSceneRevision,
  );
  const meshRegionsByObjectId = new Map<string, MeshWorkspaceManifestRegionState[]>();
  for (const region of meshManifestRegions) {
    for (const objectId of region.source_object_ids) {
      const current = meshRegionsByObjectId.get(objectId) ?? [];
      current.push(region);
      meshRegionsByObjectId.set(objectId, current);
    }
  }

  /* ── Physics ─────────────────────────────────────────────────────── */
  const aggregatePhysicsStack = normalizePhysicsStack(
    geos.flatMap((geometry) =>
      ensureObjectPhysicsStack(
        geometry.physics_stack,
        geometry.material.Dind ?? null,
      ),
    ),
  );
  const rawPhysicsCapabilityEntries = buildPhysicsCapabilityView(
    opts.capabilities ?? null,
    aggregatePhysicsStack,
  );
  const physicsCapabilityEntries = enrichPhysicsCapabilityEntries(
    rawPhysicsCapabilityEntries,
    {
      zeemanField: opts.zeemanField,
      exchangeEnabled: opts.exchangeEnabled,
      demagEnabled: opts.demagEnabled,
      interfacialDmiFromMaterial: geos.some(
        (geometry) => Math.abs(Number(geometry.material.Dind ?? 0)) > 0,
      ),
      metadata: opts.metadata,
      sceneDocument,
    },
  );
  const visiblePhysicsCapabilityEntries = physicsCapabilityEntries.filter((entry) => entry.active);
  const demagBoundaryLabel =
    opts.demagRealization == null || opts.demagRealization === "auto"
      ? "Auto"
      : opts.demagRealization === "poisson_dirichlet" || opts.demagRealization === "airbox_dirichlet"
        ? "Dirichlet"
        : opts.demagRealization === "poisson_robin" || opts.demagRealization === "airbox_robin"
          ? "Robin"
          : opts.demagRealization;
  const physicsChildren: TreeNodeData[] = [
    {
      id: "physics-solver",
      label: "Solver",
      icon: "wrench",
      status: "ready",
      badge: opts.solverIntegrator ? opts.solverIntegrator.toUpperCase() : "auto",
    },
    ...visiblePhysicsCapabilityEntries.map((entry) => ({
      id: `physics-module-${entry.id}`,
      label: entry.label,
      icon:
        entry.id === "exchange"
          ? "repeat"
          : entry.id === "demag"
            ? "magnet"
            : entry.id === "zeeman"
              ? "arrow-right"
              : entry.id === "thermal_noise"
                ? "thermometer"
                : entry.id === "spin_transfer_torque" || entry.id === "spin_orbit_torque"
                  ? "refresh-cw"
                  : entry.id === "interfacial_dmi" || entry.id === "bulk_dmi"
                    ? "git-branch"
                    : entry.id === "uniaxial_anisotropy" || entry.id === "cubic_anisotropy"
                      ? "diamond"
                      : "zap",
      status: physicsModuleNodeStatus(entry),
      badge: physicsModuleNodeBadge(entry),
      children:
        entry.id === "demag"
          ? [
              {
                id: "physics-module-demag-method",
                label: "Method",
                icon: "settings",
                status: physicsModuleNodeStatus(entry),
                badge: opts.solverIntegrator ? opts.solverIntegrator.toUpperCase() : undefined,
              },
              {
                id: "physics-module-demag-boundary",
                label: "Boundary Conditions",
                icon: "square",
                status: physicsModuleNodeStatus(entry),
                badge: demagBoundaryLabel,
              },
            ]
          : undefined,
    })),
  ];

  const authoringPrimitiveObjects =
    opts.geometryAuthoringGraph && geometryAuthoringDirty
      ? opts.geometryAuthoringGraph.nodes
          .filter((node): node is PrimitiveNode => node.kind === "primitive")
          .map((node) =>
            buildAuthoringPrimitiveObjectNode(
              node,
              geometryAuthoringDirty,
              opts.onGeometryAuthoringSelect,
            ),
          )
      : [];

  const objectsChildren: TreeNodeData[] =
    objects.length > 0
      ? [
          ...objects.map((objectNode) =>
            buildObjectNode(objectNode, undefined, {
              regions:
                meshRegionsByObjectId.get(objectNode.objectId ?? objectNode.name) ??
                meshRegionsByObjectId.get(objectNode.name) ??
                [],
              manifestStale: meshManifestStale,
            }),
          ),
          ...authoringPrimitiveObjects,
        ]
      : authoringPrimitiveObjects.length > 0
        ? authoringPrimitiveObjects
      : [
          {
            id: "objects-empty",
            label: "No objects yet",
            icon: "◻",
            status: "pending",
          },
        ];

  const studyChildren: TreeNodeData[] = [];

  studyChildren.push({
    id: "runtime",
    label: "Runtime & Backend",
    icon: "cpu",
    badge: opts.backend ?? "auto",
    status: opts.solverStatus === "active" ? "active" : "ready",
    defaultOpen: false,
  });

  if (showUniverse) {
    studyChildren.push({
      id: "universe",
      label: "Universe",
      icon: "box",
      badge: universeMode ?? "derived",
      status: "ready",
      defaultOpen: true,
      children: buildUniverseChildren({
        universeDeclaredSize,
        universeEffectiveSize: opts.universeEffectiveSize,
        universeCenter,
        universePadding,
        universeRole: opts.universeRole,
        domainMeshMode: opts.domainMeshMode,
        airPartElementCount: opts.airPartElementCount,
        airPartNodeCount: opts.airPartNodeCount,
        meshStatus: opts.meshStatus,
        meshElements: opts.meshElements,
        meshNodes: opts.meshNodes,
        meshFeOrder: opts.meshFeOrder,
      }),
    });
  }

  if (opts.domainMeshMode === "shared_domain_mesh_with_air") {
    studyChildren.push({
      id: "mesh",
      label: "Study Domain Mesh",
      icon: "grid-3x3",
      badge: opts.meshElements
        ? `${opts.meshElements.toLocaleString()} el`
        : opts.meshNodes
          ? `${opts.meshNodes.toLocaleString()} nodes`
          : "—",
      status: geometryAuthoringMeshDirty ? "stale" : (opts.meshStatus ?? "pending"),
      defaultOpen: false,
      children: [
        ...(geometryAuthoringMeshDirty
          ? [{ id: "mesh-authoring-dirty", label: "Mesh out of date - build mesh before compute", icon: "alert-triangle", status: "blocked" as const }]
          : []),
        ...(meshManifestStale
          ? [{ id: "mesh-manifest-stale", label: "Mesh manifest is stale for current scene revision", icon: "alert-triangle", status: "warning" as const }]
          : []),
        ...(meshManifestSceneRevision != null
          ? [{ id: "mesh-source-scene-revision", label: `Scene rev ${meshManifestSceneRevision}`, icon: "git-commit" } satisfies TreeNodeData]
          : []),
        ...(meshManifestRealizationRevision != null
          ? [{ id: "mesh-realization-revision", label: `Geometry realization rev ${meshManifestRealizationRevision}`, icon: "workflow" } satisfies TreeNodeData]
          : []),
        ...(opts.meshManifestRegionCount != null
          ? [{ id: "mesh-region-count", label: `${opts.meshManifestRegionCount} mesh region${opts.meshManifestRegionCount === 1 ? "" : "s"}`, icon: "layers" } satisfies TreeNodeData]
          : []),
        { id: "mesh-view", label: "Inspector", icon: "eye" },
        { id: "mesh-statistics", label: "Statistics", icon: "bar-chart-3" },
        { id: "mesh-size", label: "Size", icon: "ruler" },
        { id: "mesh-quality", label: "Quality", icon: "gauge" },
        { id: "mesh-pipeline", label: "Pipeline", icon: "workflow" },
      ],
    });
  }

  studyChildren.push({
    id: "objects",
    label: "Objects",
    icon: "package",
    badge: `${objects.length + authoringPrimitiveObjects.length}`,
    status: objects.length + authoringPrimitiveObjects.length > 0 ? "ready" : "pending",
    defaultOpen: true,
    onClick: opts.onGeometryClick,
    children: objectsChildren,
  });

  if (modules.length > 0 || excitationAnalysis) {
    const antennaChildren: TreeNodeData[] = modules.map((module) => ({
      id: `ant-${module.name}`,
      label: module.name,
      icon: module.antenna_kind === "CPWAntenna" ? "≋" : "▭",
      badge: `${module.antenna_kind === "CPWAntenna" ? "CPW" : "µstrip"} · ${(module.drive.current_a * 1e3).toFixed(1)} mA`,
      status: "ready" as const,
    }));
    if (excitationAnalysis) {
      antennaChildren.push({
        id: "ant-excitation",
        label: "Excitation Analysis",
        icon: "📡",
        badge: excitationAnalysis.method,
        status: "ready",
      });
    }
    studyChildren.push({
      id: "antennas",
      label: "Antennas / RF",
      icon: "📻",
      badge: `${modules.length} source${modules.length !== 1 ? "s" : ""}`,
      status: modules.length > 0 ? "ready" : "pending",
      defaultOpen: false,
      children: antennaChildren,
    });
  }

  const authoringStageChildren =
    studyPipeline && studyPipeline.nodes.length > 0
      ? buildStudyPipelineTreeNodes(
          studyPipeline.nodes,
          pipelineStageIndexesByNodeId,
          studyStageStatuses,
        )
      : buildFlatStudyStageTreeNodes(
          studyStages,
          studyStageStatuses,
        );
  const authoringStageCount = studyPipeline?.nodes.length ?? studyStages.length;
  const resultRootChildren = buildResultRootChildren({
    studyStages,
    resultFieldQuantities,
    resultScalarQuantities,
    resultWorkspaceEntries,
    scalarRowCount: opts.scalarRowCount,
    eigenModeCount: opts.eigenModeCount,
    eigenModeSummaries: opts.eigenModeSummaries,
    eigenHasDispersion: opts.eigenHasDispersion,
    hasVortexData: opts.hasVortexData,
  });

  studyChildren.push(
    {
      id: "physics",
      label: "Physics",
      icon: "zap",
      status: "ready",
      defaultOpen: true,
      onClick: opts.onPhysicsClick,
      children: physicsChildren,
    },
    {
      id: "study",
      label: "Study",
      icon: "play",
      badge: authoringStageCount > 0 ? `${authoringStageCount} stages` : (opts.backend ?? "—"),
      status: opts.solverStatus === "active" ? "ready" : (opts.solverStatus ?? "pending"),
      defaultOpen: true,
      onClick: opts.onSolverClick,
      children: [
        {
          id: "study-stages",
          label: "Stages",
          icon: "🧩",
          badge: opts.activeStudyStageIndex != null 
            ? `executing ${opts.activeStudyStageIndex + 1}/${authoringStageCount}` 
            : authoringStageCount > 0 ? `${authoringStageCount}` : "empty",
          status: authoringStageCount > 0 ? "ready" : "pending",
          defaultOpen: true,
          children:
            authoringStageChildren.length > 0
              ? authoringStageChildren
              : [
                  {
                    id: "study-stage-empty",
                    label: "No stages declared",
                    icon: "◌",
                    status: "pending",
                  },
                ],
        },
      ],
    },
    ...(showResultsSection
      ? [
          {
            id: "results",
            label: "Outputs",
            icon: "bar-chart-3",
            status: (opts.scalarRowCount && opts.scalarRowCount > 0 ? "ready" : "pending") as NodeStatus,
            badge: opts.scalarRowCount ? `${opts.scalarRowCount} pts` : undefined,
            defaultOpen: false,
            onClick: opts.onResultsClick,
            children: resultRootChildren,
          },
        ]
      : []),
  );

  const visualizationChildren: TreeNodeData[] = [
    {
      id: "visualization-section-project",
      label: "Project",
      icon: "🗂",
      badge: `${visualizationProjectPresets.length}`,
      status: "ready",
      defaultOpen: true,
      children:
        visualizationProjectPresets.length > 0
          ? visualizationProjectPresets.map((preset) => ({
              id: `vis-project-${preset.id}`,
              label: preset.name,
              icon: "🎛",
              badge:
                activeVisualizationPresetRef?.source === "project" &&
                activeVisualizationPresetRef?.preset_id === preset.id
                  ? "active"
                  : `${preset.domain.toUpperCase()} · ${preset.mode}`,
              status: "ready" as const,
            }))
          : [
              {
                id: "visualization-project-empty",
                label: "No project presets",
                icon: "◌",
                status: "pending" as const,
              },
            ],
    },
    {
      id: "visualization-section-local",
      label: "Local",
      icon: "💾",
      badge: `${visualizationLocalPresets.length}`,
      status: "ready",
      defaultOpen: true,
      children:
        visualizationLocalPresets.length > 0
          ? visualizationLocalPresets.map((preset) => ({
              id: `vis-local-${preset.id}`,
              label: preset.name,
              icon: "🎛",
              badge:
                activeVisualizationPresetRef?.source === "local" &&
                activeVisualizationPresetRef?.preset_id === preset.id
                  ? "active"
                  : `${preset.domain.toUpperCase()} · ${preset.mode}`,
              status: "ready" as const,
            }))
          : [
              {
                id: "visualization-local-empty",
                label: "No local presets",
                icon: "◌",
                status: "pending" as const,
              },
            ],
    },
  ];

  return [
    {
      id: "study-root",
      label: opts.studyLabel ?? "Simulation",
      icon: "◈",
      badge: opts.backend ?? undefined,
      status: "ready",
      defaultOpen: true,
      children: studyChildren,
    },
    {
      id: "visualization-root",
      label: "Visualization",
      icon: "paintbrush",
      badge: `${visualizationProjectPresets.length + visualizationLocalPresets.length}`,
      status: "ready",
      defaultOpen: false,
      children: visualizationChildren,
    },
  ];
}
