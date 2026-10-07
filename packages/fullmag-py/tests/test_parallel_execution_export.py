"""Public script round-trip checks; no native solver or build is executed."""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import fullmag as fm
from fullmag.runtime.script_builder import rewrite_loaded_problem_script


MODEL = '''import fullmag as fm
study = fm.study("signed_k_policy_roundtrip")
study.engine("fem")
study.device("cpu", precision="double")
study.parallel_execution(mode="adaptive", max_cpu_percent=75, max_workers=3)
body = study.geometry(fm.Box(40e-9, 40e-9, 10e-9), name="film")
body.Ms = 800e3
body.Aex = 13e-12
body.m = fm.texture.uniform(1, 0, 0)
study.pbc(x=True, y=True)
study.stages.add_eigenmodes(
    count=1, include_demag=True, operator="full_2x2",
    k_sampling=fm.KPath(
        points=[fm.KPoint("minus", (0, -25e6, 0)),
                fm.KPoint("G", (0, 0, 0)),
                fm.KPoint("plus", (0, 25e6, 0))],
        samples_per_segment=[7, 7]),
    bc=fm.FloquetBC(["x_faces", "y_faces"]))
'''


class ParallelExecutionExportTests(unittest.TestCase):
    def roundtrip(self, overrides=None):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "model.py"
            path.write_text(MODEL, encoding="utf-8")
            before = fm.load_problem_from_script(path, lightweight_assets=True)
            result = rewrite_loaded_problem_script(before, overrides=overrides)
            path.write_text(result["rendered_source"], encoding="utf-8")
            after = fm.load_problem_from_script(path, lightweight_assets=True)
            self.assertEqual(before.stages[-1].problem.study.to_ir(),
                             after.stages[-1].problem.study.to_ir())
            self.assertEqual(before.stages[-1].problem.pbc, after.stages[-1].problem.pbc)
            return before.problem.runtime.parallel_execution, after.problem.runtime.parallel_execution

    def test_public_signed_k_export_preserves_policy_and_physics(self):
        before, after = self.roundtrip()
        self.assertEqual(before, after)
        self.assertEqual(after.mode, "adaptive")
        self.assertEqual(after.max_cpu_percent, 75)

    def test_partial_policy_override_has_canonical_defaults(self):
        _, after = self.roundtrip({"runtime_selection": {"parallel_execution": {
            "mode": "adaptive", "max_cpu_percent": 65, "max_workers": 2}}})
        self.assertEqual(after, fm.ParallelExecutionPolicy(
            mode="adaptive", max_cpu_percent=65, max_workers=2))

    def test_scene_null_policy_restores_serial_and_preserves_runtime(self):
        from fullmag.runtime.script_builder import export_builder_draft
        from fullmag.runtime.scene_document import (
            build_scene_document_from_builder, build_builder_from_scene_document)
        with TemporaryDirectory() as directory:
            path = Path(directory) / "model.py"
            path.write_text(MODEL, encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            scene = build_scene_document_from_builder(export_builder_draft(loaded))
            scene["study"]["parallel_execution"] = None
            rebuilt = build_builder_from_scene_document(scene)
            self.assertEqual(rebuilt["parallel_execution"], fm.ParallelExecutionPolicy().to_ir())
            self.assertEqual(rebuilt["requested_device"], "cpu")
            self.assertEqual(rebuilt["requested_precision"], "double")

    def test_explicit_null_resets_policy_like_ir_decoder(self):
        _, after = self.roundtrip({"runtime_selection": {"parallel_execution": None}})
        self.assertEqual(after, fm.ParallelExecutionPolicy())

    def test_invalid_override_cannot_replace_editable_model(self):
        invalid = [False, [], "adaptive", {"unknown": 1}, {"max_cpu_percent": 0},
                   {"max_cpu_percent": float("nan")}, {"max_workers": 2.5}]
        for policy in invalid:
            with self.subTest(policy=policy), TemporaryDirectory() as directory:
                path = Path(directory) / "model.py"
                path.write_text(MODEL, encoding="utf-8")
                before = path.read_bytes()
                loaded = fm.load_problem_from_script(path, lightweight_assets=True)
                with self.assertRaises((TypeError, ValueError)):
                    rewrite_loaded_problem_script(loaded, overrides={"runtime_selection": {
                        "parallel_execution": policy}}, write=True)
                self.assertEqual(path.read_bytes(), before)
                self.assertFalse(path.with_name("model.py.fullmag.tmp").exists())


    def test_output_storage_and_parallel_policy_survive_both_exports(self):
        from fullmag.runtime.script_builder import (
            export_builder_draft, render_scene_document_as_script)
        from fullmag.runtime.scene_document import build_scene_document_from_builder

        storage = fm.OutputStorage(
            output_dir="results", temp_dir="scratch", cleanup="never",
            existing_output="error")
        source = MODEL.replace(
            'study.parallel_execution(mode="adaptive", max_cpu_percent=75, max_workers=3)',
            'study.parallel_execution(mode="adaptive", max_cpu_percent=75, max_workers=3)'
            '.storage(output_dir="results", temp_dir="scratch", cleanup="never", '
            'existing_output="error")')
        with TemporaryDirectory() as directory:
            path = Path(directory) / "model.py"
            path.write_text(source, encoding="utf-8")
            before = fm.load_problem_from_script(path, lightweight_assets=True)
            self.assertEqual(export_builder_draft(before)["output_storage"], storage.to_ir())
            scene = build_scene_document_from_builder(export_builder_draft(before))
            exports = {
                "builder": rewrite_loaded_problem_script(before)["rendered_source"],
                "scene": render_scene_document_as_script(scene),
            }
            for surface, rendered in exports.items():
                with self.subTest(surface=surface):
                    path.write_text(rendered, encoding="utf-8")
                    after = fm.load_problem_from_script(path, lightweight_assets=True)
                    self.assertEqual(export_builder_draft(after)["output_storage"], storage.to_ir())
                    self.assertEqual(after.problem.runtime.parallel_execution,
                                     before.problem.runtime.parallel_execution)
                    self.assertEqual(after.stages[-1].problem.study.to_ir(),
                                     before.stages[-1].problem.study.to_ir())
                    self.assertEqual(after.stages[-1].problem.pbc, before.stages[-1].problem.pbc)



if __name__ == "__main__":
    unittest.main()
