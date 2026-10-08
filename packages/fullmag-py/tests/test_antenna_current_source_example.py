from __future__ import annotations

from collections import Counter
from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import runpy
from tempfile import TemporaryDirectory
import unittest

import fullmag as fm
import fullmag.world as world
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.helper import _runtime_stage_action, main as helper_main
from fullmag.runtime.script_builder import render_loaded_problem_as_script


EXAMPLE = Path(__file__).resolve().parents[3] / "examples" / "fem_antenna_current_source_inspection.py"


def boundary_faces(mesh: dict) -> set[tuple[int, ...]]:
    cells = mesh["cells"]
    incidence = Counter()
    for start, stop in zip(cells["offsets"], cells["offsets"][1:]):
        tet = cells["nodes"][start:stop]
        for omitted in range(4):
            incidence[tuple(sorted(tet[:omitted] + tet[omitted + 1:]))] += 1
    return {face for face, count in incidence.items() if count == 1}


class AntennaCurrentSourceExampleTests(unittest.TestCase):
    def setUp(self):
        fm.reset()

    def tearDown(self):
        fm.reset()

    def test_stage_first_example_has_no_time_evolution_or_legacy_source(self):
        loaded = load_problem_from_script(EXAMPLE, lightweight_assets=True)
        ir = loaded.problem.to_ir(include_geometry_assets=False)
        pipeline = loaded.study_pipeline_document()
        self.assertEqual([node["stage_kind"] for node in pipeline["nodes"]], ["antenna_field_solve"])
        self.assertEqual(len(loaded.stages), 1)
        self.assertEqual(ir["backend_policy"]["requested_backend"], "fem")
        self.assertEqual(ir["backend_policy"]["execution_precision"], "double")
        self.assertEqual(ir["validation_profile"]["execution_mode"], "strict")
        self.assertEqual(ir["problem_meta"]["runtime_metadata"]["runtime_selection"]["device"], "cpu")
        self.assertEqual(len(ir["magnets"]), 1)
        self.assertEqual(ir["magnets"][0]["name"], "probe")
        definition = ir["current_modules"][0]
        self.assertEqual(definition["conservative_current_source"]["kind"], "external_lead_current")
        self.assertNotIn("conservative_current_view", definition)
        self.assertNotIn("conservative_current_view_ref", ir["antenna_field_solve_stages"][0])
        for key in ("spin_transport_modules", "solved_antenna_drives", "antenna_target_projections", "antenna_spectrum_requests"):
            self.assertFalse(ir.get(key))

    def test_script_export_preserves_source_port_target_and_stage(self):
        loaded = load_problem_from_script(EXAMPLE, lightweight_assets=True)
        before = loaded.problem.to_ir(include_geometry_assets=False, source_root=EXAMPLE.parent)
        rendered = render_loaded_problem_as_script(loaded)
        fm.reset()
        exec(rendered, {})
        after = world._build_problem().to_ir(include_geometry_assets=False, source_root=EXAMPLE.parent)
        for key in ("current_modules", "antenna_port_modes", "antenna_field_solve_stages", "geometry"):
            self.assertEqual(after[key], before[key], key)
        self.assertNotIn("add_run(", rendered)
        self.assertNotIn("add_relax(", rendered)

    def test_run_config_references_canonical_antenna_definition(self):
        output = StringIO()
        with redirect_stdout(output):
            result = helper_main([
                "export-run-config", "--script", str(EXAMPLE), "--skip-geometry-assets",
            ])
        self.assertEqual(result, 0)
        config = json.loads(output.getvalue())
        self.assertEqual(len(config["stages"]), 1)
        stage = config["stages"][0]
        self.assertEqual(stage["action"], {
            "kind": "antenna_field_solve", "stage_id": "inspect_antenna", "port_mode_ids": ["port"],
        })
        definitions = stage["ir"]["antenna_field_solve_stages"]
        self.assertEqual(len(definitions), 1)
        self.assertEqual(definitions[0]["id"], stage["action"]["stage_id"])
        self.assertEqual(definitions[0]["port_mode_ids"], stage["action"]["port_mode_ids"])
        self.assertEqual(definitions, config["ir"]["antenna_field_solve_stages"])

    def test_runtime_lowering_keeps_captured_definition_and_prior_stages_detached(self):
        definition = {"id": "current", "port_mode_ids": ["port"]}
        action = {"kind": "antenna_field_solve", "definition": definition}
        prior = {"id": "prior", "port_mode_ids": ["prior-port"]}
        stage_ir = {"antenna_field_solve_stages": [prior]}
        lowered = _runtime_stage_action(action, stage_ir=stage_ir)
        self.assertEqual(stage_ir["antenna_field_solve_stages"], [prior, definition])
        stage_ir["antenna_field_solve_stages"][1]["port_mode_ids"].append("changed")
        lowered["port_mode_ids"].append("changed")
        self.assertEqual(definition, {"id": "current", "port_mode_ids": ["port"]})
        self.assertEqual(stage_ir["antenna_field_solve_stages"][0], prior)

    def test_multi_stage_run_config_never_imports_future_solve_definitions(self):
        source = EXAMPLE.read_text(encoding="utf-8")
        source = source.replace("ROOT = Path(__file__).resolve().parent", f"ROOT = Path({str(EXAMPLE.parent)!r})")
        source = source.replace("study.stages.add_antenna_field_solve(",
                                'study.stages.add_run(1e-12, stage_id="earlier")\n'
                                "study.stages.add_antenna_field_solve(", 1)
        source += ('\nfrom dataclasses import replace\nimport fullmag.world as world\n'
                   'study.stages.add_antenna_field_solve(id="second", definition=replace(\n'
                   '    world._build_problem().antenna_field_solve_stages[0], id="second"))\n')
        with TemporaryDirectory() as directory:
            script = Path(directory) / "multi_stage.py"
            script.write_text(source, encoding="utf-8")
            output = StringIO()
            with redirect_stdout(output):
                result = helper_main([
                    "export-run-config", "--script", str(script), "--skip-geometry-assets",
                ])
            self.assertEqual(result, 0)
            config = json.loads(output.getvalue())
        expected = [[], ["inspect_antenna"], ["inspect_antenna", "second"]]
        self.assertEqual(len(config["stages"]), 3)
        for stage, identifiers in zip(config["stages"], expected, strict=True):
            self.assertEqual([item["id"] for item in stage["ir"]["antenna_field_solve_stages"]], identifiers)
        self.assertIsNone(config["stages"][0]["action"])
        for stage, identifier in zip(config["stages"][1:], ("inspect_antenna", "second"), strict=True):
            self.assertEqual(stage["action"], {
                "kind": "antenna_field_solve", "stage_id": identifier, "port_mode_ids": ["port"],
            })
        self.assertEqual([item["id"] for item in config["ir"]["antenna_field_solve_stages"]], expected[-1])

    def test_runtime_lowering_reuses_equal_definition_and_rejects_conflict(self):
        definition = {"id": "current", "port_mode_ids": ["port"]}
        action = {"kind": "antenna_field_solve", "definition": definition}
        stage_ir = {"antenna_field_solve_stages": [definition.copy()]}
        _runtime_stage_action(action, stage_ir=stage_ir)
        self.assertEqual(len(stage_ir["antenna_field_solve_stages"]), 1)
        stage_ir["antenna_field_solve_stages"] = [{"id": "current", "port_mode_ids": ["other"]}]
        with self.assertRaisesRegex(ValueError, "conflicting antenna field solve id"):
            _runtime_stage_action(action, stage_ir=stage_ir)

    def test_runtime_lowering_rejects_missing_definition_and_preserves_other_actions(self):
        with self.assertRaisesRegex(ValueError, "requires a serialized field-solve definition"):
            _runtime_stage_action({"kind": "antenna_field_solve"}, stage_ir={})
        for action in (None, {"kind": "save_state", "artifact_name": "saved"},
                       {"kind": "change_device", "device": "cpu"}):
            self.assertIs(_runtime_stage_action(action, stage_ir={}), action)

    def test_actual_lowering_binds_both_original_imported_mesh_assets(self):
        loaded = load_problem_from_script(EXAMPLE, lightweight_assets=True)
        ir = loaded.problem.to_ir(source_root=EXAMPLE.parent)
        assets = {asset["geometry_name"]: asset for asset in ir["geometry_assets"]["fem_mesh_assets"]}
        self.assertEqual(set(assets), {"antenna", "probe_geom"})
        for name, path in (("antenna", EXAMPLE.parent / "assets" / "fem_antenna_current_source.mesh.json"),
                           ("probe_geom", EXAMPLE.parent / "assets" / "fem_antenna_current_probe.mesh.json")):
            self.assertEqual(assets[name]["mesh"], json.loads(path.read_text(encoding="utf-8")))
            self.assertEqual(Path(assets[name]["mesh_source"]), path)

    def test_source_mesh_interfaces_and_signed_currents_are_physical_inputs(self):
        values = runpy.run_path(str(EXAMPLE))
        source = values["source"].to_ir()
        device = json.loads(values["SOURCE_MESH"].read_text(encoding="utf-8"))
        lead = source["lead_mesh"]
        device_ids = source["device_stable_vertex_ids"]
        lead_ids = source["lead_stable_vertex_ids"]
        device_xyz = dict(zip(device_ids, device["nodes"]))
        lead_xyz = dict(zip(lead_ids, lead["nodes"]))
        device_outer = {tuple(sorted(device_ids[v] for v in face)) for face in boundary_faces(device)}
        lead_outer = {tuple(sorted(lead_ids[v] for v in face)) for face in boundary_faces(lead)}
        for pair in source["interface_pairs"]:
            self.assertIn(tuple(sorted(pair["device_face_vertex_ids"])), device_outer)
            self.assertIn(tuple(sorted(pair["lead_face_vertex_ids"])), lead_outer)
            for device_id, lead_id in pair["vertex_pairs"]:
                self.assertEqual(device_xyz[device_id], lead_xyz[lead_id])
        paired = {tuple(sorted(pair["lead_face_vertex_ids"])) for pair in source["interface_pairs"]}
        terminal_faces = set()
        for terminal in source["outer_terminals"]:
            for face in terminal["boundary_face_vertex_ids"]:
                face = tuple(sorted(face))
                self.assertIn(face, lead_outer)
                self.assertNotIn(face, paired | terminal_faces)
                terminal_faces.add(face)
        currents = source["drives"][0]["outer_terminal_currents_a"]
        self.assertEqual(currents, {"outer-signal-in": -1.0, "outer-signal-out": 1.0,
                                    "outer-return-in": 1.0, "outer-return-out": -1.0})
        for branch in ("signal", "return"):
            self.assertEqual(currents[f"outer-{branch}-in"] + currents[f"outer-{branch}-out"], 0.0)
        weights = [branch.signed_weight for branch in values["port"].branches]
        self.assertEqual(weights, [1.0, -1.0])
        self.assertEqual(sum(weights), 0.0)
        self.assertEqual(len(device_ids), len(device["nodes"]))
        self.assertEqual(len(lead_ids), len(lead["nodes"]))
        self.assertFalse(set(device_ids) & set(lead_ids))

    def test_all_cells_have_positive_volume_and_probe_is_outside_source(self):
        values = runpy.run_path(str(EXAMPLE))
        meshes = [json.loads(values[name].read_text(encoding="utf-8")) for name in ("SOURCE_MESH", "PROBE_MESH")]
        meshes.append(values["source"].to_ir()["lead_mesh"])
        for mesh in meshes:
            cells = mesh["cells"]
            for start, stop in zip(cells["offsets"], cells["offsets"][1:]):
                points = [mesh["nodes"][v] for v in cells["nodes"][start:stop]]
                a, b, c = [[p[i] - points[0][i] for i in range(3)] for p in points[1:]]
                determinant = (a[0] * (b[1] * c[2] - b[2] * c[1])
                               - a[1] * (b[0] * c[2] - b[2] * c[0])
                               + a[2] * (b[0] * c[1] - b[1] * c[0]))
                self.assertGreater(determinant, 0.0)
        self.assertGreaterEqual(min(p[2] for p in meshes[1]["nodes"]), 2.0)
        self.assertEqual(max(p[2] for mesh in (meshes[0], meshes[2]) for p in mesh["nodes"]), 1.0)


if __name__ == "__main__":
    unittest.main()
