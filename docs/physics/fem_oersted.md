# FEM Oersted Field

- Status: native FEM CPU module contract
- Last updated: 2026-05-17
- Implementation: `native/backends/fem/cpu/mfem/interactions/oersted.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/oersted_cylinder.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/oersted_explicit.hpp/.cpp`
- Test: `native/backends/fem/tests/oersted_contract.cpp`

## Pole

The current native FEM CPU implementation supports two Oersted realizations:

- an analytical infinite-cylinder conductor;
- an explicit nodal `oersted_field_xyz` buffer supplied by the plan.

For the analytical cylinder, the module precomputes the static nodal field for
unit current, `I = 1 A`, and stores it in `h_oe_xyz` as an AoS-3 H field in
`A/m`. Runtime stepping multiplies that buffer by the configured current and
time envelope.

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

Explicit `oersted_field_xyz` buffers are already final H values in `A/m` and
are added without current scaling. Native FEM plan validation keeps the
analytical cylinder and explicit buffer mutually exclusive.

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
node coordinates and writes `h_oe_xyz` for unit current. During RHS assembly,
`add_oersted_field(...)` adds the scaled field to `H_eff`.

No gamma, damping, `mu0`, or direct torque factor is applied in this module; the
LLG RHS converts the final effective field to `dm/dt`.

## Ograniczenia capability

- The analytical cylinder is an infinite straight-conductor approximation.
- Arbitrary 3D cylinder axes are supported after finite non-zero normalization.
- Explicit generalized current-solution Oersted fields are supported only as a
  precomputed nodal field buffer in this native CPU module.
- Full generalized Biot-Savart/current-transport solving remains outside this
  module.
- GPU parity is not claimed by this module.

## Testy

Current gate:

- `fem_oersted_contract` checks unit-current Ampere-law samples inside,
  outside, and on the axis; zero-axis rejection; sinusoidal and pulse current
  scaling; analytical/explicit source-module ownership; and unscaled explicit
  nodal field addition.

Required before production qualification:

- mesh-level analytical convergence around an off-axis cylinder;
- explicit-field shape and units test through the public FEM plan API;
- parity check against any GPU/FDM Oersted capability that is production
  labeled;
- generalized current-solution lowering validation.
