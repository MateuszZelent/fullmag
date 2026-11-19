from __future__ import annotations

from pathlib import Path

import fullmag as fm
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.scene_document_ir import scene_document_to_execution_config
from fullmag.runtime.script_builder import export_builder_draft


def _materialized_scene_ir(script_path: Path, source_root: Path) -> dict[str, object]:
    loaded = fm.load_problem_from_script(script_path, lightweight_assets=True)
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    config = scene_document_to_execution_config(
        scene,
        requested_backend="fdm",
        requested_device="cpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=source_root,
        materialize_geometry_assets=True,
    )
    return config["ir"]


def _write_two_box_script(path: Path, *, strategy: str) -> None:
    path.write_text(
        f"""import fullmag as fm
NM = 1e-9
CELL = (2 * NM, 2 * NM, 2 * NM)
study = fm.study('padded-boxes-{strategy}')
study.engine('fdm')
study.device('cpu', precision='double')
study.mode('strict')
study.universe(mode='manual', size=(8 * NM, 8 * NM, 8 * NM), center=(0, 0, 2 * NM), padding=(0, 0, 0))
study.cell(*CELL)
lower = study.geometry(fm.Box(size=(8 * NM, 8 * NM, 2 * NM)), name='lower', object_id='lower-id')
lower.Ms = 580000.0
lower.Aex = 15e-12
lower.m = fm.texture.bimeron(radius=2 * NM, wall_width=NM, vorticity=-1)
lower.mesh(cell_size=CELL)
upper = study.geometry(fm.Box(size=(8 * NM, 8 * NM, 2 * NM)).translate((0, 0, 4 * NM)), name='upper', object_id='upper-id')
upper.Ms = 1000000.0
upper.Aex = 10e-12
upper.m = fm.texture.vortex(circulation=-1, core_polarity=1, core_radius=NM)
upper.mesh(cell_size=CELL)
study.fdm(default_cell=CELL, demag=fm.FDMDemag(strategy={strategy!r}, mode='three_d', common_cells=(4, 4, 4)))
study.demag()
""",
        encoding="utf-8",
    )


def test_multibody_auto_materialization_keeps_native_texture_descriptors(
    tmp_path: Path,
) -> None:
    script_path = tmp_path / "padded_boxes.py"
    _write_two_box_script(script_path, strategy="auto")

    ir = _materialized_scene_ir(script_path, tmp_path)

    magnets = {magnet["object_id"]: magnet for magnet in ir["magnets"]}
    assert {
        object_id: magnet["initial_magnetization"]["preset_kind"]
        for object_id, magnet in magnets.items()
    } == {"lower-id": "bimeron", "upper-id": "vortex"}
    assert all(
        magnet["initial_magnetization"]["kind"] == "preset_texture"
        and "values" not in magnet["initial_magnetization"]
        for magnet in magnets.values()
    )

    assets = ir["geometry_assets"]["fdm_grid_assets"]
    assert {tuple(asset["cells"]) for asset in assets} == {(4, 4, 4)}
    assert {len(asset["active_mask"]) for asset in assets} == {64}
    assert {magnet["material"] for magnet in magnets.values()} == {
        "mat_lower",
        "mat_upper",
    }


def test_single_magnet_explicit_multilayer_keeps_preset_for_native_crop(
    tmp_path: Path,
) -> None:
    script_path = tmp_path / "single_multilayer.py"
    script_path.write_text(
        """import fullmag as fm
NM = 1e-9
CELL = (2 * NM, 2 * NM, 2 * NM)
study = fm.study('single-multilayer-crop')
study.engine('fdm')
study.device('cpu', precision='double')
study.mode('strict')
study.universe(mode='manual', size=(8 * NM, 8 * NM, 8 * NM), center=(0, 0, 2 * NM), padding=(0, 0, 0))
study.cell(*CELL)
film = study.geometry(fm.Box(size=(4 * NM, 4 * NM, 2 * NM)), name='film', object_id='film-id')
film.Ms = 580000.0
film.Aex = 15e-12
film.m = fm.texture.bimeron(radius=NM, wall_width=NM)
study.fdm(default_cell=CELL, demag=fm.FDMDemag(strategy='multilayer_convolution', mode='three_d', common_cells=(4, 4, 4)))
study.demag()
""",
        encoding="utf-8",
    )

    ir = _materialized_scene_ir(script_path, tmp_path)

    initial = ir["magnets"][0]["initial_magnetization"]
    assert initial["kind"] == "preset_texture"
    assert initial["preset_kind"] == "bimeron"
    assert len(ir["geometry_assets"]["fdm_grid_assets"][0]["active_mask"]) == 64


def test_shifted_unequal_multilayer_scene_keeps_materials_and_native_geometry(
    tmp_path: Path,
) -> None:
    example = (
        Path(__file__).resolve().parents[3]
        / "examples"
        / "bimeron-cylinder-relax"
        / "verify_gpu_embedding.py"
    )

    ir = _materialized_scene_ir(example, tmp_path)

    magnets = {magnet["object_id"]: magnet for magnet in ir["magnets"]}
    lower = magnets["lower-film"]
    upper = magnets["upper-cylinder"]
    assert lower["initial_magnetization"]["kind"] == "preset_texture"
    assert lower["initial_magnetization"]["preset_kind"] == "bimeron"
    assert upper["initial_magnetization"] == {
        "kind": "uniform",
        "value": [-1.0, 0.0, 0.0],
    }

    materials = {material["name"]: material for material in ir["materials"]}
    assert materials[lower["material"]]["saturation_magnetisation"] == 580000.0
    assert materials[lower["material"]]["exchange_stiffness"] == 15e-12
    assert materials[lower["material"]]["uniaxial_anisotropy"] == 663920.0
    assert materials[lower["material"]]["anisotropy_axis"] == [1.0, 0.0, 0.0]
    assert materials[upper["material"]]["saturation_magnetisation"] == 1000000.0
    assert materials[upper["material"]]["exchange_stiffness"] == 10e-12
    assert materials[upper["material"]]["uniaxial_anisotropy"] == 0.0

    geometry = {entry["name"]: entry for entry in ir["geometry"]["entries"]}
    assert geometry["lower_film_geom"]["kind"] == "box"
    cylinder = geometry["upper_cylinder_geom"]
    assert cylinder["kind"] == "translate"
    assert cylinder["by"] == [0.0, 0.0, 10e-9]
    assert cylinder["base"]["kind"] == "cylinder"
    assert cylinder["base"]["radius"] == 5e-9
    assert cylinder["base"]["height"] == 10e-9

    fdm = ir["backend_policy"]["discretization_hints"]["fdm"]
    assert fdm["per_magnet"] == {
        "lower_film": {"cell": [2.5e-9, 2.5e-9, 2.5e-9]},
        "upper_cylinder": {"cell": [2.5e-9, 2.5e-9, 2.5e-9]},
    }
    assert {
        tuple(asset["cells"])
        for asset in ir["geometry_assets"]["fdm_grid_assets"]
    } == {(8, 8, 7)}
    assert [
        term
        for term in ir["energy_terms"]
        if term["kind"] == "rotated_interfacial_dmi"
    ] == [
        {
            "kind": "rotated_interfacial_dmi",
            "D": 0.004,
            "object_ids": ["lower-film"],
        }
    ]


def test_single_grid_materialization_keeps_padded_sampled_field_behavior(
    tmp_path: Path,
) -> None:
    script_path = tmp_path / "single_grid.py"
    script_path.write_text(
        """import fullmag as fm
NM = 1e-9
CELL = (2 * NM, 2 * NM, 2 * NM)
study = fm.study('single-grid-padded')
study.engine('fdm')
study.device('cpu', precision='double')
study.mode('strict')
study.universe(mode='manual', size=(8 * NM, 8 * NM, 8 * NM), center=(0, 0, 2 * NM), padding=(0, 0, 0))
study.cell(*CELL)
film = study.geometry(fm.Box(size=(4 * NM, 4 * NM, 2 * NM)), name='film', object_id='film-id')
film.Ms = 580000.0
film.Aex = 15e-12
film.m = fm.texture.bimeron(radius=NM, wall_width=NM)
study.fdm(default_cell=CELL, demag=fm.FDMDemag(strategy='single_grid'))
study.demag()
""",
        encoding="utf-8",
    )

    ir = _materialized_scene_ir(script_path, tmp_path)

    initial = ir["magnets"][0]["initial_magnetization"]
    assert initial["kind"] == "sampled_field"
    assert len(initial["values"]) == 64
    assert len(ir["geometry_assets"]["fdm_grid_assets"][0]["active_mask"]) == 64
