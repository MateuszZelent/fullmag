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

The normative sign, unit, and operator definitions are
[`FrequencyOperatorDictionary.v1` in physics note 0831](../../../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md).
The equations below are a representation summary of that dictionary, not a
second convention.

## 1. Layer separation

```text
Physics:       Cartesian delta_m, constraint m0·delta_m=0, fields in A/m
Adapter:       delta_m = T q
Algebra:       D(omega)q=(i omega B-L)q=b
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

Canonical modal and driven forms:

```text
L q = lambda B q
lambda = i omega
D(omega) q = (i omega B - L) q = b
b = T^T[-gamma0 (m0 x delta_h_drive)]
gamma0 = mu0 * abs(gamma)
```

Here fields are in `A/m`, `gamma` is explicitly typed in `rad/(s T)`, and
`gamma0` is in `rad s^-1 per (A/m)`. For `L=K` in the physical energy-Hessian
form, `B=-G` at `alpha=0`, giving `K phi=-i omega G phi`.

The general real split is:

```text
D(omega) = D_R + i D_I
[ D_R  -D_I ] [q_R] = [b_R]
[ D_I   D_R ] [q_I]   [b_I]
```

The special case `[K,+omega*M;-omega*M,K]` is valid only with the explicit
mapping `K=-L` and `M=B`. Backends may not infer that mapping from matrix shape.

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

For the Poisson-airbox descriptor, the accepted residual is reconstructed on
the original blocks:

```text
r_q     = A_qq q + A_qphi phi - lambda B_qq q
r_phi   = A_phiq q + P phi + c eta
r_gauge = c^T phi
eps_full = max(eps_q, eps_phi, eps_gauge)
```

The boundary/gauge tuple follows
[note 0830](../../../physics/0830-fem-poisson-airbox-modal-eigen.md): Robin with
`beta>0` and Dirichlet use no gauge; pure Neumann uses the quadrature-assembled
mean-zero augmentation. A lateral periodic constraint does not create a gauge
nullspace when the open boundary is coercive.

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

The spectral mapping is:

```text
lambda = lambda_r + i lambda_i
omega = -i lambda
positive undamped branch: lambda_i > 0
frequency_hz = Re(omega)/(2*pi) = lambda_i/(2*pi)
sigma = i*omega_target
```

For real PETSc/SLEPc, `sigma` must be represented by the explicit real-split
transformed pencil. A real `EPSSetTarget(omega_target)` on the original
imaginary-eigenvalue spectrum is forbidden unless a separately named
real-frequency pencil is derived and its mapping is published.

Gilbert damping and nonconservative torques make the pencil non-Hermitian.
Those paths must not use Hermitian-only solvers or right-eigenvector-only modal
projection. Direct modal response requires left and right eigenvectors,
declared normalization, biorthogonality and conditioning diagnostics; otherwise
use a residual-certified Petrov-Galerkin/rational Krylov model or the full
solver.

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

## 8. Damping and response observables

```text
omega_complex = omega_r + i Gamma
exp(i omega_complex t) = exp(i omega_r t - Gamma t)
Gamma > 0 for decay
damping_rate_hz = Gamma/(2*pi)
linewidth_fwhm_hz = Gamma/pi
p_abs = -0.5*mu0*Ms*omega*Im(conj(h_drive) dot delta_m)
observable = absorbed_by_magnetization
```

These are summaries of the canonical convention in
[note 0831](../../../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md),
with the absorbed-power SI derivation in
[note 0700](../../../physics/0700-frequency-domain-linearized-llg.md). They are
not backend-selectable signs. Positive Gilbert damping must yield positive
absorbed power near resonance.

## 9. GPU device representation

`gpu_device_krylov` requires device residency for:

```text
x, b, r, w, V, Z
operator buffers
preconditioner buffers
orthogonalization
residual estimate
```

Current host GMRES with GPU-backed operators remains `gpu_operator_host_krylov`.
