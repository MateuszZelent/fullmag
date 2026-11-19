"""Keep the uniform field captured by each imported Run or Relax stage."""

import tempfile
import unittest
from pathlib import Path

import fullmag as fm
from fullmag.model.energy import Zeeman
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.scene_document_ir import scene_document_to_execution_config
from fullmag.runtime.script_builder import (
    export_builder_draft,
    render_loaded_problem_as_script,
    render_scene_document_as_script,
)


SCRIPT = """import fullmag as fm
study = fm.study("stage fields")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(20e-9, 20e-9, 5e-9))
study.cell(5e-9, 5e-9, 5e-9)
body = study.geometry(fm.Box(20e-9, 20e-9, 5e-9), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.solver(fix_dt=1e-13)
{initial_field}
study.stages.add_relax(algorithm="llg_overdamped", dt=1e-13, tolA=1e-5, max_steps=4, stage_id="relax")
study.b_ext(0.010, 0.0, 0.0)
{run_damping}
study.stages.add_run(1e-12, stage_id="run")
body.alpha = 0.5
study.b_ext(0.099, 0.0, 0.0)
study.stages.add_run(2e-12, stage_id="inherits")
"""


def load(root, name, source):
    path = root / f"{name}.py"
    path.write_text(source, encoding="utf-8")
    return fm.load_problem_from_script(path, lightweight_assets=True)


def field(problem):
    return next((term.B for term in problem.energy if isinstance(term, Zeeman)), None)


class StageExternalFieldRoundtripTests(unittest.TestCase):
    def test_run_relax_fields_survive_both_script_roundtrips_and_accepted_capture(self):
        for initial, first in (("", None), ("study.b_ext(0.0, 0.0, 0.0)", (0.0, 0.0, 0.0))):
            with self.subTest(initial=initial), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                captured = load(root, "input", SCRIPT.format(initial_field=initial, run_damping=""))
                expected = [first, (0.010, 0.0, 0.0), (0.099, 0.0, 0.0)]
                self.assertEqual([field(stage.problem) for stage in captured.stages], expected)
                scene = build_scene_document_from_builder(export_builder_draft(captured))
                stages = scene["study"]["study_pipeline"]["nodes"]
                self.assertIn("external_field", stages[0]["payload"])
                self.assertEqual(stages[0]["payload"]["external_field"], list(first) if first else None)
                self.assertEqual(stages[1]["payload"]["external_field"], [0.010, 0.0, 0.0])
                self.assertNotIn("external_field", stages[2]["payload"])

                config = scene_document_to_execution_config(
                    scene, requested_backend="fdm", requested_device="cpu", requested_precision="double",
                    requested_mode="strict", source_root=root,
                )
                self.assertFalse(config.get("stages"))
                self.assertEqual(config["study_pipeline"]["nodes"], stages)
                self.assertIn({"kind": "zeeman", "B": [0.099, 0.0, 0.0]}, config["ir"]["energy_terms"])
                for exported in (render_loaded_problem_as_script(captured), render_scene_document_as_script(scene)):
                    replayed = load(root, "replayed", exported)
                    self.assertEqual([field(stage.problem) for stage in replayed.stages], expected)
                    self.assertEqual(field(replayed.workspace_problem), (0.099, 0.0, 0.0))

    def test_replay_preserves_full_precision_and_a_field_set_after_the_last_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = SCRIPT.format(initial_field="", run_damping="").replace(
                "study.stages.add_run(2e-12, stage_id=\"inherits\")", ""
            ).replace("0.010", "0.010123456789012345")
            captured = load(root, "input", payload)
            scene = build_scene_document_from_builder(export_builder_draft(captured))
            for exported in (render_loaded_problem_as_script(captured), render_scene_document_as_script(scene)):
                replayed = load(root, "replayed", exported)
                self.assertEqual(
                    [field(stage.problem) for stage in replayed.stages],
                    [None, (0.010123456789012345, 0.0, 0.0)],
                )
                self.assertEqual(field(replayed.workspace_problem), (0.099, 0.0, 0.0))

    def test_explicit_global_override_replaces_all_captured_stage_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            captured = load(root, "input", SCRIPT.format(
                initial_field="study.b_ext(0.0, 0.0, 0.0)", run_damping="",
            ))
            for override, expected in ((None, None), ([0.12, 0.0, 0.0], (0.12, 0.0, 0.0))):
                with self.subTest(override=override):
                    exported = render_loaded_problem_as_script(
                        captured, overrides={"external_field": override},
                    )
                    replayed = load(root, "replayed", exported)
                    self.assertEqual([field(stage.problem) for stage in replayed.stages], [expected] * 3)
                    self.assertEqual(field(replayed.workspace_problem), expected)

            scene = build_scene_document_from_builder(export_builder_draft(captured))
            pipeline = scene["study"]["study_pipeline"]
            pipeline["nodes"][1]["payload"]["external_field"] = [0.035, 0.0, 0.0]
            exported = render_loaded_problem_as_script(
                captured, overrides={"external_field": [0.12, 0.0, 0.0], "study_pipeline": pipeline},
            )
            replayed = load(root, "with_pipeline", exported)
            self.assertEqual(
                [field(stage.problem) for stage in replayed.stages],
                [(0.0, 0.0, 0.0), (0.035, 0.0, 0.0), (0.12, 0.0, 0.0)],
            )

    def test_mixed_pipeline_keeps_run_capture_and_modal_stage_inherits_base(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = SCRIPT.format(initial_field="", run_damping="").replace(
                'study.stages.add_run(2e-12, stage_id="inherits")',
                'study.stages.add_eigenmodes(count=3, include_demag=False, stage_id="modes")',
            ).replace('study.engine("fdm")', 'study.engine("fem")').replace(
                'study.cell(5e-9, 5e-9, 5e-9)', 'study.objects.mesh.defaults(maximum_element_size=5e-9)',
            )
            captured = load(root, "input", payload)
            scene = build_scene_document_from_builder(export_builder_draft(captured))
            accepted = scene_document_to_execution_config(
                scene, requested_backend="fem", requested_device="cpu", requested_precision="double",
                requested_mode="strict", source_root=root,
            )
            nodes = accepted["study_pipeline"]["nodes"]
            self.assertEqual(nodes[1]["payload"]["external_field"], [0.01, 0.0, 0.0])
            self.assertEqual(nodes[2]["stage_kind"], "eigenmodes")
            self.assertNotIn("external_field", nodes[2]["payload"])
            self.assertIn({"kind": "zeeman", "B": [0.099, 0.0, 0.0]}, accepted["ir"]["energy_terms"])
            for exported in (render_loaded_problem_as_script(captured), render_scene_document_as_script(scene)):
                replayed = load(root, "replayed", exported)
                self.assertEqual(
                    [field(stage.problem) for stage in replayed.stages],
                    [None, (0.01, 0.0, 0.0), (0.099, 0.0, 0.0)],
                )
                self.assertEqual(field(replayed.workspace_problem), (0.099, 0.0, 0.0))

    def test_scene_replay_keeps_independent_run_damping_and_rejects_bad_field(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            captured = load(root, "input", SCRIPT.format(
                initial_field="study.b_ext(0.0, 0.0, 0.0)", run_damping="body.alpha = 0.15",
            ))
            scene = build_scene_document_from_builder(export_builder_draft(captured))
            run = scene["study"]["study_pipeline"]["nodes"][1]["payload"]
            self.assertEqual(list(run["gilbert_damping_by_object"].values()), [0.15])
            replayed = load(root, "replayed", render_scene_document_as_script(scene))
            self.assertEqual([stage.problem.magnets[0].material.alpha for stage in replayed.stages], [1.0, 0.15, 0.5])
            self.assertEqual(field(replayed.stages[1].problem), (0.010, 0.0, 0.0))
            run["external_field"] = [0.01, True, 0.0]
            with self.assertRaisesRegex(ValueError, "external_field"):
                render_scene_document_as_script(scene)
            run["external_field"] = None
            with self.assertRaisesRegex(ValueError, "clear.*external field"):
                render_scene_document_as_script(scene)
            scene["study"]["study_pipeline"]["nodes"][1]["source"] = "ui_authored"
            with self.assertRaisesRegex(ValueError, "requires a script-imported Run or Relax"):
                render_scene_document_as_script(scene)


if __name__ == "__main__":
    unittest.main()
