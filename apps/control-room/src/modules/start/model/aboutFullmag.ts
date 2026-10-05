/**
 * What the About page says about FullMag itself (spelled as the README spells it). Everything here is taken from
 * the repository's `readme.md` ("Overview", "Citation and authors", "License",
 * "Funding"); nothing is added. `aboutFullmag.test.ts` fails when the README and
 * this file disagree, so the two cannot drift apart unnoticed.
 */

export const FULLMAG_TAGLINE =
  "FDM and FEM micromagnetics with Python, CPU/CUDA solvers, and an interactive Control Room";

export const FULLMAG_OVERVIEW = [
  "FullMag is active research software for finite-difference (FDM) and finite-element (FEM) micromagnetics. A model can be authored through the stage-oriented Python API or the Control Room, lowered to the canonical ProblemIR, checked against backend capabilities, and executed as an ordered study. The runtime records requested and resolved execution settings together with solver diagnostics and scientific artifacts.",
  "FullMag combines structured and conforming discretizations, CPU and CUDA implementations, time-domain dynamics, direct relaxation, hysteresis, FEM eigenmodes, driven frequency response, and interactive 2D/3D analysis in one workflow.",
] as const;

export interface FullmagEngine {
  readonly name: string;
  readonly bestFor: string;
}

export const FULLMAG_ENGINES: readonly FullmagEngine[] = [
  {
    name: "FDM",
    bestFor:
      "Regular films, nanowires, racetracks, disks, pillars, periodic cells, repeated time integration, and disconnected multilayers",
  },
  {
    name: "FEM",
    bestFor:
      "Curved or irregular 3D bodies, conforming multi-region structures, local refinement, magnetic-plus-air domains, and modal or driven-response studies",
  },
];

export interface FullmagAuthor {
  readonly name: string;
  readonly affiliation: string;
}

export const FULLMAG_AUTHORS: readonly FullmagAuthor[] = [
  {
    name: "Dr Mateusz Zelent",
    affiliation:
      "Fachbereich Physik and Landesforschungszentrum OPTIMAS, RPTU Kaiserslautern-Landau, Germany",
  },
  {
    name: "Dr Mateusz Gołebiewski",
    affiliation: "Faculty of Physics and Astronomy, Adam Mickiewicz University, Poznań, Poland",
  },
  {
    name: "Prof. Philipp Pirro",
    affiliation:
      "Fachbereich Physik and Landesforschungszentrum OPTIMAS, RPTU Kaiserslautern-Landau, Germany",
  },
];

export const FULLMAG_COORDINATION = "Mateusz Zelent, RPTU Kaiserslautern-Landau";

export const FULLMAG_CITATION_NOTE =
  "Until a versioned release with a persistent identifier is available, cite the repository and the exact commit used for the reported result";

export const FULLMAG_CITATION =
  "M. Zelent, M. Gołebiewski, and P. Pirro, FullMag: a computational framework for reproducible finite-difference and finite-element micromagnetics, research software, 2026.";

export const FULLMAG_BIBTEX = `@software{fullmag_2026,
  author = {Zelent, Mateusz and Gołebiewski, Mateusz and Pirro, Philipp},
  title  = {FullMag: A Computational Framework for Reproducible
            Finite-Difference and Finite-Element Micromagnetics},
  year   = {2026},
  url    = {https://github.com/MateuszZelent/fullmag},
  note   = {Research software; cite the exact release or commit used}
}`;

export const FULLMAG_REPOSITORY_URL = "https://github.com/MateuszZelent/fullmag";

export const FULLMAG_LICENSE =
  "The repository does not currently contain a root-level license file. Contact the project coordinator before reuse or redistribution.";

export const FULLMAG_FUNDING =
  "Mateusz Zelent acknowledges funding from the European Union's Horizon Europe programme under HORIZON-MSCA-2024-PF-01, Marie Skłodowska-Curie Grant Agreement No. 101208951 (CNMA).";

/* ── Rich structured extensions derived from the repository README ────────── */

export const FULLMAG_DOCS_URL = "https://fullmag.mzelent.pl/";
export const FULLMAG_CONTROL_ROOM_URL = "https://fullmag.mzelent.pl/frontend/control-room/index.html";
export const FULLMAG_PYTHON_API_URL = "https://fullmag.mzelent.pl/python-api/index.html";
export const FULLMAG_PHYSICS_URL = "https://fullmag.mzelent.pl/physics/index.html";
export const FULLMAG_NUMERICAL_URL = "https://fullmag.mzelent.pl/numerical-methods/index.html";
export const FULLMAG_CAPABILITY_MATRIX_URL = "https://fullmag.mzelent.pl/docs/specs/capability-matrix-v0.md";

export interface ExtendedAuthor extends FullmagAuthor {
  readonly role: string;
  readonly title: string;
  readonly fullName: string;
  readonly initials: string;
  readonly institution: string;
  readonly institutionShort: string;
  readonly department: string;
  readonly location: string;
  readonly isLead?: boolean;
  readonly focus: string;
  readonly grantBadge?: string;
}

export const FULLMAG_EXTENDED_AUTHORS: readonly ExtendedAuthor[] = [
  {
    name: "Dr Mateusz Zelent",
    fullName: "Mateusz Zelent",
    title: "Dr",
    initials: "MZ",
    role: "Project Coordinator & Lead Architect",
    institution: "RPTU Kaiserslautern-Landau",
    institutionShort: "RPTU",
    department: "Fachbereich Physik and Landesforschungszentrum OPTIMAS",
    location: "Kaiserslautern, Germany",
    affiliation:
      "Fachbereich Physik and Landesforschungszentrum OPTIMAS, RPTU Kaiserslautern-Landau, Germany",
    isLead: true,
    focus: "Computational micromagnetics, magnonics, FDM/FEM numerical solvers & GPU acceleration",
    grantBadge: "Horizon Europe MSCA Fellow",
  },
  {
    name: "Dr Mateusz Gołebiewski",
    fullName: "Mateusz Gołębiewski",
    title: "Dr",
    initials: "MG",
    role: "Co-Author & Numerical Architecture",
    institution: "Adam Mickiewicz University",
    institutionShort: "AMU Poznań",
    department: "Faculty of Physics and Astronomy",
    location: "Poznań, Poland",
    affiliation: "Faculty of Physics and Astronomy, Adam Mickiewicz University, Poznań, Poland",
    focus: "Theoretical physics, high-performance computing, mathematical modeling & GPU algorithms",
  },
  {
    name: "Prof. Philipp Pirro",
    fullName: "Philipp Pirro",
    title: "Prof.",
    initials: "PP",
    role: "Co-Author & Scientific Advisory",
    institution: "RPTU Kaiserslautern-Landau",
    institutionShort: "RPTU",
    department: "Fachbereich Physik and Landesforschungszentrum OPTIMAS",
    location: "Kaiserslautern, Germany",
    affiliation:
      "Fachbereich Physik and Landesforschungszentrum OPTIMAS, RPTU Kaiserslautern-Landau, Germany",
    focus: "Experimental & computational magnonics, spin waves, non-linear magnetization dynamics",
  },
];

export interface ExtendedEngine extends FullmagEngine {
  readonly id: "fdm" | "fem";
  readonly title: string;
  readonly subtitle: string;
  readonly badge: string;
  readonly accent: "fdm" | "fem";
  readonly discretization: string;
  readonly demagMethod: string;
  readonly cpuPath: string;
  readonly gpuPath: string;
  readonly boundaries: string;
  readonly features: readonly string[];
}

export const FULLMAG_EXTENDED_ENGINES: readonly ExtendedEngine[] = [
  {
    id: "fdm",
    name: "FDM",
    title: "Finite-Difference Method",
    subtitle: "Fast FFT-accelerated regular grid solver",
    badge: "Cartesian Grid",
    accent: "fdm",
    bestFor:
      "Regular films, nanowires, racetracks, disks, pillars, periodic cells, repeated time integration, and disconnected multilayers",
    discretization: "Cell-centred Cartesian grids",
    demagMethod: "Newell demagnetization tensors with zero-padded 3D FFTs",
    cpuPath: "Pure Rust & RustFFT high-performance CPU kernels",
    gpuPath: "C++17 / CUDA cuFFT convolution kernel acceleration",
    boundaries: "Explicit finite-image periodic boundary conditions (PBC)",
    features: [
      "Cell-centred Cartesian grids",
      "Newell demagnetization tensors with zero-padded FFTs",
      "Rust & RustFFT CPU execution path",
      "C++17 / CUDA / cuFFT GPU acceleration",
      "Finite-image PBC & multilayer contracts",
    ],
  },
  {
    id: "fem",
    name: "FEM",
    title: "Finite-Element Method",
    subtitle: "Conforming unstructured tetrahedral mesh solver",
    badge: "Conforming Mesh",
    accent: "fem",
    bestFor:
      "Curved or irregular 3D bodies, conforming multi-region structures, local refinement, magnetic-plus-air domains, and modal or driven-response studies",
    discretization: "Conforming Gmsh tetrahedral meshes",
    demagMethod: "Poisson Airbox domain & CPU BEM boundary formulations",
    cpuPath: "C++17 / MFEM / hypre / libCEED operator integration",
    gpuPath: "Bounded CUDA operator acceleration & libCEED device kernels",
    boundaries: "Conforming multi-region & Floquet periodic formulations",
    features: [
      "Gmsh conforming tetrahedral meshes",
      "C++17 / MFEM / hypre / libCEED numerical operators",
      "Poisson Airbox & CPU FEM/BEM demagnetization",
      "PETSc / SLEPc generalized eigenvalue solvers",
      "Complex linear driven frequency response",
    ],
  },
];

export interface ExecutionStage {
  readonly step: number;
  readonly title: string;
  readonly subtitle: string;
  readonly desc: string;
  readonly tag: string;
}

export const FULLMAG_PIPELINE_STAGES: readonly ExecutionStage[] = [
  {
    step: 1,
    title: "Authoring",
    subtitle: "Python DSL or Control Room",
    desc: "Stage-oriented Python API (fm.study) or interactive Control Room GUI with live 3D viewport.",
    tag: "Source",
  },
  {
    step: 2,
    title: "ProblemIR",
    subtitle: "Canonical Intermediate Form",
    desc: "Lowering to backend-neutral ProblemIR preserving SI units, geometry, materials and provenance.",
    tag: "Contract",
  },
  {
    step: 3,
    title: "Capability Planner",
    subtitle: "Validation & Mode Resolution",
    desc: "Checks mesh, physics and device legality in strict mode. Rejects unsupported options without silent fallback.",
    tag: "Safety",
  },
  {
    step: 4,
    title: "Session & Run",
    subtitle: "Ordered Stages & Checkpointing",
    desc: "Dispatches ordered stages with deterministic stopping criteria, live telemetry, and pause/resume.",
    tag: "Runtime",
  },
  {
    step: 5,
    title: "Solver Engines",
    subtitle: "FDM or FEM (CPU / GPU)",
    desc: "Executes on verified CPU (Rust/C++) or GPU (CUDA) lanes with explicit device residency.",
    tag: "Execution",
  },
  {
    step: 6,
    title: "Scientific Provenance",
    subtitle: "Fields, Diagnostics & Artifacts",
    desc: "Stores full observables, fields, solver diagnostics and reproducible seeds in canonical datasets.",
    tag: "Reproducibility",
  },
];

export const FULLMAG_EXECUTION_PIPELINE = FULLMAG_PIPELINE_STAGES;

export interface PhysicsModuleInfo {
  readonly title: string;
  readonly category: string;
  readonly description: string;
  readonly scope: string;
}

export const FULLMAG_PHYSICS_MODULES: readonly PhysicsModuleInfo[] = [
  {
    title: "Time-Domain Dynamics",
    category: "Dynamics",
    description: "Time integration of the Gilbert Landau–Lifshitz–Gilbert (LLG) equation.",
    scope: "Heun, RK4, RK23, RK45, and bounded lane-specific ABM3 / coupled paths.",
  },
  {
    title: "Direct Relaxation",
    category: "Statics",
    description: "Energy minimization and equilibrium state relaxation.",
    scope: "llg_overdamped, tangent projected-gradient Barzilai–Borwein, and Polak–Ribière+ NCG.",
  },
  {
    title: "Hysteresis Loops",
    category: "Sweeps",
    description: "Ordered external field schedules with deterministic stopping criteria.",
    scope: "Continuous field sweeping, relaxation stopping gates, and full artifact provenance.",
  },
  {
    title: "Eigenmodes & Dispersion",
    category: "Spectral",
    description: "Tangent-space linearized-LLG generalized eigenproblem analysis.",
    scope: "Public FEM spectral infrastructure with PETSc / SLEPc solver backends.",
  },
  {
    title: "Driven Frequency Response",
    category: "Dynamic",
    description: "Complex linear response around equilibrium magnetization.",
    scope: "Dense, sparse, Schur, modal, and GPU-oriented solver planner families (FEM).",
  },
  {
    title: "Physical Interactions",
    category: "Physics",
    description: "Comprehensive interaction modules with SI unit contracts.",
    scope: "Exchange, demagnetization, Zeeman, uniaxial/cubic anisotropy, DMI, thermal fields, STT/SOT, Oersted.",
  },
];

export interface ToolchainBadge {
  readonly name: string;
  readonly version: string;
  readonly category: "core" | "scientific" | "ui";
  readonly isAccent?: boolean;
}

export const FULLMAG_TOOLCHAIN_BADGES: readonly ToolchainBadge[] = [
  { name: "FullMag", version: "v0.1.0", category: "core", isAccent: true },
  { name: "Python", version: ">=3.10", category: "core" },
  { name: "Rust", version: "stable 2021", category: "core" },
  { name: "Node.js", version: "24.18.0", category: "core" },
  { name: "CUDA", version: "12.4.1", category: "scientific", isAccent: true },
  { name: "MFEM", version: "4.9", category: "scientific" },
  { name: "hypre", version: "3.1.0", category: "scientific" },
  { name: "libCEED", version: "0.12.0", category: "scientific" },
  { name: "Gmsh", version: ">=4.12", category: "scientific" },
  { name: "NumPy", version: ">=1.24", category: "scientific" },
  { name: "PyO3", version: "0.29", category: "scientific" },
  { name: "Next.js", version: "16.2.11", category: "ui" },
  { name: "React", version: "19.2.4", category: "ui" },
  { name: "TypeScript", version: "5.8.3", category: "ui" },
  { name: "Three.js", version: "^0.183.2", category: "ui" },
  { name: "ECharts", version: "^6.1.0", category: "ui" },
  { name: "Tauri", version: "2.11.1", category: "ui" },
];

export const FULLMAG_KEY_PILLARS = [
  {
    id: "solvers",
    value: "FDM & FEM",
    title: "Dual Solvers",
    desc: "Structured Cartesian grids and Gmsh conforming tetrahedral meshes.",
  },
  {
    id: "hardware",
    value: "CPU & CUDA",
    title: "Hardware Lanes",
    desc: "Rust & C++17 CPU paths with cuFFT & CUDA GPU acceleration.",
  },
  {
    id: "ir",
    value: "ProblemIR",
    title: "Unified IR",
    desc: "Backend-neutral canonical IR with SI units and explicit provenance.",
  },
  {
    id: "strict",
    value: "Zero Fallback",
    title: "Strict Capability",
    desc: "Execution lanes are planned and verified; no silent fallback to CPU.",
  },
] as const;

export const FULLMAG_GRANT_INFO = {
  fundingBody: "European Union",
  program: "Horizon Europe",
  scheme: "Marie Skłodowska-Curie Actions (MSCA)",
  call: "HORIZON-MSCA-2024-PF-01",
  grantNumber: "101208951",
  projectAcronym: "CNMA",
  fellow: "Dr Mateusz Zelent",
  host: "RPTU Kaiserslautern-Landau, Germany",
  statement: FULLMAG_FUNDING,
} as const;

