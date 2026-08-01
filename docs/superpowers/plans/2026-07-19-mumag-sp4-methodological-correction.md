# µMAG SP4 FEM Methodological Correction Implementation Plan

> **For agentic workers:** Execute inline in this shared checkout; do not stage,
> commit, reset, or rewrite unrelated changes. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Separate S-state relaxation qualification from physical-time solver
qualification and make the FEM SP4 scripts, ledger, plots, and managed NIST
gate fail closed on unstable relaxation or non-equivalent initial states.

**Architecture:** Ordinary user scripts remain self-contained. Dynamics
scripts use one MuMax-inspired adaptive-RK23 relaxation stage independent of
the named reversal solver, while standalone relaxation scripts cover that
reference, PG-BB, NCG, and the stable/timestep-convergence matrix of overdamped
LLG. The managed qualification runs all relaxation families and selects a
content-addressed state only after cross-algorithm gates, then gives that
identical state to every CPU/GPU dynamics run.

**Tech Stack:** Fullmag Python DSL and ProblemIR export, pytest, CSV/JSON,
NumPy, Matplotlib, Bash, and container-backed managed FEM `just` recipes.

## Global Constraints

- NIST requires a zero-field equilibrium S-state, full normalized mean-
  magnetization trajectories, the first `mx=0` magnetization image, and
  discretization independence.
- Dynamics comparison cannot include solver-specific relaxation error.
- Audited MuMax3 `Relax()` forces adaptive Bogacki--Shampine RK23,
  `FixDt=0`, and no precession, then restores the selected dynamics solver;
  fixed `dt` selected for dynamics never controls MuMax3 relaxation.
- `projected_gradient_bb` and `nonlinear_cg` have no RK, `dt`, damping
  override, or physical/pseudo-time controls.
- `llg_overdamped` is qualified at fixed `dt={2e-13,1e-13,5e-14,2e-14,1e-14}`
  and with adaptive RK23/RK45 capped at `1e-14 s`.
- The plain dynamics baseline uses fixed `dt=2e-13 s` or adaptive
  `dt_initial=1e-15`, `dt_min=1e-17`, `dt_max=2e-13`, `max_err=1e-7`;
  temporal convergence remains a separate dynamics-only sweep.
- A relaxation passes only with finite artifacts, accepted-state energy
  descent within the declared numerical budget, `converged=true`, and fresh
  `max_torque_T <= 1e-5 T`.
- Strict FEM CPU/GPU double and no-fallback provenance remain mandatory.
- No backend equations or public API are changed by this correction.

---

### Task 1: Freeze the corrected physics and design contract

**Files:**
- Modify: `docs/physics/0980-mumag-standard-problem-4-fem-application-validation.md`
- Modify: `docs/superpowers/specs/2026-07-18-mumag-standard-problem-4-fem-validation-design.md`
- Modify: `docs/superpowers/plans/2026-07-19-mumag-sp4-user-scenario-scripts.md`

- [x] Describe independent relaxation and dynamics axes.
- [x] Audit MuMax3 `Relax()`, `Minimize()`, timestep adaptation, and its SP4
  RK56 regression at the pinned upstream revision.
- [x] Record exact algorithm/timestep matrices and canonical-state selection.
- [x] Remove the requirement that one RK policy controls both phases.

### Task 2: Lock the scenario methodology with RED tests

**Files:**
- Modify: `tests/standard_problems/mumag/sp4/fem/test_scenarios.py`

- [x] Add the exact standalone relaxation manifest:
  `relax_projected_gradient_bb`, `relax_nonlinear_cg`, five RK45 fixed-dt
  levels, stable Heun/RK23/RK4 fixed, and RK23/RK45 adaptive.
- [x] Require every dynamics relaxation IR to use the same adaptive RK23,
  `dt_max=1e-14 s`, and no Zeeman term, independently of reversal RK.
- [x] Require direct-minimizer scripts to contain no `study.solver` call and
  LLG-only scripts to contain no reversal run.
- [x] Require fixed dynamics `2e-13 s` and adaptive `dt_max=2e-13 s`.
- [x] Run:

```bash
PYTHONPATH=packages/fullmag-py/src:. python3 -m pytest \
  tests/standard_problems/mumag/sp4/fem/test_scenarios.py -q
```

Expected RED: missing relaxation scripts and solver-coupled dynamics
preparation are reported explicitly.

### Task 3: Implement ordinary corrected scenario scripts

**Files:**
- Modify: `tests/standard_problems/mumag/sp4/fem/scenarios/case_*.py`
- Create: `tests/standard_problems/mumag/sp4/fem/scenarios/relax_*.py`
- Modify: `tests/standard_problems/mumag/sp4/README.md`

- [x] Replace every dynamics relaxation stage with the same explicit
  MuMax-inspired policy:

```python
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk23",
    dt_initial=1e-15,
    dt_min=1e-17,
    dt_max=1e-14,
    max_err=1e-7,
    relax_alpha=1.0,
    max_steps=50_000,
    tol=7.957747154594767,
)
```

- [x] Restore dynamics-only `fix_dt=2e-13` and adaptive `dt_max=2e-13`; do not
  infer a physical-time step from relaxation stability.
- [x] Add standalone direct-minimizer scripts without solver/time fields.
- [x] Add standalone LLG scripts with their full fixed/adaptive policy only on
  `add_relax`.
- [x] Keep table autosave columns `step,t,dt,mx,my,mz,e_ex,e_demag,e_ext,
  e_total,max_torque_T` and save `m` for the final relaxed state.
- [x] Re-run Task 2 and require GREEN.

### Task 4: Make the append-only ledger phase-aware

**Files:**
- Modify: `tests/standard_problems/mumag/sp4/fem/test_collect_results.py`
- Modify: `tests/standard_problems/mumag/sp4/fem/collect_results.py`

- [x] Write RED fixtures for relaxation rows without `mx=0`, including
  algorithm, applicable RK/timestep policy, convergence, initial/final energy,
  maximum accepted energy increase, final torque, and artifact hashes.
- [x] Preserve NIST trajectory metrics for dynamics rows and leave
  inapplicable relaxation/dynamics columns empty.
- [x] Reject nonfinite energy, non-converged completion, torque above `1e-5 T`,
  or energy growth beyond `1e-10 * max(|E|,1e-30)` without modifying the CSV.
- [x] Run focused collector tests to GREEN.

### Task 5: Separate relaxation and NIST plots

**Files:**
- Modify: `tests/standard_problems/mumag/sp4/fem/test_plot_results.py`
- Modify: `tests/standard_problems/mumag/sp4/fem/plot_results.py`

- [x] Add RED assertions for `relaxation_torque_vs_policy.png` with the
  `1e-5 T` acceptance line and `relaxation_energy_drop_J.png`.
- [x] Keep crossing, trajectory-envelope, dynamics torque, and wall-time plots
  restricted to rows where `phase=dynamics`.
- [x] Render relaxation plots only from `phase=relaxation` and close every
  Matplotlib figure.
- [x] Run focused plotting tests to GREEN.

### Task 6: Correct managed S-state qualification and reuse

**Files:**
- Modify: `tests/standard_problems/mumag/sp4/common/contract.py`
- Modify: `tests/standard_problems/mumag/sp4/fem/problem.py`
- Modify: `scripts/check_fem_sp4_relaxation.py`
- Modify: `scripts/verify_fem_standard_problem_4.sh`
- Modify: `tests/standard_problems/mumag/sp4/fem/verify.py`
- Modify: `tests/standard_problems/mumag/sp4/fem/test_contract.py`
- Modify: `tests/standard_problems/mumag/sp4/fem/test_relaxation_ready.py`

- [x] Define the three production relaxation algorithms and fail-closed
  canonical-state selection in the shared contract.
- [x] Set LLG relaxation `dt_max=1e-14 s`; direct minimizers receive no time
  controls.
- [x] Run PG-BB, NCG, and stable LLG on both devices for each required
  mesh/airbox; store each under an algorithm/device-specific artifact root.
- [x] Extend readiness to require converged completion, torque, finite energy,
  and accepted-tail descent.
- [x] Compare algorithm endpoints and select the adaptive-RK23 reference only
  after cross-algorithm S-state gates pass; do not fall back silently if it
  fails.
- [x] Store its SHA-256 in every dynamics run and require content identity plus
  mesh fingerprint identity in the validator.

### Task 7: Verify source contracts and managed execution

**Files:** Runtime artifacts only unless a reproduced defect requires a new
failing test in its owning file.

- [x] Run all SP4 Python tests with the managed Python dependencies and `PYTHONPATH`.
- [x] Run `bash -n` for both SP4 shell scripts and `git diff --check`.
- [x] Run `just verify-fem-time-domain-native-contract`.
- [x] Run `just ensure-managed-fem-runtime`.
- [x] Run the equivalent managed nonqualifying smoke matrix (resumed after the
  outer command timeout) and report it only as execution/artifact evidence.
- [ ] Run `just verify-fem-standard-problem-4`; only its complete zero exit and
  `validation.json status=passed` can promote the exact SP4 FEM scope.
