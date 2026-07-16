# FEM Brown Thermal Field

- Status: native FEM Brown sampling contract; sampling_correct, not statistically_validated
- Last updated: 2026-07-12
- Implementation: `backends/fem/cpu/mfem/interactions/thermal_brown.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/thermal_brown_sigma.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/thermal_brown_sampler.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/thermal_brown_field.hpp/.cpp`
- Test: `backends/fem/tests/thermal_brown_contract.cpp`

## Pole

The native FEM CPU path treats Brown thermal noise as a stochastic effective
field contribution `H_therm` in `A/m`. It is sampled per node and added to
`H_eff` before the LLG RHS converts the assembled field to `dm/dt`.

For node `i`, the standard deviation is:

```text
sigma_i^2 = 2 alpha_i kB T / (gamma_mu0 mu0 Ms_i V_i dt)
```

where `V_i` is the local dual volume. The executable module uses per-node
`alpha_i`, `Ms_i`, and `V_i` when available and falls back to scalar material
values plus the legacy average magnetic-node volume only when node volumes are
missing.

The `gyromagnetic_ratio` input is the bare gamma_mu0 convention used by the
LLG RHS, not gamma_bar = gamma_mu0 / (1 + alpha_i^2). The Brown denominator
uses bare gamma_mu0 directly. LLG alone applies its Gilbert
`1 / (1 + alpha_i^2)` conversion; applying that factor in both places would
understate the thermal amplitude.

Source ownership: `thermal_brown_sigma.hpp/.cpp` owns the Brown sigma formula,
`thermal_brown_sampler.hpp/.cpp` owns buffer initialization, RNG seed handling,
node-volume fallback, nonmagnetic-node zeroing, and accepted-interval raw-draw
reuse,
and `thermal_brown_field.hpp/.cpp` owns additive `H_eff` composition. The
`thermal_brown.hpp/.cpp` surface owns plan import only and is otherwise a
compatibility aggregate; it does not define sigma, sampling/cache, or `H_eff`
addition.

## Energia

Brown thermal noise is not an energy-minimizing deterministic interaction and
does not report a standalone energy term. It contributes only to `H_eff`.

## Jednostki

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| temperature | `T` | `K` |
| damping | `alpha` | `1` |
| bare gyromagnetic ratio | `gamma_mu0` | `m/(A s)` |
| saturation magnetization | `Ms` | `A/m` |
| node dual volume | `V_i` | `m^3` |
| timestep | `dt` | `s` |
| thermal field | `H_therm` | `A/m` |

## Seed i cache

`thermal_seed = 0` requests system entropy; a nonzero seed requests deterministic
replay. Provenance must preserve the requested seed policy, the resolved seed,
and the accepted interval index. A numeric zero is not a reproducible seed.

For one accepted interval `n`, the sampler draws one raw AoS-3 vector
`xi_n ~ N(0, 1)` and every RHS stage and rejected retry reuses it. A retry with
`dt_retry` recomputes only `H_therm = xi_n sigma(dt_retry)`; it must not redraw
`xi_n`. The raw draw is invalidated only after acceptance advances the interval
index or an explicit runtime reset.

## Warunki brzegowe

The Brown field is local in the current nodal state. It has no FEM weak form,
matrix assembly, solver, or boundary condition. Nonmagnetic nodes are explicitly
zeroed.

## Dyskretyzacja FEM

`initialize_thermal_brown_field(...)` sizes the AoS-3 `h_therm_xyz` buffer.
`refresh_thermal_brown_field(...)` samples each active node once per accepted
interval and rescales it using the Brown sigma expression for retry `dt`.
`add_thermal_brown_field(...)` adds the sampled H field to
`H_eff` without additional gamma, damping, `mu0`, or direct torque conversion.

## Ograniczenia capability

- The current contract is `sampling_correct`, not `statistically_validated`.
- It does not yet qualify a stochastic calculus convention, weak convergence,
  equilibrium statistics, or adaptive stochastic RK semantics beyond raw-draw
  reuse and `dt^-1/2` rescaling.
- Native FEM CPU is the only public thermal sampling lane. Strict FEM GPU
  thermal remains fail-closed until the public requested/resolved seed carrier
  reaches the native plan and its GPU law/parity gate passes; no fallback is
  implied.
- Deterministic replay is seed- and accepted-interval-index-based and scoped to
  the current native CPU RNG implementation.

## Testy

Current gate:

- `fem_thermal_brown_contract` checks the Brown sigma formula, invalid-input
  zero behavior, buffer initialization, per-node sigma diagnostics,
  nonmagnetic-node zeroing, accepted-interval raw-draw reuse across retry with
  `dt` rescaling, source-module ownership, aggregate-header non-ownership
  documentation, top-level
  source-contract docstrings for the aggregate/sigma/sampler/field-add sources,
  additive `H_eff` semantics, and deterministic sampler variance scaling
  against the documented `1/dt` accepted-timestep law.

Required before production qualification:

- active stochastic runtime evidence for the variance gate, accepted by
  `tests/fem_thermal_validation/artifact_validation.py`;
- Boltzmann macrospin CSV artifact acceptance is defined in
  `tests/fem_thermal_validation/artifact_validation.py` and unit-tested by
  `tests/fem_thermal_validation/test_acceptance.py`, but active stochastic LLG
  trajectory evidence is still required;
- public API seed/replay test;
- comparison against a fixed reference trajectory for a small thermal run;
- CPU/GPU parity before any shared production capability label.
