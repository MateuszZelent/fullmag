# Frequency-domain linearized LLG

Status: reference contract
Applies to: FEM eigen, dispersion, periodic and Floquet studies

## Convention

Fullmag uses SI units. Effective fields are stored in `A/m`. The LLG
precession coefficient used in frequency-domain operators is:

```text
gamma0 = mu0 * |gamma|
```

when `gamma` is stored in `rad/(s T)`.

The phasor convention is:

```text
m(r,t) = m0(r) + Re[delta_m(r) exp(i omega t)]
H_eff[m] = H0 + Re[delta_H[delta_m] exp(i omega t)]
```

with:

```text
|m0| = 1
m0 dot delta_m = 0
```

## Product Split

Frequency-domain authoring uses one linearized tangent-operator contract, but
it produces two separate study products:

- `modal_eigen` with UI label `Eigenmodes`,
- `driven_response` with UI label `Frequency Response`.

They are not interchangeable and neither product inherits execution status from
the other.

The modal product solves the generalized eigenproblem

```text
A q = lambda B q
```

with `lambda = i omega`.

The driven product solves the forced harmonic system

```text
(i omega B - A) q = b
```

at user-requested frequencies.

Both products use:

- `gamma0 = mu0 * |gamma|`,
- tangent variables `q`, not unconstrained three-component unknowns,
- manifest `analysis_family = "magnetic_frequency_domain"`,
- explicit `study_product = "modal_eigen"` or `study_product = "driven_response"`.

## COMSOL parity requirements

`docs/comsol/Manual_for_Micromagnetics_Module.pdf` is not a Fullmag semantic
source, but it is a useful parity reference for user-facing frequency-domain
behavior. Fullmag must preserve the following product-level distinctions:

- Time-domain dynamics and frequency-domain dynamics are separate study
  surfaces.
- Frequency-domain dynamics means linearized LLG around a static equilibrium
  `m0`.
- Modal `eigenmodes` and driven `frequency_response` are separate solvers.
  The modal path solves the eigensystem; the driven path solves a forced
  harmonic linear system at requested frequencies.
- The dynamic magnetization perturbation `delta_m` is a complex phasor. Field
  resources and inspectors must expose `real`, `imag`, `abs`, and `phase`
  views.
- Mode animation is phasor reconstruction, not time integration:

```text
m_anim(r,t) = m0(r) + scale * Re[delta_m(r) exp(i (omega t + phi0))]
```

- A dynamic drive `delta_h` is a phasor. Public UI/API surfaces must not require
  users to encode the sinusoidal `sin(omega t)` or `cos(omega t)` factor by
  hand.
- For textured states, the equilibrium used by the frequency-domain study must
  come from an explicit static or relaxation stage, and artifacts must preserve
  the equilibrium provenance and residual diagnostics.
- Floquet/Bloch periodic studies use the phase convention owned by
  `docs/physics/0710-periodic-and-floquet-boundary-conditions.md`, including
  the `exp_minus_i_k_dot_delta_r` sign convention.
- Nonzero-k Floquet dynamic demagnetization remains unsupported until Fullmag
  implements and validates a mathematically consistent dynamic demag-k
  operator.

## Linearized equation

The frequency-domain perturbation satisfies:

```text
i omega delta_m =
-gamma0 * (m0 x delta_H[delta_m] + delta_m x H0)
  + i omega alpha * (m0 x delta_m)
  + tau_lin[delta_m]
```

Equivalently, after projection to the local tangent basis:

```text
L q = i omega B_alpha q
```

where `q` contains the two tangent components of `delta_m` at each magnetic
node or cell, `L` is the projected linearized effective-field/torque operator,
and `B_alpha` is the mass/gyrotropic operator including the chosen damping
convention. Older notes may use `A` or `M` for the same roles; new production
contracts must spell out the operator definitions before mapping eigenvalues
to frequency.

For the modal product, Fullmag's canonical production convention is:

```text
lambda q = B_alpha^{-1} L q
lambda = i omega
```

or the algebraically equivalent generalized pencil:

```text
L q = lambda B_alpha q
lambda = i omega
```

If a gyrotropic energy Hessian form is used instead, it must include the
phasor factor explicitly. With the `exp(i omega t)` convention and a real
skew-symmetric gyrotropic form `G`, the pencil is:

```text
K phi = -i omega G phi
```

not `K phi = omega G phi`, unless `G` has already been transformed into a
complex or Hamiltonian operator that contains the factor `i`. Documentation and
artifacts for such a transformed operator must name the transform and the
eigenvalue-to-`omega_rad_s` mapping.

If `K` is the second variation of physical magnetic energy in joules and
`gamma0 = mu0 * |gamma|`, the gyrotropic bilinear form uses:

```text
G_t(p, q) = integral (mu0 * Ms / gamma0) * eta dot (m0 x xi) dV
```

where `xi = T p` and `eta = T q`. A form using `Ms / gamma0` is valid only if
`K` has been defined as an effective-field form rather than an energy Hessian
in joules.

The artifact contract stores:

```text
omega_rad_s
frequency_hz = Re(omega) / (2 pi)
```

`line_width_hz` is meaningful only when the damping policy includes damping.
With the canonical `exp(i omega t)` convention, a decaying damped mode has:

```text
omega_complex = omega_r + i Gamma
exp(i omega_complex t) = exp(i omega_r t - Gamma t)
Gamma > 0
damping_rate_hz = Gamma / (2 pi)
linewidth_fwhm_hz = Gamma / pi
```

Any path using `exp(-i omega t)` must state that convention in the manifest and
must invert the corresponding signs consistently for LLG, absorption, Floquet
metadata, and linewidth.

## Tangent basis

For every magnetic degree of freedom `i`, choose an orthonormal local frame:

```text
(u_i, v_i, m0_i)
```

and represent perturbations as:

```text
delta_m_i = q_{2i} * u_i + q_{2i+1} * v_i
```

Production frequency-domain paths must not solve unconstrained three-component
eigenvectors as the final physical operator. A full three-component
representation is allowed only for debug export, temporary materialization, or
visual reconstruction from the tangent solution.

For non-uniform equilibria, tangent-frame variation is part of the operator
contract. A production FEM operator may interpolate reconstructed vector
fields `delta_m = T q`, or it may assemble directly in tangent coordinates, but
the chosen implementation must match the full-vector weak form. Promotion
requires a derivative/projection test on a non-uniform `m0` texture such as a
domain wall, vortex, or skyrmion.

The Zeeman energy Hessian for a fixed external field is zero, but the
linearized dynamics still contains the restoring/precessional term from the
static effective field:

```text
-gamma0 * P_T(delta_m x H0)
```

or its equivalent in the selected `L`/`K` formulation. A frequency-domain
operator that includes only second energy derivatives and omits this term is
not a valid FMR operator.

## Static equilibrium requirement

The input equilibrium should satisfy:

```text
m0 x H0 ~= 0
```

The diagnostics artifact must expose at least:

- maximum `|m0 x H0|`,
- maximum `||m0| - 1|`,
- residual norms for exported modes when available.

If the equilibrium is not sufficiently static for the selected study, the
planner or runner should emit a capability diagnostic or reject the study
instead of silently exporting misleading eigenfrequencies.

## Boundary conditions

Periodic and Floquet studies use the convention in
`docs/physics/0710-periodic-and-floquet-boundary-conditions.md`.

For a nonzero-k Floquet FEM study, every selected periodic pair must be enforced
inside the active operator. Backends that do not enforce the selected pair set
must reject the study.
If explicit Floquet pair metadata contains both translation and phase, the
runtime validates `phase_rad = -k dot translation (mod 2*pi)` before the current
unsupported solve path. A mismatch is a metadata validation error.

The native FEM production GPU driven-response lane currently enforces the
gamma-point, free-boundary, no-demag magnetic slice and the k=0
static-periodic, no-demag magnetic slice. It supports exchange, Zeeman, uniform
uniaxial anisotropy, and uniform or nodal Gilbert damping through a CUDA
tangent operator. Static-periodic response requires complete
`mesh.periodic_node_pairs` and boundary-pair translation/tolerance metadata and
publishes static-periodic diagnostics. A development GPU slice also accepts
nonzero-k Floquet metadata only for a no-demag projected response with local
terms and a supplied exchange-edge tangent operator; DMI, dynamic demag,
magnetostatic periodic constraints, and full periodic exchange-graph assembly
remain outside this slice. The high-level planner may reach this slice only for
explicit GPU, magnetic-body, no-demag/no-DMI requests with complete periodic
pair metadata. The runner treats `FrequencyExcitationIR.field_au_per_m` as the
reference-cell drive amplitude and applies `phase_rad=-k dot translation` to
paired tangent-drive DOFs before the native solve. The implementation projects
the complex real/imaginary response block onto the supplied Floquet pair phase
relations and reports `floquet_phase_projection=true`. This is not a full
Bloch-reduced production operator. Nonzero-k Floquet/Bloch response with
dynamic demag, DMI, periodic Poisson, full mesh-periodic exchange reduction, or
magnetoelastic
coupling must fail with explicit capability diagnostics on the GPU lane; it
must not be rerouted through dense validation or CPU response.

## Demagnetization policy

Static demagnetization at `k = 0` can be included by the current FEM reference
operator. Nonzero-k dynamic demagnetization for Floquet FEM is not implemented.
Requests with nonzero-k Floquet and demag enabled must fail with a capability
error until a mathematically valid dynamic demag-k operator exists.

The public `magnetostatic_bc` value for the future nonzero-k FEM path is
`floquet_airbox`. It is distinct from `periodic_airbox_k0`:

- `periodic_airbox_k0` means zero-phase periodic magnetization and zero-phase
  scalar-potential constraints for the shared-domain airbox;
- `floquet_airbox` means Bloch/Floquet phase constraints for the dynamic
  magnetic perturbation `delta_m` and the dynamic magnetostatic scalar
  potential `delta_phi` on the selected in-plane periodic cuts.

`floquet_airbox` is therefore a physics model request, not a backend hint. Until
the coupled demag-k operator is implemented and validated, a request with
`magnetostatic_bc="floquet_airbox"` must preserve the requested intent in IR and
provenance, then fail explicitly with a capability error. It must not be
rewritten to `periodic_airbox_k0`, `open`, dense validation fallback, or a CPU
Poisson solve.

The dynamic scalar potential sign convention is:

```text
delta_H_demag = -grad(delta_phi)
div(grad(delta_phi)) = div(Ms * delta_m)
div(-grad(delta_phi)) = -div(Ms * delta_m)
```

Any weak form may multiply both sides by `-1`, but artifacts and tests must
preserve the physical relation `delta_H_demag = -grad(delta_phi)`. Required
validation includes a demag energy sign check, an ellipsoid or equivalent
field-sign oracle, and symmetry of the k=0 demag Hessian.

If the response unknown is dimensionless `delta_m`, response observables must
include `Ms` where required by SI units:

```text
delta_M = Ms * delta_m
chi = delta_M / h_drive
p_abs = sgn * 0.5 * mu0 * Ms * omega * Im(conj(h_drive) dot delta_m)
P_abs = integral p_abs dV
```

The sign `sgn` is fixed by the phasor convention and the definition of
absorbed power. The production convention must pass the gate that positive
Gilbert damping gives positive absorbed power near resonance. A value
`delta_m / h_drive` is not dimensionless susceptibility; it has units `m/A`
and must be labeled as such if exported.

FDM time-domain periodicity is axis-wise. CPU reference and CUDA FDM support
periodic exchange wrapping, and truncated-image periodic demagnetization where
the plan supplies periodic axes and image counts.

## Validation

The minimal validation set for this contract is:

- phase convention roundtrip in IR,
- macrospin undamped check `omega = gamma0 * H0`,
- macrospin damping sign and linewidth mapping for `exp(i omega t)`,
- absorbed power positive near resonance for positive Gilbert damping,
- susceptibility scaling and units with `Ms`,
- dynamic Poisson sign check through `H = -grad(phi)`,
- periodic pair validation and duplicate-node rejection,
- explicit Floquet phase consistency validation against `-k dot translation`,
- periodic/Floquet rejection when pair constraints are not enforced,
- `Floquet(k=0) == Periodic`,
- exchange-only reciprocal dispersion `f(k) = f(-k)` when DMI and other
  nonreciprocal terms are disabled,
- explicit capability error for nonzero-k Floquet demag that distinguishes
  "missing `magnetostatic_bc=floquet_airbox`" from "`floquet_airbox` requested
  but demag-k operator not implemented",
- V2 artifacts containing `path_s`, `k`, `branch_id`, and residual diagnostics.
