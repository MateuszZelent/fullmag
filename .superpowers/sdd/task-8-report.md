# Task 8 report — canonical FEM GPU PG-BB four-sync accounting

Date: 2026-07-23

Status: **DONE_WITH_CONCERNS**. The GPU PG-BB implementation, telemetry,
benchmark formula, recipes, source contracts, and physics note now share one
canonical four-sync-per-accepted-step contract. Focused and full Python tests,
the standalone runner, and the managed native source/CUDA derivative gate pass.
The exact required five-repeat production preset executed 50 successful GPU
PG-BB rows without a control-readback overrun, but the preset as a whole did
not pass CPU/GPU consistency because three unchanged PG-BB Armijo failure
classes occur identically with the immutable pre-Task-8 runtime.

## Root cause

GPU PG-BB paid two avoidable synchronization costs:

- the current state first read the energy-term snapshot and then performed a
  second three-scalar readback for total energy and two gradient norms;
- every line-search trial read a standalone total energy before the shared
  direct Armijo batch read the same trial energy terms again.

The benchmark still encoded the obsolete PG-BB ceiling of 11 syncs per step,
duplicated the direct-minimizer extra-attempt formula, and multiplied PG-BB
extra attempts by three. The production recipe also did not forward its repeat
count. PG-BB published `backtracks + 2` RHS records, which did not include
direct-energy refinement evaluations.

## Fix

- `GpuPgbbCurrentMetrics` packs the current energy-term snapshot, volume-metric
  tangent-gradient norm, energy-metric projected-gradient norm, and three
  device-produced finite/nonnegative flags into the shared scalar result
  workspace. PG-BB performs one current-state control readback and unpacks it
  on the host.
- Normal trials compute energy terms without a total-energy readback. The
  shared direct Armijo batch remains the decision owner and its
  `trial_snapshot.total_energy_j` is the trial diagnostic/observable value.
- PG-BB telemetry now counts one logical current record, every normal Armijo
  trial once, and direct-energy refinement RHS evaluations additively.
- `expected_control_sync_budget(algorithm, executed_steps, total_rhs_evals,
  initial_syncs)` is the only benchmark formula owner:

  `initial_syncs + per_step * executed_steps + max(0, total_rhs_evals - 2 * executed_steps)`

  with PG-BB `per_step=4` and NCG `per_step=3`. The obsolete PG-BB `* 3`
  branch and default 11 ceiling are gone.
- The production recipe defaults PG-BB to four, defaults repeats to five, and
  passes `--repeat`. The managed source recipe now also builds and executes the
  CUDA energy-derivative contract containing the packed finite-flag kernel
  test.

Armijo decisions, direct-energy refinement, BB1/BB2 updates and reset policy,
fresh-zero demag, rollback, ABI, and opt-in profiler ownership were not
changed.

## RED evidence

Focused Python contracts before implementation:

```bash
python3 -m pytest -q scripts/test_validate_fem_relaxation_runtime_log.py \
  -k 'gpu_pgbb_control_readback_budget_matches_cumulative_armijo_sync_structure or fem_relaxation_production_recipe_enforces_pgbb_control_budget_and_repeat'
```

Result: two intended failures. The benchmark still reported default 11 and the
production recipe did not own the four-sync/five-repeat contract.

Managed source contract after adding the semantic source assertions and before
the implementation:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
  just verify-fem-relaxation-source-contract
```

Result: exit 1 with:

```text
FAIL: native FEM GPU direct minimizers must use the shared direct energy-increment owner for Armijo decisions
```

The first sandboxed attempt could not access Docker. One subsequent harness
compile attempt exposed a test-slice scope mistake and was corrected before
using the semantic RED above.

## GREEN evidence

Focused Task 8/NCG regression contracts:

```bash
python3 -m pytest -q scripts/test_validate_fem_relaxation_runtime_log.py \
  -k 'gpu_pgbb_control_readback_budget_matches_cumulative_armijo_sync_structure or fem_relaxation_production_recipe_enforces_pgbb_control_budget_and_repeat or gpu_ncg_control_readback_budget_matches_cumulative_armijo_sync_structure'
```

Result: `3 passed, 113 deselected in 0.05s`.

Full Python test file:

```bash
python3 -m pytest -q scripts/test_validate_fem_relaxation_runtime_log.py
```

Result: `116 passed in 1.91s`.

Standalone no-argument runner:

```bash
python3 scripts/test_validate_fem_relaxation_runtime_log.py
```

Result: exit 0 with 43 `ok` lines.

Managed native source gate:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
  just verify-fem-relaxation-source-contract
```

Result: exit 0. The semantic mesh ownership contract classified 191 accesses
and 64 producers; the container rebuilt `direct_energy_increment.cpp`,
`pgbb.cpp`, the source contract, and the CUDA energy-derivative contract. The
derivative matrix covered exchange, Zeeman, PMA, cubic anisotropy, DMI, demag,
and prescribed-strain magnetoelasticity and ended with
`PASS: FEM relaxation energy derivative matrix`.

The first final source-gate invocation without the existing external-network
overlay stopped before compilation because Docker had exhausted its predefined
address pools. The overlay rerun above is the authoritative managed result.

## Exact five-repeat production result

Command:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
FULLMAG_BENCH_RELAX_ALGORITHMS=projected_gradient_bb \
FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP=4 \
FULLMAG_BENCH_REPEAT=5 \
  just verify-fem-relaxation-production-benchmark
```

Authoritative artifacts:

- `.fullmag/reports/fullmag_relaxation_production_benchmark.csv`
- `.fullmag/reports/fullmag_relaxation_production_benchmark_summary.json`

The command produced 110 rows: 95 `ok` and 15 `failed`. The completed split is
45 CPU rows and 50 GPU rows; failed rows are 10 CPU and 5 GPU. All 50 completed
GPU rows satisfy the canonical bound, with no control-readback failure and an
exact margin of three initial-budget syncs. Representative cumulative values:

| Executed steps | Total RHS records | Measured syncs | Canonical bound |
|---:|---:|---:|---:|
| 32 | 71 | 135 | 138 |
| 32 | 91 | 155 | 158 |
| 32 | 65 | 129 | 132 |
| 32 | 64 | 128 | 131 |
| 13 | 34 | 60 | 63 |

Completed rows retained `status=ok`; no control-readback or energy-monotonicity
failure was reported for them. The global summary is `status=fail` with 21
derived failures because five repeats each were missing a completed row for:

- CPU `exchange_only_box500_airbox1um`;
- CPU `box500_airbox_exchange_anis_uniaxial`;
- GPU `box500_airbox_exchange_zeeman`.

Those missing pairs make the required CPU/GPU-consistency matrix incomplete.
This is not the older accepted-fixture mesh-signature-only failure.

## Minimal pre-Task-8 versus HEAD evidence

The authoritative Task 0 fixture
`examples/assets/fem_performance/box500_airbox_exchange_demag_v1.fixture.json`
and retained Task 6/Task 7 rows cover exchange-plus-demag NCG, not these three
PG-BB scenario/backend pairs. The production recipe's
`box500-airbox-interaction-consistency` preset does include all three pairs, so
the exact Task 8 acceptance command was already exposed to them before this
change.

One-repeat, single-backend/single-scenario reproductions used identical current
scenario definitions, coarse input mesh, `hmax=250 nm`, `airbox_hmax=500 nm`,
PG-BB, and 32 requested steps. The only runtime selection change was:

- pre-Task-8 immutable managed runtime:
  `candidate-sm89-eea729ad9b6e550165b968ea283aed0b0faf4a9b74eec58e91f92b8373e54b51`,
  created at 20:35:49 local, before base commit `fbc14172` at 20:41:33;
- HEAD managed runtime:
  `candidate-sm89-7aec841222232a1bfcd87e9a0ba6fc2e9501ccb99b6ccacd21d521bc8f439b69`.

All three failure classes reproduce on both runtimes at step 1 after 20
backtracks:

- both CPU cases exhaust the unchanged CPU PG-BB Armijo loop; their gradient
  and final trial fingerprints match within each runtime, and Task 8 does not
  modify CPU code;
- GPU Zeeman has finite current energy and gradient metrics, then the unchanged
  direct Armijo owner rejects a positive direct energy increment. Pre-Task-8
  reports `direct_delta_j=2.17563960944130245e-48`; HEAD reports
  `7.90355970181576888e-49`. Both have `direct_armijo_decision=1`, no
  refinement, 20 backtracks, and successful rollback. A packed finite-flag
  failure would instead stop before line search with the explicit non-finite or
  negative metric diagnostic.

The old immutable CPU exchange-only run reports an energy fingerprint matching
its old uniaxial run despite the correct exchange-only problem label, so this
A/B is failure-class evidence rather than a new identity-pinned acceptance
fixture. No fixture, accepted baseline, Armijo tolerance, BB policy, or restart
policy was changed.

## Acceptance conflict and remaining concern

Task 8 simultaneously requires unchanged Armijo/BB/restart physics and a full
pass of the exact nine-scenario preset. The immutable pre-Task-8 runtime fails
the same three scenario/backend pairs, while changing their numerical
acceptance policy or narrowing the suite is explicitly outside Task 8. The
implementation is therefore `production_executable` and its four-sync budget
is executed across 50 completed GPU rows, but the full production matrix is not
`validated`.

`.superpowers/sdd/progress.md` was pre-existing, ignored, and dirty. It was not
edited or staged. Runtime variants, benchmark CSV/JSON, and raw diagnostic logs
are operational artifacts and are not staged.

Fix commit: created after this report is staged; the exact SHA is recorded in
the Task 8 handoff.
