# Frequency-Domain Solver Physics

Status: physics contract for magnetic and magnetoelastic frequency-domain studies
Last updated: 2026-07-05
Related docs:
- `docs/physics/0700-frequency-domain-linearized-llg.md`
- `docs/physics/0700-shared-magnetoelastic-semantics.md`
- `docs/specs/frequency-domain-artifacts-v2.md`
- `docs/specs/fullmag_magnetoelastic_frequency_patch_specs.md`

## Physical Goal

Frequency-domain studies describe small perturbations around a static magnetic
or coupled magnetoelastic equilibrium. They are not time integrators. The output
is a complex response, mode shape, phase, absorption, or branch diagnostic for a
chosen angular frequency or eigenfrequency.

Base magnetic convention:

```text
m(r,t) = m0(r) + Re[delta_m(r) exp(i omega t)]
|m0| = 1
m0 dot delta_m = 0
```

`m0` is the equilibrium magnetization and `delta_m` is a tangent-plane complex
perturbation.

## Product Split

The magnetic frequency-domain family has two separate public study products:

- `modal_eigen` / `Eigenmodes`,
- `driven_response` / `Frequency Response`.

They share the same linearized tangent-space operator semantics and the same
SI precession coefficient `gamma0 = mu0 * |gamma|`, but they answer different
physical questions and must stay distinct in capabilities, manifests, UI
labels, and provenance.

Modal eigen analysis solves

```text
A q = lambda B q
```

for tangent variables `q`.

Driven response solves

```text
(i omega B - A) q = b
```

for the harmonic response at requested frequencies.

`Eigenmodes` must not be described as the frequency-domain solver without the
word `modal`, and `Frequency Response` must not be described as inheriting the
modal eigensolver production status.

## Solver Tree Contract

Frequency-domain execution is a solver-planning problem, not one hard-coded
GMRES path. The physics layer defines the algebraic problem; a separate planner
selects an operator representation, linear solver family, preconditioner, and
runtime residency model.

The backend-neutral contract is:

```text
LinearizedFrequencyProblem
  -> FrequencySolvePlanner
  -> FrequencySolvePlan
  -> one selected solver engine
```

`FrequencySolvePlan` must preserve, at minimum:

- the public product: `modal_eigen` or `driven_response`,
- the algebraic form: modal pencil, driven full coupled system, or driven
  Schur-reduced system,
- the operator representation: dense, sparse, matrix-free, coupled block, or
  modal-reduced,
- the selected engine,
- the requested and resolved device,
- vector residency for Krylov state,
- operator backend,
- preconditioner backend,
- validation and fallback policy.

The driven-response solver tree is:

| Engine | Role |
|---|---|
| `dense_reference` | Tiny oracle for signs, scaling, residuals, Schur equivalence, and CI fixtures. It is not production execution. |
| `cpu_sparse_direct` | CPU assembled sparse real-split or complex direct solve per frequency. This is the first missing production fallback and diagnostic baseline after the layout split. |
| `full_coupled_field_split` | Full block solve for coupled `delta_m` and auxiliary fields such as `delta_phi`; preferred core path for robust periodic-airbox demag. |
| `schur_reduced` | Matrix-free reduced system used only after full-vs-Schur certification passes. It is a fast path, not the single source of truth. |
| `modal_reduced` | Reduced-basis or rational/modal sweep path for many-frequency response after modal validation. |
| `gpu_operator_host_krylov` | Transitional path where Krylov vectors, Arnoldi/orthogonalization, residuals, and restart state live on the host while some operator or preconditioner applications use GPU backends. This must not be described as a device-resident GPU solver. |
| `gpu_device_krylov` | Future path where Krylov vectors, operator inputs/outputs, preconditioner state, dot/norm/axpy/restart state, and residual estimates are device-resident. |

For magnetic plus magnetostatic periodic-airbox driven response, both block
forms are part of the physical contract:

```text
[ A_mm(omega)  A_mphi ] [ delta_m   ] = [ b_m   ]
[ A_phim       A_phiphi ] [ delta_phi ]   [ b_phi ]
```

and, when certified,

```text
S(omega) delta_m = b_m - A_mphi A_phiphi^{-1} b_phi
S = A_mm - A_mphi A_phiphi^{-1} A_phim
```

The full coupled residual is the reference residual for the reduced path.
Schur-reduced execution is eligible only when tiny dense explicit Schur,
matrix-free Schur action, reconstructed full residual, gauge/nullspace handling,
and preconditioner-quality diagnostics agree within documented tolerances.

The name `production_gpu` is not precise enough for solver architecture. Runtime
and artifacts must distinguish `gpu_operator_host_krylov` from
`gpu_device_krylov`. A run that uses device hypre or a CUDA tangent operator but
stores Arnoldi bases, Hessenberg matrices, residual vectors, and dot/norm/axpy
work on the host is `gpu_operator_host_krylov`.

## Equilibrium Linearization

A frequency-domain solve is meaningful only when the equilibrium is sufficiently
stationary:

```text
m0 x H0 ~= 0
```

Backends must report or check maximum `|m0 x H0|`, maximum `||m0| - 1|`, and
residual norms. Invalid equilibrium should reject the study rather than export a
misleading spectrum or response curve.

## Magnetic-Only Frequency Response

Magnetic-only driven response solves a linearized LLG equation with harmonic
forcing:

```text
i omega delta_m =
  -gamma0 * (m0 x delta_H[delta_m] + delta_m x H0)
  + i omega alpha * (m0 x delta_m)
  + delta_tau_drive
```

After projection to a local tangent basis, the unknown has two components per
magnetic degree of freedom. A backend may materialize three-component vectors
for output, but the physical operator should be formulated on tangent variables.
Gilbert damping may be uniform or nodal (`alpha(x)`). In both cases it enters
the harmonic tangent-space mass operator as the local `i omega alpha *
(m0 x delta_m)` term; it is not a time-integration parameter.

Use magnetic-only response for magnetic susceptibility, mode maps, phase, or
absorbed magnetic power under a harmonic magnetic or current-derived excitation
when elastic feedback is negligible or intentionally absent.

The harmonic drive is a complex phasor. A real field vector `h_drive` with
phase `phi` enters the tangent-space right-hand side as
`h_drive * exp(i phi)`. `phi = 0` is the legacy in-phase drive. Backends that
materialize real block systems must preserve both real and imaginary right-hand
side components rather than dropping the drive phase.

The native FEM production GPU driven-response lane is a limited magnetic-only
realization of this contract. It may execute the gamma-point, free-boundary,
no-demag slice with exchange, Zeeman, uniform uniaxial anisotropy, uniform or
nodal Gilbert damping, and matrix-free GMRES through a CUDA tangent operator.
It must report requested and resolved GPU lane provenance and
`validation_fallback_used=false`. DMI, dynamic demag, static-periodic
projection, nonzero-k Floquet/Bloch response, and magnetoelastic response must
reject explicitly instead of falling back to dense validation or CPU response.

## Quasistatic Bidirectional Magnetoelasticity

Quasistatic bidirectional magnetoelasticity solves mechanical equilibrium and
feeds the resulting strain back into the magnetic effective field:

```text
div sigma + f = 0
sigma = C : (eps(u) - eps_mag(m))
H_mel = -1 / (mu0 Ms) * delta E_mel / delta m
```

This is not prescribed strain. Prescribed strain supplies strain as input.
Bidirectional quasistatic mechanics solves for displacement `u`, recovers
`eps` and `sigma`, and uses the same energy contract to compute `H_mel` and
`E_mel`.

Use quasistatic coupling when mechanical waves are not part of the physics and
mechanical inertia can be neglected.

## Elastodynamic Frequency Response

Elastodynamic frequency response includes inertia and harmonic mechanical
motion:

```text
(K_u - omega^2 M_u + i omega C_u) u_hat = f_hat
```

Use elastodynamics when phonon resonances, acoustic standing waves, or
magnon-phonon resonance conditions are part of the intended physics. A
quasistatic solver must not claim elastodynamic response.

## Coupled Magnetoelastic Harmonic Response

A coupled frequency-domain solve joins tangent magnetic variables and complex
mechanical displacement variables in one block system:

```text
[A_mm(omega)  A_mu(omega)] [delta_m] = [b_m]
[A_um(omega)  A_uu(omega)] [u_hat ]   [b_u]
```

The off-diagonal blocks represent magnetoelastic coupling. This formulation is
needed when magnetic and elastic resonances interact strongly or when measured
response depends on energy transfer between the subsystems.

## Coupled Eigenmodes

Coupled magnon-phonon eigenmodes are eigenvectors of the coupled block operator,
not a post-processing merge of separately computed magnetic and elastic modes.
Branch tracking must use modal overlap or a stronger coupled metric, and
hybridization diagnostics must report magnetic versus elastic participation.

## Domains

- `Omega_m`: magnetic domain where `m`, `H_eff`, and magnetic perturbations live.
- `Omega_s`: elastic domain where `u`, `eps`, and `sigma` live.
- `D`: computational domain, including airbox or auxiliary regions when needed.

The first executable quasistatic slice may require `Omega_m == Omega_s`. When
`Omega_m != Omega_s`, transfer operators must be explicit, tested, and recorded
in provenance.

## Boundary And Interface Conditions

Magnetic boundary conditions follow the selected exchange, DMI, demag,
periodic, or Floquet policy. Mechanical boundary conditions must separately
state displacement constraints, traction loads, periodic mechanics if present,
and rigid-body nullspace handling.

At material interfaces, displacement compatibility and traction balance are the
mechanical defaults unless an explicit interface law says otherwise. Magnetic
interfaces may also carry exchange, DMI, or magnetoelastic discontinuities.

## Observables

Magnetic-only response observables:

- `m_complex`
- `response_amplitude`
- `response_phase`
- `susceptibility_tensor`
- `absorbed_power_density`

Magnetoelastic response observables:

- `u_complex`
- `strain_complex`
- `stress_complex`
- `E_el`
- `E_mel`
- `mode_hybridization_index`

All outputs use SI units and must include enough provenance to identify backend,
solver model, damping policy, and normalization.

## Model Limits

This contract assumes small perturbations around equilibrium and small-strain
mechanics. It does not cover large deformation elasticity, nonlinear acoustic
propagation, thermal noise spectra, or nonlinear driven steady-state dynamics.
Those require separate physics contracts and capability flags.
