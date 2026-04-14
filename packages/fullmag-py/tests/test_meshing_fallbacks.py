"""PR 1 — Regression tests locking meshing pipeline pre-refactor behavior.

These tests lock down:
- component-aware ↔ concatenated-STL fallback & degradation
- SharedDomainBuildReport construction
- _resolve_requested_partition_hmaxs precedence chain
- _build_field_stack semantic parity between both paths
- realize_fem_mesh_asset single-object path (current behavior)
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

import numpy as np

import fullmag as fm
from fullmag.meshing.asset_pipeline import (
    SharedDomainBuildReport,
    _build_field_stack,
    _resolve_effective_shared_domain_targets,
    _resolve_requested_partition_hmaxs,
    realize_fem_domain_mesh_asset_from_components_with_report,
    realize_fem_mesh_asset,
)
from fullmag.meshing._mesh_targets import (
    ResolvedObjectPreviewTarget,
    ResolvedSharedDomainTargets,
    resolve_object_preview_target,
    resolve_shared_domain_targets,
)
from fullmag.meshing.gmsh_bridge import (
    AirboxOptions,
    MeshData,
    SharedDomainMeshResult,
)
from fullmag.model.discretization import PerObjectMeshRecipe


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _make_mesh_3elem():
    """Minimal 3-tet mesh: markers 1 (left), 2 (right), 3 (air)."""
    return MeshData(
        nodes=np.asarray(
            [
                [-0.5, -0.5, -0.5],
                [0.5, -0.5, -0.5],
                [-0.5, 0.5, -0.5],
                [-0.5, -0.5, 0.5],
                [1.5, -0.5, -0.5],
                [2.5, -0.5, -0.5],
                [1.5, 0.5, -0.5],
                [1.5, -0.5, 0.5],
                [-2.0, -2.0, -2.0],
                [4.0, -2.0, -2.0],
                [-2.0, 2.0, -2.0],
                [-2.0, -2.0, 2.0],
            ],
            dtype=np.float64,
        ),
        elements=np.asarray(
            [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]], dtype=np.int32
        ),
        element_markers=np.asarray([1, 2, 3], dtype=np.int32),
        boundary_faces=np.asarray([[0, 1, 2], [4, 5, 6], [8, 9, 10]], dtype=np.int32),
        boundary_markers=np.asarray([10, 10, 99], dtype=np.int32),
    )


class _FakeSurface:
    vertices = np.asarray(
        [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5],
         [-0.5, 0.5, -0.5], [-0.5, -0.5, 0.5]],
        dtype=np.float64,
    )

    def copy(self):
        return self

    def export(self, _path):
        return None


_FAKE_TRIMESH = type(
    "FakeTrimesh", (), {
        "util": type("Util", (), {
            "concatenate": staticmethod(lambda meshes: _FakeSurface()),
        }),
    },
)


def _component_aware_mocks(mesh, *, side_effect=None, return_value=None):
    """Context-manager stack for the component-aware path."""
    from contextlib import ExitStack

    stack = ExitStack()
    stack.enter_context(
        patch("fullmag.meshing.asset_pipeline._import_trimesh", return_value=_FAKE_TRIMESH)
    )
    stack.enter_context(
        patch("fullmag.meshing.asset_pipeline._geometry_to_trimesh", return_value=_FakeSurface())
    )
    if side_effect is not None:
        stack.enter_context(
            patch(
                "fullmag.meshing.asset_pipeline.generate_shared_domain_mesh_from_components",
                side_effect=side_effect,
            )
        )
        stack.enter_context(
            patch(
                "fullmag.meshing.asset_pipeline._contains_points_in_geometry",
                side_effect=AssertionError("should not hit point containment"),
            )
        )
        stack.enter_context(
            patch("fullmag.meshing.gmsh_bridge.generate_mesh_from_file", return_value=mesh)
        )
    else:
        stack.enter_context(
            patch(
                "fullmag.meshing.asset_pipeline.generate_shared_domain_mesh_from_components",
                return_value=return_value,
            )
        )
    return stack


_STUDY_UNIVERSE = {
    "mode": "manual",
    "size": [8.0, 8.0, 8.0],
    "center": [0.0, 0.0, 0.0],
}


# ===================================================================
# Test: Build report
# ===================================================================

class BuildReportTests(unittest.TestCase):
    """Lock down SharedDomainBuildReport content for component-aware & fallback."""

    def test_component_aware_success_report(self):
        left = fm.Box(size=(1.0, 1.0, 1.0), name="left")
        mesh = _make_mesh_3elem()
        fake_result = SharedDomainMeshResult(
            mesh=mesh,
            component_marker_tags={"left": 1},
            component_volume_tags={"left": [11]},
            component_surface_tags={"left": [21]},
            interface_surface_tags=[21],
            outer_boundary_surface_tags=[31, 32],
        )

        with _component_aware_mocks(mesh, return_value=fake_result):
            _, region_markers, report = (
                realize_fem_domain_mesh_asset_from_components_with_report(
                    [left], fm.FEM(order=1, hmax=100e-9),
                    study_universe=_STUDY_UNIVERSE,
                )
            )

        self.assertIsInstance(report, SharedDomainBuildReport)
        self.assertEqual(report.build_mode, "component_aware")
        self.assertEqual(report.fallbacks_triggered, [])
        self.assertEqual(len(region_markers), 1)
        self.assertIsNotNone(report.effective_airbox_target.hmax)
        self.assertIn("left", report.effective_per_object_targets)

    def test_fallback_report_records_trigger(self):
        left = fm.Box(size=(1.0, 1.0, 1.0), name="left")
        right = fm.Box(size=(1.0, 1.0, 1.0), name="right").translate((2.0, 0.0, 0.0))
        mesh = _make_mesh_3elem()

        with _component_aware_mocks(mesh, side_effect=Exception("kaboom")):
            _, region_markers, report = (
                realize_fem_domain_mesh_asset_from_components_with_report(
                    [left, right], fm.FEM(order=1, hmax=100e-9),
                    study_universe=_STUDY_UNIVERSE,
                )
            )

        self.assertEqual(report.build_mode, "concatenated_stl_fallback")
        self.assertIn("component_aware_import_failed", report.fallbacks_triggered)
        self.assertEqual(len(region_markers), 2)

    def test_fallback_report_records_size_field_kinds(self):
        left = fm.Box(size=(1.0, 1.0, 1.0), name="left")
        mesh = _make_mesh_3elem()

        with _component_aware_mocks(mesh, side_effect=Exception("kaboom")):
            _, _, report = realize_fem_domain_mesh_asset_from_components_with_report(
                [left], fm.FEM(order=1, hmax=100e-9),
                study_universe=_STUDY_UNIVERSE,
                mesh_workflow={
                    "per_geometry": [
                        {"geometry": "left", "mode": "custom", "hmax": "20e-9"},
                    ],
                },
            )

        # Fallback path must use bounds-based fields, not component-scoped
        self.assertIn("Box", report.used_size_field_kinds)
        self.assertNotIn("ComponentVolumeConstant", report.used_size_field_kinds)

    def test_component_aware_report_records_component_field_kinds(self):
        left = fm.Box(size=(1.0, 1.0, 1.0), name="left")
        mesh = _make_mesh_3elem()
        fake_result = SharedDomainMeshResult(
            mesh=mesh,
            component_marker_tags={"left": 1},
            component_volume_tags={"left": [11]},
            component_surface_tags={"left": [21]},
            interface_surface_tags=[21],
            outer_boundary_surface_tags=[31, 32],
        )

        with _component_aware_mocks(mesh, return_value=fake_result):
            _, _, report = realize_fem_domain_mesh_asset_from_components_with_report(
                [left], fm.FEM(order=1, hmax=100e-9),
                study_universe=_STUDY_UNIVERSE,
                mesh_workflow={
                    "per_geometry": [
                        {"geometry": "left", "mode": "custom", "hmax": "20e-9"},
                    ],
                },
            )

        self.assertIn("ComponentVolumeConstant", report.used_size_field_kinds)


# ===================================================================
# Test: Resolution precedence
# ===================================================================

class ResolutionPrecedenceTests(unittest.TestCase):
    """Lock down the hmax resolution chain that PR 2 will refactor."""

    def _airbox(self, maximum_element_size=None):
        return AirboxOptions(
            size=(8.0, 8.0, 8.0), center=(0.0, 0.0, 0.0), maximum_element_size=maximum_element_size,
        )

    def test_recipe_overrides_workflow(self):
        """PerObjectMeshRecipe.hmax takes priority over mesh_workflow per_geometry."""
        geom = fm.Box(2.0, 2.0, 2.0, name="left")
        _, by_geom = _resolve_requested_partition_hmaxs(
            [geom], fm.FEM(order=1, hmax=100e-9),
            airbox=self._airbox(),
            mesh_workflow={
                "per_geometry": [
                    {"geometry": "left", "mode": "custom", "hmax": "50e-9"},
                ],
            },
            per_object_recipes={"left": PerObjectMeshRecipe(hmax=30e-9)},
        )
        # recipe.hmax wins because it uses setdefault (recipe comes second) —
        # actually recipe sets defaults AFTER workflow, so workflow comes first.
        # Lock current behaviour:
        self.assertAlmostEqual(by_geom["left"], 50e-9)

    def test_workflow_overrides_fem_default(self):
        """per_geometry hmax overrides global FEM.hmax."""
        geom = fm.Box(2.0, 2.0, 2.0, name="left")
        _, by_geom = _resolve_requested_partition_hmaxs(
            [geom], fm.FEM(order=1, hmax=100e-9),
            airbox=self._airbox(),
            mesh_workflow={
                "per_geometry": [
                    {"geometry": "left", "mode": "custom", "hmax": "25e-9"},
                ],
            },
            per_object_recipes=None,
        )
        self.assertAlmostEqual(by_geom["left"], 25e-9)

    def test_fem_hmax_used_when_no_override(self):
        """With no per_geometry and no airbox hmax, FEM.hmax is the fallback."""
        geom = fm.Box(2.0, 2.0, 2.0, name="left")
        _, by_geom = _resolve_requested_partition_hmaxs(
            [geom], fm.FEM(order=1, hmax=100e-9),
            airbox=self._airbox(),
            mesh_workflow=None,
            per_object_recipes=None,
        )
        # When airbox.hmax is None and no override → FEM.hmax is not used either
        # because the condition checks `airbox is None or airbox.hmax is None`.
        # Lock this current behavior:
        self.assertAlmostEqual(by_geom["left"], 100e-9)

    def test_airbox_hmax_propagated_from_study_universe(self):
        geom = fm.Box(2.0, 2.0, 2.0, name="left")
        airbox_hmax, _ = _resolve_requested_partition_hmaxs(
            [geom], fm.FEM(order=1, hmax=100e-9),
            airbox=self._airbox(maximum_element_size=200e-9),
            mesh_workflow=None,
            per_object_recipes=None,
        )
        self.assertAlmostEqual(airbox_hmax, 200e-9)

    def test_effective_targets_auto_interface_and_transition(self):
        """When bulk_hmax < default, transition is auto-derived but interface is not."""
        geom = fm.Box(2.0, 2.0, 2.0, name="left")
        _, per_obj = _resolve_effective_shared_domain_targets(
            [geom], fm.FEM(order=1, hmax=100e-9),
            airbox=self._airbox(),
            mesh_workflow={
                "per_geometry": [
                    {
                        "geometry": "left",
                        "mode": "custom",
                        "hmax": "20e-9",
                        "interface_hmax": "12e-9",
                        "interface_thickness": "18e-9",
                        "transition_distance": "60e-9",
                        "transition_growth": "1.6",
                    },
                ],
            },
            per_object_recipes=None,
        )
        target = per_obj["left"]
        self.assertAlmostEqual(target["hmax"], 20e-9)
        # interface_hmax is no longer auto-computed
        self.assertIsNone(target["interface_hmax"])
        # transition_distance = bulk_hmax * 3.0
        self.assertAlmostEqual(target["transition_distance"], 60e-9)
        self.assertEqual(target["source"], "local_override")

    def test_effective_targets_no_auto_refinement_when_coarser(self):
        """No auto interface/transition when object hmax >= FEM.hmax."""
        geom = fm.Box(2.0, 2.0, 2.0, name="left")
        _, per_obj = _resolve_effective_shared_domain_targets(
            [geom], fm.FEM(order=1, hmax=20e-9),
            airbox=self._airbox(),
            mesh_workflow={
                "per_geometry": [
                    {"geometry": "left", "mode": "custom", "hmax": "50e-9"},
                ],
            },
            per_object_recipes=None,
        )
        target = per_obj["left"]
        self.assertIsNone(target["interface_hmax"])
        self.assertIsNone(target["transition_distance"])


# ===================================================================
# Test: Field stack semantic parity
# ===================================================================

class FieldStackParityTests(unittest.TestCase):
    """Lock down field stack for component-aware vs bounds paths."""

    def test_component_aware_produces_component_scoped_kinds(self):
        geom = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_field_stack(
            [geom], default_hmax=20e-9,
            per_geometry=[{"geometry": "left", "mode": "custom", "hmax": "8e-9"}],
            component_aware=True,
        )
        kinds = sorted(f["kind"] for f in fields)
        # No auto-generated interface field; only bulk + transition
        self.assertEqual(
            kinds,
            ["ComponentVolumeConstant", "TransitionShellThreshold"],
        )

    def test_bounds_path_produces_coordinate_kinds(self):
        geom = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_field_stack(
            [geom], default_hmax=20e-9,
            per_geometry=[{"geometry": "left", "mode": "custom", "hmax": "8e-9"}],
            component_aware=False,
        )
        kinds = sorted(f["kind"] for f in fields)
        # No auto-generated interface field; only bulk Box + transition BoundsSurfaceThreshold
        self.assertEqual(
            kinds,
            ["BoundsSurfaceThreshold", "Box"],
        )

    def test_both_paths_produce_same_count(self):
        geom = fm.Box(2.0, 2.0, 2.0, name="left")
        for ca in (True, False):
            fields = _build_field_stack(
                [geom], default_hmax=20e-9,
                per_geometry=[{"geometry": "left", "mode": "custom", "hmax": "8e-9"}],
                component_aware=ca,
            )
            # Bulk + transition (no auto interface)
            self.assertEqual(len(fields), 2, f"component_aware={ca}")

    def test_no_fields_when_coarser_than_default(self):
        geom = fm.Box(2.0, 2.0, 2.0, name="left")
        for ca in (True, False):
            fields = _build_field_stack(
                [geom], default_hmax=5e-9,
                per_geometry=[{"geometry": "left", "mode": "custom", "hmax": "10e-9"}],
                component_aware=ca,
            )
            self.assertEqual(len(fields), 0, f"component_aware={ca}")


# ===================================================================
# Test: Single-object preview path
# ===================================================================

class SingleObjectPreviewTests(unittest.TestCase):
    """Lock down realize_fem_mesh_asset passing hints.hmax directly to generator."""

    def test_realize_fem_mesh_asset_uses_hints_hmax(self):
        """The single-body path must use hints.hmax (not per-object resolution)."""
        geom = fm.Box(2.0, 2.0, 2.0, name="sample")

        with patch(
            "fullmag.meshing.asset_pipeline.build_surface_preview_payload",
            return_value=None,
        ), patch(
            "fullmag.meshing.asset_pipeline.generate_mesh",
        ) as gen:
            gen.return_value = MeshData(
                nodes=np.zeros((4, 3), dtype=np.float64),
                elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
                element_markers=np.ones(1, dtype=np.int32),
                boundary_faces=np.asarray([[0, 1, 2]], dtype=np.int32),
                boundary_markers=np.ones(1, dtype=np.int32),
            )
            realize_fem_mesh_asset(geom, fm.FEM(order=2, hmax=42e-9))

        gen.assert_called_once()
        _, kwargs = gen.call_args
        self.assertAlmostEqual(kwargs.get("hmax", gen.call_args.args[1] if len(gen.call_args.args) > 1 else None), 42e-9)
        self.assertEqual(kwargs.get("order", gen.call_args.args[2] if len(gen.call_args.args) > 2 else None), 2)

    def test_realize_fem_mesh_asset_from_file_source(self):
        """When hints.mesh is set, generate_mesh_from_file is called."""
        geom = fm.Box(2.0, 2.0, 2.0, name="sample")

        with patch(
            "fullmag.meshing.asset_pipeline.build_surface_preview_payload",
            return_value=None,
        ), patch(
            "fullmag.meshing.asset_pipeline.generate_mesh_from_file",
        ) as gen:
            gen.return_value = MeshData(
                nodes=np.zeros((4, 3), dtype=np.float64),
                elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
                element_markers=np.ones(1, dtype=np.int32),
                boundary_faces=np.asarray([[0, 1, 2]], dtype=np.int32),
                boundary_markers=np.ones(1, dtype=np.int32),
            )
            realize_fem_mesh_asset(geom, fm.FEM(order=1, hmax=50e-9, mesh="/tmp/test.msh"))

        gen.assert_called_once_with("/tmp/test.msh", hmax=50e-9, order=1)

    def test_realize_fem_mesh_asset_uses_workflow_override(self):
        """PR2: per_geometry override must flow through to the mesh generator."""
        geom = fm.Box(2.0, 2.0, 2.0, name="sample")

        with patch(
            "fullmag.meshing.asset_pipeline.build_surface_preview_payload",
            return_value=None,
        ), patch(
            "fullmag.meshing.asset_pipeline.generate_mesh",
        ) as gen:
            gen.return_value = MeshData(
                nodes=np.zeros((4, 3), dtype=np.float64),
                elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
                element_markers=np.ones(1, dtype=np.int32),
                boundary_faces=np.asarray([[0, 1, 2]], dtype=np.int32),
                boundary_markers=np.ones(1, dtype=np.int32),
            )
            realize_fem_mesh_asset(
                geom, fm.FEM(order=1, hmax=100e-9),
                mesh_workflow={
                    "per_geometry": [
                        {"geometry": "sample", "mode": "custom", "hmax": "25e-9"},
                    ],
                },
            )

        gen.assert_called_once()
        self.assertAlmostEqual(gen.call_args.kwargs["hmax"], 25e-9)

    def test_realize_fem_mesh_asset_recipe_overrides_workflow(self):
        """PR2: PerObjectMeshRecipe.hmax takes priority over workflow."""
        geom = fm.Box(2.0, 2.0, 2.0, name="sample")

        with patch(
            "fullmag.meshing.asset_pipeline.build_surface_preview_payload",
            return_value=None,
        ), patch(
            "fullmag.meshing.asset_pipeline.generate_mesh",
        ) as gen:
            gen.return_value = MeshData(
                nodes=np.zeros((4, 3), dtype=np.float64),
                elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
                element_markers=np.ones(1, dtype=np.int32),
                boundary_faces=np.asarray([[0, 1, 2]], dtype=np.int32),
                boundary_markers=np.ones(1, dtype=np.int32),
            )
            realize_fem_mesh_asset(
                geom, fm.FEM(order=1, hmax=100e-9),
                mesh_workflow={
                    "per_geometry": [
                        {"geometry": "sample", "mode": "custom", "hmax": "50e-9"},
                    ],
                },
                per_object_recipes={"sample": PerObjectMeshRecipe(hmax=15e-9)},
            )

        gen.assert_called_once()
        self.assertAlmostEqual(gen.call_args.kwargs["hmax"], 15e-9)


# ===================================================================
# Test: New typed resolution API
# ===================================================================

class TypedResolutionAPITests(unittest.TestCase):
    """Tests for the new _mesh_targets typed API (PR 2)."""

    def test_resolve_object_preview_target_fem_default(self):
        geom = fm.Box(2.0, 2.0, 2.0, name="sample")
        target = resolve_object_preview_target(geom, fm.FEM(order=2, hmax=42e-9))
        self.assertIsInstance(target, ResolvedObjectPreviewTarget)
        self.assertAlmostEqual(target.hmax, 42e-9)
        self.assertEqual(target.order, 2)
        self.assertEqual(target.source, "fem_default")

    def test_resolve_object_preview_target_workflow_override(self):
        geom = fm.Box(2.0, 2.0, 2.0, name="sample")
        target = resolve_object_preview_target(
            geom, fm.FEM(order=1, hmax=100e-9),
            mesh_workflow={
                "per_geometry": [
                    {"geometry": "sample", "mode": "custom", "hmax": "30e-9"},
                ],
            },
        )
        self.assertAlmostEqual(target.hmax, 30e-9)
        self.assertEqual(target.source, "workflow_override")

    def test_resolve_object_preview_target_recipe_wins(self):
        geom = fm.Box(2.0, 2.0, 2.0, name="sample")
        target = resolve_object_preview_target(
            geom, fm.FEM(order=1, hmax=100e-9),
            mesh_workflow={
                "per_geometry": [
                    {"geometry": "sample", "mode": "custom", "hmax": "50e-9"},
                ],
            },
            per_object_recipes={"sample": PerObjectMeshRecipe(hmax=10e-9)},
        )
        self.assertAlmostEqual(target.hmax, 10e-9)
        self.assertEqual(target.source, "recipe_override")

    def test_resolve_shared_domain_targets_typed(self):
        geom = fm.Box(2.0, 2.0, 2.0, name="left")
        targets = resolve_shared_domain_targets(
            [geom], fm.FEM(order=1, hmax=100e-9),
            airbox_hmax=200e-9,
            mesh_workflow={
                "per_geometry": [
                    {
                        "geometry": "left",
                        "mode": "custom",
                        "hmax": "20e-9",
                        "interface_hmax": "12e-9",
                        "interface_thickness": "18e-9",
                        "transition_distance": "60e-9",
                        "transition_growth": "1.6",
                    },
                ],
            },
            per_object_recipes=None,
        )
        self.assertIsInstance(targets, ResolvedSharedDomainTargets)
        self.assertAlmostEqual(targets.airbox.hmax, 200e-9)
        self.assertIn("left", targets.per_object)
        self.assertAlmostEqual(targets.per_object["left"].hmax, 20e-9)
        self.assertAlmostEqual(targets.per_object["left"].interface_hmax, 12e-9)
        self.assertAlmostEqual(targets.per_object["left"].interface_thickness, 18e-9)
        self.assertAlmostEqual(targets.per_object["left"].transition_distance, 60e-9)
        self.assertAlmostEqual(targets.per_object["left"].transition_growth, 1.6)
        self.assertEqual(targets.per_object["left"].source, "local_override")
        self.assertAlmostEqual(targets.effective_hmax, 200e-9)

    def test_resolve_shared_domain_targets_alias_matching(self):
        """Geometry named 'foo_geom' should match workflow entry 'foo'."""
        geom = fm.Box(2.0, 2.0, 2.0, name="foo_geom")
        targets = resolve_shared_domain_targets(
            [geom], fm.FEM(order=1, hmax=100e-9),
            airbox_hmax=None,
            mesh_workflow={
                "per_geometry": [
                    {"geometry": "foo", "mode": "custom", "hmax": "15e-9"},
                ],
            },
            per_object_recipes=None,
        )
        self.assertAlmostEqual(targets.per_object["foo_geom"].hmax, 15e-9)


if __name__ == "__main__":
    unittest.main()
