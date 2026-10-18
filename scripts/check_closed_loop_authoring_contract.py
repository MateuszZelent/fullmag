"""Execute public decoder/export/materializer inputs; native Rust validator still needs build proof."""
import argparse
from copy import deepcopy
from dataclasses import replace
import json
from pathlib import Path

import fullmag as fm
from fullmag.model.problem import BackendTarget, DeviceTarget
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import _decode_current_transport
from fullmag.runtime.script_builder import render_scene_document_as_script

parser = argparse.ArgumentParser()
parser.add_argument("scene", type=Path)
parser.add_argument("evidence", type=Path)
parser.add_argument("--materialize", action="store_true")
args = parser.parse_args()
args.evidence.mkdir(parents=True, exist_ok=True)
scene = json.loads(args.scene.read_text(encoding="utf-8-sig"))
current = scene["current_transports"][0]
checks = 0
assert _decode_current_transport(current).to_ir()["structured_current_closure"] == current["structured_current_closure"]
checks += 1
for path, value in [
    (("structured_current_closure", "schema_version"), "structured_current_closure.v9"),
    (("structured_current_closure", "source_cuts", 0, "plane", "coordinate_frame"), "world"),
    (("structured_current_closure", "source_cuts", 0, "plane", "axis"), "x"),
    (("structured_current_closure", "source_cuts", 0, "drive", "potential_jump_V"), 0),
    (("solver", "operator_version"), "fv_charge_harmonic_source_cut_v1"),
    (("gauge",), "terminal_reference"),
]:
    invalid = deepcopy(current)
    target = invalid
    for key in path[:-1]: target = target[key]
    target[path[-1]] = value
    try:
        _decode_current_transport(invalid)
    except (ValueError, TypeError):
        checks += 1
    else:
        raise AssertionError(f"Invalid public charge contract accepted: {path}")
legacy = deepcopy(current)
legacy["structured_current_closure"]["schema_version"] = "structured_current_closure.v1"
cut = legacy["structured_current_closure"]["source_cuts"][0]
cut["plane"] = {"axis": "x", "offset_m": 0.0, "normal": "positive_axis"}
cut["region"] = {"object_id": "object"}
legacy["solver"]["operator_version"] = "fv_charge_harmonic_source_cut_v1"
legacy["materials"] = [{"region": {"object_id": "object"}, "material": {"sigma_Spm": 5.8e7}}]
legacy["boundaries"] = [{"id": "outer", "kind": "insulating", "surfaces": [{"object_id": "object", "surface_id": "outer", "orientation": [0, 0, 1]}]}]
legacy_ir = _decode_current_transport(legacy).to_ir()
assert legacy_ir["structured_current_closure"] == legacy["structured_current_closure"]
checks += 1
script = args.evidence / "actual-ui-authoring-roundtrip.py"
script.write_text(render_scene_document_as_script(scene), encoding="utf-8", newline="\n")
loaded = load_problem_from_script(script, lightweight_assets=True)
authored = loaded.problem.to_ir(include_geometry_assets=False)
assert authored["current_modules"][0]["structured_current_closure"] == current["structured_current_closure"]
assert authored["antenna_port_modes"] == scene["antenna_port_modes"]
checks += 2
if args.materialize:
    # Explicitly choose the supported execution lane for this separate contract check.
    problem = replace(loaded.problem,
        discretization=fm.DiscretizationHints(fem=fm.FEM(maximum_element_size=0.15e-6, order=1)),
        runtime=fm.RuntimeSelection(backend_target=BackendTarget.FEM, device_target=DeviceTarget.CPU))
    materialized = problem.to_ir(include_geometry_assets=True)
    transport = materialized["current_modules"][0]
    source = transport["conservative_current_source"]
    assert source["schema_version"] == "conservative_current_source.v2"
    assert source["kind"] == "closed_geometry_potential_jump" and source["object_id"] == "object"
    assert "structured_current_closure" not in transport
    assert transport["gauge"] == "zero_mean" and len(source["material_parts"]) == 4
    assert len(source["terminal_observations"]) == 4
    (args.evidence / "actual-ui-prepared-source.json").write_text(json.dumps(source, indent=2), encoding="utf-8")
    checks += 5
print(f"PASS {checks} interpreted public Python contract checks; Rust validation/native solve/browser NOT VERIFIED")
