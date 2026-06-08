import textwrap
from pathlib import Path

import fullmag as fm
import fullmag.world as flat_world
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.script_builder import rewrite_loaded_problem_script


def _region_ir() -> dict[str, object]:
    return flat_world._build_problem().to_ir(include_geometry_assets=False)["object_regions"][0]


def _body_with_material():
    body = fm.geometry(
        fm.Box(size=(100e-9, 20e-9, 10e-9), name="body"),
        name="body",
    )
    body.Ms = 800e3
    body.Aex = 13e-12
    body.alpha = 0.02
    return body


def test_region_material_ms_defaults_to_mesh_relative_transition() -> None:
    fm.reset()
    body = _body_with_material()
    defect = body.add_region("defect", fm.Cylinder(radius=10e-9, height=10e-9))

    defect.material.Ms = 400e3

    assert _region_ir()["material_transition"] == {
        "kind": "mesh_relative",
        "cells": 3,
        "scope": "boundary",
    }


def test_region_material_transition_can_be_overridden_before_assignment() -> None:
    fm.reset()
    body = _body_with_material()
    defect = body.add_region("defect", fm.Cylinder(radius=10e-9, height=10e-9))

    defect.material_transition(cells=5, scope="inside")
    defect.material.Ms = 400e3

    assert _region_ir()["material_transition"] == {
        "kind": "mesh_relative",
        "cells": 5,
        "scope": "inside",
    }


def test_region_material_transition_accepts_metric_width() -> None:
    fm.reset()
    body = _body_with_material()
    defect = body.add_region("defect", fm.Cylinder(radius=10e-9, height=10e-9))

    defect.material_transition(kind="metric", width=2e-9, scope="outside")
    defect.material.Ms = 400e3

    assert _region_ir()["material_transition"] == {
        "kind": "metric",
        "width": 2e-9,
        "scope": "outside",
    }


def test_region_material_transition_sharp_has_no_scope() -> None:
    fm.reset()
    body = _body_with_material()
    defect = body.add_region("defect", fm.Cylinder(radius=10e-9, height=10e-9))

    defect.material_transition(kind="sharp")
    defect.material.Ms = 400e3

    assert _region_ir()["material_transition"] == {"kind": "sharp"}


def test_region_set_material_field_uses_region_support_without_redeclaring_shape() -> None:
    fm.reset()
    body = _body_with_material()
    defect = body.add_region("defect", fm.Cylinder(radius=10e-9, height=10e-9))

    defect.set_material_field(
        "Ms",
        fm.fields.linear(base=800e3, gradient=(1e11, 0.0, 0.0), unit="A/m"),
    )

    region = _region_ir()
    assert region["material_overrides"][0]["parameter"] == "ms"
    assert region["material_overrides"][0]["value"]["kind"] == "linear"
    assert region["material_transition"] == {
        "kind": "mesh_relative",
        "cells": 3,
        "scope": "boundary",
    }


def test_region_material_transition_round_trips_through_script_export(tmp_path: Path) -> None:
    script_path = tmp_path / "region_transition.py"
    script_path.write_text(
        textwrap.dedent(
            """
            import fullmag as fm

            study = fm.study("region_transition")
            body = study.geometry(
                fm.Box(size=(100e-9, 20e-9, 10e-9), name="body"),
                name="body",
            )
            body.Ms = 800e3
            body.Aex = 13e-12
            body.alpha = 0.02
            defect = body.add_region("defect", fm.Cylinder(radius=10e-9, height=10e-9))
            defect.material_transition(kind="metric", width=2e-9, scope="outside")
            defect.material.Ms = 400e3
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )

    loaded = load_problem_from_script(script_path, lightweight_assets=True)
    exported = rewrite_loaded_problem_script(loaded)["rendered_source"]
    transition_index = exported.index(".material_transition(")
    material_index = exported.index(".set_material(")
    assert transition_index < material_index
    exported_path = tmp_path / "region_transition_exported.py"
    exported_path.write_text(exported, encoding="utf-8")
    reloaded = load_problem_from_script(exported_path, lightweight_assets=True)

    region = reloaded.problem.to_ir(include_geometry_assets=False)["object_regions"][0]
    assert region["material_transition"] == {
        "kind": "metric",
        "width": 2e-9,
        "scope": "outside",
    }
