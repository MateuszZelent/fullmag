# FEM Zeeman / External Field

- Status: native FEM CPU/GPU module contract
- Last updated: 2026-06-17
- Implementation:
  `backends/fem/cpu/mfem/interactions/zeeman.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/zeeman_uniform_field.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/zeeman_field.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/zeeman_energy.hpp/.cpp`,
  `backends/fem/gpu/cuda/interactions/zeeman/zeeman_kernels.hpp/.cu`,
  `backends/fem/gpu/cuda/integrators/rk/rk_external_energy_reductions.hpp/.cu`
- Test: `backends/fem/tests/zeeman_contract.cpp`,
  `backends/fem/tests/source_facade_gpu_rk_contract.cpp`

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

## GPU realization

The native FEM GPU RK path consumes the same nodal `H_ext` buffer in A/m after
host-side plan import and field-buffer upload. Device-side effective-field
accumulation adds `h_ext` directly into `h_eff`; it does not multiply by
`gamma_mu0`, damping, or `Ms`. Those factors belong respectively to the LLG RHS
or energy reductions.

The final GPU energy reduction uses the same nodal lumped formula as CPU:

```text
E_Z = -mu0 sum_i Ms_i (m_i . H_ext_i) w_i
```

and masks out nonmagnetic FEM nodes. The reduction owns only the final scalar
publication path for RK stats; it does not own Zeeman plan import, field upload,
or RK orchestration.

## Ograniczenia capability

- Uniform `H_ext` is executable in the current native FEM CPU path.
- Uniform `H_ext` is executable in the current native FEM GPU RK path when the
  runtime has device-resident `Ms`, lumped mass, magnetic-node mask, and `H_ext`
  buffers.
- Spatially sampled and time-envelope Zeeman variants must be represented as
  explicit capability extensions before production labeling.
- End-to-end CPU/GPU numerical parity remains a runtime validation gate; the
  local source contracts only prove matching sign, units, ownership, and
  device-resident reduction semantics.

## Testy

Current gate:

- `fem_zeeman_contract` checks disabled-field zero behavior, uniform field
  broadcast, additive `H_eff` semantics, Zeeman energy sign/units, and
  source-module ownership. It also checks top-level source contracts for the
  aggregate, uniform-field broadcast, field-add, and energy integration source
  files so their ownership boundaries stay visible in implementation files.
- `fem_source_facade_gpu_rk_contract` checks that GPU RK external-energy
  reductions keep the Zeeman scalar path device-resident and documented as the
  same `H_ext` in A/m, `-mu0 Ms m.H_ext` energy contract.

Required before production qualification:

- sampled field projection;
- time envelope refresh;
- FEM CPU/GPU parity for uniform field beyond local source contracts;
- explicit public API unit-conversion tests.
