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
study.stages.add_run(stage_id="excite", until=4e-12)
"""


class ScriptBuilderRegionalDriveRoundTripTests(unittest.TestCase):
    def test_add_field_drive_roundtrip_preserves_pipeline_order_without_global_leakage(self) -> None:
        script = """
        import fullmag as fm
        study = fm.study("ordered-drive")
        study.engine("fem")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.stages.add_minimize(stage_id="relax", method="bb", max_steps=2)
        study.stages.add_field_drive(
            fm.RegionalFieldDrive(
                id="k0-sinc",
                name="K0 sinc",
                target=fm.FieldTarget.global_domain(),
                amplitude_B_T=1e-3,
                direction=(0, 1, 0),
                spatial_profile=fm.UniformFieldProfile(),
                waveform=fm.SincPulse(cutoff_hz=40e9, t0=50e-12),
                time_origin="stage_local",
            ),
            stage_id="add-antenna",
        )
        study.stages.add_run(stage_id="excite", until=2e-9)
        """
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(script, root, "source.py")
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewritten = _load_text(str(rendered), root, "rewritten.py")

        self.assertNotIn("study.field_drives.add(", rendered)
        relax_at = rendered.index('study.stages.add_relax(stage_id="relax"')
        add_at = rendered.index("study.stages.add_field_drive(")
        run_at = rendered.index('study.stages.add_run(stage_id="excite"')
        self.assertLess(relax_at, add_at)
        self.assertLess(add_at, run_at)
        self.assertEqual(
            [
                stage.action["kind"] if stage.action else stage.problem.study.to_ir()["kind"]
                for stage in rewritten.stages
            ],
            ["relaxation", "add_field_drive", "time_evolution"],
        )
        self.assertEqual(rewritten.stages[0].problem.field_drives, ())
        self.assertEqual(
            [drive.id for drive in rewritten.stages[2].problem.field_drives],
            ["k0-sinc"],
        )

    def test_independent_autosave_and_fft_stages_roundtrip_before_simple_run(self) -> None:
        script = """
        import fullmag as fm
        study = fm.study("sampling-roundtrip")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.stages.tableautosave(
            5e-13,
            quantities=["time", "step", "mx", "my", "mz", "E_drive"],
            stage_id="table-on",
        )
        study.stages.autosave("m", every=2e-12, stage_id="autosave-m")
        study.stages.autosave("H_drive", every=5e-13, stage_id="autosave-drive")
        study.stages.fft_response("my", stage_id="analyse-k0")
        study.stages.add_run(stage_id="excite", until=2e-9)
        """
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(script, root, "source.py")
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewritten = _load_text(str(rendered), root, "rewritten.py")

        self.assertIn("study.stages.tableautosave(", rendered)
        self.assertIn('study.stages.autosave("m", every=2e-12', rendered)
        self.assertIn('study.stages.fft_response("my"', rendered)
        self.assertIn('study.stages.add_run(stage_id="excite", until=2e-09)', rendered)
        self.assertNotIn("table_autosave=", rendered)
        self.assertNotIn("outputs=[", rendered)
        self.assertNotIn("spin_wave_response=", rendered)
        before = loaded.stages[-1].problem.to_ir(include_geometry_assets=False)
        after = rewritten.stages[-1].problem.to_ir(include_geometry_assets=False)
        self.assertEqual(before["study"]["sampling"], after["study"]["sampling"])
        self.assertEqual(
            before["problem_meta"]["runtime_metadata"]["spin_wave_response"],
            after["problem_meta"]["runtime_metadata"]["spin_wave_response"],
        )

    def test_automatic_sampling_stages_roundtrip_as_literal_auto(self) -> None:
        script = """
        import fullmag as fm
        study = fm.study("auto-sampling-roundtrip")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.stages.tableautosave("auto", quantities=["t", "mx"], stage_id="table-auto")
        study.stages.autosave("m", every="auto", stage_id="field-auto")
        study.stages.add_run(stage_id="excite", until=2e-9)
        """
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(script, root, "source.py")
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewritten = _load_text(str(rendered), root, "rewritten.py")

        self.assertIn('study.stages.tableautosave("auto"', rendered)
        self.assertIn('study.stages.autosave("m", every="auto"', rendered)
        before = loaded.stages[-1].problem.to_ir(include_geometry_assets=False)
        after = rewritten.stages[-1].problem.to_ir(include_geometry_assets=False)
        self.assertEqual(before["study"]["sampling"], after["study"]["sampling"])

    def test_auto_sampling_export_ignores_resolved_cadence(self) -> None:
        script = """
        import fullmag as fm
        study = fm.study("auto-sampling-resolved")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.stages.tableautosave("auto", stage_id="table-auto")
        study.stages.add_run(stage_id="excite", until=2e-9)
        """
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(script, root, "source.py")
            loaded.stages[0].action["table_autosave"]["resolved_sample_period_s"] = 7.6923e-11
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]

        self.assertIn('study.stages.tableautosave("auto"', rendered)
        self.assertNotIn("7.6923e-11", rendered)

    def test_table_autosave_override_rejects_invalid_numeric_ir_cadence(self) -> None:
        script = """
        import fullmag as fm
        study = fm.study("invalid-imported-sampling")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.stages.add_run(stage_id="run", until=2e-9)
        """
        with TemporaryDirectory() as tmp_dir:
            loaded = _load_text(script, Path(tmp_dir), "source.py")
            for invalid in (0.0, -1e-12, float("nan"), float("inf"), "1e-12", True):
                with self.subTest(invalid=invalid):
                    with self.assertRaises(ValueError):
                        rewrite_loaded_problem_script(
                            loaded,
                            overrides={
                                "table_autosave": {
                                    "kind": "table_autosave",
                                    "sample_period_s": invalid,
                                }
                            },
                        )

    def test_ordered_sampling_stages_reject_invalid_numeric_ir_cadence(self) -> None:
        script = """
        import fullmag as fm
        study = fm.study("invalid-ordered-sampling")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.stages.tableautosave(1e-12, stage_id="table")
        study.stages.autosave("m", every=1e-12, stage_id="field")
        study.stages.add_run(stage_id="run", until=2e-9)
        """
        invalid_values = (0.0, -1e-12, float("nan"), float("inf"), "1e-12", True)
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            for stage_index, payload_key, cadence_key in (
                (0, "table_autosave", "sample_period_s"),
                (1, "output", "every_seconds"),
            ):
                for invalid in invalid_values:
                    with self.subTest(stage_index=stage_index, invalid=invalid):
                        loaded = _load_text(script, root, f"source-{stage_index}.py")
                        loaded.stages[stage_index].action[payload_key][cadence_key] = invalid
                        with self.assertRaises(ValueError):
                            rewrite_loaded_problem_script(loaded)

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
