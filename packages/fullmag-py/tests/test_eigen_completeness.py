"""Completeness requests survive authoring, scene export and canonical rewrite."""
import tempfile
import unittest
from pathlib import Path

import fullmag as fm
from fullmag.model.study import FemEigenSolverPolicy
from fullmag.runtime.script_builder import (
    export_builder_draft, rewrite_loaded_problem_script, render_scene_document_as_script,
)
from fullmag.runtime.scene_document import build_scene_document_from_builder

SCRIPT = '''import fullmag as fm
study = fm.study("completeness-contract")
study.engine("fem")
study.device("cpu", precision="double")
film = study.geometry(fm.Box(size=(40e-9, 40e-9, 10e-9)), name="film")
film.Ms = 800000.0
film.Aex = 13e-12
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.stages.add_eigenmodes(count=1, include_demag=False,
    solver_completeness="best_effort", solver_rtol=1e-8)
'''

class EigenCompletenessTests(unittest.TestCase):
    def test_policy_validates_choice_and_preserves_omitted_default(self):
        self.assertEqual(FemEigenSolverPolicy().to_ir(), {})
        for value in (True, 0, {}, [], "", "complete", "BEST_EFFORT"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                FemEigenSolverPolicy(completeness=value)
        for value in ("best_effort", "certified_count"):
            self.assertEqual(FemEigenSolverPolicy(completeness=value).to_ir(),
                             {"completeness": value})

    def test_explicit_clear_and_invalid_rewrite_are_not_silently_inherited(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "input.py"
            source.write_text(SCRIPT)
            loaded = fm.load_problem_from_script(source, lightweight_assets=True)
            for value in (None, ""):
                rewritten = rewrite_loaded_problem_script(loaded, overrides={"stages": [
                    {"kind": "eigenmodes", "eigen_solver_completeness": value}
                ]})["rendered_source"]
                self.assertNotIn("solver_completeness=", rewritten)
                self.assertIn("solver_rtol=1e-08", rewritten)
            for value in (False, {}, "invalid"):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    rewrite_loaded_problem_script(loaded, overrides={"stages": [
                        {"kind": "eigenmodes", "eigen_solver_completeness": value}
                    ]})

    def test_completeness_survives_script_and_scene_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "input.py"
            source.write_text(SCRIPT)
            loaded = fm.load_problem_from_script(source, lightweight_assets=True)
            expected = {"completeness": "best_effort", "residual_tolerance": 1e-8}
            self.assertEqual(loaded.stages[0].problem.study.solver_policy.to_ir(), expected)
            scene = build_scene_document_from_builder(export_builder_draft(loaded))
            sources = [rewrite_loaded_problem_script(loaded)["rendered_source"],
                       render_scene_document_as_script(scene)]
            for index, content in enumerate(sources):
                with self.subTest(index=index):
                    path = Path(tmp) / f"roundtrip{index}.py"
                    path.write_text(content)
                    actual = fm.load_problem_from_script(path, lightweight_assets=True)
                    self.assertEqual(actual.stages[0].problem.study.solver_policy.to_ir(), expected)
                    self.assertEqual(actual.stages[0].problem.to_ir()["problem_meta"]
                                     ["runtime_metadata"]["modal_solver_policy"], expected)

if __name__ == "__main__":
    unittest.main()
