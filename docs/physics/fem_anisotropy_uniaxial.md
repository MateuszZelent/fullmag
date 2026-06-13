# FEM Uniaxial Anisotropy

- Status: native FEM CPU module contract
- Last updated: 2026-05-18
- Implementation: `native/backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.hpp/.cpp`
- Test: `native/backends/fem/tests/anisotropy_contract.cpp`

## Energia

The native FEM CPU module currently reports the easy-axis energy convention:

```text
E_ani = integral_Omega [-Ku1 (m.u)^2 - Ku2 (m.u)^4] dV
```

For `Ku1 > 0`, magnetization parallel to the axis `u` has lower energy than
magnetization perpendicular to `u`. This differs from the shifted convention
`Ku(1 - (m.u)^2)` only by a constant for uniform material parameters.

For multi-body shared-domain FEM, `u` may be either a uniform material axis or
a nodal realized axis field `u(x)` produced by the planner from per-object or
per-region material assignments. The physical energy is then:

```text
E_ani = integral_Omega [-Ku1(x) (m.u(x))^2 - Ku2(x) (m.u(x))^4] dV
```

Each nonzero `u(x)` sample is normalized before the runtime uses it. Nodes with
inactive anisotropy coefficients may carry the default axis; it has no physical
effect while `Ku1(x) = Ku2(x) = 0`.

## Pole / torque

Uniaxial anisotropy contributes an effective field, not a direct torque:

```text
H_ani(x) = [2 Ku1(x)/(mu0 Ms(x)) (m.u(x)) + 4 Ku2(x)/(mu0 Ms(x)) (m.u(x))^3] u(x)
```

`H_ani` is added to `H_eff` in `A/m`. The LLG integrator applies `gamma_mu0`
and damping later.

## Jednostki

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| reduced magnetization | `m` | `1` |
| anisotropy axis | `u` | `1`, normalized |
| first anisotropy constant | `Ku1` | `J/m^3` |
| second anisotropy constant | `Ku2` | `J/m^3` |
| saturation magnetization | `Ms` | `A/m` |
| effective field | `H_ani` | `A/m` |
| energy | `E_ani` | `J` |

## Warunki brzegowe

This is a local nodal interaction. It introduces no gradient term and no
additional natural boundary condition. Nonmagnetic nodes are skipped and their
field contribution is zero.

## Dyskretyzacja FEM

The current transition module evaluates the field at nodes and integrates
energy with the available nodal lumped weights. Uniform `Ku1`, `Ku2`, and `Ms`
are used unless the corresponding per-node fields are populated. Per-node
anisotropy axis fields use the same P1 nodal ownership as `Ku1`, `Ku2`, and
`Ms`; they are a realization detail of the FEM plan, not a new public authoring
construct.

## Ograniczenia capability

- Current production target: P1 native FEM CPU.
- Axis validation is still handled outside this module and must reject zero or
  non-normalized axes before production qualification.
- GPU parity is not claimed by this module.
- Periodic maps require field projection by the caller, matching the current
  transitional `mfem_bridge.cpp` flow.
- Heterogeneous uniaxial axes are supported only after shared-domain
  materialization can prove nodal axis realization. Cubic-axis heterogeneity is
  a separate capability and remains outside this slice.

## Testy

Current gate:

- `fem_anisotropy_contract` checks per-node `Ku1`, `Ku2`, and `Ms` scaling,
  energy sign/convention, field units, source-module ownership, top-level
  source-contract docstrings for the aggregate/uniaxial/cubic sources, and
  zero contribution on nonmagnetic nodes.

Required before production qualification:

- finite-difference directional derivative;
- explicit axis normalization/capability rejection;
- easy-plane sign coverage;
- periodic projection regression.
