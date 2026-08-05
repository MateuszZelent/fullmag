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

    def test_scenario_uses_flat_study_and_object_boundary(self) -> None:
        scenario = Path(__file__).resolve().parents[3] / "tests/vlad/4.5GHz_fem.py"
        source = scenario.read_text(encoding="utf-8")
        self.assertIn("study = fm.study(\"vlad_4_5ghz_fem\")", source)
        self.assertNotIn("def build_study", source)
        loaded = fm.load_problem_from_script(scenario, lightweight_assets=True)
        problem = loaded.stages[-1].problem
        py = next(magnet for magnet in problem.magnets if magnet.name == "py")
        layer = py.to_ir()["absorbing_boundary"]
        self.assertEqual(layer["faces"], ["x+", "y-", "y+"])
        self.assertEqual(layer["profile"], "smootherstep")
        self.assertEqual(layer["frame"], "universe")

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
film.alpha.absorbing_boundary(total_width=4e-7, ramp_width=3e-7, max_damping=0.5, faces=("x+", "y-"), profile="smootherstep", frame="object")
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
