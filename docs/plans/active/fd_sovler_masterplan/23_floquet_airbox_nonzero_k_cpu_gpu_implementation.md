---
title: Nonzero-k Floquet-airbox CPU/GPU implementation contract
version: target v6 decision-complete
status: normative target with explicit current implementation boundaries
role: scoped_normative_implementation_contract
---

# Nonzero-k Floquet-airbox CPU/GPU implementation contract

## 1. Scope, authority and production boundary

This chapter is the scoped implementation contract for FEM frequency-domain
nonzero-k dynamic demagnetization on an x/y-periodic, open-z shared
magnetic-plus-airbox domain. It covers both `modal_eigen` and
`driven_response`, on CPU and GPU, in double precision.

The authority order is:

1. the phase, field, sign and physical validation semantics in
   [physics note 0828](../../../physics/0828-fem-frequency-domain-floquet-demag.md);
2. the matched-mesh equivalence-class and frame-transport contract in
   [chapter 04](04_mesh_periodic_floquet_airbox.md);
3. the K0 block, unit, BC/gauge, residual and device-residency contract in
   [chapter 18](18_poisson_airbox_eigensolve_cpu_gpu_implementation.md); and
4. this chapter for the ordered nonzero-k CPU/GPU implementation.

This chapter does not redefine the physics notes and does not promote any
capability. It defines the target algorithm and the evidence required to move
an exact scope along independent implementation and validation axes.

### 1.1 Target product signature

```text
discretization = fem
product = modal_eigen | driven_response
k != (0,0,0), canonicalized in the lateral reciprocal cell
k unit = rad/m
spin_wave_bc = floquet
magnetostatic_bc = floquet_airbox
dynamic_demag = true
magnetic FE = tangent P1 on Omega_m
potential FE = complex scalar P1 on D = Omega_m union Omega_air
periodic directions = x and y
open direction = z
outer BC = poisson_robin | poisson_dirichlet | pure_neumann
precision = double
```

The first production scope is laterally periodic and open in z. A nonzero
`k_z`, fully periodic three-dimensional demag, nonmatching periodic faces,
higher-order FE spaces and a finite isolated airbox substitution are different
capabilities and are rejected by this contract.

### 1.2 Non-negotiable representation choice

The production operator is backend-owned complex Bloch differential assembly:

```text
grad_k u = grad(u) - i k u
div_k v  = div(v) - i k dot v
```

These signs follow from the canonical boundary phase
`u(r+R)=exp(-i*k dot R)u(r)` and the decomposition of the physical Bloch field
as `u_phys(r)=exp(-i*k dot r)u_cell(r)`. An implementation with opposite signs
uses a different phase convention and is not accepted by relabelling its
artifacts.

The production FE spaces contain cell-periodic amplitudes. Their geometric
periodic reduction uses the accepted equivalence classes: the magnetic
amplitude applies `G_pair`, and the scalar amplitude is periodic. Bloch phase
enters the production operator through `grad_k`/`div_k`, not through a solved
K0 field.

Matched-mesh `C_m(k)` and `C_phi(k)` constraints are an independently
assembled pre-solve oracle. They are required to certify the production
operator over a bounded accepted k domain, but they are not the production
operator, solver, preconditioner or fallback. Equivalence is established only
by matrix parity for assembled fixtures and action parity for matrix-free
fixtures over that domain. K0-only agreement is insufficient.

## 2. Current status and canonical status axes

No runtime, build, test, example or solver workload was executed for this
documentation change. Current status is therefore bounded by the consumed
canonical documents and must not be promoted from this contract.

Status is always reported on these independent axes:

```text
implementation_state: absent | contract_only | source_visible | executable
validation_state: unvalidated | algebra_validated | physics_validated | production_qualified
validated_scope: bounded workload, signatures, k domain and evidence, or no validated scope
```

`product_status` is a separate compatibility label. In particular,
`partial_production_executable` does not imply `physics_validated` or
`production_qualified`.

| Nonzero-k dynamic-demag slice | implementation_state | validation_state | product_status | validated_scope |
|---|---|---|---|---|
| Complex Bloch `grad_k`/`div_k` production assembly | `contract_only` | `unvalidated` | Not separately classified. | No validated scope: the consumed current-status documents identify numerical FEM dynamic demag-k as a contract gap. |
| Matched-mesh `C_m(k)`/`C_phi(k)` oracle and accepted-domain equivalence certificate | `contract_only` | `unvalidated` | Not separately classified. | No validated scope: pair metadata or phase-projection behavior is not the independent block/action oracle required here. |
| CPU `modal_eigen` with `floquet_airbox` dynamic demag | `absent` | `unvalidated` | Unavailable. | No validated scope. Existing no-demag Floquet or K0 Poisson-airbox slices do not satisfy this signature. |
| CPU `driven_response` with `floquet_airbox` dynamic demag | `absent` | `unvalidated` | Unavailable. | No validated scope. Existing K0 provider/Schur response slices do not satisfy this signature. |
| GPU `modal_eigen` with `floquet_airbox` dynamic demag | `absent` | `unvalidated` | Unavailable. | No validated scope. Dense probes and K0 macrospin evidence are not a general device modal engine. |
| GPU `driven_response` with `floquet_airbox` dynamic demag | `absent` | `unvalidated` | Unavailable. | No validated scope. A GPU operator with host Krylov and K0 demag is not nonzero-k device Krylov. |

No row becomes `executable` until its numeric operator and selected engine run
for the exact signature. No row becomes `production_qualified` until every
applicable stage in Sections 9 and 10 passes and `validated_scope` names the
bounded k, mesh, material, BC, product, device and precision envelope.

## 3. K domain, phase and periodic input contract

### 3.1 Canonical k representation

`k` is a finite Cartesian vector in `rad/m`. The planner stores both requested
and resolved vectors and the reciprocal-lattice shift used to map the request
to the declared first Brillouin cell. For this x/y-periodic, open-z contract:

```text
k = (kx, ky, 0) rad/m
kz = 0 exactly after unit conversion and canonicalization
```

An exactly Gamma-equivalent resolved vector belongs to the K0 contract in
chapter 18 and is resolved there before a nonzero-k engine is selected. This
is deterministic request classification, not runtime fallback. Once a
nonzero-k plan is accepted, it must not snap, clamp or replan to K0.

The accepted k domain is part of the operator-parity and production
qualification certificate. It records:

```text
primitive lattice vectors and reciprocal basis
requested and resolved k bounds or explicit sample set in rad/m
reciprocal-cell boundary inclusion policy
mesh and FE-order signature
material, equilibrium and tangent-frame signatures
outer-boundary and scalar-space signature
phase convention and phase tolerance
```

Claims outside that exact domain remain unvalidated even if the same engine is
executable there.

### 3.2 Phase wrapping and cycle tolerance

For every lattice translation `R`, compute in double precision:

```text
theta_raw = k dot R
theta = remainder(theta_raw, 2*pi) in (-pi, pi]
phase = exp(-i*theta)
phase_wrap_tolerance_rad = 1.0e-10
```

Path and corner phases agree only when
`abs(remainder(theta_a-theta_b,2*pi)) <= phase_wrap_tolerance_rad`. The mesh
certificate is admissible at a requested k only when its translation
uncertainty satisfies
`norm(k)*translation_residual_max_m <= phase_wrap_tolerance_rad/4`; numerical
phase evaluation and cycle closure consume the remaining tolerance. The
corresponding complex-phase check uses
`abs(phase_a-phase_b) <= 2*sin(phase_wrap_tolerance_rad/2)` plus double-roundoff
slack of `64*machine_epsilon`.

This tolerance certifies phase equivalence only. It never changes the requested
k, never converts a nonzero-k operator into K0 and never relaxes matrix/action
or physical validation tolerances.

### 3.3 Required matched topology

The input contains complete, independently hashed equivalence classes for:

- tangent magnetic DOFs on `Omega_m`, including representative-to-member
  lattice translations and `G_pair=T_dst^T R_orient T_src`; and
- scalar-potential DOFs on the full shared domain `D`, including every lateral
  magnetic and airbox side-face class.

Corners and edges have one path-independent representative. Magnetic and
scalar classes use the same lattice basis and phase convention but remain
different FE-space objects. Missing scalar airbox coverage cannot be inferred
from magnetic classes. Missing magnetic frame transport cannot be replaced by
scalar phase-only constraints.

## 4. Production complex Bloch operator

### 4.1 Domains, unknowns and physical field

Let `Omega_m` be the magnetic region and
`D=Omega_m union Omega_air` the conformal shared magnetostatic domain. The
unknowns are:

```text
delta_m = T q             on Omega_m, q in C^(2 N_m)
delta_phi                 on D,       phi in C^(N_phi)
delta_M = Ms delta_m      on Omega_m
delta_H_demag = -grad_k(delta_phi) on Omega_m

div_k(grad_k(delta_phi)) = div_k(delta_M) on Omega_m
div_k(grad_k(delta_phi)) = 0              on Omega_air
```

`q` and magnetic test functions do not exist in `Omega_air`. The air region
contributes to the scalar Poisson block, its open-z boundary term and field
reconstruction, but has no `Ms delta_m` source. `Ms`, equilibrium, materials,
region maps and tangent frames come from one accepted linearization signature;
no expected dispersion or analytical frequency may enter assembly.

### 4.2 Complex scalar weak form

With the sesquilinear convention conjugate-linear in the test argument, define
`g_k=grad_k`. For scalar basis functions `Psi_i` on D:

```text
P_ij(k) = int_D conjugate(g_k Psi_i) dot (g_k Psi_j) dV
        + beta int_Gamma_open_z conjugate(Psi_i) Psi_j dS

(C_phi_q(k) q)_i
  = int_Omega_m Ms (T q) dot conjugate(g_k Psi_i) dV

A_phiq(k) = -C_phi_q(k)
P(k) phi = C_phi_q(k) q
```

This is the weak form of the canonical magnetostatic relation with
`delta_H_demag=-grad_k(delta_phi)`. The signs are identical to chapter 18 at
K0. Multiplying a complete scalar row by a documented nonzero scale is legal
only when residual reconstruction maps back to these original signs and
units.

The potential-to-magnetic coupling is assembled from the same element
geometry, quadrature, `Ms`, tangent frames and phase convention:

```text
p^H A_qphi(k) phi
  = int_Omega_m v_h dot
    [-gamma0 m0 x (-grad_k(delta_phi_h))] dV
```

The pre-LLG field/source pair must pass the complex adjoint-energy identity
before the LLG cross-product projection. `A_qphi(k)` is not declared equal to
`A_phiq(k)^H`, because their row units and the dynamic projection differ.

### 4.3 Full modal and driven blocks

The production assembler emits:

```text
A(k) = [A_qq(k)    A_qphi(k)]
       [A_phiq(k)  P(k)     ]

B(k) = [B_qq(k)  0]
       [0        0]

modal:  A(k) x = lambda B(k) x, lambda = i omega
driven: (i omega B(k)-A(k)) x = [b_q,b_phi]
x = [q,phi]
```

`A_qq(k)` contains every admitted non-demag tangent derivative assembled with
the same Bloch convention, including k-dependent exchange and any explicitly
qualified nonreciprocal term. Dynamic demag is represented only by
`A_qphi(k)`, `A_phiq(k)` and `P(k)` and is not duplicated in `A_qq(k)`.
`B_qq(k)` uses the accepted tangent mass/gyrotropic contract and matching
periodic reduction.

For pure Neumann open-z faces at resolved nonzero lateral k, the `|k|^2` part
of `P(k)` removes the constant-potential nullspace; no gauge row is added. The
exact K0 limit changes to chapter 18's `mean_zero_augmented` tuple. Solver code
must derive nullspace and gauge from the assembled BC/k tuple, not from the
word `periodic`.

### 4.4 SI units

| Quantity | Unit | Required consequence |
|---|---|---|
| `k` | `rad/m` | `k dot R` is a dimensionless phase in radians. |
| `q`, magnetic test coefficient | `1` | normalized tangent perturbation |
| `phi` | `A` | `-grad_k(phi)` is `A/m`. |
| `P(k)` | `m` | `P(k) phi` is `A m`. |
| `C_phi_q(k)`, `A_phiq(k)` | `A m` per unit `q` | same scalar-row unit as `P(k) phi` |
| `A_qphi(k)` | `m^3/(A s)` | `A_qphi(k) phi` is `m^3/s`. |
| `A_qq(k)` | `m^3/s` | magnetic dynamic row |
| `B_qq(k)` | `m^3` | `lambda B_qq(k) q` is `m^3/s`. |
| `b_q` | `m^3/s` | projected physical magnetic drive |
| `b_phi` | `A m` | explicitly typed scalar RHS |
| `beta` | `1/m` | Robin surface term has scalar-block unit `m`. |

The solver may scale rows and unknowns using chapter 18's common block scaling,
but matrix/action parity and final residual certification are computed in the
original unscaled physical blocks.

## 5. Open-z outer boundary and K0 limit

### 5.1 Boundary ownership

The only open boundary facets in this contract are the top and bottom z faces,
denoted `Gamma_open_z`. Lateral x/y cuts are Floquet interfaces and receive no
Robin mass, Dirichlet elimination or isolated-airbox boundary treatment.

| `outer_boundary_kind` | Nonzero-k scalar contract |
|---|---|
| `poisson_robin` | finite `beta>0` in `1/m`; apply the Robin integral once on `Gamma_open_z` only; `gauge_policy=none` |
| `poisson_dirichlet` | `beta=0`; eliminate only reduced classes touching declared `Gamma_open_z`; `gauge_policy=none` |
| `pure_neumann` | `beta=0`; no open-z boundary term; for resolved nonzero lateral k, `gauge_policy=none` because `P(k)` is coercive |

Applying Robin to periodic cuts changes the physical problem and rejects the
operator. Applying a mean-zero projection to a coercive nonzero-k scalar block
also changes the operator and rejects it. A fully periodic 3D request is
outside this contract.

### 5.2 Exact and limiting K0 parity

The Bloch assembler must be callable by validation at exactly `k=(0,0,0)`.
For Robin and Dirichlet it must satisfy, under canonical ordering and scaling:

```text
A_qq(k=0)   = A_qq_K0
A_qphi(k=0) = A_qphi_K0
A_phiq(k=0) = A_phiq_K0
P(k=0)      = P_K0
B_qq(k=0)   = B_qq_K0
```

Equality means matrix parity for assembled fixtures and action parity for
matrix-free fixtures, including signs, eliminated DOFs, reconstructed fields
and original block residuals. Pure Neumann parity includes the explicit K0
nullspace transition: the nonzero-k block converges to the singular K0 block,
and the K0 solve is compared only after chapter 18's mean-zero augmentation is
applied.

Selected spectra and driven responses must converge to the qualified Task 6
K0 results as `norm(k)` approaches zero from accepted directions. A
discontinuous engine switch, K0 substitution at finite k or post-filtered
agreement does not satisfy this gate.

## 6. Independent matched-mesh constraint oracle

### 6.1 Oracle maps

The oracle is built independently from the complete equivalence classes on an
unreduced matched mesh. For each representative-to-member translation `R`:

```text
C_m(k): exp(-i*k dot R) plus tangent G_pair
C_phi(k): exp(-i*k dot R)

q_full = C_m(k) q_reduced
phi_full = C_phi(k) phi_reduced
C(k) = block_diag(C_m(k),C_phi(k))
```

Every magnetic and scalar entry uses the same wrapped `k dot R`, phase sign and
tolerance. `C_m(k)` additionally applies the certified `G_pair`; `C_phi(k)` is
phase-only. Real-split implementations use the exact 2x2 phase block and do
not discard the imaginary coupling.

The oracle reduces every block before solving:

```text
A_qq(k) = C_m(k)^H A_qq C_m(k)
A_qphi(k) = C_m(k)^H A_qphi C_phi(k)
A_phiq(k) = C_phi(k)^H A_phiq C_m(k)
P(k) = C_phi(k)^H P C_phi(k)
B_qq(k) = C_m(k)^H B_qq C_m(k)

b_q(k) = C_m(k)^H b_q
b_phi(k) = C_phi(k)^H b_phi

A_oracle(k) = C(k)^H A_full C(k)
B_oracle(k) = C(k)^H B_full C(k)
```

These names describe oracle-reduced blocks in this section. Production blocks
with the same mathematical names come from direct `grad_k`/`div_k` assembly.
Their construction paths, signatures and hashes remain separate so a shared
bug cannot pass as independent parity.

### 6.2 Pre-solve equivalence certificate

Before a production scope is promoted, the oracle and production assembler
must generate a `FloquetOperatorParityCertificate` keyed by:

```text
equilibrium, mesh, magnetic/scalar equivalence classes, material, physics,
outer boundary, FE order, quadrature, tangent frames, block ordering,
block scaling, precision, phase convention, phase tolerance,
accepted k domain, production assembler identity and oracle identity
```

The certificate contains, at each required k sample:

- block dimensions, sparsity signatures and matrix parity for bounded
  assembled fixtures;
- seeded basis/random-vector action parity for all five blocks and the full
  modal/driven action;
- magnetic source, scalar potential and recovered Cartesian demag-field parity;
- Robin/Dirichlet/pure-Neumann policy and K0-limit parity;
- original unscaled `eps_q`, `eps_phi` and `eps_full` parity; and
- independent negative controls for phase sign, coupling sign, missing
  `G_pair`, scalar phase omission and Robin-on-periodic-cut contamination.

The accepted k samples include exact K0, both signs of every qualified axial
and oblique direction, interior points, reciprocal-cell boundaries admitted
by policy and the DE/BV points used for physics qualification. Adaptive or
continuous-domain claims additionally require a declared interpolation/error
bound; finite sample success alone qualifies only the sampled set.

The production and constrained forms may be called equivalent only after this
matrix/action parity passes over the accepted k domain. The certificate may be
cached only under its exact key. A changed k domain, mesh, material, boundary,
phase policy, assembler or oracle invalidates it before the next solve.

### 6.3 Oracle boundary

The oracle is a bounded correctness reference. It may use explicit matrices
or a bounded direct solve, but it never becomes:

- the production `grad_k`/`div_k` operator;
- a replacement when production assembly is absent;
- a scalable CPU/GPU solver claim;
- a postsolve repair of a K0 result; or
- capability evidence outside its certified signature and k domain.

## 7. Residual, continuity and solver acceptance

For every modal candidate, reconstruct the original unscaled production state
and compute:

```text
r_q = A_qq(k) q + A_qphi(k) phi - lambda B_qq(k) q
r_phi = A_phiq(k) q + P(k) phi

eps_q = norm(r_q) /
  (norm(A_qq(k)q) + norm(A_qphi(k)phi)
   + abs(lambda) norm(B_qq(k)q) + eps)

eps_phi = norm(r_phi) /
  (norm(A_phiq(k)q) + norm(P(k)phi) + eps)

eps_full = max(eps_q,eps_phi)
```

For driven response, form the residual directly from
`(i omega B(k)-A(k))x-b` and include the applicable RHS norm in each block
denominator. Backend, transformed, preconditioned, Schur and tracked Krylov
residuals are diagnostics only and cannot cap or replace `eps_full`.

Accepted solutions also satisfy the physical seam checks reconstructed on the
matched mesh:

```text
max_pair norm(delta_m_dst - phase R_orient delta_m_src) <= eps_dm
max_pair norm(q_dst - phase G_pair q_src) <= eps_q_pair
max_pair abs(delta_phi_dst - phase delta_phi_src) <= eps_phi_pair
max_pair abs(partial_n(dst)delta_phi_dst
             + phase partial_n(src)delta_phi_src) <= eps_flux
```

Modal acceptance additionally uses chapter 18's finite-mode, branch, window,
normalization and completeness rules. Driven acceptance uses the same physical
field-to-tangent RHS conversion as K0 and certifies every accepted frequency
point. A solver convergence reason without original-operator and seam
certification is not acceptance.

## 8. No projection and no fallback policy

Applying phase to a solved K0 vector, scalar potential, viewport field, mode
profile or exported artifact is a postsolve phase projection. A postsolve phase
projection is not an operator and cannot satisfy exchange, DMI, scalar Poisson,
dynamic demag, modal or driven operator gates.

The following substitutions are forbidden for every accepted nonzero-k
dynamic-demag request:

- K0 periodic-airbox blocks or providers;
- finite isolated/open lateral boundaries;
- synthetic algebraic operators or labels without numeric block actions;
- magnetic-only phase handling without the scalar-potential phase;
- the matched-mesh oracle as the selected production operator; and
- CPU execution for a strict GPU request.

Strict CPU or GPU requests have no fallback. A non-strict auto request may
select another already legal engine only before execution, for the identical
nonzero-k physical operator and product, and must publish requested/resolved
engine plus `fallback_reason`. It may not change k, dynamic-demag intent,
boundary policy, product, precision or discretization. In particular, no
fallback to K0, open boundaries, synthetic operators or CPU for strict GPU is
legal.

## 9. Ordered CPU implementation stages

Stages are cumulative. A later implementation may exist behind a probe, but no
scope promotes until every predecessor gate for that scope passes.

### NK-P1: no-demag exchange/local phase parity

**Input:** accepted linearization, P1 magnetic mesh/classes, tangent frames,
canonical nonzero k and no dynamic demag.

**Implementation:** assemble production complex Bloch local, exchange and each
explicitly admitted nonreciprocal magnetic term in `A_qq(k)`, with matching
`B_qq(k)`. Build the independent `C_m(k)` oracle action from the same physical
problem but a separate assembly path.

**Gate:** matrix/action parity at K0, `+k`, `-k`, axial and oblique samples;
independent local SO(2) tangent-frame rotations preserve spectra and
reconstructed Cartesian fields. Without DMI, asymmetric interfaces or another
declared nonreciprocal term, selected frequencies and driven observables obey
`f(k)=f(-k)` and response reciprocity within tolerance. With a qualified
nonreciprocal term, the expected signed asymmetry is required and reciprocal
symmetry is not asserted.

### NK-P2: scalar Poisson manufactured Bloch solution

**Input:** accepted scalar equivalence classes on the full shared domain, each
open-z BC tuple and manufactured complex Bloch potential/source pairs.

**Implementation:** assemble `P(k)` and `C_phi_q(k)` using `grad_k`/`div_k`;
assemble an independent `C_phi(k)^H P C_phi(k)` oracle; recover
`-grad_k(phi)` and paired lateral flux.

**Gate:** P1 convergence order, field/source sign, complex phase continuity,
opposite-normal flux relation, open-z Robin placement, Dirichlet elimination,
nonzero-k pure-Neumann coercivity and exact K0 gauge transition all pass.
Phase-sign and Robin-on-periodic-cut negative controls fail.

### NK-P3: full dynamic demag-k assembly

**Input:** NK-P1/P2 outputs, `Ms`, static accepted equilibrium and common block
scaling.

**Implementation:** assemble numeric `A_qphi(k)`, `A_phiq(k)` and `P(k)` with
the production complex Bloch differential forms; combine them with
`A_qq(k)`/`B_qq(k)` into the full descriptor and driven operator. Build all
five oracle-reduced blocks independently.

**Gate:** complex adjoint-energy and demag sign checks pass; every block and
the full modal/driven action pass accepted-domain matrix/action parity;
reconstructed Cartesian `delta_H_demag` agrees; a sign-flip negative control
fails. A payload kind, diagnostics label or phase metadata without executable
numeric blocks fails with `missing_numeric_fem_demag_k`.

### NK-P4: CPU selected spectrum and driven response

**Input:** NK-P3 operator, user-requested frequency window/count or frequency
sweep and physical drive.

**Implementation:** use chapter 18's complex selected-spectrum and full or
certified-Schur CPU algorithms with k in the exact problem signature.
Frequency-independent Bloch assembly and Poisson setup may be reused only for
unchanged k; every changed k creates or selects the matching keyed operator and
preconditioner state.

**Gate:** finite selected modes, window completeness, modal reconstruction,
driven full residuals, modal/driven resonance cross-checks and full-versus-
certified-Schur samples pass. Oracle solves remain independent verifier inputs
and do not select modes, targets or solver success.

### NK-P5: DE/BV dispersion and K0 limit

**Input:** qualified Damon-Eshbach (DE) and backward-volume (BV) film fixtures,
multiple mesh levels, independent z-padding levels and a signed k path that
includes the K0 limit.

**Implementation:** produce modal dispersion and driven-response observables
from the NK-P4 production operator only. Analytical or semi-analytical DE/BV
references are postsolve verifier inputs.

**Gate:** mesh and airbox-padding convergence, demag field/energy sign,
selected modal/driven agreement, DE and BV branch behavior, exact `A(k=0)`
parity and the `k -> 0` spectrum/response limit pass. Require `f(k)=f(-k)` only
when all nonreciprocal terms and structural asymmetries are disabled; otherwise
validate the expected signed nonreciprocity rather than forcing symmetry.

CPU promotion is bounded to the products, k domain, materials, BCs and solver
engines evidenced by NK-P1 through NK-P5. Passing one product does not promote
the other.

## 10. Ordered GPU implementation stages

GPU stages consume the exact CPU-qualified blocks and signatures. GPU support
is a separate realization of the same physics contract; it does not redefine
signs, units, k, phase, BC, residual or validation semantics.

### NK-G1: complex constraint and production-operator apply parity

Create a persistent GPU operator context containing the production
`grad_k`/`div_k` actions, complex scalar representation, magnetic/scalar maps,
`G_pair`, materials, tangent frames, blocks/scaling and reusable work vectors.
Implement device `C_m(k)`, `C_m(k)^H`, `C_phi(k)` and `C_phi(k)^H` oracle probes
with the same phase as CPU.

The gate requires double-precision CPU/GPU parity for each production block,
the full modal/driven action, every complex constraint/adjoint action and
reconstructed Cartesian fields at the accepted k samples. Missing either
magnetic or scalar complex constraints rejects; one phase implementation may
not stand in for both maps without their independent dimensions and actions.

### NK-G2: device Poisson and shifted-solve parity

Create persistent PETSc/hypre/libCEED/CUDA scalar and shifted-solve state for
the exact problem/k signature. Repeated `P(k)` solves and modal/driven shifted
actions reuse allocations and preconditioner setup according to the declared
policy.

The gate requires CPU/GPU solution, contraction, original scalar residual,
open-z BC, recovered field and shifted-action parity. Setup H2D and final D2H
are counted; per-iteration matrix/vector migration, hidden host factorization
or host preconditioner state fail the device-solve claim.

### NK-G3: persistent modal and driven device Krylov

`gpu_modal_device_krylov` owns PETSc CUDA vectors, SLEPc Krylov-Schur/Arnoldi
state, device shifted solves, Ritz vectors, orthogonalization and restart state.
`gpu_device_krylov` owns PETSc KSP GMRES/FGMRES vectors, preconditioner,
restart and convergence state. Both consume the NK-G2 context and certify the
original full blocks before final export.

The gate requires correct stop reasons, restart behavior, finite-mode/window
completeness or driven convergence, original residuals and zero per-iteration
H2D/D2H transfer counts. A GPU operator callback driven by host Krylov remains
`gpu_operator_host_krylov` and cannot pass NK-G3.

### NK-G4: DE/BV CPU/GPU parity and transfer audit

Run the NK-P5 qualified DE/BV and K0-limit scopes with identical CPU/GPU
problem bundles. Compare frequency clusters, invariant subspaces for
degeneracies, driven complex observables, reconstructed fields, residuals,
iteration/contraction behavior and accepted/rejected outcomes.

The transfer audit records:

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

Any hidden CPU solve, host Krylov state, per-iteration migration, changed
physical signature or product-specific mismatch fails NK-G4. Modal and driven
GPU scopes promote independently.

## 11. Exact rejection reasons and precedence

The planner validates in the order below and emits one primary exact token.
Supporting diagnostics may list additional failures but may not replace the
primary reason.

| Order | Exact token | Trigger | Native status | Fallback |
|---|---|---|---|---|
| 1 | `missing_floquet_pair_equivalence_classes` | complete accepted magnetic or scalar representative classes, lateral airbox coverage or cycle certificate is absent | `validation_error` | none |
| 2 | `missing_floquet_magnetic_constraint_operator` | `C_m(k)` or its adjoint cannot be built with the required phase and `G_pair`, or dimensions/signature disagree | `unavailable` | none |
| 3 | `missing_floquet_scalar_constraint_operator` | `C_phi(k)` or its adjoint cannot be built over the full scalar airbox space with the same phase convention | `unavailable` | none |
| 4 | `missing_numeric_fem_demag_k` | a legal nonzero-k demag request lacks executable numeric production `grad_k`/`div_k` blocks/actions; labels, K0 providers and postsolve projection do not count | `unavailable` | none |
| 5a | `nonzero_k_gpu_modal_operator_unavailable` | strict GPU `modal_eigen` lacks any required device production block, scalar/shifted solve, persistent modal Krylov state or exact parity certificate | `unavailable` | none; never CPU |
| 5b | `nonzero_k_gpu_driven_operator_unavailable` | strict GPU `driven_response` lacks any required device production block, scalar/shifted solve, persistent driven Krylov state or exact parity certificate | `unavailable` | none; never CPU |

Malformed k units/components, invalid open-z BC, contradictory phase cycles or
signature mismatches are `validation_error` diagnostics under the first
applicable input/certificate failure and reject before operator selection.
Numeric assembly/action failures after a legal plan use `operator_error` with
`missing_numeric_fem_demag_k` as the primary capability token when no valid
numeric demag-k operator remains. Krylov convergence or original-residual
failure is `solve_error`; it is never converted into a capability fallback.

For strict GPU, the two product-specific GPU tokens take precedence only after
the shared topology, constraint-oracle and numeric production-demag-k
prerequisites exist. This prevents a GPU token from hiding a missing common
physics operator.

## 12. Required artifacts and provenance

Every attempt preserves available requested/resolved provenance and the exact
primary rejection token. A successful scope publishes at least:

| Area | Required fields or evidence |
|---|---|
| Intent | product, requested/resolved k in `rad/m`, requested/resolved device, precision, method and strictness |
| Phase | `exp(-i*k dot R)`, reciprocal-cell mapping, primitive/reciprocal basis, phase-wrap tolerance and accepted k domain |
| Inputs | equilibrium, mesh, material, physics, tangent-frame, magnetic-class and scalar-class hashes |
| Production assembly | `assembly_kind=mfem_complex_bloch_grad_div_shared_domain`, FE order, quadrature, canonical maps/orderings, all block/scaling hashes |
| Oracle | `C_m(k)`/`C_phi(k)` identities, independent oracle identity, parity-certificate key, sampled k set and matrix/action errors |
| BC | open direction, open-z facets, boundary kind, `beta` in `1/m`, gauge policy/reason and eliminated DOFs |
| Modal | pencil/scalar kind, target/window/count, transform, KSP/PC, finite/converged/rejected/accepted counts and completeness |
| Driven | physical drive and projected-RHS provenance, frequency, KSP/PC/restart and stop reason |
| Certification | `eps_q`, `eps_phi`, `eps_full`, seam/flux errors, K0 limit and DE/BV evidence; backend residuals remain separate |
| Residency | context identity, buffer locations, allocation bytes and setup/final/per-iteration transfer counts |
| Status | `implementation_state`, `validation_state`, bounded `validated_scope`, separate `product_status`, native status and `complete` |

Modal and driven artifacts remain separate even when they reuse one production
operator. CPU evidence cannot fill GPU residency fields. GPU driven evidence
cannot promote modal GPU. Analytical DE/BV values are independent verifier
inputs and never assembly, target-selection, preconditioner or solver-success
inputs.

## 13. Backend ownership

Backend-neutral phase, block-signature, parity-certificate and artifact
contracts live under `backends/fem/include/frequency_domain/` and
`backends/fem/src/frequency_domain/`.

Production CPU ownership is under:

```text
backends/fem/cpu/frequency_domain/
  operators/
  engines/
  preconditioners/
  modal/
  validation/
```

Production GPU ownership is under:

```text
backends/fem/gpu/cuda/frequency_domain/
  operators/
  engines/
  preconditioners/
  residency/
  modal/
  validation/
```

The CPU and GPU realizations share the backend-neutral physics contract but
own separate MFEM/PETSc/SLEPc/hypre/libCEED/CUDA implementations and evidence.
The runner owns orchestration, ABI transport, cancellation/progress, artifacts
and provenance only. Production assembly, Poisson numerics, preconditioners and
Krylov state do not move into the runner, `Context` or `mfem_bridge.cpp`.

## 14. Definition of done

An exact nonzero-k Floquet-airbox scope is complete only when all applicable
conditions hold:

1. The request has accepted complete magnetic and scalar equivalence classes,
   canonical k in `rad/m`, one phase convention and a valid open-z BC tuple.
2. Backend-owned production assembly emits numeric complex Bloch
   `grad_k`/`div_k` blocks with the signs, domains and SI units in Section 4.
3. The independent matched-mesh oracle builds both `C_m(k)` and `C_phi(k)` and
   passes matrix/action parity over the complete accepted k domain.
4. Robin is applied only on open-z faces, pure-Neumann nonzero-k coercivity and
   the K0 gauge transition are certified, and exact `A(k=0)` parity holds.
5. Every modal mode or driven point passes original unscaled block residuals,
   physical seam/flux checks and product-specific acceptance. A postsolve phase
   projection contributes no operator evidence.
6. NK-P1 through NK-P5 pass for each promoted CPU product, including DE/BV,
   K0-limit and correctly conditional `f(k)=f(-k)` validation.
7. NK-G1 through NK-G4 pass for each promoted GPU product, including persistent
   device Krylov and zero per-iteration transfers. Strict GPU never falls back
   to CPU.
8. Every rejection uses the exact precedence and token vocabulary in Section
   11 and preserves requested/resolved provenance and partial diagnostics.
9. Artifacts report the canonical implementation/validation/scope axes and do
   not conflate executable, physics-validated and production-qualified states.
10. Production qualification is bounded to the exact product, k domain, mesh,
    material, BC, precision, device and engine evidence; no neighboring scope
    is promoted by implication.

Until all applicable conditions pass, nonzero-k dynamic demag remains
`contract_only` or unavailable for the corresponding production scope. K0,
no-demag, phase-projection, synthetic-oracle and other-product evidence must
remain separately labelled.
