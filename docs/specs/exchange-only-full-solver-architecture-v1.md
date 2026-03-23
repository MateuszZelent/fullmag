# Exchange-Only Full Solver Architecture v1

- Status: draft
- Last updated: 2026-03-23
- Revision: 1.2 — execution-first phasing correction
- Owners: Fullmag core
- Related physics notes:
  - `docs/physics/0050-shared-problem-semantics-and-embedded-python-api.md`
  - `docs/physics/0100-mesh-and-region-discretization.md`
  - `docs/physics/0200-llg-exchange-reference-engine.md`
  - `docs/physics/0300-gpu-fdm-precision-and-calibration.md`
- Related specs:
  - `docs/specs/fullmag-application-architecture-v1.md`
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
  - `docs/plans/active/phase-0-1-implementation-plan.md`
  - `docs/plans/active/phase-2-gpu-fdm-calibrated-rollout.md`
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
  - `docs/adr/0002-container-first-monorepo.md`

## 1. Purpose

This document is the target architecture plan for the first **full-stack**, **physically meaningful**, and
**numerically executable** Fullmag release.

The release is intentionally narrow in physics:

- ferromagnetic micromagnetics,
- LLG dynamics,
- exchange interaction only.

But it is intentionally broad in system scope:

- one public Python API,
- one canonical `ProblemIR`,
- one control plane,
- one artifact model,
- one FDM execution path,
- one FEM execution path,
- shared observables and validation.

This is not a temporary toy roadmap.
It is the architectural blueprint for building a solver that is already shaped like the final product,
while keeping the first physics term limited to exchange.

> **Current bootstrap state.**
> The repository contains a working reference exchange-only CPU engine
> (`crates/fullmag-engine`) with Heun stepping, exchange field, exchange energy, LLG RHS,
> unit-norm preservation, and four reference tests.
> This engine serves as a **test reference** for validating GPU kernels.
> Production execution targets the CUDA backend in `native/fdm-cuda/` (Phase 2).

> **Implementation phasing.**
> The full north star (§2) is a **Phase 3** target. Phase 1 delivered a public CPU
> execution path to validate the architecture end-to-end. Phase 2 replaces the CPU
> engine with GPU/CUDA kernels for FDM. FEM execution lands in Phase 3.
> See `docs/plans/active/phase-0-1-implementation-plan.md` for the full phasing.

## 2. North-Star Outcome

The target outcome of this plan is:

> A user writes one Python problem definition and can execute the same exchange-only LLG problem
> through either an FDM backend or an FEM backend, with shared semantics, shared output naming,
> shared provenance, and explicit validation of backend-specific approximations.

The goal is not merely "two codes in one repo."
The goal is one micromagnetic product with two discretization engines under a common physical contract.

### 2.1 Phase 1 subset of North Star

> A user writes one Python problem definition using `Box` geometry, `Exchange`, and `LLG(heun)`,
> and executes it publicly via `Simulation.run()` on the reference FDM CPU backend with real
> numerical output, canonical artifacts, and provenance.

Phase 1 proves the full pipeline: Python → IR → plan → runner → engine → artifacts.
Phase 2 adds calibrated GPU/CUDA execution for FDM, including explicit precision selection.
Phase 3 adds FEM execution and imported geometry.

## 3. Scope and Non-Goals

### 3.1 In scope

- Embedded Python DSL as the only public scripting interface.
- Canonical `ProblemIR` between Python and Rust.
- Execution planning and capability checks for FDM and FEM.
- Exchange-only effective field.
- LLG time integration.
- Shared artifacts for:
  - magnetization field,
  - exchange field,
  - exchange energy,
  - solver diagnostics,
  - provenance.
- FDM geometry-to-grid lowering.
- FEM geometry-to-mesh lowering.
- Basic viewer/export pipeline for exchange-only runs.
- Reproducible validation suite and performance baselines.

### 3.2 Explicitly out of scope for this release

- Demagnetization.
- DMI (although `InterfacialDMI` exists in the Python API scaffold, it is not in scope for the exchange-only solver).
- Anisotropy.
- Zeeman field.
- Spin torques.
- Thermal noise.
- Multiphysics coupling.
- Hybrid execution.
- Multi-GPU.
- Distributed MPI.
- Adaptive mesh refinement.
- Public user-facing backend extension APIs.

### 3.3 Important implication

This release must feel complete as a solver product, even though the physics is intentionally incomplete.
That means:

- end-to-end execution works,
- outputs are coherent,
- errors are honest,
- artifacts are usable,
- backend differences are documented,
- validation is scientific rather than ad hoc.

## 4. Architectural Principles

1. **Physics-first**: the shared interface describes the physical problem, never storage layout.
2. **Backend-neutral public API**: Python does not expose cell indices, MFEM spaces, or CUDA arrays.
3. **Canonical IR**: Rust reasons about `ProblemIR`, not Python source text.
4. **Execution plans are explicit**: backend legality and approximations are visible before execution.
5. **Reference before optimization**: every optimized path must have a slower, trusted baseline.
6. **Artifacts are first-class**: the solver is only as useful as its outputs and provenance.
7. **FDM and FEM are peers**: neither backend defines the public semantics.
8. **Production compute stays replaceable**: native backends remain behind a stable C ABI.
9. **Validation is architectural**: analytical, cross-backend, and regression checks are designed in from day one.
10. **Exchange-only now must not block future terms later**: interfaces must already be term-extensible.

## 5. Product-Level User Experience

The exchange-only solver should support a flow like:

```python
import fullmag as fm

def build():
    geom = fm.Box(size=(200e-9, 20e-9, 5e-9), name="strip")
    mat = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.02)
    body = fm.Ferromagnet(
        name="strip",
        geometry=geom,
        material=mat,
        m0=fm.init.uniform((1.0, 0.2, 0.0)),
    )
    return fm.Problem(
        name="exchange_relax",
        magnets=[body],
        energy=[fm.Exchange()],
        dynamics=fm.LLG(integrator="heun", fixed_timestep=1e-13),
        outputs=[
            fm.SaveField("m", every=1e-12),
            fm.SaveField("H_ex", every=1e-12),
            fm.SaveScalar("E_ex", every=1e-12),
        ],
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(cell=(2e-9, 2e-9, 2e-9)),
            fem=fm.FEM(order=1, hmax=2e-9),
        ),
    )

problem = build()
fm.Simulation(problem, backend="fdm", mode="strict").run(until=2e-9)
fm.Simulation(problem, backend="fem", mode="strict").run(until=2e-9)
```

The FDM and FEM runs may differ numerically, but:

- they must mean the same physical problem,
- they must publish the same observable names,
- they must store comparable metadata,
- and the software must document why they differ.

## 6. End-to-End System Architecture

```text
Python script / notebook / web editor
                │
                ▼
      fullmag.model object graph
                │
                ▼
        Python serialization layer
                │
                ▼
             ProblemIR
                │
                ▼
    Rust validation + capability checks
                │
                ▼
          ExecutionPlanIR
          │            │
          ▼            ▼
     FDM Plan      FEM Plan
          │            │
          ▼            ▼
   FDM runner      FEM runner
          │            │
          └──────► Shared artifacts ◄──────┘
                        │
                        ▼
            CLI / web / notebooks / exports
```

## 7. Canonical Public Model

The public Python layer is divided into:

- `fullmag.model`: what the problem is,
- `fullmag.runtime`: where and how it runs.

### 7.1 Required model objects for exchange-only full solver

- `Problem`
- `Material`
- `Ferromagnet`
- `Region`
- `Geometry`
  - `Box`
  - `Cylinder`
  - `ImportedGeometry`
- `Exchange`
- `LLG`
- `SaveField`
- `SaveScalar`
- `DiscretizationHints`
  - `FDM`
  - `FEM`

### 7.2 Geometry policy

For the first full solver, we should support two geometry paths:

1. **Analytic primitives**
   - `Box`
   - `Cylinder`
   - later: boolean composition

2. **Imported geometry**
   - STEP/STL as control-plane input
   - preprocessed into either voxel masks or tetrahedral meshes

Analytic primitives are not optional.
They are necessary to make validation and unit tests easy, deterministic, and backend-comparable.

### 7.3 Initial magnetization policy

Uniform `m0` is not enough for a useful exchange-only solver.
The first full release should support:

- `uniform(vector)` — **already implemented** in Python (`fullmag.init.uniform`) and Rust IR (`InitialMagnetizationIR::Uniform`)
- `random(seed)` — requires new Python class and new IR variant (`InitialMagnetizationIR::RandomSeeded`)
- `callable` or sampled initializer on physical coordinates — requires new Python class and new IR variant (`InitialMagnetizationIR::SampledField`)
- backend-neutral table/sample representation in lowered execution plans

The public API may accept Python callables, but they must be sampled during lowering.
No arbitrary Python may run in the hot loop.

## 8. Canonical ProblemIR Requirements

`ProblemIR` remains backend-neutral.
It should not contain:

- cell indices,
- CUDA strides,
- MFEM element arrays,
- device allocation details.

But it must contain enough information to fully define exchange-only LLG semantics.

### 8.1 Required `ProblemIR` sections

- `ProblemMeta`
- `GeometryIR`
- `RegionIR`
- `MaterialIR`
- `MagnetIR`
- `EnergyTermsIR`
- `DynamicsIR`
- `SamplingIR`
- `BackendPolicyIR`
- `ValidationProfileIR`

### 8.2 Exchange-only additions or clarifications

#### `GeometryIR`

Support both:

- imported solids,
- analytic primitives.

#### `MagnetIR`

Must allow initial magnetization descriptions richer than uniform:

- `uniform`
- `sampled_field`
- possibly `random_seeded`

#### `DynamicsIR::Llg`

Must carry:

- `gyromagnetic_ratio`
- `integrator`
- `fixed_timestep`
- later: adaptive controls, stopping criteria, damping policies if needed

#### `SamplingIR`

Must standardize:

- `m`
- `H_ex`
- `E_ex`
- `solver_dt`
- `step`
- `time`

### 8.3 `ExecutionPlanIR`

The next architectural step after `ProblemIR` should be a typed plan layer:

- `ExecutionPlanIR`
  - `CommonPlanMeta`
  - `FdmPlanIR`
  - `FemPlanIR`
  - `OutputPlanIR`
  - `ProvenancePlanIR`

This layer is where discretization-specific data belongs.

Examples:

- voxel grid dimensions,
- FEM mesh path,
- quadrature order,
- boundary-condition realization,
- initial-field samples,
- solver implementation choice.

This separation is critical.
`ProblemIR` describes the problem.
`ExecutionPlanIR` describes one backend-specific realization of that problem.

## 9. Planner Responsibilities

The planner is the contract boundary between shared semantics and backend reality.

For exchange-only full solver, it must perform:

1. **Semantic validation**
   - legal materials,
   - legal `LLG` parameters,
   - legal geometry references,
   - legal outputs.

2. **Capability validation**
   - does requested backend support the geometry path?
   - does it support the chosen initial magnetization representation?
   - does it support the requested integrator?

3. **Lowering**
   - geometry -> voxelizer plan for FDM
   - geometry -> mesher/import plan for FEM
   - `m0` -> sampled initial state
   - outputs -> field/scalar schedules

4. **Provenance expansion**
   - exact backend target,
   - versioned plan,
   - mesher config,
   - voxelizer config,
   - solver implementation IDs.

5. **Execution budgeting**
   - estimated memory,
   - estimated field count,
   - checkpoint frequency,
   - scratch-space requirement.

## 10. Target Repo Layout

This is the recommended target layout for the exchange-only full solver.

```text
packages/
  fullmag-py/
    src/fullmag/
      model/
      runtime/
      geometry/
      init/
      io/

crates/
  fullmag-ir/              # canonical ProblemIR
  fullmag-plan/            # ExecutionPlanIR + capability checks + lowering
  fullmag-engine/          # reference math and reference CPU kernels
  fullmag-runner/          # execution orchestration, checkpoints, artifacts
  fullmag-cli/
  fullmag-api/
  fullmag-py-core/         # optional PyO3 bindings into planner/runner
  fullmag-artifacts/       # shared artifact schemas and IO
  fullmag-compare/         # projection and backend comparison tools

native/
  include/
  common/
  backends/
    fdm_cuda/
      src/
      include/
      kernels/
    fem_mfem/
      src/
      include/
```

### 10.1 Why separate `fullmag-plan` and `fullmag-runner`

Planning and execution are not the same concern.

- `fullmag-plan` answers: "what will this backend do?"
- `fullmag-runner` answers: "run it, checkpoint it, observe it, and write artifacts"

Keeping them separate makes the system testable and honest.

## 11. Shared Mathematical Infrastructure

Before backend specialization, the project should have a shared math layer for:

- 3-vectors,
- normalized magnetization fields,
- SI constants,
- grid/mesh-agnostic field metadata,
- time-stepping utilities,
- convergence metrics,
- output naming.

This shared layer belongs in Rust first, with eventual native mirrors where performance requires it.

### 11.1 Shared invariants

- all magnetization vectors stored and reported as reduced `m`
- `|m| ≈ 1` enforced after each explicit step
- field names are canonical and backend-independent
- energies are stored in Joules
- fields are stored in `A/m`
- time is always seconds

### 11.2 Shared diagnostics

Every backend step should be able to report:

- step index,
- time,
- chosen `dt`,
- max `|H_ex|`,
- max `|dm/dt|`,
- mean `|m|`,
- max `||m|-1|`,
- `E_ex`,
- wall time.

## 12. FDM Architecture

### 12.1 Purpose of the FDM backend

The FDM backend is the workhorse for:

- fast reference runs on regular shapes,
- large structured problems,
- later CUDA optimization.

### 12.2 FDM plan contents

`FdmPlanIR` should contain:

- grid dimensions `nx, ny, nz`
- cell size `dx, dy, dz`
- origin and bounding box
- region mask or material map
- sampled initial magnetization field
- output schedule
- exchange stencil policy
- boundary-condition realization
- integrator policy
- backend implementation choice:
  - `reference_cpu`
  - `cuda_single_gpu`

### 12.3 Geometry lowering

For FDM, geometry lowering requires:

1. compute physical bounding box,
2. choose grid from `cell` hints,
3. voxelize occupancy,
4. assign region IDs,
5. assign material IDs,
6. sample `m0` at cell centers,
7. derive active-cell mask.

This pipeline must exist even in exchange-only mode.

### 12.4 Field storage

Recommended target layout:

- structure of arrays,
- one contiguous component buffer per vector field,
- explicit ownership of:
  - `m`
  - `H_ex`
  - `dm_dt`
  - scratch/predictor buffers

The reference CPU engine may use simple `Vec<[f64; 3]>`.
The CUDA backend should use SoA buffers.

### 12.5 Exchange operator

> **Current state.** `fullmag-engine` already implements the FDM exchange operator as a
> 6-point Laplacian stencil with Neumann boundary conditions (via `saturating_sub` / `min(n-1)`).
> The implementation is correct and tested, but not yet behind a trait-based term interface.

The FDM exchange operator should be abstracted behind a term interface:

- `prepare(plan)`
- `effective_field(state, out_field)`
- `energy(state) -> scalar`
- `estimate_stiffness(state) -> scalar` for timestep heuristics later

Even though exchange is the only term now, the interface must already be additive by term.

### 12.6 Time integrator

> **Current state.** `fullmag-engine` already implements a Heun stepper with post-step
> renormalization. The `dt` is passed per-step externally; there is no adaptive timestep control yet.
> `LlgConfig` stores `gyromagnetic_ratio` and `integrator` but not `fixed_timestep` —
> that field belongs in the runner/plan layer, not the stepper itself.

For exchange-only v1:

- reference integrator: Heun
- optional second path later: semi-implicit for stiff exchange cases

The runner must not hardcode exchange into the time-stepping loop.
It should query the active term set for `H_eff`.

> **Design note.** The `LLG.fixed_timestep` field in the Python API is a *hint* for the runner,
> not a stepper-internal detail. The runner should interpret it as:
> - `None` → runner picks dt (adaptive or default heuristic)
> - `Some(dt)` → runner calls stepper with exactly this dt each step

### 12.7 CUDA production path

The target CUDA backend layout should follow a pattern inspired by:

- `external_solvers/3/cuda`
- `external_solvers/plus/src/core`
- `external_solvers/BORIS/BorisCUDALib`

Recommended split:

- host-side plan and launch logic in C++
- kernels in `.cu`
- library wrappers for:
  - CUDA runtime/driver
  - optional cuBLAS
  - later cuFFT when demag is added

For exchange-only v1, no cuFFT is required.

### 12.8 FDM backend milestones

1. CPU reference voxelized exchange-only path. **(partially done — engine exists, no voxelizer yet)**
2. CUDA field storage and exchange kernel parity.
3. CUDA Heun parity against CPU reference.
4. Artifact parity between CPU and CUDA.

## 13. FEM Architecture

### 13.1 Purpose of the FEM backend

The FEM backend is the route for:

- curved geometries,
- unstructured meshes,
- higher geometric fidelity,
- future multiphysics compatibility.

### 13.2 FEM plan contents

`FemPlanIR` should contain:

- mesh source or mesher recipe,
- region tags,
- finite-element space selection,
- polynomial order,
- quadrature policy,
- initial field samples or projection instructions,
- output schedule,
- linear solver configuration,
- time integrator policy.

### 13.3 Geometry and meshing pipeline

The first full FEM solver should support:

1. imported mesh (`.msh`) direct path,
2. geometry import + mesher path later in the same architecture.

Direct mesh import is important because it lets us finish the solver architecture before we finish
industrial-grade CAD meshing.

> **Prerequisite: FEM toolchain images.**
> Before Phase 5 can begin, the project must have container images with MFEM, libCEED, and hypre
> pre-built. This is a non-trivial infrastructure task and should be scoped as a prerequisite
> deliverable (see Phase 4.5 below).

### 13.4 FE spaces

For the first exchange-only solver:

- first-order vector-valued nodal or appropriate constrained representation,
- explicit documentation of how `|m|=1` is enforced approximately after each step,
- no attempt at the final perfect formulation from day one.

The important point is consistency and validation, not formal perfection.

### 13.5 Exchange operator

The FEM exchange term should mirror the continuum functional

\[
E_{\mathrm{ex}} = \int_{\Omega} A |\nabla m|^2 \, dV
\]

and derive the corresponding discrete effective field consistently with the chosen representation.

Recommended stack:

- MFEM for mesh/space/form management,
- libCEED for operator evaluation on accelerators,
- hypre for linear algebra/preconditioning where needed.

Even in exchange-only mode, operator ownership should be term-based:

- `ExchangeFemOperator`
- later `DemagFemOperator`
- later `AnisotropyFemOperator`

### 13.6 Time integration

The first FEM time integrator does not need to be the same internal implementation as FDM,
but it must expose the same public semantics.

Acceptable v1 path:

- explicit or linearly implicit stepper,
- post-step renormalization,
- careful documentation of where this differs from the FDM realization.

### 13.7 FEM backend milestones

1. Direct mesh import path.
2. Reference CPU exchange-only operator.
3. Time stepping with `LLG`.
4. Shared outputs and comparison against FDM.
5. Optional MFEM/libCEED acceleration after CPU correctness is stable.

## 14. Shared Artifact and Output Model

Artifacts must not be backend-specific by default.

### 14.1 Required output fields

- `m`
- `H_ex`
- `E_ex`
- `time`
- `step`
- `solver_stats`

### 14.2 Storage model

Recommended artifact split:

- metadata JSON
- dense field arrays in HDF5
- mesh snapshots in VTK/XDMF or equivalent
- regular-grid snapshots in OVF/HDF5
- scalar traces in CSV/Parquet

### 14.3 Required provenance

Every run must record:

- original Python script,
- serialized `ProblemIR`,
- derived `ExecutionPlanIR`,
- backend name,
- backend implementation ID,
- mesh or voxelizer settings,
- material constants,
- `LLG` parameters,
- build revision,
- container/toolkit info for native backends,
- driver/GPU info where relevant.

## 15. Comparison Layer

Cross-backend comparison is not a later convenience feature.
It is part of the exchange-only architecture.

### 15.1 Required comparison capabilities

- scalar trace comparison (`E_ex(t)`, average `m(t)`)
- snapshot comparison at matching times
- backend-to-backend projection tools
  - FEM -> sampled Cartesian grid
  - FDM -> nodal/element-sampled field for FEM mesh views

### 15.2 Comparison metrics

- pointwise `L2` difference after projection
- max-norm difference after projection
- energy difference
- total magnetization difference
- convergence-rate studies vs refinement

## 16. Validation Architecture

Validation must be layered.

### 16.1 Layer A: local math tests

- vector ops
- normalization
- exchange stencil
- FEM local operator correctness

### 16.2 Layer B: reference problem tests

- uniform magnetization => zero exchange field
- sinusoidal perturbation on regular grid
- twisted strip relaxation
- simple tetrahedral mesh relaxation

### 16.3 Layer C: cross-backend scientific tests

- same geometry represented in FDM and FEM
- same material
- same initial condition sampled consistently
- same outputs compared under physical tolerances

### 16.4 Layer D: reproducibility tests

- same run on same backend reproduces traces within tolerance
- plan hashes and artifact metadata remain stable

### 16.5 Layer E: performance regression tests

- FDM CPU baseline
- FDM CUDA baseline
- FEM CPU baseline
- later FEM accelerated baseline

## 17. Build and Deployment Policy

### 17.1 CUDA policy

- build against a pinned CUDA toolkit, not "latest driver only"
- ship explicit architecture targets
- keep a minimum supported driver policy
- validate on both oldest-supported and current drivers
- define public execution precision modes explicitly (`double`, `single`)
- calibrate GPU `double` against CPU `double` before promoting GPU `single`

### 17.2 Native ABI policy

Rust should talk to native backends through a stable C ABI.

Target shape:

```c
fullmag_backend* fullmag_backend_create(const fullmag_plan* plan);
int fullmag_backend_run(fullmag_backend* handle, const fullmag_run_options* opts);
int fullmag_backend_step(fullmag_backend* handle, uint64_t steps);
int fullmag_backend_get_field(fullmag_backend* handle, const char* name, fullmag_array_view* out);
void fullmag_backend_destroy(fullmag_backend* handle);
```

FDM and FEM native implementations should honor the same contract.

### 17.3 Container policy

We should maintain at least:

- `dev` image
- `cuda-dev` image
- `fem-dev` image
- later combined CI or production images if justified

### 17.4 Auto-documentation policy

`docs/physics/` notes are the single source of truth for physics documentation.
The frontend should auto-render them into user-facing reference pages.
Every new physics feature documented through the `physics-publication` skill
automatically becomes visible in the web UI without extra writing effort.

## 18. Implementation Phases

### Phase 0: Freeze exchange-only shared semantics

Deliverables:

- geometry primitive policy (Box, Cylinder, ImportedGeometry)
- `m0` policy (uniform, random, callable)
- `LLG` parameter policy (integrator enum, timestep hint semantics)
- **boundary condition policy** for exchange (Neumann ∂m/∂n=0 as default)
- output naming policy (m, H_ex, E_ex, solver_dt, step, time)
- comparison tolerances policy

### Phase 1: Strengthen Python API and IR

Deliverables:

- analytic primitive geometries
- richer initial magnetization API
- updated `ProblemIR`
- typed `ExecutionPlanIR`

### Phase 2: Build planner and lowering

Deliverables:

- `fullmag-plan`
- FDM lowering
- FEM lowering
- capability matrix for executable subset

### Phase 3: Finish reference execution layer

Deliverables:

- shared `fullmag-engine`
- exchange-only reference CPU FDM
- exchange-only reference CPU FEM or lowest-risk host implementation
- shared diagnostics

### Phase 4: Complete FDM backend

Deliverables:

- voxelizer
- production host runner
- CUDA exchange operator
- CUDA Heun stepping
- FDM artifacts

### Phase 4.5: FEM toolchain infrastructure

Deliverables:

- `fem-dev` Docker image with MFEM + libCEED + hypre pre-built
- native build system for FEM backend in `native/backends/fem_mfem/`
- C ABI stub that compiles against the image
- smoke test that loads and runs a trivial MFEM program

### Phase 5: Complete FEM backend

Deliverables:

- mesh import pipeline
- FEM exchange operator
- FEM LLG stepping
- FEM artifacts

### Phase 6: Shared compare/export layer

Deliverables:

- projection tools
- compare CLI
- notebook-ready outputs
- web viewer support

### Phase 7: Hardening

Deliverables:

- regression suite
- performance suite
- robust provenance
- user-facing examples

## 19. Work Breakdown by Subsystem

### 19.1 Python API team slice

- add geometry primitives
- add richer `m0`
- add exchange-only example library
- improve docstrings and typing

### 19.2 IR/planner slice

- define `ExecutionPlanIR`
- legality checks
- output schedule lowering
- plan hashing

### 19.3 FDM slice

- voxelizer
- grid metadata
- state buffers
- exchange operator
- time integrator
- checkpoints

### 19.4 FEM slice

- mesh import
- field-space construction
- exchange operator
- time integrator
- projection/export

### 19.5 Artifact slice

- HDF5 field storage
- scalar traces
- metadata schema
- compare tools

### 19.6 Control-plane slice

- runner orchestration
- local job execution
- artifact registration
- log streaming

## 20. Main Risks and Design Traps

1. **Letting FDM primitives leak into public API**
   - fix: keep geometry-first model

2. **Pretending FEM and FDM are numerically identical**
   - fix: compare under physics tolerances, not bitwise equality

3. **Skipping analytic primitives and relying only on imported CAD**
   - fix: primitives are mandatory for validation

4. **Using `ProblemIR` as execution storage**
   - fix: introduce `ExecutionPlanIR`

5. **Building CUDA path before reference parity exists**
   - fix: require CPU reference baselines

6. **Allowing outputs to diverge by backend**
   - fix: canonical observable dictionary

7. **Making meshing a hard blocker for the first FEM run**
   - fix: support imported meshes early

8. **Under-investing in projection/comparison**
   - fix: treat compare layer as required architecture

## 21. Reference Solver Inspiration Map

These references should shape architecture, not code copying:

- `external_solvers/3/engine`, `external_solvers/3/cuda`
  - learn host/device separation and solver workflow
- `external_solvers/plus/src/core`, `external_solvers/plus/src/physics`, `external_solvers/plus/mumaxplus`
  - learn Python-facing extensible architecture
- `external_solvers/BORIS/Boris`, `external_solvers/BORIS/BorisCUDALib`
  - learn long-term backend growth patterns
- `external_solvers/tetmag/preproc`, `external_solvers/tetmag/gpu`, `external_solvers/tetmag/main`
  - learn mesh pipeline and FEM execution partitioning
- `external_solvers/tetrax/tetrax/interactions`, `external_solvers/tetrax/tests`
  - learn Python-first FEM organization and testing discipline

## 22. Definition of Done for the Exchange-Only Full Solver

The exchange-only full solver is done only when all of the following are true:

1. One Python problem runs on both FDM and FEM.
2. Both paths publish the same canonical outputs.
3. The run artifacts include complete provenance.
4. Exchange field and energy are validated analytically where possible.
5. FDM and FEM can be compared through a standard comparison tool.
6. Public docs explain backend differences honestly.
7. The web/CLI/runtime stack can submit, run, inspect, and export exchange-only jobs.
8. The system is ready to add the next energy term without architectural surgery.

## 23. Recommended Immediate Next Steps

1. Create `ExecutionPlanIR` before adding more backend code.
2. Add analytic geometries and richer `m0` to the Python API.
3. Split planner responsibilities into a dedicated Rust crate.
4. Build the first executable FDM path from Python problem to voxelized state.
5. In parallel, design the FEM imported-mesh path so meshing does not block the first full FEM run.
6. Freeze artifact schema before backend outputs proliferate.

## 24. Final Guidance

If we follow this plan, the first complete Fullmag solver will be:

- small enough to finish,
- honest enough to trust,
- structured enough to scale,
- and already shaped like the final product.

The central rule must remain visible in every implementation decision:

> We are not building a grid tool and later stretching it toward FEM.
> We are building one micromagnetic solver platform whose first complete physics slice happens to be exchange-only.
