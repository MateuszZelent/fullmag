"""Air-scoped curvature and narrow-gap controls (docs/physics/0107).

Audit 26 (2026-10-28 UI mesh-build scenario): the Airbox policy accepted
``curvature_factor`` and ``narrow_region_resolution`` but dropped them.  These
tests pin every hop of the round trip and the realized air refinement.
"""

from __future__ import annotations

import os
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

import fullmag as fm
from fullmag import world as flat_world
from fullmag.meshing._airbox_feature_fields import (
    AIRBOX_FEATURE_UNSUPPORTED_ROUTE,
    require_no_airbox_feature_refinement,
)
from fullmag.meshing._gmsh_types import AirboxOptions
from fullmag.meshing.asset_pipeline import _study_universe_airbox_options
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import (
    export_builder_draft,
    render_loaded_problem_as_script,
    render_scene_document_as_script,
)

NM = 1e-9
RADIUS = 50 * NM
SCRIPT = textwrap.dedent(
    """
    import fullmag as fm

    nm = 1e-9
    study = fm.study("airbox_feature_refinement")
    study.engine("fem")
    study.device("cpu", precision="double")
    study.universe(mode="manual", size=(400 * nm, 240 * nm, 240 * nm))
    study.universe.mesh(
        maximum_element_size=40 * nm,
        curvature_factor=0.3,
        narrow_region_resolution=0.5,
    )
    body = study.geometry(fm.Box(size=(80 * nm, 40 * nm, 10 * nm), name="film"), name="film")
    body.Ms = 800e3
    body.Aex = 13e-12
    body.alpha = 0.02
    body.m = fm.texture.uniform(1.0, 0.0, 0.0)
    body.mesh(maximum_element_size=10 * nm)
    study.exchange()
    """
)


def _universe_ir(**mesh_kwargs: object) -> dict[str, object]:
    fm.reset()
    study = fm.study("airbox_feature_ir")
    study.engine("fem")
    study.universe(mode="manual", size=(400 * NM, 240 * NM, 240 * NM))
    study.universe.mesh(**mesh_kwargs)
    body = study.geometry(fm.Box(size=(80 * NM, 40 * NM, 10 * NM), name="film"), name="film")
    body.Ms = 800e3
    body.Aex = 13e-12
    body.alpha = 0.02
    body.m = fm.texture.uniform(1.0, 0.0, 0.0)
    body.mesh(maximum_element_size=10 * NM)
    return flat_world._build_problem().to_ir()["problem_meta"]["runtime_metadata"][
        "study_universe"
    ]


class PublicApiTests(unittest.TestCase):
    def test_controls_reach_study_universe_ir(self) -> None:
        universe = _universe_ir(
            maximum_element_size=40 * NM,
            curvature_factor=0.3,
            narrow_region_resolution=0.5,
        )
        self.assertEqual(universe["airbox_curvature_factor"], 0.3)
        self.assertEqual(universe["airbox_narrow_region_resolution"], 0.5)

    def test_unset_controls_keep_previous_ir_keys(self) -> None:
        universe = _universe_ir(maximum_element_size=40 * NM)
        self.assertNotIn("airbox_curvature_factor", universe)
        self.assertNotIn("airbox_narrow_region_resolution", universe)

    def test_controls_require_air_maximum_element_size(self) -> None:
        with self.assertRaisesRegex(ValueError, "maximum_element_size"):
            _universe_ir(curvature_factor=0.3)

    def test_non_positive_values_are_rejected(self) -> None:
        for key in ("curvature_factor", "narrow_region_resolution"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                _universe_ir(maximum_element_size=40 * NM, **{key: 0.0})

    def test_cell_size_combination_is_rejected(self) -> None:
        fm.reset()
        study = fm.study("airbox_feature_fdm")
        study.engine("fdm")
        with self.assertRaisesRegex(ValueError, "curvature_factor"):
            study.universe.mesh(cell_size=(5 * NM, 5 * NM, 5 * NM), curvature_factor=0.3)


class LoweringTests(unittest.TestCase):
    def test_study_universe_lowers_into_airbox_options(self) -> None:
        airbox = _study_universe_airbox_options(
            [fm.Sphere(RADIUS, name="s")],
            {
                "mode": "manual",
                "size": [400 * NM, 240 * NM, 240 * NM],
                "center": [0.0, 0.0, 0.0],
                "airbox_hmax": 40 * NM,
                "airbox_curvature_factor": 0.3,
                "airbox_narrow_region_resolution": 0.5,
            },
        )
        assert airbox is not None
        self.assertEqual(airbox.curvature_factor, 0.3)
        self.assertEqual(airbox.narrow_region_resolution, 0.5)

    def test_airbox_options_require_far_air_size(self) -> None:
        with self.assertRaisesRegex(ValueError, "maximum_element_size"):
            AirboxOptions(narrow_region_resolution=0.5)

    def test_unsupported_route_fails_instead_of_ignoring(self) -> None:
        airbox = AirboxOptions(maximum_element_size=40 * NM, curvature_factor=0.3)
        with self.assertRaisesRegex(ValueError, AIRBOX_FEATURE_UNSUPPORTED_ROUTE):
            require_no_airbox_feature_refinement(airbox, route="mixed-v2")
        require_no_airbox_feature_refinement(
            AirboxOptions(maximum_element_size=40 * NM), route="mixed-v2"
        )


class ScriptRoundTripTests(unittest.TestCase):
    def _load(self, source: str):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.py"
            path.write_text(source, encoding="utf-8")
            with patch.dict(os.environ, {"FULLMAG_DEMAG_PRINT_LEVEL": "0"}):
                return load_problem_from_script(path, lightweight_assets=True)

    def test_exported_script_preserves_controls(self) -> None:
        loaded = self._load(SCRIPT)
        rendered = render_loaded_problem_as_script(loaded)
        self.assertIn("curvature_factor=0.3", rendered)
        self.assertIn("narrow_region_resolution=0.5", rendered)

        reloaded = self._load(rendered)
        universe = reloaded.problem.runtime_metadata["study_universe"]
        self.assertEqual(universe["airbox_curvature_factor"], 0.3)
        self.assertEqual(universe["airbox_narrow_region_resolution"], 0.5)

    def test_universe_override_from_ui_state_is_exported(self) -> None:
        loaded = self._load(SCRIPT.replace("curvature_factor=0.3,", ""))
        rendered = render_loaded_problem_as_script(
            loaded,
            overrides={
                "universe": {
                    "mode": "manual",
                    "size": [400 * NM, 240 * NM, 240 * NM],
                    "airbox_hmax": 40 * NM,
                    "airbox_curvature_factor": 0.25,
                    "airbox_narrow_region_resolution": 0.75,
                }
            },
        )
        self.assertIn("curvature_factor=0.25", rendered)
        self.assertIn("narrow_region_resolution=0.75", rendered)

    def test_scene_document_universe_is_exported(self) -> None:
        loaded = self._load(SCRIPT)
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        for owner in (scene.get("universe"), scene["study"].get("universe_mesh")):
            if owner is not None:
                self.assertEqual(owner["airbox_curvature_factor"], 0.3)
                self.assertEqual(owner["airbox_narrow_region_resolution"], 0.5)
        rendered = render_scene_document_as_script(scene)
        self.assertIn("curvature_factor=0.3", rendered)
        self.assertIn("narrow_region_resolution=0.5", rendered)


def _realize(airbox_extra: dict[str, object], *, gap: float):
    from fullmag.meshing.asset_pipeline import (
        realize_fem_domain_mesh_asset_from_components_with_report,
    )

    offset = RADIUS + gap / 2.0
    left = fm.Sphere(RADIUS, name="sphere-left").translate((-offset, 0.0, 0.0))
    right = fm.Sphere(RADIUS, name="sphere-right").translate((offset, 0.0, 0.0))
    mesh, region_markers, _report = realize_fem_domain_mesh_asset_from_components_with_report(
        [left, right],
        fm.FEM(order=1, maximum_element_size=12 * NM),
        study_universe={
            "mode": "manual",
            "size": [400 * NM, 240 * NM, 240 * NM],
            "center": [0.0, 0.0, 0.0],
            "airbox_hmax": 40 * NM,
            **airbox_extra,
        },
        mesh_workflow={
            "mesh_options": {"compute_quality": False, "per_element_quality": False},
            "per_geometry": [],
        },
    )
    return mesh, region_markers


def _air_cells(mesh, region_markers):
    nodes = np.asarray(mesh.nodes, dtype=np.float64)
    elements = np.asarray(mesh.elements, dtype=np.int64)
    markers = np.asarray(mesh.element_markers)
    body = {int(entry["marker"]) for entry in region_markers}
    air = ~np.isin(markers, list(body))
    corners = nodes[elements[air]]
    centroids = corners.mean(axis=1)
    a, b, c, d = (corners[:, index] for index in range(4))
    volumes = np.abs(np.einsum("ij,ij->i", b - a, np.cross(c - a, d - a))) / 6.0
    return centroids, volumes


@unittest.skipUnless(
    os.environ.get("FULLMAG_RUN_GMSH_TESTS", "1") != "0",
    "Gmsh regression disabled",
)
class GmshRealizationTests(unittest.TestCase):
    GAP = 20 * NM

    def setUp(self) -> None:
        try:
            import gmsh  # noqa: F401
        except ImportError:
            self.skipTest("gmsh is not installed")

    def test_narrow_gap_control_refines_air_between_spheres(self) -> None:
        def gap_cells(extra):
            centroids, _ = _air_cells(*_realize(extra, gap=self.GAP))
            in_gap = (
                (np.abs(centroids[:, 0]) < self.GAP / 2.0)
                & (np.hypot(centroids[:, 1], centroids[:, 2]) < 20 * NM)
            )
            return int(in_gap.sum())

        baseline = gap_cells({})
        refined = gap_cells({"airbox_narrow_region_resolution": 1.0})
        self.assertGreater(refined, baseline)

    def test_curvature_control_refines_air_next_to_spheres(self) -> None:
        def near_surface_mean_volume(extra):
            centroids, volumes = _air_cells(*_realize(extra, gap=self.GAP))
            offset = RADIUS + self.GAP / 2.0
            distance = np.minimum(
                np.linalg.norm(centroids - [-offset, 0.0, 0.0], axis=1),
                np.linalg.norm(centroids - [offset, 0.0, 0.0], axis=1),
            ) - RADIUS
            shell = (distance > 0.0) & (distance < 10 * NM)
            return float(volumes[shell].mean())

        baseline = near_surface_mean_volume({})
        refined = near_surface_mean_volume({"airbox_curvature_factor": 0.2})
        self.assertLess(refined, baseline)


if __name__ == "__main__":
    unittest.main()
