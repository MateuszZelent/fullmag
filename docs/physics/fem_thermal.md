# FEM Thermal Interaction

- Status: native FEM CPU interaction documentation umbrella
- Last updated: 2026-05-30
- Implementation: `backends/fem/cpu/mfem/interactions/thermal_brown.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/thermal_brown_sigma.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/thermal_brown_sampler.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/thermal_brown_field.hpp/.cpp`
- Test: `backends/fem/tests/thermal_brown_contract.cpp`

## Zakres

The current native FEM thermal interaction is the Brown stochastic effective
field described in `docs/physics/fem_thermal_brown.md`.

This umbrella document exists because the release plan names
`docs/physics/fem_thermal.md` as the required interaction document, while the
executable implementation is intentionally more specific: Brown thermal field
sampling.

## Pole / torque

Thermal Brown noise contributes an additive stochastic effective field
`H_therm` in `A/m` to `H_eff`. It is not a direct torque and does not apply
gamma, damping, or LLG RHS scaling inside the interaction module.

## Kontrakt

Thermal noise contributes an H-field term `H_therm` in `A/m` to `H_eff`. It is
not a deterministic energy term and does not report a standalone energy
observable.

The executable Brown-field contract is:

```text
sigma_i^2 = 2 alpha_i kB T / (gamma_mu0 mu0 Ms_i V_i dt)
```

where `V_i` is the FEM nodal dual volume and `gamma_mu0` is the bare Gilbert
input used directly by Brown sampling. One raw unit-normal draw belongs to an
accepted interval; retries reuse it and rescale only through `dt^-1/2`.

The executable Brown implementation is split into the sigma formula module,
the sampler/cache/RNG module, and the additive field-composition module.

## Energia

Thermal Brown noise is a stochastic drive and the current native FEM CPU
implementation does not report a deterministic standalone energy term. Energy
monitors should treat it as a non-conservative stochastic field contribution.

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

## Warunki brzegowe

The Brown field is sampled per magnetic node and has no FEM weak boundary term.
Nonmagnetic nodes are explicitly zeroed. Boundary behavior therefore follows
the magnetic-node mask and accepted-step sampling policy, not a separate
surface or airbox condition.

## Dyskretyzacja FEM

The Brown sigma module computes a nodal standard deviation from the FEM nodal
dual volume `V_i`. The sampler uses the accepted `(time, dt)` state, seed, node
volumes, material fields, and magnetic mask to refresh or reuse the stochastic
AoS-3 field buffer. The field module then adds that sampled H field to `H_eff`.

## Ograniczenia capability

- The executable native FEM CPU thermal interaction is Brown thermal field
  sampling only.
- The stochastic field is tied to accepted-interval raw-draw semantics; retry
  `dt` changes rescale the field without drawing new noise.
- This is `sampling_correct`, not `statistically_validated`. Strict public FEM
  GPU thermal stays fail-closed pending public seed-carrier and parity gates.

## Testy

Current local gate:

- `fem_thermal_brown_contract` checks sigma, invalid-input zero behavior,
  initialization, per-node diagnostics, nonmagnetic-node zeroing,
  accepted-interval raw-draw reuse across retry with `dt` rescaling,
  source-module ownership, and additive `H_eff` semantics.
- It also runs a deterministic sampler moment check showing Brown-field sample
  variance follows the documented `1/dt` scaling for accepted timesteps.

Required before production qualification:

- active stochastic runtime evidence for the variance gate, accepted by
  `tests/fem_thermal_validation/artifact_validation.py`;
- Boltzmann macrospin CSV artifact acceptance is defined in
  `tests/fem_thermal_validation/artifact_validation.py` and unit-tested by
  `tests/fem_thermal_validation/test_acceptance.py`, but active stochastic LLG
  trajectory evidence is still required;
- deterministic seed/replay test through the public API;
- CPU/GPU parity before any shared production capability label.
