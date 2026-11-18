from __future__ import annotations

import math
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm
from fullmag.runtime.script_builder import export_builder_draft, rewrite_loaded_problem_script


class AbsorbingBoundaryPythonTests(unittest.TestCase):
    def setUp(self) -> None:
        fm.world.reset()

    def _film(self) -> object:
        study = fm.study("absorbing-boundary-test")
        film = study.geometry(fm.Box(1.0e-6, 0.8e-6, 0.1e-6), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        return film

    def test_alpha_assignment_remains_numeric_and_exposes_object_module(self) -> None:
        film = self._film()
        self.assertAlmostEqual(float(film.alpha), 0.01)
        self.assertEqual(film.alpha, 0.01)
        film.alpha.absorbing_boundary(
            total_width=400e-9,
            ramp_width=300e-9,
            max_damping=0.5,
            faces=("x+", "y-", "y+"),
            profile="smootherstep",
        )
        problem = fm.world._build_problem()
        magnet = problem.magnets[0]
        self.assertEqual(
            magnet.to_ir()["absorbing_boundary"],
            {
                "total_width_m": 400e-9,
                "ramp_width_m": 300e-9,
                "max_damping": 0.5,
                "faces": ["x+", "y-", "y+"],
                "profile": "smootherstep",
                "frame": "object",
            },
        )

    def test_parameters_are_validated_and_second_call_replaces_first(self) -> None:
        film = self._film()
        with self.assertRaises(ValueError):
            film.alpha.absorbing_boundary(
                total_width=1e-9,
                ramp_width=2e-9,
                max_damping=0.5,
                faces=("x+",),
            )
        with self.assertRaises(ValueError):
            film.alpha.absorbing_boundary(
                total_width=1e-9,
                ramp_width=1e-9,
                max_damping=0.5,
                faces=("q+",),
            )
        film.alpha.absorbing_boundary(
            total_width=200e-9,
            ramp_width=100e-9,
            max_damping=0.2,
            faces=("z-",),
            profile="linear",
            frame="universe",
        )
        film.alpha.absorbing_boundary(
            total_width=300e-9,
            ramp_width=100e-9,
            max_damping=0.3,
            faces=("x-",),
            profile="quadratic",
        )
        self.assertEqual(
            fm.world._build_problem().magnets[0].to_ir()["absorbing_boundary"]["faces"],
            ["x-"],
        )

    def test_new_profiles_sample_ramp_and_plateau(self) -> None:
        for profile, expression, midpoint in (
            ("logarithmic", None, math.log(5.5) / math.log(10)),
            ("tanh", None, 0.5),
            ("custom", "u**3", 0.125),
        ):
            with self.subTest(profile=profile):
                layer = fm.AbsorbingBoundaryLayer(
                    4.0, 2.0, 0.8, profile=profile, expression=expression
                )
                bounds = (0., 0., 0., 10., 1., 1.)
                self.assertEqual(layer.contribution((6., 0., 0.), bounds), 0.)
                self.assertAlmostEqual(layer.contribution((7., 0., 0.), bounds), 0.8 * midpoint)
                self.assertEqual(layer.contribution((9., 0., 0.), bounds), 0.8)

    def test_custom_profile_rejects_invalid_expressions(self) -> None:
        for expression in (
            None, "", "u + 1", "u / (u - 0.5)", "2*u-u**4", "other(u)", "u.real",
            "u # comment", "u**1_0", "01*u", "(-1)**0.5*u", "1/exp(999)*u",
            "u**0x2", "u**0o2", "u**0b10", "(sqrt)(u)", "((abs))(u)",
        ):
            with self.subTest(expression=expression), self.assertRaisesRegex(ValueError, "expression"):
                fm.AbsorbingBoundaryLayer(4., 2., 0.8, profile="custom", expression=expression)
        with self.assertRaisesRegex(ValueError, "expression"):
            fm.AbsorbingBoundaryLayer(4., 2., 0.8, profile="linear", expression="u")

    def test_prebuilt_parameters_can_be_attached_to_alpha(self) -> None:
        film = self._film()
        parameters = fm.AbsorbingBoundaryLayer(
            total_width_m=300e-9,
            ramp_width_m=200e-9,
            max_damping=0.4,
            faces=("x+", "x-"),
        )
        self.assertIs(film.alpha.absorbing_boundary(parameters), parameters)
        self.assertEqual(
            fm.world._build_problem().magnets[0].to_ir()["absorbing_boundary"]["faces"],
            ["x+", "x-"],
        )

    def test_fem_example_preserves_the_object_boundary(self) -> None:
        scenario = Path(__file__).resolve().parents[3] / "examples/fem_absorbing_boundary.py"
        loaded = fm.load_problem_from_script(scenario, lightweight_assets=True)
        problem_ir = loaded.stages[-1].problem.to_ir(include_geometry_assets=False)
        self.assertEqual(problem_ir["backend_policy"]["requested_backend"], "fem")
        film = next(magnet for magnet in problem_ir["magnets"] if magnet["name"] == "film")
        self.assertEqual(film["absorbing_boundary"], {
            "total_width_m": 60e-9,
            "ramp_width_m": 40e-9,
            "max_damping": 0.5,
            "faces": ["x+", "x-"],
            "profile": "custom",
            "frame": "object",
            "expression": "sqrt(u)",
        })

    def test_canonical_export_rejects_invalid_absorbing_boundaries(self) -> None:
        scenario = Path(__file__).resolve().parents[3] / "examples/fem_absorbing_boundary.py"
        loaded = fm.load_problem_from_script(scenario, lightweight_assets=True)
        builder = export_builder_draft(loaded)
        layer = builder["geometries"][0]["absorbing_boundary"]
        for field, value in (
            ("faces", []),
            ("faces", ["x+", "x+"]),
            ("ramp_width_m", layer["total_width_m"] * 2),
            ("max_damping", -1),
            ("expression", "(sqrt)(u)"),
        ):
            with self.subTest(field=field, value=value):
                builder["geometries"][0]["absorbing_boundary"] = {**layer, field: value}
                with self.assertRaises(ValueError):
                    rewrite_loaded_problem_script(loaded, overrides=builder)

    def test_script_export_round_trips_object_boundary(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "source.py"
            source.write_text(
                """
import fullmag as fm
study = fm.study("roundtrip")
film = study.geometry(fm.Box(1e-6, 1e-6, 1e-8), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
film.alpha.absorbing_boundary(total_width=4.123456789012345e-7, ramp_width=3e-7, max_damping=0.5, faces=("x+", "y-"), profile="custom", expression="u**3", frame="object")
study.stages.add_run(stage_id="run", until=1e-12)
""",
                encoding="utf-8",
            )
            loaded = fm.load_problem_from_script(source, lightweight_assets=True)
            builder = export_builder_draft(loaded)
            rendered = rewrite_loaded_problem_script(
                loaded,
                overrides=builder,
            )["rendered_source"]
            rewritten = Path(tmp_dir) / "rewritten.py"
            rewritten.write_text(str(rendered), encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewritten, lightweight_assets=True)
        self.assertEqual(
            reloaded.stages[-1].problem.magnets[0].to_ir()["absorbing_boundary"],
            loaded.stages[-1].problem.magnets[0].to_ir()["absorbing_boundary"],
        )


if __name__ == "__main__":
    unittest.main()
