from __future__ import annotations

import ast
from pathlib import Path

import fullmag as fm


def test_gpu_embedding_probe_lowers_geometry_scope_grids_and_step_outputs() -> None:
    example = (
        Path(__file__).resolve().parents[3]
        / "examples"
        / "bimeron-cylinder-relax"
        / "verify_gpu_embedding.py"
    )
    loaded = fm.load_problem_from_script(example, lightweight_assets=True)
    ir = loaded.to_ir(
        requested_backend=fm.BackendTarget.FDM,
        execution_mode=fm.ExecutionMode.STRICT,
        execution_precision=fm.ExecutionPrecision.DOUBLE,
        include_geometry_assets=False,
    )

    module = ast.parse(loaded.script_source)
    device_assignment = next(
        node
        for node in module.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "DEVICE" for target in node.targets)
    )
    assert ast.literal_eval(device_assignment.value) == "gpu"
    device_calls = [
        node
        for node in ast.walk(module)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "device"
    ]
    assert len(device_calls) == 1
    assert isinstance(device_calls[0].args[0], ast.Name)
    assert device_calls[0].args[0].id == "DEVICE"
    pbc_calls = [
        node
        for node in ast.walk(module)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "pbc"
    ]
    assert len(pbc_calls) == 1
    assert {
        keyword.arg: ast.literal_eval(keyword.value)
        for keyword in pbc_calls[0].keywords
    } == {"x": False, "y": False, "z": False}

    rotated = [
        term
        for term in ir["energy_terms"]
        if term["kind"] == "rotated_interfacial_dmi"
    ]
    assert rotated == [
        {
            "kind": "rotated_interfacial_dmi",
            "D": 0.004,
            "object_ids": ["lower-film"],
        }
    ]
    magnets = {magnet["object_id"]: magnet for magnet in ir["magnets"]}
    assert set(magnets) == {"lower-film", "upper-cylinder"}
    materials = {material["name"]: material for material in ir["materials"]}
    lower_material = materials[magnets["lower-film"]["material"]]
    upper_material = materials[magnets["upper-cylinder"]["material"]]
    assert lower_material["saturation_magnetisation"] == 580000.0
    assert lower_material["exchange_stiffness"] == 15e-12
    assert lower_material["uniaxial_anisotropy"] == 663920.0
    assert lower_material["anisotropy_axis"] == [1.0, 0.0, 0.0]
    assert upper_material["saturation_magnetisation"] == 1000000.0
    assert upper_material["exchange_stiffness"] == 10e-12
    assert upper_material["uniaxial_anisotropy"] == 0.0

    geometry = ir["geometry"]["entries"]
    assert geometry[0] == {
        "name": "lower_film_geom",
        "kind": "box",
        "size": [20e-9, 20e-9, 5e-9],
    }
    assert geometry[1]["name"] == "upper_cylinder_geom"
    assert geometry[1]["kind"] == "translate"
    assert geometry[1]["by"] == [0.0, 0.0, 10e-9]
    assert geometry[1]["base"]["kind"] == "cylinder"
    assert geometry[1]["base"]["radius"] == 5e-9
    assert geometry[1]["base"]["height"] == 10e-9

    fdm = ir["backend_policy"]["discretization_hints"]["fdm"]
    cell = [2.5e-9, 2.5e-9, 2.5e-9]
    assert fdm["default_cell"] == cell
    assert fdm["per_magnet"]["lower_film"]["cell"] == cell
    assert fdm["per_magnet"]["upper_cylinder"]["cell"] == cell
    assert fdm["demag"]["common_cells"] == [8, 8, 4]

    nodes = ir["problem_meta"]["runtime_metadata"]["study_pipeline"]["nodes"]
    assert [node["stage_kind"] for node in nodes] == ["relax"]
    relax_node = nodes[0]
    assert relax_node["payload"]["max_steps"] == "1"
    assert relax_node["payload"]["fixed_timestep"] == "1e-17"
    assert relax_node["payload"]["integrator"] == "heun"
    autosave = relax_node["payload"]["autosave"]
    assert autosave["table"]["quantities"] == [
        "step",
        "e_total",
        "e_rotated_dmi",
        "max_torque_T",
    ]
    assert [field["quantity"] for field in autosave["fields"]] == [
        "m",
        "H_demag",
        "H_rotated_dmi",
        "H_eff",
    ]
