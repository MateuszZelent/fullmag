"""Source Python authoring roundtrip checks; no native solver is loaded."""
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages" / "fullmag-py" / "src"))

import fullmag as fm
from fullmag.runtime.scene_document import build_scene_document_from_builder, builder_overrides_from_scene_document
from fullmag.runtime.script_builder import export_builder_draft, rewrite_loaded_problem_script
from windows.development_scene_assets import collect_scene_assets, _rebase_declared_scene_assets


class DevelopmentScenePythonTests(unittest.TestCase):
    def test_scene_override_retains_generic_artifact_alias(self):
        for kind, prefix in (("eigenmodes", "eigen"), ("frequency_response", "frequency")):
            with self.subTest(kind=kind):
                scene = build_scene_document_from_builder({"stages": [{"kind": kind,
                    f"{prefix}_equilibrium_source": "artifact", "equilibrium_artifact": "preserved.json"}]})
                overrides = builder_overrides_from_scene_document(scene)
                self.assertEqual(overrides["stages"][0][f"{prefix}_equilibrium_artifact"], "preserved.json")

    def test_generic_source_and_artifact_survive_empty_prefixed_aliases(self):
        for kind, prefix in (("eigenmodes", "eigen"), ("frequency_response", "frequency")):
            with self.subTest(kind=kind):
                scene = build_scene_document_from_builder({"stages": [{"kind": kind,
                    f"{prefix}_equilibrium_source": "", f"{prefix}_equilibrium_artifact": None,
                    "equilibrium_source": "artifact", "equilibrium_artifact": "preserved.json"}]})
                overrides = builder_overrides_from_scene_document(scene)
                self.assertEqual(overrides["stages"][0][f"{prefix}_equilibrium_source"], "artifact")
                self.assertEqual(overrides["stages"][0][f"{prefix}_equilibrium_artifact"], "preserved.json")

    def test_modal_source_paths_survive_export_scene_and_legacy_script_rewrite(self):
        for kind, prefix, arguments in (("eigenmodes", "eigen", "count=2"),
                                        ("frequency_response", "frequency", "frequencies_hz=[1e9]")):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / "source.py"
                original_path = str(root / "initial.json")
                restored_path = str(root / "preserved.json")
                source.write_text(
                    "import fullmag as fm\n"
                    "study = fm.study('artifact-roundtrip')\n"
                    "body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name='film')\n"
                    "body.Ms = 800e3\nbody.Aex = 13e-12\nbody.m = fm.texture.uniform(1, 0, 0)\n"
                    "study.save('spectrum')\n"
                    f"study.stages.add_{kind}({arguments}, equilibrium_source='artifact', "
                    f"equilibrium_artifact={original_path!r})\n", encoding="utf-8")
                loaded = fm.load_problem_from_script(source, lightweight_assets=True)
                draft = export_builder_draft(loaded)
                artifact_key = f"{prefix}_equilibrium_artifact"
                self.assertEqual(draft["stages"][0][artifact_key], original_path)
                scene = build_scene_document_from_builder(draft)
                self.assertEqual(scene["study"]["stages"][0][artifact_key], original_path)
                references = collect_scene_assets(scene)
                self.assertTrue(any(item["asset_id"] == f"/study/stages/0/{artifact_key}"
                                    and item["source_path"] == original_path for item in references))
                # Keep the actual exported pipeline as well as the legacy rows.
                # Both representations must point at the preserved input when
                # the renderer chooses the pipeline as its authoritative form.
                copied = [{"asset_id": item["asset_id"], "sha256": "a" * 64,
                           "size_bytes": 12, "storage_path": restored_path}
                          for item in references]
                pipeline_scene = _rebase_declared_scene_assets(scene, copied)
                pipeline_overrides = builder_overrides_from_scene_document(pipeline_scene)
                pipeline_rendered = rewrite_loaded_problem_script(
                    loaded, overrides=pipeline_overrides)["rendered_source"]
                pipeline_script = root / "pipeline-rewritten.py"
                pipeline_script.write_text(pipeline_rendered, encoding="utf-8")
                pipeline_loaded = fm.load_problem_from_script(pipeline_script, lightweight_assets=True)
                pipeline_study = pipeline_loaded.stages[0].problem.study
                self.assertEqual(pipeline_study.equilibrium_source, "artifact")
                self.assertEqual(pipeline_study.equilibrium_artifact, restored_path)
                # Exercise the supported legacy stage adapter separately from
                # pipeline rendering. A handoff must rewrite both representations.
                scene["study"]["study_pipeline"] = None
                scene["study"]["stages"][0][artifact_key] = restored_path
                original_scene = deepcopy(scene)
                overrides = builder_overrides_from_scene_document(scene)
                self.assertEqual(overrides["stages"][0][artifact_key], restored_path)
                self.assertEqual(scene, original_scene)
                rendered = rewrite_loaded_problem_script(loaded, overrides=overrides)["rendered_source"]
                rewritten = root / "rewritten.py"
                rewritten.write_text(rendered, encoding="utf-8")
                reloaded = fm.load_problem_from_script(rewritten, lightweight_assets=True)
                study = reloaded.stages[0].problem.study
                self.assertEqual(study.equilibrium_source, "artifact")
                self.assertEqual(study.equilibrium_artifact, restored_path)
