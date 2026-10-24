"""mumax3-style b_ext/minimize/tablesave loops fold into one hysteresis stage."""

import textwrap

import pytest

from fullmag.model.study import Hysteresis, Relaxation
from fullmag.runtime.loader import load_problem_from_script

HEADER = """
import fullmag as fm

study = fm.study("sweep")
study.engine("fdm")
study.device("cpu", precision="double")
study.universe(mode="manual", size=(8e-9, 4e-9, 2e-9), center=(0.0, 0.0, 0.0))
study.cell(2e-9, 2e-9, 2e-9)
film = study.geometry(fm.Box(size=(8e-9, 4e-9, 2e-9), name="film"), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
fm.relax(tolT=1e-5, max_steps=1000)
"""


def _load(tmp_path, body: str):
    script = tmp_path / "sweep.py"
    script.write_text(textwrap.dedent(HEADER) + textwrap.dedent(body), encoding="utf-8")
    return load_problem_from_script(script)


def test_minimize_tablesave_loop_becomes_one_hysteresis_stage(tmp_path):
    loaded = _load(
        tmp_path,
        """
        for B in (0.0, 1e-3, 2e-3, 1e-3, -1e-3):
            fm.b_ext(B, 0, 0)
            fm.minimize(tolA=1.0, max_steps=500)
            fm.tablesave()
        """,
    )
    assert [stage.entrypoint_kind for stage in loaded.stages] == ["flat_relax", "flat_hysteresis"]
    relax, sweep = (stage.problem.study for stage in loaded.stages)
    assert isinstance(relax, Relaxation)
    assert isinstance(sweep, Hysteresis)
    assert sweep.field_values_mT == pytest.approx([0.0, 1.0, 2.0, 1.0, -1.0])
    assert sweep.direction == (1.0, 0.0, 0.0)
    assert sweep.initial_protocol == "as_authored"
    (step,) = sweep.settle_pipeline.steps
    assert step.method == "projected_gradient_bb"
    assert step.torque_tolerance == 1.0
    assert step.max_steps == 500


def test_minimize_without_tablesave_keeps_separate_stages(tmp_path):
    loaded = _load(
        tmp_path,
        """
        fm.b_ext(1e-3, 0, 0)
        fm.minimize(tolA=1.0)
        """,
    )
    assert [stage.entrypoint_kind for stage in loaded.stages] == ["flat_relax", "flat_relax"]


def test_non_collinear_fields_start_a_new_sweep(tmp_path):
    loaded = _load(
        tmp_path,
        """
        for B in ((1e-3, 0, 0), (2e-3, 0, 0), (0, 1e-3, 0)):
            fm.b_ext(*B)
            fm.minimize(tolA=1.0)
            fm.tablesave()
        """,
    )
    kinds = [stage.entrypoint_kind for stage in loaded.stages]
    assert kinds == ["flat_relax", "flat_hysteresis", "flat_hysteresis"]
    assert loaded.stages[2].problem.study.direction == (0.0, 1.0, 0.0)


def test_tablesave_after_relax_is_rejected(tmp_path):
    with pytest.raises(Exception, match="tablesave\\(\\) is supported after minimize\\(\\) only"):
        _load(tmp_path, "fm.tablesave()\n")
