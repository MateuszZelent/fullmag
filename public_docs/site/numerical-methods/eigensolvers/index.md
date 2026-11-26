---
title: Eigensolvers
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: linearized-llg, modal-validation
---

(public-docs-numerical-methods-eigensolvers-root)=
(numerical-methods-eigensolvers-index)=
# Eigensolvers

This section documents the numerical eigensolver pipeline used by FullMag to compute small-amplitude
spin-wave normal modes, eigenfrequencies $f_n = \omega_n/(2\pi)$, modal damping rates $\sigma_n$,
spatial mode profiles $\delta\mathbf m_n(\mathbf x)$, and magnonic dispersion relations $f_n(\mathbf k)$
around a verified static micromagnetic equilibrium $\mathbf m_0(\mathbf x)$.

## End-to-end modal architecture

The modal solver spans four strictly separated layers with immutable provenance handoffs:

| Architectural layer | Primary responsibility | Key source files |
|---|---|---|
| **Python DSL & ProblemIR** | Declares `EigenmodesStageSpec`, `FemEigenSolverPolicy`, `KPath`, `BiasFieldSweep`, `ModeTracking`, `magnetostatic_bc="open_airbox_k0"`, and diagnostic `equilibrium_acceptance="force"`; lowers to `StudyIR::Eigenmodes`. | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L1159), [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L182), [`crates/fullmag-ir/src/study.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/study.rs#L1502) |
| **Planner, `pure_prism_p2` Guard & R4 Handoff** | Resolves `FemEigenPlanIR`, classifies `open_airbox_k0` vs periodic $\Gamma$-point vs nonzero-$\mathbf k$ Floquet execution (`open_airbox_k0_execution_requested`), enforces `pure_prism_p2` certificate guards for `prism6` meshes (`validate_pure_prism_topology_certificate_against_mesh`), and validates equilibrium handoff (`accepted_relax_handoff_for_eigen_stage` / diagnostic `forced_relax_acceptance_requests`). | [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L6107), [`crates/fullmag-ir/src/mixed_certificate.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/mixed_certificate.rs#L1855), [`crates/fullmag-cli/src/orchestrator.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-cli/src/orchestrator.rs#L2976) |
| **Runner, V6 Certificate & Tracking** | Materializes $\mathbf m_0$, binds the cryptographic V6 certificate (including identity-view certificates for `open_airbox_k0`), dispatches multi-$\mathbf k$ worker processes (`EigenKProcessPool`), and performs consistent-$P_1$ mass-weighted Hungarian + SVD Procrustes branch tracking. | [`crates/fullmag-runner/src/fem/eigen_equilibrium.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/eigen_equilibrium.rs#L388), [`crates/fullmag-runner/src/fem/eigen_certificate.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/eigen_certificate.rs#L1193), [`crates/fullmag-runner/src/eigen/k_process_pool.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/k_process_pool.rs#L798), [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/tracking.rs#L1222) |
| **Native C++ MFEM / PETSc / SLEPc & GPU `cuDSS`** | Builds the nodal tangent frame $(\mathbf e_1, \mathbf e_2, \mathbf m_0)$, assembles coupled $(q,\phi)$ blocks with consistent P1 static $h_\parallel$, executes CPU `MATSHELL` Schur shift-invert or GPU Hermitian augmented `cuDSS` shifts (qualified for `open_airbox_k0`; memory-guarded inertia cache and narrow single-$\mathbf k$ GPU Floquet `augmented_floquet_cudss_cuda` source-visible and contract-tested), and certifies unreduced coupled residuals. | [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2352), [`backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp#L310), [`backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp#L147), [`backends/fem/gpu/frequency_domain/modal_cudss_shift.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_cudss_shift.cpp#L171) |

## Recent solver milestones

- **Isolated-body open airbox (`open_airbox_k0`)**: Isolated bodies in a Robin airbox execute
  $\mathbf k = \mathbf 0$ dynamic-demag eigensolves with identity equivalence classes, zero periodic
  pairs, and consistent static P1 $h_\parallel$ substitution on both FEM CPU and qualified FEM GPU.
- **Qualified FEM GPU open-airbox eigensolve & guarded `cuDSS` shifts**: The production GPU modal
  lane replaces nested Krylov iterations with Hermitian equilibrated augmented $(q,\phi)$ `cuDSS`
  shifts, post-analysis VRAM budget admission (`check_device_memory_budget`), lifted QR Rayleigh–Ritz
  projection, and a single-solve exact-shift inertia cache (`count_airbox_augmented_window`).
- **Narrow single-$\mathbf k$ GPU Floquet slice**: `solve_gpu_floquet_shared_domain` and
  `solve_floquet_airbox_augmented_ritz` (`augmented_floquet_cudss_cuda`) are implemented and
  contract-tested for single-point conservative ($\alpha = 0$) Bloch problems while keeping an honest
  distinction from full managed end-to-end physical qualification.
- **Diagnostic `equilibrium_acceptance="force"` & `pure_prism_p2` guard**: Non-converged relaxation
  handoffs can be opted into explicitly for diagnostics (carrying measured residual torque and
  `forced=true`), while uncertified `prism6` meshes fail closed before native execution.

## Chapters in this section

* {doc}`linearized-llg` — tangent-plane projection, rate-form and energy-Hessian operator pencils,
  shared-domain $(q,\phi)$ magnetostatic Schur complement, `open_airbox_k0`, qualified GPU Hermitian
  augmented `cuDSS` shifts, guarded single-$\mathbf k$ GPU Floquet, diagnostic forced equilibrium
  handoff, and consistent-$P_1$ branch tracking.
* {doc}`modal-validation` — analytical Kittel ferromagnetic resonance sweep models, Kalinikos–Slavin
  dipole-exchange thin-film dispersion ($n=0$), GPU open-airbox and `cuDSS` Floquet verification
  gates, coupled $(q,\phi)$ residual certification, and the COMSOL nonzero-$\mathbf k$ dispersion
  benchmark harness.

## Cross-links

* {ref}`numerical-methods-performance-fem-spectral-multiphysics`
* {doc}`/python-api/studies/eigenmodes`
* {doc}`/python-api/outputs/modes-and-spectra`
* {doc}`/python-api/outputs/dispersion-and-response`
* {doc}`/numerical-methods/frequency-domain/index`
* {doc}`/frontend/capability-register`

```{toctree}
:hidden:
:maxdepth: 1

linearized-llg
modal-validation
```
