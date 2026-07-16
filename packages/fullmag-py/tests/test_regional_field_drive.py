from __future__ import annotations

import math
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm
import fullmag.world as flat_world


class RegionalFieldDriveTests(unittest.TestCase):
    def test_global_uniform_sinc_drive_has_canonical_wire_shape(self) -> None:
        drive = fm.RegionalFieldDrive(
            id="drive-pulse",
            name="Gamma sinc pulse",
            target=fm.FieldTarget.global_domain(),
            amplitude_B_T=1e-3,
            direction=(0.0, 2.0, 0.0),
            spatial_profile=fm.UniformFieldProfile(),
            waveform=fm.SincPulse(cutoff_hz=20e9, t0=100e-12),
            time_origin="stage_local",
            activation=fm.DriveActivation.stage_ids(["excite_gamma"]),
        )

        self.assertEqual(
            drive.to_ir(),
            {
                "id": "drive-pulse",
                "name": "Gamma sinc pulse",
                "kind": "regional",
                "enabled": True,
                "target": {"kind": "global"},
                "amplitude_B_T": 1e-3,
                "direction": [0.0, 1.0, 0.0],
                "spatial_profile": {"kind": "uniform"},
                "waveform": {
                    "kind": "sinc_pulse",
                    "cutoff_hz": 20e9,
                    "t0": 100e-12,
                    "amplitude": 1.0,
                },
                "time_origin": "stage_local",
                "activation": {
                    "kind": "stage_ids",
                    "stage_ids": ["excite_gamma"],
                },
            },
        )

    def test_target_variants_are_typed(self) -> None:
        self.assertEqual(fm.FieldTarget.global_domain().to_ir(), {"kind": "global"})
        self.assertEqual(
            fm.FieldTarget.object("film").to_ir(),
            {"kind": "object", "object_id": "film"},
        )
        self.assertEqual(
            fm.FieldTarget.region("film", "source").to_ir(),
            {"kind": "region", "object_id": "film", "region_id": "source"},
        )

    def test_spatial_profile_variants_are_typed_and_normalized(self) -> None:
        sinc = fm.SincFieldProfile(
            axis=(2.0, 0.0, 0.0),
            period_m=200e-9,
            center_m=25e-9,
            width_m=400e-9,
            window="hann",
        )
        self.assertEqual(
            sinc.to_ir(),
            {
                "kind": "sinc",
                "axis": [1.0, 0.0, 0.0],
                "period_m": 200e-9,
                "center_m": 25e-9,
                "width_m": 400e-9,
                "window": "hann",
            },
        )
        self.assertEqual(
            fm.GeometryMaskFieldProfile(
                object_id="source-mask",
                envelope=sinc,
            ).to_ir(),
            {
                "kind": "geometry_mask",
                "object_id": "source-mask",
                "envelope": sinc.to_ir(),
            },
        )

    def test_all_waveform_variants_are_accepted(self) -> None:
        waveforms = (
            fm.Constant(),
            fm.Sinusoidal(frequency_hz=2e9, phase_rad=0.2, offset=0.1),
            fm.Pulse(t_on=1e-12, t_off=2e-12),
            fm.PiecewiseLinear([(0.0, 0.0), (1e-12, 1.0)]),
            fm.SincPulse(cutoff_hz=20e9, t0=50e-12, amplitude=0.5),
        )
        for index, waveform in enumerate(waveforms):
            with self.subTest(waveform=waveform):
                drive = fm.RegionalFieldDrive(
                    id=f"drive-{index}",
                    name=f"Drive {index}",
                    target=fm.FieldTarget.global_domain(),
                    amplitude_B_T=1e-3,
                    direction=(0.0, 1.0, 0.0),
                    spatial_profile=fm.UniformFieldProfile(),
                    waveform=waveform,
                )
                self.assertEqual(drive.to_ir()["waveform"], waveform.to_ir())

    def test_sinc_evaluation_is_stable_at_and_near_center(self) -> None:
        waveform = fm.SincPulse(cutoff_hz=20e9, t0=50e-12, amplitude=0.25)
        self.assertEqual(waveform.value_at(50e-12), 0.25)
        self.assertTrue(math.isfinite(waveform.value_at(50e-12 + 1e-30)))
        self.assertAlmostEqual(waveform.value_at(50e-12 + 1e-30), 0.25, places=15)

    def test_invalid_inputs_fail_closed(self) -> None:
        invalid_builders = (
            lambda: fm.FieldTarget.object(""),
            lambda: fm.FieldTarget.region("film", ""),
            lambda: fm.SincFieldProfile(axis=(0.0, 0.0, 0.0), period_m=1e-9),
            lambda: fm.SincFieldProfile(axis=(1.0, 0.0, 0.0), period_m=0.0),
            lambda: fm.SincFieldProfile(
                axis=(1.0, 0.0, 0.0), period_m=1e-9, width_m=0.0
            ),
            lambda: fm.RegionalFieldDrive(
                id="bad",
                name="Bad",
                target=fm.FieldTarget.global_domain(),
                amplitude_B_T=-1e-3,
                direction=(0.0, 1.0, 0.0),
                spatial_profile=fm.UniformFieldProfile(),
                waveform=fm.Constant(),
            ),
            lambda: fm.RegionalFieldDrive(
                id="bad",
                name="Bad",
                target=fm.FieldTarget.global_domain(),
                amplitude_B_T=float("nan"),
                direction=(0.0, 1.0, 0.0),
                spatial_profile=fm.UniformFieldProfile(),
                waveform=fm.Constant(),
            ),
            lambda: fm.RegionalFieldDrive(
                id="bad",
                name="Bad",
                target=fm.FieldTarget.global_domain(),
                amplitude_B_T=float("inf"),
                direction=(0.0, 1.0, 0.0),
                spatial_profile=fm.UniformFieldProfile(),
                waveform=fm.Constant(),
            ),
            lambda: fm.PiecewiseLinear(
                [(0.0, 0.0), (float("nan"), 1.0)]
            ),
            lambda: fm.PiecewiseLinear(
                [(0.0, 0.0), (1e-12, float("nan"))]
            ),
            lambda: fm.RegionalFieldDrive(
                id="bad",
                name="Bad",
                target=fm.FieldTarget.global_domain(),
                amplitude_B_T=1e-3,
                direction=(0.0, 0.0, 0.0),
                spatial_profile=fm.UniformFieldProfile(),
                waveform=fm.Constant(),
            ),
            lambda: fm.DriveActivation.stage_ids([]),
        )
        for builder in invalid_builders:
            with self.subTest(builder=builder), self.assertRaises((TypeError, ValueError)):
                builder()

    def test_problem_serializes_field_drives_outside_current_modules(self) -> None:
        geometry = fm.Box(size=(100e-9, 100e-9, 5e-9), name="film-geometry")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        drive = fm.RegionalFieldDrive(
            id="drive",
            name="Drive",
            target=fm.FieldTarget.object("film"),
            amplitude_B_T=1e-3,
            direction=(0.0, 1.0, 0.0),
            spatial_profile=fm.UniformFieldProfile(),
            waveform=fm.Constant(),
        )
        problem = fm.Problem(
            name="regional-drive",
            magnets=[fm.Ferromagnet(name="film", geometry=geometry, material=material)],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(
                dynamics=fm.LLG(),
                outputs=[fm.SaveScalar("E_total", every=1e-12)],
            ),
            field_drives=[drive],
        )
        ir = problem.to_ir(include_geometry_assets=False)
        self.assertEqual(ir["field_drives"], [drive.to_ir()])
        self.assertEqual(ir["current_modules"], [])

    def test_study_field_drive_registry_reaches_problem_ir(self) -> None:
        script = textwrap.dedent(
            """
            import fullmag as fm
            study = fm.study("regional-drive-study")
            body = study.geometry(fm.Box(10e-9, 10e-9, 5e-9), name="film")
            body.Ms = 800e3
            body.Aex = 13e-12
            body.alpha = 0.01
            study.field_drives.add(fm.RegionalFieldDrive(
                id="drive",
                name="Drive",
                target=fm.FieldTarget.global_domain(),
                amplitude_B_T=1e-3,
                direction=(0, 1, 0),
                spatial_profile=fm.UniformFieldProfile(),
                waveform=fm.Constant(),
            ))
            study.stages.add_run(stage_id="excite", until=1e-12)
            """
        )
        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "regional_drive.py"
            path.write_text(script, encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
        self.assertEqual(loaded.problem.to_ir(include_geometry_assets=False)["field_drives"][0]["id"], "drive")

    def test_region_target_uses_stable_region_id_not_display_name(self) -> None:
        fm.reset()
        study = fm.study("regional-drive-region-target")
        body = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name="film")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.01
        source = body.add_region("source", fm.Box(5e-9, 10e-9, 5e-9))
        study.field_drives.add(fm.RegionalFieldDrive(
            id="regional", name="Regional",
            target=fm.FieldTarget.region(source.owner_object, source.region_id),
            amplitude_B_T=1e-3, direction=(0, 1, 0),
            spatial_profile=fm.UniformFieldProfile(), waveform=fm.Constant(),
        ))
        problem = flat_world._build_problem()
        target = problem.to_ir(include_geometry_assets=False)["field_drives"][0]["target"]
        self.assertEqual(target["region_id"], "film:r1")


if __name__ == "__main__":
    unittest.main()
