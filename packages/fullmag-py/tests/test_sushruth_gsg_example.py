"""Public GSG authoring and round-trip checks; no native solve."""
from pathlib import Path
import unittest

from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import (
    export_builder_draft, render_loaded_problem_as_script, render_scene_document_as_script,
)


EXAMPLE = Path(__file__).resolve().parents[3] / "examples" / "fem_antenna_sushruth_2020_gsg.py"


class SushruthGsgExampleTests(unittest.TestCase):
    def test_public_input_has_six_balanced_terminals_and_separate_nonmagnetic_target(self):
        loaded = load_problem_from_script(EXAMPLE, lightweight_assets=True)
        draft = export_builder_draft(loaded)
        objects = {row["object_id"]: row for row in draft["geometries"]}
        self.assertEqual(objects["antenna"]["role"], "antenna")
        self.assertEqual(objects["sampling"]["role"], "geometry")
        self.assertNotEqual(objects["antenna"]["name"], objects["antenna"]["object_id"])
        self.assertEqual(objects["antenna"]["bounds_min"], [-550e-9, -10e-6, 30e-9])
        self.assertEqual(objects["antenna"]["bounds_max"], [550e-9, 10e-6, 120e-9])
        self.assertEqual(len(loaded.stages), 1)
        self.assertEqual(loaded.stages[0].action["kind"], "antenna_field_solve")
        self.assertEqual(draft["requested_backend"], "fem")
        self.assertEqual(draft["requested_device"], "cpu")
        self.assertEqual(draft["requested_precision"], "double")
        self.assertEqual(draft["solved_antenna_drives"], [])
        self.assertEqual(draft["antenna_spectrum_requests"], [])
        ir = loaded.problem.to_ir(include_geometry_assets=False)
        self.assertEqual(ir["magnets"], [])
        self.assertEqual(ir["energy_terms"], [])

        source = draft["current_modules"][0]["external_lead_preparation"]
        extensions = {row["id"]: row for row in source["extensions"]}
        currents = source["drives"][0]["outer_terminal_currents_a"]
        self.assertEqual(len(extensions), 6)
        self.assertEqual(set(currents), set(extensions))
        self.assertEqual(len({row["boundary_markers"][0] for row in extensions.values()}), 6)
        for part, current in (("signal", 1e-3), ("ground_left", -0.5e-3), ("ground_right", -0.5e-3)):
            self.assertEqual(currents[f"{part}_in"], -current)
            self.assertEqual(currents[f"{part}_out"], current)
            self.assertEqual(currents[f"{part}_in"] + currents[f"{part}_out"], 0.0)
            self.assertEqual(extensions[f"{part}_in"]["outward_direction_xyz"], [0.0, -1.0, 0.0])
            self.assertEqual(extensions[f"{part}_out"]["outward_direction_xyz"], [0.0, 1.0, 0.0])

    def test_python_and_scene_exports_preserve_current_geometry_and_stage_intent(self):
        original = EXAMPLE.read_bytes()
        loaded = load_problem_from_script(EXAMPLE, source_bytes=original, lightweight_assets=True)
        draft = export_builder_draft(loaded)
        scripts = (render_loaded_problem_as_script(loaded),
                   render_scene_document_as_script(build_scene_document_from_builder(draft)))
        for script in scripts:
            with self.subTest(surface="scene" if "scene" in script[:100] else "python"):
                rebuilt = load_problem_from_script(EXAMPLE, source_bytes=script.encode(), lightweight_assets=True)
                result = export_builder_draft(rebuilt)
                for key in ("current_modules", "antenna_port_modes", "antenna_field_solve_stages",
                            "geometries", "solved_antenna_drives", "antenna_spectrum_requests"):
                    self.assertEqual(result[key], draft[key], key)
                self.assertNotIn(".Ms =", script)
                self.assertNotIn(".Aex =", script)
        self.assertEqual(EXAMPLE.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
