# FEM Poisson-Airbox Modal Eigenproblem

- Status: implementation contract
- Owners: Fullmag FEM frequency-domain backend
- Last updated: 2026-07-09
- Related physics notes:
  - `0700-frequency-domain-linearized-llg.md`
  - `0800-fem-static-pbc-demag.md`
  - `0828-fem-frequency-domain-floquet-demag.md`
  - `0831-fem-dynamic-pencil-modal-response-and-krylov.md`
  - `0520-fem-robin-airbox-demag-bootstrap-reference.md`
- Related implementation plan:
  - `docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md`

## 1. Problem statement

This note defines the first physically valid FEM modal eigensolve with dynamic
Poisson-airbox demagnetization. It is a `k=0`, alpha-zero, shared-domain
candidate around an accepted static equilibrium. The magnetic perturbation is
complex and tangent to the equilibrium; the scalar-potential perturbation lives
on the full magnetic-plus-airbox domain.

The topology-shaped PA-E1/PA-E4b payload is an algebraic test oracle only. It
is not a FEM Poisson-airbox model and must not be labeled production physics.

## 2. Physical model

### 2.1 Governing equations

Fullmag uses

```text
m(r,t) = m0(r) + Re[delta_m(r) exp(+i omega t)]
delta_m = Tq
m0 dot delta_m = 0
delta_H_demag = -grad(delta_phi).
```

With `delta_M=Ms delta_m` inside the magnetic region and zero elsewhere,

```text
div(grad(delta_phi)) = div(delta_M) in D,
D = Omega_m union Omega_air.
```

For a Robin approximation of the open exterior boundary `Gamma_open`, the
weak form is

```text
int_D grad(psi) dot grad(delta_phi) dV
+ beta int_Gamma_open psi delta_phi dS
= int_Omega_m Ms delta_m dot grad(psi) dV.
```

The Robin term is excluded from periodic cuts. Dirichlet eliminates the
corresponding potential DOFs. Pure Neumann has a constant nullspace and alone
uses a mean-zero gauge. Fully periodic three-dimensional k=0 demagnetization
is unsupported until a macroscopic-field convention is defined.

The modal magnetic system is represented by

```text
A_qq q + A_qphi phi = lambda B_qq q
A_phiq q + P phi = 0,
lambda = i omega.
```

For a pure-Neumann scalar block, the second row is augmented by `c eta` and
`cT phi=0`. Robin and Dirichlet have no `eta` row.

### 2.2 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `m0`, `delta_m` | normalized magnetization and perturbation | 1 |
| `Ms` | saturation magnetization | A/m |
| `h_eff0`, `delta_H_demag` | effective/demag fields | A/m |
| `delta_phi` | scalar magnetic potential | A |
| `gamma0` | `mu0 abs(gamma)` | rad s^-1 per (A/m) |
| `omega` | angular frequency | rad/s |
| `beta` | Robin coefficient | 1/m |

### 2.3 Assumptions and validity limits

- `m0` originates in an accepted equilibrium artifact with matching mesh,
  material, physics and boundary signatures.
- The initial real path supports P1 tetrahedral potential and tangent magnetic
  fields, alpha=0, k=0, uniform material within each supported region and
  x/y-periodic, open-z thin films.
- Nonzero-k dynamic demag requires complex Bloch `grad_k/div_k` assembly and is
  not approximated by the k=0 operator.

## 3. Numerical interpretation

### 3.1 FEM

`P`, source `C`, potential feedback and magnetic blocks are assembled from the
same shared mesh and quadrature. The production selected-spectrum solve is
Schur reduced, with the full descriptor reconstructed solely for certification.

Certification reports dimensionless blockwise backward errors:

```text
eps_q   = ||r_q|| / (||A_qq q|| + ||A_qphi phi|| + |lambda| ||B_qq q|| + eps)
eps_phi = ||r_phi|| / (||A_phiq q|| + ||P phi|| + ||c eta|| + eps)
eps_gauge = |cT phi| / (||c|| ||phi|| + eps).
```

The accepted full residual is `max(eps_q, eps_phi, eps_gauge)` and is not
replaced by a smaller backend-reported residual.

For a real PETSc build, a complex target `sigma=i omega_target` must be
represented by an explicit real-split transformed pencil. A real scalar target
`omega_target` on an imaginary-eigenvalue spectrum is invalid.

### 3.2 GPU

A GPU result is production-capable only when the assembled blocks, vectors,
Krylov basis and preconditioner remain resident on the device through the full
selected-spectrum iteration. One-shot `A*x` or dense inverse-iteration
contracts are not a device-resident modal solver.

### 3.3 FDM and hybrid

This note does not alter FDM demagnetization or introduce hybrid semantics.

## 4. API, IR, planner, and provenance impact

The public Python model remains physics-first. The internal modal payload adds
only backend-owned provenance:

```text
assembly_kind = mfem_weak_form_shared_domain | synthetic_algebraic_oracle
outer_boundary_kind = poisson_robin | poisson_dirichlet | pure_neumann
gauge_policy = none | mean_zero_augmented
gauge_reason = coercive_outer_boundary | pure_neumann_nullspace
spectral_scalar_mode = complex | real_split
sigma_real, sigma_imag_rad_per_s
```

The boundary, gauge, and reason form one validated tuple. `poisson_robin` and
`poisson_dirichlet` require `gauge_policy=none` and
`gauge_reason=coercive_outer_boundary`; `pure_neumann` requires
`gauge_policy=mean_zero_augmented`, normalized quadrature-assembled mean
weights, and `gauge_reason=pure_neumann_nullspace`. Those weights need not be
strictly positive at eliminated or inactive scalar DOFs. The current PA-E2
executable accepts only `assembly_kind=synthetic_algebraic_oracle`; the real
shared-domain token must remain unavailable until its MFEM weak-form assembly
exists. The native SLEPc adapter exists, but it does not turn a synthetic
payload into real assembly and its real-axis spectral targeting remains open.

Any artifact with `assembly_kind=synthetic_algebraic_oracle` must carry
`production_periodic_airbox_claim=false`. Production-labelled periodic-airbox
verification requires `assembly_kind=mfem_weak_form_shared_domain` and the
matching managed assembly and physics evidence.

The planner rejects a modal periodic-airbox request if required accepted
equilibrium fields, shared-airbox periodic certificate or supported BC policy
are absent. The capability matrix cannot label the path production until the
real assembly and validation matrix pass.

## 5. Validation strategy

1. Manufactured Robin and Dirichlet potential tests establish weak-form signs
   and gauge policy.
2. Sphere/ellipsoid tests establish demag field sign and energy positivity.
3. Primitive/supercell x/y PBC tests establish airbox periodic reduction.
4. K0-1, K0-2 and K0-3 field sweeps establish Larmor, local stiffness and
   thin-film Kittel behavior respectively.
5. Multi-mode selected-spectrum tests establish the target transformation.
6. CPU/GPU parity applies only after both operate on the same real assembled
   blocks.

## 6. Completeness checklist

- [ ] Real shared-domain FEM modal block assembly
- [ ] BC-dependent gauge policy
- [ ] Real-split selected-spectrum transform for real PETSc
- [ ] Full residual block certification
- [ ] K0-3 real assembly fixture and convergence suite
- [ ] Persistent GPU modal solver
- [ ] Nonzero-k Floquet dynamic demag

## 7. Known limits and deferred work

Nonzero-k dynamic demag, device-resident modal Krylov, damping qualification,
nonuniform-texture qualification and broad periodic-airbox production coverage
are deferred. They must fail explicitly rather than reuse this k=0 path.

## 8. References

- COMSOL Micromagnetics Module User's Guide V2.13, frequency-domain chapter.
- `docs/physics/0700-frequency-domain-linearized-llg.md`.
- `docs/plans/active/fd_sovler_masterplan/19_eigensolve_frequency_driven_physics_numerics_audit.md`.
