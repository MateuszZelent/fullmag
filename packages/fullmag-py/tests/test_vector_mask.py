"""Array masks (loop style, mumax3 VectorMask) for field excitation."""

from __future__ import annotations

import math
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

import fullmag as fm
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import export_builder_draft, render_scene_document_as_script


def film_study():
    fm.reset()
    study = fm.study("vector-mask")
    study.universe(mode="manual", size=(80e-9, 40e-9, 20e-9), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
    study.cell(5e-9, 5e-9, 5e-9)
    film = study.geometry(fm.Box(size=(80e-9, 40e-9, 20e-9), name="film"), name="film")
    film.Ms = 800e3
    film.Aex = 13e-12
    film.alpha = 0.01
    film.m = fm.texture.uniform(1.0, 0.0, 0.0)
    study.exchange()
    return study, film


def antenna_mask_loop(field, B01, wavelength, xs):
    """Loop style, as the mumax3 script fills its VectorMask."""
    k = 2 * math.pi / wavelength
    nx, ny, nz = field.size
    for i in range(nx):
        x = field.index2coord(i, 0, 0)[0]
        g = math.exp(-((x + xs) ** 2) / (2 * wavelength**2))
        for j in range(ny):
            for layer in range(min(nz, 2)):
                field.set_vector(i, j, layer, (B01 * g * math.sin(k * x - math.pi / 2), 0.0, B01 * g * math.sin(k * x)))
    return field


class VectorMaskTests(unittest.TestCase):
    def tearDown(self) -> None:
        fm.reset()

    def test_default_lattice_is_the_fdm_grid(self) -> None:
        study, _ = film_study()
        mask = study.new_vector_mask()
        self.assertEqual(mask.size, (16, 8, 4))
        self.assertEqual(mask.cell, (5e-9, 5e-9, 5e-9))
        for got, want in zip(mask.index2coord(0, 0, 0), (-37.5e-9, -17.5e-9, -7.5e-9)):
            self.assertAlmostEqual(got, want, delta=1e-21)

    def test_set_vector_and_array_agree(self) -> None:
        mask = fm.VectorMask((3, 2, 1), (1e-9, 1e-9, 1e-9))
        mask.set_vector(2, 1, 0, (1e-3, -2e-3, 3e-3))
        self.assertEqual(mask.array.shape, (1, 2, 3, 3))
        np.testing.assert_allclose(mask.array[0, 1, 2], (1e-3, -2e-3, 3e-3), rtol=1e-7)
        mask.array[0, 0, 0] = (4e-3, 0.0, 0.0)
        self.assertAlmostEqual(mask.get_vector(0, 0, 0)[0], 4e-3, delta=1e-7 * 4e-3)  # float32

    def test_loop_function_equals_closed_form(self) -> None:
        study, _ = film_study()
        mask = antenna_mask_loop(study.new_vector_mask(), B01=2e-4, wavelength=40e-9, xs=10e-9)
        k = 2 * math.pi / 40e-9
        for i in range(16):
            x = mask.index2coord(i, 0, 0)[0]
            g = math.exp(-((x + 10e-9) ** 2) / (2 * 40e-9**2))
            expected = (2e-4 * g * math.sin(k * x - math.pi / 2), 0.0, 2e-4 * g * math.sin(k * x))
            for layer, scale in ((0, 1.0), (3, 0.0)):
                got = mask.get_vector(i, 3, layer)
                for a, b in zip(got, expected):
                    self.assertAlmostEqual(a, scale * b, delta=1e-7 * 2e-4)

    def test_ir_round_trip_and_cropping(self) -> None:
        mask = fm.VectorMask((10, 6, 4), (2e-9, 2e-9, 2e-9), (-10e-9, -6e-9, -4e-9))
        mask.array[1:3, 2:5, 4:7] = np.random.default_rng(1).normal(size=(2, 3, 3, 3)).astype(np.float32) * 1e-3
        ir = mask.to_ir()
        self.assertEqual(ir["kind"], "sampled")
        self.assertEqual(ir["encoding"], "f32le-zlib-base64")
        self.assertEqual(ir["size"], [3, 3, 2])
        np.testing.assert_allclose(ir["origin_m"], (-2e-9, -2e-9, -2e-9), atol=1e-21)
        restored = fm.VectorMask.from_ir(ir)
        np.testing.assert_array_equal(restored.array, mask.array[1:3, 2:5, 4:7])
        self.assertEqual(restored.to_ir()["sha256"], ir["sha256"])
        with self.assertRaisesRegex(ValueError, "sha256"):
            fm.VectorMask.from_ir({**ir, "sha256": "0" * 64})

    def test_errors(self) -> None:
        mask = fm.VectorMask((2, 2, 2), (1e-9, 1e-9, 1e-9))
        with self.assertRaises(IndexError):
            mask.set_vector(2, 0, 0, (0.0, 0.0, 0.0))
        with self.assertRaisesRegex(ValueError, "finite"):
            mask.set_vector(0, 0, 0, (math.nan, 0.0, 0.0))
        fm.reset()
        study = fm.study("no-grid")
        with self.assertRaisesRegex(ValueError, "size, cell\\s+and origin|size, cell and origin"):
            study.new_vector_mask()

    def test_antenna_takes_vector_mask_and_update_keeps_its_values(self) -> None:
        study, film = film_study()
        mask = antenna_mask_loop(study.new_vector_mask(), B01=2e-4, wavelength=40e-9, xs=10e-9)
        antenna = film.add_simpleantenna.arbitrary_mask(fm.Box(80e-9, 40e-9, 20e-9))
        antenna.add(mask, fm.time(lambda_free_sine, f=5e9))
        term = antenna.to_ir()["terms"][0]
        self.assertEqual(term["mask"]["kind"], "sampled")
        self.assertEqual(term["mask"]["size"], [16, 8, 2])
        with self.assertRaisesRegex(ValueError, "mask_update_invalid.*array mask"):
            antenna.with_parameters(mask_parameters={"B01": 1.0})
        updated = antenna.with_parameters(time_parameters={"f": 6e9})
        self.assertEqual(updated.to_ir()["terms"][0]["mask"], term["mask"])

    def test_loop_mask_survives_script_scene_script(self) -> None:
        script = textwrap.dedent(
            '''
            import math
            import fullmag as fm

            study = fm.study("vector-mask-scene")
            study.universe(mode="manual", size=(80e-9, 40e-9, 20e-9), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
            study.cell(5e-9, 5e-9, 5e-9)
            film = study.geometry(fm.Box(size=(80e-9, 40e-9, 20e-9), name="film"), name="film")
            film.Ms = 800e3
            film.Aex = 13e-12
            film.alpha = 0.01
            film.m = fm.texture.uniform(1.0, 0.0, 0.0)
            study.exchange()


            def ramp_loop(field, b):
                nx, ny, nz = field.size
                for i in range(nx):
                    for j in range(ny):
                        field.set_vector(i, j, 0, (b * i / nx, 0.0, 0.0))
                return field


            def sine(t, f):
                return math.sin(2 * math.pi * f * t)


            antenna = film.add_simpleantenna.arbitrary_mask(fm.Box(80e-9, 40e-9, 20e-9), name="Loop antenna")
            antenna.add(ramp_loop(study.new_vector_mask(), b=1e-3), fm.time(sine, f=5e9))
            study.stages.add_field_drive(antenna, stage_id="on")
            study.stages.add_run(stage_id="run", until=1e-12)
            '''
        )
        with TemporaryDirectory() as directory:
            original = Path(directory) / "original.py"
            original.write_text(script, encoding="utf-8")
            loaded = fm.load_problem_from_script(original, lightweight_assets=True)
            rendered_source = render_scene_document_as_script(
                build_scene_document_from_builder(export_builder_draft(loaded))
            )
            rendered = Path(directory) / "rendered.py"
            rendered.write_text(rendered_source, encoding="utf-8")

            def drives(path: Path) -> list[object]:
                result = fm.load_problem_from_script(path, lightweight_assets=True)
                run = next(stage for stage in result.stages if stage.stage_id == "run")
                return run.problem.to_ir(include_geometry_assets=False)["mask_field_drives"]

            before = drives(original)
            after = drives(rendered)
        self.assertIn("fm.VectorMask.from_data(", rendered_source)
        self.assertEqual(after, before)


def lambda_free_sine(t, f):
    return math.sin(2 * math.pi * f * t)


if __name__ == "__main__":
    unittest.main()
