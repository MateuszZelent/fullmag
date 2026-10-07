from __future__ import annotations

import ast
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import unittest

import fullmag as fm
import fullmag.world as world
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.script_builder import render_loaded_problem_as_script


ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "examples" / "fem_antenna_current_source_inspection.py"
DOCUMENT = ROOT / "docs" / "physics" / "0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md"


def documented_script() -> str:
    chapter = DOCUMENT.read_text(encoding="utf-8").split("(antenna-python-api)=", 1)[1]
    chapter = chapter.split("(antenna-problem-ir)=", 1)[0]
    return chapter.split(chr(96) * 3 + "python\n", 1)[1].split(chr(96) * 3, 1)[0]


class AntennaDocumentedExampleTests(unittest.TestCase):
    def setUp(self):
        fm.reset()

    def tearDown(self):
        fm.reset()

    def test_first_documented_script_is_the_current_stage_first_example(self):
        source = documented_script()
        ast.parse(source)
        self.assertEqual(source.strip(), EXAMPLE.read_text(encoding="utf-8").strip())

    def test_copied_documented_script_preserves_ir_and_round_trip_without_solver(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "assets").mkdir()
            for name in ("fem_antenna_current_source.mesh.json", "fem_antenna_current_probe.mesh.json"):
                shutil.copyfile(EXAMPLE.parent / "assets" / name, root / "assets" / name)
            script = root / "documented_antenna.py"
            script.write_text(documented_script(), encoding="utf-8")
            reference_script = root / "reference_antenna.py"
            shutil.copyfile(EXAMPLE, reference_script)
            loaded = load_problem_from_script(script, lightweight_assets=True)
            actual = loaded.problem.to_ir(include_geometry_assets=False, source_root=root)
            pipeline = loaded.study_pipeline_document()
            self.assertEqual([node["stage_kind"] for node in pipeline["nodes"]], ["antenna_field_solve"])
            rendered = render_loaded_problem_as_script(loaded)
            fm.reset()
            exec(rendered, {})
            round_trip = world._build_problem().to_ir(include_geometry_assets=False, source_root=root)
            fm.reset()
            expected = load_problem_from_script(reference_script, lightweight_assets=True).problem.to_ir(
                include_geometry_assets=False, source_root=root)
            for key in ("current_modules", "antenna_port_modes", "antenna_field_solve_stages", "geometry",
                        "backend_policy", "validation_profile"):
                self.assertEqual(actual[key], expected[key], key)
                self.assertEqual(round_trip[key], actual[key], key)
            for key in ("solved_antenna_drives", "antenna_target_projections", "antenna_spectrum_requests"):
                self.assertFalse(actual.get(key))
            self.assertNotIn("add_run(", rendered)
            self.assertNotIn("add_relax(", rendered)


if __name__ == "__main__":
    unittest.main()
