"""relax(relax_alpha=...) damps the relax stage only; later stages keep each element's alpha."""

import textwrap

import pytest

from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import (
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime.script_builder import (
    export_builder_draft,
    export_study_pipeline_document,
    render_loaded_problem_as_script,
    render_scene_document_as_script,
)

SCRIPT = """
import fullmag as fm

study = fm.study("relax_alpha")
study.engine("fdm")
study.device("cpu", precision="double")
study.universe(mode="manual", size=(16e-9, 4e-9, 2e-9), center=(0.0, 0.0, 0.0))
study.cell(2e-9, 2e-9, 2e-9)
left = study.geometry(
    fm.Translate(fm.Box(size=(6e-9, 4e-9, 2e-9)), (-4e-9, 0.0, 0.0)), name="left"
)
left.Ms = 800e3
left.Aex = 13e-12
left.alpha = 0.01
left.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
right = study.geometry(
    fm.Translate(fm.Box(size=(6e-9, 4e-9, 2e-9)), (4e-9, 0.0, 0.0)), name="right"
)
right.Ms = 800e3
right.Aex = 13e-12
right.alpha = 0.05
right.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.solver(integrator="rk45", fix_dt=1e-13)
fm.relax(tolT=1e-5, max_steps=1000)
fm.run(1e-12)
"""


def _alphas(problem) -> dict[str, float]:
    return {magnet.name: magnet.material.alpha for magnet in problem.magnets}


def test_relax_alpha_applies_to_the_relax_stage_only(tmp_path):
    script = tmp_path / "relax_alpha.py"
    script.write_text(textwrap.dedent(SCRIPT), encoding="utf-8")
    loaded = load_problem_from_script(script)

    relax, run = loaded.stages
    assert _alphas(relax.problem) == {"left": 1.0, "right": 1.0}
    assert _alphas(run.problem) == {"left": 0.01, "right": 0.05}
    assert _alphas(loaded.pipeline_base_problem()) == {"left": 0.01, "right": 0.05}

    document = export_study_pipeline_document(loaded)
    assert document is not None
    payloads = {node["stage_kind"]: node["payload"] for node in document["nodes"]}
    assert payloads["relax"]["relax_alpha"] == "1"
    assert "relax_alpha" not in payloads["run"]


@pytest.mark.parametrize("render_path", ["scene", "loaded"])
@pytest.mark.parametrize(
    ("relax_arguments", "expected_alpha", "rendered_argument"),
    [
        ('relax_alpha=0.3, solver="rk45", dt=1e-13, ', 0.3, "relax_alpha=0.3"),
        (
            'relax_alpha=0.123456789012345, solver="rk45", dt=1e-13, ',
            0.123456789012345,
            "relax_alpha=0.123456789012345",
        ),
        (
            'relax_alpha=1.0000000000000002, solver="rk45", dt=1e-13, ',
            1.0000000000000002,
            "relax_alpha=1.0000000000000002",
        ),
        ('relax_alpha=1.0, solver="rk45", dt=1e-13, ', 1.0, None),
        ('solver="rk45", dt=1e-13, ', 1.0, None),
        ('relax_alpha=None, solver="rk45", dt=1e-13, ', None, "relax_alpha=None"),
    ],
    ids=["custom", "precise", "near-default", "explicit-default", "default", "material"],
)
def test_relax_alpha_survives_script_roundtrip(
    tmp_path, render_path, relax_arguments, expected_alpha, rendered_argument
):
    source = tmp_path / "source.py"
    source.write_text(
        textwrap.dedent(SCRIPT).replace("fm.relax(", f"fm.relax({relax_arguments}"),
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source)
    authored_alphas = {"left": 0.01, "right": 0.05}
    relax_alphas = (
        authored_alphas
        if expected_alpha is None
        else {"left": expected_alpha, "right": expected_alpha}
    )
    assert _alphas(loaded.stages[0].problem) == relax_alphas

    if render_path == "scene":
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        overrides = builder_overrides_from_scene_document(scene)
        assert overrides["stages"][0]["relax_alpha"] == expected_alpha
        rendered = render_scene_document_as_script(scene)
    else:
        rendered = render_loaded_problem_as_script(loaded)

    target = tmp_path / "rendered.py"
    target.write_text(rendered, encoding="utf-8")
    reloaded = load_problem_from_script(target)
    relax, run = reloaded.stages
    assert _alphas(relax.problem) == relax_alphas
    assert _alphas(run.problem) == authored_alphas
    assert _alphas(reloaded.pipeline_base_problem()) == authored_alphas
    relax_line = next(
        line for line in rendered.splitlines() if line.startswith("study.stages.add_relax(")
    )
    if rendered_argument is None:
        assert "relax_alpha" not in relax_line
    else:
        assert rendered_argument in relax_line


@pytest.mark.parametrize("render_path", ["scene", "loaded"])
@pytest.mark.parametrize("material_alpha, relax_alpha", [(0.02, 0.02), (0.02, None), (0.0, None)])
def test_uniform_material_damping_survives_script_roundtrip(
    tmp_path, render_path, material_alpha, relax_alpha
):
    source = tmp_path / "source.py"
    source.write_text(
        textwrap.dedent(SCRIPT)
        .replace("left.alpha = 0.01", f"left.alpha = {material_alpha!r}")
        .replace("right.alpha = 0.05", f"right.alpha = {material_alpha!r}")
        .replace(
            "fm.relax(",
            f'fm.relax(relax_alpha={relax_alpha!r}, solver="rk45", dt=1e-13, ',
        ),
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source)
    if render_path == "scene":
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        rendered = render_scene_document_as_script(scene)
    else:
        rendered = render_loaded_problem_as_script(loaded)
    target = tmp_path / "rendered.py"
    target.write_text(rendered, encoding="utf-8")
    reloaded = load_problem_from_script(target)
    expected = {"left": material_alpha, "right": material_alpha}
    assert _alphas(reloaded.stages[0].problem) == expected
    assert _alphas(reloaded.stages[1].problem) == expected
    assert _alphas(reloaded.pipeline_base_problem()) == expected
    document = export_study_pipeline_document(reloaded)
    assert document is not None
    assert document["nodes"][0]["payload"].get("relax_alpha") is None


@pytest.mark.parametrize("algorithm", ["projected_gradient_bb", "nonlinear_cg"])
def test_canonical_minimizer_does_not_emit_relax_alpha(tmp_path, algorithm):
    source = tmp_path / "minimizer.py"
    source.write_text(
        textwrap.dedent(SCRIPT).replace("fm.relax(", f"fm.relax(algorithm={algorithm!r}, "),
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source)
    rendered = render_loaded_problem_as_script(loaded)
    assert "relax_alpha" not in next(
        line for line in rendered.splitlines() if line.startswith("study.stages.add_relax(")
    )


def test_canonical_algorithm_override_uses_default_relax_alpha(tmp_path):
    source = tmp_path / "minimizer.py"
    source.write_text(
        textwrap.dedent(SCRIPT).replace(
            "fm.relax(", 'fm.relax(algorithm="projected_gradient_bb", '
        ),
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source)
    rendered = render_loaded_problem_as_script(
        loaded,
        overrides={
            "stages": [
                {
                    "relax_algorithm": "llg_overdamped",
                    "integrator": "rk45",
                    "fixed_timestep": 1e-13,
                }
            ]
        },
    )
    target = tmp_path / "rendered.py"
    target.write_text(rendered, encoding="utf-8")
    relax, run = load_problem_from_script(target).stages
    assert _alphas(relax.problem) == {"left": 1.0, "right": 1.0}
    assert _alphas(run.problem) == {"left": 0.01, "right": 0.05}
    assert "relax_alpha" not in next(
        line for line in rendered.splitlines() if line.startswith("study.stages.add_relax(")
    )
