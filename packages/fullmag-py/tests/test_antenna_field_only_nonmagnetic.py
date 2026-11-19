"""Interpreted field-only authoring and round-trip; no native solve is invoked."""
import os
from pathlib import Path
import shutil
import tempfile
import unittest

import fullmag as fm
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.script_builder import (
    export_builder_draft, render_loaded_problem_as_script, render_scene_document_as_script,
)
from fullmag.runtime.scene_document import build_scene_document_from_builder


FIXTURE = Path(__file__).resolve().parents[3] / "examples" / "fem_antenna_field_only_nonmagnetic.py"


class AntennaFieldOnlyTests(unittest.TestCase):
    def setUp(self):
        root = Path(os.environ["FULLMAG_TEST_TEMP_ROOT"]).resolve(strict=True)
        self.temp = tempfile.TemporaryDirectory(dir=root)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        assets = self.root / "assets"
        assets.mkdir()
        for filename in ("fem_antenna_current_source.mesh.json", "fem_antenna_current_probe.mesh.json"):
            shutil.copyfile(FIXTURE.parent / "assets" / filename, assets / filename)

    def test_public_fixture_and_both_exports_have_no_magnetic_state(self):
        loaded = load_problem_from_script(FIXTURE, lightweight_assets=True)
        draft = export_builder_draft(loaded)
        scripts = (render_loaded_problem_as_script(loaded),
                   render_scene_document_as_script(build_scene_document_from_builder(draft)))
        for index, script in enumerate(scripts):
            self.assertNotIn(".Ms =", script)
            self.assertNotIn(".Aex =", script)
            path = self.root / f"export-{index}.py"
            path.write_text(script, encoding="utf-8")
            result = load_problem_from_script(path, lightweight_assets=True)
            self.assertEqual(len(result.stages), 1)
            self.assertIsInstance(result.problem.study, fm.AntennaFieldSolve)
            ir = result.problem.to_ir(source_root=self.root)
            self.assertEqual(ir["study"], {"kind": "antenna_field_solve", "sampling": {"outputs": []}})
            self.assertEqual(ir["magnets"], [])
            self.assertEqual(ir["materials"], [])
            self.assertEqual(ir["energy_terms"], [])
            self.assertEqual(len(ir["geometry_assets"]["fem_mesh_assets"]), 2)
            self.assertEqual(result.stages[0].action["kind"], "antenna_field_solve")
            original = export_builder_draft(loaded)
            exported = export_builder_draft(result)
            self.assertEqual(exported["antenna_port_modes"], original["antenna_port_modes"])
            self.assertEqual(exported["antenna_field_solve_stages"], original["antenna_field_solve_stages"])

    def test_closed_loop_scene_keeps_unauthored_integrator_without_magnetism(self):
        fixture = FIXTURE.parent / "fem_antenna_closed_loop_nonmagnetic.py"
        loaded = load_problem_from_script(fixture, lightweight_assets=True)
        draft = export_builder_draft(loaded)
        self.assertIsNone(draft["solver"]["integrator"])
        scene = build_scene_document_from_builder(draft)
        self.assertEqual(scene["study"]["solver"]["integrator"], "")
        self.assertIsNone(draft["solver"]["integrator"])
        self.assertEqual(scene["materials"], [])
        self.assertEqual(scene["magnetization_assets"], [])
        self.assertEqual([stage["kind"] for stage in scene["study"]["stages"]],
                         ["antenna_field_solve"])
        self.assertNotIn(".solver(", render_scene_document_as_script(scene))
        draft["solver"]["integrator"] = "rk45"
        self.assertEqual(build_scene_document_from_builder(draft)["study"]["solver"]["integrator"], "rk45")

    def test_field_only_rejects_magnetic_sampling_and_constraints(self):
        with self.assertRaises(ValueError):
            fm.FieldOnly(outputs=[object()])
        with self.assertRaises(ValueError):
            fm.FieldOnly(constraints=[object()])

    def test_run_and_relax_still_require_magnets(self):
        source = FIXTURE.read_text(encoding="utf-8")
        for action, error in (("study.stages.add_run(until=1e-12)", TypeError),
                              ("study.stages.add_relax()", ValueError)):
            path = self.root / "invalid.py"
            path.write_text(source + "\n" + action + "\n", encoding="utf-8")
            with self.assertRaises(error):
                load_problem_from_script(path, lightweight_assets=True)


if __name__ == "__main__":
    unittest.main()
