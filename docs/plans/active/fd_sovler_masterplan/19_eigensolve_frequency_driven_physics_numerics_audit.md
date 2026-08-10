---
title: Frequency-domain physics and numerics audit register
date: 2026-08-01
status: implementation_status
runtime_revalidated_in_this_update: false
source_revision_basis: static code and existing repository evidence
---

# Physics and numerics audit register

This file replaces the previous narrative audit with a current finding
register. The source-level findings remain current after the master update.
The dated revalidation below records the limited build/runtime evidence from
this update; it does not promote any readiness cell.

Required state fields:

```text
documentation_state = open | resolved_in_docs
code_state = open | source_visible | implemented
verification_state = not_run | runtime_verified
```

`implemented` means the inspected source currently contains the corrective
guard, label or behavior for the finding. It does not imply production
qualification. `source_visible` means source or target labels are visible but
the production artifact path has not emitted the integrated behavior. It is
still open for production promotion. `runtime_verified` is used only for
previously existing runtime evidence and is not used for this update unless a
runtime was actually rerun, which it was not.

## Capability matrix integration

`docs/specs/capability-matrix-v0.md` and `.json` are maintained as the
product-facing projection of this audit. The current recovery update edited
those projections to describe the implemented shared-domain CPU Schur and GPU
PETSc/SLEPc paths while keeping their validation state unqualified. The
readiness matrix remains the immutable status authority. Parallel
dynamic-solver remediation owns:

- correcting any stale heading or downstream copy that calls the seven
  product-facing statuses a "four-state status vocabulary";
- adding links from capability-matrix rows to
  `25_frequency_domain_readiness_matrix.json`;
- preserving the distinction between product-facing availability and the
  independent axes `implementation_state`, `validation_state` and
  `validated_scope`;
- explaining broad booleans such as `supports_frequency_response=false` as
  coarse family gates that may coexist with narrow executable readiness cells
  exposed through `frequency_domain_capabilities.v1`.

Any future capability-matrix change must preserve the same separation between
source-visible implementation, executable scope, runtime verification and
production qualification.

## Finding register

| ID | Severity | Affected scope | Finding | Required disposition | Documentation state | Code state | Verification state | Evidence paths |
|---|---|---|---|---|---|---|---|---|
| F-01 | BLOCKER | K0-3 CPU Poisson-airbox modal, Kittel demag, GPU promotion | PA-E4b/topology-shaped Kittel payload is not real shared-domain FEM Poisson-airbox assembly. | Keep synthetic/topology-shaped payload as algebra evidence only; require `production_periodic_airbox_claim=false`; build separate `mfem_weak_form_shared_domain` assembly with Kittel answer removed from operator inputs. The synthetic lane is identified explicitly as `assembly_kind = synthetic_algebraic_oracle`. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`; `crates/fullmag-runner/src/fem_eigen.rs`; `25_frequency_domain_readiness_matrix.json` |

The field `production_periodic_airbox_claim` może mieć wartość `true` dopiero po
wykazaniu rzeczywistej wspólnej domeny FEM, certyfikatu par okresowych, konwergencji
siatkowej oraz niezależnej walidacji CPU/GPU.
| F-02 | BLOCKER | K0 Poisson-airbox modal BC/gauge | Mean-zero gauge is invalid for Robin/Dirichlet coercive scalar blocks. | Enforce boundary/gauge tuple: Robin/Dirichlet use `gauge_policy=none`; pure Neumann uses mean-zero; keep unsupported combinations fail-closed until implemented. | resolved_in_docs | implemented | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-03 | BLOCKER | CPU SLEPc modal selected spectrum | `spectral_transform.cpp` converts the requested Hz target to a positive real `omega`; `slepc_modal_eigen.cpp` and `poisson_airbox_modal_eigen.cpp` then use `EPS_TARGET_MAGNITUDE` with that real target. This is not the canonical `sigma=i*omega` transform or a proven real-split equivalent. | Implement one explicit target realization: complex PETSc, real-split transformed pencil, or a rigorously derived real Hamiltonian/gyrotropic pencil; artifact must publish sigma components and scalar mode. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/cpu/frequency_domain/spectral_transform.cpp`; `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-04 | BLOCKER | Modal descriptor residual certification | Full residual certification previously could hide bad reconstruction by taking the smaller SLEPc residual. | Certify only the reconstructed blockwise original-unscaled descriptor residual; publish SLEPc, scaled and transformed residuals separately as diagnostics; use `eps_full_original_unscaled=max(eps_q,eps_phi,eps_gauge)`. | resolved_in_docs | implemented | not_run | `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`; `docs/plans/active/fd_sovler_masterplan/11_runtime_telemetry_performance.md` |
| F-05 | BLOCKER | K0-3 Kittel geometry | The K0-3 validation fixture must be x/y periodic and open-z; a one-axis PBC strip is not the ideal film oracle. | Require x/y periodic magnetic and airbox pair metadata or relabel the fixture as a finite strip with a different independent oracle. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`; `examples/fem_eigen_k0_kittel_periodic_airbox.py`; `docs/plans/active/fd_sovler_masterplan/24_production_definition_of_done.md` |
| F-06 | HIGH | K0-3 convergence and production validation | The old convergence gate did not require real mesh/airbox convergence. | Enforce at least three mesh levels and at least three airbox-padding levels with independent oracle, branch tracking, raw rows and separate budgets. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/09_validation_certification_benchmarks.md`; `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`; `scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py` |
| F-07 | HIGH | Kittel verifier and mode-quality artifacts | The verifier must enforce mode-quality thresholds, not only metric presence. | Enforce residual, uniformity, overlap, tangent leakage, seam mismatch and equilibrium thresholds from the validation metadata. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/09_validation_certification_benchmarks.md`; `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`; `scripts/verify_fem_frequency_domain_eigen_artifacts.py` |
| F-08 | HIGH | Equilibrium handoff for modal/driven sweeps | Native `EquilibriumArtifactDescriptor -> LinearizationStateNative` validation exists, including static-demag availability, but planner and runner do not materialize or consume the state; modal execution still passes equilibrium arrays independently. Relaxation step count is not evidence. | Connect accepted `EquilibriumArtifact -> LinearizationState` with mesh/material/physics hashes, torque residual, static demag and bias-field identity into every modal/driven sample, or require an explicit analytic proof. | resolved_in_docs | source_visible | not_run | `docs/plans/active/fd_sovler_masterplan/03_relaxed_texture_linearization.md`; `docs/plans/active/fd_sovler_masterplan/16_end_to_end_fem_frequency_domain_implementation.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/include/frequency_domain/linearization_state.hpp`; `backends/fem/src/frequency_domain/linearization_state.cpp` |
| F-09 | HIGH | Demag block signs, reciprocity and energy | Nonzero coupling blocks alone do not prove the demag operator's weak-form reciprocity or energy sign. | Add directional-derivative, Hessian reciprocity and energy-sign gates independent of Kittel. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`; `docs/plans/active/fd_sovler_masterplan/09_validation_certification_benchmarks.md` |
| F-10 | HIGH | Singular descriptor modal pencil | Singular `B` needs finite-mode policy, algebraic-mode rejection and full descriptor reconstruction. | Prefer certified Schur-reduced magnetic pencil; if monolithic descriptor remains, publish finite-mode filters, regularity, `q^H B q` and algebraic-mode rejection. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-11 | HIGH | Kittel demag oracle and `M_eff` | One scalar `M_eff` is not a general Kittel oracle and must not leak into operator construction. | Keep `H1`, `H2`, `N0`, `N1`, `N2` or fitted stiffnesses as verifier-only outputs; remove expected Kittel values from builder, targeting, selection and solver pass/fail. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`; `crates/fullmag-runner/src/fem_eigen.rs`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-12 | HIGH | Status governance and capability labels | Historical status text mixed normative contract, implementation evidence, runtime capability and validated production status. | Use `25_frequency_domain_readiness_matrix.json` as the current active status source and let parallel remediation link capability rows to it. | resolved_in_docs | implemented | not_run | `docs/plans/active/fd_sovler_masterplan/10_patch_queue_current_status.md`; `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_matrix.json`; `docs/specs/capability-matrix-v0.md` |
| F-13 | HIGH | Driven response absorbed-power sign | The emitted `absorbed_power_density` is explicitly a `drive_projected_absorption_proxy` with `physical_power_density=false`, not `absorbed_by_magnetization`. Its units and sign cannot certify the physical power law under `exp(+i*omega*t)`. | Add a separate physical observable `absorbed_by_magnetization` using `p_abs = -0.5*mu0*Ms*omega*Im(conj(h_drive) dot delta_m)` and damped-macrospin sign checks. Preserve the proxy under its existing explicit provenance. | resolved_in_docs | source_visible | not_run | `docs/physics/0700-frequency-domain-linearized-llg.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `docs/plans/active/fd_sovler_masterplan/02_physics_contract.md`; `backends/fem/src/frequency_domain/driven_response_solver.cpp` |
| F-14 | HIGH | Modal/driven sign dictionary | Modal, driven and real-split paths need one operator dictionary for `L`, `B_alpha`, `A_omega`, `lambda`, `omega` and `b`. | Keep 0831 as the single dictionary; production code must use one canonical dynamic pencil and prove fused/apply parity before promotion. | resolved_in_docs | source_visible | not_run | `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `docs/physics/0700-frequency-domain-linearized-llg.md`; `backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp`; `backends/fem/src/frequency_domain/linearized_dynamic_pencil.cpp`; `docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md` |
| F-15 | HIGH | Static and dynamic demag consistency | Static demag in `h_eff0` and dynamic demag derivative must share mesh/material/BC/operator provenance. | Require common operator/equilibrium digest; invalidate Schur certificates and artifacts when any static/dynamic demag input changes. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/03_relaxed_texture_linearization.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `docs/specs/frequency-domain-artifacts-v2.md` |
| F-16 | HIGH | Nonzero-k dynamic demag | Nonzero-k dynamic demag must remain hard blocked until complex Bloch `grad_k/div_k` assembly exists. | Reject `k!=0 && include_demag` without `floquet_airbox` dynamic-demag-k operator; no fallback to K0, no-demag projection, open boundary, dense validation or CPU for strict GPU. | resolved_in_docs | implemented | not_run | `docs/physics/0828-fem-frequency-domain-floquet-demag.md`; `docs/plans/active/fd_sovler_masterplan/23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md`; `backends/fem/src/frequency_domain/driven_response_solver.cpp`; `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` |
| F-17 | MEDIUM_HIGH | Driven residuals and preconditioners | Driven response needs reconstructed original-unscaled block/full residuals and preconditioner quality, not only tracked GMRES residual; the target acceptance lane is not yet claimed as emitted. | Publish tracked residuals only as diagnostics; accept only `driven_original_unscaled_full_relative_residual` and original-unscaled block residuals against the original operator; publish Schur contraction ratio and threshold when defined, otherwise `null` plus `not_applicable`/`not_available`; keep the target lane open until artifacts emit the full contract under root `runtime_telemetry`. | resolved_in_docs | source_visible | not_run | `docs/plans/active/fd_sovler_masterplan/11_runtime_telemetry_performance.md`; `.fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime/artifacts/response/diagnostics/solver.v1.json`; `backends/fem/src/frequency_domain/driven_response_solver.cpp` |
| F-18 | MEDIUM | Gauge weights | Gauge weights must match the active scalar FE space and BC; strict positivity everywhere is not generally correct. | Use no gauge for Robin/Dirichlet; for pure Neumann assemble a valid mean functional over active scalar DOFs, allowing inactive/eliminated DOFs to be absent. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-19 | MEDIUM_HIGH | Periodic tangent transport | `mesh_symmetry_certificate.cpp` computes and stores pairwise `T_dst^T T_src` blocks, but no single canonical constraint consumes them consistently in assembly, RHS projection, output lift and residual reconstruction; gauge-rotation/nonuniform-frame tests are also absent. | Add arbitrary tangent-basis rotation invariance, nonuniform texture projection and periodic seam transfer tests, then use one phase-plus-frame constraint in every Floquet consumer before broad promotion. | resolved_in_docs | source_visible | not_run | `docs/physics/0828-fem-frequency-domain-floquet-demag.md`; `docs/plans/active/fd_sovler_masterplan/23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md`; `backends/fem/include/frequency_domain/mesh_symmetry_certificate.hpp`; `backends/fem/src/frequency_domain/mesh_symmetry_certificate.cpp` |
| F-20 | BLOCKER | GPU modal production claims | GPU macrospin dense proof is not a scalable eigensolver. | Keep the current `gpu_dense_k0_macrospin_modal_eigen` lane scoped to the double-precision no-demag macrospin cell; do not publish broad `gpu_device_resident_modal_eigensolver=true` from one-shot dense paths. | resolved_in_docs | implemented | not_run | `docs/plans/active/fd_sovler_masterplan/17_eigen_k0_gpu_readiness_audit.md`; `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`; `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/eigen/diagnostics/solver.v1.json` |
| F-21 | MEDIUM | GPU descriptor apply residency | One-shot GPU descriptor apply allocates/transfers per call and is not a persistent device context. The current device-Krylov transfer diagnostics expose counts but not the Chapter 11 byte/allocation/workspace-reuse telemetry, so zero transfer counts alone cannot certify persistence. | Build persistent modal context before using GPU apply inside Arnoldi/Krylov; bind `hot_loop_h2d_bytes`, `hot_loop_d2h_bytes`, host/device allocated bytes, allocation count and workspace reuse/rebuild counters into the engine result. Production requires all hot-loop transfer/allocation counters and rebuild count to be zero. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/11_runtime_telemetry_performance.md`; `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`; `backends/fem/include/frequency_domain/gpu_device_krylov.hpp` |
| F-22 | MEDIUM | GPU callback/readiness levels | GPU operator callbacks, shifted apply probes, the no-demag macrospin validation lane and the shared-domain PETSc/SLEPc CUDA lane are different readiness levels and must not be collapsed. | Keep labels separate: `gpu_dense_k0_macrospin_modal_eigen` for the no-demag macrospin validation scope; `gpu_dense_modal_validation` for the bounded dense oracle; `k0_poisson_airbox_gpu_petsc_slepc` for the source-visible shared-domain production adapter; and `gpu_modal_device_krylov` for the planner capability token. Do not promote any label until the exact scope has fresh managed evidence. | resolved_in_docs | source_visible | not_run | `docs/plans/active/fd_sovler_masterplan/17_eigen_k0_gpu_readiness_audit.md`; `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_matrix.json`; `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp`; `backends/fem/gpu/cuda/frequency_domain/modal_krylov.cu` |

## Remediation ownership

The active implementation owner is
`docs/superpowers/plans/2026-07-10-fem-dynamic-solver-remediation.md`. The
following mapping prevents source-visible work from being mistaken for closure:

| Findings | Required remediation tasks | Promotion condition |
|---|---|---|
| F-01, F-05, F-06, F-07, F-09, F-11, F-18 | 10, 17, 18, 22 | Real shared-domain P1 assembly, Kittel-independent solve input, three-level mesh and airbox evidence, and postsolve-only Kittel verification. |
| F-02, F-04, F-10 | 16, 17 | Correct selected-spectrum transform, finite Schur pencil, BC/gauge-correct reconstruction and original residual certification. |
| F-03 | 3, 16 | Typed `sigma=i omega` transform reaches every SLEPc adapter and is emitted in artifacts. |
| F-08, F-15 | 10, 11, 12 | Accepted equilibrium plus common static/dynamic operator provenance and invalidation digest. |
| F-13, F-14, F-17 | 4, 11, 13, 14, 22 | One canonical pencil, physical-power provenance, original residuals, and parity evidence; `source_visible` is not sufficient. |
| F-16, F-19 | 9, 11 | One Floquet phase-plus-frame constraint, full FE topology certificate, and physical nonzero-k dynamic demag before promotion. |
| F-20, F-21, F-22 | 15, 19, 20, 22 | Truthful bounded GPU labels followed by persistent device-resident FGMRES and fresh transfer/residual evidence. |
| F-12 | 1, 22, 23 | Readiness/capability/API claims are generated only from fresh bounded evidence. |

## Current production boundary

The current production boundary is intentionally narrow:

- `modal_eigen/gpu/k0/none` is physics-validated only for the K0-1 no-demag
  macrospin/Larmor field sweep.
- `modal_eigen/cpu/k0/periodic_airbox_k0` has algebra and source evidence but
  not real shared-domain Poisson-airbox production qualification.
- `modal_eigen/gpu/k0/periodic_airbox_k0` retains the target
  `gpu_dense_contract_eigensolver` as source-visible/unvalidated until
  migration; the current emitted GPU modal validation lane is only
  `gpu_dense_k0_macrospin_modal_eigen` for the no-demag macrospin cell.
- `modal_eigen/*/nonzero_k/floquet_airbox_nonzero_k` remains blocked by
  missing dynamic demag-k.
- `driven_response` CPU/GPU periodic-airbox slices are executable in bounded
  Schur/provider lanes, but not production qualified and not modal proof.
- `gpu_device_krylov` and `gpu_modal_device_krylov` remain unvalidated until a
  full device loop and transfer audit exist.

Any future status change must update the JSON readiness matrix first, then
project the new truth into this register and the capability matrix under the
parallel owner.

## Revalidation boundary after master update (2026-08-01)

The branch update was completed before the audit: merge commit
`d5f63b35a4f4a57798089915b312c4695caea917` contains
`origin/master=eee245ac200bf138d880b793791848106b7386ba`, with
`HEAD...origin/master = 25 0`. Focused Python, IR/planner, runner, and UI
tests passed before the managed native run; these tests cover authoring and
contracts, not physical K0 demag qualification.

The managed FEM runtime was rebuilt and its exact commit/source identity was
validated. The container had no NVIDIA driver, so this update has no executed
GPU-device evidence. The aggregate native-contract recipe failed before
compilation because `native/build` was absent in the fresh worktree. The
explicit K0 CPU SLEPc recipe configured PETSc/SLEPc and built the target
binary, but its small SLEPc fixture produced no result after approximately 19
minutes and was terminated with exit code 130.

Accordingly all finding rows whose `verification_state` is `not_run` remain
`not_run`, and the readiness matrix remains the authority. Build identity is
not runtime solver proof; source-visible artifacts are not production
qualification; and GPU compilation without an executed device is not GPU
validation.

## Current recovery snapshot (2026-08-05; supersedes stale implementation prose)

The active recovery branch is `codex/eigensolve-k0-demag` at
`138d95325cee241fae1b6ffa44d3d7c883242cbf`, with dirty source snapshot
`8d6c8a993d9e6361f85430882d570233c6712c40489ab145d8888ba42742fbb5`.
The managed runtime export is currently blocked by a held lock owned by a
stale export process. The current GPU pointer is stale and the matching
PETSc/SLEPc bundle has only been used for syntax/build diagnostics. There is
therefore no fresh current-HEAD CPU solve, GPU-device solve, convergence
matrix, parity/performance record, browser mode-field proof, or release DOD
claim.

The code state has nevertheless advanced beyond the historical rows above:

- CPU K0 shared-domain execution is wired through the real-split Schur
  MatShell route with persistent Poisson factorization, original-unscaled
  block residual reconstruction, cancellation/progress callbacks, and
  positive-frequency filtering. Synthetic algebraic fixtures remain a
  separate oracle.
- GPU K0 shared-domain execution is wired through the PETSc/SLEPc CUDA
  adapter with device-resident operator application and residual workspace,
  persistent context telemetry, and explicit no-fallback diagnostics. The
  implementation is source-visible, not production-qualified.
- The artifact/performance verifiers now require hash-bound native diagnostics
  and managed-runtime telemetry for every performance run; hand-authored or
  summary-only timing cannot pass.
- FDM remains an explicit negative capability for modal Eigenmodes and
  FrequencyResponse. FDM time-domain/FFT response is a separate product path,
  not a modal eigensolve implementation.

The readiness matrix validation state therefore remains unchanged: CPU/GPU
shared-domain K0 cells are source-visible but not promoted until fresh managed evidence satisfies the mesh/airbox
convergence, CPU/GPU parity, device-residency, mode-quality, browser, and
release gates.
