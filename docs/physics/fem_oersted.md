# FEM Oersted Field

- Status: native FEM CPU/GPU observable contract
- Last updated: 2026-07-12
- Implementation: `backends/fem/cpu/mfem/interactions/oersted.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/oersted_cylinder.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/oersted_explicit.hpp/.cpp`, and the
  corresponding `backends/fem/gpu/cuda/interactions/oersted/` realization
- Test: `backends/fem/tests/oersted_contract.cpp`

## Pole

The current native FEM CPU implementation supports two Oersted realizations:

- an analytical infinite-cylinder conductor;
- an explicit nodal `oersted_field_xyz` buffer supplied by the plan.

For the analytical cylinder, the module precomputes the static nodal field for
unit current, `I = 1 A`, and stores it privately as
`H_basis_per_ampere`.  This is not a public observable.  The public
`H_oe(t) = I(t) H_basis_per_ampere` is materialized in `A/m` at the explicit
RHS evaluation time before it is added to `H_eff` or copied/snapshotted.
Explicit nodal `oersted_field_xyz` is already final `H_oe` in `A/m` and is
never current- or envelope-scaled.

Source ownership: analytical-cylinder axis normalization, unit-current field
sampling, current-envelope scaling, and scaled addition live in
`oersted_cylinder.hpp/.cpp`. Explicit nodal buffer addition lives in
`oersted_explicit.hpp/.cpp`. The public `oersted.hpp/.cpp` surface is only the
aggregate dispatcher.

For a cylinder of radius `R`, normalized current axis `a`, and perpendicular
distance `r` from the axis:

```text
inside:  |H_oe| = r / (2 pi R^2)
outside: |H_oe| = 1 / (2 pi r)
direction: H_oe parallel to a x r_hat
```

The axis node uses zero field.

## Envelope czasu

The analytical-cylinder runtime scale is:

```text
kind 0: I(t) = I0
kind 1: I(t) = I0 * [sin(2 pi f t + phase) + offset]
kind 2: I(t) = I0 for t_on <= t < t_off, otherwise 0
```

The pulse uses the frozen half-open interval `[t_on, t_off)`: the source is
on exactly at `t_on` and off exactly at `t_off`.  Every RK stage evaluates
this convention at `t_n + c_j dt`; the accepted final refresh evaluates it at
`t_n + dt`, before the accepted-time commit.

Explicit `oersted_field_xyz` buffers are already final H values in `A/m` and
are added without current scaling. Native FEM plan validation keeps the
analytical cylinder and explicit buffer mutually exclusive.

## Public observable and accepted-time snapshots

`H_oe` is a public field ID with units `A/m`; it never exposes the analytical
unit-current basis.  CPU field copies materialize it at the accepted
`ctx.state.current_time`.  CPU snapshots recompute the accepted `H_eff` and
refresh the same accepted-time `H_oe`.  The GPU keeps a device basis separate
from device `H_oe`, materializes device `H_oe(t)` before unscaled accumulation
into device `H_eff`, and uses that same realized buffer for synchronous copies
and asynchronous snapshot source selection. The latter is covered by a native
source contract; managed artifacts validate final public fields rather than an
independent async-staging probe. Thus every public snapshot corresponds to the
accepted final RHS time, rather than a previous current-time or RK-stage value.

Requested and resolved CPU/GPU lanes retain the existing FEM provenance; the
observable does not introduce a new DSL, ProblemIR, planner, OpenAPI, or UI
semantic.  CPU decomposition checks use `rtol <= 1e-12`; GPU checks use
`rtol <= 1e-10`.

## Energia

The executable Oersted module currently contributes only to `H_eff`. It does
not report a separate energy accumulator. If a future solver path requires
energy accounting for prescribed Oersted fields, it should use the same work
term convention as a prescribed Zeeman-like H field:

```text
E_oe = -mu0 integral_Omega Ms m . H_oe dV
```

That is not a current production contract.

## Jednostki

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| reduced magnetization | `m` | `1` |
| cylinder current | `I` | `A` |
| cylinder radius | `R` | `m` |
| cylinder center | `c` | `m` |
| cylinder axis | `a` | unit vector |
| Oersted field | `H_oe` | `A/m` |

## Warunki brzegowe

Oersted is a local additive effective-field term after precomputation. The
analytical cylinder has no FEM weak form, matrix assembly, solver, or boundary
condition in the current native CPU path.

## Dyskretyzacja FEM

`initialize_oersted_cylinder_field(...)` samples the analytical field at FEM
node coordinates and writes the private `H_basis_per_ampere`. During RHS
assembly, the Oersted interaction materializes public `H_oe(t)` and adds that
realized field to `H_eff` exactly once.

No gamma, damping, `mu0`, or direct torque factor is applied in this module; the
LLG RHS converts the final effective field to `dm/dt`.

## Ograniczenia capability

- The analytical cylinder is an infinite straight-conductor approximation.
- Arbitrary 3D cylinder axes are supported after finite non-zero normalization.
- Explicit generalized current-solution Oersted fields are supported only as a
  precomputed nodal field buffer.
- Full generalized Biot-Savart/current-transport solving remains outside this
  module.
- Strict native CPU/GPU parity is claimed only for the accepted-time public
  `H_oe` observable: managed artifacts prove the `H_oe = H_eff(driven) -
  H_eff(zero)` identity at `1e-12` (CPU) and `1e-10` (GPU). It is not a claim
  of generalized current-transport or Oersted-energy/minimizer parity.

## Validation and deferred work

The regression contract samples inside/outside Ampere-law amplitudes, sign
changes with current, a non-unit sinusoidal envelope at two times, explicit
nodal no-scaling, and `H_oe = H_eff(with Oersted)-H_eff(without Oersted)` on
both requested lanes. Sync copy and asynchronous GPU snapshot source selection
must expose the same accepted-time materialization; a standalone async-staging
behavioral probe remains out of this record. Managed CPU/GPU runtime artifacts
record the requested and resolved lanes and final public fields.

Oersted energy/minimizer legality is deliberately deferred.  This note only
defines a prescribed effective-field observable and must not be read as an
energy qualification.

## Testy

Current gate:

- `fem_oersted_contract` checks unit-current Ampere-law samples inside,
  outside, and on the axis; zero-axis rejection; sinusoidal and pulse current
  scaling; analytical/explicit source-module ownership; and unscaled explicit
  nodal field addition. It also checks top-level source contracts for the
  aggregate, analytical-cylinder, and explicit-field source files so their
  realization boundaries remain visible in implementation files.

Required before production qualification:

- mesh-level analytical convergence around an off-axis cylinder;
- explicit-field shape and units test through the public FEM plan API;
- parity check against any GPU/FDM Oersted capability that is production
  labeled;
- generalized current-solution lowering validation.
