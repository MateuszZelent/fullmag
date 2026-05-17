# FEM Magnetoelastic Prescribed Strain

- Status: native FEM CPU module contract
- Last updated: 2026-05-17
- Implementation:
  `native/backends/fem/cpu/mfem/interactions/magnetoelastic.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/magnetoelastic_prescribed_strain.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/magnetoelastic_field.hpp/.cpp`
- Test: `native/backends/fem/tests/magnetoelastic_contract.cpp`
- Parent note: `docs/physics/0700-shared-magnetoelastic-semantics.md`

## Pole

The native FEM CPU module implements prescribed small-strain magnetoelastic
coupling with cubic `B1/B2` constants. It contributes an effective field
`H_mel` in `A/m` to `H_eff`.

The strain input uses Voigt engineering-shear order:

```text
[e11, e22, e33, 2e23, 2e13, 2e12]
```

The module converts engineering shear to tensor strain before evaluating:

```text
H_x = -[2 B1 mx e11 + 2 B2 (my e12 + mz e13)] / (mu0 Ms)
H_y = -[2 B1 my e22 + 2 B2 (mx e12 + mz e23)] / (mu0 Ms)
H_z = -[2 B1 mz e33 + 2 B2 (mx e13 + my e23)] / (mu0 Ms)
```

Uniform strain and per-node strain buffers are supported.

## Energia

When nodal lumped masses are available, the module reports:

```text
e_mel =
  B1 (mx^2 e11 + my^2 e22 + mz^2 e33)
  + 2 B2 (mx my e12 + mx mz e13 + my mz e23)

E_mel = sum_i e_mel,i * w_i
```

The accumulated energy is stored in `ctx.mel_energy` in joules.

## Jednostki

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| reduced magnetization | `m` | `1` |
| magnetoelastic constants | `B1`, `B2` | `Pa` |
| strain | `eps` | `1` |
| saturation magnetization | `Ms` | `A/m` |
| magnetoelastic field | `H_mel` | `A/m` |
| magnetoelastic energy | `E_mel` | `J` |

## Warunki brzegowe

This module covers prescribed strain only. It has no mechanical solve, no
elastic boundary condition assembly, and no coupled displacement field. Full
mechanical coupling remains governed by the broader magnetoelastic specs.

## Dyskretyzacja FEM

`compute_magnetoelastic_field(...)` evaluates the local field at FEM nodes and
integrates energy with existing nodal lumped masses. Nonmagnetic nodes are
zeroed. `add_magnetoelastic_field(...)` adds the current `h_mel_xyz` buffer to
`H_eff`.

Source ownership: `magnetoelastic_prescribed_strain.hpp/.cpp` owns the
prescribed-strain `B1/B2` field and conservative-energy computation.
`magnetoelastic_field.hpp/.cpp` owns additive `H_eff` composition.
`magnetoelastic.hpp/.cpp` remains an aggregate include and compatibility
translation unit.

No gamma, damping, or direct RHS torque conversion is applied in this module.

## Ograniczenia capability

- Prescribed strain only.
- No quasistatic elastic solve.
- No dynamic elastic wave solve.
- No interface magnetoelastic coupling.
- GPU parity is not claimed by this module.

## Testy

Current gate:

- `fem_magnetoelastic_contract` checks the `B1/B2` field formula, engineering
  shear conversion, energy integration with nodal lumped masses, per-node strain
  selection, nonmagnetic-node masking, additive `H_eff` semantics, and
  source-module ownership.

Required before production qualification:

- public API strain-shape validation;
- comparison against an analytic single-domain prescribed-strain fixture;
- convergence test for nonuniform strain sampling;
- parity check before any shared CPU/GPU magnetoelastic capability label.
