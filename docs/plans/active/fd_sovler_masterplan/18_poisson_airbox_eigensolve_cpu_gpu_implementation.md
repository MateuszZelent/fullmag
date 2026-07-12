---
title: K0 Poisson-airbox modal and driven implementation contract
version: COMSOL-aligned v5.1 decision-complete
status: scoped K0 target contract with explicit current implementation boundaries
role: scoped_normative_implementation_contract_subordinate_to_plan_20_and_physics_notes
---

# K0 Poisson-airbox modal and driven implementation contract

## 1. Scope and current-vs-target boundary

This chapter is the scoped normative implementation contract for FEM `k=0`
dynamic demag on a shared magnetic-plus-airbox domain for both `modal_eigen`
and `driven_response`. The authority order is:

1. physics semantics in `docs/physics/0700-frequency-domain-linearized-llg.md`,
   `docs/physics/0830-fem-poisson-airbox-modal-eigen.md` and
   `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`;
2. the active overarching dynamic-solver audit and remediation contract in
   `20_dynamic_solver_audit_revalidation_and_remediation.md`; and
3. this chapter for the subordinate K0 Poisson-airbox implementation details.

Within that hierarchy, this chapter consumes, without redefining:

- the phasor, sign, unit, damping and operator dictionary in
  `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`;
- the K0 Poisson-airbox physics and residual contract in
  `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`;
- the accepted equilibrium and periodic-certificate contracts in chapters 03
  and 04;
- the end-to-end propagation contract in chapter 16;
- the planner and engine vocabulary in chapters 06 and 08; and
- backend ownership in `docs/architecture/backend-golden-masterplan.md`.

This chapter does not supersede plan 20, does not alter the authority of the
physics notes and is not authority to promote a capability. It is a scoped
target implementation contract only. Implementation, execution and validation
remain independent axes.

### 1.1 Supported target scope

The first qualification scope is:

```text
discretization = fem
product = modal_eigen | driven_response
k = (0,0,0)
dynamic_demag = periodic_airbox_k0
magnetic FE = tangent P1, two DOFs per active magnetic node
potential FE = scalar P1 on magnetic plus airbox domain
periodicity = x and y
open direction = z
outer BC = poisson_robin | poisson_dirichlet | pure_neumann
precision = double
initial modal qualification = alpha=0
```

Nonzero-k dynamic demag, fully periodic three-dimensional K0 demag, arbitrary
high-order FE, broad damped/nonconservative modal qualification and hidden CPU
fallback for strict GPU are outside this contract and reject explicitly.

### 1.2 Current implementation boundary

| Current repository evidence | Honest current status | Target boundary |
|---|---|---|
| `dense_poisson_airbox_eigen_oracle.cpp` and PA-E1 fixtures construct tiny dense blocks. | `synthetic_algebraic_oracle`; bounded algebra evidence only. | Never selected for physical K0 Poisson-airbox execution and never a production fallback. |
| `PoissonAirboxEigenBlockProblem` accepts CSR blocks through ABI v2. | The current validator accepts only `synthetic_algebraic_oracle`; Robin and Dirichlet are rejected because the current descriptor assumes a gauge row. | Replace supplied synthetic blocks with backend-owned `mfem_weak_form_shared_domain` assembly and the exact BC-dependent descriptor. |
| `poisson_airbox_modal_eigen.cpp` creates a monolithic SeqAIJ descriptor and calls SLEPc. | Source-visible/executable for bounded synthetic payloads. It currently passes real `omega_target` to the unrotated lambda pencil. | Use the real-PETSc representation in section 6 and qualify selected interior spectra. |
| Current residual code reports SLEPc backward error and reconstructed magnetic, scalar and gauge blocks. | Useful source evidence; current input validation still requires a pure-Neumann augmentation and overconstrains mean weights. | Certify every accepted mode or response from the original unscaled BC-correct blocks. |
| `poisson_airbox_schur_matshell.cpp` builds and certifies a Schur MatShell. | Algebra-validated against synthetic fixtures only. | Admit Schur only with an exact-signature certificate generated from real shared-domain blocks. |
| Current driven periodic-airbox provider/Schur paths execute for bounded CPU/GPU slices. | They are not the target full coupled `MatNest/PCFIELDSPLIT` solve and do not qualify modal solving. | Cross-check full coupled and Schur driven results on the same P1 blocks and physical RHS. |
| The CUDA frequency-domain source owns a persistent magnetic operator context and bounded dense/apply probes. | Operator residency or a one-shot dense solve is not device Krylov residency. `production_loop_available=false` remains current device-Krylov truth. | Only `gpu_device_krylov` and `gpu_modal_device_krylov` are scalable GPU solver claims. |
| No dedicated frequency-domain shared-domain modal assembler exists. | Real K0 Poisson-airbox modal production is not implemented or qualified. | Stages K0-P1 through K0-P7 and K0-G1 through K0-G4 must pass before scoped promotion. |
| `crates/fullmag-runner/src/fem_eigen.rs::build_pa_e4b_k0_kittel_poisson_airbox_payload` computes `expected_reference_frequency_hz` from the analytical Kittel expression and assigns it to both `target_frequency_hz` and `expected_reference_frequency_hz`. | The analytical answer currently contaminates the synthetic PA-E4b solve request; it is not postsolve-only validation. | K0-P3 removes analytical reference data from descriptor assembly/request construction; only a user-requested target or window may reach the eigensolver. |
| `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` converts that `target_frequency_hz` into the SLEPc target, selects the nearest accepted mode by distance to it, and uses `expected_reference_frequency_hz` for `reference_frequency_certified` pass/fail. | Kittel data currently influences targeting, nearest-mode selection and solver success. | K0-P4 removes analytical-reference selection and pass/fail from the solver. Analytical Kittel comparison is postsolve validation owned by K0-P6 and its independent verifier only. |

Analytical frequencies and demag factors are verifier inputs only. They must
not enter block assembly, spectral targeting, preconditioning, convergence,
mode selection or solver pass/fail. The current
`expected_reference_frequency_hz` payload field is active contamination, not
solver evidence; K0-P3/P4 remove it from solve construction and acceptance,
while K0-P6 performs the analytical Kittel comparison after the solve.

## 2. Mathematical model and FE spaces

### 2.1 Physical equations

Fullmag uses `exp(+i omega t)`, fields in `A/m`, and
`gamma0=mu0*abs(gamma)`. On the magnetic region `Omega_m` and shared domain
`D=Omega_m union Omega_air`:

```text
delta_m = T q
m0 dot delta_m = 0
delta_H_demag = -grad(delta_phi)

int_D grad(psi) dot grad(delta_phi) dV
  + beta int_Gamma_open psi delta_phi dS
  = int_Omega_m Ms delta_m dot grad(psi) dV.
```

The modal and driven contracts are:

```text
modal:  A x = lambda B x,  lambda = i omega
driven: (i omega B - A) x = [b_q, b_phi, 0]
```

Here `A` is the block realization of the dictionary operator `L` together with
the algebraic scalar-potential constraint, and `B` is `B_alpha` on magnetic
rows with zero scalar/gauge rows. This notation does not introduce a second
dynamic-operator convention.

The final zero entry is present only for the pure-Neumann gauge row. A usual
magnetic RF drive has `b_phi=0`; a future scalar source must be explicitly
typed and obey the same row units and signs.

### 2.2 Discrete spaces

Let `N_a` be scalar P1 shape functions on active magnetic nodes, `Psi_i` scalar
P1 shape functions on the shared domain, and `T_a=[t_a1,t_a2]` an orthonormal
tangent frame at magnetic node `a`.

```text
Q_h = {delta_m_h = sum_a N_a T_a q_a}, q_a in C^2
V_h = scalar continuous P1 on D after K0 periodic reduction
V_h^0 = V_h with homogeneous outer Dirichlet classes eliminated
```

The first implementation accepts P1 only. A request with `fe_order != 1`
rejects until every magnetic, scalar, coupling, residual and convergence path
implements that order; silently evaluating a P1 operator on a higher-order
request is forbidden.

### 2.3 Canonical ordering

Ordering is part of the operator signature:

```text
q = [q_0,1, q_0,2, q_1,1, q_1,2, ...]       node-major magnetic order
phi = [phi_0, phi_1, ...]                      reduced scalar true-DOF order
x_R/D = [q, phi]                               Robin or Dirichlet
x_N   = [q, phi, eta]                          pure Neumann
real split = [x_real, x_imag]                  field blocks first, then copy
```

`phi` ordering is produced after complete scalar equivalence classes are
formed and, for Dirichlet, after every reduced class touching the essential
outer boundary is marked and eliminated. The magnetic and scalar reduction
maps, source true-DOF maps and all offsets are artifact fields. A backend may
use another internal layout only through an explicit permutation whose parity
with this canonical ordering is tested and recorded.

## 3. Shared-domain P1 assembly

### 3.1 Blocks and weak forms

For tangent test `v_h=sum_a N_a T_a p_a` and scalar test `psi_h`, the assembler
produces:

```text
P_ij = int_D grad(Psi_i) dot grad(Psi_j) dV
     + beta int_Gamma_open Psi_i Psi_j dS

(C_phi_q q)_i = int_Omega_m Ms (T q) dot grad(Psi_i) dV
A_phiq = -C_phi_q

p^H A_qphi phi
  = int_Omega_m v_h dot [-gamma0 m0 x (-grad(delta_phi_h))] dV

p^H A_qq q
  = weak tangent projection of the accepted static-restoring,
    local, exchange, DMI and other admitted frequency-independent
    derivatives in FrequencyOperatorDictionary.v1

p^H B_qq q
  = gyrotropic/Gilbert tangent mass form from
    FrequencyOperatorDictionary.v1.
```

The sign `A_phiq=-C_phi_q` follows from `P phi=C_phi_q q` and the descriptor
row `A_phiq q+P phi=0`. `A_qq` excludes dynamic demag because that derivative
is represented by `A_qphi`, `A_phiq` and `P`. Static demag remains in the
accepted `h_eff0` contribution to the linearization.

Every block is assembled from the same accepted `LinearizationState`, magnetic
region map, P1 geometry, quadrature rule, `Ms` source and tangent frames. No
block may infer material values from an expected analytical frequency.

### 3.2 SI units by row and column

| Quantity | Unit | Consequence |
|---|---|---|
| `q`, magnetic test coefficient | `1` | normalized tangent perturbation |
| `phi` | `A` | `-grad(phi)` is `A/m` |
| `eta` with normalized `c` | `A m` | `c eta` has scalar-row unit `A m` |
| `P` | `m` | `P phi` is `A m` |
| `C_phi_q`, `A_phiq` | `A m` per unit `q` | same unit as `P phi` |
| `A_qphi` | `m^3/(A s)` | `A_qphi phi` is `m^3/s` |
| `A_qq` | `m^3/s` | magnetic dynamic row |
| `B_qq` | `m^3` | `lambda B_qq q` is `m^3/s` |
| `b_q` | `m^3/s` | projected physical drive RHS |
| `b_phi` | `A m` | scalar equation RHS |
| gauge row `c^T phi` | `A` | mean-potential constraint |

The matrix is not made dimensionally uniform by pretending these blocks have
the same units. Solver scaling is explicit and residual certification returns
to the original physical blocks.

### 3.3 Reciprocal coupling and energy check

`C_phi_q` and the field recovery used by `A_qphi` share element traversal,
quadrature points, Jacobians, `Ms`, tangent frames and periodic maps. For every
test pair `(p,phi)`, use the sesquilinear inner product that is conjugate-linear
in its first argument. The pre-LLG field map must satisfy:

```text
<Ms T p, H_phi(phi)>_Omega_m = -p^H C_phi_q^H phi
H_phi(phi) = -grad(phi).
```

Equivalently, the mixed magnetostatic energy Hessian uses `mu0 C_phi_q^H`
before the `-gamma0 m0 x` dynamic projection. The production gate checks this
identity by element and globally. For each element `e` and for the assembled
global operator it forms

```text
r_rec,e(p,phi) = <Ms T p,H_phi(phi)>_e + p^H C_phi_q,e^H phi
eps_rec,e = |r_rec,e| /
  (|<Ms T p,H_phi(phi)>_e| + |p^H C_phi_q,e^H phi| + eps)
```

and requires both the maximum element residual and the global residual to meet
their declared tolerances for deterministic basis vectors and seeded complex
random pairs. A sign-flip negative control must fail. The gate also checks the
assembled conjugate-adjoint action and verifies the demag energy and field sign
on sphere/ellipsoid oracles. `A_qphi` is not asserted to equal `A_phiq^H`
because the LLG cross-product projection and units are applied after this
energy/field adjoint identity.

### 3.4 Common block scaling

The assembler publishes positive reference scales `L_ref`, `V_m`, `H_ref`,
`Ms_ref` and `gamma0_ref`, then uses one scaling for full, Schur, CPU and GPU
paths:

```text
X = diag(q*=1, phi*=H_ref L_ref, eta*=Ms_ref V_m/L_ref)
R = diag(r_q*=gamma0_ref H_ref V_m,
         r_phi*=Ms_ref V_m/L_ref,
         r_eta*=H_ref L_ref)

A_hat = R^-1 A X
B_hat = R^-1 B X
b_hat = R^-1 b.
```

For Robin/Dirichlet, the `eta` entries are absent. The same `X` and `R` are
duplicated for real and imaginary blocks. Their values and hash are part of
the problem signature and Schur certificate. Scaling may improve conditioning
but may not change signs, branch selection or acceptance; `eps_q`, `eps_phi`,
`eps_gauge` and `eps_full` are recomputed from unscaled original blocks.

## 4. Periodic reduction and outer BC

### 4.1 K0 reduction

The mesh certificate supplies complete magnetic and scalar equivalence classes,
lattice translations and tangent-frame transforms. At K0 the scalar phase is
one, while the magnetic constraint still transports tangent frames:

```text
T_dst q_dst = Q T_src q_src
q_dst = (T_dst^T Q T_src) q_src
phi_dst = phi_src
Q = I for a pure translation.
```

The assembler forms unconstrained element contributions once and reduces them
with magnetic and scalar prolongations `R_q`, `R_phi`:

```text
A_qq   <- R_q^H A_qq R_q
B_qq   <- R_q^H B_qq R_q
A_qphi <- R_q^H A_qphi R_phi
A_phiq <- R_phi^H A_phiq R_q
P      <- R_phi^H P R_phi.
```

Complete corner/edge classes, cycle consistency and independent magnetic and
scalar hashes are mandatory. Pair-only postsolve projection is not an operator.

### 4.2 Closed BC/gauge tuple

| `outer_boundary_kind` | Required parameters | Scalar space and descriptor | Required tuple |
|---|---|---|---|
| `poisson_robin` | finite `beta>0`; Robin mass only on non-periodic open faces | all reduced scalar DOFs; no multiplier | `gauge_policy=none`, `gauge_reason=coercive_outer_boundary` |
| `poisson_dirichlet` | `beta=0`; homogeneous perturbation potential on declared outer faces | essential reduced classes eliminated from `P`, both couplings and vectors; no multiplier | `gauge_policy=none`, `gauge_reason=coercive_outer_boundary` |
| `pure_neumann` | `beta=0`; no essential outer potential | normalized quadrature mean vector `c` and multiplier `eta` | `gauge_policy=mean_zero_augmented`, `gauge_reason=pure_neumann_nullspace` |

For pure Neumann, `c_i=int_D Psi_i dV / int_D 1 dV` on the active reduced
scalar space and `sum_i c_i=1` within assembly tolerance. Eliminated or
inactive entries may have zero weight. Robin or Dirichlet must not carry `c`
or `eta`. Lateral periodicity alone does not create a gauge when the open
boundary is coercive.

Fully periodic 3D K0 rejects before assembly because no macroscopic-field
convention is defined.

## 5. Descriptor and driven block systems

### 5.1 Full systems

For Robin or Dirichlet:

```text
A = [A_qq    A_qphi]       B = [B_qq  0]
    [A_phiq  P     ]           [0     0]
x = [q,phi].
```

For pure Neumann:

```text
A_N = [A_qq    A_qphi  0]
      [A_phiq  P       c]
      [0       c^T     0]

B_N = [B_qq  0  0]
      [0     0  0]
      [0     0  0]

x_N = [q,phi,eta].
```

The modal equation is `A x=lambda B x`. The driven equation is
`(i omega B-A)x=[b_q,b_phi,0]`; signs in any row-rescaled implementation must
map exactly back to this equation.

### 5.2 Schur systems

Let `K_phi=P` for no-gauge boundaries and
`K_phi=[[P,c],[c^T,0]]` for pure Neumann. With the obvious zero extension of
the couplings, define:

```text
S = A_qq - [A_qphi,0] K_phi^-1 [A_phiq;0]

modal:  S q = lambda B_qq q

driven: (i omega B_qq-S) q = b_S
b_S = b_q - [A_qphi,0] K_phi^-1 [b_phi;0].
```

Reconstruction is mandatory:

```text
[phi;eta] = -K_phi^-1 ([A_phiq;0] q + [b_phi;0])
```

with `b_phi=0` for modal solve. The Schur path and full path consume the same
assembled blocks, BC elimination, scaling and Poisson solver policy. A dense
inverse is allowed only in a bounded oracle and is never production evidence.

### 5.3 Finite modes, branch and window

Because `B` is zero on scalar and gauge rows, the full descriptor contains
algebraic/infinite modes. An accepted modal result must:

1. have finite `lambda`, `omega=-i lambda` and nonzero magnetic norm;
2. pass the selected solver's finite-eigenvalue classification;
3. satisfy the requested frequency window after canonical mapping;
4. for the first undamped qualification, satisfy `lambda_imag>0` and exclude
   the declared zero-frequency policy;
5. reconstruct `phi` and `eta` and pass the original full residual; and
6. satisfy window-completeness and conjugate/positive-branch accounting for the
   requested count, where `mode_count` counts physical complex modes rather
   than duplicated real-split vectors.

Sorting or filtering after a wrongly targeted solve does not certify an
interior window.

### 5.4 Residual certification

For every modal candidate:

```text
r_q     = A_qq q + A_qphi phi - lambda B_qq q
r_phi   = A_phiq q + P phi + c eta
r_gauge = c^T phi

eps_q = ||r_q|| /
  (||A_qq q|| + ||A_qphi phi|| + |lambda| ||B_qq q|| + eps)
eps_phi = ||r_phi|| /
  (||A_phiq q|| + ||P phi|| + ||c eta|| + eps)
eps_gauge = |c^T phi| / (||c|| ||phi|| + eps)
eps_full = max(eps_q,eps_phi,eps_gauge).
```

Terms involving `c` and `eta` are zero and `eps_gauge=0` when no gauge exists.
For driven response, residuals are formed directly from
`(i omega B-A)x-b`; the block denominators add the corresponding RHS norm.
The tracked preconditioned/Krylov residual and SLEPc-reported backward error
are diagnostics only. They cannot cap or replace `eps_full`.

## 6. CPU selected-spectrum algorithm

### 6.1 Complex PETSc/SLEPc

With complex scalars, SLEPc consumes the scaled generalized pencil directly.
For an interior target:

```text
sigma=i*omega_target
EPS problem = generalized non-Hermitian
EPS type = Krylov-Schur or Arnoldi
ST = shift-invert or another named, artifact-recorded transform
selection = EPS_TARGET_MAGNITUDE around complex sigma
```

The shifted KSP/PC and its tolerances are part of the engine. A direct shifted
factorization is a bounded CPU baseline; scalable work uses a certified
iterative shifted solve.

### 6.2 Real PETSc target representation

For any complex matrix `M=M_R+i M_I`, define only the algebraic realification
map

```text
R(M) = [ M_R  -M_I ]
       [ M_I   M_R ]

J = [ 0  -I ]
    [ I   0 ]
```

Realification maps a fixed complex operator action to real block form; it does
not turn a generalized eigenproblem with complex `lambda` into a real
generalized eigensystem. The initial real-PETSc lane is narrower: `alpha=0`,
admitted conservative K0 operators, and real `omega`. With the Task 2
dictionary `A=L`, `B=B_alpha`, `lambda=i omega`, and `y=[x_R;x_I]`, its directly
specified real-frequency pencil is

```text
A x = i omega B x
R(A) y = omega R(i B) y

R(i B) = J R(B) = R(B) J.
```

For the energy-Hessian notation `A=K` and `B_alpha=-G`, the exact same pencil
is

```text
R(K) y = omega R(-i G) y.
```

Thus a notation that calls the energy gyrotropic operator `G` by the local name
`B` writes `R(A)y=omega R(-i B)y`; this document keeps `B` reserved for the
Task 2 dictionary operator `B_alpha=-G` and therefore uses `R(i B)`. The complex
lambda target and real-frequency target are linked exactly:

```text
sigma=i*omega_target
tau=omega_target.
```

`EPSSetTarget(tau)` with `EPS_TARGET_MAGNITUDE` is legal only on this named
`real_frequency_rotated` pencil. Its shift-invert solve uses
`R(A)-tau R(i B)=R(A-i tau B)`, which is the real representation of the same
complex shift, not a real-axis approximation to `sigma`. Artifacts record
`spectral_scalar_mode=real_split`, `spectral_pencil_kind=real_frequency_rotated`,
`sigma_real_per_s=0`, `sigma_imag_rad_per_s=omega_target` and `tau=omega_target`.

Multiplication of `x` by `i` maps `y` to `Jy`. Because the real-frequency
pencil commutes with this complex structure, `y` and `Jy` are not two physical
modes. One physical mode is the J-equivalence class

```text
[y]_J = span_R{y,Jy},
q = q_R + i q_I.
```

After the existing positive mass normalization, a simple class receives a
deterministic representative by choosing the smallest canonical magnetic DOF
index `j` attaining `max_k |q_k|`, multiplying the reconstructed full complex
state by `exp(-i arg(q_j))`, and requiring `q_j` to be real and positive within
tolerance. This rule canonicalizes `y` and `Jy` identically. A candidate with
zero magnetic norm is not a physical class.

`requested_mode_count` counts these physical J-equivalence classes. A simple
physical frequency has real eigenspace `span_R{y,Jy}` and therefore real
multiplicity two. A frequency cluster with physical multiplicity `d` must have
an even, J-closed real invariant subspace of dimension `2d`; degenerate-cluster
tests compare frequency multiplicity and subspace projectors, not arbitrary
solver basis vectors. Acceptance requires J-partner residual parity, canonical
reconstruction parity, the declared frequency tolerance, and at least the
requested number of complete physical classes in a certified window.

This rotated real-frequency pencil does not cover Gilbert damping or another
non-Hermitian case with complex `omega`. Such a spectrum requires a separately
specified real generalized formulation with its own eigenvalue mapping and
tests, or a complex PETSc/SLEPc lane. The undamped pencil must not be reused as
if it represented that spectrum.

### 6.3 Selected-spectrum execution and acceptance

The CPU algorithm is:

1. validate the equilibrium, P1 shared-domain mesh, periodic certificate,
   BC/gauge tuple, material sources and exact problem signatures;
2. assemble and scale real FEM blocks once;
3. choose full descriptor or certified Schur before SLEPc setup;
4. create the complex or `real_frequency_rotated` pencil and exact target;
5. configure the selected transform, KSP/PC, count, subspace, tolerance and
   maximum iterations;
6. solve, classify finite modes, form complete J-equivalence classes, map
   `lambda` and `omega`, filter the positive branch and enforce the requested
   physical window/count;
7. undo solver scaling, reconstruct scalar/gauge fields and compute every
   original block residual; and
8. publish converged, rejected and accepted counts plus the exact stop reason.

A mandatory multi-mode interior-window case contains at least three positive
modes around a nonzero interior target. It must select the same mode set in
complex and rotated-real representations. A negative control using a real
target on the unrotated lambda pencil must select the wrong set or fail the
window gate, so a real-axis shift regression cannot pass by post-filtering.

## 7. CPU driven field-split algorithm

The production full-coupled CPU driven engine uses the same blocks as modal
solve:

```text
operator = PETSc MatNest or equivalent nested MatShell for i omega B-A
outer solve = GMRES or FGMRES
preconditioner = PCFIELDSPLIT
magnetic split = accepted tangent dynamic preconditioner
scalar split = BC/gauge-correct PETSc/hypre Poisson solve
```

The physical RF field is converted once to
`b_q=T^T[-gamma0(m0 x delta_h_drive)]` with the magnetic weak mass pairing.
No native solve may reinterpret tangent field samples as an already projected
RHS without the explicit conversion and provenance required by chapter 16.

For a sweep, frequency-independent assembly, reduction, scaling and Poisson
setup are reused under one immutable problem signature. Frequency-dependent
state is limited to `i omega B`, the selected preconditioner update and solve
vectors. Every accepted frequency reports tracked residual history and a
recomputed unpreconditioned full/block residual. Explicit strict field-split
rejects when unavailable. A permitted non-strict fallback may select another
full CPU engine for the identical physical problem only before execution and
must publish requested/resolved engines and `fallback_reason`.

K0-P7 compares full coupled response against direct/Schur response on identical
blocks and against modal resonance only after the modal basis has its own
completeness and full-residual certificate.

## 8. Certified Schur algorithms

### 8.1 Certificate

`schur_reduced` is legal only with a `SchurCertificate` keyed by:

```text
equilibrium, mesh, magnetic/scalar periodic certificate, material, physics,
boundary/gauge, k=(0,0,0), FE order, assembly, operator dictionary, tangent
frame, block ordering, block scaling, scalar representation, precision,
Poisson solver and preconditioner signatures.
```

Any changed key invalidates the certificate. The certificate contains random
and basis-vector apply parity, scalar solve residuals, reciprocal-coupling
checks, full-versus-Schur modal parity, full-versus-Schur driven samples,
reconstruction residuals and accepted tolerances.

### 8.2 Modal Schur

The SLEPc MatShell applies `S q` without forming `P^-1` and uses the same
complex or rotated-real target as the full descriptor. The scalar solve is
reused through an owned PETSc/hypre context. Ritz vectors are magnetic only;
every candidate reconstructs `phi`/`eta` before acceptance. A Schur eigen
residual alone never accepts a mode.

### 8.3 Driven Schur

The driven MatShell applies `i omega B_qq-S` and constructs `b_S` with the same
scalar context. It reconstructs the full response at every accepted frequency.
A runtime scalar-solve or apply-quality violation invalidates the certificate
for the run. Strict Schur rejects. A permitted auto request may replan to the
full coupled CPU engine only before the next solve and records the invalidation
and fallback.

## 9. GPU persistent context and solvers

### 9.1 Truthful GPU labels

| Label | Contract | Solver claim |
|---|---|---|
| `gpu_dense_contract_eigensolver` | bounded dense synthetic algebra oracle | validation only; non-scalable |
| `gpu_descriptor_apply_probe` | one-shot parity of full descriptor action | probe only |
| `gpu_shifted_apply_probe` | one-shot parity of the correctly shifted/rotated action or solve | probe only |
| `gpu_persistent_operator_context` | setup-once device ownership of accepted blocks and reusable actions | context/readiness only |
| `gpu_modal_device_krylov` | device-resident SLEPc modal iteration, shifted solves and Ritz state | scalable modal solver |
| `gpu_device_krylov` | device-resident PETSc KSP driven iteration and preconditioner | scalable driven solver |

Only the final two labels are scalable solver claims. A probe or dense result
cannot set either label, even when its arithmetic ran on a GPU.

### 9.2 Persistent allocation and lifetime

`gpu_persistent_operator_context` is created once per exact problem signature
and owns, on device:

- reduced mesh/geometry, region maps, tangent frames, material fields and
  periodic/Dirichlet maps;
- `A_qq`, `A_qphi`, `A_phiq`, `P`, `B_qq`, `c`, scaling and permutations, as
  assembled matrices or equivalent MFEM/libCEED/CUDA actions;
- PETSc CUDA vectors, MatShell/MatNest state, hypre device Poisson/shifted
  preconditioner state and reusable work vectors; and
- for solver contexts, Krylov basis, restart workspace, Ritz vectors and all
  device-side orthogonalization/reduction state required by PETSc/SLEPc.

Setup H2D is allowed and counted. Final eigenvector/response export and
explicit output-cadence snapshots may copy D2H and are counted. Per-iteration
vector or matrix H2D/D2H, host dot/norm/axpy, host Arnoldi/Hessenberg updates
or host preconditioner state invalidate a device-resident solver claim.
Context destruction is deterministic on success, rejection, interruption and
exception; a changed signature creates a new context rather than mutating an
accepted one in place.

### 9.3 Modal and driven execution

`gpu_modal_device_krylov` uses PETSc CUDA objects and SLEPc Krylov-Schur or
Arnoldi. The complex/rotated-real target, restart/subspace size, converged Ritz
count, rejected finite-mode count and stop reason are explicit. Shift-invert
uses a PETSc/hypre device solve with measured contraction and no hidden host
factorization. Accepted Ritz vectors are reconstructed and certified against
the original full blocks before final D2H export.

`gpu_device_krylov` uses PETSc KSP GMRES/FGMRES over the full or certified Schur
driven action. Restart, right preconditioner, tracked residual, periodically
recomputed true residual and convergence reason are device-engine state.

Both engines publish:

```text
krylov_vector_location=device
operator_buffer_location=device
preconditioner_buffer_location=device
setup_h2d_transfer_count
final_d2h_transfer_count
per_iteration_h2d_transfer_count=0
per_iteration_d2h_transfer_count=0
operator_apply_count
preconditioner_apply_count
krylov_iteration_count
restart_count
```

Strict GPU rejects when any required block, device scalar representation,
Poisson/shifted preconditioner, memory admission or transfer audit is missing.
It never routes to CPU or to `gpu_operator_host_krylov` while retaining a
device-resident label.

## 10. Artifacts and exact rejection reasons

### 10.1 Required artifact envelope

Every attempted solve publishes the available subset of the common artifact
envelope; successful promotion requires all applicable fields:

| Area | Required fields or target artifact |
|---|---|
| Identity | git/build/run identity; `physics_contract_version`; `operator_dictionary_version` |
| Intent | product, frequency/window/count, K0, demag, requested device/precision/method/strictness |
| Resolution | resolved engine/device/precision, selection reason, fallback flag/reason |
| Inputs | equilibrium, mesh, material, physics, boundary, tangent-frame and certificate hashes |
| FE assembly | `assembly_kind=mfem_weak_form_shared_domain`, `fe_order=1`, quadrature, DOF counts/maps/orderings, block/scaling hashes, reciprocity diagnostics |
| BC/gauge | outer boundary, beta, gauge policy/reason, eliminated DOFs or normalized `c` diagnostics |
| Spectrum | scalar mode, pencil kind, `sigma`/`tau`, transform, KSP/PC, finite/converged/rejected/accepted counts, branch/window completeness |
| Driven | physical drive and projected-RHS provenance, frequency point, KSP/PC/restart/stop reason |
| Certification | `eps_q`, `eps_phi`, `eps_gauge`, `eps_full`, tracked/backend residuals as separate diagnostics |
| Residency | context identity, buffer locations, allocation bytes, setup/final/per-iteration transfer counts |
| Status | independent `implementation_state`, `validation_state`, `validated_scope`, native status, `complete` |

Target named artifacts include:

```text
eigen/diagnostics/solver.v1.json
eigen/spectrum.v2.json
response/diagnostics/solver.v1.json
response/frequency-points/{frequency_index}.json
validation/k0_poisson_airbox/manufactured_poisson.v1.json
validation/k0_poisson_airbox/reciprocity.v1.json
validation/k0_poisson_airbox/interior_window.v1.json
validation/k0_poisson_airbox/kittel_convergence.v1.csv
validation/k0_poisson_airbox/cpu_gpu_parity.v1.json
validation/k0_poisson_airbox/gpu_transfer_audit.v1.json
```

Analytical reference values appear only in validation artifacts produced or
consumed by an independent verifier after the solve. They are not accepted as
assembly or eigensolver inputs.

### 10.2 Rejection tokens

| Exact token | Trigger | Fallback |
|---|---|---|
| `k0_poisson_airbox_requires_accepted_equilibrium` | missing or unaccepted equilibrium | none |
| `k0_poisson_airbox_signature_mismatch` | any equilibrium/mesh/material/physics/boundary hash mismatch | none |
| `k0_poisson_airbox_requires_shared_domain_mesh` | magnetic-plus-airbox coverage or region map absent | none |
| `k0_poisson_airbox_requires_periodic_mesh_certificate_v6` | required complete magnetic/scalar classes or hashes absent | none |
| `k0_poisson_airbox_unsupported_fe_order` | any accepted space is not P1 | none |
| `k0_poisson_airbox_unsupported_k` | any k component is nonzero beyond canonical tolerance | none |
| `k0_poisson_airbox_fully_periodic_3d_unsupported` | no open direction/macroscopic convention | none |
| `k0_poisson_airbox_invalid_boundary_gauge_tuple` | BC, beta, gauge, reason, weights or multiplier disagree | none |
| `k0_poisson_airbox_real_fem_assembly_unavailable` | real shared-domain assembler is absent for the request | no synthetic substitution |
| `k0_poisson_airbox_scalar_manufactured_validation_failed` | scalar P1 sign, BC, gauge or convergence oracle fails | none |
| `k0_poisson_airbox_reciprocity_check_failed` | energy/field coupling identity exceeds tolerance | none |
| `k0_poisson_airbox_descriptor_parity_failed` | assembled full descriptor disagrees with independent action/oracle | none |
| `k0_poisson_airbox_real_split_target_unavailable` | real PETSc path cannot form `real_frequency_rotated` | no unrotated real target |
| `k0_poisson_airbox_cpu_solver_parity_failed` | direct, complex and rotated-real selected spectra disagree | none |
| `k0_poisson_airbox_no_finite_modes` | no finite magnetic mode survives classification | none |
| `k0_poisson_airbox_interior_window_incomplete` | requested count/window completeness is not certified | none |
| `k0_poisson_airbox_full_residual_not_certified` | any required original block residual exceeds tolerance | none |
| `k0_poisson_airbox_kittel_convergence_failed` | real-film mesh, padding, field-sweep or demag-physics gate fails | none |
| `k0_poisson_airbox_schur_certificate_missing` | explicit Schur request has no exact-signature certificate | strict: none; auto may choose a legal full engine before solve |
| `k0_poisson_airbox_schur_certificate_invalid` | certificate key or runtime quality check fails | strict: none; auto may choose a legal full engine before solve |
| `k0_poisson_airbox_physical_drive_rhs_invalid` | field-to-RHS conversion/provenance absent or inconsistent | none |
| `k0_poisson_airbox_driven_crosscheck_failed` | full, Schur, direct or qualified modal response comparisons disagree | none |
| `k0_poisson_airbox_gpu_persistent_context_unavailable` | required device allocation/action/context is absent | strict GPU: none |
| `k0_poisson_airbox_gpu_operator_parity_failed` | GPU block/action/Poisson result disagrees with CPU | none |
| `k0_poisson_airbox_gpu_shifted_solve_failed` | persistent shifted action/solve fails parity or contraction | none |
| `k0_poisson_airbox_gpu_device_krylov_unavailable` | scalable device modal/driven loop is absent | strict GPU: none |
| `k0_poisson_airbox_gpu_solver_parity_failed` | device Krylov modal/driven result disagrees with qualified CPU result | none |
| `k0_poisson_airbox_gpu_transfer_audit_failed` | per-iteration migration or host hot-loop state is observed | none |
| `k0_poisson_airbox_cpu_gpu_qualification_failed` | exact-scope physics, parity, residency, performance or memory gate fails | none |
| `k0_poisson_airbox_synthetic_assembly_not_production` | synthetic oracle attempts a production claim | none |

Native status is `validation_error` for malformed or contradictory inputs,
`unavailable` for a legal request whose engine is absent, `operator_error` for
assembly/action failures and `solve_error` for convergence or certification
failure. Failed and interrupted attempts retain requested/resolved provenance,
the primary token, supporting diagnostics and available partial artifacts.

## 11. Implementation sequence

Stages are ordered. A later stage may be developed behind a probe, but it may
not promote until all predecessor gates for its claimed scope pass.

### 11.1 CPU stages

| Stage | Owner paths | Inputs | Outputs | Required artifacts | Exact stage rejections | Promotion gate |
|---|---|---|---|---|---|---|
| K0-P1 manufactured scalar Poisson assembly | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.*`; `backends/fem/tests/frequency_domain/` | P1 shared mesh, scalar classes, BC tuple, beta | reduced `P`, Dirichlet map or `c/eta` layout | `manufactured_poisson.v1.json` | `k0_poisson_airbox_requires_shared_domain_mesh`; `k0_poisson_airbox_invalid_boundary_gauge_tuple`; `k0_poisson_airbox_scalar_manufactured_validation_failed` | Robin, Dirichlet and pure-Neumann manufactured solutions converge at P1 order; only Neumann has a gauge. |
| K0-P2 reciprocal magnetic/scalar coupling | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.*`; `backends/fem/cpu/mfem/` | K0-P1 output, `Ms`, tangent frames, magnetic classes | `C_phi_q`, `A_phiq`, field recovery and `A_qphi` | `validation/k0_poisson_airbox/reciprocity.v1.json` | `k0_poisson_airbox_reciprocity_check_failed` | Element/global adjoint-energy checks, sign-flip negative control and sphere/ellipsoid field-energy checks pass. |
| K0-P3 real full descriptor assembly | `backends/fem/cpu/frequency_domain/operators/`; `backends/fem/include/frequency_domain/` | accepted linearization, K0-P1/P2, `A_qq`, `B_qq`, scaling; no analytical reference | BC-correct sparse `A`, `B`, canonical maps/signatures; production request with analytical Kittel fields removed | `eigen/diagnostics/solver.v1.json#assembly` | `k0_poisson_airbox_unsupported_fe_order`; `k0_poisson_airbox_real_fem_assembly_unavailable`; `k0_poisson_airbox_descriptor_parity_failed` | Random-vector parity against independent element assembly and dense tiny full descriptor passes; changing Kittel metadata cannot change any block, target or signature. |
| K0-P4 CPU sparse-direct and SLEPc parity | `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.*`; `backends/fem/cpu/frequency_domain/slepc_modal_eigen.*`; `backends/fem/cpu/frequency_domain/engines/sparse_direct/` | K0-P3 descriptor, user-requested complex or rotated-real target/window, tiny admitted case; no expected frequency | direct baseline and selected finite physical mode classes | `validation/k0_poisson_airbox/interior_window.v1.json` | `k0_poisson_airbox_real_split_target_unavailable`; `k0_poisson_airbox_cpu_solver_parity_failed`; `k0_poisson_airbox_no_finite_modes` | Complex/real-split and direct/SLEPc frequency clusters, physical multiplicities and invariant subspaces agree; wrong-axis negative control fails; analytical Kittel data cannot affect selection or solver pass/fail. |
| K0-P5 residual and finite-mode certification | `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.*` | K0-P4 candidates, original unscaled blocks | accepted/rejected modes, reconstructed `phi/eta`, block errors | `eigen/diagnostics/solver.v1.json#residuals`; `eigen/spectrum.v2.json` | `k0_poisson_airbox_interior_window_incomplete`; `k0_poisson_airbox_full_residual_not_certified` | Every accepted mode passes finite classification, branch/window completeness and all original block tolerances. |
| K0-P6 real-film Kittel convergence | `examples/`; `scripts/verify_fem_frequency_domain_eigen_artifacts.py`; managed `justfile` gate | accepted real equilibria, at least three mesh levels, independent airbox-padding levels, field sweep | solved spectra and independent Kittel comparison | `kittel_convergence.v1.csv` plus equilibrium/mesh/airbox provenance | `k0_poisson_airbox_kittel_convergence_failed` plus any exact predecessor token | Mesh and padding convergence, field sweep, demag sign and managed-runtime evidence pass without analytical data entering the solver. |
| K0-P7 CPU driven full-coupled/modal cross-check | `backends/fem/cpu/frequency_domain/engines/field_split/`; `backends/fem/cpu/frequency_domain/production_cpu_driven_response.*`; `backends/fem/cpu/frequency_domain/modal_response.*` | same K0-P3 blocks, physical drive, frequency sweep, qualified modal basis when used | full coupled, Schur and qualified reduced responses | `response/diagnostics/solver.v1.json`; `response/frequency-points/{frequency_index}.json` | `k0_poisson_airbox_physical_drive_rhs_invalid`; `k0_poisson_airbox_schur_certificate_invalid`; `k0_poisson_airbox_full_residual_not_certified`; `k0_poisson_airbox_driven_crosscheck_failed` | Full/Schur responses agree on certified samples; resonance agrees with independently qualified modes; original driven residual passes at every point. |

The planned `operators/poisson_airbox_shared_domain.*` owner is a dedicated
frequency-domain subsystem. It may reuse static demag mesh, boundary and MFEM
utilities, but it must not add frequency-domain assembly or solver ownership to
`Context` or `mfem_bridge.cpp`.

### 11.2 GPU stages

| Stage | Owner paths | Inputs | Outputs | Required artifacts | Exact stage rejections | Promotion gate |
|---|---|---|---|---|---|---|
| K0-G1 GPU operator and Poisson parity | `backends/fem/gpu/cuda/frequency_domain/operators/`; `backends/fem/gpu/cuda/demag_poisson/`; GPU FD tests | K0-P3 blocks/signatures and CPU probe vectors | `gpu_descriptor_apply_probe`, Poisson and coupling action parity | GPU apply/Poisson section in `cpu_gpu_parity.v1.json` | `k0_poisson_airbox_gpu_persistent_context_unavailable`; `k0_poisson_airbox_reciprocity_check_failed`; `k0_poisson_airbox_gpu_operator_parity_failed` | Double-precision CPU/GPU action, scalar solve, BC/gauge and reconstructed field parity pass on identical assembled inputs. |
| K0-G2 persistent shifted solve | `backends/fem/gpu/cuda/frequency_domain/preconditioners/`; `backends/fem/gpu/cuda/frequency_domain/residency/`; PETSc/hypre adapters | K0-G1 context, rotated-real or complex shift, admitted memory | `gpu_persistent_operator_context`, `gpu_shifted_apply_probe`, contraction/transfer telemetry | `validation/k0_poisson_airbox/gpu_transfer_audit.v1.json` | `k0_poisson_airbox_gpu_persistent_context_unavailable`; `k0_poisson_airbox_gpu_shifted_solve_failed`; `k0_poisson_airbox_gpu_transfer_audit_failed` | Repeated shifted applies/solves reuse allocations, match CPU and show zero per-iteration migration. |
| K0-G3 GPU modal/driven Krylov | `backends/fem/gpu/cuda/frequency_domain/engines/`; `backends/fem/gpu/cuda/frequency_domain/modal/`; `backends/fem/include/frequency_domain/gpu_device_krylov.hpp` | K0-G2 context, selected modal or driven request | `gpu_modal_device_krylov` and `gpu_device_krylov` results | `eigen/diagnostics/solver.v1.json`; `response/diagnostics/solver.v1.json`; GPU transfer audit | `k0_poisson_airbox_gpu_device_krylov_unavailable`; `k0_poisson_airbox_gpu_solver_parity_failed`; `k0_poisson_airbox_interior_window_incomplete`; `k0_poisson_airbox_full_residual_not_certified` | PETSc/SLEPc device hot loops converge, restart correctly, reconstruct full fields and pass original residuals without host hot-loop state. |
| K0-G4 CPU/GPU production qualification | `backends/fem/tests/frequency_domain/`; `scripts/`; managed `justfile` gates | exact CPU/GPU problem bundles over qualified size/field/mesh/padding sets | bounded capability evidence and performance/memory envelope | `cpu_gpu_parity.v1.json`, Kittel convergence, response parity, transfer audit | `k0_poisson_airbox_cpu_gpu_qualification_failed` plus any exact predecessor token | Exact scoped CPU/GPU parity, physics convergence, residency, strict intent, managed runtime and performance gates pass; only that `validated_scope` may be promoted. |

## 12. Definition of done

This contract is implemented for an exact scope only when all of the following
are true:

1. A physical request consumes an accepted equilibrium, shared-domain P1 mesh,
   complete K0 magnetic/scalar certificate and valid BC/gauge tuple.
2. Backend-owned MFEM assembly emits `mfem_weak_form_shared_domain` blocks with
   canonical ordering, units, scaling, signatures and reciprocal-coupling
   evidence. No synthetic or analytical builder participates.
3. Modal full and certified Schur paths represent `sigma=i*omega_target`
   correctly for the PETSc scalar build, detect the wrong-axis negative control,
   select finite positive-window modes and reconstruct the full descriptor.
4. Driven full field-split and certified Schur paths consume the physical drive
   conversion, reuse the same blocks and pass full/block residuals at every
   accepted frequency.
5. `eps_full=max(eps_q,eps_phi,eps_gauge)` from the original unscaled operator
   is within tolerance; backend, transformed and preconditioned residuals remain
   separate diagnostics.
6. Real-film mesh and airbox-padding convergence, field-swept Kittel comparison,
   demag sign/energy and modal-driven cross-checks pass through independent
   verifiers. Expected values are never solver inputs.
7. A GPU promotion uses `gpu_modal_device_krylov` or `gpu_device_krylov`, owns a
   persistent device context, passes CPU parity and records zero per-iteration
   migration. Dense and apply probes remain probe-labelled.
8. Strict requested intent never falls back silently; every rejection uses an
   exact token and preserves partial diagnostics.
9. Artifacts expose requested/resolved execution, implementation and validation
   axes, bounded `validated_scope`, all signatures, BC/gauge, scalar/target,
   residual and residency evidence.
10. Authoritative runtime proof uses the repository's container-backed managed
    `just` gates. Host-only or source-only evidence cannot promote capability.

Until these conditions pass, current capability rows remain bounded by their
existing exact evidence and the target stage remains unimplemented or
unqualified as appropriate.

### 12.1 Production-scope documentation assertions

The following assertions are normative documentation gates. They deliberately
do not claim that the feature is qualified today; they define the complete
evidence set that the final production record must bind for each exact CPU or
GPU scope:

1. CPU stages `K0-P1` through `K0-P6` and GPU stages `K0-G1` through `K0-G4`
   have passed with their required artifacts and exact rejection controls.
2. The managed `libpetsc-real-dev`/`libslepc-real-dev` runtime records
   `spectral_scalar_mode=real_split`,
   `spectral_pencil_kind=real_frequency_rotated`, `sigma=i*omega_target`, and
   `tau=omega_target`; a real target on the original `lambda=i omega` pencil
   is a required wrong-axis negative control.
3. `Spectrum` publishes bounded selected-window metadata, physical
   J-equivalence classes, counts, branch completeness, residuals, stop reason,
   requested/resolved execution, and the exact validation-scope identity.
4. Native `q` and reconstructed `phi` are published as revisioned Cartesian
   mode fields on the binary data plane, with mesh/topology identity, units,
   representation, mode identity, and validation sidecars. Fabricated or
   runner-synthesized mode vectors cannot satisfy this assertion.
5. The unified viewport proves selected-mode real, imaginary, magnitude, and
   phase-rotated rendering through a visible, non-lost WebGL canvas with a
   nonzero drawing buffer, a selected-mode visual difference, a phase-change
   visual difference, and bounded memory across repeated mode switches.
6. `frequency_domain_production_dod.v1` binds immutable passing evidence for
   `DOD-01` through `DOD-14` for the exact CPU or GPU scope. A partial,
   stale, hidden-fallback, or scope-mismatched record cannot promote a
   capability.
