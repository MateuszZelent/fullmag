from __future__ import annotations

import json
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import export_builder_draft, rewrite_loaded_problem_script


def _load_text(script: str, directory: Path, name: str = "problem.py"):
    path = directory / name
    path.write_text(textwrap.dedent(script), encoding="utf-8")
    return fm.load_problem_from_script(path, lightweight_assets=True)


_SCRIPT = """
import fullmag as fm

study = fm.study("drive-roundtrip")
study.engine("fem")
film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
study.antenna_object(fm.Box(20e-9, 40e-9, 5e-9), name="source-mask")

study.field_drives.add(fm.RegionalFieldDrive(
    id="global-sinc",
    name="Global sinc",
    target=fm.FieldTarget.global_domain(),
    amplitude_B_T=1e-3,
    direction=(0, 1, 0),
    spatial_profile=fm.UniformFieldProfile(),
    waveform=fm.SincPulse(cutoff_hz=20e9, t0=100e-12),
    time_origin="stage_local",
    activation=fm.DriveActivation.stage_ids(["excite"]),
))
study.field_drives.add(fm.RegionalFieldDrive(
    id="masked-pwl",
    name="Masked PWL",
    target=fm.FieldTarget.object("film"),
    amplitude_B_T=0.5e-3,
    direction=(0, 0, 1),
    spatial_profile=fm.GeometryMaskFieldProfile(
        object_id="source-mask",
        envelope=fm.SincFieldProfile(
            axis=(1, 0, 0), period_m=20e-9, center_m=0, width_m=40e-9, window="hann"
        ),
    ),
    waveform=fm.PiecewiseLinear([(0, 0), (1e-12, 1), (2e-12, 0)]),
    time_origin="absolute",
    activation=fm.DriveActivation.all_time_evolution(),
))
study.stages.add_relax(stage_id="relax", max_steps=2)
study.stages.add_run(stage_id="excite", until=4e-12, output_every=1e-12)
"""


class ScriptBuilderRegionalDriveRoundTripTests(unittest.TestCase):
    def test_canonical_rewrite_preserves_drives_and_stage_ids(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(_SCRIPT, root, "source.py")
            before = loaded.problem.to_ir(include_geometry_assets=False)["field_drives"]
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewritten = _load_text(str(rendered), root, "rewritten.py")
            after = rewritten.problem.to_ir(include_geometry_assets=False)["field_drives"]

        self.assertIn("study.field_drives.add(fm.RegionalFieldDrive(", rendered)
        self.assertIn('stage_id="relax"', rendered)
        self.assertIn('stage_id="excite"', rendered)
        self.assertIn("output_every=1e-12", rendered)
        self.assertEqual(before, after)
        self.assertEqual(
            [stage.stage_id for stage in rewritten.stages],
            ["relax", "excite"],
        )

    def test_scene_document_keeps_field_drives_as_typed_state(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            loaded = _load_text(_SCRIPT, Path(tmp_dir))
            scene = build_scene_document_from_builder(export_builder_draft(loaded))
        expected = loaded.problem.to_ir(include_geometry_assets=False)["field_drives"]
        self.assertEqual(scene["field_drives"]["drives"], expected)
        self.assertNotIn("field_drives", scene["current_modules"])

    def test_legacy_prescribed_mask_migrates_one_way(self) -> None:
        legacy = """
        import fullmag as fm
        study = fm.study("legacy-mask")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.antenna_object(fm.Box(20e-9, 40e-9, 5e-9), name="source-mask")
        study.antenna_field_source(
            name="legacy-drive",
            model="prescribed_zeeman_mask",
            object="source-mask",
            B=1e-3,
            direction=(0, 1, 0),
            spatial_profile={"kind": "uniform"},
            waveform=fm.SincPulse(cutoff_hz=20e9, t0=100e-12),
        )
        study.stages.add_run(stage_id="excite", until=1e-12)
        """
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(legacy, root)
            ir = loaded.problem.to_ir(include_geometry_assets=False)
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]

        self.assertEqual(ir["current_modules"], [])
        self.assertEqual(ir["field_drives"][0]["kind"], "regional")
        self.assertEqual(
            ir["field_drives"][0]["migration"],
            {"migrated_from": "prescribed_zeeman_mask"},
        )
        self.assertNotIn('model="prescribed_zeeman_mask"', rendered)
        self.assertIn("RegionalFieldDrive", rendered)

    def test_canonical_scene_roundtrip_json_is_idempotent(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(_SCRIPT, root, "first.py")
            first_scene = build_scene_document_from_builder(export_builder_draft(loaded))
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            loaded_again = _load_text(str(rendered), root, "second.py")
            second_scene = build_scene_document_from_builder(export_builder_draft(loaded_again))
        self.assertEqual(
            json.dumps(first_scene["field_drives"], sort_keys=True),
            json.dumps(second_scene["field_drives"], sort_keys=True),
        )


if __name__ == "__main__":
    unittest.main()
