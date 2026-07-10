# Task 1 report: canonical FEM dynamic-solver contract and claim freeze

## Status

Complete. The canonical FEM dynamic-pencil note is published, stale SLEPc
non-existence claims are removed, synthetic periodic-airbox and dense G5a GPU
claims fail closed, and no executable capability is promoted.

## Scope and ownership

Task-owned paths changed:

- `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`
- `docs/physics/0600-fem-eigenmodes-linearized-llg.md`
- `docs/physics/0700-frequency-domain-linearized-llg.md`
- `docs/physics/0828-fem-frequency-domain-floquet-demag.md`
- `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- `docs/specs/capability-matrix-v0.md`
- `scripts/test_frequency_domain_math_contract_docs.py`
- `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`
- `scripts/test_verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py`
- `scripts/verify_fem_frequency_domain_eigen_artifacts.py`
- `scripts/verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py`
- `docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md`
- `docs/superpowers/plans/2026-07-10-fem-dynamic-solver-remediation.md`

The two plan files were pre-existing untracked task inputs and are included
unchanged. Unrelated dirty relaxation, DMI, STT, runner, example, runtime, and
`justfile` paths were not modified or staged by this task.

## RED evidence

Tests were added before the note or verifier changes.

### Documentation contract

Command:

```text
python3 -m pytest -q scripts/test_frequency_domain_math_contract_docs.py
```

Result: exit 1, `1 failed, 6 passed`.

Expected failure:

```text
test_canonical_fem_dynamic_solver_contract_freezes_algebra_units_and_claims
AssertionError: canonical FEM dynamic-solver note is missing
```

This proved the new test required the absent canonical note rather than
passing on the existing scattered documentation.

### Synthetic periodic-airbox production claim

Command:

```text
python3 -m pytest -q scripts/test_verify_fem_frequency_domain_eigen_artifacts.py
```

Result: exit 1, `1 failed, 163 passed`.

Expected failure:

```text
test_validator_rejects_synthetic_periodic_airbox_production_claim
AssertionError: assert 0 != 0
```

The otherwise production-labelled periodic K0 fixture carried
`assembly_kind=synthetic_algebraic_oracle`, and the current verifier accepted
it. This was the required wrong acceptance.

### Broad G5a device-resident modal claim

Command:

```text
python3 -m pytest -q scripts/test_verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py
```

Result: exit 1, `1 failed, 6 passed`.

Expected failure:

```text
test_validator_rejects_broad_device_resident_modal_eigensolver_claim
AssertionError: assert 0 != 0
```

The dense one-thread G5a fixture carried
`gpu_device_resident_modal_eigensolver=true`, and the current verifier accepted
it. This was the required wrong acceptance.

## Minimal GREEN implementation

- Added one publication-style note defining the single
  `L`/`B_alpha`/`A_omega` dictionary, typed gamma/frequency/shift units,
  `lambda=i omega` mapping, BC-dependent gauge, full-descriptor residual,
  direct left/right modal rules, Petrov-Galerkin rules, phase-plus-frame
  Floquet constraints, truthful CPU/GPU ownership, API/IR/planner/runtime/
  artifact impact, validation matrix, checklist, and deferred capabilities.
- Replaced stale statements that no native SLEPc implementation exists with
  the accurate boundary: the adapter exists; real-scalar imaginary-axis
  targeting and real shared-domain Poisson assembly remain open.
- Added independent `implementation_state`, `validation_state`, and
  `validated_scope` evidence axes to the capability documentation.
- Kept synthetic Poisson and dense G5a algebra tests executable while marking
  both product-facing capabilities `source_visible`, not publishable.
- Required `assembly_kind=mfem_weak_form_shared_domain` before the periodic K0
  production verifier accepts an artifact.
- Renamed the G5a fixture to `gpu_dense_modal_validation`, required explicit
  non-persistent/non-scalable/validation-only facts, and rejected the old broad
  device-resident boolean.

## Final GREEN evidence

Fresh final commands run after the last implementation change:

```text
$ python3 -m pytest -q scripts/test_frequency_domain_math_contract_docs.py
.......                                                                  [100%]
7 passed in 0.03s

$ python3 -m pytest -q scripts/test_verify_fem_frequency_domain_eigen_artifacts.py
........................................................................ [ 43%]
........................................................................ [ 87%]
....................                                                     [100%]
164 passed in 13.49s

$ python3 -m pytest -q scripts/test_verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py
.......                                                                  [100%]
7 passed in 0.28s

$ git diff --check
# exit 0, no output
```

Total focused result: 178 tests passed, 0 failed; diff whitespace check passed.

## Self-review

- Design: the new note matches the approved `exp(+i omega t)`,
  `lambda=i omega`, `gamma0=mu0*abs(gamma)`, descriptor, gauge, Floquet,
  residual, ROM, and solver-lane decisions.
- Functionality: both previously accepted overclaims now fail on their exact
  provenance fields; accepted validation fixtures still exercise the algebra.
- Capability honesty: no row is promoted. Synthetic Poisson and dense G5a are
  `source_visible` with bounded algebra validation; the narrow cuSolverDN K0
  macrospin exception remains separate.
- Architecture: numerical ownership stays under `backends/fem`; no physics or
  state was added to `Context`, `mfem_bridge.cpp`, Rust orchestration, FDM, API,
  or UI.
- Scope: every changed line traces to Task 1. No unrelated dirty file is part
  of the task diff or planned commit.

## Remaining concerns and deferred work

- This task intentionally performs no native build or runtime workload. The
  approved design classifies it as documentation/claim hardening, and its
  explicit gates are the three Python suites plus `git diff --check`.
- Existing producers that still emit synthetic production provenance or the
  old broad G5a boolean will now fail closed. Later implementation tasks must
  update those producers only after real assembly or truthful bounded-adapter
  semantics exist.
- Real-split imaginary-axis SLEPc targeting, real MFEM Poisson assembly,
  finite-pencil qualification, persistent device Krylov, and general GPU modal
  eigensolve remain unavailable and are not claimed here.

## Commit

- Subject: `Freeze FEM dynamic solver contracts and claims`
- SHA: recorded in the final handoff because the commit is created after this report
