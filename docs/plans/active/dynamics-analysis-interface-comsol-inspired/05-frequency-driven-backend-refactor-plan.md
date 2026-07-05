# 05 - Frequency-Driven Backend Refactor Plan

Status: active correction plan
Created: 2026-07-04
Scope: FEM frequency-driven response at `k=0` now, with the same operator
family prepared for nonzero-k dispersion later.

## Purpose

This document corrects the backend side of the COMSOL-inspired dynamics plan.
The previous frontend-first plan is not enough: a professional dynamics
interface is only valid when the solver can produce physically correct
frequency-driven results with explicit demag, PBC, provenance, and validation.

The production target is:

1. implement `FrequencyResponse` as a real frequency-driven solver product,
2. make `periodic_airbox_k0` demag a production CPU and GPU slice for driven
   response, not a diagnostic workaround,
3. preserve the same operator contracts for future nonzero-k Floquet demag-k
   and modal dispersion,
4. remove or retire every temporary `unsupported`, `inactive`, `P2`,
   read-only, validation-only, and fallback path from the user-facing success
   path once the matching production implementation exists.

This plan does not replace:

- `docs/physics/0700-frequency-domain-linearized-llg.md`,
- `docs/physics/0710-periodic-and-floquet-boundary-conditions.md`,
- `docs/physics/0828-fem-frequency-domain-floquet-demag.md`,
- `docs/specs/capability-matrix-v0.md`,
- `docs/specs/frequency-domain-artifacts-v2.md`,
- `docs/architecture/backend-golden-masterplan.md`.

Those files remain the source of truth for equations, semantics, capability
language, artifacts, and backend ownership.

## External Reference Corrections

### COMSOL Lessons To Preserve

The local COMSOL Micromagnetics Module manual is a parity reference, not a
semantic authority over Fullmag physics. The useful constraints are:

- Frequency-domain micromagnetics solves the linearized LLG around an
  equilibrium `m0`.
- The dynamic unknowns `dmX`, `dmY`, and `dmZ` are complex phasors.
- The harmonic factor is supplied by the solver. A drive field is a phasor
  amplitude `delta_h` in `A/m`, not a user-authored sine or cosine waveform.
- `Eigenfrequency` and `Frequency Domain` are different study products.
  `Eigenfrequency` returns natural modes and eigenvectors; `Frequency Domain`
  returns forced response at requested frequencies.
- Floquet periodicity applies the dependent-variable phase
  `exp(-i k_F dot (r_dst - r_src))`.
- Dynamic magnetostatic coupling in frequency domain is solved consistently
  with the dynamic micromagnetic unknowns. It is not a postprocessing display
  correction.

Fullmag must keep those product-level semantics while using its own Python DSL,
ProblemIR, planner, runtime, native backend, artifacts, and resource-first
Control Room contracts.

### TetraX Lessons To Preserve

The TetraX implementation under `external_solvers/tetrax/` gives the right
algorithmic shape for spin-wave demag:

- `DynamicMatrix` is a `LinearOperator` whose `set_km(k, m)` call propagates
  the wave number into every spin-wave interaction tensor.
- `DipoleTensor` is matrix-free when needed. It does not pretend that the
  static demag matrix is enough for propagating waves.
- The dipole solve modifies the potential equation with `k^2` terms through
  `poiss - ksquared_mat` / `laplace - ksquared_mat`.
- The magnetostatic source includes complex derivative terms such as
  `i k Ms m_z`.
- Field recovery uses the k-dependent gradient, for example
  `grad_z(psi) + i k psi`.

The Fullmag FEM formulation is different because it uses a shared-domain
airbox, MFEM/hypre/libCEED, explicit CPU/GPU lanes, and a resource-first
runtime. The transferable rule is the operator rule:

```text
static k=0 demag reuse is not dynamic demag-k.
dynamic demag-k must replace grad/div with their Bloch/Floquet phasor forms.
```

For `k=0`, this reduces to real periodic scalar-potential constraints and the
ordinary dynamic tangent demag provider. For future nonzero-k dispersion, the
same contract becomes a complex Bloch/Floquet scalar-potential operator.

## Correct Physics Contract

The driven response product solves:

```text
(i omega B - A) q = b
```

where `q` is the tangent dynamic magnetization phasor. With demag enabled,
the operator must include the dynamic scalar potential contribution:

```text
delta_M = Ms delta_m
delta_H_demag = -grad(delta_phi)
div(grad(delta_phi)) = div(delta_M)
```

For periodic/Floquet frequency-domain demag, Fullmag must carry two constraint
sets:

```text
delta_m: magnetic-domain periodic or Floquet tangent constraints
delta_phi: magnetostatic airbox periodic or Floquet scalar constraints
```

At `k=0`, `periodic_airbox_k0` is a real periodic constraint on both
`delta_m` and `delta_phi`. It is the production target for the current
frequency-driven module.

For future dispersion with nonzero-k:

```text
phase = exp(-i k dot (r_dst - r_src))
delta_m_dst = phase delta_m_src
delta_phi_dst = phase delta_phi_src
grad_k = grad + i k
div_k = div + i k dot
```

Tangent-space FEM must enforce the phase on the reconstructed vector:

```text
q_dst = phase (T_dst^T T_src) q_src
```

Identity tangent-frame transport is valid only when the paired frames match
within tolerance and artifacts state that policy.

## Non-Negotiable Refactor Rules

1. The study product name remains `FrequencyResponse`. "Frequency-driven" is
   an implementation/module label, not a third public solver product.
2. `Eigenmodes` and `FrequencyResponse` must not share result status. A
   response peak is not an eigenmode.
3. `periodic_airbox_k0` must never mean "magnetization periodic, finite airbox
   demag". Accepted artifacts must prove scalar potential and demag-field seam
   behavior.
4. A requested GPU lane must not accept a CPU dense/coupled block as proof.
5. Dense validation paths are allowed only as validators and smoke fixtures.
   They must not appear in production provenance as solved physics.
6. `unsupported`, `inactive`, `degraded`, `source_visible`,
   `reference_executable`, `semantic_only`, `P2`, and read-only placeholders
   are temporary development statuses. They must have a named production
   replacement and a removal condition.
7. Native FEM build/runtime proof must use the container-backed `just` recipes.
   Host `cargo`, host CMake, direct binaries, or hand-written Docker commands
   are diagnostics only.

## Module Boundaries

The refactor keeps production numerics under `backends/fem`:

```text
backends/fem/include/frequency_domain/
  frequency_domain_contract.hpp
  driven_response_solver.hpp
  operator_contract.hpp
  operator_terms.hpp

backends/fem/src/frequency_domain/
  driven_response_solver.cpp
  frequency_domain_contract.cpp
  operator_contract.cpp
  operator_terms.cpp

backends/fem/cpu/frequency_domain/
  production_cpu_driven_response.*
  mfem_linearized_operator.*
  mfem_exchange_operator.*
  mfem_dmi_operator.*
  dense_driven_response.hpp

backends/fem/gpu/cuda/frequency_domain/
  driven_response_gpu.cu
```

Rust owns orchestration, ABI marshalling, planning, artifacts, and provenance.
Rust must not become the owner of production FEM weak forms or hot loops.

This is the current ownership map, not the final file layout. The current
driven-response implementation still concentrates too much policy inside
`backends/fem/src/frequency_domain/driven_response_solver.cpp` and too much
orchestration inside `crates/fullmag-runner/src/frequency_response.rs`. The
next source patch must split those files mechanically without changing runtime
behavior.

### Target Native Layout

The target layout is:

```text
backends/fem/include/frequency_domain/
  algebra/
    linearized_problem.hpp
    coupled_block_layout.hpp
    operator_representation.hpp
  planner/
    frequency_solve_plan.hpp
    frequency_solve_planner.hpp
  engines/
    dense_reference.hpp
    cpu_sparse_direct.hpp
    full_coupled_field_split.hpp
    schur_reduced.hpp
    modal_reduced.hpp
    gpu_operator_host_krylov.hpp
    gpu_device_krylov.hpp
  diagnostics/
    residual_diagnostics.hpp
    schur_certification.hpp

backends/fem/src/frequency_domain/
  algebra/
  planner/
  artifacts/
  diagnostics/

backends/fem/cpu/frequency_domain/
  engines/
    dense_reference/
    sparse_direct/
    host_krylov/
    full_coupled_field_split/
    schur_reduced/
    modal_reduced/
  operators/
  validation/

backends/fem/gpu/cuda/frequency_domain/
  engines/
    operator_host_krylov/
    device_krylov/
  operators/
  residency/
```

The first source-layout patch after this documentation change is allowed to add
directories, headers, and forwarding wrappers only when the move is
behavior-preserving. It must not change GMRES, Schur logic, preconditioner
selection, runtime fallback, artifact schemas, or C ABI semantics.

## FrequencySolvePlanner Contract

Frequency-driven response must move toward a solver tree. The planner owns the
choice between algebraically valid engines; individual engines own their
numerics.

```cpp
struct FrequencySolvePlan {
    FrequencyExecutionLane lane;
    OperatorRepresentation operator_representation;
    LinearSolverFamily linear_solver;
    PreconditionerFamily preconditioner;
    bool use_full_coupled_system;
    bool use_schur_reduction;
    bool require_true_residual_verification;
    bool allow_gpu_operator_backend;
    bool allow_device_resident_krylov;
};
```

The planned execution lanes are:

| Lane | Purpose | Promotion condition |
|---|---|---|
| `dense_reference` | Tiny dense oracle for signs, scaling, residuals, and full-vs-Schur equivalence. | Already allowed as validation only; never production proof. |
| `cpu_sparse_direct` | Assembled sparse direct solve per frequency, real-split or complex. | First missing backend to implement after mechanical split; gives the baseline for conditioning and Schur/preconditioner quality. |
| `full_coupled_field_split` | Full coupled block solve with field-split or Schur preconditioner. | Core production target for `periodic_airbox_k0` once block residual and preconditioner gates pass. |
| `schur_reduced` | Matrix-free reduced solve. | Allowed only when tiny explicit Schur, matrix-free Schur, reconstructed full residual, and preconditioner-quality gates pass. |
| `modal_reduced` | Modal/rational/recycling sweep for many frequencies. | Depends on validated modal basis and frequency-band residual correction. |
| `gpu_operator_host_krylov` | Current transitional GPU-backed operator path with host Krylov state. | Must publish host Krylov residency; useful but not device-resident production GPU. |
| `gpu_device_krylov` | Future device-resident Krylov path. | Requires device-resident vectors, operator, preconditioner, dot/norm/axpy, restart state, and residual estimates. |

The decision order for the planner is:

```text
if tiny validation fixture:
    dense_reference
else if single_frequency and sparse_direct_memory_ok:
    cpu_sparse_direct
else if periodic_airbox_k0 and full coupled blocks are available:
    full_coupled_field_split
else if Schur is certified for this operator and preconditioner:
    schur_reduced
else if many frequencies and modal basis is validated:
    modal_reduced
else if requested GPU but only operator/preconditioner is device-backed:
    gpu_operator_host_krylov
else if full device residency is available:
    gpu_device_krylov
else:
    reject or use an explicitly documented CPU fallback only for non-forced requests
```

The current `production_gpu` terminology is retained only as a compatibility
surface until runtime schemas are migrated. It must not hide the distinction
between `gpu_operator_host_krylov` and `gpu_device_krylov`.

## Cross-Layer Deliverables

### Physics Notes

- `docs/physics/0828-fem-frequency-domain-floquet-demag.md` must describe the
  k=0 production target and the future nonzero-k demag-k operator in one
  backend-neutral contract.
- The note must explicitly state which paths are real-valued k=0 providers and
  which paths require complex Bloch/Floquet providers.
- It must include COMSOL product split language and TetraX-derived operator
  requirements without copying either project as a semantic authority.

### Python DSL

The public authoring surface must preserve:

| Public choice | Required meaning |
|---|---|
| `frequencies_hz` | Explicit driven sweep frequencies. This is not an eigenfrequency window. |
| `spin_wave_bc="free"` | Open/free tangent perturbation boundary semantics. |
| `spin_wave_bc="periodic"` | k=0 periodic tangent perturbation constraints. |
| `spin_wave_bc="floquet"` | Future nonzero-k Bloch/Floquet tangent perturbation constraints. |
| `magnetostatic_bc="open"` | Open-air magnetostatic boundary realization. |
| `magnetostatic_bc="periodic_airbox_k0"` | Production target for real k=0 periodic-airbox driven response. |
| `magnetostatic_bc="floquet_airbox"` | Future nonzero-k complex Bloch/Floquet demag-k realization. |

The DSL must not expose MFEM, hypre, libCEED, CUDA image names, CPU dense-block
payloads, or provider callback names as common semantics.

### ProblemIR

`StudyIR::FrequencyResponse` must carry:

- `spin_wave_bc`,
- `k_sampling`,
- `magnetostatic_bc`,
- `operator.include_demag`,
- `solver_policy`,
- `equilibrium_provenance`,
- frequency sweep coordinates,
- dynamic drive phasor metadata.

The planned execution must derive separate magnetic and magnetostatic
constraint sets instead of inferring magnetostatic PBC from mesh metadata alone.

### Planner And Capability Matrix

Planner decisions must distinguish:

- requested product: `driven_response`,
- requested device: `cpu`, `gpu`, or `auto`,
- requested magnetic boundary: free, periodic, or Floquet,
- requested magnetostatic boundary: open, `periodic_airbox_k0`, or
  `floquet_airbox`,
- resolved execution lane,
- demag provider model,
- validation status.

Unsupported combinations must fail before execution unless the request is an
intentional unavailable-artifact diagnostic target. Unavailable diagnostics are
not production results.

### Runtime And Artifacts

Every accepted frequency-driven artifact bundle must publish:

- `frequency_domain/manifest.v1.json`,
- `response/diagnostics/solver.v1.json`,
- `response/progress.v1.json`,
- `response/magnetic_response_sweep.v2.json`,
- `response/frequency_points/frequency_*.json`,
- `response/field_payloads.zarr/`,
- `mesh/periodic_pairs.v1.json` when periodic/Floquet constraints are active.

For demag/PBC runs, diagnostics must also publish:

- requested and resolved magnetic boundary condition,
- requested and resolved magnetostatic boundary condition,
- `dynamic_demag_operator_source`,
- `dynamic_demag_matrix_form`,
- `delta_phi_dof_count`,
- magnetic and magnetostatic periodic constraint counts,
- basis transport policy,
- gauge policy,
- `delta_phi` seam residual,
- `H_demag` seam residual,
- normal flux residual,
- GMRES/preconditioner iterations,
- residual norms,
- whether validation fallback was used.

### Control Room

Control Room may show unavailable/degraded states, but it must not treat them
as successful analysis. The final UI target is:

- editable Study Setup nodes using canonical model transactions,
- dedicated result inspectors for frequency-driven response,
- chart and 3D overlay actions gated by real artifact availability,
- visible requested/resolved CPU/GPU and magnetostatic boundary provenance,
- no read-only fake authoring panels after backend transactions exist.

## CPU Refactor Chapter

### CPU Goal

Make `FrequencyResponse + periodic_airbox_k0 + include_demag=true` a
production CPU path for `k=0` periodic unit cells, and make its interfaces ready
for future nonzero-k `floquet_airbox`.

### CPU Ownership

CPU production numerics live in:

- `backends/fem/cpu/frequency_domain/production_cpu_driven_response.*`,
- `backends/fem/cpu/frequency_domain/mfem_linearized_operator.*`,
- `backends/fem/cpu/frequency_domain/mfem_exchange_operator.*`,
- `backends/fem/cpu/frequency_domain/mfem_dmi_operator.*`,
- dedicated demag/provider files created under the same CPU frequency-domain
  owner when the implementation is split.

The runner may create descriptors and callbacks, but it must not own the weak
form or the Krylov hot path.

### CPU Implementation Tasks

- Define a single CPU `FrequencyDrivenOperator` contract that applies
  exchange, Zeeman, anisotropy, damping/mass, optional DMI, and dynamic demag
  in tangent coordinates.
- Split k=0 real periodic demag from future nonzero-k complex demag-k at the
  type level. A real provider must not be accepted for `floquet_airbox`.
- Keep `periodic_airbox_k0` as a real-valued `delta_phi` provider with explicit
  gauge ownership, periodic pair validation, scalar-potential residuals, and
  demag-field seam residuals.
- Replace diagnostic-only Schur behavior with a production preconditioner plan:
  right preconditioner name, setup telemetry, per-frequency iteration counts,
  residual norms, and failure reasons.
- Add the `cpu_sparse_direct` baseline before attempting device-resident GPU
  Krylov. This is the fastest missing backend that can answer whether a stalled
  GMRES run is caused by conditioning, sign/scaling errors, or the current
  preconditioner.
- Reject missing or magnetic-only pair metadata before native solve.
- Reject `periodic_airbox_k0` when the shared-domain airbox is missing, the
  selected axes do not match `ProblemIR.pbc.axes`, or top/bottom open boundary
  policy is not represented.
- Preserve `delta_phi` and demag contribution provenance in every frequency
  point artifact.
- Keep dense validation response available only for tests and comparison. It
  must publish `validation_fallback_used=true` and must never satisfy the CPU
  production gate.
- Add a future complex-provider interface for `floquet_airbox` with
  `apply_complex_stiffness` and `apply_complex_mass`; do not route nonzero-k
  through the k=0 real provider.

### CPU Acceptance Gates

The CPU path is production-acceptable only when these pass:

- native contract tests for operator terms, driven response, coupled block,
  periodic pair validation, and demag sign,
- planner tests rejecting missing `delta_phi` constraints and magnetic-only
  PBC,
- artifact validator tests for `delta_phi`, `H_demag`, flux, gauge, and no
  fallback,
- managed runtime proof through:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-periodic-airbox-runtime
```

The second command must not be counted as production proof when it requires
`--allow-solve-error` or unavailable-artifact acceptance.

## GPU Refactor Chapter

### GPU Goal

Make the explicit GPU `FrequencyResponse + periodic_airbox_k0 +
include_demag=true` path a real production GPU lane for `k=0`, while keeping
future nonzero-k `floquet_airbox` gated until a GPU complex Bloch/Floquet
provider exists.

### GPU Ownership

GPU production numerics live in:

- `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`,
- GPU demag provider integration under the existing native FEM GPU/MFEM/hypre
  ownership,
- GPU-specific tests under `backends/fem/tests/`.

The GPU path may use a host-side GMRES driver during the current transition
only if every operator application preserves requested GPU provenance and uses
GPU-backed demag tangent-with-potential for demag. A CPU dense/coupled-block
payload is never GPU proof.

### GPU Implementation Tasks

- Keep a persistent CUDA frequency-domain operator context for tangent frames,
  exchange edges, node coefficients, damping, Zeeman, anisotropy, and supported
  DMI payloads.
- Upload only the current Krylov tangent vector and required dynamic payloads
  per operator application.
- Route ordinary k=0 demag through a GPU demag tangent provider for free/open
  slices.
- Route `periodic_airbox_k0` through a GPU demag tangent-with-potential provider
  with `device_hypre_poisson` provenance, scalar-potential diagnostics, and no
  CPU coupled-block substitution.
- Publish `gpu_operator_host_krylov` when the magnetic operator or demag
  provider is GPU-backed but GMRES basis vectors, Hessenberg state,
  orthogonalization, residual workspaces, dot/norm/axpy, and restart logic stay
  on the host.
- Publish `gpu_device_krylov` only after those Krylov workspaces and reductions
  are device-resident.
- Reject explicit CPU dense/coupled-block payloads when
  `requested_execution_lane="production_gpu"`.
- Reject GPU `floquet_airbox` unless a GPU matrix-free complex coupled-block
  provider exists and publishes complex stiffness/mass callbacks.
- Preserve `requested_execution_lane="production_gpu"` and
  `resolved_execution_lane="production_gpu"` in successful GPU artifacts.
- Fail hard when CUDA/MFEM/hypre/libCEED prerequisites are missing for a strict
  GPU request. Do not auto-promote or demote explicit device intent.
- Add GPU parity checks against CPU for each promoted k=0 slice:
  free/open demag, static-periodic magnetic slice, shared-domain compacted
  slice, and `periodic_airbox_k0` demag.

### GPU Acceptance Gates

The GPU path is production-acceptable only when these pass:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-gpu-free-demag-runtime
just verify-fem-frequency-domain-free-demag-parity-runtime
just verify-fem-frequency-domain-periodic-airbox-gpu-runtime
```

The GPU periodic-airbox gate must verify:

- `resolved_execution_lane="production_gpu"`,
- `validation_fallback_used=false`,
- `uses_gpu_poisson=true` or equivalent provider-side GPU Poisson provenance,
- `dynamic_demag_operator_source` naming the GPU demag tangent-with-potential
  provider,
- no CPU dense/coupled-block payload,
- nonzero field payloads,
- finite residuals,
- `delta_phi` and `H_demag` seam diagnostics,
- pair metadata covering magnetic and airbox constraints.

## Future Dispersion Chapter

The future nonzero-k dispersion target belongs to `Eigenmodes`, not
`FrequencyResponse`. This plan still prepares the shared demag-k operator
family because both products require the same Bloch/Floquet magnetostatic
physics.

Production nonzero-k dispersion requires:

- `spin_wave_bc=floquet`,
- `magnetostatic_bc=floquet_airbox` when demag is enabled,
- complex `delta_m` and `delta_phi` constraints,
- `grad_k` / `div_k` terms,
- tangent-frame transport,
- selected-spectrum modal solver,
- branch tracking by modal overlap,
- DE/BV low-k analytic acceptance,
- primitive-vs-supercell Floquet validation.

No gamma-only k-path, no-demag Floquet smoke, or analytic reference bundle may
be described as production demag-k dispersion.

## Temporary Status Retirement Ledger

| Current Status Or Shortcut | Where It May Appear During Development | Production Replacement | Removal Condition |
|---|---|---|---|
| `P2` / "Phase 2 backend-dependent" Study Setup nodes | COMSOL-inspired UI docs and inspectors | Canonical Study transaction schema for `FrequencyResponse` and `Eigenmodes` | Backend transaction schema exists, UI smoke proves edits persist through `model.commitTransaction`, and stale read-only cards are removed. |
| `Configuration not yet available` | Transitional Study Setup inspector | Editable, capability-aware inspector controls | The corresponding `stage.*` schema is implemented and round-trip tested. |
| `unsupported` for `floquet.nonzero_k.demag_unsupported` | Capability diagnostics for nonzero-k demag | `floquet_airbox` complex demag-k provider | CPU and GPU complex provider gates pass for the lane being promoted. |
| `inactive` coupled lanes | Multiphysics lane selectors | Explicit active/passive/unsupported solver-lane capability with persisted user intent | Planner and runtime preserve requested lane state and rejection diagnostics for every lane. |
| `reference_executable` dense response | Validation fallback and small fixtures | Production CPU/GPU native response | Artifacts with `validation_fallback_used=true` are excluded from production acceptance validators. |
| `semantic_only` modal interior-window | Capability matrix | Production selected-spectrum eigensolver with managed proof | SLEPc/PETSc or accepted equivalent passes managed selected-spectrum gates. |
| `partial_production_executable` k=0 demag slices | Capability matrix | `production_executable` plus workload-specific validation labels | CPU/GPU runtime, parity, seam, gauge, and supercell gates pass for named workloads. |
| `allow-unavailable` unavailable bundles | Negative capability tests | Hard planner/runtime rejection outside diagnostic targets | Negative tests remain, but UI and normal run paths cannot present unavailable bundles as solved results. |
| no-demag Floquet phase projection | Development smoke for phase transport | Full Floquet exchange graph plus optional demag-k and DMI operators | Nonzero-k operator validation passes for requested terms. |
| CPU dense/coupled-block payload on GPU | Invalid shortcut | GPU matrix-free provider or device-resident coupled operator | GPU validator rejects explicit CPU dense/coupled-block payloads and proves GPU provenance. |
| host-side FEM build proof | Developer diagnostic | Container-backed `just` proof | All final native FEM readiness claims cite managed/container `just` recipes. |

## Documentation Update Tasks

- Update this folder's `README.md` so this file is part of the read order and
  source hierarchy.
- Update `02-target-interface-contract.md` so read-only Study Setup states are
  transitional diagnostics, not a planned end state.
- Update `04-implementation-plan.md` so frontend checkboxes cannot be read as
  proof that backend schemas, demag-k, periodic-airbox, or GPU response are
  finished.
- Keep `docs/physics/0828-fem-frequency-domain-floquet-demag.md` synchronized
  with the k=0 CPU/GPU production target and future nonzero-k demag-k contract.
- Keep `docs/specs/capability-matrix-v0.md` synchronized whenever a status
  moves from diagnostic, reference, or partial to production.
- Keep `docs/specs/frequency-domain-artifacts-v2.md` synchronized whenever new
  demag, scalar-potential, provider, or validation diagnostics become required.
- Keep `docs/frequency_domain_solver_files.md` synchronized with the current
  monolith inventory and the target layout so future agents do not confuse a
  docs-only architecture decision with an already-completed source move.

## Patch Sequencing From 2026-07-05 Audit

1. Documentation-only architecture patch: record `FrequencySolvePlanner`, the
   solver tree, honest GPU residency names, and the target layout. Do not move
   code. Status: complete.
2. Mechanical source split: extract planner/engine descriptors and file
   boundaries from the current monoliths without changing GMRES, Schur,
   preconditioner, artifacts, C ABI, or runtime behavior. Status: started with
   header-only `frequency_domain/planner/frequency_solve_plan.hpp` and
   `frequency_domain/planner/frequency_solve_planner.hpp`; monolith file moves
   and runtime integration remain pending.
3. Implement `cpu_sparse_direct`: assembled sparse direct baseline for driven
   response, with dense-reference and full-residual comparison tests.
4. Implement `full_coupled_field_split`: make full coupled residual and
   block/field-split preconditioner the robust periodic-airbox core.
5. Promote `schur_reduced` only after certification gates pass against the full
   coupled oracle.
6. Add `modal_reduced` and then `gpu_device_krylov` only after their
   preconditions are proven.

## Completion Criteria

This plan is complete only when:

1. CPU `periodic_airbox_k0` driven response passes managed production gates
   without `allow-solve-error`.
2. GPU `periodic_airbox_k0` driven response passes managed production gates
   without CPU dense/coupled-block fallback.
3. The capability matrix names the exact workload coverage and validation
   level for each CPU/GPU slice.
4. Artifacts expose requested/resolved magnetic and magnetostatic boundaries,
   demag provider source, gauge, `delta_phi`, seam diagnostics, and fallback
   status.
5. Control Room Study Setup nodes use canonical transactions rather than
   read-only placeholder panels for implemented schemas.
6. Nonzero-k demag-k remains explicitly rejected until the complex provider
   exists, and those rejections preserve user intent in provenance.
7. The future dispersion plan uses `Eigenmodes` over Floquet k-paths and does
   not reuse driven response smokes as modal proof.
