# Physics documentation

`docs/physics/` is the mandatory publication-style record of Fullmag's physical and numerical scope.

## Golden rule

Before implementing any new physics or numerics feature, create or update a note in this directory.

That note must describe:

- problem statement and motivation,
- governing equations, symbols, and SI units,
- assumptions and approximations,
- FDM, FEM, and hybrid interpretation,
- Python API and `ProblemIR` impact,
- planner and capability-matrix impact,
- validation strategy,
- completeness across the stack,
- deferred work.

## Why this exists

This directory is intended to evolve into:

- internal technical notes,
- reproducibility and validation records,
- publication supplements,
- the canonical physics reference for human contributors and coding agents.

## Naming convention

Recommended filenames:

- `0000-physics-documentation-standard.md`
- `0050-shared-problem-semantics-and-embedded-python-api.md`
- `0100-mesh-and-region-discretization.md`
- `units.md`
- `0200-llg-exchange-reference-engine.md`
- `0300-gpu-fdm-precision-and-calibration.md`
- `0400-demagnetization.md`
- `fem_exchange.md`
- `llg_conventions.md`
- `fem_zeeman.md`
- `fem_anisotropy_uniaxial.md`
- `fem_anisotropy_cubic.md`
- `fem_demag_poisson.md`
- `fem_demag_fem_bem.md`
- `fem_dmi.md`
- `fem_magnetoelastic.md`
- `fem_oersted.md`
- `fem_stt.md`
- `fem_thermal.md`
- `fem_thermal_brown.md`
- `0700-frequency-domain-linearized-llg.md`
- `0710-periodic-and-floquet-boundary-conditions.md`
- `0870-fem-bem-demag-open-boundary.md`
- `0880-active-effective-field-terms.md`
- `0900-native-fem-operator-contracts-and-validation.md`

The numbering is semantic, not bureaucratic.
