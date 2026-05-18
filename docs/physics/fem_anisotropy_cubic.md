# FEM Cubic Anisotropy

- Status: native FEM CPU module contract
- Last updated: 2026-05-18
- Implementation: `native/backends/fem/cpu/mfem/interactions/anisotropy_cubic.hpp/.cpp`
- Test: `native/backends/fem/tests/anisotropy_contract.cpp`

## Energia

The native FEM CPU module uses crystal axes `c1`, `c2`, and `c3 = c1 x c2`.
For `mi = m.ci`, it reports:

```text
sigma = m1^2 m2^2 + m2^2 m3^2 + m1^2 m3^2
E_cub = integral_Omega [K1 sigma + K2 m1^2 m2^2 m3^2 + K3 sigma^2] dV
```

## Pole / torque

Cubic anisotropy contributes an effective field:

```text
H_cub = -(1/(mu0 Ms)) d e_cub / d m
```

The derivative is evaluated in the crystal frame and transformed back to the
simulation Cartesian frame. `H_cub` is returned in `A/m` and is added to
`H_eff`; it is not a direct `1/s` torque.

## Jednostki

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| reduced magnetization | `m` | `1` |
| crystal axes | `c1`, `c2`, `c3` | `1`, orthonormal |
| cubic constants | `K1`, `K2`, `K3` | `J/m^3` |
| saturation magnetization | `Ms` | `A/m` |
| effective field | `H_cub` | `A/m` |
| energy | `E_cub` | `J` |

## Warunki brzegowe

This is a local nodal interaction. It has no weak gradient term and introduces
no additional boundary condition. Nonmagnetic nodes are skipped.

## Dyskretyzacja FEM

The module evaluates nodal field contributions and integrates the energy with
the available nodal lumped weights. Uniform `K1`, `K2`, `K3`, and `Ms` are used
unless the matching per-node fields are populated.

## Ograniczenia capability

- Current production target: P1 native FEM CPU.
- The caller must provide normalized, orthogonal `c1` and `c2`; explicit
  validation remains an open production gate.
- GPU parity is not claimed by this module.
- Periodic projection is still performed by the caller in the transitional
  bridge flow.

## Testy

Current gate:

- `fem_anisotropy_contract` checks the `K1/K2/K3` energy convention, field
  values in the crystal frame, a known easy-axis zero-field case,
  source-module ownership, top-level source-contract docstrings for the
  aggregate/uniaxial/cubic sources, and nonmagnetic-node masking.

Required before production qualification:

- finite-difference directional derivative;
- axis orthonormality rejection;
- rotation-invariance regression;
- per-node `K1/K2/K3` scaling coverage.
