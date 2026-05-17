# FEM Zeeman / External Field

- Status: native FEM CPU module contract
- Last updated: 2026-05-17
- Implementation:
  `native/backends/fem/cpu/mfem/interactions/zeeman.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/zeeman_uniform_field.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/zeeman_field.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/zeeman_energy.hpp/.cpp`
- Test: `native/backends/fem/tests/zeeman_contract.cpp`

## Energia

The native FEM CPU path treats the external field as `H_ext` in `A/m`:

```text
E_Z = -mu0 integral_Omega Ms m . H_ext dV
```

The current executable contract supports a uniform field broadcast to all
nodes. Energy is integrated with nodal lumped weights.

## Pole / torque

Zeeman contributes directly to `H_eff`:

```text
H_Z = H_ext
```

It is not a direct `1/s` torque. The LLG integrator applies `gamma_mu0` and
damping after field assembly.

## Jednostki

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| reduced magnetization | `m` | `1` |
| external field | `H_ext` | `A/m` |
| saturation magnetization | `Ms` | `A/m` |
| energy | `E_Z` | `J` |

## Warunki brzegowe

Zeeman is a local field term. It has no FEM weak gradient term and no boundary
condition.

## Dyskretyzacja FEM

The current modules broadcast the uniform field into `h_ext_xyz` and add it to
the assembled effective field. Energy uses nodal lumped weights and per-node
`Ms` overrides when present.

Source ownership: `zeeman_uniform_field.hpp/.cpp` owns the uniform `H_ext`
broadcast, `zeeman_field.hpp/.cpp` owns additive `H_eff` composition, and
`zeeman_energy.hpp/.cpp` owns the `E_Z` integration. `zeeman.hpp/.cpp` remains
an aggregate include and compatibility translation unit.

## Ograniczenia capability

- Uniform `H_ext` is executable in the current native FEM CPU path.
- Spatially sampled and time-envelope Zeeman variants must be represented as
  explicit capability extensions before production labeling.
- GPU parity is not claimed by this module.

## Testy

Current gate:

- `fem_zeeman_contract` checks disabled-field zero behavior, uniform field
  broadcast, additive `H_eff` semantics, Zeeman energy sign/units, and
  source-module ownership.

Required before production qualification:

- sampled field projection;
- time envelope refresh;
- FEM CPU/GPU parity for uniform field;
- explicit public API unit-conversion tests.
