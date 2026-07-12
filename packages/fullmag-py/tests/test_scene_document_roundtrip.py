from pathlib import Path

import fullmag as fm
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime.script_builder import export_builder_draft, rewrite_loaded_problem_script


def test_scene_document_round_trips_eigenmode_periodic_airbox_k0() -> None:
    builder = {
        "stages": [
            {
                "kind": "eigenmodes",
                "eigen_magnetostatic_bc": "periodic_airbox_k0",
            }
        ]
    }

    scene = build_scene_document_from_builder(builder)
    rebuilt = build_builder_from_scene_document(scene)

    assert rebuilt["stages"][0]["eigen_magnetostatic_bc"] == "periodic_airbox_k0"


def test_scene_document_exports_and_reloads_canonical_k0_problem_ir(tmp_path: Path) -> None:
    source = tmp_path / "k0.py"
    source.write_text(
        """import fullmag as fm
study = fm.study('k0')
study.engine('fem')
study.device('cpu', precision='double')
study.pbc(x=True, y=True, demag='periodic_airbox_k0')
body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name='film')
body.Ms = 800e3
body.Aex = 13e-12
body.m = fm.texture.uniform(1, 0, 0)
study.demag()
study.save('spectrum')
study.stages.add_eigenmodes(target='frequency_window', frequency_min=1e9, frequency_max=2e9, include_demag=True, magnetostatic_bc='periodic_airbox_k0', k_vector=(0.0, 0.0, 0.0), bc=fm.PeriodicBC(['x_faces', 'y_faces']))
""",
        encoding="utf-8",
    )
    loaded = fm.load_problem_from_script(source, lightweight_assets=True)
    draft = export_builder_draft(loaded)
    scene = build_scene_document_from_builder(draft)
    rewritten = rewrite_loaded_problem_script(
        loaded, overrides=builder_overrides_from_scene_document(scene)
    )["rendered_source"]
    exported = tmp_path / "k0_exported.py"
    exported.write_text(rewritten, encoding="utf-8")
    reloaded = fm.load_problem_from_script(exported, lightweight_assets=True)

    assert reloaded.stages[0].problem.to_ir(include_geometry_assets=False)["study"] == loaded.stages[0].problem.to_ir(include_geometry_assets=False)["study"]


def test_k0_requested_cpu_and_gpu_intent_survives_problem_ir(tmp_path: Path) -> None:
    for device in ("cpu", "cuda"):
        source = tmp_path / f"k0_{device}.py"
        source.write_text(
            f"""import fullmag as fm
study = fm.study('k0')
study.engine('fem')
study.device('{device}', precision='double')
study.pbc(x=True, y=True, demag='periodic_airbox_k0')
body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name='film')
body.Ms = 800e3
body.Aex = 13e-12
body.m = fm.texture.uniform(1, 0, 0)
study.demag()
study.save('spectrum')
study.stages.add_eigenmodes(target='frequency_window', frequency_min=1e9, frequency_max=2e9, include_demag=True, magnetostatic_bc='periodic_airbox_k0', k_vector=(0.0, 0.0, 0.0), bc=fm.PeriodicBC(['x_faces', 'y_faces']))
""", encoding="utf-8")
        ir = fm.load_problem_from_script(source, lightweight_assets=True).stages[0].problem.to_ir(include_geometry_assets=False)
        assert ir["backend_policy"]["requested_backend"] == "fem"
        assert ir["backend_policy"]["execution_precision"] == "double"
        assert ir["validation_profile"]["execution_mode"] == "strict"
        assert ir["problem_meta"]["runtime_metadata"]["runtime_selection"]["device"] == device
