---
title: Numerical Methods
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-root)=
# Numerical Methods

This family documents algorithms that operate on an already defined spatial discretization:
time integration, relaxation, demagnetization solves, eigensolvers, frequency-domain response,
state transfer, and computational optimizations and hardware acceleration.

Meshing is intentionally owned by the Backend branch at {doc}`meshing/index`, because geometry
realization, topology, airbox construction, and quality governance form an independent subsystem.

| Area | Scope |
| --- | --- |
| {doc}`time-integration/index` | Explicit Runge–Kutta (`heun`, `rk4`, `rk23`, `rk45`), fixed-step `abm3`, adaptive coupled `coupled_imex_ark2`, history PI stepping, and FEM tangent-plane methods |
| {doc}`relaxation/index` | Overdamped LLG, projected-gradient Barzilai–Borwein (`projected_gradient_bb`, including device-resident CUDA and FEM exchange-mass preconditioning), nonlinear CG, and accepted-state stop rules |
| {doc}`demag-solvers/index` | FDM Hermitian half-spectrum cuFFT convolution, FEM Poisson-airbox (`CG/AMG` and guarded `cuDSS` Cholesky, including `pure_prism_p2`), GPU/CPU FEM–BEM, and periodic demagnetization |
| {doc}`eigensolvers/index` | Linearized LLG modal solvers on CPU/GPU (open-airbox `k=0`, periodic `k=0`, guarded `cuDSS` shifts, single-$k$ Floquet) and modal validation |
| {doc}`frequency-domain/index` | Driven harmonic response (`CPU GMRES`, `gpu_operator_host_krylov`, `gpu_sparse_direct` `cuDSS`) and Floquet response |
| {doc}`interpolation-and-state-transfer/index` | Cross-backend FEM $\leftrightarrow$ FDM state interpolation and continuation contracts |
| {ref}`numerical-methods-performance` | Computational optimizations, GPU acceleration, direct solvers, kernel fusion, and RTX A/B benchmarks across FDM, FEM, and multiphysics |

```{toctree}
:maxdepth: 2

time-integration/index
relaxation/index
demag-solvers/index
eigensolvers/index
frequency-domain/index
interpolation-and-state-transfer/index
performance/index
```
