from __future__ import annotations

from pathlib import Path

import fullmag as fm


def test_scoped_rdmi_gpu_probe_lowers_declared_geometry_grid_and_outputs(
    monkeypatch,
) -> None:
    monkeypatch.setenv("FULLMAG_RDMI_PROBE_D", "0.004")
    example = (
        Path(__file__).resolve().parents[3]
        / "examples"
        / "bimeron-cylinder-relax"
        / "verify_scoped_rdmi.py"
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
            "object_ids": ["selected"],
        }
    ]

    geometry = ir["geometry"]["entries"]
    assert geometry == [
        {"name": "selected_geom", "kind": "box", "size": [20e-9, 20e-9, 5e-9]},
        {
            "name": "excluded_geom",
            "kind": "translate",
            "base": {"name": "box", "kind": "box", "size": [20e-9, 20e-9, 5e-9]},
            "by": [0.0, 0.0, 10e-9],
        },
    ]
    magnets = {magnet["object_id"] for magnet in ir["magnets"]}
    assert magnets == {"selected", "excluded"}

    fdm = ir["backend_policy"]["discretization_hints"]["fdm"]
    expected_cell = [2.5e-9, 2.5e-9, 2.5e-9]
    assert fdm["default_cell"] == expected_cell
    assert {
        object_id: hint["cell"] for object_id, hint in fdm["per_magnet"].items()
    } == {"selected": expected_cell, "excluded": expected_cell}
    assert fdm["demag"]["common_cells"] == [8, 8, 2]
    assert "common_cell_size" not in fdm["demag"]

    pipeline_nodes = ir["problem_meta"]["runtime_metadata"]["study_pipeline"]["nodes"]
    assert [node["stage_kind"] for node in pipeline_nodes] == ["relax"]
    relax_node = next(node for node in pipeline_nodes if node["stage_kind"] == "relax")
    assert relax_node["payload"]["max_steps"] == "1"
    assert relax_node["payload"]["fixed_timestep"] == "1e-15"
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
        "H_rotated_dmi",
    ]
