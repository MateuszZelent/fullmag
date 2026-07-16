from __future__ import annotations

import inspect
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm


def _load(script_body: str):
    with TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "stages.py"
        path.write_text(textwrap.dedent(script_body), encoding="utf-8")
        return fm.load_problem_from_script(path, lightweight_assets=True)


_PREAMBLE = """
import fullmag as fm
study = fm.study("stable-stage-ids")
study.engine("fem")
body = study.geometry(fm.Box(10e-9, 10e-9, 5e-9), name="film")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.01
body.m = fm.texture.uniform(1, 0, 0)
"""


class StudyStageIdTests(unittest.TestCase):
    def test_run_relax_and_minimize_preserve_explicit_stage_ids(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_relax(stage_id="relax", max_steps=2)
study.stages.add_minimize(stage_id="equilibrate", method="bb", max_steps=2)
study.stages.add_run(stage_id="excite", until=4e-12)
"""
        )
        self.assertEqual(
            [stage.stage_id for stage in loaded.stages],
            ["relax", "equilibrate", "excite"],
        )
        excite_ir = loaded.stages[2].to_ir(
            requested_backend=None,
            execution_mode=None,
            execution_precision=None,
            script_source="",
            include_geometry_assets=False,
            study_pipeline=loaded.study_pipeline_document(),
            stage_start_time_s=2e-12,
        )
        self.assertEqual(
            excite_ir["problem_meta"]["runtime_metadata"]["stage_start_time_s"],
            2e-12,
        )
        self.assertEqual(
            excite_ir["problem_meta"]["runtime_metadata"]["active_stage_id"],
            "excite",
        )

    def test_omitted_stage_ids_are_deterministic(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_relax(max_steps=2)
study.stages.add_run(4e-12)
"""
        )
        self.assertEqual(
            [stage.stage_id for stage in loaded.stages],
            ["relax-1", "run-1"],
        )

    def test_duplicate_stage_id_is_rejected_at_authoring_time(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate stage_id"):
            _load(
                _PREAMBLE
                + """
study.stages.add_relax(stage_id="same", max_steps=2)
study.stages.add_run(stage_id="same", until=4e-12)
"""
            )

    def test_add_field_drive_is_an_ordered_action_after_relaxation(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_minimize(stage_id="relax", method="bb", max_steps=2)
study.stages.add_field_drive(
    fm.RegionalFieldDrive(
        id="k0-sinc-antenna",
        name="Uniform transverse k0 sinc antenna",
        target=fm.FieldTarget.global_domain(),
        amplitude_B_T=1e-3,
        direction=(0.0, 1.0, 0.0),
        spatial_profile=fm.UniformFieldProfile(),
        waveform=fm.SincPulse(cutoff_hz=40e9, t0=50e-12),
        time_origin="stage_local",
    ),
    stage_id="add-antenna",
)
study.stages.add_run(stage_id="excite", until=2e-9)
"""
        )

        self.assertEqual(
            [stage.stage_id for stage in loaded.stages],
            ["relax", "add-antenna", "excite"],
        )
        self.assertEqual(loaded.stages[0].problem.field_drives, ())
        self.assertEqual(loaded.stages[1].problem.field_drives, ())
        for attribute in (
            "magnets",
            "energy",
            "dynamics",
            "discretization",
            "runtime",
            "auxiliary_geometries",
            "current_modules",
            "couplings",
            "pbc",
        ):
            self.assertEqual(
                getattr(loaded.stages[1].problem, attribute),
                getattr(loaded.stages[0].problem, attribute),
                f"{attribute} must pass unchanged from Relax to Add antenna",
            )
        self.assertEqual(loaded.stages[1].action["kind"], "add_field_drive")
        self.assertEqual(
            loaded.stages[1].action["drive"]["id"],
            "k0-sinc-antenna",
        )
        self.assertEqual(
            [drive.id for drive in loaded.stages[2].problem.field_drives],
            ["k0-sinc-antenna"],
        )
        for attribute in (
            "magnets",
            "energy",
            "dynamics",
            "discretization",
            "runtime",
            "auxiliary_geometries",
            "current_modules",
            "couplings",
            "pbc",
        ):
            self.assertEqual(
                getattr(loaded.stages[2].problem, attribute),
                getattr(loaded.stages[1].problem, attribute),
                f"{attribute} must pass unchanged from Add antenna to Run",
            )
        self.assertEqual(
            [drive.id for drive in loaded.workspace_problem.field_drives],
            ["k0-sinc-antenna"],
        )

        pipeline = loaded.study_pipeline_document()
        self.assertEqual(pipeline["nodes"][1]["stage_kind"], "add_field_drive")
        self.assertEqual(
            pipeline["nodes"][1]["payload"]["drive"]["id"],
            "k0-sinc-antenna",
        )

    def test_add_field_drive_rejects_duplicate_drive_id_at_action_boundary(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate field drive id"):
            _load(
                _PREAMBLE
                + """
drive = fm.RegionalFieldDrive(
    id="same-drive",
    name="First drive",
    target=fm.FieldTarget.global_domain(),
    amplitude_B_T=1e-3,
    direction=(0.0, 1.0, 0.0),
    spatial_profile=fm.UniformFieldProfile(),
    waveform=fm.Constant(),
)
study.stages.add_field_drive(drive, stage_id="add-first")
study.stages.add_field_drive(
    fm.RegionalFieldDrive(
        id="same-drive",
        name="Second drive",
        target=fm.FieldTarget.global_domain(),
        amplitude_B_T=1e-3,
        direction=(0.0, 0.0, 1.0),
        spatial_profile=fm.UniformFieldProfile(),
        waveform=fm.Constant(),
    ),
    stage_id="add-second",
)
"""
            )

    def test_autosave_and_fft_are_ordered_configuration_stages_not_run_arguments(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_minimize(stage_id="relax", method="bb", max_steps=2)
study.stages.tableautosave(
    5e-13,
    quantities=["time", "step", "mx", "my", "mz", "E_drive"],
    stage_id="table-on",
)
study.stages.autosave("m", every=2e-12, stage_id="autosave-m")
study.stages.autosave("H_drive", every=5e-13, stage_id="autosave-drive")
study.stages.fft_response("my", stage_id="analyse-k0")
study.stages.add_run(stage_id="excite", until=2e-9)
study.stages.tableautosave(enabled=False, stage_id="table-off")
study.stages.autosave(enabled=False, stage_id="autosave-off")
study.stages.fft_response(enabled=False, stage_id="analysis-off")
study.stages.add_run(stage_id="unsampled", until=1e-9)
"""
        )

        self.assertEqual(
            [stage.action["kind"] if stage.action else stage.problem.study.to_ir()["kind"] for stage in loaded.stages],
            [
                "relaxation",
                "table_autosave",
                "autosave",
                "autosave",
                "fft_response",
                "time_evolution",
                "table_autosave",
                "autosave",
                "fft_response",
                "time_evolution",
            ],
        )
        relax_sampling = loaded.stages[0].problem.study.to_ir()["sampling"]
        run_ir = loaded.stages[5].problem.to_ir(include_geometry_assets=False)
        run_sampling = run_ir["study"]["sampling"]
        self.assertIsNone(relax_sampling.get("table_autosave"))
        self.assertEqual(run_sampling["table_autosave"]["sample_period_s"], 5e-13)
        self.assertEqual(
            run_sampling["table_autosave"]["quantities"],
            ["t", "step", "mx", "my", "mz", "e_drive"],
        )
        self.assertEqual(
            run_sampling["outputs"],
            [
                {"kind": "field", "name": "m", "every_seconds": 2e-12},
                {"kind": "field", "name": "H_drive", "every_seconds": 5e-13},
            ],
        )
        self.assertEqual(
            run_ir["problem_meta"]["runtime_metadata"]["spin_wave_response"],
            {
                "schema_version": "spin_wave_response.request.v1",
                "analysis": "gamma",
                "response_component": "my",
                "weighting": "Ms_times_lumped_volume",
                "detrend": "linear",
                "window": "hann",
                "susceptibility_floor_fraction": 1e-6,
            },
        )
        unsampled_ir = loaded.stages[9].problem.to_ir(include_geometry_assets=False)
        self.assertIsNone(unsampled_ir["study"]["sampling"].get("table_autosave"))
        self.assertEqual(unsampled_ir["study"]["sampling"]["outputs"], [])
        self.assertNotIn(
            "spin_wave_response",
            unsampled_ir["problem_meta"]["runtime_metadata"],
        )
        for action_index in (1, 2, 3, 4, 6, 7, 8):
            for attribute in (
                "magnets",
                "energy",
                "dynamics",
                "discretization",
                "runtime",
                "auxiliary_geometries",
                "current_modules",
                "couplings",
                "pbc",
            ):
                self.assertEqual(
                    getattr(loaded.stages[action_index].problem, attribute),
                    getattr(loaded.stages[action_index - 1].problem, attribute),
                    f"{attribute} must pass unchanged through configuration stage {action_index}",
                )

    def test_add_run_primary_signature_contains_only_time_and_stage_id(self) -> None:
        fm.reset()
        study = fm.study("simple-run-signature")
        self.assertEqual(
            [
                name
                for name, parameter in inspect.signature(
                    study.stages.add_run
                ).parameters.items()
                if parameter.kind is not inspect.Parameter.VAR_KEYWORD
            ],
            ["until", "stage_id"],
        )

    def test_legacy_run_configuration_expands_to_visible_actions(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_run(
    stage_id="excite",
    until=2e-9,
    outputs=[fm.SaveField("m", every=2e-12)],
    table_autosave=fm.TableAutosave(
        t_sampl=5e-13,
        quantities=["t", "mx", "my", "mz"],
    ),
    spin_wave_response=fm.GammaResponseAnalysis(response_component="my"),
)
"""
        )

        self.assertEqual(
            [stage.action["kind"] if stage.action else "run" for stage in loaded.stages],
            ["table_autosave", "autosave", "autosave", "fft_response", "run"],
        )
        self.assertEqual(loaded.stages[-1].stage_id, "excite")
        self.assertEqual(
            loaded.stages[-1].problem.study.to_ir()["sampling"]["outputs"],
            [{"kind": "field", "name": "m", "every_seconds": 2e-12}],
        )


if __name__ == "__main__":
    unittest.main()
