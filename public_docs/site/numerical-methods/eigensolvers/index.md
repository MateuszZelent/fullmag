---
title: Eigensolvers
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0600-fem-eigenmodes-linearized-llg.md
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
| **Python DSL & ProblemIR** | Declares `EigenmodesStageSpec`, `FemEigenSolverPolicy`, `KPath`, `BiasFieldSweep`, `ModeTracking`, and validation schemas; lowers to `StudyIR::Eigenmodes`. | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L1), [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L1), [`crates/fullmag-ir/src/study.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/study.rs#L1) |
| **Planner & R4 Handoff Gate** | Resolves `FemEigenPlanIR`, classifies $\Gamma$-point vs nonzero-$\mathbf k$ Bloch/waveguide execution, and enforces converged equilibrium handoff (`accepted_relax_handoff_for_eigen_stage`). | [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L1), [`crates/fullmag-cli/src/orchestrator.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-cli/src/orchestrator.rs#L1) |
| **Runner, V6 Certificate & Tracking** | Materializes $\mathbf m_0$, binds the cryptographic V6 certificate, dispatches multi-$\mathbf k$ worker processes (`EigenKProcessPool`), and performs consistent-$P_1$ mass-weighted Hungarian + SVD Procrustes branch tracking. | [`crates/fullmag-runner/src/fem/eigen_equilibrium.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_equilibrium.rs#L1), [`crates/fullmag-runner/src/fem/eigen_certificate.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_certificate.rs#L1), [`crates/fullmag-runner/src/eigen/k_process_pool.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/k_process_pool.rs#L1), [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking.rs#L1) |
| **Native C++ MFEM / PETSc / SLEPc** | Builds the nodal tangent frame $(\mathbf e_1, \mathbf e_2, \mathbf m_0)$, assembles the coupled $(q,\phi)$ shared-domain blocks, evaluates the matrix-free `MATSHELL` Schur complement $S(\tau)$, gates inner shifted KSP residuals, and certifies full coupled eigenpair residuals. | [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L1), [`backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp#L1), [`backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp#L1) |

## Chapters in this section

* {doc}`linearized-llg` — tangent-plane projection, rate-form and energy-Hessian operator pencils,
  shared-domain $(q,\phi)$ magnetostatic Schur complement, real-split SLEPc shift-and-invert, 3D
  Floquet vs 2.5D waveguide dispersion operators, and consistent-$P_1$ branch tracking.
* {doc}`modal-validation` — analytical Kittel ferromagnetic resonance sweep models, Kalinikos–Slavin
  dipole-exchange thin-film dispersion ($n=0$), and coupled $(q,\phi)$ residual qualification gates.

## Cross-links

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
