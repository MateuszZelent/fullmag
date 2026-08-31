from __future__ import annotations

import ast
import json
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
    assert values["CELL"] == (1e-9, 1e-9, 0.5e-9)
    assert values["BIMERON_RADIUS"] == 10e-9
    assert values["BIMERON_WALL_WIDTH"] == 3e-9
    assert values["LLG_HOLD_TIME"] == 1e-9


def test_fdm_scenario_is_strict_fp64_periodic_x_with_relax_and_hold() -> None:
    module = _module("scenario_fdm.py")
    source = ast.unparse(module)
    assert "study.engine('fdm')" in source
    assert "study.device(REQUESTED_DEVICE, precision='double')" in source
    assert "study.mode('strict')" in source
    assert "study.cell(*CELL)" in source
    assert "study.pbc(x=True, demag='truncated_images')" in source
    assert len(_calls(module, "RotatedInterfacialDMI")) == 1
    assert len(_calls(module, "bimeron")) == 1
    assert len(_calls(module, "add_relax")) == 1
    assert "algorithm='llg_overdamped'" in source
    assert "dt=HOLD_DT" in source
    assert len(_calls(module, "add_run")) == 1
    assert len(_calls(module, "add_save_state")) == 2


def test_fem_scenario_preserves_one_exact_prism_layer_and_periodic_x() -> None:
    module = _module("scenario_fem.py")
    source = ast.unparse(module)
    assert "study.engine('fem')" in source
    assert "study.device(REQUESTED_DEVICE, precision='double')" in source
    assert "study.mode('strict')" in source
    assert "study.pbc(x=True, demag='truncated_images')" in source
    assert "topology='prismatic'" in source
    assert "layers=1" in source
    assert "exact_layers=True" in source
    assert "study.demag(realization='poisson_robin')" in source
    assert len(_calls(module, "RotatedInterfacialDMI")) == 1
    assert len(_calls(module, "add_relax")) == 1
    assert "algorithm='llg_overdamped'" in source
    assert "dt=HOLD_DT" in source
    assert len(_calls(module, "add_run")) == 1
    assert len(_calls(module, "add_save_state")) == 2


def test_thresholds_are_source_frozen() -> None:
    thresholds = json.loads((ROOT / "thresholds.v1.json").read_text(encoding="utf-8"))
    assert thresholds == {
        "schema_version": "goebel-bimeron-thresholds.v1",
        "min_abs_topological_charge": 0.8,
        "min_core_abs_mz": 0.5,
        "min_background_mx": 0.8,
        "fdm_cpu_gpu_fp64_field_rtol": 2e-12,
        "fem_cpu_gpu_fp64_residual_rtol": 5e-11,
        "fp32_field_rtol": 3e-5,
    }
