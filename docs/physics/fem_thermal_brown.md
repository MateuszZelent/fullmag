# FEM Brown Thermal Field

- Status: native FEM CPU module contract
- Last updated: 2026-05-16
- Implementation: `native/backends/fem/cpu/mfem/interactions/thermal_brown.hpp/.cpp`
- Test: `native/backends/fem/tests/thermal_brown_contract.cpp`

## Pole

The native FEM CPU path treats Brown thermal noise as a stochastic effective
field contribution `H_therm` in `A/m`. It is sampled per node and added to
`H_eff` before the LLG RHS converts the assembled field to `dm/dt`.

For node `i`, the standard deviation is:

```text
sigma_i = sqrt(2 alpha_i kB T / (gamma0_i mu0 Ms_i V_i dt))
gamma0_i = gamma_red * (1 + alpha_i^2)
```

where `V_i` is the local dual volume. The executable module uses per-node
`alpha_i`, `Ms_i`, and `V_i` when available and falls back to scalar material
values plus the legacy average magnetic-node volume only when node volumes are
missing.

## Energia

Brown thermal noise is not an energy-minimizing deterministic interaction and
does not report a standalone energy term. It contributes only to `H_eff`.

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

## Seed i cache

`thermal_seed = 0` keeps the run non-reproducible by seeding from system
entropy. Non-zero seeds initialize the module RNG deterministically.

`refresh_thermal_brown_field(...)` caches the last `(current_time, current_dt)`
pair. Repeated RHS evaluations at the same accepted state reuse the same
thermal field instead of resampling.

## Warunki brzegowe

The Brown field is local in the current nodal state. It has no FEM weak form,
matrix assembly, solver, or boundary condition. Nonmagnetic nodes are explicitly
zeroed.

## Dyskretyzacja FEM

`initialize_thermal_brown_field(...)` sizes the AoS-3 `h_therm_xyz` buffer.
`refresh_thermal_brown_field(...)` samples each active node using the Brown
sigma expression. `add_thermal_brown_field(...)` adds the sampled H field to
`H_eff` without additional gamma, damping, `mu0`, or direct torque conversion.

## Ograniczenia capability

- The current contract is stochastic-field sampling only.
- The module does not claim a stochastic calculus convention beyond the sampled
  field contract used by the existing explicit RHS path.
- GPU parity is not claimed by this module.
- Deterministic replay is seed-based and scoped to the current native CPU RNG
  implementation.

## Testy

Current gate:

- `fem_thermal_brown_contract` checks the Brown sigma formula, invalid-input
  zero behavior, buffer initialization, per-node sigma diagnostics,
  nonmagnetic-node zeroing, same-time/dt refresh caching, and additive `H_eff`
  semantics.

Required before production qualification:

- statistical moment tests over many samples;
- public API seed/replay test;
- comparison against a fixed reference trajectory for a small thermal run;
- CPU/GPU parity before any shared production capability label.
