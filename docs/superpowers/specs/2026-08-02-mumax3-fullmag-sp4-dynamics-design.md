# MuMax3 and Fullmag µMAG SP4 dynamics design

- Status: approved design
- Date: 2026-08-02
- Scope: NIST/µMAG Standard Problem 4 reversal cases A and B
- Related physics note: `docs/physics/0980-mumag-standard-problem-4-fem-application-validation.md`

## Goal

Run the second SP4 phase as one continuous physical-time integration after the
zero-field S-state relaxation, in both MuMax3 and Fullmag, and compare the
recorded mean-reduced-magnetization trajectories rather than only their final
values.

## Decisions

1. The scope includes both official NIST reversal fields:
   - case A: `B_ext=(-24.6e-3, 4.3e-3, 0) T`;
   - case B: `B_ext=(-35.5e-3, -6.3e-3, 0) T`.
2. MuMax3 uses its native table and field output cadence: `10 ps` scalar
   samples, `100 ps` `m` autosaves, and `50 ps` snapshots.
3. Fullmag uses the public stage workflow on the FDM CPU double lane:
   `relax -> set B_ext -> tableautosave -> m autosave -> run`.
4. Fullmag records `t`, `mx`, `my`, `mz`, and energy/torque observables at
   `10 ps`; the dynamic `m` field series is recorded at `50 ps`.
5. Each case is one continuous `1 ns` reversal run. Re-running 10 ps chunks
   and reinitializing the solver is explicitly forbidden because it changes
   the adaptive history and is not the NIST physical-time experiment.
6. Comparisons use SI time in seconds, reduced magnetization components
   (dimensionless), common-time interpolation, component RMSE, endpoint error,
   and interpolated first positive-to-nonpositive `mx=0` crossing.

## Components

### MuMax3 input

`external_solvers/3/test/standardproblem4.mx3` remains the case-A input and is
made executable with the vendored MuMax3 parser. A case-B input is added next
to it with identical geometry, material, relaxation, output cadence, and only
the reversal field changed.

### Fullmag inputs

Two ordinary user scripts are added under
`tests/standard_problems/mumag/sp4/fdm/scenarios/`. They use explicit FDM CPU
double execution, the `128 x 32 x 1` grid, the NIST material constants, an
adaptive RK23 overdamped relaxation, and an adaptive RK45 physical-time run.
The scenario IR is tested without executing the expensive solver.

### Comparison

`scripts/compare_mumax3_fullmag_sp4_dynamics.py` reads one MuMax3 `table.txt`
and one Fullmag `scalars.csv` for each case. It rejects missing required
columns, non-monotonic time, non-finite values, and trajectories shorter than
the declared `1 ns`. It writes a JSON/CSV comparison report and does not turn
differences into a pass automatically.

## Validation gates

- MuMax3 parses and executes both `.mx3` files on the managed CUDA runtime.
- Fullmag export shows exactly `relax`, `autosave-m`, and `reversal` stages,
  with zero field during relaxation and the correct case field during the run.
- Both trajectories contain the initial relaxed sample and the complete
  `0..1 ns` interval at the declared scalar cadence.
- The comparison reports finite RMSE, endpoint deltas, and `mx=0` crossing
  times for both cases.
- A scientific agreement claim is made only after the actual runtime outputs
  are inspected; passing authoring tests alone is not runtime proof.

## Out of scope

- FEM dynamics qualification, GPU FDM qualification, and backend kernel
  changes.
- Replacing the NIST reference ensemble with MuMax3 as an exact oracle.
- Adding a new public API; existing `tableautosave` and stage autosave
  contracts are used unchanged.
