from pathlib import Path

import fullmag as fm
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.scene_document_ir import scene_document_to_execution_config
from fullmag.runtime.script_builder import export_builder_draft


def test_scene_execution_config_preserves_single_scoped_rotated_dmi(
    tmp_path: Path,
) -> None:
    source = tmp_path / "single_scoped_dmi.py"
    source.write_text(
        """import fullmag as fm
study = fm.study('single-scoped-dmi')
study.engine('fdm')
study.device('gpu', precision='double')
film = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='film', object_id='film-id')
film.Ms = 800e3
film.Aex = 13e-12
study.terms.add(fm.RotatedInterfacialDMI(D=0.004, object_ids=['film-id']))
""",
        encoding="utf-8",
    )
    loaded = fm.load_problem_from_script(source, lightweight_assets=True)
    scene = build_scene_document_from_builder(export_builder_draft(loaded))

    config = scene_document_to_execution_config(
        scene,
        requested_backend="fdm",
        requested_device="gpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )

    rotated_terms = [
        term
        for term in config["ir"]["energy_terms"]
        if term["kind"] == "rotated_interfacial_dmi"
    ]
    assert rotated_terms == [
        {
            "kind": "rotated_interfacial_dmi",
            "D": 0.004,
            "object_ids": ["film-id"],
        }
    ]
