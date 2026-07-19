# µMAG SP4 User-Scenario Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the parameter-heavy FEM SP4 execution entrypoint with twelve ordinary, directly runnable Fullmag Python scenarios and read-only CSV/PNG postprocessing of their application artifacts.

**Architecture:** Each scenario is a self-contained public `fm.study` script for one NIST field and one explicit-RK timestep policy. The CLI selects strict CPU or GPU; the script declares all physics, mesh, solver, sampling, relaxation, and run values inline. Separate collectors consume normal stage artifacts, append immutable attempt rows to a stable CSV ledger, and create plots without controlling the simulation.

**Tech Stack:** Fullmag Python DSL, ProblemIR export helper, pytest, Python standard-library CSV/JSON, NumPy, Matplotlib, managed MFEM/hypre/libCEED/CUDA runtime through repository `just` recipes.

## Global Constraints

- Tangent-plane and direct minimizers are outside this explicit-RK scenario matrix.
- Scenario scripts must not import `tests.standard_problems` helpers or read solver parameters from environment variables.
- Every scenario must use `study.tableautosave(...)` for accepted-state time data and `study.stages.autosave("m", ...)` for dynamic field samples.
- CPU/GPU selection comes from `just fullmag build=True fem cpu|gpu <script>`; scripts request strict FEM `double` with device `auto`.
- The initial relaxation has zero applied field; only the reversal stage contains the selected NIST field.
- Runtime artifacts are immutable inputs to postprocessing; collection never rewrites them.
- `results.csv` is append-only and has one row per attempt ID.
- No commit, push, or staging is performed unless the user requests it.

---

### Task 1: Lock the plain-script scenario contract test-first

**Files:**
- Create: `tests/standard_problems/mumag/sp4/fem/test_scenarios.py`
- Create: `tests/standard_problems/mumag/sp4/fem/scenarios/__init__.py`

**Interfaces:**
- Produces: `SCENARIOS`, the exact twelve-path manifest used by structural and ProblemIR tests.

- [ ] **Step 1: Write the failing manifest and AST tests**

Require the six policies for both `case_a` and `case_b`. Parse every file with
`ast.parse` and reject `os.environ`, helper imports, top-level functions,
`SP4RunRequest`, and imports from `tests.standard_problems`.

- [ ] **Step 2: Run RED**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src:. python3 -m pytest tests/standard_problems/mumag/sp4/fem/test_scenarios.py -q
```

Expected: fail because the twelve scenario files do not exist.

- [ ] **Step 3: Add only the empty package marker and rerun RED**

Expected: the same missing-file assertions fail, proving the test is not failing
because of Python package discovery.

---

### Task 2: Add twelve direct Fullmag scenarios

**Files:**
- Create: `tests/standard_problems/mumag/sp4/fem/scenarios/case_a_heun_fixed.py`
- Create: `tests/standard_problems/mumag/sp4/fem/scenarios/case_b_heun_fixed.py`
- Create: `tests/standard_problems/mumag/sp4/fem/scenarios/case_a_rk23_fixed.py`
- Create: `tests/standard_problems/mumag/sp4/fem/scenarios/case_b_rk23_fixed.py`
- Create: `tests/standard_problems/mumag/sp4/fem/scenarios/case_a_rk4_fixed.py`
- Create: `tests/standard_problems/mumag/sp4/fem/scenarios/case_b_rk4_fixed.py`
- Create: `tests/standard_problems/mumag/sp4/fem/scenarios/case_a_rk45_fixed.py`
- Create: `tests/standard_problems/mumag/sp4/fem/scenarios/case_b_rk45_fixed.py`
- Create: `tests/standard_problems/mumag/sp4/fem/scenarios/case_a_rk23_adaptive.py`
- Create: `tests/standard_problems/mumag/sp4/fem/scenarios/case_b_rk23_adaptive.py`
- Create: `tests/standard_problems/mumag/sp4/fem/scenarios/case_a_rk45_adaptive.py`
- Create: `tests/standard_problems/mumag/sp4/fem/scenarios/case_b_rk45_adaptive.py`

**Interfaces:**
- Produces: ordered stages `relax`, `autosave-m`, `reversal` through the public DSL.

- [ ] **Step 1: Implement the shared visible physical declaration in every file**

Each script directly declares the `500e-9 x 125e-9 x 3e-9` film, Permalloy
constants, normalized `(1, 0.1, 0)` start, baseline manual airbox, three-layer
P1 thin-film intent, Poisson-Robin demag, `CG+AMG` with `rtol=1e-12`, strict
FEM `double`, and canonical table columns.

- [ ] **Step 2: Implement fixed policies**

Use `dt=2e-13` in `add_relax` and `fix_dt=2e-13` in `study.solver` for
`heun`, `rk23`, `rk4`, and `rk45`.

- [ ] **Step 3: Implement adaptive policies**

Use `dt_initial=1e-15`, `dt_min=1e-17`, `dt_max=2e-13`, and
`max_err=1e-7` for `rk23` and `rk45` in relaxation and dynamics.

- [ ] **Step 4: Apply the field only after relaxation**

Case A uses `(-24.6e-3, 4.3e-3, 0.0)` T and case B uses
`(-35.5e-3, -6.3e-3, 0.0)` T. Add `m` autosave at `1e-12 s`, then run to
`5e-9 s`.

- [ ] **Step 5: Run GREEN for structural tests**

Run the Task 1 command. Expected: all structural tests pass.

---

### Task 3: Verify every scenario through public ProblemIR export

**Files:**
- Modify: `tests/standard_problems/mumag/sp4/fem/test_scenarios.py`

**Interfaces:**
- Consumes: twelve scripts.
- Produces: fail-closed assertions over exported stage IR.

- [ ] **Step 1: Add failing ProblemIR assertions**

For every script call `runtime_helper.main(["export-run-config", "--script",
path, "--backend", "fem", "--mode", "strict", "--precision", "double",
"--skip-geometry-assets"])`. Require three stages, zero Zeeman term in
relaxation, the correct Zeeman field in reversal, correct integrator and
fixed/adaptive policy, table columns, field autosave, P1 FEM, and strict
double runtime intent.

- [ ] **Step 2: Run RED and correct only scenario declarations**

Expected: any mismatch identifies a public-authoring defect in a concrete
scenario rather than being hidden by a generator.

- [ ] **Step 3: Run GREEN**

Run the Task 1 command. Expected: all twelve exported pipelines pass.

---

### Task 4: Add append-only application-result collection

**Files:**
- Create: `tests/standard_problems/mumag/sp4/fem/collect_results.py`
- Create: `tests/standard_problems/mumag/sp4/fem/test_collect_results.py`

**Interfaces:**
- Produces: `collect_attempt(artifacts: Path, ledger: Path, *, scenario: str, attempt_id: str) -> dict[str, object]`.

- [ ] **Step 1: Write RED tests**

Synthetic application artifacts must yield one stable CSV row. A second
attempt appends a row; reusing an attempt ID raises an error; missing metadata,
required scalar columns, nonfinite values, or nonmonotone dynamic time fail
closed without modifying the ledger.

- [ ] **Step 2: Implement the minimum collector**

Use `csv.DictReader`/`DictWriter`, atomic replacement of a temporary file, and
a fixed schema. Read scenario facts from metadata and stage artifacts where
available; explicit CLI arguments identify only the script and attempt, not
physics.

- [ ] **Step 3: Run GREEN**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src:. python3 -m pytest tests/standard_problems/mumag/sp4/fem/test_collect_results.py -q
```

Expected: all collector tests pass.

---

### Task 5: Generate deterministic PNG diagnostics from the ledger

**Files:**
- Create: `tests/standard_problems/mumag/sp4/fem/plot_results.py`
- Create: `tests/standard_problems/mumag/sp4/fem/test_plot_results.py`

**Interfaces:**
- Produces: `plot_ledger(ledger: Path, output_dir: Path) -> tuple[Path, ...]`.

- [ ] **Step 1: Write RED tests using a small ledger fixture**

Require non-empty PNGs for crossing time, trajectory error, final torque, and
wall time grouped by scenario and device. Axis labels must include units and
NIST data must be labelled as a reference band, not an exact FEM value.

- [ ] **Step 2: Implement focused Matplotlib plotting**

Use the noninteractive `Agg` backend, deterministic filenames, bounded figure
sizes, and close every figure.

- [ ] **Step 3: Run GREEN**

Run the focused plotting tests and verify PNG signatures and sizes.

---

### Task 6: Wire managed repeatable execution without changing scripts

**Files:**
- Modify: `justfile`
- Create: `scripts/run_fem_sp4_scenario.sh`
- Modify: `scripts/test_fem_standard_problem_4_runtime_targets.py`
- Modify: `tests/standard_problems/mumag/sp4/README.md`

**Interfaces:**
- Produces: `just fem-sp4-scenario cpu|gpu <script> <output-dir>` and documented interactive `just fullmag` commands.

- [ ] **Step 1: Write failing recipe-contract tests**

Require managed runtime setup, explicit CPU/GPU selection, strict failure on
unsupported device, exact script path forwarding, output directory forwarding,
and post-run ledger collection.

- [ ] **Step 2: Implement the narrow managed wrapper**

The wrapper may choose device, output directory, and attempt ID. It must not
set field, integrator, timestep, mesh, airbox, tolerance, or duration.

- [ ] **Step 3: Verify shell syntax and static contracts**

Run `bash -n`, focused pytest, `just --summary`, and `git diff --check`.

---

### Task 7: Managed application smoke and qualification handoff

**Files:**
- Runtime outputs only unless a reproduced defect requires a test-first fix in its owner.

**Interfaces:**
- Produces: fresh CPU/GPU application artifacts and initial ledger rows.

- [ ] **Step 1: Run public export tests and native prerequisite**

Run the complete SP4 Python tests and `just verify-fem-time-domain-native-contract`.

- [ ] **Step 2: Run one short managed application smoke per device**

Use the repository-managed runtime path and a dedicated smoke scenario. Do not
edit a production scenario to shorten it and do not call the smoke
`physics_validated`.

- [ ] **Step 3: Execute baseline scenarios incrementally**

Run each concrete script, append its artifact metrics, regenerate PNGs, and
retain failed attempts in the ledger. Diagnose failures by mesh/demag,
relaxation, integrator, runtime, or artifact owner before changing algorithms.

- [ ] **Step 4: Continue with concrete convergence scripts**

Add fixed-`dt`, adaptive-tolerance, frozen-mesh airbox, and mesh-resolution
variants as separate user-readable files when their execution begins. Full
NIST qualification remains the completion gate from the parent plan.
