# 00 - Source Of Truth And Consolidation

This file stitches together the existing Fullmag frequency-domain, eigenmode,
artifact, capability, runtime, and frontend notes. It is the entry point for the
implementation plan in this folder.

The core consolidation rule is:

```text
frequency_domain = analysis family
frequency_response = driven harmonic frequency-domain solver
eigenmodes = modal dynamic-matrix/eigensystem solver
```

`frequency_response` and `eigenmodes` may share the same linearized LLG
operator contract, tangent-space projection, equilibrium diagnostics, artifact
manifest, and UI family. They must not share one solver identity, one result
schema, or one capability bit.

## Canonical Source Hierarchy For This Feature

Use this order when documents disagree.

1. Physics notes own equations, units, assumptions, and validation gates.
2. Specs and ADRs own public API, artifact, runtime, capability, and frontend
   architecture contracts.
3. Backend architecture docs and skills own native FEM lane ownership and build
   discipline.
4. Engineering plans and reports provide status, implementation sequence, and
   migration history.
5. External solver source code provides reference behavior, not Fullmag public
   semantics.

## Documents That Own Current Truth

| Document | Owns | Import Into This Masterplan |
|---|---|---|
| `docs/physics/frequency_domain_solver_physics.md` | Broad magnetic, magnetoelastic, quasistatic, elastodynamic, and coupled frequency-domain physics contract. | The actual driven solver is magnetic-only harmonic response first. Magnetoelastic, elastodynamic, and coupled modes stay future gated capabilities. |
| `docs/physics/0700-frequency-domain-linearized-llg.md` | Linearized LLG convention, tangent constraint, phase convention, COMSOL parity requirements, complex phasor UI views, mode animation semantics, demag policy, Floquet validation. | Production FEM must solve in tangent variables. Three-component fields are output reconstruction only. UI mode views and animation must reconstruct from `delta_m`, not invent a time-domain solve. |
| `docs/physics/0710-periodic-and-floquet-boundary-conditions.md` | Periodic and Floquet/Bloch phase convention, capability policy, mesh metadata, pair diagnostics, and sign test. | Use `exp_minus_i_k_dot_delta_r`, require backend enforcement, and reject unsupported Floquet demag. |
| `docs/physics/0600-fem-eigenmodes-linearized-llg.md` | Current FEM eigenmode physics and implementation status. | Current executable eigenmode path is reference/transitional modal support, not the driven frequency-response solver. |
| `docs/physics/fullmag_fem_eigenproblem_plan.md` | Historical but correct separation of eigenproblem from frequency-response spectrum. | Preserve the statement that true eigenmodes and RF frequency-response spectra are not the same product. |
| `docs/physics/0800-fem-static-pbc-demag.md` | Static/time-domain FEM demag PBC semantics. | Reuse static/zero-phase periodic demag rules for k = 0 FMR where applicable; do not imply nonzero-k dynamic demag. |
| `docs/physics/0810-fem-static-pbc-dmi.md` | Static/time-domain DMI PBC seam semantics. | Periodic seam is not a physical free boundary; DMI seam handling must be explicit. |
| `docs/specs/frequency-domain-artifacts-v2.md` | Canonical v2 artifact family for spectrum, branches, dispersion, modes, response sweep, and periodic pairs. | Reuse `eigen/*.v2`, `response/magnetic_response_sweep.v1.json`, and diagnostic 404 semantics. |
| `docs/specs/fullmag_magnetoelastic_frequency_patch_specs.md` | Patch-level IR, planner, capability, artifact, UI, API, test, and benchmark contract. | Historical baseline: keep production capability flags separate. Current rollout keeps that separation and promotes only the explicitly gated native FEM production CPU response slice. |
| `docs/specs/capability-matrix-v0.md` | Current capability status and deferred booleans. | `StudyIR::FrequencyResponse` is partial-production-executable for the native FEM CPU gamma/free-boundary magnetic slice, reference-executable for dense validation artifacts, and unsupported for production GPU, demag, nonzero-k Floquet/Bloch response, and magnetoelastic response. `frequency_domain_capabilities.v1` is the precise UI-gating source. |
| `docs/specs/runtime-engine-naming-v0.md` | Current FEM eigen engine names and production/reference labels. | Keep `fem_eigen_*` engine names scoped to modal eigen paths. Do not promote them as response engines. |
| `docs/specs/resource-first-control-room-api-v2.md` | Resource-first v2 API rules. | Add frequency-domain resources through the typed API/facade/resource-hook layers only. |
| `docs/engineering/frequency_domain_solver_engineering.md` | Engineering backlog, solve stack, ABI direction, frontend/CLI, tests, benchmarks, release gates. | Use the staged MR path: semantic contract, scalable modal path, then driven response, then mechanics/coupling. |
| `docs/plans/fullmag_magnetoelastic_frequency_implementation_plan.md` | Prior implementation status and completed/pending task list. | Treat checked tasks as known current status, especially semantic IR, planner rejection, capabilities, dense response primitive, response artifact writer, and API resource. |
| `docs/reports/05.05.2026/PBC/update/08_PHASE_F_FREQUENCY_DOMAIN_CLEANUP.md` | Explicit correction that eigenfrequency is not frequency-response. | Use the solver split exactly: `EigenfrequencySolver` solves `L q = lambda B q`; `FrequencyResponseSolver` solves `(i omega B - L) q = f`. |
| `docs/reports/05.05.2026/PBC/update/13_TEST_SNIPPETS.md` | Historical PBC/Floquet test snippets. | Import phase sign, PBC parity, DMI seam, API artifact, and frontend diagnostic test ideas. |
| `docs/reports/05.05.2026/PBC/update/14_PR_CHECKLISTS.md` | Historical PR checklist for cleanup and frontend separation. | Use as checklist reference only, adjusted to `apps/control-room` and v2 API. |
| `docs/reports/05.05.2026/PBC/fullmag_fd_08_artifacts_api_client_contract.mdx` | Historical artifact, API, and TypeScript client plan for v2 modal artifacts. | Import artifact/API intent, but remap old `apps/web` paths to `apps/control-room`. |
| `docs/reports/05.05.2026/PBC/fullmag_fd_09_frontend_dispersion_workbench.mdx` | Historical dispersion workbench design. | Import UX requirements: k-path editor, periodic pairs, branch plot, mode inspector, and path-s axis. Remap implementation paths to Control Room modules. |
| `docs/reports/fullmag_eigensolver_diagnostic_2026-04-14.md` | Diagnostic of existing eigensolver UI, COMSOL-style result tree, and missing workspace integration. | Keep the result-tree lesson: spectrum, mode table, dispersion, and mode viewport belong in normal workspace resources, not an isolated workbench. |

## Current Repo Status To Preserve

Backend and public contract status:

- Python exposes `Eigenmodes` and `FrequencyResponse`.
- IR exposes `StudyIR::Eigenmodes` and `StudyIR::FrequencyResponse`.
- Planner can produce FEM eigen plans.
- Planner can produce `FemFrequencyResponsePlanIR` for FEM response paths and
  rejects FDM response explicitly.
- Runtime capabilities expose frequency-domain deferred flags for compatibility
  and the nested `frequency_domain_capabilities.v1` snapshot for precise
  reference/production/unsupported UI gating.
- The current modal runner writes eigen artifacts and v2 dispersion artifacts.
- The runner contains dense validation primitives for a field-driven response
  sweep and can write an artifact-shaped
  `response/magnetic_response_sweep.v1.json`.
- The runner also orchestrates a limited native FEM/MFEM production CPU response
  lane for the supported gamma/free-boundary magnetic slice. That slice is a
  partial production capability, not a promotion of demag, nonzero-k
  Floquet/Bloch, magnetoelastic, or GPU response.
- The v2 API can serve `response/magnetic_response_sweep.v1.json` when present
  and must return explicit diagnostic 404 when absent.

Frontend status:

- `apps/control-room` is the target app, not historical `apps/web`.
- Control Room already has generated route constants for current eigen and
  response endpoints.
- Control Room currently exposes the response sweep facade/resource hook, but
  modal eigen facade methods and hooks are incomplete.
- Explorer currently has shallow `study.stage.eigenmodes` and
  `study.stage.frequency_response` authoring nodes.
- Explorer does not yet expose solved spectra, branches, modes, response
  sweeps, frequency points, diagnostics, or mode-field resources as nodes.
- Inspector routing does not yet guarantee one inspector per frequency-domain
  result node.
- `analysis-plots` does not yet render modal spectra, dispersion, branch plots,
  response sweep charts, mode tables, or response diagnostics.
- `viewport-3d` does not yet have a frequency-domain mode/response field
  overlay source, phase controls, or complex-field visualization selection.

## External Solver Integration

External solvers are reference sources only. Fullmag public semantics remain
defined by Fullmag physics notes, IR, capability matrix, and resource contracts.

TetraX:

- `external_solvers/tetrax/tetrax/experiments/eigen/solve.py` is a local
  reference for the modal eigenmode experiment.
- `external_solvers/tetrax/tetrax/experiments/eigen/dynamic_matrix.py` is a
  local reference for dynamic-matrix modal formulation and sparse linear
  operator use.
- `external_solvers/tetrax/tetrax/experiments/eigen/result.py` is a local
  reference for spectrum dataframe, mode profiles, plotting, linewidths, and
  modal postprocessing.
- `external_solvers/tetrax/tetrax/experiments/eigen/postprocessing/absorption.py`
  calculates dynamic susceptibility from an existing eigensystem and antenna.
  That is modal absorption postprocessing, not the direct driven solver.
- Import the UX and validation lessons for eigenmodes, dispersion, linewidths,
  mode profile export, and absorption-from-modes.

Tetmag:

- `external_solvers/tetmag/specs/ProgramSpecs.h` defines `Hdynamic` pulse,
  sweep, and RF drive fields.
- `external_solvers/tetmag/main/TheLLG.cpp` applies RF, pulse, and sweep fields
  inside time-domain LLG effective-field evaluation.
- Import excitation vocabulary, RF-drive UX, and time-domain validation ideas.
- Do not treat Tetmag as a direct harmonic frequency-domain solver reference.

## Historical Docs To Translate, Not Copy

Some older documents are still useful but contain outdated implementation
paths.

Translation rules:

- Replace `apps/web` with `apps/control-room`.
- Replace legacy direct client modules with generated v2 route constants,
  `ControlRoomApi`, and resource hooks.
- Replace isolated analyze workbench assumptions with unified workspace module,
  Explorer, inspector, analysis-plots, and viewport integration.
- Treat old `/v1/live/current/...` routes as compatibility history only.
- Treat old artifact names without `.v2` as compatibility inputs, not target
  output for new UI.
- Keep COMSOL-style lessons about result trees, datasets, plot groups, and mode
  selection, but express them through Fullmag resource-first semantics.
- Keep TetraX modal lessons, but do not rename modal postprocessing to driven
  frequency response.

## Conflict Resolution

### Conflict: `frequency-domain artifacts v2` applies to FEM eigen

Resolution:

The artifact family can be called frequency-domain because it belongs to the
frequency-domain analysis family. That does not make every artifact a driven
`frequency_response` result.

Use these resource groups:

```text
analysis.frequency_domain.manifest
analysis.eigen.spectrum
analysis.eigen.branches
analysis.eigen.dispersion
analysis.eigen.mode
analysis.frequency_response.sweep
analysis.frequency_response.frequency_point
```

### Conflict: old reports propose `fem_frequency_response.rs` in Rust runner

Resolution:

The Rust runner may host orchestration, validation primitives, and artifact
compatibility, but production native FEM implementation belongs under
`backends/fem`. `mfem_bridge.cpp` and Rust runner dispatch must stay thin.

### Conflict: dense response primitive exists, but capability is false

Resolution:

The primitive is validation infrastructure. It does not make
`supports_frequency_response=true`. Capability promotion requires a planner
path, backend runtime execution, solver-created artifacts, API/resource
integration, diagnostics, tests, benchmarks, and UI behavior for the named lane.

### Conflict: modal absorption can plot absorption spectrum

Resolution:

Modal absorption from an eigensystem is a modal postprocessing product. Driven
response absorption is produced by solving `(i omega B - L) q = f` at requested
frequencies. The UI may show both, but labels, provenance, artifacts, and
capabilities must keep them separate.

### Conflict: eigen linewidths look like frequency-domain response

Resolution:

Linewidths from damped eigenvalues are modal diagnostics. Response linewidths or
peaks from a driven sweep are response diagnostics. They can be cross-validated
only under documented assumptions.

## Consolidated Target Architecture

Backend target:

```text
backends/fem/
  include/frequency_domain/
    public native contracts
  src/frequency_domain/
    artifact metadata, diagnostics, and FFI-safe orchestration helpers
  core/frequency_domain/
    equilibrium state, tangent frame, tangent projection, observables
  cpu/frequency_domain/
    MFEM/hypre/libCEED operator realization, driven response, modal integration
  gpu/frequency_domain/
    CUDA/libCEED realization and future qualification probes
  tests/frequency_domain/
    native contract, operator, response, modal, and artifact tests
```

Do not create a parallel `backends/fem/frequency_domain/include` hierarchy. The
native FEM tree already owns shared `include`, `src`, `core`, `cpu`, `gpu`, and
`tests` directories; frequency-domain code is added as subdirectories inside
those existing owners.

Planner target:

```text
FemFrequencyResponsePlanIR
FemEigenPlanIR
shared frequency-domain operator/equilibrium plan pieces
separate solve requests and separate capability decisions
```

Runtime/API target:

```text
frequency_domain/manifest.v1.json
eigen/spectrum.v2.json
eigen/branches.v2.json
eigen/dispersion.csv
eigen/modes/...
response/magnetic_response_sweep.v1.json
response/frequency_points/...
Zarr-backed field payload resources for mode and response overlays
optional HDF5/H5 export or backend storage with identical resource semantics
mesh/periodic_pairs.v1.json
```

Capability field source of truth:

- `02-ir-planner-python-capabilities-api.md` Stage C4 owns the master capability field list for this plan.
- `08-periodic-floquet-bloch-boundary-conditions.md` adds PBC/Floquet-specific capability candidates.
- If the two documents diverge, update Stage C4 first, then update doc 08 to match.

Frontend target:

```text
Explorer frequency-domain family
  authoring nodes for eigenmodes and frequency response
  result nodes for modal products
  result nodes for driven response products
  job nodes
  diagnostics nodes

Inspector
  one specific inspector per node kind
  no PlaceholderPanel fallback

Analysis plots
  modal spectrum
  dispersion and branches
  mode table
  response sweep
  absorption
  residuals and tangent leakage

Viewport 3D
  mode field overlay
  response field overlay
  real/imag/amplitude/phase controls
  vector and scalar component controls
```

## Required Update Sequence

Use this sequence before implementing code:

1. Update or confirm the physics notes if the planned solver changes equations,
   units, damping, demag, Floquet, magnetoelasticity, or observables.
2. Update specs for artifacts, capabilities, runtime resources, and OpenAPI if
   the public contract changes.
3. Validate periodic pair, static periodic, Floquet/Bloch, k-path, and demag
   capability semantics before enabling FMR or dispersion workflows.
4. Add native FEM backend contracts and managed `just` verification recipes.
5. Promote planner support only for cases the native backend can execute.
6. Wire API and frontend resource hooks only through generated paths and
   `ControlRoomApi`.
7. Build Explorer nodes from resources or manifests, not from guessed file
   names.
8. Add an inspector for every node kind before enabling the node in Explorer.
9. Add analysis chart and 3D overlay tests before claiming UI support.
10. Promote capability flags only in the same change series that includes
   backend execution, artifacts, API, UI, tests, and benchmark evidence.

## Acceptance Criteria For Consolidation

- The plan uses `frequency_response` only for the driven harmonic solver.
- The plan uses `eigenmodes` only for the modal eigensystem product.
- Every historical `apps/web` frontend instruction has a Control Room v2
  translation before implementation.
- Capability status is promoted only for lanes with executable proof; production
  CPU/GPU response remains unsupported until the native solver passes its gates.
- Every new UI node has a named inspector and a named resource source.
- Every new backend lane has a managed container-backed `just` verification
  path.
