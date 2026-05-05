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
A q = i omega B q
```

where `q` contains the two tangent components of `delta_m` at each magnetic
node or cell. The artifact contract stores both:

```text
omega_rad_s
frequency_hz = Re(omega) / (2 pi)
```

`line_width_hz` is meaningful only when the damping policy includes damping.

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

## Demagnetization policy

Static demagnetization at `k = 0` can be included by the current FEM reference
operator. Nonzero-k dynamic demagnetization for Floquet FEM is not implemented.
Requests with nonzero-k Floquet and demag enabled must fail with a capability
error until a mathematically valid dynamic demag-k operator exists.

FDM time-domain periodicity is axis-wise. CPU reference and CUDA FDM support
periodic exchange wrapping, and truncated-image periodic demagnetization where
the plan supplies periodic axes and image counts.

## Validation

The minimal validation set for this contract is:

- phase convention roundtrip in IR,
- periodic pair validation and duplicate-node rejection,
- periodic/Floquet rejection when pair constraints are not enforced,
- `Floquet(k=0) == Periodic`,
- exchange-only reciprocal dispersion `f(k) = f(-k)` when DMI and other
  nonreciprocal terms are disabled,
- explicit capability error for nonzero-k Floquet demag,
- V2 artifacts containing `path_s`, `k`, `branch_id`, and residual diagnostics.
