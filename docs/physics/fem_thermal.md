# FEM Thermal Interaction

- Status: native FEM CPU interaction documentation umbrella
- Last updated: 2026-05-16
- Implementation: `native/backends/fem/cpu/mfem/interactions/thermal_brown.hpp/.cpp`
- Test: `native/backends/fem/tests/thermal_brown_contract.cpp`

## Zakres

The current native FEM thermal interaction is the Brown stochastic effective
field described in `docs/physics/fem_thermal_brown.md`.

This umbrella document exists because the release plan names
`docs/physics/fem_thermal.md` as the required interaction document, while the
executable implementation is intentionally more specific: Brown thermal field
sampling.

## Kontrakt

Thermal noise contributes an H-field term `H_therm` in `A/m` to `H_eff`. It is
not a deterministic energy term and does not report a standalone energy
observable.

The executable Brown-field contract is:

```text
sigma_i = sqrt(2 alpha_i kB T / (gamma0_i mu0 Ms_i V_i dt))
gamma0_i = gamma_red * (1 + alpha_i^2)
```

where `V_i` is the FEM nodal dual volume. Repeated RHS evaluations at the same
accepted `(time, dt)` reuse the sampled thermal field.

## Jednostki

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| temperature | `T` | `K` |
| damping | `alpha` | `1` |
| reduced gyromagnetic ratio | `gamma_red` | `m/(A s)` |
| saturation magnetization | `Ms` | `A/m` |
| node dual volume | `V_i` | `m^3` |
| timestep | `dt` | `s` |
| thermal field | `H_therm` | `A/m` |

## Walidacja

Current local gate:

- `fem_thermal_brown_contract` checks sigma, invalid-input zero behavior,
  initialization, per-node diagnostics, nonmagnetic-node zeroing, same-time/dt
  cache reuse, and additive `H_eff` semantics.

Required before production qualification:

- statistical moment tests over many samples;
- deterministic seed/replay test through the public API;
- CPU/GPU parity before any shared production capability label.
