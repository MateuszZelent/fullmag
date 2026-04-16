import type { SetStateAction } from "react";
import type {
  MeshBuildIntent,
  ModelBuilderGraphCurrentModulesNode,
  ModelBuilderGraphObjectNode,
  ModelBuilderGraphV2,
  ScriptBuilderCurrentModuleEntry,
  ScriptBuilderExcitationAnalysisEntry,
  ScriptBuilderGeometryEntry,
  ScriptBuilderInitialState,
  ScriptBuilderMeshState,
  StudyPipelineDocumentState,
  ScriptBuilderSolverState,
  ScriptBuilderStageState,
  ScriptBuilderState,
  ScriptBuilderUniverseState,
} from "./types";

interface ModelBuilderGraphDefaults {
  revision?: number;
  solver?: ScriptBuilderSolverState;
  mesh?: ScriptBuilderMeshState;
  initialState?: ScriptBuilderInitialState | null;
}

const EMPTY_SOLVER: ScriptBuilderSolverState = {
  integrator: "",
  fixed_timestep: "",
  relax_algorithm: "",
  torque_tolerance: "",
  energy_tolerance: "",
  max_relax_steps: "",
};

const EMPTY_MESH: ScriptBuilderMeshState = {
  algorithm_2d: 6,
  algorithm_3d: 1,
  size_mode: "predefined",
  hmax: "",
  hmin: "",
  maximum_element_size: "",
  minimum_element_size: "",
  calibrate_for: "general_physics",
  size_preset: "normal",
  size_factor: 1,
  size_from_curvature: 0,
  curvature_factor: "",
  growth_rate: "",
  maximum_element_growth_rate: "",
  narrow_regions: 0,
  narrow_region_resolution: "",
  resolved_size_from_curvature: null,
  resolved_narrow_regions: null,
  resolved_growth_rate: "",
  smoothing_steps: 1,
  optimize: "",
  optimize_iterations: 1,
  compute_quality: false,
  per_element_quality: false,
  interface_hmax: "",
  interface_thickness: "",
  transition_distance: "",
  transition_growth: "",
  adaptive_enabled: false,
  adaptive_policy: "auto",
  adaptive_indicator: "geometric_only",
  adaptive_target_quantity: "auto",
  adaptive_convergence_metric: "energy_delta",
  adaptive_theta: 0.3,
  adaptive_h_min: "",
  adaptive_h_max: "",
  adaptive_max_passes: 2,
  adaptive_error_tolerance: "1e-3",
};

function applyStateAction<T>(prev: T, action: SetStateAction<T>): T {
  return typeof action === "function" ? (action as (value: T) => T)(prev) : action;
}

function buildObjectNode(geometry: ScriptBuilderGeometryEntry): ModelBuilderGraphObjectNode {
  const geometryId = `geo-${geometry.name}`;
  return {
    id: geometry.name,
    kind: "ferromagnet",
    name: geometry.name,
    label: geometry.name,
    geometry,
    object_mesh: geometry.mesh ?? null,
    tree: {
      geometry: geometryId,
      material: `mat-${geometry.name}`,
      region: `reg-${geometry.name}`,
      mesh: `${geometryId}-mesh`,
    },
  };
}

function buildCurrentModulesNode(
  modules: ScriptBuilderCurrentModuleEntry[],
  excitationAnalysis: ScriptBuilderExcitationAnalysisEntry | null,
): ModelBuilderGraphCurrentModulesNode {
  return {
    id: "current_modules",
    kind: "current_modules",
    label: "Antennas / RF",
    modules,
    excitation_analysis: excitationAnalysis,
  };
}

export function createModelBuilderGraphV2(
  builder?: Partial<ScriptBuilderState> | null,
): ModelBuilderGraphV2 {
  return {
    version: "model_builder.v2",
    source_of_truth: "repo_head",
    authoring_schema: "mesh-first-fem.v1",
    revision: builder?.revision ?? 0,
    study: {
      id: "study",
      kind: "study",
      label: "Simulation",
      backend: builder?.backend ?? null,
      requested_backend: "auto",
      requested_device: "auto",
      requested_precision: "double",
      requested_mode: "strict",
      requested_cpu_threads: builder?.cpu_threads ?? null,
      fem_demag_solver_policy: builder?.fem_demag_solver_policy ?? null,
      demag_realization: builder?.demag_realization ?? null,
      external_field: builder?.external_field ?? null,
      solver: builder?.solver ?? EMPTY_SOLVER,
      universe_mesh: builder?.universe ?? null,
      shared_domain_mesh: builder?.mesh ?? EMPTY_MESH,
      mesh_defaults: builder?.mesh ?? EMPTY_MESH,
      stages: builder?.stages ?? [],
      study_pipeline: builder?.study_pipeline ?? null,
      initial_state: builder?.initial_state ?? null,
    },
    universe: {
      id: "universe",
      kind: "universe",
      label: "Universe",
      value: builder?.universe ?? null,
    },
    objects: {
      id: "objects",
      kind: "objects",
      label: "Objects",
      items: (builder?.geometries ?? []).map(buildObjectNode),
    },
    current_modules: buildCurrentModulesNode(
      builder?.current_modules ?? [],
      builder?.excitation_analysis ?? null,
    ),
  };
}

export function buildModelBuilderGraphV2(
  builder: ScriptBuilderState | null | undefined,
): ModelBuilderGraphV2 | null {
  if (!builder) {
    return null;
  }
  return createModelBuilderGraphV2(builder);
}

export function ensureModelBuilderGraphV2(
  graph: ModelBuilderGraphV2 | null | undefined,
  defaults?: ModelBuilderGraphDefaults,
): ModelBuilderGraphV2 {
  if (graph) {
    return graph;
  }
  return createModelBuilderGraphV2({
    revision: defaults?.revision ?? 0,
    solver: defaults?.solver ?? EMPTY_SOLVER,
    mesh: defaults?.mesh ?? EMPTY_MESH,
    initial_state: defaults?.initialState ?? null,
  });
}

export function serializeModelBuilderGraphV2(graph: ModelBuilderGraphV2): Omit<
  ScriptBuilderState,
  "revision" | "initial_state"
> {
  return {
    backend: graph.study.backend,
    cpu_threads: graph.study.requested_cpu_threads,
    fem_demag_solver_policy: graph.study.fem_demag_solver_policy,
    demag_realization: graph.study.demag_realization,
    external_field: graph.study.external_field,
    solver: graph.study.solver,
    mesh: graph.study.shared_domain_mesh,
    universe: graph.universe.value,
    domain_frame: null,
    stages: graph.study.stages,
    study_pipeline: graph.study.study_pipeline,
    geometries: graph.objects.items.map((objectNode) => objectNode.geometry),
    current_modules: graph.current_modules.modules,
    excitation_analysis: graph.current_modules.excitation_analysis,
  };
}

export function selectModelBuilderStages(
  graph: ModelBuilderGraphV2 | null | undefined,
): ScriptBuilderStageState[] {
  return graph?.study.stages ?? [];
}

export function selectModelBuilderStudyPipeline(
  graph: ModelBuilderGraphV2 | null | undefined,
): StudyPipelineDocumentState | null {
  return graph?.study.study_pipeline ?? null;
}

export function selectModelBuilderUniverse(
  graph: ModelBuilderGraphV2 | null | undefined,
): ScriptBuilderUniverseState | null {
  return graph?.universe.value ?? null;
}

export function selectModelBuilderGeometries(
  graph: ModelBuilderGraphV2 | null | undefined,
): ScriptBuilderGeometryEntry[] {
  return graph?.objects.items.map((objectNode) => objectNode.geometry) ?? [];
}

export function selectModelBuilderCurrentModules(
  graph: ModelBuilderGraphV2 | null | undefined,
): ScriptBuilderCurrentModuleEntry[] {
  return graph?.current_modules.modules ?? [];
}

export function selectModelBuilderExcitationAnalysis(
  graph: ModelBuilderGraphV2 | null | undefined,
): ScriptBuilderExcitationAnalysisEntry | null {
  return graph?.current_modules.excitation_analysis ?? null;
}

export function selectModelBuilderSolver(
  graph: ModelBuilderGraphV2 | null | undefined,
): ScriptBuilderSolverState | null {
  return graph?.study.solver ?? null;
}

export function selectModelBuilderMeshDefaults(
  graph: ModelBuilderGraphV2 | null | undefined,
): ScriptBuilderMeshState | null {
  return graph?.study.shared_domain_mesh ?? graph?.study.mesh_defaults ?? null;
}

export function setModelBuilderStages(
  graph: ModelBuilderGraphV2 | null | undefined,
  action: SetStateAction<ScriptBuilderStageState[]>,
  defaults?: ModelBuilderGraphDefaults,
): ModelBuilderGraphV2 {
  const ensured = ensureModelBuilderGraphV2(graph, defaults);
  const nextStages = applyStateAction(ensured.study.stages, action);
  return {
    ...ensured,
    study: {
      ...ensured.study,
      stages: nextStages,
    },
  };
}

export function setModelBuilderStudyPipeline(
  graph: ModelBuilderGraphV2 | null | undefined,
  action: SetStateAction<StudyPipelineDocumentState | null>,
  defaults?: ModelBuilderGraphDefaults,
): ModelBuilderGraphV2 {
  const ensured = ensureModelBuilderGraphV2(graph, defaults);
  const nextStudyPipeline = applyStateAction(ensured.study.study_pipeline, action);
  return {
    ...ensured,
    study: {
      ...ensured.study,
      study_pipeline: nextStudyPipeline,
    },
  };
}

export function setModelBuilderDemagRealization(
  graph: ModelBuilderGraphV2 | null | undefined,
  action: SetStateAction<string | null>,
  defaults?: ModelBuilderGraphDefaults,
): ModelBuilderGraphV2 {
  const ensured = ensureModelBuilderGraphV2(graph, defaults);
  const nextValue = applyStateAction(ensured.study.demag_realization, action);
  return {
    ...ensured,
    study: {
      ...ensured.study,
      demag_realization: nextValue,
    },
  };
}

export function setModelBuilderRequestedRuntime(
  graph: ModelBuilderGraphV2 | null | undefined,
  action: SetStateAction<{
    requested_backend: string;
    requested_device: string;
    requested_precision: string;
    requested_mode: string;
    requested_cpu_threads: number | null;
  }>,
  defaults?: ModelBuilderGraphDefaults,
): ModelBuilderGraphV2 {
  const ensured = ensureModelBuilderGraphV2(graph, defaults);
  const nextRuntime = applyStateAction(
    {
      requested_backend: ensured.study.requested_backend,
      requested_device: ensured.study.requested_device,
      requested_precision: ensured.study.requested_precision,
      requested_mode: ensured.study.requested_mode,
      requested_cpu_threads: ensured.study.requested_cpu_threads,
    },
    action,
  );
  return {
    ...ensured,
    study: {
      ...ensured.study,
      ...nextRuntime,
    },
  };
}

export function setModelBuilderUniverse(
  graph: ModelBuilderGraphV2 | null | undefined,
  action: SetStateAction<ScriptBuilderUniverseState | null>,
  defaults?: ModelBuilderGraphDefaults,
): ModelBuilderGraphV2 {
  const ensured = ensureModelBuilderGraphV2(graph, defaults);
  const nextUniverse = applyStateAction(ensured.universe.value, action);
  return {
    ...ensured,
    universe: {
      ...ensured.universe,
      value: nextUniverse,
    },
  };
}

export function setModelBuilderGeometries(
  graph: ModelBuilderGraphV2 | null | undefined,
  action: SetStateAction<ScriptBuilderGeometryEntry[]>,
  defaults?: ModelBuilderGraphDefaults,
): ModelBuilderGraphV2 {
  const ensured = ensureModelBuilderGraphV2(graph, defaults);
  const nextGeometries = applyStateAction(selectModelBuilderGeometries(ensured), action);
  return {
    ...ensured,
    objects: {
      ...ensured.objects,
      items: nextGeometries.map(buildObjectNode),
    },
  };
}

export function setModelBuilderCurrentModules(
  graph: ModelBuilderGraphV2 | null | undefined,
  action: SetStateAction<ScriptBuilderCurrentModuleEntry[]>,
  defaults?: ModelBuilderGraphDefaults,
): ModelBuilderGraphV2 {
  const ensured = ensureModelBuilderGraphV2(graph, defaults);
  const nextModules = applyStateAction(ensured.current_modules.modules, action);
  return {
    ...ensured,
    current_modules: buildCurrentModulesNode(
      nextModules,
      ensured.current_modules.excitation_analysis,
    ),
  };
}

export function setModelBuilderExcitationAnalysis(
  graph: ModelBuilderGraphV2 | null | undefined,
  action: SetStateAction<ScriptBuilderExcitationAnalysisEntry | null>,
  defaults?: ModelBuilderGraphDefaults,
): ModelBuilderGraphV2 {
  const ensured = ensureModelBuilderGraphV2(graph, defaults);
  const nextAnalysis = applyStateAction(ensured.current_modules.excitation_analysis, action);
  return {
    ...ensured,
    current_modules: buildCurrentModulesNode(ensured.current_modules.modules, nextAnalysis),
  };
}

export function setModelBuilderSolver(
  graph: ModelBuilderGraphV2 | null | undefined,
  solver: ScriptBuilderSolverState,
  defaults?: ModelBuilderGraphDefaults,
): ModelBuilderGraphV2 {
  const ensured = ensureModelBuilderGraphV2(graph, defaults);
  return {
    ...ensured,
    study: {
      ...ensured.study,
      solver,
    },
  };
}

export function setModelBuilderMeshDefaults(
  graph: ModelBuilderGraphV2 | null | undefined,
  meshDefaults: ScriptBuilderMeshState,
  defaults?: ModelBuilderGraphDefaults,
): ModelBuilderGraphV2 {
  const ensured = ensureModelBuilderGraphV2(graph, defaults);
  return {
    ...ensured,
    study: {
      ...ensured.study,
      shared_domain_mesh: meshDefaults,
      mesh_defaults: meshDefaults,
    },
  };
}

export function resolveSelectedObjectIdFromModelBuilderGraph(
  graph: ModelBuilderGraphV2 | null | undefined,
  nodeId: string | null | undefined,
): string | null {
  if (!graph || !nodeId) {
    return null;
  }
  for (const objectNode of graph.objects.items) {
    const objectPrefix = `obj-${objectNode.id}`;
    const geometryPrefix = objectNode.tree.geometry;
    const materialPrefix = objectNode.tree.material;
    const regionPrefix = objectNode.tree.region;
    const meshPrefix = objectNode.tree.mesh;
    const physicsPrefix = `physobj-${objectNode.name}`;
    const magnetizationPrefix = `mag-${objectNode.name}`;
    if (
      nodeId === objectPrefix ||
      nodeId.startsWith(`${objectPrefix}-`) ||
      nodeId === geometryPrefix ||
      nodeId.startsWith(`${geometryPrefix}-`) ||
      nodeId === materialPrefix ||
      nodeId.startsWith(`${materialPrefix}-`) ||
      nodeId === regionPrefix ||
      nodeId.startsWith(`${regionPrefix}-`) ||
      nodeId === physicsPrefix ||
      nodeId.startsWith(`${physicsPrefix}-`) ||
      nodeId === magnetizationPrefix ||
      nodeId.startsWith(`${magnetizationPrefix}-`) ||
      nodeId === meshPrefix ||
      nodeId.startsWith(`${meshPrefix}-`)
    ) {
      return objectNode.name;
    }
  }
  if ((nodeId === "geometry" || nodeId === "objects") && graph.objects.items.length === 1) {
    return graph.objects.items[0]?.name ?? null;
  }
  return null;
}

/**
 * Map a model-tree node ID to a MeshBuildIntent so the UI can dispatch
 * the correct mesh rebuild scope when the user clicks "Build Selected".
 */
export function resolveMeshBuildIntentFromNodeId(
  nodeId: string | null | undefined,
  graph: ModelBuilderGraphV2 | null | undefined,
): MeshBuildIntent | null {
  if (!graph || !nodeId) {
    return null;
  }

  // Universe-level airbox node
  if (nodeId === "universe-airbox" || nodeId.startsWith("universe-airbox-")) {
    return { mode: "selected", target: { kind: "airbox" } };
  }

  // Universe-level mesh node → full study domain rebuild
  if (nodeId === "universe-mesh" || nodeId.startsWith("universe-mesh-")) {
    return { mode: "selected", target: { kind: "study_domain" } };
  }

  // Top-level mesh node → full study domain rebuild
  if (nodeId === "mesh" || nodeId.startsWith("mesh-")) {
    return { mode: "selected", target: { kind: "study_domain" } };
  }

  // Per-object mesh node → object_mesh for that object
  for (const objectNode of graph.objects.items) {
    const meshPrefix = objectNode.tree.mesh;
    if (
      nodeId === meshPrefix ||
      nodeId.startsWith(`${meshPrefix}-`)
    ) {
      return { mode: "selected", target: { kind: "object_mesh", object_id: objectNode.name } };
    }
  }

  return null;
}
