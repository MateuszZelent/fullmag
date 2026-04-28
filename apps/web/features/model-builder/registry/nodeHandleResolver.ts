/**
 * @module model-builder/registry/nodeHandleResolver
 *
 * Resolves raw node ids (e.g. "phys-exchange", "obj-free") into
 * typed NodeHandle objects with full semantic metadata.
 *
 * This replaces all `nodeId.startsWith(...)` cascades throughout
 * the frontend with a single, canonical resolution layer.
 */

import type { NodeHandle, NodeKind, NodeDomain, NodeScope, SourceOfTruth } from "../types";
import { parseStudyNodeContext } from "@/lib/study-builder/node-context";

// ---------------------------------------------------------------------------
// Static node table — nodes with fixed ids
// ---------------------------------------------------------------------------

interface StaticEntry {
  nodeKind: NodeKind;
  domain: NodeDomain;
  scope: NodeScope;
  sourceOfTruth: SourceOfTruth;
}

const STATIC_NODES: Record<string, StaticEntry> = {
  session: {
    nodeKind: "session.root",
    domain: "global",
    scope: "readonly",
    sourceOfTruth: "backend_live",
  },
  "script-builder": {
    nodeKind: "session.script-builder",
    domain: "global",
    scope: "readonly",
    sourceOfTruth: "computed",
  },
  runtime: {
    nodeKind: "session.runtime",
    domain: "global",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
  },
  universe: {
    nodeKind: "universe.root",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
  },
  "universe-domain": {
    nodeKind: "universe.domain",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
  },
  "universe-domain-size": {
    nodeKind: "universe.domain.size",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
  },
  "universe-domain-center": {
    nodeKind: "universe.domain.center",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
  },
  "universe-domain-padding": {
    nodeKind: "universe.domain.padding",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
  },
  "universe-airbox": {
    nodeKind: "universe.airbox",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "scene_document",
  },
  "universe-airbox-sizing": {
    nodeKind: "universe.airbox.sizing",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "scene_document",
  },
  "universe-boundary": {
    nodeKind: "universe.boundary",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
  },
  "universe-mesh": {
    nodeKind: "universe.mesh",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
  },
  "universe-mesh-view": {
    nodeKind: "universe.mesh.view",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
  },
  "universe-mesh-pipeline": {
    nodeKind: "universe.mesh.pipeline",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
  },
  "universe-mesh-algorithm": {
    nodeKind: "universe.mesh.algorithm",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
  },
  "universe-mesh-size": {
    nodeKind: "universe.mesh.size",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
  },
  "universe-mesh-transition": {
    nodeKind: "universe.mesh.transition",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
  },
  "universe-mesh-statistics": {
    nodeKind: "universe.mesh.statistics",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
  },
  "universe-mesh-quality": {
    nodeKind: "universe.mesh.quality",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
  },
  "universe-role": {
    nodeKind: "universe.role",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
  },
  objects: {
    nodeKind: "objects.root",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
  },
  materials: {
    nodeKind: "materials.root",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
  },
  physics: {
    nodeKind: "physics.root",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "phys-llg": {
    nodeKind: "physics.llg",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "phys-exchange": {
    nodeKind: "physics.exchange",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "physics-solver": {
    nodeKind: "physics.solver",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "solver_settings",
  },
  "physics-module-demag": {
    nodeKind: "physics.demag",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "physics-module-demag-method": {
    nodeKind: "physics.demag.method",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "physics-module-demag-boundary": {
    nodeKind: "physics.boundary_conditions",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "phys-demag": {
    nodeKind: "physics.demag",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "phys-demag-method": {
    nodeKind: "physics.demag.method",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "phys-zeeman": {
    nodeKind: "physics.zeeman",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "phys-boundary": {
    nodeKind: "physics.boundary_conditions",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "phys-bc": {
    nodeKind: "physics.boundary_conditions",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "phys-demag-open-bc": {
    nodeKind: "physics.boundary_conditions",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "phys-thermal": {
    nodeKind: "physics.thermal_noise",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "phys-stt": {
    nodeKind: "physics.spin_torque",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "phys-spin-torque": {
    nodeKind: "physics.spin_torque",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "phys-dmi": {
    nodeKind: "physics.dmi",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  "phys-anisotropy": {
    nodeKind: "physics.anisotropy",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
  },
  antennas: {
    nodeKind: "antennas.root",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
  },
  mesh: {
    nodeKind: "mesh.root",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
  },
  "mesh-size": {
    nodeKind: "mesh.size",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
  },
  "mesh-algorithm": {
    nodeKind: "mesh.algorithm",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
  },
  "mesh-transition": {
    nodeKind: "mesh.transition",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
  },
  "mesh-quality": {
    nodeKind: "mesh.quality",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
  },
  "mesh-statistics": {
    nodeKind: "mesh.statistics",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
  },
  study: {
    nodeKind: "study.root",
    domain: "study",
    scope: "solver_affecting",
    sourceOfTruth: "study_pipeline",
  },
  "study-root": {
    nodeKind: "study.root",
    domain: "study",
    scope: "solver_affecting",
    sourceOfTruth: "study_pipeline",
  },
  "study-stages": {
    nodeKind: "study.pipeline.root",
    domain: "study",
    scope: "solver_affecting",
    sourceOfTruth: "study_pipeline",
  },
  "study-stage-empty": {
    nodeKind: "study.pipeline.root",
    domain: "study",
    scope: "solver_affecting",
    sourceOfTruth: "study_pipeline",
  },
  "study-defaults": {
    nodeKind: "study.pipeline.root",
    domain: "study",
    scope: "solver_affecting",
    sourceOfTruth: "study_pipeline",
  },
  "study-defaults-runtime": {
    nodeKind: "study.pipeline.root",
    domain: "study",
    scope: "solver_affecting",
    sourceOfTruth: "study_pipeline",
  },
  "study-defaults-solver": {
    nodeKind: "study.pipeline.root",
    domain: "study",
    scope: "solver_affecting",
    sourceOfTruth: "study_pipeline",
  },
  "study-defaults-physics": {
    nodeKind: "study.pipeline.root",
    domain: "study",
    scope: "solver_affecting",
    sourceOfTruth: "study_pipeline",
  },
  "study-defaults-outputs": {
    nodeKind: "study.pipeline.root",
    domain: "study",
    scope: "solver_affecting",
    sourceOfTruth: "study_pipeline",
  },
  results: {
    nodeKind: "results.root",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
  },
  "res-fields": {
    nodeKind: "results.fields",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
  },
  "res-energy": {
    nodeKind: "results.energy",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
  },
  "res-state-io": {
    nodeKind: "results.state_io",
    domain: "results",
    scope: "output_affecting",
    sourceOfTruth: "backend_live",
  },
  "res-export": {
    nodeKind: "results.export",
    domain: "results",
    scope: "output_affecting",
    sourceOfTruth: "backend_live",
  },
  "initial-state": {
    nodeKind: "object.initial_state",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
  },
};

// ---------------------------------------------------------------------------
// Prefix rules — for dynamically generated nodes (obj-free, mat-Co, etc.)
// ---------------------------------------------------------------------------

interface PrefixRule {
  prefix: string;
  nodeKind: NodeKind;
  domain: NodeDomain;
  scope: NodeScope;
  sourceOfTruth: SourceOfTruth;
  /** Extract entity id from node id after stripping prefix */
  entityFromSuffix?: boolean;
}

const PREFIX_RULES: PrefixRule[] = [
  // Order matters — more specific prefixes first
  {
    prefix: "vis-project-",
    nodeKind: "visualization.preset.project",
    domain: "global",
    scope: "workspace_only",
    sourceOfTruth: "workspace_store",
    entityFromSuffix: true,
  },
  {
    prefix: "vis-local-",
    nodeKind: "visualization.preset.local",
    domain: "global",
    scope: "workspace_only",
    sourceOfTruth: "workspace_store",
    entityFromSuffix: true,
  },
  {
    prefix: "vis-",
    nodeKind: "visualization.root",
    domain: "global",
    scope: "workspace_only",
    sourceOfTruth: "workspace_store",
    entityFromSuffix: true,
  },
  {
    prefix: "physobj-",
    nodeKind: "object.material",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
    entityFromSuffix: true,
  },
  {
    prefix: "mag-",
    nodeKind: "object.initial_state",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
    entityFromSuffix: true,
  },
  {
    prefix: "geo-",
    nodeKind: "object.geometry",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
    entityFromSuffix: true,
  },
  {
    prefix: "reg-",
    nodeKind: "object.region",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
    entityFromSuffix: true,
  },
  {
    prefix: "obj-",
    nodeKind: "object.root",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
    entityFromSuffix: true,
  },
  {
    prefix: "mat-",
    nodeKind: "material.entry",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
    entityFromSuffix: true,
  },
  {
    prefix: "ant-",
    nodeKind: "antenna.cpw",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
    entityFromSuffix: true,
  },
  {
    prefix: "physics-module-",
    nodeKind: "physics.interaction",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
    entityFromSuffix: true,
  },
  {
    prefix: "phys-",
    nodeKind: "physics.interaction",
    domain: "build",
    scope: "physics_affecting",
    sourceOfTruth: "scene_document",
    entityFromSuffix: true,
  },
  {
    prefix: "universe-",
    nodeKind: "universe.root",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
    entityFromSuffix: true,
  },
  {
    prefix: "mesh-",
    nodeKind: "mesh.root",
    domain: "build",
    scope: "mesh_affecting",
    sourceOfTruth: "mesh_options",
    entityFromSuffix: true,
  },
  {
    prefix: "res-solution-",
    nodeKind: "results.solution",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
    entityFromSuffix: true,
  },
  {
    prefix: "res-dataset-",
    nodeKind: "results.dataset",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
    entityFromSuffix: true,
  },
  {
    prefix: "res-analysis-",
    nodeKind: "results.analysis",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
    entityFromSuffix: true,
  },
  {
    prefix: "res-eigenmode-",
    nodeKind: "results.eigenmode",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
    entityFromSuffix: true,
  },
  {
    prefix: "res-time-trace-",
    nodeKind: "results.time_trace",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
    entityFromSuffix: true,
  },
  {
    prefix: "res-qty-",
    nodeKind: "results.field_quantity",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
    entityFromSuffix: true,
  },
  {
    prefix: "res-derived-value-",
    nodeKind: "results.derived_scalars",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
    entityFromSuffix: true,
  },
  {
    prefix: "res-plot-group-",
    nodeKind: "results.plot_group",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
    entityFromSuffix: true,
  },
  {
    prefix: "res-table-",
    nodeKind: "results.table",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
    entityFromSuffix: true,
  },
  {
    prefix: "res-export-",
    nodeKind: "results.export",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
    entityFromSuffix: true,
  },
  {
    prefix: "res-report-",
    nodeKind: "results.report",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
    entityFromSuffix: true,
  },
  {
    prefix: "res-",
    nodeKind: "results.root",
    domain: "results",
    scope: "readonly",
    sourceOfTruth: "backend_live",
    entityFromSuffix: true,
  },
];

// ---------------------------------------------------------------------------
// Study stage node resolution
// ---------------------------------------------------------------------------

function isStudyStageNodeId(id: string): boolean {
  return (
    id.startsWith("study-stage-node:")
    || id.startsWith("study-stage-flat:")
    || id.startsWith("study-stage-")
    || id.startsWith("study-macro-")
    || id.startsWith("study-group-")
  );
}

function resolveStudyStageHandle(id: string): NodeHandle | null {
  const detailKindMap: Record<string, NodeKind> = {
    overview: "study.stage.detail.overview",
    solver: "study.stage.detail.solver",
    "time-range": "study.stage.detail.time_range",
    "stop-criteria": "study.stage.detail.stop_criteria",
    equilibrium: "study.stage.detail.equilibrium",
    operator: "study.stage.detail.operator",
    sweep: "study.stage.detail.sweep",
    settle: "study.stage.detail.settle",
    outputs: "study.stage.detail.outputs",
    materialized: "study.stage.detail.materialized",
  };

  const studyContext = parseStudyNodeContext(id);
  if (studyContext?.kind === "study-stage") {
    const parentId =
      studyContext.source === "pipeline"
        ? `study-stage-node:${studyContext.stageKey}`
        : `study-stage-flat:${studyContext.stageKey}`;
    if (studyContext.detail) {
      const nodeKind = detailKindMap[studyContext.detail];
      if (nodeKind) {
        return {
          id,
          nodeKind,
          domain: "study",
          scope: "solver_affecting",
          sourceOfTruth: "study_pipeline",
          parentId,
          entityId: studyContext.detail,
        };
      }
    }
    return {
      id,
      nodeKind: "study.stage.run",
      domain: "study",
      scope: "solver_affecting",
      sourceOfTruth: "study_pipeline",
      entityId: studyContext.stageKey,
    };
  }

  if (id.startsWith("study-group-")) {
    return {
      id,
      nodeKind: "study.group",
      domain: "study",
      scope: "solver_affecting",
      sourceOfTruth: "study_pipeline",
      entityId: id.replace("study-group-", ""),
    };
  }

  if (id.startsWith("study-macro-")) {
    return {
      id,
      nodeKind: "study.macro.hysteresis_loop", // refined downstream if needed
      domain: "study",
      scope: "solver_affecting",
      sourceOfTruth: "study_pipeline",
      entityId: id.replace("study-macro-", ""),
    };
  }

  if (id.startsWith("study-stage-")) {
    return {
      id,
      nodeKind: "study.stage.run", // refined downstream if needed
      domain: "study",
      scope: "solver_affecting",
      sourceOfTruth: "study_pipeline",
      entityId: id.replace("study-stage-", ""),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Texture / mesh suffix refinement for reg- and geo- nodes
// ---------------------------------------------------------------------------

function refineMagnetizationHandle(id: string, base: NodeHandle): NodeHandle {
  if (id.endsWith("-transform-translate")) {
    return {
      ...base,
      nodeKind: "object.initial_state.texture_transform.translate",
    };
  }
  if (id.endsWith("-transform-rotate")) {
    return {
      ...base,
      nodeKind: "object.initial_state.texture_transform.rotate",
    };
  }
  if (id.endsWith("-transform-scale")) {
    return {
      ...base,
      nodeKind: "object.initial_state.texture_transform.scale",
    };
  }
  if (id.endsWith("-transform")) {
    return { ...base, nodeKind: "object.initial_state.texture_transform" };
  }
  if (id.endsWith("-kind")) {
    return { ...base, nodeKind: "object.initial_state.texture" };
  }
  return base;
}

function refineRegionHandle(id: string, base: NodeHandle): NodeHandle {
  if (id.endsWith("-texture-transform-translate")) {
    return {
      ...base,
      nodeKind: "object.initial_state.texture_transform.translate",
    };
  }
  if (id.endsWith("-texture-transform-rotate")) {
    return {
      ...base,
      nodeKind: "object.initial_state.texture_transform.rotate",
    };
  }
  if (id.endsWith("-texture-transform-scale")) {
    return {
      ...base,
      nodeKind: "object.initial_state.texture_transform.scale",
    };
  }
  if (id.endsWith("-texture-transform")) {
    return { ...base, nodeKind: "object.initial_state.texture_transform" };
  }
  if (id.endsWith("-texture")) {
    return { ...base, nodeKind: "object.initial_state.texture" };
  }
  return base;
}

function refineGeometryHandle(id: string, base: NodeHandle): NodeHandle {
  if (id.includes("-mesh")) {
    return { ...base, nodeKind: "object.geometry.mesh", scope: "mesh_affecting" };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a raw node id into a fully typed NodeHandle.
 *
 * This is the single canonical function replacing all `nodeId.startsWith(...)`
 * conditionals. Every component that needs to know the semantic class of a
 * node should call this instead of pattern-matching on the string.
 */
export function resolveNodeHandle(nodeId: string): NodeHandle {
  // 1. Exact match in static table
  const staticEntry = STATIC_NODES[nodeId];
  if (staticEntry) {
    return { id: nodeId, ...staticEntry };
  }

  // 2. Study stage nodes (special structure with / separator)
  if (isStudyStageNodeId(nodeId)) {
    const studyHandle = resolveStudyStageHandle(nodeId);
    if (studyHandle) return studyHandle;
  }

  // 3. Prefix rules (longest-prefix-first order)
  for (const rule of PREFIX_RULES) {
    if (nodeId.startsWith(rule.prefix)) {
      const base: NodeHandle = {
        id: nodeId,
        nodeKind: rule.nodeKind,
        domain: rule.domain,
        scope: rule.scope,
        sourceOfTruth: rule.sourceOfTruth,
        entityId: rule.entityFromSuffix ? nodeId.slice(rule.prefix.length) : undefined,
      };

      // Apply refinements based on suffix patterns
      if (rule.prefix === "mag-") return refineMagnetizationHandle(nodeId, base);
      if (rule.prefix === "reg-") return refineRegionHandle(nodeId, base);
      if (rule.prefix === "geo-") return refineGeometryHandle(nodeId, base);

      return base;
    }
  }

  // 4. Fallback — treat as geometry
  return {
    id: nodeId,
    nodeKind: "object.geometry",
    domain: "build",
    scope: "solver_affecting",
    sourceOfTruth: "scene_document",
  };
}

/**
 * Check if a node kind starts with a given domain prefix.
 * E.g. `isNodeKindInDomain("physics.exchange", "physics")` → true
 */
export function isNodeKindInDomain(nodeKind: NodeKind, domain: string): boolean {
  return nodeKind.startsWith(domain + ".");
}

/**
 * Extract the top-level domain from a node kind.
 * E.g. `nodeKindTopDomain("physics.exchange")` → "physics"
 */
export function nodeKindTopDomain(nodeKind: NodeKind): string {
  return nodeKind.split(".")[0];
}
