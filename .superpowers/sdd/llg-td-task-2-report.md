# Task 2 report: canonical Python LLG solver API

## Scope

Implemented only the Python authoring, scene-document, and canonical-script
surfaces from Task 2. No Rust ProblemIR, planner, runner, native, OpenAPI, or
Control Room code was changed.

## RED

Command:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_llg_solver_contract.py -q
```

Result: exit 1, `23 failed, 2 passed`.

Intended failures included:

- `StudyBuilder.solver()` and module `solver()` rejected `fix_dt`,
  `dt_initial`, `dt_max`, and `max_err` as unknown keywords;
- adaptive script loading failed on the canonical keywords;
- legacy aliases emitted no `DeprecationWarning`;
- an unknown integrator was stored without immediate validation.

The first two attempted commands (`uv run ...` and `python ...`) were
environment errors because this checkout has neither `uv` nor a `python`
shim. They were not counted as RED. The successful RED command uses
`python3` and the package source path explicitly.

## Implementation

- Added canonical `fix_dt`, `dt_initial`, `dt_min`, `dt_max`, and `max_err`
  parameters to both solver entry points.
- Kept `dt` and `max_error` as deterministic deprecated aliases, warned on
  use, and rejected ambiguous canonical/legacy mixes.
- Validated finite positive values, adaptive bounds, fixed/adaptive mutual
  exclusion, and supported/adaptive integrators before mutating world state.
- Lowered maximum-error mode as `atol=max_err, rtol=0` and allowed zero
  relative tolerance.
- Preserved omitted `AdaptiveTimestep.dt_initial` as `None`; explicit
  `dt_initial == dt_min` remains explicit.
- Added adaptive policy fields to builder drafts and scene overrides.
- Canonical script rendering now emits `fix_dt` for fixed mode and
  `dt_initial` (only when authored), `dt_min`, `dt_max`, and `max_err` for
  adaptive mode.

## GREEN and regression evidence

Focused contract:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_llg_solver_contract.py -q
8 passed, 17 subtests passed in 0.19s
```

Task-owned `test_api.py` regression surface, excluding one independently
reproducible FEM mesh-cache failure:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -q -k 'not fem_backend_forwards_study_universe_to_shared_domain_realization'
251 passed, 1 deselected in 8.34s
```

Full `test_api.py` result was `251 passed, 1 failed`. The remaining test is
`test_fem_backend_forwards_study_universe_to_shared_domain_realization`; it
expects `mocked_domain.call_count == 1` but observes `0`, reproduces alone,
and does not exercise solver policy.

The whole Python package run was `990 passed, 2 skipped, 22 failed`. Besides
the same FEM mesh test, failures are existing benchmark/source-contract and
the in-progress periodic-antidot example expectations; none touch the files
or behavior owned by Task 2.

Additional hygiene:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m compileall -q packages/fullmag-py/src/fullmag
git diff --check
```

Both commands exited 0.

## Changed files

- `packages/fullmag-py/src/fullmag/model/dynamics.py`
- `packages/fullmag-py/src/fullmag/world.py`
- `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- `packages/fullmag-py/tests/test_api.py`
- `packages/fullmag-py/tests/test_llg_solver_contract.py`

## Remaining review

Task 2 still requires independent specification and code-quality reviews.
No commit was created.

## Review remediation

The first specification/code-quality review found three gaps: solver calls
could partially mutate state before late validation, lower-level advanced
tolerances did not permit `atol=0`, and advanced adaptive controller/guard
settings were flattened into convenience `max_err` export.

Review RED:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_llg_solver_contract.py -q
7 failed, 8 passed, 17 subtests passed
```

The intended failures showed `atol=0` rejected, `adaptive_timestep` missing
from both solver entry points, prior `rk4` not considered when adding an
adaptive policy, an existing adaptive policy invalidated by a chained
integrator call, and nonfinite gamma accepted before mutating state.

Remediation:

- solver calls now construct and validate one proposed policy, effective
  prior/new integrator, gamma/g conversion, and demag interval before one
  state commit;
- chained calls preserve the current policy and reject changes that would
  make it illegal;
- `AdaptiveTimestep` permits either zero tolerance but rejects two zeros and
  all nonfinite tolerance/controller values;
- `StudyBuilder.solver(adaptive_timestep=...)` and module `solver(...)`
  preserve the complete advanced policy;
- builder draft, scene override, canonical script rendering, and reload
  preserve `atol`, `rtol`, bounds, safety, growth/shrink limits, rotation
  guard, and norm guard;
- convenience `max_err` rendering is used only for the semantically exact
  `rtol=0` policy with default controller settings and no advanced guards.

Review GREEN:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_llg_solver_contract.py -q
15 passed, 24 subtests passed in 0.29s

PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -q -k 'not fem_backend_forwards_study_universe_to_shared_domain_realization'
251 passed, 1 deselected in 8.13s

PYTHONPATH=packages/fullmag-py/src python3 -m compileall -q packages/fullmag-py/src/fullmag
git diff --check
```

All review GREEN/hygiene commands exited 0. Independent re-review remains
required before Task 2 is marked completed.

An additional focused RED proved that an explicitly authored advanced policy
with `rtol=0` was incorrectly rewritten as convenience `max_err`. Fullmag now
tracks the Python authoring tolerance mode separately from the numerical
values, so only a policy authored through `max_err` can use convenience
export. An explicit `AdaptiveTimestep`, even when numerically equivalent,
round-trips as `fm.AdaptiveTimestep(...)`.

## Re-review remediation

The next specification and quality review required policy-variant resolution,
partial override merging, an unspoofable internal authoring marker, and state
deduplication.

Re-review RED:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_llg_solver_contract.py -q
6 failed, 15 passed, 24 subtests passed
```

The failures demonstrated loss of partial override key presence, reset of
unspecified chained convenience values, inability to switch fixed/adaptive
variants through script overrides, and exposure of `_tolerance_mode` in the
public dataclass constructor.

Remediation:

- partial convenience and advanced scene overrides now preserve authored key
  presence and merge missing keys from the base dynamics policy;
- only nullable `dt_initial`, `dt_max`, `max_spin_rotation`, and
  `norm_tolerance` accept explicit clearing; required-value clearing and
  invalid merged bounds fail before rendering;
- script rendering resolves exactly one fixed, convenience adaptive, or
  advanced adaptive variant, including adaptive-to-fixed and
  fixed-to-adaptive overrides;
- chained convenience calls preserve omitted initial step, bounds, and
  maximum error from an existing maximum-error policy;
- `_tolerance_mode` is now `init=False`, `repr=False`, and `compare=False`;
  only the private `_from_max_error` factory can mark convenience authoring;
- removed the four redundant `_adaptive_dt_initial`, `_adaptive_max_err`,
  `_adaptive_dt_min`, and `_adaptive_dt_max` world-state mirrors.

Re-review GREEN:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_llg_solver_contract.py -q
21 passed, 24 subtests passed in 0.27s

PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -q -k 'not fem_backend_forwards_study_universe_to_shared_domain_realization'
251 passed, 1 deselected in 7.83s

PYTHONPATH=packages/fullmag-py/src python3 -m compileall -q packages/fullmag-py/src/fullmag
git diff --check
```

All re-review GREEN/hygiene commands exited 0.

## Fixed-draft and resolver follow-up

A final root/spec review identified a legacy full builder draft containing a
fixed timestep alongside empty adaptive keys. Focused RED reproduced the
false fixed/adaptive conflict. Two additional RED assertions covered an
advanced dictionary mixed with an active convenience value and an adaptive
policy rendered with an incompatible effective integrator.

The resolver now treats empty adaptive keys beside an active fixed policy as
cleared/inactive, while `max_err=None` remains an invalid explicit clear on
an adaptive base. It rejects advanced plus any active convenience value,
validates the effective integrator against the resolved policy, and continues
to require exactly one active policy variant. Builder drafts also remove
inactive timestep-policy keys before scene round-trip.

Final follow-up GREEN:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_llg_solver_contract.py -q
24 passed, 24 subtests passed in 0.23s

PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -q -k 'not fem_backend_forwards_study_universe_to_shared_domain_realization'
251 passed, 1 deselected in 7.90s

PYTHONPATH=packages/fullmag-py/src python3 -m compileall -q packages/fullmag-py/src/fullmag
git diff --check
```

All commands exited 0.
