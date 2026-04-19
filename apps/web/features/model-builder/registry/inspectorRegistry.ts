/**
 * @module model-builder/registry/inspectorRegistry
 *
 * Maps NodeKind → Inspector panel descriptor.
 *
 * The SettingsPanel is the consumer: instead of a 24-branch if/else
 * cascade it calls `inspectorForNodeKind(handle)` and renders the
 * returned descriptor.
 *
 * Each entry carries:
 *  • panelKey   – a unique string used as React reconciliation key
 *  • component  – the lazy or eager React component to render
 *  • props      – a function that derives component props from context
 *  • composites – optional secondary panel (e.g. MeshSettingsPanel)
 */

import type { ComponentType } from "react";
import type { NodeKind, NodeHandle } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Props every inspector panel can receive. */
export interface InspectorPanelProps {
  nodeId: string;
}

/**
 * Context handed to the `props()` function so panels can derive
 * extra props without importing the world.
 */
export interface InspectorContext {
  nodeId: string;
  nodeHandle: NodeHandle;
  selectedObjectId?: string | null;
  selectedObjectNodeId?: string;
  selectedObjectMeshNodeId?: string;
}

/** Descriptor returned by the registry. */
export interface InspectorDescriptor {
  /** Unique key for the panel (used by React key). */
  panelKey: string;
  /** The primary panel component. */
  component: ComponentType<InspectorPanelProps> | ComponentType<Record<string, never>>;
  /** Derive runtime props for the primary component. */
  props: (ctx: InspectorContext) => Record<string, unknown>;
  /** Optional secondary (composite) panel keys. */
  compositeKeys?: string[];
  /** Optional info banner shown above the panel. */
  infoBanner?: string;
}

// ---------------------------------------------------------------------------
// Panel key constants (stable strings for React reconciliation)
// ---------------------------------------------------------------------------

export const PanelKey = {
  SESSION:             "session",
  SCRIPT_BUILDER:      "script-builder",
  RUNTIME:             "runtime",
  VIS_PRESET:          "vis-preset",
  STUDY:               "study",
  UNIVERSE:            "universe",
  MESH:                "mesh",
  MESH_SETTINGS:       "mesh-settings",
  MESH_INFO:           "mesh-info",
  ANTENNA:             "antenna",
  PHYSICS:             "physics",
  RESULTS:             "results",
  PREVIEW_CONTROLS:    "preview-controls",
  ENERGY:              "energy",
  STATE_IO:            "state-io",
  GEOMETRY:            "geometry",
  MATERIAL:            "material",
  MATERIAL_MAG:        "material-mag",
  OBJECT_MESH:         "object-mesh",
  REGION:              "region",
  OBJ_GEO_MESH:       "obj-geo-mesh",
  BUILDER_OVERVIEW:    "builder-overview",
  BUILDER_PRIMITIVE:   "builder-primitive",
  BUILDER_UNIVERSE:    "builder-universe",
} as const;

// ---------------------------------------------------------------------------
// Registry rules — ordered by specificity (most specific first)
// ---------------------------------------------------------------------------

/**
 * Each rule is [NodeKind | NodeKind[], panelKey, props-factory?, compositeKeys?, infoBanner?].
 *
 * For the simple cases the fourth+ args are optional.
 * Complex routing (e.g. composite panels) is encoded here once.
 */
interface RegistryRule {
  kinds: NodeKind[];
  panelKey: string;
  props: (ctx: InspectorContext) => Record<string, unknown>;
  compositeKeys?: string[];
  infoBanner?: string;
}

// ------------ helpers -------------------------------------------------------
const noProps = () => ({});
const passNodeId = (ctx: InspectorContext) => ({ nodeId: ctx.nodeId });

const MESH_INFO_BANNER_DEFAULTS =
  "These settings define shared object defaults for the next study-domain remesh. They do not create a third standalone mesh, and airbox sizing is still configured separately under Universe → Airbox.";

const MESH_INFO_BANNER_ALT =
  "These controls set shared object defaults for the final study-domain remesh. Use Universe → Airbox for air-region sizing and object nodes for local overrides.";

// ---------------------------------------------------------------------------
// Rule table
// ---------------------------------------------------------------------------
const RULES: RegistryRule[] = [
  // ── Session & Script ──
  {
    kinds: ["session.root"],
    panelKey: PanelKey.SESSION,
    props: noProps,
  },
  {
    kinds: ["session.script-builder"],
    panelKey: PanelKey.SCRIPT_BUILDER,
    props: noProps,
  },
  {
    kinds: ["session.runtime"],
    panelKey: PanelKey.RUNTIME,
    props: passNodeId,
  },

  // ── Visualization ──
  {
    kinds: [
      "visualization.root",
      "visualization.preset.project",
      "visualization.preset.local",
    ],
    panelKey: PanelKey.VIS_PRESET,
    props: passNodeId,
  },

  // ── Study (all study kinds go to StudyPanel) ──
  {
    kinds: [
      "study.root",
      "study.pipeline.root",
      "study.stage.relax",
      "study.stage.run",
      "study.stage.eigenmodes",
      "study.stage.set_field",
      "study.stage.set_current",
      "study.stage.save_state",
      "study.stage.load_state",
      "study.stage.export",
      "study.macro.hysteresis_loop",
      "study.macro.field_sweep_relax",
      "study.macro.field_sweep_relax_snapshot",
      "study.macro.relax_run",
      "study.macro.relax_eigenmodes",
      "study.macro.parameter_sweep",
      "study.macro.current_sweep_run",
      "study.macro.dc_bias_plus_rf_probe",
      "study.group",
      "study.stage.detail.overview",
      "study.stage.detail.solver",
      "study.stage.detail.time_range",
      "study.stage.detail.stop_criteria",
      "study.stage.detail.equilibrium",
      "study.stage.detail.operator",
      "study.stage.detail.sweep",
      "study.stage.detail.settle",
      "study.stage.detail.outputs",
      "study.stage.detail.materialized",
    ],
    panelKey: PanelKey.STUDY,
    props: passNodeId,
  },

  // ── Universe mesh (composite: MeshPanel + MeshSettingsPanel) ──
  {
    kinds: [
      "universe.mesh",
      "universe.mesh.view",
      "universe.mesh.pipeline",
      "universe.mesh.algorithm",
    ],
    panelKey: PanelKey.MESH,
    props: noProps,
    compositeKeys: [PanelKey.MESH_SETTINGS],
  },
  {
    kinds: ["universe.mesh.size", "universe.mesh.quality"],
    panelKey: PanelKey.MESH_INFO,
    props: noProps,
    compositeKeys: [PanelKey.MESH_SETTINGS],
    infoBanner: MESH_INFO_BANNER_DEFAULTS,
  },

  // ── Universe (everything else under universe) ──
  {
    kinds: [
      "universe.root",
      "universe.domain",
      "universe.domain.size",
      "universe.domain.center",
      "universe.domain.padding",
      "universe.airbox",
      "universe.airbox.sizing",
      "universe.boundary",
      "universe.role",
    ],
    panelKey: PanelKey.UNIVERSE,
    props: noProps,
  },

  // ── Global mesh (fallback) ──
  {
    kinds: ["mesh.size", "mesh.algorithm", "mesh.quality"],
    panelKey: PanelKey.MESH_INFO,
    props: noProps,
    compositeKeys: [PanelKey.MESH_SETTINGS],
    infoBanner: MESH_INFO_BANNER_ALT,
  },
  {
    kinds: ["mesh.root", "mesh.inspector", "mesh.pipeline"],
    panelKey: PanelKey.MESH,
    props: noProps,
    compositeKeys: [PanelKey.MESH_SETTINGS],
  },

  // ── Antennas ──
  {
    kinds: [
      "antennas.root",
      "antenna.cpw",
      "antenna.microstrip",
      "antenna.excitation_analysis",
    ],
    panelKey: PanelKey.ANTENNA,
    props: passNodeId,
  },

  // ── Physics ──
  {
    kinds: [
      "physics.root",
      "physics.solver",
      "physics.llg",
      "physics.exchange",
      "physics.demag",
      "physics.demag.method",
      "physics.zeeman",
      "physics.boundary_conditions",
      "physics.thermal_noise",
      "physics.spin_torque",
      "physics.dmi",
      "physics.anisotropy",
      "physics.interaction",
    ],
    panelKey: PanelKey.PHYSICS,
    props: passNodeId,
  },

  // ── Results ──
  {
    kinds: ["results.root", "results.fields", "results.overview", "results.plot_group", "results.table", "results.report", "results.vortex"],
    panelKey: PanelKey.RESULTS,
    props: noProps,
  },
  {
    kinds: ["results.energy"],
    panelKey: PanelKey.ENERGY,
    props: noProps,
  },
  {
    kinds: ["results.state_io", "results.export"],
    panelKey: PanelKey.STATE_IO,
    props: noProps,
  },
  {
    kinds: [
      "results.solution",
      "results.dataset",
      "results.analysis",
      "results.analysis.pinned",
      "results.field_quantity",
      "results.derived_scalars",
      "results.time_trace",
      "results.eigen_spectrum",
      "results.eigen_dispersion",
      "results.eigenmodes",
      "results.eigenmode",
    ],
    panelKey: PanelKey.RESULTS,
    props: noProps,
  },

  // ── Objects & Geometry ──
  {
    kinds: ["objects.root"],
    panelKey: PanelKey.GEOMETRY,
    props: noProps,
  },
  {
    kinds: ["object.material", "object.material.properties"],
    panelKey: PanelKey.MATERIAL,
    props: passNodeId,
  },
  {
    kinds: [
      "object.initial_state",
      "object.initial_state.texture",
      "object.initial_state.texture_transform",
      "object.initial_state.texture_transform.translate",
      "object.initial_state.texture_transform.rotate",
      "object.initial_state.texture_transform.scale",
    ],
    panelKey: PanelKey.MATERIAL_MAG,
    props: passNodeId,
  },
  {
    kinds: ["object.geometry.mesh", "object.mesh"],
    panelKey: PanelKey.OBJECT_MESH,
    props: passNodeId,
  },
  {
    kinds: ["object.region"],
    panelKey: PanelKey.REGION,
    props: passNodeId,
  },
  {
    kinds: ["object.root", "object.geometry", "object.regions"],
    panelKey: PanelKey.OBJ_GEO_MESH,
    props: (ctx: InspectorContext) => ({
      nodeId: ctx.selectedObjectNodeId ?? ctx.nodeId,
      meshNodeId: ctx.selectedObjectMeshNodeId,
    }),
  },

  // ── Materials ──
  {
    kinds: ["materials.root", "material.entry"],
    panelKey: PanelKey.MATERIAL,
    props: passNodeId,
  },

  // ── Diagnostics (fallback hint) ──
  {
    kinds: ["diagnostics.root"],
    panelKey: PanelKey.GEOMETRY,
    props: passNodeId,
  },

  // ── Geometry Builder ──
  {
    kinds: ["builder.root", "builder.primitives", "builder.lifecycle"],
    panelKey: PanelKey.BUILDER_OVERVIEW,
    props: noProps,
  },
  {
    kinds: ["builder.universe"],
    panelKey: PanelKey.BUILDER_UNIVERSE,
    props: noProps,
  },
  {
    kinds: [
      "builder.primitive",
      "builder.primitive.params",
      "builder.primitive.transform",
      "builder.primitive.material",
    ],
    panelKey: PanelKey.BUILDER_PRIMITIVE,
    props: passNodeId,
  },
];

// ---------------------------------------------------------------------------
// Build fast lookup: NodeKind → RegistryRule
// ---------------------------------------------------------------------------

const KIND_TO_RULE = new Map<NodeKind, RegistryRule>();
for (const rule of RULES) {
  for (const kind of rule.kinds) {
    if (!KIND_TO_RULE.has(kind)) {
      KIND_TO_RULE.set(kind, rule);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Given a NodeHandle (resolved via `resolveNodeHandle`), return the
 * descriptor for the inspector panel that should be rendered.
 *
 * Falls back to `PanelKey.GEOMETRY` for unknown kinds.
 */
export function inspectorForNodeKind(handle: NodeHandle): InspectorDescriptor {
  const rule = KIND_TO_RULE.get(handle.nodeKind);
  if (!rule) {
    // Fallback: render GeometryPanel
    return {
      panelKey: PanelKey.GEOMETRY,
      component: undefined as never, // The consumer must resolve by panelKey
      props: passNodeId,
    };
  }

  return {
    panelKey: rule.panelKey,
    component: undefined as never, // The consumer resolves by panelKey
    props: rule.props,
    compositeKeys: rule.compositeKeys,
    infoBanner: rule.infoBanner,
  };
}

/**
 * Check if a panelKey requires composite (secondary) panels.
 */
export function hasComposite(descriptor: InspectorDescriptor): boolean {
  return (descriptor.compositeKeys?.length ?? 0) > 0;
}
