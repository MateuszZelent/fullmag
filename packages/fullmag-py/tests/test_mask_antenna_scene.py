"""Mask antennas survive script -> SceneDocument -> script (field-masks plan, Task 7)."""

from __future__ import annotations

import json
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import export_builder_draft, render_scene_document_as_script

ANTENNA_SCRIPT = textwrap.dedent(
    """
    from math import exp, log, pi, sin, sqrt
    import fullmag as fm
    from fullmag import GHz, mT, nm

    study = fm.study("mask-scene")
    study.universe(mode="manual", size=(400e-9, 100e-9, 20e-9), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
    study.cell(5e-9, 5e-9, 5e-9)
    film = study.geometry(fm.Box(size=(400e-9, 100e-9, 20e-9), name="film"), name="film")
    film.Ms = 800e3
    film.Aex = 13e-12
    film.alpha = 0.01
    film.m = fm.texture.uniform(1.0, 0.0, 0.0)
    left = film.add_region("left", fm.Box(200e-9, 100e-9, 20e-9).translate((-100e-9, 0.0, 0.0)))
    study.exchange()


    def antenna_mask(x, y, z, B01, wavelength, fwhm_y, xs):
        k = 2 * pi / wavelength
        sigma_y = fwhm_y / (2 * sqrt(2 * log(2)))
        g = exp(-(x + xs) ** 2 / (2 * wavelength ** 2))
        g = g * exp(-y ** 2 / (2 * sigma_y ** 2))
        return (B01 * g * sin(k * x - pi / 2), 0.0, B01 * g * sin(k * x))


    def antenna_time(t, frequency, t0):
        return sin(2 * pi * frequency * (t - t0))


    def static_z(x, y, z, b):
        return (0.0, 0.0, b)


    antenna = film.add_simpleantenna.arbitrary_mask(
        shape=fm.Box(400e-9, 100e-9, 10e-9),
        position=(0.0, 0.0, -5e-9),
        frame="world",
        time_origin="absolute",
        name="Antenna",
    )
    antenna.add(
        fm.mask(antenna_mask, B01=0.2 * mT, wavelength=60 * nm, fwhm_y=40 * nm, xs=100 * nm),
        fm.time(antenna_time, frequency=3.6 * GHz, t0=0.0),
        name="carrier",
    )
    antenna.add(fm.mask(static_z, b=0.01 * mT))
    study.field_drives.add(antenna)

    probe = left.add_simpleantenna.arbitrary_mask(
        fm.Box(100e-9, 100e-9, 20e-9),
        activation=fm.DriveActivation.stage_ids(["run"]),
        id="probe",
    )
    probe.add(
        fm.mask(antenna_mask, B01=0.1 * mT, wavelength=60 * nm, fwhm_y=40 * nm, xs=0.0),
        fm.time(antenna_time, frequency=4.0 * GHz, t0=1e-10),
    )
    study.field_drives.add(probe)
    study.stages.add_run(stage_id="run", until=1e-12)
    """
)


def _without_sources(value: object) -> object:
    """Parameter sources are display text and are not exported."""
    if isinstance(value, dict):
        return {key: _without_sources(item) for key, item in value.items() if key != "source"}
    if isinstance(value, list):
        return [_without_sources(item) for item in value]
    return value


def _mask_drives(path: Path) -> list[dict[str, object]]:
    loaded = fm.load_problem_from_script(path, lightweight_assets=True)
    run = next(stage for stage in loaded.stages if stage.stage_id == "run")
    return run.problem.to_ir(include_geometry_assets=False).get("mask_field_drives", [])


class MaskAntennaSceneTests(unittest.TestCase):
    def tearDown(self) -> None:
        fm.reset()

    def _round_trip(self, script: str) -> tuple[Path, Path, str]:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        original = directory / "original.py"
        original.write_text(script, encoding="utf-8")
        loaded = fm.load_problem_from_script(original, lightweight_assets=True)
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        rendered_source = render_scene_document_as_script(scene)
        rendered = directory / "rendered.py"
        rendered.write_text(rendered_source, encoding="utf-8")
        return original, rendered, rendered_source

    def test_mask_antennas_survive_script_scene_script(self) -> None:
        original, rendered, source = self._round_trip(ANTENNA_SCRIPT)
        before = _mask_drives(original)
        after = _mask_drives(rendered)
        self.assertEqual([drive["id"] for drive in before], ["antenna", "probe"])
        self.assertEqual(_without_sources(after), _without_sources(before))

    def test_rendered_script_reuses_functions_and_keeps_names(self) -> None:
        _, _, source = self._round_trip(ANTENNA_SCRIPT)
        self.assertEqual(source.count("def antenna_mask(x, y, z, B01, wavelength, fwhm_y, xs):"), 1)
        self.assertEqual(source.count("def antenna_time(t, frequency, t0):"), 1)
        self.assertIn("    g_2 = g * exp(-y ** 2 / (2 * sigma_y ** 2))", source)
        self.assertIn('name="carrier"', source)
        self.assertIn('"kind": "region"', source)
        self.assertIn('fm.DriveActivation.stage_ids(["run"])', source)
        self.assertIn("from math import exp, log, pi, sin, sqrt", source)

    def test_scene_lists_mask_drives_beside_regional_drives(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "script.py"
            path.write_text(ANTENNA_SCRIPT, encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            scene = build_scene_document_from_builder(export_builder_draft(loaded))
        drives = scene["field_drives"]
        self.assertEqual(drives["drives"], [])
        self.assertEqual([drive["id"] for drive in drives["mask_drives"]], ["antenna", "probe"])
        json.dumps(scene)  # the scene stays plain JSON

    def test_script_without_masks_renders_without_mask_sections(self) -> None:
        plain = ANTENNA_SCRIPT.split("def antenna_mask")[0] + 'study.stages.add_run(stage_id="run", until=1e-12)\n'
        _, _, source = self._round_trip(plain)
        self.assertNotIn("# Mask antennas", source)
        self.assertNotIn("from math import", source)


if __name__ == "__main__":
    unittest.main()
