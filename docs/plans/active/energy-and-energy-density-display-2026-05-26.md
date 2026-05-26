# Energy and energy-density display implementation plan

## Summary

Fullmag will expose energy density as canonical spatial-scalar quantities using existing IDs: `eden_ex`, `eden_demag`, `eden_ext`, `eden_ani`, `eden_dmi`, and `eden_total`. Global scalar energies stay in `data/scalars` and `simulation/solver/energies/*`; spatial densities go through the existing field resource path with `n_comp=1`.

The first implementation slice is FDM CPU plus API/control-room support. FDM CUDA and FEM density publication remain explicit follow-up work because they require device-side scalar buffers and FEM element/quadrature ownership.

## Implementation Changes

- Add `docs/physics/0890-energy-density-observables.md` as the canonical physics note.
- Activate `eden_*` quantity metadata only where the runtime can supply real fields.
- Extend runner preview helpers to carry spatial scalar payloads without packing fake 3-vectors.
- Add FDM CPU energy-density evaluators that reuse field buffers:
  - field-derived density terms use the same conventions as existing scalar energies;
  - `eden_total` is the pointwise sum of available active density terms;
  - scalar integration over cell volume must match the existing energy scalar.
- Update v2 field resources and preview state to respect `n_comp=1`.
- Replace the control-room hardcoded `"energy_density"` option with canonical `eden_*` quantities.

## Test Plan

- Add RED tests for FDM CPU density integration: `sum(eden_i * cell_volume) == E_i`.
- Add RED tests for `eden_*` availability in the FDM CPU quantity filter.
- Add RED tests for scalar preview fields preserving `n_comp=1` and scalar payload length.
- Add frontend tests or static checks that the ribbon no longer contains `"energy_density"` and includes canonical `eden_total`.
- Run focused Rust tests for `fullmag-engine`, `fullmag-runner`, and `fullmag-api`, then control-room type/test checks for touched files.

## Assumptions

- “amumax” means mumax3 and mumax+.
- No new ProblemIR authoring term is required; density is an observable derived from existing physics.
- The v1 implementation does not claim CUDA or FEM density support until those backends publish real density buffers.
