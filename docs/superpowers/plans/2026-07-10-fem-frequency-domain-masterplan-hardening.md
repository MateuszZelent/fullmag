# FEM Frequency-Domain Masterplan Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the active FEM frequency-domain documentation into a decision-complete, internally consistent implementation contract for CPU/GPU, `k=0`/nonzero-k, modal eigensolve and driven response.

**Architecture:** Keep equations and SI semantics in `docs/physics`, backend ownership in the backend golden masterplan, and ordered implementation instructions in `docs/plans/active/fd_sovler_masterplan`. Separate normative text from current status and historical evidence, add a machine-readable readiness matrix, and make the full pack a deterministic projection of the manifest instead of an independent source of truth.

**Tech Stack:** Markdown, JSON, Python 3 standard library for documentation generation/static conformance, Fullmag Python DSL, Rust `ProblemIR`, native C++ FEM ABI vocabulary, MFEM/PETSc/SLEPc/hypre/libCEED/CUDA architecture.

## Global Constraints

- Scope is FEM frequency-domain only. FDM frequency-domain implementation is excluded.
- Cover `modal_eigen` and `driven_response`, CPU and GPU, `k=0` and nonzero-k Floquet, with and without dynamic demag.
- `docs/physics/` owns equations, signs, SI units, assumptions and validation semantics.
- `docs/architecture/backend-golden-masterplan.md` owns backend and source-layout authority.
- Do not change solver code, public APIs or runtime behavior during this documentation pass.
- Do not run tests, builds, managed runtimes, examples or solver workloads during this pass.
- Read-only text inspection commands are allowed; runtime status must not be promoted from unexecuted code inspection.
- Preserve unrelated worktree changes. Stage and commit only files listed in each task.
- Normative files must contain no `TODO`, `TBD`, unresolved alternatives or dated append-only evidence logs.
- Historical evidence remains available under `docs/plans/active/fd_sovler_masterplan/old/` but is excluded from canonical read order.
- Every production claim must state `implementation_state`, `validation_state` and `validated_scope`.
- `production_executable` is not equivalent to `production_qualified`.
- Strict GPU requests never fall back to CPU. Any non-strict fallback is explicit in plan and provenance.
- Effective fields use `A/m`; the precession coefficient is `gamma0 = mu0 * abs(gamma)`.
- Canonical phasor convention is `exp(+i*omega*t)` and canonical modal mapping is `lambda = i*omega`.
- The v1 production Poisson-airbox topology is x/y periodic and open in z. Fully periodic 3D `k=0` demag is outside scope until a macroscopic-field convention is accepted.
- The generated full pack is never edited as an independent source of truth.
- Parallel plan `2026-07-10-fem-dynamic-solver-remediation.md` owns
  `docs/physics/0700-frequency-domain-linearized-llg.md`,
  `0828-fem-frequency-domain-floquet-demag.md`,
  `0830-fem-poisson-airbox-modal-eigen.md`,
  `0831-fem-dynamic-pencil-modal-response-and-krylov.md`, and
  `docs/specs/capability-matrix-v0.{md,json}`. This documentation plan consumes
  those files and must not overwrite their concurrent edits.
- Preserve and classify the parallel status document
  `20_dynamic_solver_audit_revalidation_and_remediation.md`; this plan owns new
  active-root numbers 23 through 25.

---

## File Structure

### Canonical Physics And Architecture

- Consume `docs/physics/0700-frequency-domain-linearized-llg.md`: common modal/driven LLG contract, phasor, damping and observables.
- Consume `docs/physics/0828-fem-frequency-domain-floquet-demag.md`: nonzero-k magnetic/scalar-potential Floquet semantics.
- Consume `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`: K0 descriptor, BC/gauge and residual semantics.
- Consume `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`: single operator sign/unit/scaling dictionary owned by the parallel remediation plan.
- Modify `docs/architecture/backend-golden-masterplan.md`: CPU/GPU solver ownership.
- Consume `docs/specs/capability-matrix-v0.{md,json}`: capability status owned by the parallel remediation plan.
- Modify `docs/specs/frequency-domain-artifacts-v2.md`: modal/driven artifact contract.

### Canonical Active Masterplan

- Modify `docs/plans/active/fd_sovler_masterplan/00_README_CANONICAL_FULL_READ.md`.
- Modify `docs/plans/active/fd_sovler_masterplan/01_full_read_inventory_and_resolution.md`.
- Modify `docs/plans/active/fd_sovler_masterplan/02_physics_contract.md` through `15_self_weryfication_Kittel.md` as assigned below.
- Replace `16_implementation_plan_Kittel_D2.md` with `16_end_to_end_fem_frequency_domain_implementation.md`.
- Replace `17_eigen_k0_gpu_readiness_audit.md`.
- Replace `18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`.
- Replace `19_eigensolve_frequency_driven_physics_numerics_audit.md`.
- Preserve and classify `20_dynamic_solver_audit_revalidation_and_remediation.md`.
- Create `23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md`.
- Create `24_production_definition_of_done.md`.
- Create `25_frequency_domain_readiness_matrix.json`.
- Modify `documentation_manifest.json`.
- Regenerate `fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md`.

### Historical Snapshots

Create under `docs/plans/active/fd_sovler_masterplan/old/`:

```text
09_validation_certification_benchmarks_legacy_2026-07-10.md
10_patch_queue_current_status_legacy_2026-07-10.md
11_runtime_telemetry_performance_legacy_2026-07-10.md
16_implementation_plan_Kittel_D2_completed_2026-07-10.md
17_eigen_k0_gpu_readiness_audit_legacy_2026-07-10.md
18_poisson_airbox_eigensolve_cpu_gpu_legacy_2026-07-10.md
19_physics_numerics_audit_original_2026-07-10.md
```

### Documentation Tooling

- Create `scripts/build_fd_solver_masterplan_full_pack.py`.
- Create `scripts/check_fd_solver_masterplan_contract.py`.

---

### Task 1: Freeze History And Establish Document Roles

**Files:**
- Create: the seven historical snapshots listed above.
- Modify: `docs/plans/active/fd_sovler_masterplan/documentation_manifest.json:1-136`.
- Modify: `docs/plans/active/fd_sovler_masterplan/00_README_CANONICAL_FULL_READ.md:1-115`.
- Modify: `docs/plans/active/fd_sovler_masterplan/01_full_read_inventory_and_resolution.md:1-161`.
- Modify: `docs/plans/active/fd_sovler_masterplan/13_repo_migration_cleanup.md:1-63`.

**Interfaces:**
- Consumes: current V5 active files as immutable historical evidence.
- Produces: role vocabulary, canonical read order and archived evidence paths used by every later task.

- [ ] **Step 1: Preserve append-only source text**

Copy the exact current bodies into the dated snapshots. Prepend:

```markdown
> Historical snapshot captured on 2026-07-10. This file is excluded from the
> canonical read order and must not define current physics, algorithms or
> implementation status.
```

Do not semantically edit the preserved body.

- [ ] **Step 2: Replace the manifest shape**

Use:

```json
{
  "schema_version": "frequency_domain_documentation_manifest.v2",
  "package_version": "COMSOL-aligned v5.1 decision-complete",
  "updated_at": "2026-07-10",
  "entrypoint": "00_README_CANONICAL_FULL_READ.md",
  "full_pack": "fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md",
  "full_pack_generated": true,
  "documents": [],
  "historical_roots": ["old/"],
  "readiness_matrix": "25_frequency_domain_readiness_matrix.json"
}
```

Every document entry contains `order`, `path`, `role`, and
`include_in_full_pack`. Roles are `normative`, `validation`,
`implementation_status`, or `supporting`. No active-root file is historical.
The JSON readiness entry uses `include_in_full_pack=false`; the Markdown status
chapter links it instead of duplicating its body.

Classify:

```text
normative: 00, 02-08, 12, 16, 18, 23, 24
validation: 09, 15
implementation_status: 10, 11, 17, 19, 20, 25
supporting: 01, 13, 14
```

- [ ] **Step 3: Rewrite README and inventory policy**

State the hierarchy:

```text
docs/physics -> equations and units
docs/architecture/docs/specs -> ownership and public architecture
masterplan normative docs -> implementation order
status/readiness docs -> current evidence only
old/ -> historical, never normative
```

Remove dated Patch B-J claims from the README. Add separate read orders for
implementers and status auditors. State FDM is out of scope and runtime gates,
not documentation, establish production proof.

- [ ] **Step 4: Update migration policy**

`13_repo_migration_cleanup.md` must forbid active-root historical diaries and
must define the generated full pack as non-authoritative.

- [ ] **Step 5: Perform text-only review**

```bash
rg -n '"role"|"include_in_full_pack"|"readiness_matrix"' docs/plans/active/fd_sovler_masterplan/documentation_manifest.json
rg -n 'historical|normative|implementation_status|validation' docs/plans/active/fd_sovler_masterplan/00_README_CANONICAL_FULL_READ.md
```

Expected: one explicit hierarchy and no independent full-pack authority.

- [ ] **Step 6: Commit**

```bash
git add docs/plans/active/fd_sovler_masterplan/00_README_CANONICAL_FULL_READ.md docs/plans/active/fd_sovler_masterplan/01_full_read_inventory_and_resolution.md docs/plans/active/fd_sovler_masterplan/13_repo_migration_cleanup.md docs/plans/active/fd_sovler_masterplan/documentation_manifest.json docs/plans/active/fd_sovler_masterplan/old
git commit -m "Separate canonical frequency docs from history"
```

---

### Task 2: Close The Physics, Sign And Unit Contract

**Files:**
- Consume without editing: `docs/physics/0700-frequency-domain-linearized-llg.md`.
- Consume without editing: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`.
- Consume without editing: `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md` from the parallel remediation plan.
- Modify: `docs/plans/active/fd_sovler_masterplan/02_physics_contract.md:1-198`.
- Modify: `docs/plans/active/fd_sovler_masterplan/05_algebra_and_operator_representations.md:1-128`.
- Modify: `docs/plans/active/fd_sovler_masterplan/12_adr_decisions.md:1-104`.

**Interfaces:**
- Consumes: `exp(+i*omega*t)` and fields in `A/m`.
- Produces: masterplan summaries and ADRs aligned to the parallel plan's
  `FrequencyOperatorDictionary.v1`.

- [ ] **Step 1: Consume the normative dictionary**

Confirm the parallel-owned note 0831 defines:

```text
gamma0 = mu0 * abs(gamma)
m = m0 + Re(delta_m exp(+i omega t))
i omega delta_m =
  -gamma0 [m0 x delta_h_eff[delta_m] + delta_m x h_eff0]
  + i omega alpha (m0 x delta_m)
  + tau_lin[delta_m]

L q = lambda B q, lambda = i omega
(i omega B - L) q = b
b = T^T[-gamma0 (m0 x delta_h_drive)]
K phi = -i omega G phi
B = -G when L=K is the physical energy-Hessian form
```

The masterplan must link that note as the authority for units and the general
real split:

```text
D(omega) = i*omega*B - L = D_R + i D_I
[D_R -D_I; D_I D_R] [q_R; q_I] = [b_R; b_I]
```

Do not reuse `[K,+omega*M;-omega*M,K]` without mapping `K/M` to `-L/B`.

- [ ] **Step 2: Mirror damping and observables without redefining them**

Specify:

```text
omega_complex = omega_r + i Gamma
exp(i omega_complex t) = exp(i omega_r t - Gamma t)
Gamma > 0 for decay
damping_rate_hz = Gamma/(2*pi)
linewidth_fwhm_hz = Gamma/pi
p_abs = -0.5*mu0*Ms*omega*Im(conj(h_drive) dot delta_m)
observable = absorbed_by_magnetization
```

`02` and `05` summarize these rules and link note 0831. They must not introduce
a competing sign or linewidth convention.

- [ ] **Step 3: Correct gamma tokens**

Replace undefined `gamma` on `A/m` fields with `gamma0` in active masterplan
equations only. Preserve `gamma` only when explicitly defined in `rad/(s*T)`.

- [ ] **Step 4: Close branch and spectral-target mapping**

Require:

```text
lambda = lambda_r + i lambda_i
omega = -i lambda
positive undamped branch: lambda_i > 0
frequency_hz = Re(omega)/(2*pi) = lambda_i/(2*pi)
```

The masterplan links the parallel physics note's explicit real-split
representation of `sigma=i*omega_target` and forbids a real
`EPSSetTarget(omega_target)` unless a separately named real-frequency pencil
is derived.

- [ ] **Step 5: Align masterplan algebra and ADRs**

Add ADR-014 through ADR-019 for `gamma0`, sign dictionary, BC/gauge tuple,
real-PETSc target, blockwise residual and non-Hermitian damping policy.

- [ ] **Step 6: Perform text-only review**

```bash
rg -n --glob '*.md' --glob '!old/**' '\- gamma |\-gamma |b = -gamma ' docs/plans/active/fd_sovler_masterplan docs/physics/0700-frequency-domain-linearized-llg.md docs/physics/0830-fem-poisson-airbox-modal-eigen.md docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md
rg -n 'lambda = i omega|sigma=i\*omega_target|absorbed_by_magnetization' docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md
```

Expected: no undefined `gamma` and one complete sign mapping.

- [ ] **Step 7: Commit**

```bash
git add docs/plans/active/fd_sovler_masterplan/02_physics_contract.md docs/plans/active/fd_sovler_masterplan/05_algebra_and_operator_representations.md docs/plans/active/fd_sovler_masterplan/12_adr_decisions.md
git commit -m "Close frequency-domain sign and unit contracts"
```

---

### Task 3: Close Equilibrium, Mesh, PBC And Floquet Contracts

**Files:**
- Modify: `docs/plans/active/fd_sovler_masterplan/03_relaxed_texture_linearization.md:1-130`.
- Modify: `docs/plans/active/fd_sovler_masterplan/04_mesh_periodic_floquet_airbox.md:1-107`.
- Consume without editing: `docs/physics/0828-fem-frequency-domain-floquet-demag.md`.
- Consume without editing: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`.

**Interfaces:**
- Consumes: `FrequencyOperatorDictionary.v1` from Task 2.
- Produces: `EquilibriumArtifact.v6`, `LinearizationState.v6`, and
  `periodic_mesh_certificate.v6` documentation contracts.

- [ ] **Step 1: Define accepted equilibrium inputs and invalidation**

Require:

```json
{
  "accepted_for_linearization": true,
  "stop_reason": "torque_tolerance",
  "m0": "fields/m0_unit.zarr",
  "h_eff0_a_per_m": "fields/h_eff0_a_per_m.zarr",
  "h_demag0_a_per_m": "fields/h_demag0_a_per_m.zarr",
  "phi0_a": "fields/phi_demag0_a.zarr",
  "mesh_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "material_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "physics_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "boundary_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "static_demag_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "max_m0_norm_error": 0.0,
  "max_m0_cross_h_eff0_relative": 0.0
}
```

`phi0` is optional only when the selected demag realization does not need its
restart/provenance. Recomputed static fields must share signatures and be
compared to stored fields; they cannot silently replace them.
The documents must label these as target v6 contracts and retain an explicit
current-v5-to-target-v6 migration table; they must not claim v6 runtime support
before the corresponding schemas and consumers are implemented.

- [ ] **Step 2: Define complete periodic equivalence classes**

Replace pair-only language with:

```text
representative_dof
members[]
translation_from_representative[]
orientation_transform[]
material_region
boundary_role
```

Corners and edges belong to one class and cannot receive contradictory
duplicate constraints. Record class/pair counts, orientation and translation
residuals, topology match, and separate magnetic/scalar hashes.

- [ ] **Step 3: Define tangent-frame gauge invariance**

Use:

```text
G_pair = T_dst^T R T_src
q_dst = exp(-i*k dot translation) G_pair q_src
```

Require arbitrary local SO(2) tangent-frame rotations to preserve eigenvalues
and reconstructed Cartesian fields under the corresponding coordinate change.

- [ ] **Step 4: Close K0 BC and gauge tuple**

Specify:

```text
poisson_robin(beta>0) -> gauge_policy=none, no eta row
poisson_dirichlet     -> gauge_policy=none, eliminated boundary DOFs, no eta row
pure_neumann          -> gauge_policy=mean_zero_augmented, eta row present
```

The mean functional `c` comes from the active scalar FE space and quadrature.
It may contain zeros on eliminated/inactive entries. A global strictly-positive
weight rule is forbidden.

- [ ] **Step 5: Close nonzero-k representation choice**

Follow the higher-authority physics notes `0828` and `0830`: the production
nonzero-k dynamic-demag operator uses complex Bloch `grad_k`/`div_k` assembly.
Matched-mesh complex constraints remain the independent reference/oracle:

```text
q_full = C_m(k) q_reduced
phi_full = C_phi(k) phi_reduced
A_reduced(k) = C(k)^H A_full C(k)
```

Both fields use `exp(-i*k dot R)`. The constrained and `grad_k`/`div_k`
representations may be called equivalent only after matrix/action parity over
the accepted k domain. Postsolve phase projection is not an operator.

- [ ] **Step 6: Perform text-only review**

```bash
rg -n 'strictly positive|mean_zero_augmented|poisson_robin|poisson_dirichlet|pure_neumann' docs/plans/active/fd_sovler_masterplan/03_relaxed_texture_linearization.md docs/plans/active/fd_sovler_masterplan/04_mesh_periodic_floquet_airbox.md docs/physics/0828-fem-frequency-domain-floquet-demag.md docs/physics/0830-fem-poisson-airbox-modal-eigen.md
```

Expected: no unconditional mean-zero production policy; magnetic/scalar fields
share one phase convention.

- [ ] **Step 7: Commit**

```bash
git add docs/plans/active/fd_sovler_masterplan/03_relaxed_texture_linearization.md docs/plans/active/fd_sovler_masterplan/04_mesh_periodic_floquet_airbox.md
git commit -m "Close equilibrium and Floquet mesh contracts"
```

---

### Task 4: Specify The End-To-End Public And Native Data Flow

**Files:**
- Delete after archival: `docs/plans/active/fd_sovler_masterplan/16_implementation_plan_Kittel_D2.md`.
- Create: `docs/plans/active/fd_sovler_masterplan/16_end_to_end_fem_frequency_domain_implementation.md`.
- Modify: `docs/plans/active/fd_sovler_masterplan/07_api_abi_artifacts.md:1-106`.
- Modify: `docs/specs/frequency-domain-artifacts-v2.md`.

**Interfaces:**
- Consumes: Tasks 2-3 physics/equilibrium/mesh contracts.
- Produces: field-by-field Python/IR/planner/native/artifact/API/UI traceability.

- [ ] **Step 1: Define the mandatory stage order**

Create file 16 with:

```text
Python DSL / UI authoring
ProblemIR lowering
semantic validation
capability and requested/resolved execution planning
EquilibriumArtifact -> LinearizationState
periodic/Floquet certificate
native request materialization
MFEM operator/block assembly
FrequencySolvePlanner
single selected engine
full residual certification
artifact publication
OpenAPI/resource/UI inspection
```

- [ ] **Step 2: Add modal traceability**

Rows:

```text
frequency window/count
k sampling and phase convention
equilibrium source/artifact id
include_demag and magnetostatic_bc
outer boundary and Robin beta
requested device/precision
solver method and spectral transform
normalization and output fields
```

For each row include exact Python, `StudyIR`, plan, native ABI and artifact
names, units/default, validation owner and unsupported behavior. Use names from
current code. Mark a missing field `contract_gap`; do not invent it as
implemented.

- [ ] **Step 3: Add driven-response traceability**

Rows:

```text
frequency sweep
dynamic field phasor real/imag in A/m
drive_kind and zero-drive policy
k sampling and BC
normalization and observables
solver method/preconditioner/rtol/max/restart
requested device/precision
progress/snapshot policy
```

Differentiate physical drive from internal tangent RHS and legacy ABI lane
names from target engine names.

- [ ] **Step 4: Close ABI memory/version semantics**

`07_api_abi_artifacts.md` defines:

```text
abi_version/struct_size negotiation
uint32 enums and FFI-normalized booleans
pointer length/nullability
real/imag layout and node ordering
host/device ownership
result allocation/release
error and diagnostics lifetime
backward compatibility
```

Add a current-vs-target table. Do not claim the target stable ABI exists.

- [ ] **Step 5: Align artifact specification**

Add:

```text
physics_contract_version
operator_dictionary_version
requested_execution/resolved_execution
implementation_state/validation_state/validated_scope
assembly_kind
phase and equilibrium/certificate hashes
BC/gauge tuple
spectral scalar mode and sigma
block residuals
device residency and fallback
```

- [ ] **Step 6: Perform text-only review**

```bash
rg -n 'contract_gap|Python|ProblemIR|native ABI|artifact|OpenAPI|UI' docs/plans/active/fd_sovler_masterplan/16_end_to_end_fem_frequency_domain_implementation.md
rg -n 'abi_version|struct_size|ownership|release|current.*target' docs/plans/active/fd_sovler_masterplan/07_api_abi_artifacts.md
```

Expected: complete cross-layer tables and explicit gaps.

- [ ] **Step 7: Commit**

```bash
git add docs/plans/active/fd_sovler_masterplan/07_api_abi_artifacts.md docs/plans/active/fd_sovler_masterplan/16_implementation_plan_Kittel_D2.md docs/plans/active/fd_sovler_masterplan/16_end_to_end_fem_frequency_domain_implementation.md docs/specs/frequency-domain-artifacts-v2.md
git commit -m "Specify end-to-end frequency-domain contracts"
```

---

### Task 5: Specify Planner And CPU/GPU Solver Engines

**Files:**
- Modify: `docs/plans/active/fd_sovler_masterplan/06_solver_tree_planner_and_lanes.md:1-106`.
- Modify: `docs/plans/active/fd_sovler_masterplan/08_backend_algorithms_and_status.md:1-179`.
- Modify: `docs/architecture/backend-golden-masterplan.md:260-445`.

**Interfaces:**
- Consumes: traceability from Task 4.
- Produces: deterministic planner policy and engine definitions.

- [ ] **Step 1: Separate target engines from legacy ABI lanes**

Normative engines:

```text
dense_cartesian_reference
dense_tangent_reference
cpu_sparse_direct
cpu_host_krylov
full_coupled_field_split
schur_reduced
modal_reduced
gpu_operator_host_krylov
gpu_device_krylov
gpu_modal_device_krylov
```

Legacy `validation`, `production_cpu`, `production_gpu` resolve to one explicit
engine in diagnostics.

- [ ] **Step 2: Define ordered legality planning**

Use:

```text
1 validate physics, phase, equilibrium, BC and mesh certificates
2 resolve explicit device, precision and solver method
3 reject strict unavailable requests; record legal non-strict fallback
4 build legal candidates for product/algebra
5 filter by problem-signature certificates and memory
6 apply performance heuristics among legal candidates
7 emit exactly one engine and selection reason
```

Invariants:

```text
CPU cannot become GPU from prefer_existing_host_krylov
forced GPU cannot be preempted by CPU sparse-direct
nonzero-k demag cannot select K0 operator
Schur requires a problem-keyed certificate
modal-reduced requires completeness and sample checks
```

- [ ] **Step 3: Specify CPU algorithms**

Define matrix/scalar properties, solver, transform, preconditioner, residual
and fallback for:

```text
dense Cartesian/tangent oracle
P1 shared-domain MFEM assembly
PETSc AIJ sparse-direct diagnostic
SLEPc full descriptor selected spectrum
SLEPc Schur MatShell selected spectrum
PETSc MatNest/PCFIELDSPLIT driven solve
certified Schur-reduced driven solve
modal/rational/recycling sweep
```

- [ ] **Step 4: Specify GPU algorithms**

Primary path:

```text
MFEM/libCEED/CUDA operator apply
PETSc CUDA vectors and MatShell/MatNest
hypre device Poisson/shifted preconditioner
PETSc KSP GMRES/FGMRES for driven response
SLEPc Krylov-Schur/Arnoldi for modal spectrum
```

Host orchestration and bounded scalar reductions are allowed. Per-iteration
vector/matrix host migration is forbidden for a device-resident claim. A
custom Krylov loop is considered only after the library path is shown unable
to meet the contract.

- [ ] **Step 5: Align backend ownership**

Production code lives under `backends/fem/cpu/frequency_domain/` and
`backends/fem/gpu/cuda/frequency_domain/`. Runner owns orchestration, ABI and
artifacts, not production MFEM assembly or GPU Krylov state.

- [ ] **Step 6: Perform text-only review**

```bash
rg -n 'prefer_existing_host_krylov|strict GPU|sparse-direct|exactly one|legacy' docs/plans/active/fd_sovler_masterplan/06_solver_tree_planner_and_lanes.md
rg -n 'PETSc|SLEPc|MFEM|hypre|libCEED|device' docs/plans/active/fd_sovler_masterplan/08_backend_algorithms_and_status.md docs/architecture/backend-golden-masterplan.md
```

Expected: explicit intent precedes heuristics; GPU labels are device-honest.

- [ ] **Step 7: Commit**

```bash
git add docs/plans/active/fd_sovler_masterplan/06_solver_tree_planner_and_lanes.md docs/plans/active/fd_sovler_masterplan/08_backend_algorithms_and_status.md docs/architecture/backend-golden-masterplan.md
git commit -m "Define frequency-domain planner and engine policy"
```

---

### Task 6: Rewrite The K0 Poisson-Airbox Implementation Contract

**Files:**
- Replace: `docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md:1-4013`.
- Reference: `docs/superpowers/specs/2026-07-09-real-fem-poisson-airbox-modal-design.md`.
- Reference: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`.

**Interfaces:**
- Consumes: Tasks 2-5 contracts.
- Produces: implementable K0 modal and driven Poisson-airbox assembly/solve contract.

- [ ] **Step 1: Replace the append-only plan**

Use sections:

```text
1 scope and current-vs-target boundary
2 mathematical model and FE spaces
3 shared-domain P1 assembly
4 periodic reduction and outer BC
5 descriptor and driven block systems
6 CPU selected-spectrum algorithm
7 CPU driven field-split algorithm
8 certified Schur algorithms
9 GPU persistent context and solvers
10 artifacts and exact rejection reasons
11 implementation sequence
12 definition of done
```

No dated evidence belongs in this normative file.

- [ ] **Step 2: Define FE spaces and forms**

Specify:

```text
q: two tangent P1 magnetic DOFs per active magnetic node
phi: scalar P1 DOFs on the shared magnetic-plus-air domain
P_ij = integral_D grad(N_i) dot grad(N_j) dV + Robin term
C_phi_q = integral_Omega_m Ms*T*q dot grad(psi) dV
A_qphi = projected -gamma0*m0 x (-grad(phi)) feedback
B_qq = gyrotropic/damping mass form from operator dictionary
A_qq = static restoring plus accepted local/exchange/DMI derivatives
```

Give row/column ordering and units. `A_qphi` and `A_phiq` use the same
quadrature/material source and must pass reciprocity/energy checks.

- [ ] **Step 3: Define modal and driven systems**

```text
modal:  A x = lambda B x
driven: (i*omega*B - A) x = [b_q, b_phi, 0]
x = [q,phi] or [q,phi,eta]
```

Define Dirichlet elimination, Robin no-gauge, Neumann augmentation, finite-mode
filtering, positive branch, full reconstruction and common block scaling.

- [ ] **Step 4: Define real-PETSc selected spectrum**

Show the real-split block pencil for complex `A`, `B` and
`sigma=i*omega_target`. `EPS_TARGET_MAGNITUDE` is legal only after the target
is represented correctly. Require a multi-mode interior-window case that
detects a real-axis shift error.

- [ ] **Step 5: Define GPU promotion labels**

```text
gpu_dense_contract_eigensolver
gpu_descriptor_apply_probe
gpu_shifted_apply_probe
gpu_persistent_operator_context
gpu_modal_device_krylov
gpu_device_krylov
```

Only the final two are scalable solver claims. Specify persistent allocation,
Ritz extraction, restart, convergence, shifted preconditioning and transfer
audit.

- [ ] **Step 6: Define implementation stages**

```text
K0-P1 manufactured scalar Poisson assembly
K0-P2 reciprocal magnetic/scalar coupling
K0-P3 real full descriptor assembly
K0-P4 CPU sparse-direct and SLEPc parity
K0-P5 residual and finite-mode certification
K0-P6 real-film Kittel convergence
K0-P7 CPU driven full-coupled/modal cross-check
K0-G1 GPU operator and Poisson parity
K0-G2 persistent shifted solve
K0-G3 GPU modal/driven Krylov
K0-G4 CPU/GPU production qualification
```

For every stage list owner paths, inputs, outputs, artifacts, rejection reasons
and promotion gates.

- [ ] **Step 7: Perform text-only review**

```bash
rg -n 'current mandatory next patch|Task 4.*mean-zero|strictly positive.*weights|expected_reference_frequency.*builder' docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md
rg -n 'poisson_robin|poisson_dirichlet|pure_neumann|sigma=i|eps_full|gpu_modal_device_krylov' docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md
```

Expected: first search has no stale matches; second covers closed contracts.

- [ ] **Step 8: Commit**

```bash
git add docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md
git commit -m "Rewrite K0 Poisson-airbox implementation contract"
```

---

### Task 7: Add The Nonzero-K Floquet-Airbox Implementation Contract

**Files:**
- Create: `docs/plans/active/fd_sovler_masterplan/23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md`.
- Consume without editing: `docs/physics/0828-fem-frequency-domain-floquet-demag.md`.

**Interfaces:**
- Consumes: Task 6 K0 blocks and Task 3 constraints.
- Produces: a production `grad_k`/`div_k` algorithm for nonzero-k dynamic demag
  on CPU/GPU, plus an independent matched-mesh constraint oracle.

- [ ] **Step 1: Define the production operator and constraint oracle**

The production dynamic-demag operator is complex Bloch `grad_k`/`div_k`
assembly, as required by physics note `0828`. Define its block forms,
material/air-domain semantics and `k` units first. The following matched-mesh
reduction is a pre-solve oracle, not a replacement production operator:

```text
C_m(k): exp(-i*k dot R) plus tangent G_pair
C_phi(k): exp(-i*k dot R)
A_qq(k) = C_m^H A_qq C_m
A_qphi(k) = C_m^H A_qphi C_phi
A_phiq(k) = C_phi^H A_phiq C_m
P(k) = C_phi^H P C_phi
B_qq(k) = C_m^H B_qq C_m
```

Apply Robin only to open-z faces, never periodic cuts. Define `k` in `rad/m`,
reciprocal-cell wrapping and Gamma tolerance. Distinguish periodic cell
amplitudes from physical reconstructions carrying `exp(-i*k dot r)`. The
`grad_k`/`div_k` and constrained forms require a matching Bloch-enriched
basis/interpolation map for raw matrix/action parity; otherwise certify only
bounded convergence and observable parity over the accepted k domain.

- [ ] **Step 2: Define CPU stages**

```text
NK-P1 no-demag exchange/local phase parity
NK-P2 scalar Poisson manufactured Bloch solution
NK-P3 full dynamic demag-k assembly
NK-P4 CPU selected spectrum and driven response
NK-P5 DE/BV dispersion and K0 limit
```

Require `A(k=0)` parity with Task 6. A `k <-> -k` gate requires an explicit
geometry/material/equilibrium/BC symmetry map, cluster/branch matching, and
transformed drive/observation pair; it is not inferred merely from the
absence of DMI or another nonreciprocal term.

- [ ] **Step 3: Define GPU stages**

```text
NK-G1 complex constraint apply parity
NK-G2 device Poisson/shifted solve parity
NK-G3 persistent modal/driven device Krylov
NK-G4 DE/BV CPU/GPU parity and transfer audit
```

No postsolve phase projection can satisfy an operator gate.

- [ ] **Step 4: Define exact rejection reasons**

```text
missing_floquet_pair_equivalence_classes
missing_floquet_magnetic_constraint_operator
missing_floquet_scalar_constraint_operator
missing_numeric_fem_demag_k
nonzero_k_gpu_modal_operator_unavailable
nonzero_k_gpu_driven_operator_unavailable
```

No fallback to K0, open boundaries, synthetic operators or CPU for strict GPU.

- [ ] **Step 5: Perform text-only review**

```bash
rg -n 'C_m\(k\)|C_phi\(k\)|A_qphi\(k\)|P\(k\)|rad/m|open-z' docs/plans/active/fd_sovler_masterplan/23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md
rg -n 'postsolve phase projection|fallback|missing_numeric_fem_demag_k' docs/plans/active/fd_sovler_masterplan/23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md
```

Expected: magnetic/scalar blocks share one phase and fail explicitly when absent.

- [ ] **Step 6: Commit**

```bash
git add docs/plans/active/fd_sovler_masterplan/23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md
git commit -m "Specify nonzero-k Floquet-airbox implementation"
```

---

### Task 8: Rebuild Validation, Kittel And Production Definition Of Done

**Files:**
- Replace: `docs/plans/active/fd_sovler_masterplan/09_validation_certification_benchmarks.md:1-376`.
- Modify: `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md:1-1221`.
- Create: `docs/plans/active/fd_sovler_masterplan/24_production_definition_of_done.md`.

**Interfaces:**
- Consumes: Tasks 6-7 algorithms.
- Produces: independent validation gates controlling readiness.

- [ ] **Step 1: Replace evidence diary with validation matrix**

Sections:

```text
physics gates
manufactured assembly gates
algebra parity gates
modal gates
driven gates
periodic/Floquet gates
CPU/GPU parity gates
performance/residency gates
artifact/provenance gates
```

Every gate defines fixture, independent oracle, metric, initial/production
tolerance, artifacts and promotable readiness cells.

- [ ] **Step 2: Harden Kittel independence**

Require:

```text
expected Kittel frequency and fitted M_eff are verifier outputs only
assembly cannot consume expected frequency, fitted M_eff or Kittel demag_delta
K0-3 uses x/y PBC, open z, symmetric top/bottom airbox
minimum three mesh levels
minimum three airbox-padding levels at fixed magnetic mesh
at least 15 fields for extended validation; fast CI may use a documented subset
near-zero field is optional and cannot replace positive-bias gates
```

Select modes by uniform overlap, branch continuity, residual, tangent leakage
and seam mismatch, not nearest expected frequency alone.

- [ ] **Step 3: Define convergence acceptance**

Require raw levels, monotonicity or asymptotic fit, observed order where
applicable, Richardson/finest-two delta, separate mesh/truncation budgets and
no duplicated synthetic rows.

- [ ] **Step 4: Create product definition of done**

Checklist:

```text
physics note
Python/UI round-trip
ProblemIR validation
planner legality
equilibrium/mesh certificates
native assembly
solver engine
full residual
artifacts/OpenAPI/UI
analytical validation
convergence
CPU/GPU parity
performance/residency
release regression
```

`production_qualified` requires every applicable item for the exact
`validated_scope`.

- [ ] **Step 5: Perform text-only review**

```bash
rg -n 'expected.*builder|demag_delta.*Kittel|nearest expected frequency' docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md
rg -n 'three mesh|airbox.padding|15 field|independent oracle|validated_scope' docs/plans/active/fd_sovler_masterplan/09_validation_certification_benchmarks.md docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md docs/plans/active/fd_sovler_masterplan/24_production_definition_of_done.md
```

Expected: analytical expectations cannot leak into assembly; scope/convergence
promotion rules are explicit.

- [ ] **Step 6: Commit**

```bash
git add docs/plans/active/fd_sovler_masterplan/09_validation_certification_benchmarks.md docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md docs/plans/active/fd_sovler_masterplan/24_production_definition_of_done.md
git commit -m "Define frequency-domain production validation gates"
```

---

### Task 9: Rebuild Readiness, Audit And Telemetry Truth

**Files:**
- Replace: `docs/plans/active/fd_sovler_masterplan/10_patch_queue_current_status.md:1-1958`.
- Replace: `docs/plans/active/fd_sovler_masterplan/11_runtime_telemetry_performance.md:1-426`.
- Replace: `docs/plans/active/fd_sovler_masterplan/17_eigen_k0_gpu_readiness_audit.md:1-249`.
- Replace: `docs/plans/active/fd_sovler_masterplan/19_eigensolve_frequency_driven_physics_numerics_audit.md:1-981`.
- Create: `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_matrix.json`.
- Consume without editing: `docs/specs/capability-matrix-v0.{md,json}`.

**Interfaces:**
- Consumes: Task 8 production gates.
- Produces: one current status source for README, capability docs and future UI/provenance.

- [ ] **Step 1: Create readiness schema and cells**

Use:

```json
{
  "schema_version": "frequency_domain_readiness_matrix.v1",
  "as_of": "2026-07-10",
  "status_source": "static_code_and_existing_repository_evidence",
  "runtime_revalidated_in_this_update": false,
  "cells": [
    {
      "study_product": "modal_eigen",
      "device": "cpu",
      "wavevector_scope": "k0",
      "demag_scope": "none",
      "implementation_state": "executable",
      "validation_state": "physics_validated",
      "validated_scope": "macrospin_larmor_field_sweep",
      "evidence": [],
      "open_blockers": []
    }
  ]
}
```

Cover the base Cartesian product:

```text
2 products x 2 devices x 2 k scopes x 2 demag scopes
```

Split a cell when a narrow realization would otherwise overclaim, such as GPU
K0 no-demag macrospin versus general GPU K0 modal.

- [ ] **Step 2: Populate status conservatively**

Use current source and previously recorded managed evidence. Keep
`runtime_revalidated_in_this_update=false`. Preserve at minimum:

```text
GPU K0 no-demag macrospin modal: narrow physics_validated scope
GPU K0 Poisson-airbox modal: not production qualified
CPU K0 real shared-domain Poisson-airbox modal: not production qualified
nonzero-k dynamic demag CPU/GPU: not production qualified
driven periodic_airbox_k0 CPU/GPU: partial executable slices, not blanket qualified
gpu_device_krylov: not executable without a full device loop
```

- [ ] **Step 3: Rewrite current status and GPU audit**

`10` becomes a concise JSON-derived table with implemented, executable,
validated and blocked columns. `17` starts with current GPU status and links to
the legacy audit instead of retaining contradictory before/after matrices.

- [ ] **Step 4: Convert audit 19 into a finding register**

Every F-01 through F-22 records:

```text
severity
affected_scope
finding
required_disposition
documentation_state: open | resolved_in_docs
code_state: open | implemented
verification_state: not_run | runtime_verified
evidence_paths
```

Examples:

```text
F-04 residual min/conjugation: docs resolved; implementation from current source; no new runtime verification
F-13 absorbed power sign: resolved in docs
F-03 real PETSc target: open while code uses real target_omega
F-05/F-06 Kittel geometry/convergence: open without real evidence
```

- [ ] **Step 5: Rewrite telemetry normatively**

`11` defines fields/thresholds rather than chronology:

```text
tracked and true block residuals
modal descriptor residuals
outer/inner iterations and stop reason
Schur/preconditioner quality
Poisson setup/solve counts
progress throttling
CPU/GPU memory and transfer counters
device-residency claim rules
partial/interrupted artifacts
```

- [ ] **Step 6: Record capability-matrix integration requirements**

In `10` and `19`, record that the parallel remediation plan owns correction of
the heading that calls six statuses a "Four-state status vocabulary" and owns
links from the capability matrix to readiness JSON. This plan must not edit the
matrix concurrently. Its own readiness/status text must still explain any
coarse `supports_frequency_response=false` boolean that coexists with a narrow
executable slice.

- [ ] **Step 7: Perform text-only review**

```bash
rg -n 'no real path|slice closed|unsupported.*validated|Four-state' docs/plans/active/fd_sovler_masterplan/10_patch_queue_current_status.md docs/plans/active/fd_sovler_masterplan/17_eigen_k0_gpu_readiness_audit.md
rg -n 'F-0[1-9]|F-1[0-9]|F-2[0-2]' docs/plans/active/fd_sovler_masterplan/19_eigensolve_frequency_driven_physics_numerics_audit.md
```

Expected: all findings have state and current status has no timeline contradiction.

- [ ] **Step 8: Commit**

```bash
git add docs/plans/active/fd_sovler_masterplan/10_patch_queue_current_status.md docs/plans/active/fd_sovler_masterplan/11_runtime_telemetry_performance.md docs/plans/active/fd_sovler_masterplan/17_eigen_k0_gpu_readiness_audit.md docs/plans/active/fd_sovler_masterplan/19_eigensolve_frequency_driven_physics_numerics_audit.md docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_matrix.json
git commit -m "Make frequency-domain readiness claims scope-aware"
```

---

### Task 10: Add Deterministic Full-Pack And Static Contract Tooling

**Files:**
- Create: `scripts/build_fd_solver_masterplan_full_pack.py`.
- Create: `scripts/check_fd_solver_masterplan_contract.py`.
- Modify: `docs/plans/active/fd_sovler_masterplan/14_sources_traceability.md:1-62`.
- Modify: `docs/plans/active/fd_sovler_masterplan/documentation_manifest.json`.
- Replace: `docs/plans/active/fd_sovler_masterplan/fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md:1-1947`.

**Interfaces:**
- Consumes: final canonical docs and readiness JSON.
- Produces: deterministic full pack and future static drift detection.

- [ ] **Step 1: Implement full-pack builder**

Use this complete standard-library implementation shape:

```python
from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_manifest(root: Path) -> dict[str, object]:
    value = json.loads((root / "documentation_manifest.json").read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("documentation manifest must be a JSON object")
    return value


def ordered_full_pack_documents(root: Path, manifest: dict[str, object]) -> list[Path]:
    entries = manifest.get("documents")
    if not isinstance(entries, list):
        raise ValueError("documentation manifest documents must be an array")
    selected: list[tuple[int, Path]] = []
    seen_orders: set[int] = set()
    full_pack = manifest.get("full_pack")
    for raw in entries:
        if not isinstance(raw, dict):
            raise ValueError("documentation manifest entry must be an object")
        if raw.get("include_in_full_pack") is not True:
            continue
        if raw.get("role") == "historical":
            raise ValueError("historical documents cannot enter the full pack")
        order = raw.get("order")
        relative = raw.get("path")
        if not isinstance(order, int) or not isinstance(relative, str):
            raise ValueError("included document requires integer order and string path")
        if order in seen_orders:
            raise ValueError(f"duplicate documentation order: {order}")
        if relative == full_pack or not relative.endswith(".md") or relative.startswith("old/"):
            raise ValueError(f"invalid full-pack input: {relative}")
        path = root / relative
        if not path.is_file():
            raise ValueError(f"missing full-pack input: {relative}")
        seen_orders.add(order)
        selected.append((order, path))
    return [path for _, path in sorted(selected)]


def render_full_pack(root: Path, documents: list[Path]) -> str:
    chunks = ["# Frequency-driven solver - COMSOL-aligned V5.1 full pack\n"]
    for path in documents:
        relative = path.relative_to(root).as_posix()
        body = path.read_text(encoding="utf-8").rstrip()
        chunks.append(f"<!-- BEGIN {relative} -->\n{body}\n<!-- END {relative} -->\n")
    return "\n".join(chunks)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        type=Path,
        default=Path("docs/plans/active/fd_sovler_masterplan"),
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args(argv)
    manifest = load_manifest(args.root)
    output_name = manifest.get("full_pack")
    if not isinstance(output_name, str):
        raise ValueError("documentation manifest full_pack must be a string")
    expected = render_full_pack(
        args.root,
        ordered_full_pack_documents(args.root, manifest),
    )
    output = args.root / output_name
    if args.check:
        return 0 if output.is_file() and output.read_text(encoding="utf-8") == expected else 1
    output.write_text(expected, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

CLI:

```text
python3 scripts/build_fd_solver_masterplan_full_pack.py --check
python3 scripts/build_fd_solver_masterplan_full_pack.py --write
```

Reject duplicate orders, missing paths, historical roles, JSON/PDF inputs and
recursive full-pack inclusion. `--check` reports drift; `--write` writes only
the declared output.

- [ ] **Step 2: Implement static contract checker**

Pure functions validate:

```text
every active Markdown file is classified or explicitly excluded
every manifest path exists
old/ is excluded
normative docs contain no TODO/TBD
normative docs contain no undefined -gamma on A/m fields
Robin/Dirichlet are not paired with mean_zero_augmented
readiness cells have implementation_state, validation_state, validated_scope
F-01 through F-22 appear in audit 19
full pack matches manifest order
```

Use this complete implementation shape:

```python
from __future__ import annotations

import json
import re
from pathlib import Path

from build_fd_solver_masterplan_full_pack import (
    load_manifest,
    ordered_full_pack_documents,
    render_full_pack,
)

ROOT = Path("docs/plans/active/fd_sovler_masterplan")
IMPLEMENTATION_STATES = {"absent", "contract_only", "source_visible", "executable"}
VALIDATION_STATES = {
    "unvalidated",
    "algebra_validated",
    "physics_validated",
    "production_qualified",
}


def manifest_entries(manifest: dict[str, object]) -> list[dict[str, object]]:
    raw = manifest.get("documents")
    if not isinstance(raw, list) or not all(isinstance(item, dict) for item in raw):
        raise ValueError("manifest documents must be an array of objects")
    return raw


def check_manifest(root: Path, manifest: dict[str, object]) -> list[str]:
    errors: list[str] = []
    entries = manifest_entries(manifest)
    declared = {entry.get("path") for entry in entries if isinstance(entry.get("path"), str)}
    full_pack = manifest.get("full_pack")
    allowed = declared | ({full_pack} if isinstance(full_pack, str) else set())
    active_markdown = {path.name for path in root.glob("*.md")}
    for name in sorted(active_markdown - allowed):
        errors.append(f"unclassified active Markdown file: {name}")
    for entry in entries:
        relative = entry.get("path")
        if not isinstance(relative, str):
            errors.append("manifest entry lacks string path")
            continue
        if relative.startswith("old/"):
            errors.append(f"historical path declared active: {relative}")
        if not (root / relative).is_file():
            errors.append(f"manifest path does not exist: {relative}")
    return errors


def check_normative_text(root: Path, manifest: dict[str, object]) -> list[str]:
    errors: list[str] = []
    undefined_gamma = re.compile(r"(?<![A-Za-z0-9_])-\s*gamma(?![A-Za-z0-9_])")
    for entry in manifest_entries(manifest):
        if entry.get("role") != "normative":
            continue
        relative = entry.get("path")
        if not isinstance(relative, str) or not relative.endswith(".md"):
            continue
        text = (root / relative).read_text(encoding="utf-8")
        for token in ("TODO", "TBD"):
            if re.search(rf"\b{token}\b", text):
                errors.append(f"normative placeholder {token}: {relative}")
        for number, line in enumerate(text.splitlines(), start=1):
            if undefined_gamma.search(line):
                errors.append(f"undefined gamma: {relative}:{number}")
            if "mean_zero_augmented" in line and (
                "poisson_robin" in line or "poisson_dirichlet" in line
            ):
                errors.append(f"coercive BC paired with mean-zero gauge: {relative}:{number}")
    return errors


def check_readiness(root: Path, manifest: dict[str, object]) -> list[str]:
    errors: list[str] = []
    relative = manifest.get("readiness_matrix")
    if not isinstance(relative, str):
        return ["manifest readiness_matrix must be a string"]
    payload = json.loads((root / relative).read_text(encoding="utf-8"))
    cells = payload.get("cells") if isinstance(payload, dict) else None
    if not isinstance(cells, list):
        return ["readiness matrix cells must be an array"]
    for index, cell in enumerate(cells):
        if not isinstance(cell, dict):
            errors.append(f"readiness cell {index} must be an object")
            continue
        if cell.get("implementation_state") not in IMPLEMENTATION_STATES:
            errors.append(f"invalid implementation_state in readiness cell {index}")
        if cell.get("validation_state") not in VALIDATION_STATES:
            errors.append(f"invalid validation_state in readiness cell {index}")
        if not isinstance(cell.get("validated_scope"), str):
            errors.append(f"missing validated_scope in readiness cell {index}")
    return errors


def check_audit_findings(root: Path) -> list[str]:
    audit = (root / "19_eigensolve_frequency_driven_physics_numerics_audit.md").read_text(
        encoding="utf-8"
    )
    return [
        f"missing audit finding F-{index:02d}"
        for index in range(1, 23)
        if f"F-{index:02d}" not in audit
    ]


def check_full_pack(root: Path, manifest: dict[str, object]) -> list[str]:
    output_name = manifest.get("full_pack")
    if not isinstance(output_name, str):
        return ["manifest full_pack must be a string"]
    expected = render_full_pack(root, ordered_full_pack_documents(root, manifest))
    output = root / output_name
    if not output.is_file() or output.read_text(encoding="utf-8") != expected:
        return ["generated full pack differs from manifest inputs"]
    return []


def main() -> int:
    manifest = load_manifest(ROOT)
    errors = (
        check_manifest(ROOT, manifest)
        + check_normative_text(ROOT, manifest)
        + check_readiness(ROOT, manifest)
        + check_audit_findings(ROOT)
        + check_full_pack(ROOT, manifest)
    )
    for error in errors:
        print(error)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
```

Do not add/run tests in this text-only pass.

- [ ] **Step 3: Update source traceability**

Map every physics claim to the manual, Fullmag physics note and validation
gate. Distinguish external parity references from Fullmag normative sources.
List current code vocabulary without claiming runtime validation from source.

- [ ] **Step 4: Materialize full pack without running tooling**

Construct the full pack in manifest order while editing. Use markers:

```markdown
<!-- BEGIN path/to/document.md -->
<!-- END path/to/document.md -->
```

The actual document body is inserted verbatim between those two markers by
`render_full_pack`; the markers themselves are the only generated wrapper.

Exclude historical snapshots, PDF, readiness JSON body and full pack itself.

- [ ] **Step 5: Perform final text-only self-review**

Do not run the new scripts. Inspect text/code with:

```bash
rg -n 'TODO|TBD|current mandatory next patch' docs/plans/active/fd_sovler_masterplan --glob '*.md' --glob '!old/**'
rg -n '\- gamma |\-gamma |b = -gamma ' docs/plans/active/fd_sovler_masterplan --glob '*.md' --glob '!old/**'
rg -n 'poisson_(robin|dirichlet).*mean_zero|mean_zero.*poisson_(robin|dirichlet)' docs/plans/active/fd_sovler_masterplan docs/physics/0830-fem-poisson-airbox-modal-eigen.md
git diff --stat
git diff --check
```

Expected: no normative placeholders, undefined gamma, coercive-BC mean-zero
pairing or whitespace errors. Report explicitly that no tests/builds/solvers ran.

- [ ] **Step 6: Commit**

```bash
git add scripts/build_fd_solver_masterplan_full_pack.py scripts/check_fd_solver_masterplan_contract.py docs/plans/active/fd_sovler_masterplan/14_sources_traceability.md docs/plans/active/fd_sovler_masterplan/documentation_manifest.json docs/plans/active/fd_sovler_masterplan/fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md
git commit -m "Make frequency-domain documentation deterministic"
```

---

## Final Review Checklist

- [ ] Every approved design requirement maps to a task.
- [ ] `docs/physics` contains one sign/unit dictionary and no competing formula.
- [ ] K0 Robin/Dirichlet/Neumann gauge semantics are closed.
- [ ] Nonzero-k magnetic and scalar constraints use one Bloch phase.
- [ ] Real PETSc selected-spectrum targeting is specified correctly.
- [ ] CPU/GPU algorithms use explicit established-library ownership.
- [ ] Python, IR, planner, native ABI, artifacts, API and UI are traceable.
- [ ] Kittel expected values cannot enter assembly.
- [ ] Validation includes mesh/airbox convergence, modal/driven parity and CPU/GPU parity.
- [ ] Readiness cannot promote from synthetic or narrow evidence.
- [ ] All 22 audit findings have current states.
- [ ] Historical evidence is preserved but excluded from canonical truth.
- [ ] Full-pack order derives from the manifest.
- [ ] No tests, builds, managed runtimes, examples or solver workloads ran during this pass.
