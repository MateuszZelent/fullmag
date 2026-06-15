# Frequency-Domain Solver Physics

Status: physics contract for magnetic and magnetoelastic frequency-domain studies
Last updated: 2026-06-12
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
