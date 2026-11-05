from __future__ import annotations

from pathlib import Path

import fullmag as fm
import pytest
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
)
from fullmag.runtime.script_builder import (
    export_builder_draft,
    render_loaded_problem_as_script,
    render_scene_document_as_script,
)
from fullmag.runtime.scene_document_ir import scene_document_to_problem_ir


def test_rotated_interfacial_dmi_validates_and_serializes_object_ids() -> None:
    with pytest.raises(ValueError, match="at least one"):
        fm.RotatedInterfacialDMI(D=0.0, object_ids=[])
    with pytest.raises(ValueError, match=r"object_ids\[0\]"):
        fm.RotatedInterfacialDMI(D=0.0, object_ids=[""])
    with pytest.raises(ValueError, match="unique"):
        fm.RotatedInterfacialDMI(D=0.0, object_ids=["film-a", "film-a"])
    with pytest.raises(TypeError, match="sequence"):
        fm.RotatedInterfacialDMI(D=0.0, object_ids="film-a")

    global_term = fm.RotatedInterfacialDMI(D=3e-3)
    assert global_term.to_ir() == {"kind": "rotated_interfacial_dmi", "D": 3e-3}

    scoped_term = fm.RotatedInterfacialDMI(
        D=0.0,
        object_ids=("film-a", "film-b"),
    )
    assert scoped_term.to_ir() == {
        "kind": "rotated_interfacial_dmi",
        "D": 0.0,
        "object_ids": ["film-a", "film-b"],
    }


def test_problem_rejects_unknown_rotated_dmi_object_ids() -> None:
    magnet = fm.Ferromagnet(
        name="film",
        object_id="film-id",
        geometry=fm.Box(20e-9, 10e-9, 5e-9, name="film"),
        material=fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01),
    )

    with pytest.raises(ValueError, match="unknown magnetic object_id.*missing"):
        fm.Problem(
            name="unknown-scoped-rdmi",
            magnets=[magnet],
            energy=[
                fm.Exchange(),
                fm.RotatedInterfacialDMI(D=0.0, object_ids=["missing"]),
            ],
            study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[]),
        )


def test_study_capture_script_export_and_scene_round_trip_preserve_scoped_zero_dmi(
    tmp_path: Path,
) -> None:
    source = tmp_path / "scoped_rdmi.py"
    source.write_text(
        """import fullmag as fm
study = fm.study('scoped-rdmi')
study.engine('fdm')
study.device('cpu')
film_a = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='film-a', object_id='film-a-id')
film_a.Ms = 800e3
film_a.Aex = 13e-12
film_a.alpha = 0.01
film_b = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='film-b', object_id='film-b-id')
film_b.Ms = 800e3
film_b.Aex = 13e-12
film_b.alpha = 0.01
study.terms.add(fm.RotatedInterfacialDMI(D=0.0, object_ids=[film_a.object_id, film_b.object_id]))
""",
        encoding="utf-8",
    )

    loaded = fm.load_problem_from_script(source, lightweight_assets=True)
    expected_term = {
        "kind": "rotated_interfacial_dmi",
        "D": 0.0,
        "object_ids": ["film-a-id", "film-b-id"],
    }
    assert loaded.problem.to_ir(include_geometry_assets=False)["energy_terms"][-1] == expected_term

    rendered = render_loaded_problem_as_script(loaded)
    assert 'object_ids=("film-a-id", "film-b-id")' in rendered
    rewritten = tmp_path / "rewritten.py"
    rewritten.write_text(rendered, encoding="utf-8")
    rewritten_loaded = fm.load_problem_from_script(rewritten, lightweight_assets=True)
    assert rewritten_loaded.problem.to_ir(include_geometry_assets=False)["energy_terms"][-1] == expected_term

    builder = export_builder_draft(loaded)
    assert builder["rotated_interfacial_dmi"] == 0.0
    assert builder["rotated_interfacial_dmi_object_ids"] == ["film-a-id", "film-b-id"]
    scene = build_scene_document_from_builder(builder)
    assert scene["study"]["rotated_interfacial_dmi"] == 0.0
    assert scene["study"]["rotated_interfacial_dmi_object_ids"] == ["film-a-id", "film-b-id"]
    rebuilt_builder = build_builder_from_scene_document(scene)
    assert rebuilt_builder["rotated_interfacial_dmi"] == 0.0
    assert rebuilt_builder["rotated_interfacial_dmi_object_ids"] == ["film-a-id", "film-b-id"]

    scene_script = render_scene_document_as_script(scene)
    assert 'object_ids=("film-a-id", "film-b-id")' in scene_script
    scene_script_path = tmp_path / "scene_export.py"
    scene_script_path.write_text(scene_script, encoding="utf-8")
    scene_loaded = fm.load_problem_from_script(scene_script_path, lightweight_assets=True)
    assert scene_loaded.problem.to_ir(include_geometry_assets=False)["energy_terms"][-1] == expected_term
    scene_ir = scene_document_to_problem_ir(
        scene,
        requested_backend="fdm",
        requested_device="cpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )
    assert scene_ir["energy_terms"][-1] == expected_term


def test_global_zero_dmi_scene_round_trip_keeps_historical_global_scope() -> None:
    builder = {"geometries": [], "rotated_interfacial_dmi": 0.0}
    scene = build_scene_document_from_builder(builder)
    assert scene["study"]["rotated_interfacial_dmi"] == 0.0
    assert "rotated_interfacial_dmi_object_ids" not in scene["study"]

    rebuilt = build_builder_from_scene_document(scene)
    assert rebuilt["rotated_interfacial_dmi"] == 0.0
    assert rebuilt["rotated_interfacial_dmi_object_ids"] is None


def test_bimeron_example_lowers_one_scoped_term_and_keeps_distinct_materials() -> None:
    example = (
        Path(__file__).resolve().parents[3]
        / "examples"
        / "bimeron-cylinder-relax"
        / "relax.py"
    )
    loaded = fm.load_problem_from_script(example, lightweight_assets=True)
    ir = loaded.to_ir(
        requested_backend=fm.BackendTarget.FDM,
        execution_mode=fm.ExecutionMode.STRICT,
        execution_precision=fm.ExecutionPrecision.DOUBLE,
        include_geometry_assets=False,
    )

    rotated_dmi_terms = [
        term
        for term in ir["energy_terms"]
        if term["kind"] == "rotated_interfacial_dmi"
    ]
    assert rotated_dmi_terms == [
        {
            "kind": "rotated_interfacial_dmi",
            "D": 0.004,
            "object_ids": ["bimeron-film"],
        }
    ]
    magnets = {magnet["name"]: magnet for magnet in ir["magnets"]}
    materials = {material["name"]: material for material in ir["materials"]}
    film = materials[magnets["bimeron_film"]["material"]]
    cylinder = materials[magnets["upper_cylinder"]["material"]]
    assert (
        film["saturation_magnetisation"],
        film["exchange_stiffness"],
        film["uniaxial_anisotropy"],
    ) == (580000.0, 15e-12, 663920.0)
    assert (
        cylinder["saturation_magnetisation"],
        cylinder["exchange_stiffness"],
        cylinder["uniaxial_anisotropy"],
    ) == (1000000.0, 10e-12, 0.0)
    pipeline_nodes = ir["problem_meta"]["runtime_metadata"]["study_pipeline"]["nodes"]
    assert [node["stage_kind"] for node in pipeline_nodes] == ["relax"]
    assert pipeline_nodes[0]["payload"]["max_steps"] == "100000"
    assert [
        field["quantity"]
        for field in pipeline_nodes[0]["payload"]["autosave"]["fields"]
    ] == ["m"]


@pytest.mark.parametrize(
    ("parameter", "left", "right"),
    [
        ("Dind", 1e-3, 2e-3),
        ("Dind", 1e-3, None),
        ("Dbulk", -1e-3, 2e-3),
        ("Dbulk", -1e-3, None),
    ],
)
def test_study_capture_rejects_nonuniform_material_dmi_lowering(
    tmp_path: Path,
    parameter: str,
    left: float | None,
    right: float | None,
) -> None:
    assignments = "\n".join(
        f"film_{side}.{parameter} = {value!r}"
        for side, value in (("a", left), ("b", right))
        if value is not None
    )
    source = tmp_path / f"mixed_{parameter}_{left}_{right}.py"
    source.write_text(
        f"""import fullmag as fm
study = fm.study('mixed-{parameter}')
film_a = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='film-a', object_id='film-a-id')
film_a.Ms = 800e3
film_a.Aex = 13e-12
film_b = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='film-b', object_id='film-b-id')
film_b.Ms = 800e3
film_b.Aex = 13e-12
{assignments}
""",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match=f"legacy study-level {parameter} lowering"):
        fm.load_problem_from_script(source, lightweight_assets=True)


@pytest.mark.parametrize(
    ("parameter", "kind"),
    [("Dind", "interfacial_dmi"), ("Dbulk", "bulk_dmi")],
)
def test_explicit_material_dmi_zero_and_unset_lower_to_global_zero(
    tmp_path: Path,
    parameter: str,
    kind: str,
) -> None:
    source = tmp_path / f"zero_and_unset_{parameter}.py"
    source.write_text(
        f"""import fullmag as fm
study = fm.study('zero-and-unset-{parameter}')
film_a = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='film-a', object_id='film-a-id')
film_a.Ms = 800e3
film_a.Aex = 13e-12
film_a.{parameter} = 0.0
film_b = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='film-b', object_id='film-b-id')
film_b.Ms = 800e3
film_b.Aex = 13e-12
""",
        encoding="utf-8",
    )

    loaded = fm.load_problem_from_script(source, lightweight_assets=True)
    assert {
        "kind": kind,
        "D": 0.0,
    } in loaded.problem.to_ir(include_geometry_assets=False)["energy_terms"]


@pytest.mark.parametrize(
    ("parameter", "kind"),
    [("Dind", "interfacial_dmi"), ("Dbulk", "bulk_dmi")],
)
def test_uniform_material_dmi_keeps_legacy_global_lowering(
    tmp_path: Path,
    parameter: str,
    kind: str,
) -> None:
    source = tmp_path / f"uniform_{parameter}.py"
    source.write_text(
        f"""import fullmag as fm
study = fm.study('uniform-{parameter}')
film_a = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='film-a', object_id='film-a-id')
film_a.Ms = 800e3
film_a.Aex = 13e-12
film_a.{parameter} = 1e-3
film_b = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='film-b', object_id='film-b-id')
film_b.Ms = 800e3
film_b.Aex = 13e-12
film_b.{parameter} = 1e-3
""",
        encoding="utf-8",
    )

    loaded = fm.load_problem_from_script(source, lightweight_assets=True)
    assert {
        "kind": kind,
        "D": 1e-3,
    } in loaded.problem.to_ir(include_geometry_assets=False)["energy_terms"]
