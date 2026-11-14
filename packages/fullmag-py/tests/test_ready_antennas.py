"""Ready antennas (``fullmag.antennas``): the call, its origin and the exported script."""

from __future__ import annotations

import math
import re
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

import fullmag as fm
from fullmag.antennas import READY_ANTENNAS, gaussian_k_source, gaussian_k_source_mask, rebuild
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import (
    _mask_library_imports,
    _MaskAntennaRenderer,
    export_builder_draft,
    render_scene_document_as_script,
)

NAME = "fullmag.antennas.gaussian_k_source"
RACETRACK = dict(
    amplitude=0.2e-3, wavelength=279e-9, frequency=3.6e9, fwhm_y=240e-9, center_x=-6000e-9 / 2.3, t0=2e-9
)


def antenna_mask(x, y, z, B01, wavelength, fwhm_y, xs):
    """The hand-written mask of the user's racetrack script."""
    k = 2 * math.pi / wavelength
    sigma_y = fwhm_y / (2 * math.sqrt(2 * math.log(2)))
    g = math.exp(-(x + xs) ** 2 / (2 * wavelength**2)) * math.exp(-y**2 / (2 * sigma_y**2))
    return (B01 * g * math.sin(k * x - math.pi / 2), 0.0, B01 * g * math.sin(k * x))


def antenna_mask_loop(field, B01, wavelength, fwhm_y, xs, layers):
    """The loop of the user's racetrack script (mumax3 newVectorMask + setVector)."""
    k = 2 * math.pi / wavelength
    sigma_y = fwhm_y / (2.0 * math.sqrt(2.0 * math.log(2.0)))
    nx, ny, nz = field.size
    for i in range(nx):
        x = field.index2coord(i, 0, 0)[0]
        gaussx = math.exp(-((x + xs) * (x + xs)) / (2.0 * wavelength * wavelength))
        z_sin_kx = math.sin(k * x) * gaussx
        x_sin_kx = math.sin(k * x - math.pi / 2) * gaussx
        for j in range(ny):
            y = field.index2coord(0, j, 0)[1]
            ymask = math.exp(-(y * y) / (2.0 * sigma_y * sigma_y))
            for layer in range(layers):
                field.set_vector(i, j, layer, (B01 * ymask * x_sin_kx, 0.0, B01 * ymask * z_sin_kx))
    return field


def film_study():
    fm.reset()
    study = fm.study("ready-antenna")
    study.universe(mode="manual", size=(80e-9, 40e-9, 20e-9), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
    study.cell(5e-9, 5e-9, 5e-9)
    film = study.geometry(fm.Box(size=(80e-9, 40e-9, 20e-9), name="film"), name="film")
    film.Ms = 800e3
    film.Aex = 13e-12
    film.alpha = 0.01
    film.m = fm.texture.uniform(1.0, 0.0, 0.0)
    study.exchange()
    return study, film


SMALL = dict(amplitude=2e-4, wavelength=40e-9, frequency=5e9, fwhm_y=20e-9, center_x=-10e-9)

SCRIPT = textwrap.dedent(
    """
    import fullmag as fm
    from fullmag import GHz, mT, nm
    from fullmag.antennas import gaussian_k_source

    study = fm.study("ready-antenna-scene")
    study.universe(mode="manual", size=(400e-9, 100e-9, 20e-9), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
    study.cell(5e-9, 5e-9, 5e-9)
    film = study.geometry(fm.Box(size=(400e-9, 100e-9, 20e-9), name="film"), name="film")
    film.Ms = 800e3
    film.Aex = 13e-12
    film.alpha = 0.01
    film.m = fm.texture.uniform(1.0, 0.0, 0.0)
    study.exchange()

    antenna = film.add_simpleantenna.arbitrary_mask(
        shape=fm.Box(400e-9, 100e-9, 10e-9),
        position=(0.0, 0.0, -5e-9),
        frame="world",
        time_origin="absolute",
        name="Antenna",
    )
    for field, drive in gaussian_k_source(amplitude=0.2 * mT, wavelength=60 * nm, frequency=3.6 * GHz,
                                          fwhm_y=40 * nm, center_x=-100 * nm, t0=1e-10):
        antenna.add(field, drive, name="source")
    for field, drive in gaussian_k_source(amplitude=0.1 * mT, wavelength=80 * nm, frequency=4 * GHz,
                                          fwhm_y=40 * nm, center_x=100 * nm, sigma_x=50 * nm):
        antenna.add(field, drive)
    study.field_drives.add(antenna)

    probe = film.add_simpleantenna.arbitrary_mask(fm.Box(100e-9, 100e-9, 20e-9), frame="world", id="probe")
    for field, drive in gaussian_k_source(amplitude=0.1 * mT, wavelength=60 * nm, frequency=4 * GHz,
                                          fwhm_y=40 * nm, center_x=0.0):
        probe.add(field, drive)
    study.stages.add_field_drive(probe, stage_id="add_probe")
    study.stages.update_field_drive(probe, mask_parameters={"amplitude": 0.3 * mT}, stage_id="louder")
    study.stages.add_run(stage_id="run", until=1e-12)
    """
)


class ReadyAntennaTests(unittest.TestCase):
    def tearDown(self) -> None:
        fm.reset()

    def test_function_style_equals_the_hand_written_mask(self) -> None:
        ((field, drive),) = gaussian_k_source(**RACETRACK)
        parameters = {item["name"]: item["value"] for item in field.to_ir()["parameters"]}
        self.assertEqual(
            parameters,
            {
                "amplitude": 0.2e-3,
                "wavelength": 279e-9,
                "sigma_x": 279e-9,
                "fwhm_y": 240e-9,
                "center_x": -6000e-9 / 2.3,
                "center_y": 0.0,
            },
        )
        self.assertEqual(
            {item["name"]: item["value"] for item in drive.to_ir()["parameters"]},
            {"frequency": 3.6e9, "t0": 2e-9},
        )
        for x in np.linspace(-3e-6, 3e-6, 41):
            for y in np.linspace(-500e-9, 500e-9, 11):
                ready = gaussian_k_source_mask(x, y, 0.0, **{**parameters})
                hand = antenna_mask(x, y, 0.0, 0.2e-3, 279e-9, 240e-9, 6000e-9 / 2.3)
                self.assertEqual(ready, hand)

    def test_loop_style_is_the_mumax3_loop(self) -> None:
        study, _ = film_study()
        ((field, _),) = gaussian_k_source(study, **SMALL, n_layers=2, style="loop")
        reference = antenna_mask_loop(
            study.new_vector_mask(), B01=2e-4, wavelength=40e-9, fwhm_y=20e-9, xs=10e-9, layers=2
        )
        np.testing.assert_array_equal(field.array, reference.array)
        self.assertFalse(np.any(field.array[2:]))
        ((function, _),) = gaussian_k_source(**SMALL)
        parameters = {item["name"]: item["value"] for item in function.to_ir()["parameters"]}
        for i in range(16):
            for j in range(8):
                x, y, z = field.index2coord(i, j, 0)
                expected = gaussian_k_source_mask(x, y, z, **parameters)
                for got, want in zip(field.get_vector(i, j, 1), expected):
                    self.assertAlmostEqual(got, want, delta=1e-7 * 2e-4)

    def test_terms_carry_the_call(self) -> None:
        _, film = film_study()
        antenna = film.add_simpleantenna.arbitrary_mask(fm.Box(80e-9, 40e-9, 20e-9), frame="world")
        for field, drive in gaussian_k_source(**SMALL):
            antenna.add(field, drive)
        for field, drive in gaussian_k_source(**SMALL, sigma_x=30e-9, t0=1e-10):
            antenna.add(field, drive)
        first, second = antenna.to_ir()["terms"]
        self.assertEqual(
            first["origin"],
            {
                "function": NAME,
                "arguments": {**SMALL, "center_y": 0.0, "t0": 0.0},
                "call_index": 0,
                "output_index": 0,
            },
        )
        self.assertEqual(second["origin"]["call_index"], 1)
        self.assertEqual(second["origin"]["arguments"]["sigma_x"], 30e-9)
        self.assertNotIn("sigma_x", first["origin"]["arguments"])
        study, _ = film_study()
        ((array, _),) = gaussian_k_source(study, **SMALL, style="loop")
        loop_antenna = study.add_simpleantenna.arbitrary_mask(target="global", shape=fm.Box(80e-9, 40e-9, 20e-9))
        loop_antenna.add(array, fm.time(lambda_free_sine, f=5e9))
        self.assertNotIn("origin", loop_antenna.to_ir()["terms"][0])

    def test_registry_and_rebuild(self) -> None:
        spec = READY_ANTENNAS[NAME]
        self.assertIs(spec.function, gaussian_k_source)
        self.assertEqual(
            [(argument.name, argument.unit) for argument in spec.arguments],
            [
                ("amplitude", "T"),
                ("wavelength", "m"),
                ("frequency", "Hz"),
                ("fwhm_y", "m"),
                ("center_x", "m"),
                ("center_y", "m"),
                ("sigma_x", "m"),
                ("t0", "s"),
            ],
        )
        ((field, drive),) = gaussian_k_source(**SMALL, t0=1e-10)
        ((again, again_drive),) = rebuild(NAME, dict(field.library_call.arguments))
        self.assertEqual(again.to_ir(), field.to_ir())
        self.assertEqual(again_drive.to_ir(), drive.to_ir())
        with self.assertRaisesRegex(ValueError, "unknown ready antenna"):
            rebuild("fullmag.antennas.nothing", {})
        with self.assertRaisesRegex(ValueError, "unknown arguments \\['B01'\\]"):
            rebuild(NAME, {**SMALL, "B01": 1.0})

    def test_update_drops_the_origin(self) -> None:
        _, film = film_study()
        antenna = film.add_simpleantenna.arbitrary_mask(fm.Box(80e-9, 40e-9, 20e-9), frame="world")
        for field, drive in gaussian_k_source(**SMALL):
            antenna.add(field, drive)
        self.assertIn("origin", antenna.to_ir()["terms"][0])
        louder = antenna.with_parameters(mask_parameters={"amplitude": 3e-4}).to_ir()["terms"][0]
        self.assertNotIn("origin", louder)
        later = antenna.with_parameters(time_parameters={"t0": 1e-9}).to_ir()["terms"][0]
        self.assertNotIn("origin", later)
        self.assertIn("origin", antenna.to_ir()["terms"][0])

    def test_style_errors(self) -> None:
        with self.assertRaisesRegex(ValueError, "n_layers applies to style='loop'"):
            gaussian_k_source(**SMALL, n_layers=9)
        with self.assertRaisesRegex(ValueError, "needs the study"):
            gaussian_k_source(**SMALL, style="loop")
        with self.assertRaisesRegex(ValueError, "style must be"):
            gaussian_k_source(**SMALL, style="array")

    def test_ready_antenna_survives_script_scene_script(self) -> None:
        with TemporaryDirectory() as directory:
            original = Path(directory) / "original.py"
            original.write_text(SCRIPT, encoding="utf-8")
            loaded = fm.load_problem_from_script(original, lightweight_assets=True)
            rendered_source = render_scene_document_as_script(
                build_scene_document_from_builder(export_builder_draft(loaded))
            )
            rendered = Path(directory) / "rendered.py"
            rendered.write_text(rendered_source, encoding="utf-8")

            def drives(path: Path) -> dict[str, object]:
                result = fm.load_problem_from_script(path, lightweight_assets=True)
                return {
                    stage.stage_id: stage.problem.to_ir(include_geometry_assets=False).get("mask_field_drives")
                    for stage in result.stages
                }

            before = drives(original)
            after = drives(rendered)
        self.assertIn("from fullmag.antennas import gaussian_k_source", rendered_source)
        self.assertEqual(rendered_source.count(" in gaussian_k_source("), 3)
        self.assertNotIn("def gaussian_k_source_mask", rendered_source)
        self.assertRegex(rendered_source, r"antenna\.add\(field, drive, name=['\"]source['\"]\)")
        self.assertIn("study.stages.update_field_drive(", rendered_source)
        self.assertEqual(after, before)
        run = before["run"]
        probe = next(drive for drive in run if drive["id"] == "probe")
        self.assertNotIn("origin", probe["terms"][0])  # changed by the Update
        antenna = next(drive for drive in run if drive["id"] != "probe")
        self.assertEqual([term["origin"]["call_index"] for term in antenna["terms"]], [0, 1])

    def test_changed_terms_export_as_functions(self) -> None:
        _, film = film_study()
        antenna = film.add_simpleantenna.arbitrary_mask(fm.Box(80e-9, 40e-9, 20e-9), frame="world", id="source")
        for field, drive in gaussian_k_source(**SMALL):
            antenna.add(field, drive)
        payload = antenna.to_ir()
        self.assertEqual(_mask_library_imports([payload]), ["from fullmag.antennas import gaussian_k_source"])
        payload["terms"][0]["mask"]["function"]["parameters"][0]["value"] = 3e-4  # origin left stale
        self.assertEqual(_mask_library_imports([payload]), [])
        _, lines = _MaskAntennaRenderer(reserved_names={"study", "fm"}, source_root=Path.cwd()).define(payload)
        source = "\n".join(lines)
        self.assertIn("def gaussian_k_source_mask(x, y, z, amplitude,", source)
        self.assertIn("fm.mask(gaussian_k_source_mask, amplitude=0.0003,", source)
        self.assertNotRegex(source, re.escape("in gaussian_k_source("))


def lambda_free_sine(t, f):
    return math.sin(2 * math.pi * f * t)


if __name__ == "__main__":
    unittest.main()
