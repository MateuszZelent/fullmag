# Eigen K0 GPU readiness audit

- Date: 2026-08-05
- Status: implementation_status
- Source of truth: `25_frequency_domain_readiness_matrix.json`
- Managed runtime bundle identity revalidated in this update: `false`
- Executed GPU-device solver revalidated in this update: `false`
- Historical audit: `old/17_eigen_k0_gpu_readiness_audit_legacy_2026-07-10.md`

This file is a strict GPU-focused projection of
`25_frequency_domain_readiness_matrix.json`. The old before/after audit is
archived under `old/` and must not be used as current status when it conflicts
with the readiness matrix.

## Current GPU status

All non-null `validated_scope` and `executable_scope` references use the
readiness projection catalog:

```text
scope_catalog_uri = urn:fullmag:frequency-domain:readiness-scope-catalog:6bd14fb083db6474c1e33ccc5b67081ad68ee5bed6cb22db7d93df0aabdc9993
scope_catalog_sha256 = sha256:6bd14fb083db6474c1e33ccc5b67081ad68ee5bed6cb22db7d93df0aabdc9993
scope_catalog_path = docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_scope_catalog.json
```

| Cell ID | Implementation state | Validation state | `validated_scope` | Evidence or executable scope | Current conclusion |
|---|---|---|---|---|---|
| `modal_gpu_k0_none_macrospin_larmor` | `executable` | `physics_validated` | `modal_gpu_k0_none_macrospin_larmor.validation` | K0-1 no-demag macrospin/Larmor field sweep using `gpu_dense_k0_macrospin_modal_eigen`; precision=`double`. | Real narrow GPU modal slice exists through the current emitted GPU modal validation lane. |
| `modal_gpu_k0_none_general_modal` | `source_visible` | `unvalidated` | `null` | Source evidence only. | The macrospin slice does not promote a general GPU modal eigensolver. |
| `modal_gpu_k0_periodic_airbox_dense_probe` | `source_visible` | `unvalidated` | `null` | Bounded shared-domain lane: `k0_poisson_airbox_gpu_petsc_slepc`; the legacy `gpu_dense_contract_eigensolver` is validation-only. | Matrix status remains unvalidated; see the historical bounded evidence below. |
| `modal_gpu_k0_periodic_airbox_scalable` | `source_visible` | `unvalidated` | `null` | Source and bounded managed GPU evidence only. | Matrix status remains unvalidated because matrix-free convergence, large-problem scaling, and the full DOD-01..DOD-14 release record remain open. |
| `modal_gpu_nonzero_k_none` | `absent` | `unvalidated` | `null` | None. | Nonzero-k Floquet GPU modal remains unavailable. |
| `modal_gpu_nonzero_k_floquet_airbox` | `absent` | `unvalidated` | `null` | None. | Dynamic demag-k GPU modal remains unavailable. |
| `driven_gpu_k0_none` | `executable` | `unvalidated` | `null` | Executable scope `driven_gpu_k0_none.executable`: bounded gamma/free-boundary and k0 static-periodic GPU operator-host Krylov slices; not `gpu_device_krylov`. | This is driven response, not modal eigensolve; no full device-resident Krylov loop is proven. |
| `driven_gpu_k0_periodic_airbox_gpu_operator_host_krylov` | `executable` | `unvalidated` | `null` | Executable scope `driven_gpu_k0_periodic_airbox_operator_host_krylov.executable`: partial periodic_airbox_k0 GPU operator-host Krylov artifacts with hybrid or host Poisson demag provider. | This is driven response, not modal eigensolve; current reliable lane is `gpu_operator_host_krylov` with host or hybrid Poisson provider. |
| `driven_gpu_k0_periodic_airbox_gpu_device_krylov` | `source_visible` | `unvalidated` | `null` | Source evidence only. | `production_loop_available=false`; no full device Krylov loop. |
| `driven_gpu_nonzero_k_none_phase_projection` | `executable` | `unvalidated` | `null` | Executable scope `driven_gpu_nonzero_k_none_phase_projection.executable`: no-demag/non-DMI Floquet phase-projection response slice with local/exchange CUDA operator support only. | This is driven response, not modal eigensolve; it does not prove nonzero-k GPU modal or GPU dynamic demag-k. |
| `driven_gpu_nonzero_k_floquet_airbox` | `absent` | `unvalidated` | `null` | None. | Nonzero-k GPU driven dynamic-demag-k is unavailable; strict GPU fallback to CPU is forbidden. |

## Historical bounded evidence (2026-08-03; not current revalidation)

The managed run adds a bounded GPU Poisson-airbox physics result. It is
deliberately described separately from the immutable readiness catalog because
that catalog still has no scope entry for this new runtime evidence:

```text
cell_id = modal_gpu_k0_periodic_airbox_dense_probe (bounded managed evidence)
study_product = modal_eigen
device = gpu
precision = double
wavevector_scope = k0
demag_scope = periodic_airbox_k0
solver_lane = k0_poisson_airbox_gpu_petsc_slepc
managed_device = NVIDIA RTX 4080 SUPER, compute capability 8.9
frequency_hz = 1956981356.1283116
full_residual_reconstruction_relative_error = 3.3650808035851064e-11
per_iteration_h2d_transfer_count = 0
per_iteration_d2h_transfer_count = 0
cpu_parity_relative_frequency_error = 1.0867215055095796e-13
```

The matching CPU run reports `1956981356.1280994 Hz` and
`4.940374972503828e-14` full residual reconstruction error. Both runs emit
the spectrum/branch/dispersion artifacts and 15 mode-field payloads.

Existing static evidence:

- `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/validation/kittel_k0_pbc/summary.v1.json`
- `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/eigen/diagnostics/solver.v1.json`
- `.fullmag/reports/frequency-domain-eigen-k0-kittel-cpu-gpu-comparison-summary.v1.json`

Those artifacts report GPU execution and roundoff-level CPU/GPU agreement for
the no-demag macrospin field sweep. They do not prove:

- K0 Poisson-airbox demag;
- real shared-domain FEM assembly;
- nonzero-k Floquet modal dispersion on GPU;
- dynamic demag-k;
- DMI or damping modal qualification;
- broad sparse/matrix-free selected-spectrum GPU modal execution;
- Task8 runtime `scope_catalog.v1` emission.

## What is not production qualified

### GPU K0 Poisson-airbox modal

The immutable readiness matrix still treats the broad
`modal_gpu_k0_periodic_airbox_scalable` cell as source-visible/unvalidated.
The bounded target label is now executable and physics-validated in the audit
above, but the catalog needs a new scope binding before the matrix can carry a
non-null `validated_scope`. The bounded target label is:

```text
target_solver_label = k0_poisson_airbox_gpu_petsc_slepc
implementation_state = executable (bounded materialized path)
validation_state = unvalidated
validated_scope = null
```

The managed artifact publishes this bounded label with the telemetry required
for device residency. It is not yet a broad production promotion because the
immutable readiness catalog has no binding for this new scope. The current
materialized implementation is bounded to descriptor dimensions through 1024;
larger problems select a matrix-free shell that remains unqualified.

GPU K0 Poisson-airbox broad production qualification still requires:

- persistent GPU modal context;
- full selected-spectrum Krylov-Schur or Arnoldi loop;
- shifted preconditioner;
- Ritz extraction, restart and convergence;
- real shared-domain `mfem_weak_form_shared_domain` assembly;
- CPU/GPU parity for real Poisson-airbox blocks;
- mesh and airbox convergence;
- K0-3 Kittel independence.

### GPU nonzero-k modal

No GPU modal nonzero-k Floquet operator/eigensolver is production available.
The driven-response no-demag phase-projection slice is not modal proof. A
strict GPU request for nonzero-k modal dynamic demag must fail explicitly.

### GPU device Krylov

`gpu_device_krylov` and `gpu_modal_device_krylov` may be claimed only after
the telemetry contract in chapter 11 proves a full device-resident loop with
zero per-iteration host transfers. Current status remains:

```text
implementation_state = source_visible
validation_state = unvalidated
validated_scope = null
```

## Required promotion gates

A future broad GPU modal promotion must add all of the following for the exact
cell being promoted:

1. backend-owned GPU modal source under the GPU frequency-domain owner, not a
   modal proof hidden inside driven-response source;
2. persistent device context for blocks, vectors, basis and preconditioner;
3. scalable selected-spectrum solver with restart, convergence and Ritz
   extraction;
4. reconstructed original-unscaled descriptor residual and finite-mode
   certification;
5. transfer audit showing no per-iteration H2D/D2H;
6. CPU/GPU parity on real assembled blocks;
7. validation matrix gates for the exact `validated_scope`;
8. artifact fields with requested/resolved execution, implementation state,
   validation state, Task8 scope binding and evidence scope.

Until those gates pass, the managed K0 demag result is qualified only for the
bounded materialized fixture and precision=`double`; the broad GPU modal cell
remains unvalidated.

## Historical revalidation after the master branch update (2026-08-01; superseded)

The following section records the earlier no-driver result for provenance. It
is superseded by the managed RTX 4080 SUPER execution evidence in the
2026-08-03 section above and must not be used as the current device result.

The working branch was first brought up to the current `origin/master` before
this audit. The merge commit is `d5f63b35a4f4a57798089915b312c4695caea917`;
`origin/master` is `eee245ac200bf138d880b793791848106b7386ba`, and
`git rev-list --left-right --count HEAD...origin/master` reports `25 0`.
This is branch-integration evidence, not solver qualification.

The managed FEM bundle was rebuilt and validated against the exact source
snapshot. Its manifest reports commit `d5f63b35a4f4a57798089915b312c4695caea917`,
`source_identity_compatibility=exact-schema-3`, `worktree_state=clean`, and
`compute_capability=8.9`. The container reported that no NVIDIA driver was
available, so no executed-device GPU result was produced.

The aggregate native-contract recipe was attempted after the rebuild but
stopped before compilation because the fresh worktree did not contain
`native/build`; this is a recipe/bootstrap failure, not evidence that the
frequency-domain contracts passed or failed. The explicit K0 CPU recipe then
configured its own managed CMake build and produced the contract binary, but
the small SLEPc fixture did not emit a result after approximately 19 minutes.
The recipe was terminated with exit code 130; this is a timeout/non-convergence
boundary, not a pass.

The source-level boundary is unchanged and is anchored by:

| Source anchor | Revalidated conclusion |
|---|---|
| `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu::fullmag_fem_frequency_domain_apply_modal_shift_invert_gpu_action` | A device dense shifted action exists, but its diagnostics explicitly set `gpu_device_resident_modal_eigensolver=false`; it is not a modal Krylov loop. |
| `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu::fullmag_fem_frequency_domain_solve_modal_poisson_airbox_gpu_dense_eigensolver` | The bounded dense Poisson-airbox lane remains `validation_only=true`, `production_modal_claim=false`, and `persistent_solver_context=false`. |
| `backends/fem/include/frequency_domain/gpu_device_krylov.hpp::validate_fgmres_device_engine` | Device workspace validation is present, but `production_loop_available=false`; no promotion follows from the contract structure alone. |

Therefore the immutable matrix still leaves
`modal_gpu_k0_periodic_airbox_scalable` `source_visible/unvalidated`; the
current audit additionally records bounded managed K0 demag physics with
double-precision CPU/GPU parity.

## Recovery implementation delta (2026-08-02; bounded runtime revalidation supersedes the qualification boundary)

The worktree audit found one and only one uncommitted K0 *content* lane:
`codex/eigensolve-k0-demag` in
`.worktrees/eigensolve-k0-demag-recovery`. Relative to the current local
`master` (`4d68d8fe286b6f6e8f60edb17e179751f713f09a`), that recovery branch is
34 commits ahead and 12 commits behind; this is branch topology, not
qualification evidence.

The separate
`/zfn2/mateuszz/git/fullmag/worktrees/fem-solver-optimization-remediation-current`
worktree (`codex/fem-solver-optimization-remediation-current`, `ef0ee059`) is
156 commits ahead and 15 commits behind `master`. Its 5,187 dirty entries are
primarily mode-only churn (5,155 mode changes); the K0 CPU files are mode-only,
it has no `modal_krylov.cu`, and it does not contain a competing content
implementation of this recovery lane. Its committed older CPU SLEPc and GPU
dense-validation work remains the pre-recovery baseline.

The recovery commit `5e3efe56` (shared-domain K0 modal CPU/GPU slice) is
reachable only from `codex/eigensolve-k0-demag`; older K0 contract commits are
already in `master` and are shared baseline history.

The recovery source now contains the following bounded implementation evidence:

- CPU shared-domain K0 uses the real-split Schur MatShell lane with persistent
  Poisson factorization, explicit original-block residuals, and SLEPc target
  selection; synthetic algebraic fixtures remain a separate validation oracle.
- GPU K0 owns the CSR blocks, vectors, basis, orthogonalization, shifted action,
  and residual certification on the device. The Arnoldi path transfers only
  scalar/control state and the bounded projected Hessenberg; diagnostics expose
  `host_ritz_extraction=true` and `ritz_state_location=host_small_projected`.
- The 67-DOF CUDA contract passes with the device-BiCGStab shifted action and
  device 2x2 magnetic block-Jacobi preconditioner, but its bounded projected
  Ritz extraction is host-side and therefore emits
  `scalable_selected_spectrum=false` and `validation_only=true`. Ritz vectors
  remain on-device; the projected Ritz state and scalar/control state cross the
  host boundary. The later managed route now proves the bounded real shared-domain
  fixture and CPU/GPU parity; >1024-DOF materialized coverage, matrix-free
  convergence and broad scaling remain unqualified.

These changes do not alter the readiness matrix above. The cell
`modal_gpu_k0_periodic_airbox_scalable` remains `source_visible/unvalidated`
until the new bounded artifact receives a catalog scope binding and the broad
cell proves matrix-free convergence, three-size scaling, and the DOD-01..DOD-14
release record. The bounded managed result is recorded above to prevent
reimplementing the already-present recovery lane under another worktree.

## Current recovery snapshot (2026-08-05; supersedes stale runtime wording)

The current source snapshot is dirty by design and is identified by:

```text
branch = codex/eigensolve-k0-demag
head_commit = 138d95325cee241fae1b6ffa44d3d7c883242cbf
head_tree_sha256 = 8fb72e96e1385366bdfcfd4f3d4484495a0fb17af9b71b130f2b298cf13cc222
source_snapshot_sha256 = 8d6c8a993d9e6361f85430882d570233c6712c40489ab145d8888ba42742fbb5
source_snapshot_dirty = true
identity_policy = capture_source_snapshot_identity.py --ignore-non-runtime-dirty
```

The current managed pointer is stale (it resolves to the older PETSc 3.15
bundle), while the only matching PETSc 3.24.6/SLEPc 3.24.3 bundle is an older
syntax/build artifact. A runtime-export lock is still held by a stale export
process, so no fresh managed CPU or GPU solve has been executed for this
source snapshot. Consequently the following distinction is authoritative:

| Cell | Current source conclusion | Current verification conclusion |
|---|---|---|
| `modal_gpu_k0_periodic_airbox_dense_probe` | Production PETSc/SLEPc CUDA adapter and raw device-residency diagnostics are present; bounded projected-Ritz extraction is still a validation lane. | `source_visible / unvalidated`; no fresh managed artifact or scope binding. |
| `modal_gpu_k0_periodic_airbox_scalable` | Production PETSc/SLEPc CUDA selected-spectrum path is source-visible; broad qualification gates remain open. | `source_visible / unvalidated` in the readiness matrix. |
| `modal_gpu_k0_none_macrospin_larmor` | Existing double-precision no-demag macrospin lane remains the only GPU modal physics-qualified slice. | Existing historical qualification only; not re-run in this snapshot. |
| `modal_gpu_nonzero_k_floquet_airbox` | Dynamic demag-k operator is not implemented. | `absent / unvalidated`. |

The performance verifier now rejects summary-only timing or residency claims:
each run must bind hash-addressed native GPU diagnostics and managed-runtime
telemetry, with zero hot-loop host/device vector transfers and
`fallback_used=false`. This strengthens the gate but does not satisfy it
without a fresh managed run. Browser mode-field proof, release DOD, and
three-size scaling remain open.

The evidence-generation path is now executable through
`scripts/capture_fem_eigen_k0_periodic_airbox_performance.py` and the matching
`just capture-fem-frequency-domain-eigen-k0-poisson-airbox-performance` recipe.
That orchestrator first ensures the managed runtime and invokes the explicit
per-case producer
`run-fem-frequency-domain-eigen-k0-poisson-airbox-performance-case` for every
configured DOF case, cancellation run, and Compute Sanitizer run. The capture
command measures wall time and child peak RSS, requires each case to emit
native diagnostics containing operator and hot-loop telemetry, hashes and
verifies every copied artifact, and only then emits
`fem_k0_modal_performance.v1`; it does not turn source presence or stale
runtime artifacts into qualification. This closes the producer gap while the
fresh managed-runtime and DOD blockers remain unchanged.
