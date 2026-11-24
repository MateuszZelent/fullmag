"""Closed GSG public authoring checks; no native solve or LLG qualification."""
from pathlib import Path
import unittest

from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import (
    export_builder_draft, render_loaded_problem_as_script, render_scene_document_as_script,
)

EXAMPLE = Path(__file__).resolve().parents[3] / "examples" / "fem_antenna_sushruth_2020_closed_gsg.py"


class SushruthClosedGsgExampleTests(unittest.TestCase):
    def test_voltage_driven_closed_circuit_and_separate_nonmagnetic_sample(self):
        loaded = load_problem_from_script(EXAMPLE, lightweight_assets=True)
        draft = export_builder_draft(loaded)
        objects = {row["object_id"]: row for row in draft["geometries"]}
        self.assertEqual(objects["antenna"]["role"], "antenna")
        self.assertEqual(objects["sampling"]["role"], "geometry")
        for actual, expected in zip(objects["antenna"]["bounds_min"], [-550e-9, -12e-6, 30e-9]):
            self.assertAlmostEqual(actual, expected, delta=1e-18)
        for actual, expected in zip(objects["antenna"]["bounds_max"], [550e-9, 12e-6, 120e-9]):
            self.assertAlmostEqual(actual, expected, delta=1e-18)
        self.assertAlmostEqual(objects["sampling"]["bounds_min"][2], -22.4e-9, delta=1e-18)
        self.assertAlmostEqual(objects["sampling"]["bounds_max"][2], -5e-9, delta=1e-18)
        self.assertEqual(len(loaded.stages), 1)
        self.assertEqual(loaded.stages[0].action["kind"], "antenna_field_solve")
        self.assertEqual(loaded.problem.antenna_field_solve_stages[0].solver_policy, "volume_inspection_v1")
        self.assertEqual(draft["requested_backend"], "fem")
        self.assertEqual(draft["requested_device"], "cpu")
        self.assertEqual(draft["requested_precision"], "double")
        ir = loaded.problem.to_ir(include_geometry_assets=False)
        self.assertEqual(ir["magnets"], [])
        self.assertEqual(ir["energy_terms"], [])
        self.assertEqual(draft["solved_antenna_drives"], [])
        self.assertEqual(draft["antenna_spectrum_requests"], [])
        module = draft["current_modules"][0]
        self.assertIsNone(module.get("external_lead_preparation"))
        self.assertEqual(tuple(loaded.problem.current_modules[0].boundaries), ())
        self.assertNotIn("boundaries", module)
        self.assertEqual(len(module["materials"]), 5)
        closure = module["structured_current_closure"]
        self.assertEqual(closure["schema_version"], "structured_current_closure.v2")
        self.assertEqual(len(closure["source_cuts"]), 1)
        cut = closure["source_cuts"][0]
        self.assertEqual(cut["region"], {"object_id":"antenna", "region_id":"inlet"})
        self.assertEqual(cut["plane"]["coordinate_frame"], "object")
        self.assertEqual(cut["plane"]["axis"], "x")
        self.assertEqual(cut["plane"]["offset_m"], -1e-6)
        self.assertEqual(cut["drive"]["potential_jump_V"], 1e-3)
        port = draft["antenna_port_modes"][0]
        self.assertEqual(port["schema_version"], "antenna_port_mode.v3")
        self.assertEqual({branch["id"] for branch in port["branches"]}, {"signal", "ground_left", "ground_right"})
        self.assertTrue(all(branch["signed_weight"] == 0.0 for branch in port["branches"]))

    def test_python_and_scene_round_trip_preserves_source_and_field_stage(self):
        original = EXAMPLE.read_bytes()
        loaded = load_problem_from_script(EXAMPLE, source_bytes=original, lightweight_assets=True)
        draft = export_builder_draft(loaded)
        scripts = (render_loaded_problem_as_script(loaded),
                   render_scene_document_as_script(build_scene_document_from_builder(draft)))
        for script in scripts:
            restored = load_problem_from_script(EXAMPLE, source_bytes=script.encode(), lightweight_assets=True)
            result = export_builder_draft(restored)
            for key in ("current_modules", "antenna_port_modes", "antenna_field_solve_stages", "geometries"):
                self.assertEqual(result[key], draft[key], key)
        self.assertEqual(EXAMPLE.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
