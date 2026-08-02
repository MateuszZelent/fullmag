# MuMax3 and Fullmag SP4 Dynamics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute and compare continuous µMAG SP4 reversal trajectories A and B in MuMax3 and Fullmag with explicit `tableautosave` output.

**Architecture:** Keep the existing native MuMax3 test inputs as the reference lane and add two public Fullmag FDM CPU scenario scripts. A small read-only comparison utility consumes the two applications' existing scalar tables and computes shared-grid trajectory metrics; no solver backend or public API changes are required.

**Tech Stack:** MuMax3 `.mx3`, Fullmag Python DSL, ProblemIR export, pytest, NumPy, CSV/JSON artifacts, managed CUDA runtime.

## Global Constraints

- Use the NIST SI contract: `500 nm x 125 nm x 3 nm`, `Ms=8e5 A/m`, `Aex=1.3e-11 J/m`, `alpha=0.02`, and `gamma0=2.211e5 m/(A s)`.
- Execute both official fields: A `(-24.6e-3, 4.3e-3, 0) T`, B `(-35.5e-3, -6.3e-3, 0) T`.
- Keep the reversal as one continuous `1 ns` physical-time run after relaxation.
- Use `10 ps` scalar samples and preserve SI units: seconds for time, dimensionless reduced magnetization, joules for energy.
- Do not modify unrelated dirty files or claim physics agreement from source/tests alone.

---

### Task 1: Add failing scenario and input-contract tests

**Files:**
- Create: `tests/standard_problems/mumag/sp4/fdm/__init__.py`
- Create: `tests/standard_problems/mumag/sp4/fdm/scenarios/__init__.py`
- Create: `tests/standard_problems/mumag/sp4/fdm/test_scenarios.py`
- Create: `tests/standard_problems/mumag/sp4/fdm/test_compare.py`

**Interfaces:**
- Consumes: the existing `fullmag.runtime.helper export-run-config` path and the shared SP4 case constants.
- Produces: failing tests that require two FDM stage scripts and a strict trajectory parser/metric interface.

- [ ] **Step 1: Write the failing test**

Assert that `case_a_rk45_adaptive.py` and `case_b_rk45_adaptive.py` exist,
export exactly `flat_relax`, `flat_autosave`, `flat_run`, use FDM CPU double,
have no Zeeman term in relaxation, have the correct case field in the run,
sample `10e-12`, save `m` at `50e-12`, and run for `1e-9`.

Add parser fixtures with headers `t,mx,my,mz` and assert the comparison
function returns finite RMSE, endpoint deltas, and a linearly interpolated
crossing time. Add rejection cases for missing columns, duplicate/non-increasing
time, non-finite values, and a trajectory ending before `1e-9`.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```text
PYTHONPATH=packages/fullmag-py/src pytest -q tests/standard_problems/mumag/sp4/fdm
```

Expected: collection or assertion failure because the two scenario modules and
comparison parser do not yet exist.

### Task 2: Implement the two continuous Fullmag FDM scenarios

**Files:**
- Create: `tests/standard_problems/mumag/sp4/fdm/scenarios/case_a_rk45_adaptive.py`
- Create: `tests/standard_problems/mumag/sp4/fdm/scenarios/case_b_rk45_adaptive.py`

**Interfaces:**
- Consumes: existing `fm.study`, `study.stages.add_relax`, `study.b_ext`,
  `study.tableautosave`, and `study.stages.autosave` APIs.
- Produces: one stage-first Fullmag script per NIST field.

- [ ] **Step 1: Implement case A and case B with the exact shared setup**

Each script must declare `fm.study`, `study.engine("fdm")`,
`study.device("cpu", precision="double")`, the `128 x 32 x 1` cell grid,
the NIST film and material values, `study.demag()`, and the dynamic solver.
The ordered stages must be:

```python
study.tableautosave(
    10e-12,
    quantities=["step", "t", "dt", "mx", "my", "mz", "e_ex", "e_demag", "e_ext", "e_total", "max_torque_T"],
)
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk23",
    dt_initial=1e-15,
    dt_min=1e-17,
    dt_max=1e-14,
    max_err=1e-7,
    relax_alpha=1.0,
    max_steps=100_000,
    tolA=1e-6,
)
study.b_ext(*FIELD)
study.stages.autosave("m", every=50e-12, stage_id="autosave-m")
study.stages.add_run(stage_id="reversal", until=1e-9)
```

The only difference between the two scripts is the named field and study
identity. The run solver is adaptive RK45 with the canonical `2e-13 s` cap,
`1e-15 s` initial step, `1e-17 s` minimum step, and `max_err=1e-7`.

- [ ] **Step 2: Run the scenario export tests**

Run:

```text
PYTHONPATH=packages/fullmag-py/src pytest -q tests/standard_problems/mumag/sp4/fdm/test_scenarios.py
```

Expected: PASS, with no native solver execution.

### Task 3: Implement strict trajectory parsing and comparison metrics

**Files:**
- Create: `tests/standard_problems/mumag/sp4/fdm/compare.py`
- Modify: `tests/standard_problems/mumag/sp4/fdm/test_compare.py`

**Interfaces:**
- Consumes: MuMax3 tab-separated `table.txt` headers such as `# t (s)`,
  Fullmag comma-separated `scalars.csv`, and `numpy.ndarray` trajectories.
- Produces: `Trajectory` and `compare_trajectories(left, right, duration_s=1e-9)`.

- [ ] **Step 1: Implement parsers and fail-closed validation**

Normalize MuMax3 names `t`, `mx`, `my`, `mz` and Fullmag aliases `time`/`t`.
Require strictly increasing time, finite values, exactly three magnetization
components, and coverage through `1e-9`. Interpolate both series on the
overlapping common grid, compute componentwise RMSE and endpoint delta, and
interpolate the first positive-to-nonpositive `mx` crossing.

- [ ] **Step 2: Run the comparison tests**

Run:

```text
PYTHONPATH=packages/fullmag-py/src pytest -q tests/standard_problems/mumag/sp4/fdm/test_compare.py
```

Expected: PASS.

### Task 4: Add and validate the MuMax3 A+B inputs

**Files:**
- Modify: `external_solvers/3/test/standardproblem4.mx3`
- Create: `external_solvers/3/test/standardproblem4_caseb.mx3`

**Interfaces:**
- Consumes: vendored MuMax3 v3.12 parser and CUDA runtime.
- Produces: valid case-A and case-B inputs with identical output cadence.

- [ ] **Step 1: Restore the vendored parser-compatible syntax**

Use lowercase `setgridsize`, `setcellsize`, `minimize`, `tablesave`,
`tableautosave`, `autosave`, `autosnapshot`, `B_ext = vector(...)`, and
`run`. Keep `tableautosave(10e-12)`, `autosave(m,100e-12)`, and
`autosnapshot(m,50e-12)` after relaxation and before the reversal run.

- [ ] **Step 2: Run MuMax3 syntax/runtime smoke for both files**

Run the managed MuMax3 CUDA container with the two inputs and inspect both
`table.txt` files. Expected: successful parse, at least one relaxed row, rows
through `1 ns`, and columns `t`, `mx`, `my`, `mz`.

### Task 5: Execute A+B and publish the comparison report

**Files:**
- Create: `scripts/compare_mumax3_fullmag_sp4_dynamics.py`
- Create: `docs/audits/2026-08-02-mumax3-fullmag-sp4-dynamics-comparison.md`

**Interfaces:**
- Consumes: the two MuMax3 table files and the two Fullmag `scalars.csv` files.
- Produces: machine-readable comparison JSON/CSV and an evidence-backed Markdown report.

- [ ] **Step 1: Add the CLI wrapper**

Expose explicit `--case-a-mumax`, `--case-a-fullmag`, `--case-b-mumax`,
`--case-b-fullmag`, and `--output` paths. Call the strict parser and write
case-labelled metrics without applying an unapproved pass threshold.

- [ ] **Step 2: Run both MuMax3 simulations**

Record image/runtime identity, exact input path, and output path. If the host
CUDA lane fails, use the already established managed container route and
record that fact rather than treating host failure as a physics failure.

- [ ] **Step 3: Run both Fullmag scenarios**

Use the repository `just fullmag` route for the FDM CPU double lane, then locate
the authoritative dynamic `scalars.csv` under the generated bundle.

- [ ] **Step 4: Compare and inspect results**

Run the comparison CLI, inspect row counts and time ranges, and report per
case RMSE, endpoint deltas, crossing times, solver provenance, and any runtime
blocker. Do not claim agreement if either application did not execute or if
the output was truncated.

### Task 6: Final verification

- [ ] Run the focused FDM tests and the existing SP4 contract/metric tests.
- [ ] Run the public documentation/example guard if the physics note changed.
- [ ] Inspect `git status --short` and preserve unrelated dirty changes.
- [ ] Report implementation, tests, actual runtime execution, and comparison
  evidence as separate statuses.
