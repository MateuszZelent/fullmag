---
title: Frequency-domain physics and numerics audit register
date: 2026-07-10
status: implementation_status
runtime_revalidated_in_this_update: false
source_revision_basis: static code and existing repository evidence
---

# Physics and numerics audit register

This file replaces the previous narrative audit with a current finding
register. It does not claim new runtime proof. No tests, builds, examples,
managed runtimes or solvers were run for this update.

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

`docs/specs/capability-matrix-v0.md` and `.json` are consumed without editing.
Parallel dynamic-solver remediation owns:

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

This task intentionally does not edit the capability matrix to avoid
overwriting parallel work.

## Finding register

| ID | Severity | Affected scope | Finding | Required disposition | Documentation state | Code state | Verification state | Evidence paths |
|---|---|---|---|---|---|---|---|---|
| F-01 | BLOCKER | K0-3 CPU Poisson-airbox modal, Kittel demag, GPU promotion | PA-E4b/topology-shaped Kittel payload is not real shared-domain FEM Poisson-airbox assembly. | Keep synthetic/topology-shaped payload as algebra evidence only; require `production_periodic_airbox_claim=false`; build separate `mfem_weak_form_shared_domain` assembly with Kittel answer removed from operator inputs. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`; `crates/fullmag-runner/src/fem_eigen.rs`; `25_frequency_domain_readiness_matrix.json` |
| F-02 | BLOCKER | K0 Poisson-airbox modal BC/gauge | Mean-zero gauge is invalid for Robin/Dirichlet coercive scalar blocks. | Enforce boundary/gauge tuple: Robin/Dirichlet use `gauge_policy=none`; pure Neumann uses mean-zero; keep unsupported combinations fail-closed until implemented. | resolved_in_docs | implemented | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-03 | BLOCKER | CPU SLEPc modal selected spectrum | Real PETSc/SLEPc target still uses a real `target_omega` instead of the canonical `sigma=i*omega` or a proven real-split equivalent. | Implement one explicit target realization: complex PETSc, real-split transformed pencil, or a rigorously derived real Hamiltonian/gyrotropic pencil; artifact must publish sigma components and scalar mode. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-04 | BLOCKER | Modal descriptor residual certification | Full residual certification previously could hide bad reconstruction by taking the smaller SLEPc residual. | Certify only the reconstructed blockwise original-unscaled descriptor residual; publish SLEPc, scaled and transformed residuals separately as diagnostics; use `eps_full_original_unscaled=max(eps_q,eps_phi,eps_gauge)`. | resolved_in_docs | implemented | not_run | `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`; `docs/plans/active/fd_sovler_masterplan/11_runtime_telemetry_performance.md` |
| F-05 | BLOCKER | K0-3 Kittel geometry | The K0-3 validation fixture must be x/y periodic and open-z; a one-axis PBC strip is not the ideal film oracle. | Require x/y periodic magnetic and airbox pair metadata or relabel the fixture as a finite strip with a different independent oracle. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`; `examples/fem_eigen_k0_kittel_periodic_airbox.py`; `docs/plans/active/fd_sovler_masterplan/24_production_definition_of_done.md` |
| F-06 | HIGH | K0-3 convergence and production validation | The old convergence gate did not require real mesh/airbox convergence. | Enforce at least three mesh levels and at least three airbox-padding levels with independent oracle, branch tracking, raw rows and separate budgets. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/09_validation_certification_benchmarks.md`; `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`; `scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py` |
| F-07 | HIGH | Kittel verifier and mode-quality artifacts | The verifier must enforce mode-quality thresholds, not only metric presence. | Enforce residual, uniformity, overlap, tangent leakage, seam mismatch and equilibrium thresholds from the validation metadata. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/09_validation_certification_benchmarks.md`; `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`; `scripts/verify_fem_frequency_domain_eigen_artifacts.py` |
| F-08 | HIGH | Equilibrium handoff for modal/driven sweeps | Frequency-domain linearization must consume accepted per-scope equilibrium, static demag and provenance; relaxation step count is not evidence. | Require accepted `EquilibriumArtifact -> LinearizationState` with mesh/material/physics hashes, torque residual, static demag and bias-field identity for every sample or an explicit analytic proof. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/03_relaxed_texture_linearization.md`; `docs/plans/active/fd_sovler_masterplan/16_end_to_end_fem_frequency_domain_implementation.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md` |
| F-09 | HIGH | Demag block signs, reciprocity and energy | Nonzero coupling blocks alone do not prove the demag operator's weak-form reciprocity or energy sign. | Add directional-derivative, Hessian reciprocity and energy-sign gates independent of Kittel. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`; `docs/plans/active/fd_sovler_masterplan/09_validation_certification_benchmarks.md` |
| F-10 | HIGH | Singular descriptor modal pencil | Singular `B` needs finite-mode policy, algebraic-mode rejection and full descriptor reconstruction. | Prefer certified Schur-reduced magnetic pencil; if monolithic descriptor remains, publish finite-mode filters, regularity, `q^H B q` and algebraic-mode rejection. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-11 | HIGH | Kittel demag oracle and `M_eff` | One scalar `M_eff` is not a general Kittel oracle and must not leak into operator construction. | Keep `H1`, `H2`, `N0`, `N1`, `N2` or fitted stiffnesses as verifier-only outputs; remove expected Kittel values from builder, targeting, selection and solver pass/fail. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`; `crates/fullmag-runner/src/fem_eigen.rs`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-12 | HIGH | Status governance and capability labels | Historical status text mixed normative contract, implementation evidence, runtime capability and validated production status. | Use `25_frequency_domain_readiness_matrix.json` as the current active status source and let parallel remediation link capability rows to it. | resolved_in_docs | implemented | not_run | `docs/plans/active/fd_sovler_masterplan/10_patch_queue_current_status.md`; `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_matrix.json`; `docs/specs/capability-matrix-v0.md` |
| F-13 | HIGH | Driven response absorbed-power sign | Absorbed-power observable must have a fixed sign convention under `exp(+i*omega*t)`. | Use `absorbed_by_magnetization` with `p_abs = -0.5*mu0*Ms*omega*Im(conj(h_drive) dot delta_m)` and add damped macrospin checks before validation. | resolved_in_docs | open | not_run | `docs/physics/0700-frequency-domain-linearized-llg.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `docs/plans/active/fd_sovler_masterplan/02_physics_contract.md` |
| F-14 | HIGH | Modal/driven sign dictionary | Modal, driven and real-split paths need one operator dictionary for `L`, `B_alpha`, `A_omega`, `lambda`, `omega` and `b`. | Keep 0831 as the single dictionary; production code must use one canonical dynamic pencil and prove fused/apply parity before promotion. | resolved_in_docs | open | not_run | `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `docs/physics/0700-frequency-domain-linearized-llg.md`; `docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md` |
| F-15 | HIGH | Static and dynamic demag consistency | Static demag in `h_eff0` and dynamic demag derivative must share mesh/material/BC/operator provenance. | Require common operator/equilibrium digest; invalidate Schur certificates and artifacts when any static/dynamic demag input changes. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/03_relaxed_texture_linearization.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `docs/specs/frequency-domain-artifacts-v2.md` |
| F-16 | HIGH | Nonzero-k dynamic demag | Nonzero-k dynamic demag must remain hard blocked until complex Bloch `grad_k/div_k` assembly exists. | Reject `k!=0 && include_demag` without `floquet_airbox` dynamic-demag-k operator; no fallback to K0, no-demag projection, open boundary, dense validation or CPU for strict GPU. | resolved_in_docs | implemented | not_run | `docs/physics/0828-fem-frequency-domain-floquet-demag.md`; `docs/plans/active/fd_sovler_masterplan/23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md`; `backends/fem/src/frequency_domain/driven_response_solver.cpp`; `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` |
| F-17 | MEDIUM_HIGH | Driven residuals and preconditioners | Driven response needs reconstructed original-unscaled block/full residuals and preconditioner quality, not only tracked GMRES residual; the target acceptance lane is not yet claimed as emitted. | Publish tracked residuals only as diagnostics; accept only `driven_original_unscaled_full_relative_residual` and original-unscaled block residuals against the original operator; publish Schur contraction ratio and threshold when defined, otherwise `null` plus `not_applicable`/`not_available`; keep the target lane open until artifacts emit the full contract under root `runtime_telemetry`. | resolved_in_docs | source_visible | not_run | `docs/plans/active/fd_sovler_masterplan/11_runtime_telemetry_performance.md`; `.fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime/artifacts/response/diagnostics/solver.v1.json`; `backends/fem/src/frequency_domain/driven_response_solver.cpp` |
| F-18 | MEDIUM | Gauge weights | Gauge weights must match the active scalar FE space and BC; strict positivity everywhere is not generally correct. | Use no gauge for Robin/Dirichlet; for pure Neumann assemble a valid mean functional over active scalar DOFs, allowing inactive/eliminated DOFs to be absent. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-19 | MEDIUM_HIGH | Periodic tangent transport | Tangent-frame transport needs gauge-invariance tests for nonuniform texture, not only seam pair storage. | Add arbitrary tangent-basis rotation invariance, nonuniform texture projection and periodic seam transfer tests before broad Floquet promotion. | resolved_in_docs | open | not_run | `docs/physics/0828-fem-frequency-domain-floquet-demag.md`; `docs/plans/active/fd_sovler_masterplan/23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md`; `backends/fem/src/frequency_domain/mesh_symmetry_certificate.cpp` |
| F-20 | BLOCKER | GPU modal production claims | GPU macrospin dense proof is not a scalable eigensolver. | Keep the current `gpu_dense_k0_macrospin_modal_eigen` lane scoped to the double-precision no-demag macrospin cell; do not publish broad `gpu_device_resident_modal_eigensolver=true` from one-shot dense paths. | resolved_in_docs | implemented | not_run | `docs/plans/active/fd_sovler_masterplan/17_eigen_k0_gpu_readiness_audit.md`; `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`; `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/eigen/diagnostics/solver.v1.json` |
| F-21 | MEDIUM | GPU descriptor apply residency | One-shot GPU descriptor apply allocates/transfers per call and is not a persistent device context. | Build persistent modal context before using GPU apply inside Arnoldi/Krylov; transfer audit must show no per-iteration allocation or H2D/D2H. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/11_runtime_telemetry_performance.md`; `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`; `backends/fem/include/frequency_domain/gpu_device_krylov.hpp` |
| F-22 | MEDIUM | GPU callback/readiness levels | GPU operator callbacks, shifted apply probes, the current dense macrospin eigensolve and the target dense-contract eigensolver are different readiness levels and must not be collapsed. | Keep labels separate: current emitted GPU modal validation lane `gpu_dense_k0_macrospin_modal_eigen`; target/source-visible `gpu_dense_contract_eigensolver` until migration; `gpu_operator_host_krylov`; `gpu_device_krylov`; `gpu_modal_device_krylov`. Do not call the target dense-contract label emitted until artifacts publish it. | resolved_in_docs | source_visible | not_run | `docs/plans/active/fd_sovler_masterplan/17_eigen_k0_gpu_readiness_audit.md`; `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_matrix.json`; `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`; `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/eigen/diagnostics/solver.v1.json` |

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
