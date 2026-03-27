# Fullmag agents guide

> **This file is the single source of truth for all AI models working on Fullmag**
> (Antigravity, Codex, Copilot, and any future model).
> All other instruction files (`.github/copilot-instructions.md`,
> `.github/instructions/*.md`) must reference this file and must not contradict it.

## North star

Fullmag describes a physical micromagnetic problem, not a numerical storage layout or a solver
implementation detail.
Every change must preserve that contract across Python API, UI flows, `ProblemIR`, planning,
session/run APIs, and backend execution.

## Product vision

Fullmag is one micromagnetics application with one semantic core and multiple user entrypoints.

The target user experience is:

1. a user can author a simulation in the embedded Python DSL,
2. a user can also configure the same simulation interactively in the browser control room,
3. both paths converge to the same canonical `ProblemIR`,
4. the same simulation can be launched headlessly, from the CLI, from notebooks, or with the live
   control room,
5. the UI can export a canonical, human-editable Python script for the configured simulation.

The browser is therefore not a secondary admin panel.
It is a first-class control room and authoring companion.

However, the only canonical public scripting artifact remains the embedded Python DSL in
`packages/fullmag-py`.
If the UI creates or edits a simulation, it must do so through the same canonical model and be able
to emit an equivalent Python representation.
No separate UI-only simulation semantics are allowed.

## Current strategic priority

The current top execution priority remains a calibrated GPU-first FDM/CUDA path.

That means:

1. CPU exchange-only FDM remains the trusted `double` reference.
2. CUDA FDM lands before FEM execution work resumes.
3. GPU `double` parity is required before GPU `single` becomes public-executable.
4. User-visible execution selection must become more explicit, not less explicit, as the stack
   grows.
5. The product shell must stay backend-neutral enough that CPU/GPU and FDM/FEM remain selectable
   realizations of one application contract, not separate products.

## Canonical instruction sources

- **`AGENTS.md` (this file)** is the canonical source of all project rules.
- `docs/specs/fullmag-application-architecture-v2.md` is the canonical application architecture
  document.
- `docs/specs/session-run-api-v1.md` is the canonical session/run runtime contract.
- `docs/specs/runtime-distribution-and-managed-backends-v1.md` is the canonical managed-runtime and
  packaging contract.
- `.agents/` contains agent workflows and skills that extend these rules.
- `.github/copilot-instructions.md` and `.github/instructions/` mirror a summary for Copilot.
- `docs/physics/TEMPLATE.md` is the only canonical template for publication-style physics notes.

## Golden rule: physics before implementation

This rule is non-negotiable.

Before implementing any physics or numerical feature, create or update a publication-style note in
`docs/physics/` covering:

1. problem statement and physical motivation,
2. governing equations, symbols, SI units, and assumptions,
3. FDM, FEM, GPU, CPU, and hybrid interpretation where relevant,
4. Python API and `ProblemIR` impact,
5. planner, capability-matrix, and runtime-selection impact,
6. validation strategy and observables,
7. completeness checklist across Python, UI, IR, planner, backend, and provenance layers,
8. known limits and deferred work.

If the note does not exist or is incomplete, the task is not ready for implementation.

## Canonical product contract

The following points are non-negotiable:

1. One physical model contract: shared semantics live above solver internals.
2. One canonical semantic representation: `ProblemIR`.
3. One public local launcher: `fullmag script.py`.
4. One runtime abstraction: sessions and runs.
5. One browser role: control room for live observability, launch flows, and authoring assistance.
6. One artifact and provenance model across backends.
7. One capability language across Python API, UI, planner, runner, and docs.
8. One round-trip rule: UI-authored simulations must be exportable as canonical Python DSL.

Round-trip drift between Python authoring, UI authoring, `ProblemIR`, planning, and provenance is a
product bug.

## Execution-selection rules

Execution choice must be easy for users and explicit in the architecture.

The user-level execution policy should be expressed in terms of:

- discretization target: `fdm` / `fem` / `auto` / later `hybrid`
- device target: `cpu` / `gpu` / `auto` when supported by the selected path
- execution mode: `strict` / `extended` / `hybrid`
- precision: `single` / `double`
- UI policy: headless / UI / auto

Rules:

1. Requested execution intent and resolved execution reality must be distinguishable.
2. Planning may resolve `auto` into a concrete backend/runtime, but it must not silently erase user
   intent.
3. If a requested path is unavailable, the system must surface that as a capability or planning
   outcome, not hide it behind undocumented fallback.
4. Public surfaces must never require users to understand CUDA image names, MFEM internals, C ABI
   details, or filesystem artifact quirks in order to choose execution.
5. If one surface cannot yet express an execution choice that another surface can express, treat
   that as product debt and close the gap rather than normalizing the mismatch.

## Architectural guardrails

1. The only canonical public scripting surface is the embedded Python DSL in `packages/fullmag-py`.
2. Python scripts and UI authoring flows must both lower to canonical `ProblemIR`; Rust validates,
   normalizes, and plans that IR.
3. The UI must not invent a second simulation-definition schema that bypasses Python and `ProblemIR`
   semantics.
4. UI-generated scripts must prefer canonical public API shapes and remain human-editable.
5. The shared API must never expose grid indices, raw GPU arrays, CUDA pointers, MFEM objects, or
   FEM-only implementation details.
6. `strict`, `extended`, and `hybrid` are first-class execution semantics from day one.
7. Rust remains the control plane: validation, normalization, capability checks, planning, session
   management, runner dispatch, API, provenance, and script export orchestration.
8. Native compute stays behind stable C ABI boundaries.
9. Backend-specific knobs are allowed only in explicit backend hint blocks or explicit `extended`
   mode, never as ambient leakage into the common model.
10. Managed runtimes are acceptable and expected for heavy backends; the launcher must still feel
    like one application.
11. `docs/physics/` notes are auto-rendered into frontend documentation, so physics docs are also
    user docs.
12. Containerized workflows remain the default verification path.
13. **No single source file should exceed ~1000 lines.** When a module grows past this threshold,
    split it into focused submodules. Monolithic files are harder to review, test, and maintain.

## Modularity rules

Performance work does not justify monolithic architecture.
CUDA-first execution and modular software design are both mandatory.

Rules:

1. Separate semantic layers from execution layers: Python/UI authoring, `ProblemIR`, planning,
   runtime/session control, and native execution must remain cleanly separated.
2. Separate backend policy from backend implementation: choosing `fdm`, `fem`, `cpu`, or `gpu`
   belongs to planning and runtime policy, not scattered ad-hoc across UI and solver code.
3. Separate operator modules from solver shells: new CUDA or FEM work should land as focused
   operators, kernels, planners, and adapters rather than enlarging god-files.
4. Separate packaging from semantics: managed runtime selection must not redefine the public problem
   model.
5. Separate observability from execution: browser views, artifacts, traces, and field transport are
   products of the session/run contract, not direct solver internals.

When in doubt, prefer more small, well-named modules with explicit boundaries over fewer large
files.

## Reference-solvers policy

`external_solvers/` contains full source trees of existing micromagnetic solvers.
These are **read-only references**.
Study them for workflow patterns, modular decomposition, validation approaches, and performance
architecture.
Never copy code verbatim.

Use them to learn the right lessons:

- **mumax3 / mumax+**: lightweight GPU-first FDM workflows, batch-plus-visual UX, Python ergonomics,
  operator layout, demag/FFT structure
- **BORIS**: modular multiphysics organization, CUDA library decomposition, large-scale GPU
  execution patterns
- **tetmag / tetrax**: FEM mesh and operator structure, Python-first FEM ergonomics, test and
  packaging patterns

Aim for:

- comparable computational seriousness,
- comparable workflow smoothness,
- better semantic consistency across Python, UI, and IR,
- better modularity than the older solver codebases.

## Canonical build and run entrypoints

- Prefer `justfile` recipes over ad-hoc `cargo`, `make`, and raw `docker compose` commands whenever
  a matching recipe exists.
- Treat these as the canonical build entrypoints:
  - `just build fullmag` — build/install the local launcher on the host
  - `just build fem-gpu-runtime-host` — build the heavy FEM GPU runtime in the managed container and
    export a host-usable runtime bundle
  - `just package fullmag` — assemble the host-side staging package
- Treat these as the canonical run entrypoints when applicable:
  - `just run ...`
  - `just run-py-layer-hole`
  - `just control-room`
- `make` remains a compatibility/developer fallback. Use it only when no `just` recipe exists yet
  or when explicitly debugging lower-level build stages.
- Raw `docker compose` and raw `cargo` commands are acceptable for debugging, narrow reproduction,
  or adding new recipes, but they should not be the default workflow recommended back to the user.

## Repo map

- `packages/fullmag-py` — public embedded Python DSL and runtime scaffolding.
- `crates/fullmag-ir` — typed canonical `ProblemIR`, validation, normalization, and planning
  summaries.
- `crates/fullmag-plan` — execution planner: lowers `ProblemIR` into backend-specific plans and
  runtime selection outcomes.
- `crates/fullmag-runner` — reference runner: executes planned simulations via native backends.
- `crates/fullmag-engine` — reference CPU solver for trusted baseline behavior.
- `crates/fullmag-cli` — CLI for IR validation, planning, script execution, and session launching.
- `crates/fullmag-api` — control-plane HTTP API.
- `crates/fullmag-py-core` — private PyO3 bridge for Python/Rust integration.
- `apps/web` — Next.js control room for scripts, sessions, runs, artifacts, and future script-export
  authoring flows. Uses **Tailwind CSS v4** for styling and **shadcn/ui** for UI primitives.
- `native/` — native backends and C ABI.
- `docs/specs` — canonical architecture, runtime, and packaging specs.
- `docs/plans` — active and archived implementation plans.
- `docs/physics` — publication-style physics documentation and validation notes.
- `.agents/skills` — canonical agent skills.
- `.agents/workflows` — canonical agent workflows.
- `external_solvers/` — reference solver codebases (not part of Fullmag, gitignored).

## When to consult reference solvers

- **Designing a new CUDA kernel** -> check `external_solvers/3/cuda/`,
  `external_solvers/plus/src/`, `external_solvers/BORIS/BorisCUDALib/`
- **Designing Python API classes** -> check `external_solvers/plus/mumaxplus/`
- **Designing UI-to-script workflows** -> compare mumax-style launch ergonomics with tetrax-style
  Python-first flows
- **Implementing energy terms** -> compare operator structures across all solvers
- **FEM discretization** -> check `external_solvers/tetmag/` and `external_solvers/tetrax/tetrax/`
- **Demag/FFT pipeline** -> check `external_solvers/3/engine/` and `external_solvers/plus/src/`
- **Time integrators** -> compare approaches in `external_solvers/3/engine/`,
  `external_solvers/plus/src/`, `external_solvers/BORIS/Boris/`
- **Writing validation tests** -> check `external_solvers/3/test/`, `external_solvers/plus/test/`,
  `external_solvers/tetmag/examples/`, `external_solvers/tetrax/tests/`

## Definition of done for foundation changes

- The change strengthens, or at least preserves, the `Python DSL -> UI authoring -> ProblemIR ->
  planner -> session/run -> backend` contract.
- Physics-facing changes include a corresponding `docs/physics/` update.
- Changes that touch authoring or launch flows preserve UI/script round-trip expectations.
- Changes that touch execution policy preserve explicit requested vs resolved execution truth across
  user surfaces, planning, and provenance.
- GPU/CUDA work improves performance without degrading backend neutrality of the public contract.
- README, AGENTS, skills, prompts, and web/CLI copy stay aligned.
- Verification covers the changed path through Rust, Python, repo consistency, and smoke flow,
  preferably via the canonical containerized or `just`-based workflows.
- No source file exceeds ~1000 lines; large modules are split into focused submodules.
