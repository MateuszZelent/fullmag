from pathlib import Path

import fullmag as fm
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime.script_builder import (
    export_builder_draft,
    render_scene_document_as_script,
    rewrite_loaded_problem_script,
)


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


def test_scene_document_preserves_declared_bias_field_sweep_order() -> None:
    builder = {
        "stages": [
            {
                "kind": "eigenmodes",
                "bias_field_sweep": {
                    "samples_a_per_m": [
                        [12_500.0, 0.0, 0.0],
                        [25_000.0, 0.0, 0.0],
                        [50_000.0, 0.0, 0.0],
                    ],
                    "equilibrium_policy": "continuation",
                    "ordering": "declared",
                    "continuation_seed": "previous_accepted_equilibrium",
                },
            }
        ]
    }

    scene = build_scene_document_from_builder(builder)
    rebuilt = build_builder_from_scene_document(scene)

    assert rebuilt["stages"][0]["bias_field_sweep"] == builder["stages"][0]["bias_field_sweep"]


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


def test_public_gpu_round_trips_through_scene_document_without_legacy_cuda_alias(
    tmp_path: Path,
) -> None:
    source = tmp_path / "public_gpu.py"
    source.write_text(
        """import fullmag as fm
study = fm.study('public_gpu')
study.engine('fem')
study.device('gpu', precision='double')
body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name='film')
body.Ms = 800e3
body.Aex = 13e-12
body.m = fm.texture.uniform(1, 0, 0)
""",
        encoding="utf-8",
    )
    loaded = fm.load_problem_from_script(source, lightweight_assets=True)

    runtime = loaded.problem.to_ir(include_geometry_assets=False)["problem_meta"][
        "runtime_metadata"
    ]["runtime_selection"]
    assert runtime["device"] == "gpu"

    draft = export_builder_draft(loaded)
    assert draft["requested_device"] == "gpu"
    scene = build_scene_document_from_builder(draft)
    assert scene["study"]["requested_device"] == "gpu"

    rendered_scene = render_scene_document_as_script(
        scene,
        include_authored_stages=False,
        include_legacy_relax_stages=False,
    )
    assert 'study.device("gpu", precision="double")' in rendered_scene
    assert "cuda:0" not in rendered_scene

    rendered_source = rewrite_loaded_problem_script(loaded)["rendered_source"]
    assert 'study.device("gpu", precision="double")' in rendered_source

    legacy_source = tmp_path / "legacy_cuda.py"
    legacy_source.write_text(
        source.read_text(encoding="utf-8").replace(
            "study.device('gpu', precision='double')",
            "study.device('cuda:0', precision='double')",
        ),
        encoding="utf-8",
    )
    legacy_loaded = fm.load_problem_from_script(legacy_source, lightweight_assets=True)
    legacy_runtime = legacy_loaded.problem.to_ir(include_geometry_assets=False)[
        "problem_meta"
    ]["runtime_metadata"]["runtime_selection"]
    assert legacy_runtime["device"] == "cuda"
    legacy_rendered = rewrite_loaded_problem_script(legacy_loaded)["rendered_source"]
    assert 'study.device("cuda:0", precision="double")' in legacy_rendered


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

def test_scene_round_trip_preserves_authored_global_mesh_order(tmp_path: Path) -> None:
    from fullmag.runtime.loader import load_problem_from_script

    for order in (None, 1, 2):
        order_arg = "" if order is None else f", order={order}"
        source = tmp_path / f"mesh_order_{order}.py"
        source.write_text(
            "import fullmag as fm\n"
            "study = fm.study('mesh-order-roundtrip')\n"
            "study.engine('fem')\n"
            f"study.objects.mesh.defaults(maximum_element_size=20e-9{order_arg})\n"
            "film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name='film')\n"
            "film.Ms = 800e3\n"
            "film.Aex = 13e-12\n"
            "study.stages.add_run(stage_id='run', until=1e-12)\n",
            encoding="utf-8",
        )
        loaded = load_problem_from_script(source, lightweight_assets=True)
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        assert builder_overrides_from_scene_document(scene)["mesh"]["order"] == order
        exported = tmp_path / f"exported_mesh_order_{order}.py"
        exported.write_text(render_scene_document_as_script(scene), encoding="utf-8")
        reloaded = load_problem_from_script(exported, lightweight_assets=True)
        rebuilt = build_scene_document_from_builder(export_builder_draft(reloaded))
        assert builder_overrides_from_scene_document(rebuilt)["mesh"]["order"] == order
