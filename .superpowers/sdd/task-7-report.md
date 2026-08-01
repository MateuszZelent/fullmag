# Task 7 report — exact FEM GPU NCG sync-budget accounting

Date: 2026-07-23

Status: **DONE_WITH_CONCERNS**. The review findings are fixed and the focused,
managed source, managed runtime, and one-repeat production-like 64-step NCG
proofs pass their Task 7 contracts. The performance recipe still exits 18 only
because the pre-existing accepted fixture/baseline mesh signature differs from
the currently realized solver mesh. The full five-repeat performance suite was
not rerun because the review requested the smallest sufficient managed proof.

## Root cause

GPU NCG derived `rhs_evaluations` from physical work:

- accepted-endpoint reuse set `current_evaluation_count=0`, so a normal
  64-step run published 65 records instead of the canonical 128 logical
  current-state/trial records;
- `backtracks + 1` represented normal trials but omitted the first forced
  recovery Armijo trial, because that trial is not another rejected backtrack;
- refinement evaluations were already explicit and remain included.

The budget consumer and `run_json_summary` cumulative sum were correct. The
producer telemetry was not. Two independent review findings were also valid:
the standalone Python runner referenced a nonexistent test name, and the
energy-derivative test only assigned a struct member and read it back.

## Fix

- `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp`
  now owns an explicit logical RHS-record counter. Every executed step starts
  with one current-state record, every normal or recovery Armijo trial adds one
  record, and refinement RHS evaluations remain additive. Accepted endpoint
  reuse still avoids recomputation; only telemetry changed.
- `backends/fem/tests/relaxation_source_contract.cpp` now requires separate
  normal/recovery trial increments and proves that direct Armijo populates
  `trial_snapshot.total_energy_j` while both NCG consumers use that value.
- `backends/fem/tests/relaxation_energy_derivative_contract.cpp` no longer
  contains the tautological struct assignment/readback test.
- `scripts/test_validate_fem_relaxation_runtime_log.py` now covers the actual
  64-step nominal budget, one extra trial, and the 30-backtrack forced-recovery
  boundary, and its no-argument runner calls the defined production-manifest
  test. Its older fail-closed recipe assertion now checks the configurable
  repeat argument and its default of five instead of requiring the obsolete
  literal `--repeat 5` spelling.
- `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md` now
  states that direct-minimizer `rhs_evals` are logical records, not claims of
  physical recomputation.

Armijo decisions, fresh-zero demag, rollback, refinement, PR+, accepted
trajectory, parity tolerances, ABI, and profiler ownership were not changed.

## RED evidence

Command:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
  just verify-fem-relaxation-source-contract
```

After adding the accounting contract and before changing NCG, the managed gate
exited 1 with:

```text
FAIL: native FEM GPU nonlinear-CG must consume accepted endpoint evaluations once while publishing one logical current-state record, every normal/recovery Armijo trial exactly once, and refinement evaluations
```

The initial sandboxed invocation could not access `/var/run/docker.sock`; the
same managed command was rerun with approved Docker access and produced the
intended RED above.

## GREEN evidence

Focused Task 7 Python contracts:

```bash
python3 -m pytest -q scripts/test_validate_fem_relaxation_runtime_log.py \
  -k 'gpu_ncg_control_readback_budget_matches_cumulative_armijo_sync_structure or run_json_summary_publishes_cumulative_rhs_telemetry or benchmark_parses_run_json_cumulative_rhs_telemetry or fem_gpu_performance_regression_recipe_enforces_ncg_control_budget'
```

Result: `4 passed, 111 deselected in 0.05s`.

Full Python test file:

```bash
python3 -m pytest -q scripts/test_validate_fem_relaxation_runtime_log.py
```

Result: `115 passed in 2.02s`.

Standalone no-argument runner:

```bash
python3 scripts/test_validate_fem_relaxation_runtime_log.py
```

Result: exit 0 with 41 `ok` lines, including
`test_fem_pgbb_demag_is_included_in_current_production_manifest`.

Managed native source gate:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
  just verify-fem-relaxation-source-contract
```

Result: exit 0. The semantic mesh ownership contract classified 191 accesses
and 64 producers; the managed CUDA build rebuilt `nonlinear_cg.cpp` and the
relaxation source, stage-completion, and explicit-RK targets completed.

Managed runtime gate:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
  just verify-fem-relaxation-runtime
```

Result: exit 0. It rebuilt and validated the `candidate-sm89` managed bundle
with 1536 HYPRE bindings, executed GPU LLG/PG-BB/NCG and CPU
LLG/PG-BB/NCG/TPI, and ended with
`FEM relaxation runtime smoke completed`.

Production-like 64-step NCG proof, one repeat:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP=3 \
FULLMAG_BENCH_RELAX_ALGORITHMS=nonlinear_cg \
FULLMAG_BENCH_REPEAT=1 \
  just verify-fem-gpu-performance-regression
```

The managed CPU and RTX 4080 SUPER GPU rows both completed with `status=ok`,
and CPU/GPU consistency reported `status=pass`, `failed_count=0`. The GPU row
reported:

- `executed_steps=64`
- last-step `rhs_evals=2`
- `total_rhs_evals=128`
- `hot_loop_control_scalar_host_sync_count=193`

The exact limit is `3 + 3*64 + max(0, 128 - 2*64) = 195`; the measured 193
passes. The focused boundary contract additionally accepts 129 records/196
syncs for one extra trial and 159 records/226 syncs when one step exhausts 31
normal trials at 30 backtracks and then executes its first forced-recovery
trial; the next sync fails in both cases.

The command exits 18 only after these rows pass because current signature
`20a1851a39da191c61cf50006e72c4b977fa31a5a4cdf2dee1e037e93640d431`
does not match the accepted fixture/baseline signature
`83dc036495e6f5c13d101dd94c010ee1af9b6ac560892d66411a4140172a2f41`.
No fixture or accepted baseline was changed.

## Repository hygiene and remaining concern

`.superpowers/sdd/progress.md` was pre-existing, ignored, and dirty. It was not
edited or staged. Generated runtime bundles and `.fullmag/reports` remain
operational artifacts and are not staged.

Remaining concern: the independent fixture/baseline identity mismatch still
prevents the full performance recipe from returning zero. Updating accepted
scientific identity is outside Task 7 and must be reviewed separately.

Fix commit: created after this report is staged; the exact SHA is recorded in
the Task 7 handoff.
