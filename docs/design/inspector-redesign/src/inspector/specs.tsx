import {
  Activity, ArrowUpRight, Box, Boxes, Brush, Compass, Cpu, Database, Eye, EyeOff,
  Gauge, Grid3x3, History, Layers, Link2, Magnet, Palette, Play, Ruler, Scan, Scissors, Sigma, Square,
  SquareDashed, Tag, Timer, Waves, Workflow, Zap, Radar, FileOutput, Table2, CircleDot,
} from "lucide-react"

import { fmt, minus, sci, thin } from "@/lib/format"
import type { Draft, Spec } from "./types"
import { QTY, cmapGradient } from "./constants"
export { STAGES, QTY, cmapGradient } from "./constants"
import {
  BuildHistory, ColormapBar, JsonButton, MaterialLibrary, PipelineStrip, RegionsTable,
  SincChart, TelemetryChart, TexturePreview,
} from "./custom"

export const UNITS = {
  Apm: [["A/m", 1], ["kA/m", 1e3], ["MA/m", 1e6]] as [string, number][],
  Jpm: [["J/m", 1], ["pJ/m", 1e-12]] as [string, number][],
  Apm2: [["A/m²", 1], ["MA/cm²", 1e10]] as [string, number][],
  T: [["T", 1], ["mT", 1e-3]] as [string, number][],
  Hz: [["Hz", 1], ["GHz", 1e9]] as [string, number][],
  s: [["s", 1], ["ns", 1e-9], ["ps", 1e-12]] as [string, number][],
}

const positive = (v: number) => (v > 0 ? null : "Must be greater than 0.")
const edges = (v: number[]) => (v.some((x) => !(x > 0)) ? "Every edge must be longer than 0 nm." : null)
const unitNote = (label: string) => (v: number[]): ["ok" | "warn", string] => {
  const n = Math.hypot(...v)
  if (!(n > 0)) return ["warn", `${label} cannot be the zero vector.`]
  return Math.abs(n - 1) < 1e-9 ? ["ok", "Unit vector"] : ["warn", `Normalized on apply, |v| = ${fmt(n)}`]
}
export function gridShape(d: Draft) {
  const size = d.dmode === "Manual" ? d.size : [1600, 800, 1.7]
  return (size as number[]).map((s, i) => Math.max(1, Math.round(s / (d.cell[i] || 1))))
}

export const SPECS: Record<string, Spec> = {
  object: {
    id: "object", domain: "geometry", icon: Box, kind: "Magnetic object", idv: "film", before: "before/object.webp",
    path: ["Model", "Objects", "film"], mode: "staged", rename: "name",
    title: (d) => d.name,
    state: () => ({ tone: "ok", label: "Ready" }),
    facts: (d) => [
      { label: "Shape", value: "Box" },
      { label: "Material", value: d.material },
      { label: "Size", value: `${d.size.map(fmt).join(" × ")} nm` },
      { label: "Grid", value: "512 × 256 × 1" },
    ],
    tabs: [["props", "Properties"], ["display", "Display"]],
    sections: [
      { id: "identity", tab: "props", title: "Identity", icon: Tag, summary: (d) => (d.notes ? "Has notes" : "No notes"), rows: [
        { k: "name", type: "text", label: "Name", value: "film", validate: (v) => (v.trim() ? null : "Give the object a name.") },
        { k: "notes", type: "area", label: "Notes", value: "", placeholder: "Add a note for collaborators", wide: true },
        { k: "role", type: "ro", label: "Role", value: "Magnet" },
      ] },
      { id: "geom", tab: "props", title: "Geometry", icon: Ruler, summary: (d) => `Box, ${d.size.map(fmt).join(" × ")} nm`, rows: [
        { k: "shape", type: "ro", label: "Shape", value: "Box" },
        { k: "size", type: "vec", label: "Size", unit: "nm", value: [1600, 800, 1.7], validate: edges },
        { k: "center", type: "vec", label: "Center", unit: "nm", value: [0, 0, 0] },
      ] },
      { id: "assign", tab: "props", title: "Assignment", icon: Link2, summary: (d) => `${d.material}, region ${d.region}`, rows: [
        { k: "material", type: "select", label: "Material", value: "film material", options: [["film material", "film material"]] },
        { k: "region", type: "select", label: "Region", value: "film", options: [["film", "film"]] },
        { k: "texture", type: "ro", label: "Initial state", value: "Uniform, m = (1, 0, 0)" },
      ] },
      { id: "colors", tab: "display", live: true, title: "Viewport colors", icon: Palette, summary: (d) => `${d.opacity}% opacity`, rows: [
        { k: "color", type: "color", label: "Surface", value: "blue" },
        { k: "frame", type: "color", label: "Frame", value: "overlay" },
        { k: "opacity", type: "range", label: "Opacity", value: 100, min: 10, max: 100, step: 5, suffix: "%" },
        { k: "visible", type: "switch", label: "Show in viewport", value: true },
      ] },
    ],
    details: [["Object ID", "film", true], ["Scene revision", "1"], ["Mesh policy", "Execution-plan owned, read-only"]],
  },

  material: {
    id: "material", domain: "material", icon: Magnet, kind: "Material", idv: "mat:film", before: "before/material.webp",
    path: ["Model", "Objects", "film", "Magnetic parameters"], mode: "staged",
    title: () => "film material",
    state: () => ({ tone: "ok", label: "Committed" }),
    facts: (d) => [
      { label: <span className="sym">M<sub>s</sub></span>, value: `${fmt(d.ms / 1e3)} kA/m` },
      { label: <span className="sym">A<sub>ex</sub></span>, value: <>{sci(d.aex)} J/m</> },
      { label: <span className="sym">α</span>, value: minus(fmt(d.alpha)) },
      { label: "Used by", value: "1 object" },
    ],
    sections: [
      { id: "core", title: "Magnetization and exchange", icon: Magnet, summary: (d) => `Ms ${fmt(d.ms / 1e3)} kA/m, α ${fmt(d.alpha)}`, rows: [
        { k: "ms", type: "num", label: "Saturation magnetization", sym: <>M<sub>s</sub></>, value: 521000, units: UNITS.Apm, unit0: "kA/m", scrub: "log", validate: positive,
          symInfo: { name: "Saturation magnetization", definition: "Magnetic moment per unit volume when all spins are aligned. Sets the length of m in LLG and the strength of the demagnetizing field.", unit: "A/m", range: "Permalloy ≈ 800 kA/m, YIG ≈ 140 kA/m" } },
        { k: "aex", type: "num", label: "Exchange stiffness", sym: <>A<sub>ex</sub></>, value: 1.5e-11, units: UNITS.Jpm, unit0: "pJ/m", scrub: "log", validate: positive,
          symInfo: { name: "Exchange stiffness", definition: "Energy cost of bending the magnetization. Together with Ms it sets the exchange length √(2A/μ₀Ms²), which bounds the cell size.", unit: "J/m", range: "Typically 3 to 30 pJ/m" } },
        { k: "alpha", type: "num", label: "Gilbert damping", sym: <>α</>, value: 0.045, step: 0.001,
          validate: (v) => (v >= 0 && v <= 1 ? null : "Damping must be between 0 and 1."),
          symInfo: { name: "Gilbert damping", definition: "Dimensionless rate at which precession relaxes toward the effective field.", unit: "dimensionless", range: "YIG ≈ 1e−4, metals 0.005 to 0.05" } },
      ] },
      { id: "absorb", title: "Absorbing boundary", icon: Waves, open: false, summary: (d) => (d.absorb ? `On, ${fmt(d.absorbW)} nm` : "Off"), rows: [
        { k: "absorb", type: "switch", label: "Damp object edges", value: false, structural: true, hint: "Raises damping near the edges so spin waves do not reflect." },
        { k: "absorbW", type: "num", label: "Layer width", value: 50, unitText: "nm", step: 1, when: (d) => d.absorb, validate: positive },
      ] },
      { id: "source", title: "Source", icon: Database, summary: () => "Defined in this model", rows: [
        { type: "ro", label: "Origin", value: "Defined in this model" },
        { type: "chips", label: "Used by", value: ["film"] },
      ], footer: (ctx) => <MaterialLibrary ctx={ctx} /> },
    ],
    details: [["Material ID", "mat:film", true], ["Mode", "Committed"], ["Scene fetch", "Ready"], ["Material fetch", "Ready"]],
  },

  texture: {
    id: "texture", domain: "material", icon: Compass, kind: "Initial magnetization", idv: "mag:film",
    path: ["Model", "Objects", "film", "Magnetic texture"], mode: "staged",
    title: () => "Magnetic texture",
    state: () => ({ tone: "ok", label: "Assigned" }),
    facts: (d) => [
      { label: "Preset", value: d.preset },
      { label: "Target", value: "film" },
      { label: "Direction", value: `(${d.dir.map((x: number) => minus(fmt(x))).join(", ")})` },
      { label: "Asset", value: "mag:film" },
    ],
    sections: [
      { id: "preview", title: "Preview", icon: Eye, summary: (d) => d.preset, rows: [
        { k: "previewRow", type: "custom", wide: true, render: ({ d }) => <TexturePreview d={d} /> },
      ] },
      { id: "preset", title: "Preset", icon: Brush, summary: (d) => d.preset, rows: [
        { k: "preset", type: "select", label: "Preset", value: "Uniform", structural: true, options: [["Uniform", "Uniform"], ["Vortex", "Vortex"], ["Néel skyrmion", "Néel skyrmion"], ["Random", "Random"]] },
        { k: "dir", type: "vec", label: "Direction", sym: <>m̂</>, value: [1, 0, 0], when: (d) => d.preset === "Uniform", note: unitNote("Direction"), validate: (v) => (Math.hypot(...v) > 0 ? null : "Direction cannot be the zero vector.") },
        { k: "chir", type: "seg", label: "Circulation", value: "CCW", options: [["CCW", "Counter-clockwise"], ["CW", "Clockwise"]], when: (d) => d.preset === "Vortex" },
        { k: "radius", type: "num", label: "Core radius", value: 20, unitText: "nm", when: (d) => d.preset !== "Uniform" && d.preset !== "Random", validate: positive },
        { k: "seed", type: "num", label: "Seed", value: 42, step: 1, when: (d) => d.preset === "Random" },
      ] },
      { id: "asset", title: "Asset", icon: Tag, open: false, summary: () => "mag:film", rows: [
        { k: "label", type: "text", label: "Label", value: "Uniform" },
        { type: "ro", label: "Magnetization ref", value: "mag:film", mono: true, copy: true },
      ] },
    ],
    details: [["Draft", "Clean"], ["State", "Object"], ["Target", "film"]],
  },

  viz: {
    id: "viz", domain: "visualization", icon: Scan, kind: "Object display", idv: "viz:film", before: "before/visualization.webp",
    path: ["Model", "Objects", "film", "Visualization"], mode: "live",
    title: () => "Visualization",
    state: () => ({ tone: "live", label: "Live" }),
    facts: (d) => [
      { label: "Data", value: "Not computed yet", tone: "warn" },
      { label: "Mesh", value: "Ready", tone: "ok" },
      { label: "Quantity", value: d.quantity === "m" ? "m" : d.quantity === "hd" ? "Hd" : "Heff" },
      { label: "Render", value: d.render },
    ],
    notices: (d) =>
      d.quantity === "m"
        ? [{ tone: "info", text: "Magnetization is computed during Run. Until then the viewport shows the initial texture." }]
        : [{ tone: "warn", text: `${QTY[d.quantity]} becomes available after Run. The viewport keeps the initial texture.`, action: { label: "Show magnetization", run: (api) => api.setVal("viz", "quantity", "m") } }],
    sections: [
      { id: "view", title: "View", icon: Eye, summary: (d) => `${d.view}, ${d.render}`, rows: [
        { k: "view", type: "seg", label: "Projection", value: "3D", options: [["3D", "3D"], ["2D", "2D"]] },
        { k: "render", type: "tiles", label: "Render mode", value: "Shaded", wide: true, options: [["Shaded", "Shaded", Box], ["Shaded + wire", "Shaded + wire", Boxes], ["Wireframe", "Wireframe", Square], ["Points", "Points", CircleDot], ["Off", "Off", EyeOff]] },
        { k: "overlays", type: "toggles", label: "Overlays", value: ["vectors"], options: [["bounds", "Bounds", SquareDashed], ["vectors", "Vectors", ArrowUpRight]] },
      ] },
      { id: "color", title: "Coloring", icon: Palette, summary: (d) => `${d.quantity}, ${d.comp} component`, rows: [
        { k: "quantity", type: "select", label: "Quantity", value: "m", options: [["m", "Magnetization m"], ["hd", "Demagnetization field, after Run"], ["heff", "Effective field, after Run"]] },
        { k: "comp", type: "seg", label: "Component", value: "z", options: [["x", "x"], ["y", "y"], ["z", "z"], ["|m|", "|m|"]] },
        { k: "cmap", type: "select", label: "Colormap", value: "div", options: [["div", "Diverging"], ["vir", "Viridis"], ["hue", "In-plane angle"]], swatch: (v) => cmapGradient(v) },
        { k: "cmapbar", type: "custom", label: "Scale", render: ({ d }) => <ColormapBar cmap={d.cmap} /> },
      ] },
      { id: "vectors", title: "Vector glyphs", icon: ArrowUpRight, open: false, summary: (d) => (d.overlays.includes("vectors") ? `Every ${d.density} cells` : "Hidden"), rows: [
        { k: "density", type: "range", label: "Spacing", value: 4, min: 2, max: 8, step: 1, suffix: " cells" },
        { k: "vscale", type: "range", label: "Length", value: 100, min: 40, max: 180, step: 10, suffix: "%" },
      ] },
      { id: "clip", title: "Clipping", icon: Scissors, open: false, summary: (d) => (d.plane === "Off" ? "Off" : `${d.plane} at ${d.clipAt}%`), rows: [
        { k: "plane", type: "seg", label: "Plane", value: "Off", options: [["Off", "Off"], ["X", "X"], ["Y", "Y"]], structural: true },
        { k: "clipAt", type: "range", label: "Position", value: 50, min: 0, max: 100, step: 1, suffix: "%", when: (d) => d.plane !== "Off" },
      ] },
    ],
    details: [["Target", "film"], ["Carrier", "Structured-grid cells"], ["Quantity source", "Initial texture"]],
  },

  torque: {
    id: "torque", domain: "physics", icon: Zap, kind: "Transport torque", idv: "spin_hall_pulse", before: "before/torque.webp",
    path: ["Model", "film", "Physics", "Spin torque"], mode: "staged",
    title: (d) => d.tid,
    state: () => ({ tone: "warn", label: "Lane unresolved" }),
    facts: (d) => [
      { label: "Model", value: d.model },
      { label: <span className="sym">J</span>, value: <>{sci(d.j)} A/m²</> },
      { label: <span className="sym">ξ<sub>DL</sub></span>, value: minus(fmt(d.xidl)) },
      { label: "Scope", value: "Object" },
    ],
    notices: () => [{ tone: "warn", text: "The execution lane is unresolved, so solver support for this torque has not been checked yet.", action: { label: "Open Relax 2", run: (api) => api.select("stage") } }],
    sections: [
      { id: "model", title: "Model", icon: Zap, summary: (d) => d.model, rows: [
        { k: "model", type: "select", label: "Torque model", value: "Prescribed SOT", options: [["Prescribed SOT", "Prescribed SOT"], ["Slonczewski STT", "Slonczewski STT"], ["Zhang–Li STT", "Zhang–Li STT"]] },
        { k: "tid", type: "text", label: "Torque ID", mono: true, value: "spin_hall_pulse", validate: (v) => (/^[a-z0-9_]+$/.test(v) ? null : "Use lowercase letters, digits and underscores.") },
      ] },
      { id: "drive", title: "Drive", icon: Activity, summary: (d) => `${d.dkind}, J ${fmt(d.j)} A/m²`, rows: [
        { k: "dkind", type: "seg", label: "Drive kind", value: "Signed scalar", options: [["Constant", "Constant"], ["Signed scalar", "Signed scalar"]] },
        { k: "j", type: "num", label: "Current density", sym: <>J</>, value: 2.6e10, units: UNITS.Apm2, unit0: "A/m²", scrub: "log",
          symInfo: { name: "Charge current density", definition: "Current through the heavy-metal layer. The spin Hall effect converts it into a spin current that exerts torque on m.", unit: "A/m²", range: "10¹⁰ to 10¹² A/m² in SOT devices" } },
        { k: "sigma", type: "vec", label: "Spin polarization", sym: <>σ̂</>, value: [0, 1, 0], note: unitNote("Polarization"), validate: (v) => (Math.hypot(...v) > 0 ? null : "Polarization cannot be the zero vector.") },
        { type: "chips", label: "Switched by", value: ["Set Spin Torque 1", "Set Spin Torque 9"] },
      ] },
      { id: "eff", title: "Torque efficiencies", icon: Sigma, summary: (d) => `ξDL ${minus(fmt(d.xidl))}, ξFL ${minus(fmt(d.xifl))}`, rows: [
        { k: "xidl", type: "num", label: "Damping-like", sym: <>ξ<sub>DL</sub></>, value: -0.21, step: 0.01,
          symInfo: { name: "Damping-like efficiency", definition: "Effective spin Hall angle of the damping-like torque term. The sign follows the heavy metal (Pt positive, Ta and W negative).", unit: "dimensionless" } },
        { k: "xifl", type: "num", label: "Field-like", sym: <>ξ<sub>FL</sub></>, value: 0, step: 0.01 },
      ], footer: ({ d, api }) => <JsonButton api={api} d={d} /> },
    ],
    details: [["Source", "spin_hall_pulse", true], ["Lane", "Unresolved"], ["Status", "Active"]],
  },

  zeeman: {
    id: "zeeman", domain: "physics", icon: Radar, kind: "Physics module", idv: "field:external:global", before: "before/physics.webp",
    path: ["Model", "Global physics", "External field"], mode: "staged",
    title: () => "External magnetic field",
    state: () => ({ tone: "warn", label: "Lane unresolved" }),
    facts: (d) => [
      { label: "Scope", value: "Global" },
      { label: <span className="sym">B<sub>0</sub></span>, value: `${fmt(Math.hypot(...d.b))} mT` },
      { label: "Profile", value: d.profile },
      { label: "Status", value: "Active", tone: "ok" },
    ],
    sections: [
      { id: "amp", title: "Field", icon: Compass, summary: (d) => `(${d.b.map(fmt).join(", ")}) mT`, rows: [
        { k: "b", type: "vec", label: "Amplitude", sym: <>B<sub>0</sub></>, unit: "mT", value: [0, 0, 5] },
        { k: "profile", type: "seg", label: "Time profile", value: "Sinc pulse", structural: true, options: [["Constant", "Constant"], ["Sinc pulse", "Sinc"], ["Sine", "Sine"]] },
        { k: "fc", type: "num", label: "Cutoff frequency", sym: <>f<sub>c</sub></>, value: 10e9, units: UNITS.Hz, unit0: "GHz", scrub: "log", when: (d) => d.profile !== "Constant", validate: positive },
        { k: "t0", type: "num", label: "Delay", sym: <>t<sub>0</sub></>, value: 0.5e-9, units: UNITS.s, unit0: "ns", when: (d) => d.profile === "Sinc pulse" },
        { k: "chart", type: "custom", label: "", wide: true, when: (d) => d.profile !== "Constant", render: ({ d }) => <SincChart d={d} /> },
      ] },
      { id: "scope", title: "Scope", icon: Layers, open: false, summary: () => "All magnetic objects", rows: [
        { type: "chips", label: "Applies to", value: ["film"] },
        { type: "ro", label: "Source", value: "field:external:global", mono: true, copy: true },
      ] },
    ],
    details: [["Module", "Zeeman"], ["Lane", "Unresolved"], ["Dependency", "Active"]],
  },

  airbox: {
    id: "airbox", domain: "mesh", icon: Layers, kind: "Universe domain", idv: "airbox", before: "before/airbox.webp",
    path: ["Model", "Universe", "Airbox"], mode: "staged",
    title: () => "Airbox",
    state: () => ({ tone: "ok", label: "Ready" }),
    facts: (d) => [
      { label: "Sizing", value: d.dmode },
      { label: "Grid", value: gridShape(d).join(" × ") },
      { label: "Cells", value: thin(gridShape(d).reduce((a, b) => a * b, 1)) },
      { label: "Cell", value: `${d.cell.map(fmt).join(" × ")} nm` },
    ],
    notices: () => [{ tone: "info", text: "Applying a new size or cell rebuilds the FDM grid." }],
    confirmApply: { title: "Rebuild the FDM grid?", text: "The grid is rebuilt from the new domain. Field data from earlier runs stays in the session history.", action: "Rebuild and apply" },
    sections: [
      { id: "domain", title: "Domain", icon: Layers, summary: (d) => (d.dmode === "Manual" ? `${d.size.map(fmt).join(" × ")} nm` : `Padding ${d.pad.map(fmt).join(", ")} nm`), rows: [
        { k: "dmode", type: "seg", label: "Sizing", value: "Manual", options: [["Auto", "Auto"], ["Manual", "Manual"]], structural: true },
        { k: "pad", type: "vec", label: "Padding", unit: "nm", value: [0, 0, 0], when: (d) => d.dmode === "Auto", hint: "Space added around all objects." },
        { k: "size", type: "vec", label: "Size", unit: "nm", value: [1600, 800, 1.7], when: (d) => d.dmode === "Manual", validate: edges },
      ] },
      { id: "grid", title: "FDM grid", icon: Grid3x3, summary: (d) => `${gridShape(d).join(" × ")} cells`, rows: [
        { k: "cell", type: "vec", label: "Cell size", unit: "nm", value: [3.125, 3.125, 1.7], validate: edges },
        { k: "shape", type: "ro", label: "Grid shape", get: (d) => gridShape(d).join(" × ") },
        { k: "cells", type: "ro", label: "Total cells", get: (d) => thin(gridShape(d).reduce((a, b) => a * b, 1)) },
      ] },
    ],
    details: [["Policy revision", "1"], ["Policy scope", "Structured-grid universe geometry"], ["Grid fingerprint", "90cfe128…ebcd7ae67f", true], ["Script sync", "Round-trips to Python"]],
  },

  mesh: {
    id: "mesh", domain: "mesh", icon: Grid3x3, kind: "Object mesh policy", idv: "mesh:film",
    path: ["Model", "Objects", "film", "Mesh"], mode: "staged",
    title: () => "Mesh",
    state: () => ({ tone: "ok", label: "Ready" }),
    facts: () => [
      { label: "Lane", value: "FDM" },
      { label: "Grid", value: "512 × 256 × 1" },
      { label: "Cells", value: thin(131072) },
      { label: "Outside support", value: "0" },
    ],
    tabs: [["policy", "Policy"], ["regions", "Regions"], ["history", "History"]],
    headerAction: { label: "Re-voxelize", icon: Grid3x3, confirm: { title: "Re-voxelize film?", text: "Fullmag builds the structured grid again from the current geometry. The current realization is kept as a rollback.", action: "Re-voxelize" } },
    sections: [
      { id: "policy", tab: "policy", title: "Realization", icon: Grid3x3, summary: () => "Structured-grid cells", rows: [
        { type: "ro", label: "Policy", value: "Execution-plan owned, read-only" },
        { type: "ro", label: "Scope", value: "Selected object, magnetic support" },
        { type: "ro", label: "Origin", value: "(−800, −400, −0.85) nm" },
        { type: "ro", label: "Spacing", value: "3.125 × 3.125 × 1.7 nm" },
        { type: "ro", label: "Participation", value: "131 072 active, 0 outside support" },
        { type: "ro", label: "Fingerprint", value: "90cfe12878a3889e61eaacd323ce8bceb5c7b49…", mono: true, copy: true },
      ] },
      { id: "regions", tab: "regions", title: "Regions", icon: Table2, summary: () => "2 regions", rows: [
        { k: "regionsTable", type: "custom", wide: true, render: () => <RegionsTable /> },
      ] },
      { id: "history", tab: "history", title: "Builds", icon: History, summary: () => "1 build", rows: [
        { k: "buildList", type: "custom", wide: true, render: () => <BuildHistory /> },
      ] },
    ],
    details: [["Mesh revision", "1"], ["Realization", "Structured-grid cells"]],
  },

  monitor: {
    id: "monitor", domain: "definition", icon: Scan, kind: "Planar monitor", idv: "monitor:mid_plane",
    path: ["Model", "Definitions", "Planar monitors", "mid_plane"], mode: "staged",
    title: (d) => d.mname,
    state: () => ({ tone: "neutral", label: "Draft" }),
    facts: (d) => [
      { label: "Plane", value: d.plane },
      { label: "Quantity", value: QTY[d.q] ?? d.q },
      { label: "Every", value: `${fmt(d.every / 1e-12)} ps` },
      { label: "Output", value: d.out },
    ],
    sections: [
      { id: "where", title: "Placement", icon: Scan, summary: (d) => `${d.plane} at ${fmt(d.pos)} nm`, rows: [
        { k: "mname", type: "text", label: "Name", value: "mid_plane", mono: true, validate: (v) => (/^[a-z0-9_]+$/.test(v) ? null : "Use lowercase letters, digits and underscores.") },
        { k: "plane", type: "seg", label: "Plane", value: "XY", options: [["XY", "XY"], ["XZ", "XZ"], ["YZ", "YZ"]] },
        { k: "pos", type: "num", label: "Offset", value: 0, unitText: "nm", step: 0.1, hint: "Distance from the film center along the plane normal." },
      ] },
      { id: "what", title: "Sampling", icon: Timer, summary: (d) => `${QTY[d.q] ?? d.q}, every ${fmt(d.every / 1e-12)} ps`, rows: [
        { k: "q", type: "select", label: "Quantity", value: "m", options: [["m", "Magnetization m"], ["heff", "Effective field"], ["hd", "Demagnetization field"]] },
        { k: "every", type: "num", label: "Interval", value: 10e-12, units: UNITS.s, unit0: "ps", validate: positive },
        { k: "out", type: "seg", label: "Output", value: "OVF", options: [["OVF", "OVF"], ["NPY", "NPY"], ["VTK", "VTK"]] },
      ] },
    ],
    details: [["Monitor ID", "monitor:mid_plane", true], ["Storage", "Session results"]],
  },

  stage: {
    id: "stage", domain: "study", icon: Play, kind: "Relaxation stage", idv: "initial_relaxation", before: "before/stage.webp",
    path: ["Study", "Stages", "Relax 2"], mode: "staged",
    title: () => "Relax 2",
    state: (d) => (d.device === "Auto" ? { tone: "err", label: "2 issues" } : { tone: "neutral", label: "Queued" }),
    facts: (d) => [
      { label: "Position", value: "2 of 10" },
      { label: "Method", value: d.algo },
      { label: "Device", value: d.device, tone: d.device === "Auto" ? "err" : undefined },
      { label: "Revision", value: "8" },
    ],
    tabs: [["setup", "Setup"], ["telemetry", "Telemetry"]],
    notices: (d) =>
      d.device === "Auto"
        ? [
            { tone: "err", title: "Device required", text: "Adaptive FDM execution requires an explicit CPU device.", action: { label: "Use CPU", run: (api) => api.setVal("stage", "device", "CPU") } },
            { tone: "err", title: "Lane unresolved", text: "Operation support cannot be checked until the device is chosen.", action: { label: "Show device", run: (api) => api.focusRow("device"), ghost: true } },
          ]
        : [],
    sections: [
      { id: "pipe", tab: "setup", title: "Pipeline", icon: Workflow, summary: (d) => (d.include ? "Included, stage 2 of 10" : "Skipped"), rows: [
        { k: "pipeline", type: "custom", wide: true, render: () => <PipelineStrip current={1} /> },
        { k: "include", type: "switch", label: "Include in study", value: true },
      ] },
      { id: "algo", tab: "setup", title: "Algorithm", icon: Gauge, summary: (d) => `${d.algo}, tol ${fmt(d.tol)}`, rows: [
        { k: "algo", type: "select", label: "Method", value: "LLG overdamped", options: [["LLG overdamped", "LLG overdamped"], ["Steepest descent", "Steepest descent"], ["Conjugate gradient", "Conjugate gradient"]] },
        { k: "tol", type: "num", label: "Stop at max torque", value: 1e-4, scrub: "log", validate: positive },
        { k: "steps", type: "num", label: "Step limit", value: 50000, step: 1000, validate: (v) => (Number.isInteger(v) && v > 0 ? null : "Use a whole number above 0.") },
      ] },
      { id: "exec", tab: "setup", title: "Execution", icon: Cpu, summary: (d) => `FDM on ${d.device}`, rows: [
        { k: "device", type: "seg", label: "Device", value: "Auto", options: [["Auto", "Auto"], ["CPU", "CPU"], ["GPU", "GPU"]], serverError: (d) => (d.device === "Auto" ? "Adaptive FDM needs CPU or GPU chosen explicitly." : null) },
        { type: "ro", label: "Backend", value: "FDM" },
        { type: "ro", label: "Stage ID", value: "initial_relaxation", mono: true, copy: true },
      ] },
      { id: "tele", tab: "telemetry", title: "Convergence", icon: Activity, rows: [], empty: { title: "No telemetry yet", text: "Max torque and energy are charted here while Relax 2 runs.", icon: Activity } },
    ],
    details: [["Pipeline group", "Top level"], ["Execution revision", "8"], ["Effective", "Enabled"]],
  },

  view3d: {
    id: "view3d", domain: "visualization", icon: Eye, kind: "Viewport settings", idv: "viewport-3d",
    path: ["Workspace", "3D viewport"], mode: "live",
    title: () => "3D View",
    state: () => ({ tone: "live", label: "Live" }),
    facts: (d) => [
      { label: "Camera", value: d.proj },
      { label: "Rotation", value: d.rot },
      { label: "Quality", value: d.quality },
      { label: "Renderer", value: "WebGL", tone: "ok" },
    ],
    sections: [
      { id: "camera", title: "Camera", icon: Compass, summary: (d) => `${d.proj}, ${d.rot}`, rows: [
        { k: "proj", type: "seg", label: "Projection", value: "Perspective", options: [["Perspective", "Perspective"], ["Orthographic", "Ortho"]] },
        { k: "rot", type: "seg", label: "Rotation mode", value: "Object orbit", options: [["Free camera", "Free"], ["Object orbit", "Orbit"]] },
        { k: "fov", type: "range", label: "Field of view", value: 40, min: 15, max: 75, step: 5, suffix: "°", when: (d) => d.proj === "Perspective" },
      ] },
      { id: "scene", title: "Scene", icon: Layers, summary: (d) => [d.grid && "grid", d.axes && "axes"].filter(Boolean).join(", ") || "Bare", rows: [
        { k: "grid", type: "switch", label: "Ground grid", value: true },
        { k: "axes", type: "switch", label: "Axis triad", value: true },
        { k: "glow", type: "switch", label: "Selection glow", value: true },
      ] },
      { id: "quality", title: "Quality", icon: Gauge, summary: (d) => d.quality, rows: [
        { k: "quality", type: "seg", label: "Profile", value: "Balanced", options: [["Lite", "Lite"], ["Interactive", "Interactive"], ["Balanced", "Balanced"], ["Figure", "Figure"]] },
      ] },
    ],
    details: [["Renderer", "WebGL 2"], ["Display samples", "131 072"], ["Origin", "Frame center"]],
  },

  run: {
    id: "run", domain: "study", icon: Play, kind: "Time evolution stage", idv: "run_4",
    path: ["Study", "Stages", "Run 4"], mode: "staged",
    title: () => "Run 4",
    state: () => ({ tone: "live", label: "Running" }),
    facts: (d) => [
      { label: "Sim time", value: "7.65 ns" },
      { label: "Solver", value: "LLG + RK23" },
      { label: "Duration", value: `${fmt(d.dur / 1e-9)} ns` },
      { label: "Device", value: "GPU" },
    ],
    tabs: [["telemetry", "Telemetry"], ["setup", "Setup"]],
    headerAction: { label: "Stop run", icon: Square, confirm: { title: "Stop Run 4?", text: "The solver stops at the next step. Results written so far stay in the session.", action: "Stop run" } },
    sections: [
      { id: "progress", tab: "telemetry", title: "Progress", icon: Timer, summary: () => "77% of 10 ns", rows: [
        { k: "telemetryChart", type: "custom", wide: true, render: () => <TelemetryChart /> },
      ] },
      { id: "time", tab: "setup", title: "Time", icon: Timer, summary: (d) => `${fmt(d.dur / 1e-9)} ns`, rows: [
        { k: "dur", type: "num", label: "Duration", value: 10e-9, units: UNITS.s, unit0: "ns", validate: positive },
        { type: "ro", label: "Integrator", value: "RK23, adaptive step" },
      ] },
      { id: "outputs", tab: "setup", title: "Outputs", icon: FileOutput, summary: () => "Table and snapshots", rows: [
        { k: "tableEvery", type: "num", label: "Table every", value: 10e-12, units: UNITS.s, unit0: "ps", validate: positive },
        { k: "snapEvery", type: "num", label: "Snapshot every", value: 100e-12, units: UNITS.s, unit0: "ps", validate: positive },
      ] },
    ],
    details: [["Stage ID", "run_4", true], ["Execution revision", "8"]],
  },
}

export type TreeNode = { label: string; level: number; target?: string; icon: typeof Box; group?: boolean }
export const TREE: TreeNode[] = [
  { label: "Definitions", level: 0, icon: Layers, group: true },
  { label: "mid_plane", level: 1, target: "monitor", icon: Scan },
  { label: "Universe", level: 0, icon: Layers, group: true },
  { label: "Airbox", level: 1, target: "airbox", icon: Layers },
  { label: "Objects", level: 0, icon: Boxes, group: true },
  { label: "film", level: 1, target: "object", icon: Box },
  { label: "Magnetic parameters", level: 2, target: "material", icon: Magnet },
  { label: "Magnetic texture", level: 2, target: "texture", icon: Compass },
  { label: "Mesh", level: 2, target: "mesh", icon: Grid3x3 },
  { label: "Visualization", level: 2, target: "viz", icon: Scan },
  { label: "spin_hall_pulse", level: 2, target: "torque", icon: Zap },
  { label: "Global physics", level: 0, icon: Radar, group: true },
  { label: "External field", level: 1, target: "zeeman", icon: Radar },
  { label: "Study", level: 0, icon: Workflow, group: true },
  { label: "Set Spin Torque 1", level: 1, icon: Zap },
  { label: "Relax 2", level: 1, target: "stage", icon: Play },
  { label: "Table Autosave 3", level: 1, icon: Table2 },
  { label: "Run 4", level: 1, target: "run", icon: Play },
]
