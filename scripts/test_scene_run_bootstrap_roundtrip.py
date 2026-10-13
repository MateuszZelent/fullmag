"""Interpreted Scene -> Python -> capture regression; never executes a solver."""
from __future__ import annotations

import argparse
import copy
import faulthandler
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/fullmag-py/src"))

import fullmag as fm
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import export_builder_draft, render_scene_document_as_script

TEMP_ROOT: Path


class SceneRunBootstrapRoundtrip(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(dir=TEMP_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        source = self.root / "authoring.py"
        source.write_text(
            "import fullmag as fm\n"
            "study = fm.study('run-export-regression')\n"
            "study.engine('fdm')\n"
            "study.device('cpu', precision='double')\n"
            "study.objects.mesh.defaults(cell_size=(10e-9, 10e-9, 10e-9))\n"
            "study.solver(integrator='rk45', fix_dt=1e-13)\n"
            "body = study.geometry(fm.Box(100e-9, 20e-9, 10e-9), name='waveguide')\n"
            "body.Ms = 800e3\nbody.Aex = 13e-12\nbody.alpha = 0.01\n"
            "body.m = fm.texture.uniform(1, 0, 0)\n"
            "study.disable_demag()\n",
            encoding="utf-8",
        )
        loaded = load_problem_from_script(source, lightweight_assets=True)
        self.scene = build_scene_document_from_builder(export_builder_draft(loaded))
        self.scene["study"]["study_pipeline"] = None

    def run_stage(self, stage_id: str, until: object = "1e-12") -> dict:
        return {"kind": "run", "entrypoint_kind": "flat_run", "stage_id": stage_id, "until_seconds": until}

    def capture(self, scene: dict):
        rendered = render_scene_document_as_script(scene)
        path = self.root / "export.py"
        path.write_text(rendered, encoding="utf-8")
        loaded = load_problem_from_script(path, lightweight_assets=True)
        self.assertFalse(loaded.auto_execute_stages)
        return loaded

    def test_run_only_keeps_authored_duration_and_identity(self) -> None:
        self.scene["study"]["stages"] = [self.run_stage("run-1")]
        stages = self.capture(self.scene).stages
        self.assertEqual([(stage.stage_id, stage.entrypoint_kind) for stage in stages], [("run-1", "flat_run")])
        self.assertEqual(stages[0].default_until_seconds, 1e-12)

    def test_mixed_sequence_keeps_order_and_stage_ids(self) -> None:
        self.scene["study"]["stages"] = [
            self.run_stage("before", "1e-12"),
            {"kind": "relax", "entrypoint_kind": "flat_relax", "stage_id": "equilibrium", "max_steps": "2", "fixed_timestep": "1e-13"},
            self.run_stage("after", "2e-12"),
        ]
        stages = self.capture(self.scene).stages
        self.assertEqual([(stage.stage_id, stage.entrypoint_kind) for stage in stages], [("before", "flat_run"), ("equilibrium", "flat_relax"), ("after", "flat_run")])
        self.assertEqual([stages[0].default_until_seconds, stages[2].default_until_seconds], [1e-12, 2e-12])

    def test_empty_workspace_stays_empty(self) -> None:
        self.scene["study"]["stages"] = []
        loaded = self.capture(self.scene)
        self.assertEqual(loaded.entrypoint_kind, "flat_workspace")
        self.assertEqual(loaded.stages, ())

    def test_invalid_run_duration_is_rejected(self) -> None:
        for value in ("0", "-1e-12", "nan", "inf", "1e309", ""):
            with self.subTest(value=value):
                scene = copy.deepcopy(self.scene)
                scene["study"]["stages"] = [self.run_stage("invalid", value)]
                with self.assertRaises(ValueError):
                    self.capture(scene)

    def test_explicit_autosave_table_and_fields_survive_capture(self) -> None:
        policy = fm.StageAutosave(
            target="samples", layout="separate", format="hdf5",
            table=fm.TableAutosave(t_sampl=2e-13, quantities=["t", "mx"], expressions=["mx*mx"]),
            fields=[fm.FieldAutosave("m", every=2e-13)],
        )
        for stage in (self.run_stage("sampled"), {"kind": "relax", "stage_id": "sampled", "max_steps": "2", "fixed_timestep": "1e-13"}):
            with self.subTest(kind=stage["kind"]):
                stage_policy = policy if stage["kind"] == "run" else fm.StageAutosave(
                    target="samples", layout="separate", format="hdf5",
                    table=fm.TableAutosave(every_steps=2, quantities=["t", "mx"], expressions=["mx*mx"]),
                    fields=[fm.FieldAutosave("m", every_steps=2)],
                )
                self.scene["study"]["stages"] = [{**stage, "autosave": stage_policy.to_ir()}]
                stages = self.capture(self.scene).stages
                self.assertEqual(len(stages), 1)
                self.assertEqual(stages[0].autosave.to_ir(), stage_policy.to_ir())

    def test_implicit_storage_autosave_survives_capture(self) -> None:
        self.scene["study"]["stages"] = [self.run_stage("stored")]
        self.scene["study"]["output_storage"] = fm.OutputStorage(output_dir=str(self.root / "results.zarr")).to_ir()
        table = fm.TableAutosave(t_sampl=2e-13, quantities=["t", "mx"])
        self.scene["study"]["table_autosave"] = table.to_ir()
        self.scene["study"]["stages"][0]["sampling"] = {"outputs": [fm.SaveField("m", every=1e-12).to_ir()]}
        stages = self.capture(self.scene).stages
        self.assertEqual(len(stages), 1)
        self.assertEqual(stages[0].autosave.table.to_ir(), table.to_ir())
        self.assertEqual(stages[0].autosave.fields[0].to_ir(), fm.FieldAutosave("m", every=1e-12).to_ir())

    def test_default_storage_autosave_survives_capture(self) -> None:
        self.scene["study"]["output_storage"] = fm.OutputStorage(output_dir=str(self.root / "results.zarr")).to_ir()
        for stage, field in (
            (self.run_stage("stored"), fm.FieldAutosave("m", every=1e-12)),
            ({"kind": "relax", "stage_id": "stored", "max_steps": "2", "fixed_timestep": "1e-13"}, fm.FieldAutosave("m", every_steps=100)),
        ):
            with self.subTest(kind=stage["kind"]):
                self.scene["study"]["stages"] = [stage]
                stages = self.capture(self.scene).stages
                self.assertEqual(len(stages), 1)
                self.assertEqual(stages[0].autosave.fields[0].to_ir(), field.to_ir())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--temp-root", type=Path, required=True)
    args = parser.parse_args()
    TEMP_ROOT = args.temp_root.resolve(strict=True)
    tempfile.tempdir = str(TEMP_ROOT)
    faulthandler.dump_traceback_later(45, exit=True)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SceneRunBootstrapRoundtrip)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(not result.wasSuccessful())
