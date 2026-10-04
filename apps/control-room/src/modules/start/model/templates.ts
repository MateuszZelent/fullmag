import { TEMPLATE_SCRIPTS } from "./templateScripts";
import type { ComputeProbeState, SolverKind } from "./types";

export interface TemplateEstimate {
  /** Wall-clock minutes on the reference GPU (RTX 4090, 24 GB). */
  readonly gpuMinutes: number;
  readonly vramGb: number;
  /** Wall-clock minutes on the reference CPU run, at `CPU_REFERENCE_THREADS`. */
  readonly cpuMinutes: number;
}

export interface StudyTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly solver: SolverKind;
  readonly estimate: TemplateEstimate;
  /** What the study reproduces, so a result can be checked against it. */
  readonly reference: string;
  /** The documentation page that explains it, relative to the docs root. */
  readonly docsPage: string;
  readonly model: readonly { readonly label: string; readonly value: string }[];
}

export const CPU_REFERENCE_THREADS = 32;

/**
 * The canonical Python for a template, or null when none was validated. A
 * template without a script stays visible but cannot be created or saved.
 */
export function templateScript(template: StudyTemplate): string | null {
  return Object.hasOwn(TEMPLATE_SCRIPTS, template.id) ? TEMPLATE_SCRIPTS[template.id] : null;
}

/** The file name a template's script is saved under. */
export const templateScriptFileName = (template: StudyTemplate): string => `${template.id}.py`;

/**
 * The shipped set. Descriptions follow the design spec; estimates are
 * calibrated on the reference machine and rescaled to the detected one by
 * `estimateFor`, so they are indications, not promises.
 */
export const STUDY_TEMPLATES: readonly StudyTemplate[] = [
  {
    id: "umag-sp1",
    name: "µMAG Standard Problem #1",
    description:
      "Hysteresis of a 1 × 2 µm Permalloy rectangle. The canonical first check that a solver build is sane.",
    solver: "FDM",
    estimate: { gpuMinutes: 2, vramGb: 0.4, cpuMinutes: 25 },
    reference: "µMAG Standard Problem #1 (NIST), hysteresis loop of a thin Permalloy rectangle.",
    docsPage: "validation/mumag-standard-problems.html",
    model: [
      { label: "Geometry", value: "1 × 2 µm × 20 nm rectangle" },
      { label: "Material", value: "Permalloy" },
    ],
  },
  {
    id: "umag-sp4",
    name: "µMAG Standard Problem #4",
    description:
      "Field-driven switching of a 500 × 125 × 3 nm Py strip; compare ⟨m⟩ zero crossing against the reference.",
    solver: "FDM",
    estimate: { gpuMinutes: 1, vramGb: 0.3, cpuMinutes: 12 },
    reference: "µMAG Standard Problem #4 (NIST), dynamic switching of a Permalloy strip.",
    docsPage: "validation/mumag-standard-problems.html",
    model: [
      { label: "Geometry", value: "500 × 125 × 3 nm strip" },
      { label: "Material", value: "Permalloy" },
    ],
  },
  {
    id: "spin-wave-dispersion",
    name: "Spin-wave dispersion",
    description:
      "Sinc-excited YIG waveguide with a space-time FFT of m_y; gives ω(k) maps directly in the results viewer.",
    solver: "FDM",
    estimate: { gpuMinutes: 25, vramGb: 6, cpuMinutes: 420 },
    reference: "Magnetostatic spin-wave dispersion of a YIG waveguide.",
    docsPage: "python-api/outputs/dispersion-and-response.html",
    model: [
      { label: "Material", value: "YIG" },
      { label: "Excitation", value: "sinc, fc = 20 GHz" },
    ],
  },
  {
    id: "magnonic-crystal-bands",
    name: "Magnonic crystal bands",
    description:
      "Bloch-periodic eigenmode study of a 1D two-material stripe lattice along Γ–X–Γ; band edges and gaps are read from the dispersion.",
    solver: "FEM",
    estimate: { gpuMinutes: 90, vramGb: 10, cpuMinutes: 120 },
    reference: "Band structure of a one-dimensional magnonic crystal.",
    docsPage: "python-api/boundary-conditions/floquet-boundary-conditions.html",
    model: [
      { label: "Study", value: "Bloch-periodic eigenmodes" },
      { label: "Demag", value: "not included" },
    ],
  },
  {
    id: "skyrmion-phase-diagram",
    name: "Skyrmion phase diagram",
    description:
      "Relaxation series over the out-of-plane field at fixed interfacial DMI, with topological-charge tracking. Re-run at another D to add a row of the diagram.",
    solver: "FDM",
    estimate: { gpuMinutes: 60, vramGb: 8, cpuMinutes: 900 },
    reference: "Phase diagram of interfacial-DMI skyrmions in a thin film.",
    docsPage: "physics/interactions/dmi/interfacial.html",
    model: [{ label: "Sweep", value: "B_z series at fixed D" }],
  },
  {
    id: "broadband-fmr",
    name: "Broadband FMR",
    description:
      "Field-stepped linear response: relaxes the film at each bias field and solves the susceptibility tensor over a frequency list.",
    solver: "FDM",
    estimate: { gpuMinutes: 20, vramGb: 4, cpuMinutes: 300 },
    reference: "Field-swept ferromagnetic resonance absorption map.",
    docsPage: "python-api/studies/frequency-response.html",
    model: [{ label: "Study", value: "bias-field steps, susceptibility" }],
  },
  {
    id: "domain-wall-motion",
    name: "Domain-wall motion",
    description:
      "Current-driven wall propagation with Zhang-Li STT and an absorbing boundary at the strip ends.",
    solver: "FDM",
    estimate: { gpuMinutes: 35, vramGb: 5, cpuMinutes: 520 },
    reference: "Current-driven domain-wall motion in a nanostrip (Zhang-Li).",
    docsPage: "python-api/interactions/spin-transfer-torque.html",
    model: [{ label: "Drive", value: "Zhang-Li spin-transfer torque" }],
  },
  {
    id: "vortex-gyration",
    name: "Vortex gyration",
    description:
      "Field-pulse excitation of a Py disc; ⟨m⟩(t) after the pulse gives the gyration frequency.",
    solver: "FEM",
    estimate: { gpuMinutes: 45, vramGb: 7, cpuMinutes: 240 },
    reference: "Gyrotropic mode of a magnetic vortex in a Permalloy disc.",
    docsPage: "python-api/studies/eigenmodes.html",
    model: [
      { label: "Geometry", value: "Py disc" },
      { label: "Excitation", value: "field pulse" },
    ],
  },
];

export interface EstimateLabel {
  readonly text: string;
  readonly basis: "gpu" | "cpu" | "reference";
  /** Why the figure reads the way it does, for a tooltip. */
  readonly note: string;
}

function duration(minutes: number): string {
  if (minutes < 90) return `~${Math.max(1, Math.round(minutes))} min`;
  const hours = minutes / 60;
  return `~${hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours)} h`;
}

const vram = (gb: number) => `${gb % 1 === 0 ? gb : gb.toFixed(1)} GB VRAM`;

/**
 * Calibrate against the detected device so the same card reads "~25 min · 6 GB
 * VRAM" on a GPU host and "~7 h · CPU ×32" on a machine without one. A probe
 * that has not answered, or cannot, falls back to the reference figures and says so.
 */
export function estimateFor(template: StudyTemplate, compute: ComputeProbeState): EstimateLabel {
  const { gpuMinutes, vramGb, cpuMinutes } = template.estimate;
  if (!compute || (compute.gpus.length === 0 &&
    (compute.gpuProbeStatus === "unavailable" || compute.cpuThreads < 1))) {
    return {
      text: `${duration(gpuMinutes)} · ${vram(vramGb)}`,
      basis: "reference",
      note: compute
        ? "Reference figure on an RTX 4090; GPU availability on this host has not been confirmed."
        : "Reference figure on an RTX 4090; this machine has not been probed.",
    };
  }
  const gpu = compute.gpus[0];
  const fits = gpu !== undefined && gpu.vramTotalBytes >= vramGb * 1e9;
  if (gpu && fits) {
    return {
      text: `${duration(gpuMinutes)} · ${vram(vramGb)}`,
      basis: "gpu",
      note: `Estimated for ${gpu.name}.`,
    };
  }
  const threads = Math.max(1, compute.cpuThreads);
  const scaled = (cpuMinutes * CPU_REFERENCE_THREADS) / threads;
  return {
    text: `${duration(scaled)} · CPU ×${threads}`,
    basis: "cpu",
    note: gpu
      ? `${gpu.name} has less than the ${vram(vramGb)} this study needs, so the CPU figure is shown.`
      : "No GPU was detected, so the CPU figure is shown.",
  };
}
