from __future__ import annotations

import math
from pathlib import Path
import textwrap
from tempfile import TemporaryDirectory
import unittest

import fullmag as fm
from fullmag.runtime.script_builder import rewrite_loaded_problem_script


class GaussianPlaneWaveAntennaTests(unittest.TestCase):
    def test_profile_serializes_and_evaluates_global_carrier_origin(self) -> None:
        profile = fm.GaussianPlaneWaveFieldProfile(
            center_x_m=-1.0e-6,
            center_y_m=2.0e-6,
            carrier_origin_x_m=0.0,
            sigma_x_m=196e-9,
            sigma_y_m=440e-9 / (2.0 * math.sqrt(2.0 * math.log(2.0))),
            wavelength_m=196e-9,
            carrier_phase_rad=0.0,
        )

        self.assertEqual(profile.to_ir()["kind"], "gaussian_plane_wave")
        self.assertEqual(profile.to_ir()["carrier_origin_x_m"], 0.0)
        expected_at_carrier_origin = math.exp(-0.5 * (1.0e-6 / 196e-9) ** 2)
        self.assertAlmostEqual(
            profile.value_at((0.0, 2.0e-6, 0.0)),
            expected_at_carrier_origin,
            places=15,
        )
        self.assertAlmostEqual(
            profile.value_at((49e-9, 2.0e-6, 0.0)),
            0.0,
            places=12,
        )

    def test_antenna_expands_to_two_quadrature_drives(self) -> None:
        antenna = fm.GaussianPlaneWaveAntenna(
            id="src",
            amplitude_B_T=3e-3,
            frequency_hz=4.5e9,
            wavelength_m=196e-9,
            sigma_x_m=196e-9,
            fwhm_y_m=440e-9,
            center_x_m=-4500e-9 / 2.3,
            center_y_m=0.0,
            carrier_origin_x_m=0.0,
            t0_s=2e-9,
        )

        x_drive, z_drive = antenna.to_drives()

        self.assertEqual((x_drive.id, z_drive.id), ("src_x", "src_z"))
        self.assertEqual(x_drive.direction, (1.0, 0.0, 0.0))
        self.assertEqual(z_drive.direction, (0.0, 0.0, 1.0))
        self.assertEqual(x_drive.amplitude_B_T, 3e-3)
        self.assertEqual(z_drive.amplitude_B_T, 3e-3)
        self.assertEqual(
            x_drive.spatial_profile.to_ir()["carrier_phase_rad"],
            0.0,
        )
        self.assertAlmostEqual(
            z_drive.spatial_profile.to_ir()["carrier_phase_rad"],
            -math.pi / 2.0,
        )
        self.assertAlmostEqual(
            x_drive.waveform.to_ir()["phase_rad"],
            -2.0 * math.pi * 4.5e9 * 2e-9,
        )
        self.assertEqual(x_drive.spatial_profile.to_ir()["carrier_origin_x_m"], 0.0)

    def test_invalid_profile_and_antenna_parameters_fail_closed(self) -> None:
        invalid_profiles = (
            dict(
                center_x_m=0.0,
                center_y_m=0.0,
                carrier_origin_x_m=0.0,
                sigma_x_m=0.0,
                sigma_y_m=1e-9,
                wavelength_m=1e-9,
            ),
            dict(
                center_x_m=0.0,
                center_y_m=0.0,
                carrier_origin_x_m=0.0,
                sigma_x_m=1e-9,
                sigma_y_m=1e-9,
                wavelength_m=float("nan"),
            ),
        )
        for kwargs in invalid_profiles:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                fm.GaussianPlaneWaveFieldProfile(**kwargs)

        with self.assertRaises(ValueError):
            fm.GaussianPlaneWaveAntenna(
                id="src",
                amplitude_B_T=1e-3,
                frequency_hz=4.5e9,
                wavelength_m=196e-9,
                sigma_x_m=196e-9,
                fwhm_y_m=0.0,
            )

    def test_expanded_gaussian_drives_round_trip_through_script_builder(self) -> None:
        source = """
        import fullmag as fm

        study = fm.study("gaussian-roundtrip")
        study.engine("fem")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        antenna = fm.GaussianPlaneWaveAntenna(
            id="roundtrip",
            amplitude_B_T=3e-3,
            frequency_hz=4.5e9,
            wavelength_m=196e-9,
            sigma_x_m=196e-9,
            fwhm_y_m=440e-9,
            center_x_m=-1e-6,
            carrier_origin_x_m=0.0,
            t0_s=2e-9,
            activation=fm.DriveActivation.stage_ids(["run"]),
        )
        for drive in antenna.to_drives():
            study.field_drives.add(drive)
        study.stages.add_run(stage_id="run", until=1e-12)
        """
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source_path = root / "source.py"
            source_path.write_text(textwrap.dedent(source), encoding="utf-8")
            loaded = fm.load_problem_from_script(source_path, lightweight_assets=True)
            before = [drive.to_ir() for drive in loaded.stages[-1].problem.field_drives]
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewritten_path = root / "rewritten.py"
            rewritten_path.write_text(str(rendered), encoding="utf-8")
            rewritten = fm.load_problem_from_script(
                rewritten_path,
                lightweight_assets=True,
            )

        self.assertIn("GaussianPlaneWaveFieldProfile", str(rendered))
        self.assertIn("carrier_origin_x_m=0", str(rendered))
        after = [drive.to_ir() for drive in rewritten.stages[-1].problem.field_drives]
        self.assertEqual([drive["id"] for drive in before], [drive["id"] for drive in after])
        for expected, actual in zip(before, after):
            for key in ("amplitude_B_T", "time_origin"):
                if isinstance(expected[key], float):
                    self.assertAlmostEqual(expected[key], actual[key], delta=1e-15)
                else:
                    self.assertEqual(expected[key], actual[key])
            self.assertEqual(expected["direction"], actual["direction"])
            self.assertEqual(expected["target"], actual["target"])
            self.assertEqual(expected["activation"], actual["activation"])
            for key in (
                "center_x_m",
                "center_y_m",
                "carrier_origin_x_m",
                "sigma_x_m",
                "sigma_y_m",
                "wavelength_m",
                "carrier_phase_rad",
            ):
                self.assertAlmostEqual(expected["spatial_profile"][key], actual["spatial_profile"][key], delta=1e-10)
            self.assertAlmostEqual(
                expected["waveform"]["frequency_hz"],
                actual["waveform"]["frequency_hz"],
                delta=1e-3,
            )
            self.assertAlmostEqual(
                expected["waveform"]["phase_rad"],
                actual["waveform"]["phase_rad"],
                delta=1e-10,
            )

    def test_fem_counterpart_preserves_geometry_gradient_and_antenna_contract(self) -> None:
        scenario_path = Path(__file__).resolve().parents[3] / "tests/vlad/4.5GHz_fem.py"
        loaded = fm.load_problem_from_script(scenario_path, lightweight_assets=True)
        problem = loaded.stages[-1].problem

        self.assertEqual({magnet.name for magnet in problem.magnets}, {"yig", "py"})
        bias_stages = [
            stage for stage in loaded.stages if stage.stage_id.startswith("bias_minimize_")
        ]
        self.assertEqual(len(bias_stages), 98)
        py = next(magnet for magnet in problem.magnets if magnet.name == "py")
        py_gradient_regions = [
            region
            for region in py.object_regions
            if region.name.startswith("py_ms_gradient_")
        ]
        self.assertEqual(len(py_gradient_regions), 100)
        self.assertEqual(
            [drive.id for drive in problem.field_drives],
            ["mumax_4_5ghz_antenna_x", "mumax_4_5ghz_antenna_z"],
        )
        profile = problem.field_drives[0].spatial_profile.to_ir()
        self.assertEqual(profile["kind"], "gaussian_plane_wave")
        self.assertEqual(profile["carrier_origin_x_m"], 0.0)
        self.assertAlmostEqual(profile["wavelength_m"], 196e-9)
        self.assertEqual(
            problem.field_drives[0].activation.to_ir(),
            {"kind": "stage_ids", "stage_ids": ["antenna_run"]},
        )


if __name__ == "__main__":
    unittest.main()
