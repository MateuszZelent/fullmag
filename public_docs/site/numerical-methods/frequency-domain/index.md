---
title: Frequency Domain
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: response-solver, floquet-response
---

(public-docs-numerical-methods-frequency-domain-root)=
(numerical-methods-frequency-domain-index)=
# Frequency-domain solvers

This section documents the harmonic driven frequency-response solvers in FullMag. Whereas the modal
eigensolvers ({doc}`/numerical-methods/eigensolvers/index`) solve the homogeneous eigenvalue problem
for free spin-wave resonances, the frequency-domain response solvers evaluate the forced steady-state
complex magnetization response $\widehat{\mathbf q}(\omega)$, dynamic Polder susceptibility tensor
$\widehat{\boldsymbol\chi}(\omega)$, and cycle-averaged absorbed power density $p_{\mathrm{abs}}(\omega)$
under a time-harmonic excitation field $\widehat{\mathbf h}_{\mathrm{ext}}\mathrm e^{-\mathrm i\omega t}$.

## Architectural overview

| Component | Role in driven response pipeline | Key source files |
|---|---|---|
| **Python DSL & ProblemIR** | Authors `FrequencyResponseStageSpec`, `FrequencyResponseSolverPolicy` (`auto`, `gpu_sparse_direct`, `gpu_operator_host_krylov`, `schur_reduced`, `dense_reference`), `SaveResponse`, and `FloquetBC`; lowers to `StudyIR::FrequencyResponse`. | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L117), [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L217) |
| **Planner, Runtime Gate & Accepted Artifacts** | Validates periodic/Floquet constraint sets (`frequency_response_periodic_constraint_sets`), enforces the solver-method runtime gate (`frequency_response_solver_method_rejection_reason`), and publishes bounded accepted native FEM frequency-response artifacts (`collect_publish_accepted_frequency_response_artifacts`). | [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L7087), [`crates/fullmag-runner/src/frequency_response.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response.rs#L223), [`crates/fullmag-runner/src/frequency_response/accepted_artifacts.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response/accepted_artifacts.rs#L279) |
| **Native CPU & GPU `cuDSS` Shifted Linear Solvers** | Assembles $\mathsf A(\omega) = \mathsf K - \mathrm i\omega\mathsf G$ (or coupled $(q,\delta\phi)$ CSR blocks), executes CPU GMRES / Schur Krylov or GPU factor-once `cuDSS` general complex LU (`solve_driven_response_gpu_cudss`), and certifies unpreconditioned unscaled residuals per frequency point. | [`backends/fem/src/frequency_domain/driven_response_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/driven_response_solver.cpp#L17743), [`backends/fem/gpu/frequency_domain/driven_response_cudss.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/driven_response_cudss.cpp#L1301), [`crates/fullmag-runner/src/eigen/response_block_real.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/response_block_real.rs#L226) |

## Recent solver milestones

- **Accepted native FEM frequency response:** Native FEM frequency-response sweeps execute end-to-end
  through the accepted study worker with bounded artifact storage, native FMR observable retention,
  and live study catalog binding.
- **GPU Driven Response `cuDSS` (`gpu_sparse_direct`):** Guarded general complex FP64 sparse LU
  with 1× symbolic analysis, in-place GPU update of the $4 N_{m,\mathrm{eff}}$ frequency-dependent
  diagonal entries, exact 2×2 geometric block pre-scaling plus 6-pass Ruiz equilibration, VRAM
  preflight, and fused unscaled GPU residual certification. Verified on RTX 4080 SUPER:
  **`151.3×–454×`** faster than CPU GMRES on open-airbox P2 Robin and **`2.89×–4.22×`** faster
  than GPU GMRES on `periodic_airbox_k0`, scaling to **`42,907` complex DOFs** with `0` perturbed
  pivots.

## Chapters in this section

* {doc}`response-solver` — harmonic ansatz, shifted tangent system $\mathsf A(\omega)\widehat{\mathbf q} = \widehat{\mathbf b}$,
  accepted native FEM sweep pipeline, GPU `cuDSS` direct sparse solver (`gpu_sparse_direct`),
  susceptibility and absorbed power definitions, and unscaled true-residual gates.
* {doc}`floquet-response` — Bloch–Floquet phase prolongation $C(\mathbf k)$ and 2.5D waveguide
  shifted-gradient operators for driven response at $\mathbf k \neq \mathbf 0$, plus the explicit
  runtime boundary against `gpu_sparse_direct`.

## Cross-links

* {ref}`numerical-methods-performance-fem-spectral-multiphysics`
* {doc}`/numerical-methods/eigensolvers/index`
* {doc}`/python-api/studies/frequency-response`
* {doc}`/python-api/outputs/dispersion-and-response`
* {doc}`/frontend/capability-register`

```{toctree}
:hidden:
:maxdepth: 1

response-solver
floquet-response
```
