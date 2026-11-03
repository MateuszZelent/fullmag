from __future__ import annotations

import ast
import json
import math
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def _module(name: str) -> ast.Module:
    return ast.parse((ROOT / name).read_text(encoding="utf-8"), filename=name)


def _constants(module: ast.Module) -> dict[str, object]:
    values: dict[str, object] = {}
    for node in module.body:
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
        ):
            try:
                values[node.targets[0].id] = ast.literal_eval(node.value)
            except (ValueError, TypeError):
                pass
    return values


def _calls(module: ast.Module, terminal_name: str) -> list[ast.Call]:
    calls: list[ast.Call] = []
    for node in ast.walk(module):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id == terminal_name:
            calls.append(node)
        elif isinstance(func, ast.Attribute) and func.attr == terminal_name:
            calls.append(node)
    return calls


def test_common_parameters_match_goebel_2019_supplement_table_i() -> None:
    values = _constants(_module("common.py"))
    assert values["TRACK_SIZE"] == (500e-9, 40e-9, 0.5e-9)
    assert values["MS"] == 0.58e6
    assert values["AEX"] == 15e-12
    assert values["D_ROTATED"] == 3e-3
    assert values["KU_X"] == 0.8e6
    assert values["ALPHA"] == 0.3
    assert values["TEMPERATURE"] == 0.0
    from tests.standard_problems.bimeron.goebel_2019.common import GAMMA_H

    assert math.isclose(GAMMA_H / (4e-7 * math.pi), 1.760e11, rel_tol=1e-15)
    assert values["CELL"] == (0.5e-9, 0.5e-9, 0.5e-9)
    assert values["BIMERON_RADIUS"] == 10e-9
    assert values["BIMERON_WALL_WIDTH"] == 3e-9
    assert values["LLG_HOLD_TIME"] == 1e-10


def test_device_selection_keeps_fdm_gpu_default_and_rejects_fem_gpu(
    monkeypatch,
) -> None:
    from tests.standard_problems.bimeron.goebel_2019.common import (
        requested_device,
        requested_fem_device,
    )

    monkeypatch.delenv("FULLMAG_GOEBEL_DEVICE", raising=False)
    assert requested_device() == "gpu"
    assert requested_fem_device() == "cpu"

    monkeypatch.setenv("FULLMAG_GOEBEL_DEVICE", "cpu")
    assert requested_device() == "cpu"
    assert requested_fem_device() == "cpu"

    monkeypatch.setenv("FULLMAG_GOEBEL_DEVICE", "gpu")
    try:
        requested_fem_device()
    except ValueError as exc:
        message = str(exc)
        assert "mixed-topology rotated-DMI" in message
        assert "without a CPU fallback" in message
    else:
        raise AssertionError("FEM GPU must be rejected before domain-mesh build")


def test_fdm_scenario_is_strict_fp64_periodic_x_with_relax_and_hold() -> None:
    module = _module("scenario_fdm.py")
    source = ast.unparse(module)
    assert "study.engine('fdm')" in source
    assert "study.device(REQUESTED_DEVICE, precision='double')" in source
    assert "study.mode('strict')" in source
    assert "study.cell(*CELL)" in source
    assert "study.pbc(x=True, demag='truncated_images')" in source
    assert len(_calls(module, "RotatedInterfacialDMI")) == 1
    assert "film.Ku1 = KU_X" in source
    assert "film.anisU = (1.0, 0.0, 0.0)" in source
    assert len(_calls(module, "bimeron")) == 1
    assert len(_calls(module, "add_relax")) == 1
    assert "algorithm='llg_overdamped'" in source
    assert "fix_dt=LLG_DT" in source
    assert "gamma=GAMMA_H" in source
    assert "dt=LLG_DT" in source
    assert "vorticity=-1" in source
    assert "max_physical_time_s=RELAX_TIME" in source
    assert "relax_alpha=ALPHA" in source
    assert len(_calls(module, "add_run")) == 1
    assert "until=HOLD_TIME" in source
    assert len(_calls(module, "add_save_state")) == 2


def test_fem_scenario_preserves_one_exact_prism_layer_and_open_boundary() -> None:
    module = _module("scenario_fem.py")
    source = ast.unparse(module)
    assert "study.engine('fem')" in source
    assert "study.device(REQUESTED_DEVICE, precision='double')" in source
    assert "requested_fem_device()" in source
    assert "study.mode('strict')" in source
    assert "study.pbc(" not in source
    assert "film.Aex = AEX" in source
    assert "topology='prismatic'" in source
    assert "layers=1" in source
    assert "exact_layers=True" in source
    assert "study.demag(realization='poisson_robin')" in source
    assert len(_calls(module, "RotatedInterfacialDMI")) == 1
    assert "film.Ku1 = KU_X" in source
    assert "film.anisU = (1.0, 0.0, 0.0)" in source
    assert len(_calls(module, "add_relax")) == 1
    assert "algorithm='llg_overdamped'" in source
    assert "fix_dt=LLG_DT" in source
    assert "dt=LLG_DT" in source
    assert "vorticity=-1" in source
    assert "max_physical_time_s=RELAX_TIME" in source
    assert "relax_alpha=ALPHA" in source
    assert len(_calls(module, "add_run")) == 1
    assert "until=HOLD_TIME" in source
    assert len(_calls(module, "add_save_state")) == 2


def test_thresholds_are_source_frozen() -> None:
    thresholds = json.loads((ROOT / "thresholds.v1.json").read_text(encoding="utf-8"))
    assert thresholds == {
        "schema_version": "goebel-bimeron-thresholds.v1",
        "min_abs_topological_charge": 0.8,
        "min_core_abs_mz": 0.5,
        "min_background_mx": 0.8,
        "min_hold_time_s": 1e-10,
        "fdm_cpu_gpu_fp64_field_rtol": 2e-12,
        "fem_cpu_gpu_fp64_residual_rtol": 5e-11,
        "fp32_field_rtol": 3e-5,
    }


def test_source_physics_rejects_extra_uniaxial_and_cubic_channels() -> None:
    from tests.standard_problems.bimeron.goebel_2019.verify import (
        _goebel_material_has_only_expected_physics,
    )

    material = {
        "name": "Py",
        "saturation_magnetisation": 0.58e6,
        "exchange_stiffness": 15e-12,
        "damping": 0.3,
        "uniaxial_anisotropy_ku1": 0.8e6,
        "anisotropy_axis": [1.0, 0.0, 0.0],
    }
    assert _goebel_material_has_only_expected_physics(material)
    for extra_key in ("uniaxial_anisotropy_ku2", "cubic_anisotropy_kc1"):
        with_extra = {**material, extra_key: 1.0}
        assert not _goebel_material_has_only_expected_physics(with_extra)


def test_periodic_fem_lowers_same_physics_and_stages_as_fdm(monkeypatch) -> None:
    from fullmag.runtime.loader import load_problem_from_script
    from fullmag.runtime.run_config_export import RunConfigExportOptions, export_run_config

    for name in (
        "DEVICE",
        "RELAX_MAX_STEPS",
        "RELAX_TIME",
        "HOLD_TIME",
        "DT",
        "RELAX_FIELD_EVERY_STEPS",
        "HOLD_SAMPLE_PERIOD",
    ):
        monkeypatch.delenv("FULLMAG_GOEBEL_" + name, raising=False)

    def export(scenario):
        loaded = load_problem_from_script(ROOT / scenario, lightweight_assets=True)
        return export_run_config(
            loaded,
            loaded.to_ir(
                requested_backend=None,
                execution_mode=None,
                execution_precision=None,
                include_geometry_assets=False,
            ),
            options=RunConfigExportOptions(include_geometry_assets=False),
        )

    fem = export("scenario_fem_periodic.py")
    fdm = export("scenario_fdm.py")
    fem_ir = fem["ir"]
    fdm_ir = fdm["ir"]
    assert fem_ir["pbc"] == {
        "axes": ["periodic", "open", "open"],
        "demag": "periodic_airbox_k0",
    }
    assert fem_ir["geometry"] == fdm_ir["geometry"]
    assert fem_ir["materials"] == fdm_ir["materials"]
    assert fem_ir["magnets"][0]["initial_magnetization"] == (
        fdm_ir["magnets"][0]["initial_magnetization"]
    )
    assert fem_ir["energy_terms"] == [
        {"kind": "exchange"},
        {"kind": "demag", "realization": "poisson_robin"},
        {"kind": "rotated_interfacial_dmi", "D": 3e-3},
    ]
    metadata = fem_ir["problem_meta"]["runtime_metadata"]
    runtime = metadata["runtime_selection"]
    assert (runtime["backend"], runtime["device"]) == ("fem", "cpu")
    assert (runtime["execution_mode"], runtime["execution_precision"]) == ("strict", "double")
    mesh = metadata["mesh_workflow"]
    assert mesh["default_mesh"]["periodic_pair_ids"] == ["x_faces"]
    assert mesh["per_geometry"][0]["order"] == 1
    assert metadata["domain_frame"]["declared_universe"]["size"] == [500e-9, 120e-9, 80.5e-9]

    def stage_signature(config):
        return [
            (
                stage["entrypoint_kind"],
                stage["default_until_seconds"],
                stage["action"],
                stage["ir"]["study"],
            )
            for stage in config["stages"]
        ]

    assert stage_signature(fem) == stage_signature(fdm)


def test_x_periodic_airbox_authoring_stays_within_fem_time_domain() -> None:
    from dataclasses import replace

    import fullmag as fm
    import pytest
    from fullmag.model import BackendTarget
    from fullmag.runtime.loader import load_problem_from_script

    with pytest.raises(ValueError, match="requires x/y periodic axes and open z"):
        fm.FdmPbc(axes=(False, True, False), demag="periodic_airbox_k0")
    with pytest.raises(ValueError, match="requires x/y periodic axes and open z"):
        fm.FdmPbc(axes=(True, True, True), demag="periodic_airbox_k0")

    loaded = load_problem_from_script(ROOT / "scenario_fem_periodic.py", lightweight_assets=True)
    with pytest.raises(ValueError, match="periodic_airbox_k0.*FEM-only"):
        loaded.problem.to_ir(
            requested_backend=BackendTarget.FDM,
            include_geometry_assets=False,
        )

    modal = replace(loaded.problem, study=fm.Eigenmodes(count=1, outputs=(fm.SaveSpectrum(),)))
    with pytest.raises(ValueError, match="requires FEM relaxation or time evolution"):
        modal.to_ir(include_geometry_assets=False)


def test_layered_periodic_mesh_exports_canonical_facet_roles() -> None:
    import numpy as np

    from fullmag.meshing.persistence import mesh_data_from_ir
    from tests.standard_problems.bimeron.goebel_2019.periodic_tet4_mesh import build_mesh

    mesh = mesh_data_from_ir(build_mesh())
    mesh.validate_strict(eps_volume=1e-30 / 6)
    for marker, role in ((10, "material_interface"), (20, "exterior"),
                         (100, "periodic_seam"), (101, "periodic_seam")):
        selected = mesh.boundary_markers == marker
        assert np.any(selected)
        assert np.all(mesh.facet_roles[selected] == role)
    assert len(mesh.periodic_node_pairs) == np.unique(mesh.boundary_faces[mesh.boundary_markers == 100]).size
