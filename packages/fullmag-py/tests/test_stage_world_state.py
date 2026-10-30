"""Script stages keep the b_ext they saw when called, like mumax3 (not the last one)."""

import json
import textwrap

import pytest

from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import (
    export_builder_draft,
    export_study_pipeline_document,
    render_scene_document_as_script,
)

HEADER = """
import fullmag as fm

study = fm.study("stages")
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
study.solver(integrator="rk45", fix_dt=1e-13)
"""


def _pipeline(tmp_path, body: str) -> dict[str, dict[str, object]]:
    script = tmp_path / "stages.py"
    script.write_text(textwrap.dedent(HEADER) + textwrap.dedent(body), encoding="utf-8")
    document = export_study_pipeline_document(load_problem_from_script(script))
    assert document is not None
    return {node["stage_kind"]: node["payload"] for node in document["nodes"]}


def test_relax_before_a_field_sweep_keeps_zero_field(tmp_path):
    # mumax3 example 3: relax() at B=0; the sweep's last b_ext must not leak into it.
    payloads = _pipeline(
        tmp_path,
        """
        fm.relax(tolT=1e-5, max_steps=1000)
        for B in (0.0, 1e-3, 2e-3):
            fm.b_ext(B, 0, 0)
            fm.minimize(tolA=1.0)
            fm.tablesave()
        """,
    )
    assert payloads["relax"]["external_field"] == [0.0, 0.0, 0.0]
    assert "external_field" not in payloads["hysteresis"]


def test_run_keeps_the_field_set_before_it(tmp_path):
    payloads = _pipeline(
        tmp_path,
        """
        fm.b_ext(0.0, 0.0, 5e-3)
        fm.relax(tolT=1e-5, max_steps=1000)
        fm.b_ext(1e-2, 0.0, 0.0)
        fm.run(1e-12)
        fm.b_ext(0.0, 2e-2, 0.0)
        """,
    )
    assert payloads["relax"]["external_field"] == [0.0, 0.0, 5e-3]
    assert payloads["run"]["external_field"] == [1e-2, 0.0, 0.0]


def test_constant_field_adds_no_stage_override(tmp_path):
    payloads = _pipeline(
        tmp_path,
        """
        fm.b_ext(1e-2, 0.0, 0.0)
        fm.relax(tolT=1e-5, max_steps=1000)
        fm.run(1e-12)
        """,
    )
    assert "external_field" not in payloads["relax"]
    assert "external_field" not in payloads["run"]


def test_relax_alpha_is_not_a_material_change(tmp_path):
    payloads = _pipeline(
        tmp_path,
        """
        fm.relax(relax_alpha=1.0, tolT=1e-5, max_steps=1000)
        fm.run(1e-12)
        """,
    )
    assert payloads["relax"]["relax_alpha"] == "1"


def test_relax_alpha_equal_to_the_material_damping_exports_no_override(tmp_path):
    # relax() defaults to relax_alpha=1.0; only a damping that differs travels.
    payloads = _pipeline(tmp_path, "fm.relax(relax_alpha=0.02, tolT=1e-5, max_steps=1000)\n")
    assert "relax_alpha" not in payloads["relax"]
    assert _pipeline(tmp_path, "fm.relax(tolT=1e-5, max_steps=1000)\n")["relax"]["relax_alpha"] == "1"


def test_relax_alpha_survives_the_scene_round_trip(tmp_path):
    script = tmp_path / "stages.py"
    script.write_text(
        textwrap.dedent(HEADER)
        + 'fm.relax(relax_alpha=1.0, solver="rk45", dt=1e-13, tolT=1e-5, max_steps=1000)\n',
        encoding="utf-8",
    )
    loaded = load_problem_from_script(script, lightweight_assets=True)
    scene = json.loads(json.dumps(build_scene_document_from_builder(export_builder_draft(loaded))))
    rendered = tmp_path / "rendered.py"
    rendered.write_text(render_scene_document_as_script(scene), encoding="utf-8")
    reloaded = load_problem_from_script(rendered, lightweight_assets=True)
    (relax,) = reloaded.stages
    assert {magnet.material.alpha for magnet in relax.problem.magnets} == {1.0}


def test_material_change_between_stages_is_rejected(tmp_path):
    with pytest.raises(ValueError, match=r"material parameters of 'film' \(Ms\)"):
        _pipeline(
            tmp_path,
            """
            fm.relax(tolT=1e-5, max_steps=1000)
            film.Ms = 600e3
            fm.run(1e-12)
            """,
        )
