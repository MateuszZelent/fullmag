---
title: Frequency Domain
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0700-frequency-domain-linearized-llg.md
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
| **Python DSL & ProblemIR** | Authors `FrequencyResponseStageSpec`, `FrequencyResponseSolverPolicy`, `SaveResponse`, and `FloquetBC`; lowers to `StudyIR::FrequencyResponse`. | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L1), [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L1) |
| **Planner & Runtime Gate** | Validates periodic/Floquet constraint sets (`frequency_response_periodic_constraint_sets`) and enforces the explicit solver-method runtime gate (`frequency_response_solver_method_rejection_reason`). | [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L1), [`crates/fullmag-runner/src/frequency_response.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/frequency_response.rs#L1) |
| **Native Shifted Linear Solver** | Assembles $\mathsf A(\omega) = \mathsf K - \mathrm i\omega\mathsf G$, solves $\mathsf A(\omega)\widehat{\mathbf q} = \widehat{\mathbf b}(\omega)$ across frequency samples, and gates acceptance on the unpreconditioned residual $\varepsilon_{\mathrm{true}}(\omega)$. | [`backends/fem/src/frequency_domain/driven_response_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/driven_response_solver.cpp#L1), [`crates/fullmag-runner/src/eigen/response_block_real.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/response_block_real.rs#L1) |

## Chapters in this section

* {doc}`response-solver` — harmonic ansatz, shifted tangent system $\mathsf A(\omega)\widehat{\mathbf q} = \widehat{\mathbf b}$,
  susceptibility and absorbed power definitions, and true-residual gates.
* {doc}`floquet-response` — Bloch–Floquet phase prolongation $C(\mathbf k)$ and 2.5D waveguide
  shifted-gradient operators for driven response at $\mathbf k \neq \mathbf 0$.

## Cross-links

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
