from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from fullmag import load_problem_from_script
from fullmag.runtime.scene_document import (
    build_scene_document_from_builder,
    build_builder_from_scene_document,
)
from fullmag.runtime.script_builder import export_builder_draft


def _builder(*, backend: str) -> dict[str, object]:
    builder: dict[str, object] = {
        "revision": 4,
        "backend": backend,
        "requested_mode": "strict",
        "exchange_enabled": True,
        "demag_enabled": True,
        "demag_realization": "auto",
        "solver": {
            "integrator": "rk45",
            "fixed_timestep": "1e-13",
            "relax_algorithm": "llg_overdamped",
            "torque_tolerance": "1e-4",
            "max_relax_steps": "1000",
        },
        "geometries": [
            {
                "object_id": "x-ferromagnet-id",
                "name": "x-ferromagnet",
                "geometry_kind": "Box",
                "geometry_params": {
                    "size": [120e-9, 40e-9, 8e-9],
                    "translation": [10e-9, 0.0, 0.0],
                },
                "material": {"Ms": 800e3, "Aex": 13e-12, "alpha": 0.02},
                "magnetization": {
                    "kind": "preset_texture",
                    "preset_kind": "uniform",
                    "preset_params": {"direction": [1.0, 0.0, 0.0]},
                    "preset_version": 1,
                },
                "physics_stack": [
                    {"kind": "exchange", "enabled": True},
                    {"kind": "demag", "enabled": True},
                ],
            }
        ],
        "stages": [
            {
                "stage_id": "relax",
                "kind": "relax",
                "algorithm": "llg_overdamped",
                "max_steps": 100,
                "torque_tolerance": 1e-4,
            }
        ],
    }
    if backend == "fdm":
        builder["fdm"] = {
            "default_cell": [4e-9, 4e-9, 4e-9],
            "per_magnet": {"x-ferromagnet": {"cell": [2e-9, 2e-9, 2e-9]}},
        }
    else:
        builder["mesh"] = {"maximum_element_size": "8e-9", "order": 1}
        builder["universe"] = {"kind": "airbox", "padding": [20e-9, 20e-9, 20e-9]}
    return builder


def _semantic_scene(scene: dict[str, object]) -> dict[str, object]:
    def number(value: object) -> object:
        if value in (None, ""):
            return None
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
        if isinstance(value, str) and value:
            try:
                return float(value)
            except ValueError:
                return value
        return value

    object_entry = scene["objects"][0]
    study = scene["study"]
    geometry = object_entry["geometry"]
    geometry = {
        key: value
        for key, value in geometry.items()
        if key not in {"bounds_min", "bounds_max"}
    }
    material = {
        key: value
        for key, value in scene["materials"][0]["properties"].items()
        if value is not None
    }
    texture = {
        key: value
        for key, value in scene["magnetization_assets"][0].items()
        if key != "preset_version"
    }
    fdm = study.get("fdm")
    if isinstance(fdm, dict):
        fdm = {
            key: fdm.get(key)
            for key in ("default_cell", "per_magnet")
        }
    shared_domain_mesh = study.get("shared_domain_mesh")
    if isinstance(shared_domain_mesh, dict):
        normalized_mesh = {
            "maximum_element_size": number(shared_domain_mesh.get("maximum_element_size")),
            "order": int(shared_domain_mesh["order"])
            if shared_domain_mesh.get("order") is not None
            else None,
        }
        shared_domain_mesh = (
            normalized_mesh
            if any(value is not None for value in normalized_mesh.values())
            else {}
        )
    stages = []
    for stage in study.get("stages") or []:
        stages.append(
            {
                key: (
                    int(stage[key])
                    if key == "max_steps" and stage.get(key) is not None
                    else number(stage.get(key))
                    if key == "torque_tolerance"
                    else stage.get(key)
                )
                for key in (
                    "stage_id",
                    "kind",
                    "algorithm",
                    "max_steps",
                    "torque_tolerance",
                )
            }
        )
    return {
        "version": scene["version"],
        "object": {
            "id": object_entry["id"],
            "name": object_entry["name"],
            "geometry": geometry,
            "material_ref": object_entry["material_ref"],
            "magnetization_ref": object_entry["magnetization_ref"],
        },
        "material": material,
        "texture": texture,
        "study": {
            "backend": study.get("backend"),
            "fdm": fdm,
            "shared_domain_mesh": shared_domain_mesh,
            "stages": stages,
        },
    }


@pytest.mark.parametrize("backend", ["fdm", "fem"])
def test_scene_document_exports_without_a_base_script(backend: str) -> None:
    from fullmag.runtime.script_builder import render_scene_document_as_script

    scene = build_scene_document_from_builder(_builder(backend=backend))
    with TemporaryDirectory() as temporary:
        source = render_scene_document_as_script(scene)
        assert "import fullmag as fm" in source
        assert "x-ferromagnet" in source
        assert "study.exchange(" not in source
        assert "study.demag(" not in source
        assert "enabled=True" not in source
        if backend == "fdm":
            assert "study.fdm(" not in source
            assert "study.objects.mesh.defaults(cell_size=" in source
            assert ".mesh(cell_size=" in source
        script = Path(temporary) / f"{backend}.py"
        script.write_text(source, encoding="utf-8")
        loaded = load_problem_from_script(script, lightweight_assets=True)
        draft = export_builder_draft(loaded)
        assert draft["exchange_enabled"] is True
        assert draft["demag_enabled"] is True
        round_tripped = build_scene_document_from_builder(draft)

    assert _semantic_scene(round_tripped) == _semantic_scene(scene)


def test_scene_document_renders_eigenmodes_stage_with_nonzero_k_and_floquet_bc() -> None:
    from fullmag.runtime.script_builder import render_scene_document_as_script

    builder = _builder(backend="fem")
    builder["stages"].append(
        {
            "kind": "eigenmodes",
            "eigen_count": 4,
            "eigen_target": "nearest",
            "eigen_target_frequency": 11e9,
            "eigen_operator": "full_2x2",
            "eigen_include_demag": True,
            "eigen_equilibrium_source": "relax",
            "eigen_normalization": "unit_l2",
            "eigen_damping_policy": "ignore",
            "eigen_k_vector": "10000000.0,0.0,0.0",
            "eigen_spin_wave_bc": "floquet",
            "eigen_spin_wave_bc_config": {
                "kind": "floquet",
                "pair_ids": ["x_faces"],
                "phase_convention": "exp_plus_i_k_dot_delta_r",
            },
            "eigen_magnetostatic_bc": "floquet_airbox",
            "eigen_solver_rtol": 1e-8,
            "eigen_solver_max_outer_iterations": 123,
            "eigen_solver_max_linear_iterations": 456,
        }
    )

    scene = build_scene_document_from_builder(builder)
    source = render_scene_document_as_script(scene)

    assert "study.stages.add_eigenmodes(" in source
    assert 'operator="full_2x2"' in source
    assert "k_vector=(10000000.0, 0.0, 0.0)" in source
    assert 'bc=fm.FloquetBC(["x_faces"], phase_convention="exp_plus_i_k_dot_delta_r")' in source
    assert 'magnetostatic_bc="floquet_airbox"' in source
    assert "solver_rtol=1e-08" in source
    assert "solver_max_outer_iterations=123" in source
    assert "solver_max_linear_iterations=456" in source

    with TemporaryDirectory() as temporary:
        script = Path(temporary) / "fem-eigenmodes.py"
        script.write_text(source, encoding="utf-8")
        loaded = load_problem_from_script(script, lightweight_assets=True)

    assert [stage.problem.study.to_ir()["kind"] for stage in loaded.stages] == [
        "relaxation",
        "eigenmodes",
    ]
    eigen = loaded.stages[1].problem.study.to_ir()
    assert eigen["operator"] == {"kind": "full_2x2", "include_demag": True}
    assert eigen["target"] == {"kind": "nearest", "frequency_hz": 11e9}
    assert eigen["k_sampling"] == {"kind": "single", "k_vector": [10000000.0, 0.0, 0.0]}
    assert eigen["spin_wave_bc"] == {
        "kind": "floquet",
        "pair_ids": ["x_faces"],
        "phase_convention": "exp_plus_i_k_dot_delta_r",
    }
    assert eigen["magnetostatic_bc"] == "floquet_airbox"
    assert loaded.stages[1].problem.to_ir()["problem_meta"]["runtime_metadata"]["modal_solver_policy"] == {
        "residual_tolerance": 1e-8,
        "max_outer_iterations": 123,
        "max_linear_iterations": 456,
    }

    draft = export_builder_draft(loaded)
    assert draft["stages"][1]["eigen_solver_rtol"] == "1e-08"
    rerendered = render_scene_document_as_script(build_scene_document_from_builder(draft))
    assert "study.stages.add_eigenmodes(" in rerendered
    assert 'magnetostatic_bc="floquet_airbox"' in rerendered
    assert "solver_max_outer_iterations=123" in rerendered


def test_scene_document_rejects_unsupported_stage_instead_of_dropping_it() -> None:
    from fullmag.runtime.script_builder import render_scene_document_as_script

    builder = _builder(backend="fem")
    builder["stages"].append({"kind": "frequency_response"})
    scene = build_scene_document_from_builder(builder)

    with pytest.raises(ValueError, match="does not support stage kind 'frequency_response'"):
        render_scene_document_as_script(scene)


def test_scene_document_preserves_signed_eigen_stage_ids_and_k_vectors() -> None:
    from fullmag.runtime.script_builder import render_scene_document_as_script

    builder = _builder(backend="fem")
    for stage_id, k_value in (("k_plus_10", 10e6), ("k_minus_10", -10e6)):
        builder["stages"].append(
            {
                "stage_id": stage_id,
                "kind": "eigenmodes",
                "eigen_count": 2,
                "eigen_target": "nearest",
                "eigen_target_frequency": 11e9,
                "eigen_operator": "full_2x2",
                "eigen_include_demag": True,
                "eigen_k_vector": f"{k_value},0.0,0.0",
                "eigen_spin_wave_bc": "floquet",
                "eigen_spin_wave_bc_config": {
                    "kind": "floquet",
                    "pair_ids": ["x_faces"],
                },
                "eigen_magnetostatic_bc": "floquet_airbox",
            }
        )

    scene = build_scene_document_from_builder(builder)
    source = render_scene_document_as_script(scene)

    assert 'stage_id="k_plus_10"' in source
    assert 'stage_id="k_minus_10"' in source
    with TemporaryDirectory() as temporary:
        script = Path(temporary) / "signed-eigenmodes.py"
        script.write_text(source, encoding="utf-8")
        loaded = load_problem_from_script(script, lightweight_assets=True)

    assert [stage.stage_id for stage in loaded.stages] == [
        "relax",
        "k_plus_10",
        "k_minus_10",
    ]
    assert [
        stage.problem.study.to_ir()["k_sampling"]["k_vector"][0]
        for stage in loaded.stages[1:]
    ] == [10e6, -10e6]


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("eigen_count", 0, "invalid eigen_count"),
        ("eigen_k_vector", "10.0,20.0", "invalid eigen_k_vector"),
        ("eigen_k_path", "malformed", "invalid eigen_k_path"),
    ],
)
def test_scene_document_rejects_malformed_explicit_eigen_values(
    field: str, value: object, message: str
) -> None:
    from fullmag.runtime.script_builder import render_scene_document_as_script

    builder = _builder(backend="fem")
    builder["stages"].append({"kind": "eigenmodes", field: value})
    scene = build_scene_document_from_builder(builder)

    with pytest.raises(ValueError, match=message):
        render_scene_document_as_script(scene)


@pytest.mark.parametrize("value", [1.5, True, float("nan")], ids=["fraction", "bool", "nan"])
def test_canonical_eigen_rewrite_rejects_malformed_count(value: object) -> None:
    from fullmag.runtime.script_builder import (
        render_loaded_problem_as_script,
        render_scene_document_as_script,
    )

    builder = _builder(backend="fem")
    builder["stages"] = [
        {
            "stage_id": "modal",
            "kind": "eigenmodes",
            "eigen_count": 2,
            "eigen_target": "lowest",
        }
    ]
    scene = build_scene_document_from_builder(builder)
    source = render_scene_document_as_script(scene)
    with TemporaryDirectory() as temporary:
        script = Path(temporary) / "malformed-eigen-count.py"
        script.write_text(source, encoding="utf-8")
        loaded = load_problem_from_script(script, lightweight_assets=True)

    with pytest.raises(ValueError, match="invalid eigen_count"):
        render_loaded_problem_as_script(
            loaded,
            overrides={
                "stages": [
                    {"kind": "eigenmodes", "eigen_count": value},
                ]
            },
        )


def test_scene_document_normalizes_fdm_grid_object_ids_to_magnet_names() -> None:
    from fullmag.runtime.script_builder import render_scene_document_as_script

    builder = _builder(backend="fdm")
    builder["geometries"][0]["name"] = "X ferromagnet"
    builder["geometries"][0]["region_name"] = "x-ferromagnet"
    builder["fdm"]["per_magnet"] = {
        builder["geometries"][0]["object_id"]: {"cell": [2e-9, 2e-9, 2e-9]}
    }
    builder["fdm"]["demag"] = {
        "strategy": "multilayer_convolution",
        "mode": "auto",
        "explain": True,
    }
    scene = build_scene_document_from_builder(builder)

    source = render_scene_document_as_script(scene)

    assert 'per_magnet={"X ferromagnet": fm.FDMGrid' in source
    assert 'per_magnet={"x-ferromagnet": fm.FDMGrid' not in source
    assert 'per_magnet={"x-ferromagnet-id": fm.FDMGrid' not in source
    with TemporaryDirectory() as temporary:
        script = Path(temporary) / "fdm-object-id-grid.py"
        script.write_text(source, encoding="utf-8")
        loaded = load_problem_from_script(script, lightweight_assets=True)
        assert loaded.problem.to_ir()["ir_version"] == "0.3.0"


def test_zero_dmi_material_defaults_do_not_activate_fdm_interactions() -> None:
    from fullmag.runtime.script_builder import render_scene_document_as_script

    builder = _builder(backend="fdm")
    builder["geometries"][0]["material"] = {
        "Ms": 800e3,
        "Aex": 13e-12,
        "alpha": 0.02,
        "Dind": 0.0,
        "Dbulk": 0.0,
    }
    scene = build_scene_document_from_builder(builder)

    assert all(
        entry["kind"] not in {"interfacial_dmi", "bulk_dmi"}
        for entry in scene["objects"][0]["physics_stack"]
    )
    source = render_scene_document_as_script(scene)
    assert ".Dind =" not in source
    assert ".Dbulk =" not in source


def test_explicit_zero_dmi_modules_are_preserved_in_python_export() -> None:
    from fullmag.runtime.script_builder import render_scene_document_as_script

    builder = _builder(backend="fdm")
    builder["geometries"][0]["physics_stack"] = [
        {"kind": "exchange", "enabled": True},
        {"kind": "demag", "enabled": True},
        {"kind": "interfacial_dmi", "enabled": True, "params": {"dind": 0.0}},
        {"kind": "bulk_dmi", "enabled": True, "params": {"dbulk": 0.0}},
    ]

    scene = build_scene_document_from_builder(builder)
    stack = scene["objects"][0]["physics_stack"]
    assert {entry["kind"] for entry in stack} >= {"interfacial_dmi", "bulk_dmi"}
    source = render_scene_document_as_script(scene)
    assert ".Dind = 0" in source
    assert ".Dbulk = 0" in source


def test_rotated_dmi_study_term_round_trips_signed_coefficient() -> None:
    from fullmag.runtime.script_builder import render_scene_document_as_script

    builder = _builder(backend="fdm")
    builder["rotated_interfacial_dmi"] = -0.003
    scene = build_scene_document_from_builder(builder)

    assert scene["study"]["rotated_interfacial_dmi"] == -0.003
    source = render_scene_document_as_script(scene)
    assert "study.terms.add(fm.RotatedInterfacialDMI(D=-0.003))" in source

    with TemporaryDirectory() as temporary:
        script = Path(temporary) / "rotated-dmi.py"
        script.write_text(source, encoding="utf-8")
        loaded = load_problem_from_script(script, lightweight_assets=True)
        draft = export_builder_draft(loaded)

    assert draft["rotated_interfacial_dmi"] == -0.003


def test_rotated_dmi_requires_study_exchange_for_open_boundary_authoring() -> None:
    builder = _builder(backend="fdm")
    builder["exchange_enabled"] = False
    builder["rotated_interfacial_dmi"] = 0.003

    with pytest.raises(ValueError, match="requires Exchange"):
        build_scene_document_from_builder(builder)

    scene = build_scene_document_from_builder(_builder(backend="fdm"))
    scene["study"]["exchange_enabled"] = False
    scene["study"]["rotated_interfacial_dmi"] = 0.003
    with pytest.raises(ValueError, match="requires Exchange"):
        build_builder_from_scene_document(scene)

    builder["rotated_interfacial_dmi"] = 0.0
    build_scene_document_from_builder(builder)


def test_rotated_dmi_object_stack_is_rejected_fail_closed() -> None:
    builder = _builder(backend="fdm")
    builder["geometries"][0]["physics_stack"].append(
        {
            "kind": "rotated_interfacial_dmi",
            "enabled": True,
            "params": {"d": 0.003},
        }
    )

    with pytest.raises(ValueError, match="study-scoped"):
        build_scene_document_from_builder(builder)

    scene = build_scene_document_from_builder(_builder(backend="fdm"))
    scene["objects"][0]["physics_stack"].append(
        {
            "kind": "rotated_interfacial_dmi",
            "enabled": True,
            "params": {"d": 0.003},
        }
    )
    with pytest.raises(ValueError, match="study-scoped"):
        build_builder_from_scene_document(scene)


@pytest.mark.parametrize("dmi_kind", ["interfacial_dmi", "bulk_dmi"])
def test_scene_document_rejects_conflicting_study_and_object_dmi(
    dmi_kind: str,
) -> None:
    builder = _builder(backend="fdm")
    builder["rotated_interfacial_dmi"] = -0.003
    builder["geometries"][0]["physics_stack"].append(
        {"kind": dmi_kind, "enabled": True, "params": {}}
    )

    with pytest.raises(ValueError, match="study-scoped.*cannot coexist"):
        build_scene_document_from_builder(builder)

    scene = build_scene_document_from_builder(_builder(backend="fdm"))
    scene["study"]["rotated_interfacial_dmi"] = -0.003
    scene["objects"][0]["physics_stack"].append(
        {"kind": dmi_kind, "enabled": True, "params": {}}
    )
    with pytest.raises(ValueError, match="study-scoped.*cannot coexist"):
        build_builder_from_scene_document(scene)


@pytest.mark.parametrize(
    ("material_key", "dmi_kind"),
    [("Dind", "interfacial_dmi"), ("Dbulk", "bulk_dmi")],
)
@pytest.mark.parametrize("stack_state", ["empty", "missing"])
def test_scene_document_rejects_material_derived_dmi_conflict_in_both_directions(
    material_key: str,
    dmi_kind: str,
    stack_state: str,
) -> None:
    builder = _builder(backend="fdm")
    builder["rotated_interfacial_dmi"] = -0.003
    builder["geometries"][0]["material"][material_key] = 0.003

    with pytest.raises(ValueError, match="study-scoped.*cannot coexist"):
        build_scene_document_from_builder(builder)

    scene_builder = _builder(backend="fdm")
    scene_builder["geometries"][0]["material"][material_key] = 0.003
    scene = build_scene_document_from_builder(scene_builder)
    if stack_state == "empty":
        scene["objects"][0]["physics_stack"] = []
    else:
        scene["objects"][0].pop("physics_stack")
    scene["study"]["rotated_interfacial_dmi"] = -0.003

    with pytest.raises(ValueError, match="study-scoped.*cannot coexist"):
        build_builder_from_scene_document(scene)

    scene["objects"][0]["physics_stack"] = [
        {"kind": dmi_kind, "enabled": False, "params": {}}
    ]
    recovered = build_builder_from_scene_document(scene)
    recovered_stack = recovered["geometries"][0]["physics_stack"]
    assert any(
        entry["kind"] == dmi_kind and entry["enabled"] is False
        for entry in recovered_stack
    )


def test_scene_document_export_rejects_an_incomplete_scene() -> None:
    from fullmag.runtime.script_builder import render_scene_document_as_script

    scene = build_scene_document_from_builder(_builder(backend="fdm"))
    scene["objects"][0]["material_ref"] = None
    with pytest.raises(ValueError, match="material"):
        render_scene_document_as_script(scene)


def test_helper_renders_scene_document_without_input_script(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from fullmag.runtime.helper import main

    scene = build_scene_document_from_builder(_builder(backend="fem"))
    scene_path = tmp_path / "scene.json"
    output_path = tmp_path / "scene.py"
    scene_path.write_text(json.dumps(scene), encoding="utf-8")

    assert main(
        [
            "render-scene-document",
            "--scene-json",
            str(scene_path),
            "--output",
            str(output_path),
        ]
    ) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["source_kind"] == "scene_document"
    assert payload["written"] is True
    assert output_path.read_text(encoding="utf-8").startswith('"""Canonical Fullmag script')


def test_scene_document_preserves_execution_intent_and_zero_random_seed() -> None:
    from fullmag.runtime.script_builder import render_scene_document_as_script

    builder = _builder(backend="fdm")
    builder["requested_backend"] = "fdm"
    builder["requested_device"] = "gpu"
    builder["requested_precision"] = "single"
    builder["geometries"][0]["magnetization"] = {
        "kind": "preset_texture",
        "preset_kind": "random",
        "preset_params": {"seed": 0},
        "preset_version": 1,
    }

    scene = build_scene_document_from_builder(builder)
    assert scene["study"]["requested_backend"] == "fdm"
    assert scene["study"]["requested_device"] == "gpu"
    assert scene["study"]["requested_precision"] == "single"
    assert build_builder_from_scene_document(scene)["requested_device"] == "gpu"
    assert build_builder_from_scene_document(scene)["requested_precision"] == "single"

    source = render_scene_document_as_script(scene)
    assert 'study.device("cuda:0", precision="single")' in source
    assert 'preset_kind="random"' in source
    assert 'params={"seed": 0}' in source
    assert "preset_version=1" in source


def test_scene_document_exports_legacy_uniform_texture_value() -> None:
    from fullmag.runtime.script_builder import render_scene_document_as_script

    builder = _builder(backend="fdm")
    builder["geometries"][0]["magnetization"] = {
        "kind": "uniform",
        "value": [0.0, 1.0, 0.0],
    }

    scene = build_scene_document_from_builder(builder)
    source = render_scene_document_as_script(scene)

    assert "fm.texture.uniform(0, 1, 0)" in source
    with TemporaryDirectory() as temporary:
        script = Path(temporary) / "uniform.py"
        script.write_text(source, encoding="utf-8")
        loaded = load_problem_from_script(script, lightweight_assets=True)
        assert export_builder_draft(loaded)["geometries"][0]["magnetization"]
