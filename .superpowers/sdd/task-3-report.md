# Task 3 report: Python DSL automatic sampling

## Scope delivered

- `TableAutosave(t_sampl="auto")`, `SaveField(..., every="auto")`, and
  `SaveScalar(..., every="auto")` now preserve automatic sampling as requested
  intent.
- `study.stages.tableautosave("auto", ...)` and
  `study.stages.autosave(..., every="auto")` accept the canonical literal.
- One shared cadence normalizer accepts positive finite numeric seconds or the
  exact lowercase literal `"auto"`; it rejects other strings, booleans, zero,
  negative values, NaN, and infinity.
- Automatic table, field, and scalar sampling lower to the Task 2 canonical
  `auto_sinc_cutoff` policy with guard factor `1.3`.
- Canonical script export preserves the literal `"auto"` for both flat and
  ordered-stage surfaces. Import/export reads requested policy and deliberately
  ignores `resolved_sample_period_s`, so a resolved runtime cadence cannot
  overwrite author intent.
- Existing numeric sampling JSON and rendered scripts remain unchanged.

## TDD record

RED command:

```bash
PYTHONPATH=packages/fullmag-py/src /home/kkingstoun/software/anaconda3/envs/numba_sprawna/bin/python -m pytest packages/fullmag-py/tests/test_table_autosave.py packages/fullmag-py/tests/test_study_stages.py packages/fullmag-py/tests/test_script_builder_roundtrip.py -q
```

Expected RED result: 13 failed, 24 passed. Failures were the missing `"auto"`
acceptance, the previous permissive boolean handling, missing automatic IR
variants, and exporters requiring only numeric cadence fields.

Final GREEN result for the same focused suite: 38 passed, with one existing
deprecation warning for legacy run-local sampling arguments.

Additional successful checks:

```bash
PYTHONPATH=packages/fullmag-py/src /home/kkingstoun/software/anaconda3/envs/numba_sprawna/bin/python -m compileall -q packages/fullmag-py/src/fullmag/_validation.py packages/fullmag-py/src/fullmag/model/outputs.py packages/fullmag-py/src/fullmag/model/study.py packages/fullmag-py/src/fullmag/world.py packages/fullmag-py/src/fullmag/runtime/script_builder.py
git diff --check
```

## Known unrelated failure

The required expanded run including `test_api.py` produced 288 passed and one
failure in
`ProblemApiTests.test_fem_backend_forwards_study_universe_to_shared_domain_realization`:
the mocked FEM domain mesher had call count 0 instead of 1. The same test fails
identically in isolation. It does not traverse sampling code, so no FEM code was
changed. Ruff was not available in the selected Python environment.

## Commit

`6629c6c3 Accept automatic sampling in the Python DSL`

## Review fix

The importer and ordered-stage renderer now route every present numeric cadence
through the shared `normalize_sampling_period` validator. Missing cadence keys
still mean “not configured”, while zero, negative, NaN, infinity, booleans, and
non-numeric values fail closed. Automatic policy import, resolved-cadence
handling, and valid legacy numeric rendering are unchanged.

TDD RED: `test_script_builder_roundtrip.py` reported 10 failing subtests that
demonstrated invalid imported or ordered-stage cadence values being accepted.

GREEN verification:

```bash
PYTHONPATH=packages/fullmag-py/src /home/kkingstoun/software/anaconda3/envs/numba_sprawna/bin/python -m pytest packages/fullmag-py/tests/test_script_builder_roundtrip.py -q
# 10 passed, 18 subtests passed

PYTHONPATH=packages/fullmag-py/src /home/kkingstoun/software/anaconda3/envs/numba_sprawna/bin/python -m pytest packages/fullmag-py/tests/test_table_autosave.py packages/fullmag-py/tests/test_study_stages.py packages/fullmag-py/tests/test_script_builder_roundtrip.py -q
# 40 passed, 1 warning, 18 subtests passed

git diff --check
# clean
```

Review-fix commit: `cc802582 Validate imported sampling cadences`.
