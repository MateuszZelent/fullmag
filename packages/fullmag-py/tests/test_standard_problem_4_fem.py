from pathlib import Path

import fullmag as fm


REPO_ROOT = Path(__file__).resolve().parents[3]
SP4_SCRIPT = REPO_ROOT / "tests/standard_problems/mumag/sp4/fem/problem.py"


def test_sp4_requests_qualified_demag_linear_solver_policy(monkeypatch):
    monkeypatch.setenv("FULLMAG_SP4_PHASE", "relax")
    monkeypatch.setenv("FULLMAG_SP4_DEVICE", "cpu")
    monkeypatch.setenv("FULLMAG_SP4_MESH", "coarse")
    monkeypatch.setenv("FULLMAG_SP4_AIRBOX", "baseline")
    monkeypatch.setenv("FULLMAG_SP4_RELAX_MAX_STEPS", "1")

    loaded = fm.load_problem_from_script(SP4_SCRIPT, lightweight_assets=True)
    problem = loaded.stages[0].problem
    policy = problem.discretization.fem.demag_solver_policy

    assert policy is not None
    assert policy.solver == "CG"
    assert policy.preconditioner == "AMG"
    assert policy.rtol == 1e-12
    assert policy.max_iterations == 500


def test_sp4_relaxation_uses_accepted_step_table_autosave(monkeypatch):
    monkeypatch.setenv("FULLMAG_SP4_PHASE", "relax")
    monkeypatch.setenv("FULLMAG_SP4_DEVICE", "cpu")
    monkeypatch.setenv("FULLMAG_SP4_MESH", "coarse")
    monkeypatch.setenv("FULLMAG_SP4_AIRBOX", "baseline")
    monkeypatch.setenv("FULLMAG_SP4_RELAX_MAX_STEPS", "1")

    loaded = fm.load_problem_from_script(SP4_SCRIPT, lightweight_assets=True)
    [stage] = loaded.stages

    assert stage.table_autosave is not None
    assert stage.table_autosave.every_steps == 10
    assert stage.table_autosave.t_sampl is None
    assert stage.problem.study.to_ir()["sampling"].get("table_autosave") is None
