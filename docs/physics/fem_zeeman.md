# FEM Zeeman / External Field

- Status: native FEM CPU module contract
- Last updated: 2026-05-16
- Implementation: `native/backends/fem/cpu/mfem/interactions/zeeman.hpp/.cpp`
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

The current module broadcasts the uniform field into `h_ext_xyz` and adds it to
the assembled effective field. Energy uses nodal lumped weights and per-node
`Ms` overrides when present.

## Ograniczenia capability

- Uniform `H_ext` is executable in the current native FEM CPU path.
- Spatially sampled and time-envelope Zeeman variants must be represented as
  explicit capability extensions before production labeling.
- GPU parity is not claimed by this module.

## Testy

Current gate:

- `fem_zeeman_contract` checks disabled-field zero behavior, uniform field
  broadcast, additive `H_eff` semantics, and Zeeman energy sign/units.

Required before production qualification:

- sampled field projection;
- time envelope refresh;
- FEM CPU/GPU parity for uniform field;
- explicit public API unit-conversion tests.
