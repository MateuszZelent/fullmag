from __future__ import annotations

import unittest
from dataclasses import replace
from unittest.mock import patch

import fullmag as fm
import fullmag.world as flat_world


class ObjectRegionOwnerIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        fm.reset()
        fm.engine("fem")

    def tearDown(self) -> None:
        fm.reset()

    def _problem(self, *, object_id: str | None):
        layer = fm.geometry(
            fm.Box(200e-9, 80e-9, 4e-9),
            name="track",
            object_id=object_id,
        )
        layer.Ms = 800e3
        layer.Aex = 13e-12
        layer.add_region(
            "core",
            fm.Cylinder(radius=30e-9, height=4e-9),
            region_id="core-id",
            realization_policy="conformal",
        )
        fm.exchange()
        return flat_world._build_problem()

    def _capture(self, problem):
        with (
            patch("subprocess.Popen", side_effect=AssertionError("unexpected subprocess")),
            patch(
                "fullmag.model.problem.build_geometry_assets_for_request",
                return_value=None,
            ) as build_assets,
        ):
            ir = problem.to_ir(include_geometry_assets=True)
        build_assets.assert_called_once()
        return ir, build_assets.call_args.kwargs

    def test_explicit_owner_id_resolves_the_magnetic_geometry(self) -> None:
        problem = self._problem(object_id="immutable-track")
        ir, arguments = self._capture(problem)
        self.assertEqual(ir["object_regions"][0]["owner_object"], "immutable-track")
        self.assertEqual(
            arguments["object_regions"][0]["owner_geometry_name"], "track_geom"
        )
        self.assertEqual(arguments["geometry_object_ids"]["track_geom"], "immutable-track")

    def test_implicit_owner_keeps_the_legacy_name_fallback(self) -> None:
        ir, arguments = self._capture(self._problem(object_id=None))
        self.assertEqual(ir["object_regions"][0]["owner_object"], "track")
        self.assertEqual(
            arguments["object_regions"][0]["owner_geometry_name"], "track_geom"
        )

    def test_display_rename_does_not_lose_an_explicit_owner(self) -> None:
        problem = self._problem(object_id="immutable-track")
        renamed = replace(
            problem,
            magnets=[replace(problem.magnets[0], name="Renamed track")],
        )
        ir, arguments = self._capture(renamed)
        self.assertEqual(ir["magnets"][0]["name"], "Renamed track")
        self.assertEqual(ir["object_regions"][0]["owner_object"], "immutable-track")
        self.assertEqual(
            arguments["object_regions"][0]["owner_geometry_name"], "track_geom"
        )

    def test_another_display_name_cannot_redirect_the_region_owner(self) -> None:
        problem = self._problem(object_id="immutable-track")
        other = fm.geometry(
            fm.Box(100e-9, 40e-9, 4e-9),
            name="immutable-track",
            object_id="other-object",
        )
        other.Ms = 800e3
        other.Aex = 13e-12
        problem = flat_world._build_problem()
        ir, arguments = self._capture(problem)
        self.assertEqual(ir["object_regions"][0]["owner_object"], "immutable-track")
        self.assertEqual(
            arguments["object_regions"][0]["owner_geometry_name"], "track_geom"
        )
        self.assertNotEqual(
            arguments["object_regions"][0]["owner_geometry_name"], "immutable-track_geom"
        )


if __name__ == "__main__":
    unittest.main()
