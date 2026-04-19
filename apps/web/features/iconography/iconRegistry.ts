/**
 * @module iconography/iconRegistry
 *
 * Centralised icon-token registry for the entire node tree.
 *
 * Every NodeKind maps to a stable IconToken.  Components that render
 * icons import `iconForNodeKind()` instead of sprinkling emoji literals.
 *
 * The icon values are Lucide icon names (https://lucide.dev/icons);
 * the rendering layer converts tokens to <LucideIcon /> components.
 * This decouples the registry from a specific icon library.
 */

import type { NodeKind } from "../model-builder/types";

// ---------------------------------------------------------------------------
// IconToken — a stable, semantic name for an icon
// ---------------------------------------------------------------------------

/**
 * Icon tokens map 1:1 to lucide-react icon names.
 * When a custom SVG is required, prefix with "custom:" — the renderer
 * falls back to a <CustomIcon /> component.
 */
export type IconToken =
  // Session & Script
  | "link"
  | "file-code-2"
  // Universe
  | "box"
  | "frame"
  | "ruler"
  | "move"
  | "crosshair"
  | "globe"
  | "fence"
  | "settings"
  // Objects & Geometry
  | "package"
  | "cube"
  | "diamond"
  | "circle"
  | "pentagon"
  | "hexagon"
  | "combine"
  | "scissors"
  | "merge"
  | "layers"
  | "component"
  // Materials
  | "palette"
  | "atom"
  // Physics
  | "zap"
  | "activity"
  | "magnet"
  | "arrow-right"
  | "square"
  | "thermometer"
  | "refresh-cw"
  | "git-branch"
  | "repeat"
  // Antennas
  | "radio"
  | "waves"
  | "signal"
  // Mesh
  | "grid-3x3"
  | "sliders-horizontal"
  | "gauge"
  | "eye"
  | "compass"
  | "workflow"
  // Study
  | "play"
  | "flask-conical"
  | "puzzle"
  | "circle-dot"
  | "file-text"
  | "wrench"
  | "timer"
  | "target"
  | "chevrons-up-down"
  | "save"
  | "brick-wall"
  // Results
  | "bar-chart-3"
  | "line-chart"
  | "table-2"
  | "database"
  | "brain"
  | "pin"
  | "folder-open"
  | "sigma"
  | "audio-waveform"
  | "orbit"
  | "spiral"
  // Visualization
  | "paintbrush"
  | "sliders"
  // Diagnostics
  | "shield-check"
  // Fallback
  | "help-circle";

// ---------------------------------------------------------------------------
// Icon variant — state-dependent rendering hints
// ---------------------------------------------------------------------------

export type IconVariant = "default" | "active" | "muted" | "warning" | "error" | "derived";

// ---------------------------------------------------------------------------
// Registry entry
// ---------------------------------------------------------------------------

export interface IconRegistryEntry {
  /** Lucide icon name */
  token: IconToken;
  /** Accessible label for screen readers */
  label: string;
  /** Default variant */
  defaultVariant?: IconVariant;
}

// ---------------------------------------------------------------------------
// Master mapping: NodeKind → IconRegistryEntry
// ---------------------------------------------------------------------------

const ICON_REGISTRY: Record<NodeKind, IconRegistryEntry> = {
  // Session
  "session.root":                          { token: "link",              label: "Session" },
  "session.script-builder":                { token: "file-code-2",      label: "Script Builder" },

  // Universe
  "universe.root":                         { token: "box",              label: "Universe" },
  "universe.domain":                       { token: "frame",            label: "Domain Frame" },
  "universe.domain.size":                  { token: "ruler",            label: "Domain Size" },
  "universe.domain.center":                { token: "crosshair",        label: "Domain Center" },
  "universe.domain.padding":               { token: "move",             label: "Domain Padding" },
  "universe.airbox":                       { token: "globe",            label: "Airbox" },
  "universe.airbox.sizing":                { token: "ruler",            label: "Airbox Sizing" },
  "universe.boundary":                     { token: "fence",            label: "Outer Boundary" },
  "universe.mesh":                         { token: "grid-3x3",        label: "Study Domain Mesh" },
  "universe.mesh.view":                    { token: "eye",              label: "Mesh Inspector" },
  "universe.mesh.pipeline":                { token: "workflow",         label: "Mesh Pipeline" },
  "universe.mesh.algorithm":               { token: "settings",         label: "Mesh Algorithm" },
  "universe.mesh.size":                    { token: "ruler",            label: "Mesh Size" },
  "universe.mesh.quality":                 { token: "gauge",            label: "Mesh Quality" },
  "universe.role":                         { token: "settings",         label: "Universe Role" },

  // Objects & Geometry
  "objects.root":                          { token: "package",          label: "Objects" },
  "object.root":                           { token: "cube",             label: "Object" },
  "object.geometry":                       { token: "diamond",          label: "Geometry" },
  "object.geometry.mesh":                  { token: "grid-3x3",        label: "Object Mesh" },
  "object.material":                       { token: "atom",             label: "Magnetic Parameters" },
  "object.material.properties":            { token: "sliders",          label: "Magnetic Parameters" },
  "object.initial_state":                  { token: "compass",          label: "Magnetic Texture" },
  "object.initial_state.texture":          { token: "paintbrush",       label: "Texture" },
  "object.initial_state.texture_transform": { token: "move",            label: "Texture Transform" },
  "object.initial_state.texture_transform.translate": { token: "move",   label: "Texture Translate" },
  "object.initial_state.texture_transform.rotate": { token: "refresh-cw", label: "Texture Rotate" },
  "object.initial_state.texture_transform.scale": { token: "ruler",      label: "Texture Scale" },
  "object.regions":                        { token: "layers",           label: "Regions" },
  "object.region":                         { token: "component",        label: "Region" },
  "object.mesh":                           { token: "grid-3x3",        label: "Object Mesh" },

  // Materials
  "materials.root":                        { token: "palette",          label: "Materials" },
  "material.entry":                        { token: "atom",             label: "Material" },

  // Physics
  "physics.root":                          { token: "zap",              label: "Physics" },
  "physics.solver":                        { token: "wrench",           label: "Solver" },
  "physics.llg":                           { token: "activity",         label: "LLG Dynamics" },
  "physics.exchange":                      { token: "repeat",           label: "Exchange" },
  "physics.demag":                         { token: "magnet",           label: "Demagnetization" },
  "physics.demag.method":                  { token: "settings",         label: "Demag Method" },
  "physics.zeeman":                        { token: "arrow-right",      label: "External Field (Zeeman)" },
  "physics.boundary_conditions":           { token: "square",           label: "Boundary Conditions" },
  "physics.thermal_noise":                 { token: "thermometer",      label: "Thermal Noise" },
  "physics.spin_torque":                   { token: "refresh-cw",       label: "Spin Torque" },
  "physics.dmi":                           { token: "git-branch",       label: "DMI" },
  "physics.anisotropy":                    { token: "diamond",          label: "Anisotropy" },
  "physics.interaction":                   { token: "zap",              label: "Physics Interaction" },

  // Antennas
  "antennas.root":                         { token: "radio",            label: "Antennas / RF" },
  "antenna.cpw":                           { token: "waves",            label: "CPW Antenna" },
  "antenna.microstrip":                    { token: "signal",           label: "Microstrip Antenna" },
  "antenna.excitation_analysis":           { token: "bar-chart-3",      label: "Excitation Analysis" },

  // Mesh (global)
  "mesh.root":                             { token: "grid-3x3",        label: "Mesh" },
  "mesh.size":                             { token: "ruler",            label: "Mesh Size" },
  "mesh.algorithm":                        { token: "settings",         label: "Mesh Algorithm" },
  "mesh.quality":                          { token: "gauge",            label: "Mesh Quality" },
  "mesh.inspector":                        { token: "eye",              label: "Mesh Inspector" },
  "mesh.pipeline":                         { token: "workflow",         label: "Mesh Pipeline" },

  // Study
  "study.root":                            { token: "play",             label: "Study" },
  "study.pipeline.root":                   { token: "workflow",         label: "Study Pipeline" },
  "study.stage.relax":                     { token: "circle-dot",       label: "Relax" },
  "study.stage.run":                       { token: "play",             label: "Run" },
  "study.stage.eigenmodes":                { token: "audio-waveform",   label: "Eigensolve" },
  "study.stage.set_field":                 { token: "arrow-right",      label: "Set Field" },
  "study.stage.set_current":               { token: "zap",              label: "Set Current" },
  "study.stage.save_state":                { token: "save",             label: "Save State" },
  "study.stage.load_state":                { token: "folder-open",      label: "Load State" },
  "study.stage.export":                    { token: "save",             label: "Export" },
  "study.macro.hysteresis_loop":           { token: "flask-conical",    label: "Hysteresis Loop" },
  "study.macro.field_sweep_relax":         { token: "flask-conical",    label: "Field Sweep + Relax" },
  "study.macro.field_sweep_relax_snapshot": { token: "flask-conical",   label: "Field Sweep + Snapshot" },
  "study.macro.relax_run":                 { token: "flask-conical",    label: "Relax → Run" },
  "study.macro.relax_eigenmodes":          { token: "flask-conical",    label: "Relax → Eigensolve" },
  "study.macro.parameter_sweep":           { token: "flask-conical",    label: "Parameter Sweep" },
  "study.macro.current_sweep_run":         { token: "flask-conical",    label: "Current Sweep + Run" },
  "study.macro.dc_bias_plus_rf_probe":     { token: "flask-conical",    label: "DC Bias + RF Probe" },
  "study.group":                           { token: "puzzle",           label: "Stage Group" },
  "study.stage.detail.overview":           { token: "file-text",        label: "Overview" },
  "study.stage.detail.solver":             { token: "wrench",           label: "Solver" },
  "study.stage.detail.time_range":         { token: "timer",            label: "Time Range" },
  "study.stage.detail.stop_criteria":      { token: "target",           label: "Stop Criteria" },
  "study.stage.detail.equilibrium":        { token: "magnet",           label: "Equilibrium" },
  "study.stage.detail.operator":           { token: "audio-waveform",   label: "Operator & Spectrum" },
  "study.stage.detail.sweep":              { token: "chevrons-up-down", label: "Sweep Definition" },
  "study.stage.detail.settle":             { token: "magnet",           label: "Settle Stage" },
  "study.stage.detail.outputs":            { token: "save",             label: "Outputs" },
  "study.stage.detail.materialized":       { token: "brick-wall",       label: "Materialized Preview" },

  // Runtime
  "session.runtime":                       { token: "settings",         label: "Runtime & Backend" },

  // Results
  "results.root":                          { token: "bar-chart-3",      label: "Results" },
  "results.fields":                        { token: "folder-open",      label: "Field Quantities" },
  "results.energy":                        { token: "zap",              label: "Energy" },
  "results.state_io":                      { token: "save",             label: "State I/O" },
  "results.export":                        { token: "save",             label: "Export" },
  "results.solution":                      { token: "layers",           label: "Solution" },
  "results.dataset":                       { token: "database",         label: "Dataset" },
  "results.analysis":                      { token: "brain",            label: "Analysis" },
  "results.analysis.pinned":               { token: "pin",              label: "Pinned Analysis" },
  "results.field_quantity":                { token: "activity",         label: "Field Quantity" },
  "results.derived_scalars":               { token: "sigma",            label: "Derived Scalars" },
  "results.time_trace":                    { token: "line-chart",       label: "Time Trace" },
  "results.eigen_spectrum":                { token: "audio-waveform",   label: "Eigen Spectrum" },
  "results.eigen_dispersion":              { token: "audio-waveform",   label: "Eigen Dispersion" },
  "results.eigenmodes":                    { token: "audio-waveform",   label: "Eigenmodes" },
  "results.eigenmode":                     { token: "circle-dot",       label: "Eigenmode" },
  "results.overview":                      { token: "compass",          label: "Overview" },
  "results.plot_group":                    { token: "line-chart",       label: "Plot Group" },
  "results.table":                         { token: "table-2",          label: "Table" },
  "results.report":                        { token: "file-text",        label: "Report" },
  "results.vortex":                        { token: "orbit",            label: "Vortex / STNO" },

  // Visualization
  "visualization.root":                    { token: "paintbrush",       label: "Visualization" },
  "visualization.preset.project":          { token: "sliders",          label: "Project Preset" },
  "visualization.preset.local":            { token: "sliders",          label: "Local Preset" },

  // Diagnostics
  "diagnostics.root":                      { token: "shield-check",     label: "Diagnostics" },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up the icon token for a given NodeKind.
 * Falls back to "help-circle" for unknown kinds.
 */
export function iconForNodeKind(nodeKind: NodeKind): IconRegistryEntry {
  return ICON_REGISTRY[nodeKind] ?? { token: "help-circle", label: nodeKind };
}

/**
 * Convenience: look up icon token directly from raw nodeId.
 * Uses the NodeHandleResolver under the hood.
 */
export { resolveNodeHandle } from "../model-builder/registry/nodeHandleResolver";

/**
 * Return the full registry (for iteration, e.g. in Storybook).
 */
export function allIconEntries(): ReadonlyArray<[NodeKind, IconRegistryEntry]> {
  return Object.entries(ICON_REGISTRY) as Array<[NodeKind, IconRegistryEntry]>;
}
