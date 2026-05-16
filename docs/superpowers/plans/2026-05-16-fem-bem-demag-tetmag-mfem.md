# FEM/BEM Open-Boundary Demag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a Tetmag-style Fredkin-Koehler FEM/BEM open-boundary demag realization for native MFEM CPU, using a magnetic-domain-only tetrahedral mesh and no volumetric airbox.

**Architecture:** Add a dedicated native FEM demag subsystem beside the existing Poisson airbox subsystem. The new subsystem owns boundary extraction, Neumann Poisson solve, boundary integral application, Dirichlet Laplace correction, field recovery, energy, provenance, and profiler timing. Rust/Python/API surfaces keep the existing physics-first `Demag(model="fredkin_koehler")` contract and stop rejecting it only after the native path is validated.

**Tech Stack:** Fullmag Python DSL, ProblemIR and planner crates, Rust runner C ABI bridge, native C++17 FEM backend, MFEM, hypre, dense Lindholm BEM reference operator, future compressed H2/FMM BEM operator, session solver profiler diagnostics.

---

## 1. Required Reading

**Files:**
- Read: `docs/physics/0870-fem-bem-demag-open-boundary.md`
- Read: `docs/physics/0540-fem-demag-multi-model-architecture.md`
- Read: `docs/specs/native-fem-backend-architecture-v1.md`
- Read: `docs/specs/capability-matrix-v0.md`
- Read: `external_solvers/tetmag/main/DemagField.cpp`
- Read: `external_solvers/tetmag/preproc/BEMprocessing.cpp`
- Read: `external_solvers/tetmag/preproc/Lindholm.cpp`
- Read: `external_solvers/tetmag/preproc/FEMprocessing.cpp`
- Read: `external_solvers/tetmag/preproc/Boundary.cpp`
- Read: `external_solvers/tetmag/main/h2interface.c`

- [ ] **Step 1: Confirm the numerical contract**

Record in the implementation PR that Tetmag's relevant demag path is a body-only hybrid FEM/BEM method:

```text
u = u1 + u2
int_Omega grad u1 . grad v dV = int_Omega M . grad v dV
u2|_Gamma = B(u1|_Gamma)
Delta u2 = 0 in Omega, u2 = B(u1|_Gamma) on Gamma
H_demag = -grad(u1 + u2)
```

There is no volumetric airbox. The exterior open boundary is represented by the boundary integral operator on `Gamma = boundary(Omega_m)`.

- [ ] **Step 2: Record the license boundary**

Tetmag is AGPL. Do not copy Tetmag implementation code into native Fullmag unless the project explicitly accepts that license coupling. Reimplement from the equations and use Tetmag only as an external executable or fixture generator for validation.

## 2. Public Contract and Capability Gates

**Files:**
- Modify: `crates/fullmag-ir/src/plan.rs`
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-plan/src/tests.rs`
- Modify: `packages/fullmag-py/tests/test_api.py`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/physics/0870-fem-bem-demag-open-boundary.md`

- [ ] **Step 1: Add RED tests for the current public vocabulary**

Add tests that prove the existing public vocabulary is accepted at authoring and IR layers but rejected as executable until the native backend is ready:

```bash
cargo test -p fullmag-plan fredkin_koehler --no-fail-fast
pytest packages/fullmag-py/tests/test_api.py -k fredkin_koehler
```

Expected before native implementation: Python/IR serialization passes, executable planning still rejects with a message naming `fredkin_koehler` as not yet implemented.

- [ ] **Step 2: Keep `auto` on the validated airbox path**

Do not change default `Demag()` or `Demag(model="auto")` resolution. `auto` continues to resolve to the current Poisson airbox realization until FEM/BEM has validation and performance gates.

- [ ] **Step 3: Promote only `fredkin_koehler` after native readiness**

When native execution is ready, update `RequestedFemDemagIR::is_implemented()` so only `FredkinKoehler` becomes implemented. Keep `Bem` and `Fmm` rejected unless separate implementations exist.

- [ ] **Step 4: Enforce no-airbox planning semantics**

Add planner tests proving:

```text
Demag(model="fredkin_koehler") + FEM body-only mesh -> no air_box_config
Demag(model="fredkin_koehler") + periodic FEM demag -> rejected
Demag(model="fredkin_koehler") + missing tetra topology -> rejected
Demag(model="fredkin_koehler") + non-watertight magnetic boundary -> rejected
```

## 3. Native C ABI and Runner Selection

**Files:**
- Modify: `native/include/fullmag_fem.h`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Modify: `crates/fullmag-runner/src/dispatch.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Modify: `crates/fullmag-cli/src/diagnostics.rs`

- [ ] **Step 1: Extend the C ABI enum deliberately**

Add a native demag realization value for Fredkin-Koehler FEM/BEM:

```text
FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER
```

Keep existing values stable. Do not reuse the generic `BEM` or `FMM` variants for this implementation.

- [ ] **Step 2: Route the Rust runner to the new native mode**

Change the runner so:

```text
ResolvedFemDemagIR::FredkinKoehler -> FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER
ResolvedFemDemagIR::Bem -> still rejected
ResolvedFemDemagIR::Fmm -> still rejected
```

- [ ] **Step 3: Add early environment and capability diagnostics**

Native runner errors must distinguish:

```text
unsupported demag model
missing native FEM backend
missing boundary topology
non-watertight boundary mesh
dense BEM too large for configured reference cap
```

- [ ] **Step 4: Preserve artifact and diagnostics labels**

Artifacts and CLI diagnostics must use:

```text
requested_demag_model = "fredkin_koehler"
resolved_demag_realization = "fem_fredkin_koehler"
bem_operator_mode = "dense_reference" | "h2" | "fmm"
```

## 4. Boundary Surface Extraction

**Files:**
- Create: `native/backends/fem/cpu/mfem/interactions/demag_boundary_surface.hpp`
- Create: `native/backends/fem/cpu/mfem/interactions/demag_boundary_surface.cpp`
- Create: `native/backends/fem/tests/demag_boundary_surface_contract.cpp`
- Modify: `native/backends/fem/CMakeLists.txt`

- [ ] **Step 1: Add boundary extraction tests first**

Create contract tests for a single tetrahedron and a simple closed cube tetra mesh. The tests must verify:

```text
unique boundary node map
boundary triangle count
global node -> boundary node index mapping
outward-oriented triangle normals
no interior faces in the boundary surface
stable ordering for deterministic BEM matrix assembly
```

Run:

```bash
cmake --build native/build --target demag_boundary_surface_contract
ctest --test-dir native/build -R demag_boundary_surface_contract --output-on-failure
```

- [ ] **Step 2: Implement MFEM-backed extraction**

Use MFEM mesh boundary elements where available. If a mesh lacks boundary elements, reconstruct exterior faces by counting tetrahedron faces and selecting faces with count `1`. Reject non-triangular boundary elements in v1.

- [ ] **Step 3: Reject invalid topology explicitly**

Return structured native errors for:

```text
empty boundary
non-tetrahedral volume elements
non-triangular boundary elements
boundary face with missing vertices
ambiguous normal orientation
nonmanifold exterior face ownership
```

## 5. Dense Lindholm BEM Reference Operator

**Files:**
- Create: `native/backends/fem/cpu/mfem/interactions/demag_lindholm_operator.hpp`
- Create: `native/backends/fem/cpu/mfem/interactions/demag_lindholm_operator.cpp`
- Create: `native/backends/fem/tests/demag_lindholm_operator_contract.cpp`
- Modify: `native/backends/fem/CMakeLists.txt`

- [ ] **Step 1: Write dense-operator tests before implementation**

Tests must cover:

```text
finite matrix entries on tetrahedron and cube surfaces
diagonal solid-angle convention matches the physics note
constant-vector sanity check against the Tetmag-style Laplace matrix test
dense setup refuses boundary node counts above the configured reference cap
```

- [ ] **Step 2: Implement the operator from equations, not by copying Tetmag**

Implement a Fullmag-owned Lindholm triangle quadrature/weight routine from the published formulas. Keep the code comments tied to the equations and the physics note, not Tetmag source line numbers.

- [ ] **Step 3: Isolate the production operator interface**

Expose one interface:

```cpp
class DemagBoundaryOperator {
 public:
  virtual void apply(const mfem::Vector& u1_boundary, mfem::Vector& u2_boundary) const = 0;
  virtual const char* mode() const = 0;
};
```

The dense operator implements this interface as `dense_reference`. H2/FMM later plugs into the same interface.

## 6. Neumann Poisson Workspace for `u1`

**Files:**
- Create: `native/backends/fem/cpu/mfem/interactions/demag_fem_bem.hpp`
- Create: `native/backends/fem/cpu/mfem/interactions/demag_fem_bem.cpp`
- Modify: `native/backends/fem/cpu/mfem/interactions/demag_poisson.hpp`
- Modify: `native/backends/fem/cpu/mfem/interactions/demag_poisson.cpp`
- Create: `native/backends/fem/tests/demag_fem_bem_neumann_contract.cpp`

- [ ] **Step 1: Reuse the existing weak RHS semantics**

The Neumann RHS must use the same sign and units as the documented Fullmag demag contract:

```text
rhs_i = int_Omega M . grad(phi_i) dV
```

Use the existing magnetization coefficient/RHS workspace patterns where possible. Do not duplicate equations in separate CPU/GPU-specific formulas.

- [ ] **Step 2: Add a gauge constraint**

The Neumann Poisson operator is singular. Implement a deterministic gauge. V1 may pin one true DOF if this is the only robust MFEM path available; the preferred final form is a mean-zero constraint if MFEM/hypre support is already available in this codebase.

- [ ] **Step 3: Verify zero-source and finite-source behavior**

Contract tests must verify:

```text
zero magnetization -> finite u1 with chosen gauge
uniform magnetization on a closed symmetric fixture -> finite u1 and finite RHS norm
solver telemetry contains iterations and final residual
```

## 7. Dirichlet Laplace Correction for `u2`

**Files:**
- Modify: `native/backends/fem/cpu/mfem/interactions/demag_fem_bem.hpp`
- Modify: `native/backends/fem/cpu/mfem/interactions/demag_fem_bem.cpp`
- Create: `native/backends/fem/tests/demag_fem_bem_dirichlet_contract.cpp`

- [ ] **Step 1: Add boundary gather/scatter helpers**

Implement deterministic helpers:

```text
gather_boundary_values(global_potential, boundary_surface) -> boundary vector
scatter_boundary_values(boundary vector, boundary_surface) -> global Dirichlet vector
```

- [ ] **Step 2: Solve the harmonic correction**

Use the scalar stiffness operator with essential boundary true DOFs:

```text
Delta u2 = 0 in Omega_m
u2 = B(u1|Gamma) on Gamma
```

The solve must not allocate a new FE space or stiffness matrix on every step.

- [ ] **Step 3: Validate boundary conditions**

Contract tests must verify that all boundary true DOFs in `u2` equal the BEM-applied boundary vector within solver tolerance.

## 8. Field Recovery, Energy, and Solver Profiler

**Files:**
- Modify: `native/backends/fem/cpu/mfem/interactions/demag_fem_bem.hpp`
- Modify: `native/backends/fem/cpu/mfem/interactions/demag_fem_bem.cpp`
- Modify: `native/include/fullmag_fem.h`
- Modify: `crates/fullmag-runner/src/solver_profile.rs`
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `docs/physics/0817-native-fem-cpu-demag-hot-path-profile.md`

- [ ] **Step 1: Recover the field from the total potential**

Compute:

```text
u = u1 + u2
H_demag = -grad(u)
```

Reuse existing MFEM field recovery machinery where possible. Keep output artifact names identical to the current FEM demag outputs.

- [ ] **Step 2: Preserve Fullmag energy sign**

Compute:

```text
E_demag = -0.5 * mu0 * int_Omega M . H_demag dV
```

Add a regression test that catches sign inversion against a simple uniformly magnetized fixture.

- [ ] **Step 3: Emit profiler-compatible phases**

When the opt-in solver profiler is enabled, report:

```text
demag_total
demag_assemble
demag_solver_setup
demag_solver_apply
demag_recover
demag_energy
```

Detailed native labels may include:

```text
demag_neumann_poisson_solve
demag_bem_apply
demag_dirichlet_laplace_solve
```

When the profiler is disabled, do not allocate profiler samples, write JSONL, or emit engine-log profile lines.

## 9. Native Context Integration

**Files:**
- Modify: `native/backends/fem/include/context.hpp`
- Modify: `native/backends/fem/src/context.cpp`
- Modify: `native/backends/fem/src/mfem_bridge.cpp`
- Modify: `native/backends/fem/CMakeLists.txt`
- Create: `native/backends/fem/tests/demag_fem_bem_bridge_contract.cpp`

- [ ] **Step 1: Add subsystem ownership without growing bridge physics**

`mfem_bridge.cpp` may route calls and translate errors, but the FEM/BEM equations must live in `demag_fem_bem.cpp` and helper files.

- [ ] **Step 2: Initialize only the selected demag subsystem**

For `FULLMAG_FEM_DEMAG_AIRBOX_*`, keep using the current Poisson subsystem. For `FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER`, initialize:

```text
DemagBoundarySurface
DenseLindholmBoundaryOperator
NeumannPoissonWorkspace
DirichletLaplaceWorkspace
PotentialRecoveryWorkspace
```

- [ ] **Step 3: Destroy in reverse ownership order**

Tests must verify repeated create/destroy cycles do not leak native-owned demag objects or leave dangling pointers in `Context`.

## 10. Runtime Validation Fixtures

**Files:**
- Create: `crates/fullmag-runner/tests/fem_bem_demag_validation.rs`
- Create: `native/backends/fem/tests/demag_fem_bem_sphere_contract.cpp`
- Create: `docs/reports/16.05.2026/fem_bem_demag_validation.md`

- [ ] **Step 1: Add analytical fixture tests**

Validate at least:

```text
uniformly magnetized sphere: average H_demag ~= -M/3
closed cube fixture: finite H_demag, finite E_demag, deterministic boundary operator checksum
zero magnetization: zero or near-zero H_demag and E_demag
```

- [ ] **Step 2: Compare against current Poisson airbox convergence**

Run the same magnetic body with Poisson airbox factors:

```text
2x, 4x, 8x
```

Record that FEM/BEM does not change with airbox size because no airbox exists, while Poisson airbox approaches the open-boundary result as padding grows.

- [ ] **Step 3: Compare against Tetmag externally**

Use Tetmag as an external executable/reference data generator for a small fixture. Store only derived numeric reference data and command provenance. Do not vendor or copy Tetmag code into Fullmag native sources.

## 11. Control Room and Diagnostics

**Files:**
- Modify: `apps/control-room/src/modules/footer/FooterTelemetry.tsx`
- Modify: `apps/control-room/src/modules/footer/FooterTelemetry.test.ts`
- Modify: `apps/control-room/src/shared/api/generated/*` through OpenAPI generation only if the diagnostics schema changes

- [ ] **Step 1: Keep status thin**

Do not add full FEM/BEM boundary diagnostics to `/v2/sessions/current/status`.

- [ ] **Step 2: Surface profiler details through diagnostics**

If new solver-profile detail keys are added, expose them only through `diagnostics/solver-profile` and the existing resource hook path.

- [ ] **Step 3: Warn on dense reference mode**

The control room may show `dense_reference` as a diagnostic warning because it is not the production large-mesh BEM operator.

## 12. H2/FMM Production Operator Follow-up

**Files:**
- Create: `docs/superpowers/plans/2026-05-16-fem-bem-demag-h2-fmm-production.md`
- Create or modify native BEM operator files selected during that plan

- [ ] **Step 1: Stop after dense reference passes validation**

Do not mix dense reference correctness and production H2/FMM library integration in the same implementation PR. Dense reference gives a small-mesh oracle and keeps the physics reviewable.

- [ ] **Step 2: Choose production compression explicitly**

The follow-up plan must decide between an external H2 library, FMM, ACA/H-matrix, or a project-owned operator. That decision must include license compatibility, packaging, Windows/Linux support, and GPU roadmap impact.

## 13. Final Verification

Run the narrowest checks while iterating, then the final gate:

```bash
cargo test -p fullmag-ir fredkin_koehler --no-fail-fast
cargo test -p fullmag-plan fredkin_koehler --no-fail-fast
cargo test -p fullmag-runner fem_bem_demag --no-fail-fast
cargo check -p fullmag-cli
pytest packages/fullmag-py/tests/test_api.py -k fredkin_koehler
cmake --build native/build --target demag_boundary_surface_contract demag_lindholm_operator_contract demag_fem_bem_bridge_contract
ctest --test-dir native/build -R "demag_(boundary_surface|lindholm_operator|fem_bem)" --output-on-failure
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room test
pnpm --dir apps/control-room check:api-hygiene
git diff --check
```

Expected final state:

```text
Demag(model="fredkin_koehler") resolves to native FEM/BEM on CPU
resolved provenance is fem_fredkin_koehler
air_box_config is absent
boundary operator mode is reported
small analytical validation passes
profiler shows FEM/BEM demag subphases only when enabled
auto/default demag remains unchanged
```
