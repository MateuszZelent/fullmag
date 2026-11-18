from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
import math
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm
from fullmag.runtime.scene_document import build_builder_from_scene_document, build_scene_document_from_builder
from fullmag.runtime.scene_document_ir import scene_document_to_problem_ir
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

    def test_spatial_geometry_validation_and_region_lifecycle(self) -> None:
        film = self._film()
        region = film.add_region("branch", fm.Box(1e-8, 1e-8, 1e-8), region_id="branch-id")
        geometry = fm.AbsorbingGeometry
        layer = fm.SpatialAbsorbingLayer(
            layer_id="wide", name="Wide", total_width_m=2., ramp_width_m=1., max_damping=.5,
            geometry=geometry.sphere((0, 0, 0), 2., "outward"), region_id=region.region_id,
        )
        for kwargs in ({"layer_id": " rim "}, {"region_id": " branch-id"}):
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(ValueError, "whitespace"):
                replace(layer, **kwargs)
        with self.assertRaisesRegex(ValueError, "whitespace"):
            geometry.region_boundary("branch-id ")
        with self.assertRaises(FrozenInstanceError):
            layer.layer_id = "other"
        with self.assertRaisesRegex(ValueError, "unique|duplicate"):
            film.alpha.absorbing_boundary(layers=[layer, layer])
        with self.assertRaisesRegex(ValueError, "radius"):
            replace(layer, total_width_m=3.)
        with self.assertRaisesRegex(ValueError, "normal"):
            geometry.plane((0, 0, 0), (0, 0, 0))
        for expression in ("u", "x.y", "__import__('os')", "x + 0x1", "sin(z, y)", "(sqrt)(x)", "min(x,y,)"):
            with self.subTest(expression=expression), self.assertRaisesRegex(ValueError, "expression"):
                geometry.expression(expression)
        film.alpha.absorbing_boundary(layers=[layer])
        film.rename_region(region, "renamed")
        with self.assertRaisesRegex(ValueError, "wide"):
            film.remove_region(region)
        self.assertEqual(fm.world._build_problem().magnets[0].to_ir()["absorbing_boundary"]["layers"][0]["region_id"], "branch-id")
        film.alpha.absorbing_boundary(layers=[replace(layer, region_id=None, geometry=geometry.region_boundary("branch-id"))])
        with self.assertRaisesRegex(ValueError, "wide"):
            film.remove_region(region)
        film.alpha.absorbing_boundary(layers=[])
        film.remove_region(region)
        film.alpha.absorbing_boundary(layers=[layer])
        with self.assertRaisesRegex(ValueError, "branch-id"):
            fm.world._build_problem()

    def test_custom_distance_both_edges_of_annulus_and_y_branch(self) -> None:
        from fullmag.model._absorbing_boundary_expression import compile_distance_expression

        annulus = compile_distance_expression("min(5e-7-sqrt(x*x+y*y), sqrt(x*x+y*y)-2e-7)")
        self.assertLess(annulus(0., 0., 0.), 0.)  # The central hole.
        self.assertAlmostEqual(annulus(2.5e-7, 0., 0.), 5e-8, delta=1e-21)
        self.assertAlmostEqual(annulus(0., 4.5e-7, 0.), 5e-8, delta=1e-21)
        self.assertLess(annulus(0., 6e-7, 0.), 0.)
        branch = compile_distance_expression("max(min(-y,1-abs(x)),min(y,1-abs(abs(x)-y)))")
        for point in ((0., -3., 0.), (-3., 3., 0.), (3., 3., 0.)):
            self.assertGreater(branch(*point), 0.)
        self.assertLess(branch(0., 3., 0.), 0.)

    def test_translated_spherical_csg_boundary_survives_scene_export(self) -> None:
        from fullmag.runtime.script_builder import render_scene_document_as_script

        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "shell.py"
            path.write_text("""
import fullmag as fm
study = fm.study("csg-shell")
study.engine("fdm")
film = study.geometry(fm.Box(1e-6, 1e-6, 1e-6), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
shell = (fm.Sphere(8e-9) - fm.Sphere(3e-9)).translate((20e-9, 0, 0))
region = film.add_region("Displaced shell", shell, region_id="shell-id")
film.alpha.absorbing_boundary(layers=[
    fm.SpatialAbsorbingLayer(layer_id="abl", name="Shell boundary",
        geometry=fm.AbsorbingGeometry.region_boundary(region.region_id),
        total_width_m=2e-9, ramp_width_m=1e-9, max_damping=0.5),
])
study.stages.add_run(stage_id="run", until=1e-12)
""", encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            original = loaded.stages[-1].problem.to_ir(include_geometry_assets=False)
            shape = original["object_regions"][0]["shape"]
            self.assertEqual(shape["kind"], "csg")
            offset = shape["expression"]
            self.assertEqual((offset["kind"], offset["by"]), ("translate", [20e-9, 0, 0]))
            self.assertEqual(offset["base"]["kind"], "difference")
            self.assertEqual(offset["base"]["base"]["radii"], [8e-9] * 3)
            self.assertEqual(offset["base"]["tool"]["radii"], [3e-9] * 3)
            scene = build_scene_document_from_builder(export_builder_draft(loaded))
            path.write_text(render_scene_document_as_script(scene), encoding="utf-8")
            restored = fm.load_problem_from_script(path, lightweight_assets=True)
            recovered = restored.stages[-1].problem.to_ir(include_geometry_assets=False)
            self.assertEqual(recovered["object_regions"], original["object_regions"])
            self.assertEqual(recovered["magnets"][0]["absorbing_boundary"],
                             original["magnets"][0]["absorbing_boundary"])

    def test_boolean_regions_keep_the_authored_expression(self) -> None:
        film = self._film()
        a = fm.Box(8e-9, 8e-9, 8e-9)
        b = fm.Sphere(2e-9)
        for geometry in (a - b, a + b, a & b, (a - b).translate((1e-9, 0, 0)).translate((0, 2e-9, 0))):
            with self.subTest(geometry=geometry):
                region = film.add_region(geometry.geometry_name, geometry)
                self.assertEqual(region.to_ir()["shape"], {"kind": "csg", "expression": geometry.to_ir()})

    def test_spatial_layers_round_trip_scene_script_and_ir(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "source.py"
            path.write_text("""
import fullmag as fm
study = fm.study("spatial")
film = study.geometry(fm.Box(1e-6, 1e-6, 1e-8), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = .01
film.add_region("branch", fm.Box(4e-7, 4e-7, 1e-8), region_id="region-1")
G = fm.AbsorbingGeometry
shapes = [
    G.faces(("x-", "y+")),
    G.plane(origin=(2e-8, 3e-8, 0), normal=(1, 2, 3)),
    G.cylinder(center=(1.2345678901234567e-8, 0, 0), axis=(0, 1, 0), radius_m=3e-7, direction="outward"),
    G.sphere(center=(0, 0, 0), radius_m=1e-9, direction="inward"),
    G.region_boundary("region-1"),
    G.expression("min(2e-7-sqrt(x*x+y*y), sqrt(x*x+y*y)-2e-8)"),
]
film.alpha.absorbing_boundary(layers=[
    fm.SpatialAbsorbingLayer(layer_id=f"abl-{i}", name=f"Layer {i}", geometry=shape,
        total_width_m=8.123456789012346e-8, ramp_width_m=5e-8, max_damping=.5,
        region_id="region-1" if i % 2 else None, enabled=i != 2, profile="custom",
        expression="u**3", frame="universe" if i % 2 else "object")
    for i, shape in enumerate(shapes)
])
study.stages.add_run(stage_id="run", until=1e-12)
""", encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            expected = loaded.stages[-1].problem.magnets[0].to_ir()["absorbing_boundary"]
            self.assertEqual([row["geometry"]["kind"] for row in expected["layers"]],
                             ["faces", "plane", "cylinder", "sphere", "region_boundary", "expression"])
            builder = export_builder_draft(loaded)
            scene = build_scene_document_from_builder(builder)
            direct_ir = scene_document_to_problem_ir(
                scene, requested_backend="fdm", requested_device="cpu",
                requested_precision="double", requested_mode="strict", source_root=path.parent,
            )
            self.assertEqual(direct_ir["magnets"][0]["absorbing_boundary"], expected)
            restored = build_builder_from_scene_document(scene)
            self.assertEqual(restored["geometries"][0]["absorbing_boundary"], expected)
            rendered = rewrite_loaded_problem_script(loaded, overrides=restored)["rendered_source"]
            self.assertIn("fm.AbsorbingGeometry.cylinder(", rendered)
            for missing in ("enabled", "profile", "frame"):
                rows = [dict(row) for row in expected["layers"]]
                del rows[0][missing]
                restored["geometries"][0]["absorbing_boundary"] = {"layers": rows}
                with self.subTest(missing=missing), self.assertRaisesRegex(ValueError, missing):
                    rewrite_loaded_problem_script(loaded, overrides=restored)
            path.write_text(rendered, encoding="utf-8")
            reloaded = fm.load_problem_from_script(path, lightweight_assets=True)
            self.assertEqual(reloaded.stages[-1].problem.magnets[0].to_ir()["absorbing_boundary"], expected)

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
