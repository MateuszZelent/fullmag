---
title: Frequency-driven solver - algebra and operator representations
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Algebra and operator representations

## 1. Layer separation

```text
Physics:       Cartesian delta_m, constraint m0·delta_m=0
Adapter:       delta_m = T q
Algebra:       A(omega)x=b
Representation: dense/sparse/full-coupled/Schur/modal/GPU
Engine:        backend-specific solve
```

Callbacks must not secretly mix those layers without diagnostics.

## 2. Cartesian constrained oracle

Tiny physical oracle:

```text
[ A_cart  C^T ] [delta_m] = [b]
[ C       0   ] [lambda ]   [0]
```

or tangent elimination:

```text
A_t = T^T A_cart T
b_t = T^T b_cart
```

## 3. Tangent 2-DOF operator

```text
q in C^(2N)
delta_m = T q
```

Internal real-split convention:

```text
A_real(omega) = [K, +omega M; -omega M, K]
```

must be linked to the COMSOL phase contract by tests.

## 4. Full-coupled demag/airbox

Reference production form:

```text
[ A_qq(omega)  A_qphi   ] [q]   = [b_q]
[ A_phiq       A_phiphi ] [phi] = [b_phi]
```

Full-coupled is needed for:

```text
true residual
Poisson/gauge/nullspace diagnostics
field-split preconditioner
Schur certification
```

## 5. Schur reduced

```text
S(omega) = A_qq(omega) - A_qphi A_phiphi^-1 A_phiq
b_S      = b_q - A_qphi A_phiphi^-1 b_phi
```

Schur is only a certified fast path.

## 6. Sparse/direct

```text
assemble CSR/BSR real split
solve with direct sparse solver
compute true residual
```

In v5 status, the patch queue reports a PETSc `KSPPREONLY + PCLU` MVP for CPU sparse/direct baseline. This is a diagnostic production slice, not the final scalable sparse architecture.

## 7. Modal/eigen

Frequency sweeps should use modal or reduced-basis response when certified:

```text
x(omega) ≈ V c(omega)
```

Basis provenance must include:

```text
operator hash
equilibrium hash
material hash
boundary hash
demag hash
phase convention
frequency window
completeness certificate
```

## 8. GPU device representation

`gpu_device_krylov` requires device residency for:

```text
x, b, r, w, V, Z
operator buffers
preconditioner buffers
orthogonalization
residual estimate
```

Current host GMRES with GPU-backed operators remains `gpu_operator_host_krylov`.
