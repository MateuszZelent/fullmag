"""relax(relax_alpha=...) damps the relax stage only; later stages keep each element's alpha."""

import textwrap

from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.script_builder import export_study_pipeline_document

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
