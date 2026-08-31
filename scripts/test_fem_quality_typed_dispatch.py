"""Direct regression tests for the public FEM quality dispatch boundary.

This runner intentionally uses only ``unittest`` so it remains executable in
the source-only Windows preflight environment where the optional pytest
development dependency may not be installed.
"""

from __future__ import annotations

from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from types import SimpleNamespace

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_SRC = REPO_ROOT / "packages" / "fullmag-py" / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from fullmag.meshing import (  # noqa: E402
    MeshGrowthValidationError,
    GmshQualityExtractionError,
    MeshData,
    MeshPhysicalTagCoverageError,
    MeshQualityReport,
    MeshOptions,
    MeshQualityFailureV2,
    AirboxOptions,
    MeshValidationCompatibilityError,
    build_typed_quality_summary,
    measure_adjacent_size_growth,
    validate_adjacent_size_growth,
    validate_mesh,
    validate_typed_mesh,
    validate_typed_mesh_strict,
    validate_typed_quality_summary,
)
from fullmag.meshing.mesh_controls import (  # noqa: E402
    boundary_layers,
    nearest_surface_to_point,
)
from fullmag.model.discretization import SweepDistribution  # noqa: E402
from fullmag.model.geometry import Box, Cylinder  # noqa: E402
from fullmag.meshing._gmsh_swept import (  # noqa: E402
    _resolve_sweep_axis,
    generate_swept_mesh,
)
from fullmag.meshing.remesh_cli import _mesh_result_payload  # noqa: E402
from fullmag.meshing._gmsh_extraction import (  # noqa: E402
    _align_quality_report_to_element_tags,
    _extract_element_markers_for_tags,
    _extract_quality_metrics,
)
from fullmag.meshing.asset_pipeline import (  # noqa: E402
    ComponentIdentityResolutionError,
    MeshQualityUnavailableError,
    _drop_degenerate_tetrahedra,
    _match_geometry_bounds_to_source_markers,
)
from fullmag.meshing.fmmq import _cell_metrics  # noqa: E402


def _mixed_mesh(*, invert_prism: bool = False) -> MeshData:
    prism = [4, 5, 6, 7, 8, 9]
    if invert_prism:
        prism = [4, 6, 5, 7, 9, 8]
    return MeshData(
        nodes=np.asarray(
            [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [2.0, 0.0, 0.0],
                [3.0, 0.0, 0.0],
                [2.0, 1.0, 0.0],
                [2.0, 0.0, 1.0],
                [3.0, 0.0, 1.0],
                [2.0, 1.0, 1.0],
            ],
            dtype=np.float64,
        ),
        cell_types=np.asarray(["tet4", "prism6"]),
        cell_offsets=np.asarray([0, 4, 10], dtype=np.int64),
        cell_nodes=np.asarray([0, 1, 2, 3, *prism], dtype=np.int32),
        element_markers=np.asarray([1, 2], dtype=np.int32),
        facet_types=np.asarray([], dtype=np.str_),
        facet_roles=np.asarray([], dtype=np.str_),
        facet_offsets=np.asarray([0], dtype=np.int64),
        facet_nodes=np.asarray([], dtype=np.int32),
        boundary_markers=np.asarray([], dtype=np.int32),
        cell_global_ordinals=np.asarray([0, 1], dtype=np.int64),
        facet_global_ordinals=np.asarray([], dtype=np.int64),
    )


class TypedQualityDispatchTests(unittest.TestCase):
    def test_tet4_legacy_report_remains_compatible(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ]
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.zeros((0, 3), dtype=np.int32),
            boundary_markers=np.zeros((0,), dtype=np.int32),
        )
        report = validate_mesh(mesh)
        self.assertTrue(report.is_valid)
        self.assertEqual(report.n_elements, 1)
        self.assertAlmostEqual(report.min_volume, 1.0 / 6.0)

    def test_mixed_mesh_is_rejected_before_tet4_compatibility_view(self) -> None:
        with self.assertRaises(MeshValidationCompatibilityError) as caught:
            validate_mesh(_mixed_mesh())
        error = caught.exception
        self.assertEqual(error.code, "tet4_only_validator_mixed_topology")
        self.assertEqual(error.pointer, "/cell_types")
        self.assertEqual(error.families, ("prism6", "tet4"))
        self.assertIn("validate_typed_mesh", str(error))

    def test_typed_dispatch_reports_each_mixed_family(self) -> None:
        report = validate_typed_mesh(_mixed_mesh())
        self.assertTrue(report.is_valid)
        self.assertEqual(report.n_elements, 2)
        self.assertEqual([family.family for family in report.families], ["prism6", "tet4"])
        self.assertEqual([family.n_elements for family in report.families], [1, 1])
        self.assertTrue(all(family.is_valid for family in report.families))
        self.assertEqual(report.family_reports, report.families)

    def test_typed_quality_summary_reconciles_family_and_region_buckets(self) -> None:
        mesh = _mixed_mesh()
        summary = build_typed_quality_summary(mesh)
        self.assertTrue(summary.is_valid)
        self.assertEqual(summary.element_count, 2)
        self.assertEqual(summary.assigned_element_count, 2)
        self.assertEqual(summary.unassigned_element_count, 0)
        self.assertEqual(
            {(scope.family, scope.material_region) for scope in summary.scopes},
            {("tet4", 1), ("prism6", 2)},
        )
        for scope in summary.scopes:
            self.assertEqual(scope.metrics["cell.volume.v1"]["count"], 1)
            self.assertIn(f"signed_jacobian.{scope.family}.v1", scope.metrics)

    def test_typed_quality_threshold_failure_is_structured(self) -> None:
        with self.assertRaises(MeshQualityFailureV2) as caught:
            validate_typed_quality_summary(
                _mixed_mesh(),
                thresholds={"signed_jacobian.prism6.v1": {"minimum": 0.9}},
                policy_fingerprint="sha256:policy",
                topology_fingerprint="sha256:topology",
                evidence_path="quality.fmmq",
            )
        error = caught.exception
        self.assertEqual(error.code, "mesh_quality_threshold_exceeded")
        self.assertEqual(error.metric_id, "signed_jacobian.prism6.v1")
        self.assertEqual(error.family, "prism6")
        self.assertEqual(error.element_ordinals, (1,))
        payload = error.to_dict()
        self.assertEqual(payload["schema_version"], "mesh_quality_failure.v2")
        self.assertEqual(payload["pointer"], "/quality/signed_jacobian.prism6.v1")
        self.assertEqual(payload["policy_fingerprint"], "sha256:policy")
        self.assertEqual(payload["topology_fingerprint"], "sha256:topology")

    def test_strict_typed_dispatch_catches_inverted_prism(self) -> None:
        report = validate_typed_mesh_strict(_mixed_mesh(invert_prism=True))
        self.assertFalse(report.is_valid)
        prism = next(family for family in report.families if family.family == "prism6")
        self.assertEqual(prism.n_inverted, 1)
        self.assertFalse(prism.is_valid)

    def test_unknown_future_family_is_rejected_by_typed_mesh_contract(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown cell type"):
            MeshData(
                nodes=np.zeros((4, 3), dtype=np.float64),
                cell_types=np.asarray(["future15"]),
                cell_offsets=np.asarray([0, 4], dtype=np.int64),
                cell_nodes=np.asarray([0, 1, 2, 3], dtype=np.int32),
                element_markers=np.asarray([1], dtype=np.int32),
                facet_types=np.asarray([], dtype=np.str_),
                facet_roles=np.asarray([], dtype=np.str_),
                facet_offsets=np.asarray([0], dtype=np.int64),
                facet_nodes=np.asarray([], dtype=np.int32),
                boundary_markers=np.asarray([], dtype=np.int32),
                cell_global_ordinals=np.asarray([0], dtype=np.int64),
                facet_global_ordinals=np.asarray([], dtype=np.int64),
            )

    def test_remesh_payload_rejects_measured_growth_violation(self) -> None:
        # Two positively oriented tetrahedra share one face, but the second
        # apex is deliberately far away.  The declared growth law must be a
        # hard publication gate rather than diagnostic metadata.
        mesh = MeshData(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [0.0, 0.0, -10.0],
                ],
                dtype=np.float64,
            ),
            cell_types=np.asarray(["tet4", "tet4"]),
            cell_offsets=np.asarray([0, 4, 8], dtype=np.int64),
            cell_nodes=np.asarray([0, 1, 2, 3, 0, 2, 1, 4], dtype=np.int32),
            element_markers=np.asarray([1, 1], dtype=np.int32),
            facet_types=np.asarray([], dtype=np.str_),
            facet_roles=np.asarray([], dtype=np.str_),
            facet_offsets=np.asarray([0], dtype=np.int64),
            facet_nodes=np.asarray([], dtype=np.int32),
            boundary_markers=np.asarray([], dtype=np.int32),
            cell_global_ordinals=np.asarray([0, 1], dtype=np.int64),
            facet_global_ordinals=np.asarray([], dtype=np.int64),
        )

        with TemporaryDirectory() as artifact_dir:
            with self.assertRaises(MeshGrowthValidationError) as caught:
                _mesh_result_payload(
                    mesh,
                    mesh_name="growth-gate",
                    generation_mode="generated",
                    mesh_provenance={"mesh_options": {"growth_rate": 1.3}},
                    topology_artifact_dir=artifact_dir,
                    inline_topology_max_bytes=0,
                )
            self.assertEqual(list(Path(artifact_dir).iterdir()), [])
        self.assertEqual(caught.exception.code, "adjacent_size_growth_exceeded")
        self.assertGreater(caught.exception.report.violation_count, 0)
        growth_payload = caught.exception.to_dict()
        self.assertEqual(growth_payload["schema_version"], "mesh_quality_failure.v2")
        self.assertEqual(growth_payload["metric_id"], "adjacent_size_growth.v1")
        self.assertGreater(growth_payload["details"]["violation_count"], 0)

    def test_remesh_payload_rejects_declared_growth_without_neighbor_pairs(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.zeros((0, 3), dtype=np.int32),
            boundary_markers=np.zeros((0,), dtype=np.int32),
        )

        with self.assertRaises(MeshGrowthValidationError) as caught:
            _mesh_result_payload(
                mesh,
                mesh_name="growth-pair-gate",
                generation_mode="generated",
                mesh_provenance={"mesh_options": {"growth_rate": 1.3}},
            )
        self.assertEqual(caught.exception.report.evaluated_pair_count, 0)
        self.assertFalse(caught.exception.report.is_valid)


class _PhysicalGroupGmsh:
    def __init__(self, groups: list[tuple[int, int]], tags_by_group: dict[int, list[int]]) -> None:
        self._groups = groups
        self._tags_by_group = tags_by_group
        self.model = SimpleNamespace(
            mesh=SimpleNamespace(getElements=self._get_elements),
            getPhysicalGroups=self.getPhysicalGroups,
            getEntitiesForPhysicalGroup=self.getEntitiesForPhysicalGroup,
        )

    def getPhysicalGroups(self, *, dim: int) -> list[tuple[int, int]]:
        return [group for group in self._groups if group[0] == dim]

    def getEntitiesForPhysicalGroup(self, dim: int, marker: int) -> list[int]:
        return [int(marker)]

    def _get_elements(self, dim: int, entity: int) -> tuple[list[int], list[np.ndarray], list[np.ndarray]]:
        if dim != 3:
            return [], [], []
        return [4], [np.asarray(self._tags_by_group.get(int(entity), []), dtype=np.int64)], []


class _QualityGmsh:
    def __init__(self, responses: dict[str, object]) -> None:
        self._responses = responses
        self.model = SimpleNamespace(mesh=SimpleNamespace(
            getElements=lambda dim: (
                [4],
                [np.asarray([101, 102], dtype=np.int64)],
                [],
            ),
            getElementQualities=lambda _tags, channel: self._responses[channel],
        ))
        self.option = SimpleNamespace(getNumber=lambda _name: 0.75)


class ExtractionGuardTests(unittest.TestCase):
    def test_physical_tag_mapping_requires_complete_coverage(self) -> None:
        gmsh = _PhysicalGroupGmsh([(3, 1)], {1: [101]})
        with self.assertRaises(MeshPhysicalTagCoverageError) as caught:
            _extract_element_markers_for_tags(gmsh, [101, 102])
        self.assertEqual(caught.exception.missing_tags, (102,))
        self.assertEqual(caught.exception.to_dict()["schema_version"], "mesh_quality_failure.v2")
        self.assertEqual(caught.exception.to_dict()["details"]["missing_tags"], [102])

    def test_physical_tag_mapping_rejects_extra_and_duplicate_tags(self) -> None:
        with self.assertRaises(MeshPhysicalTagCoverageError) as extra:
            _extract_element_markers_for_tags(
                _PhysicalGroupGmsh([(3, 1)], {1: [101, 999]}),
                [101],
            )
        self.assertEqual(extra.exception.extra_tags, (999,))

        with self.assertRaises(MeshPhysicalTagCoverageError) as duplicate:
            _extract_element_markers_for_tags(
                _PhysicalGroupGmsh([(3, 1), (3, 2)], {1: [101], 2: [101]}),
                [101],
            )
        self.assertEqual(duplicate.exception.duplicate_tags, {101: (1, 2)})

    def test_physical_tag_mapping_preserves_explicit_marker_one(self) -> None:
        markers = _extract_element_markers_for_tags(
            _PhysicalGroupGmsh([(3, 1), (3, 7)], {1: [101], 7: [102]}),
            [101, 102],
        )
        np.testing.assert_array_equal(markers, np.asarray([1, 7], dtype=np.int32))

    def test_gmsh_quality_channels_reject_short_long_and_nonfinite(self) -> None:
        valid = {"minSICN": [0.1, 0.2], "gamma": [0.3, 0.4], "volume": [1.0, 2.0]}
        quality, per_domain = _extract_quality_metrics(_QualityGmsh(valid), MeshOptions())
        self.assertEqual(quality.n_elements, 2)
        self.assertIsNone(per_domain)

        for channel, response in (
            ("gamma", [0.3]),
            ("volume", [1.0, 2.0, 3.0]),
            ("minSICN", [0.1, float("nan")]),
            ("gamma", [0.3, float("inf")]),
        ):
            responses = dict(valid)
            responses[channel] = response
            with self.subTest(channel=channel, response=response), self.assertRaises(
                GmshQualityExtractionError
            ) as caught:
                _extract_quality_metrics(_QualityGmsh(responses), MeshOptions())
            self.assertEqual(caught.exception.code, "gmsh_quality_malformed")
            self.assertEqual(caught.exception.to_dict()["schema_version"], "mesh_quality_failure.v2")
            self.assertEqual(caught.exception.to_dict()["metric_id"], channel)

    def test_quality_tag_alignment_reorders_and_rejects_mismatch(self) -> None:
        quality = MeshQualityReport(
            n_elements=2,
            sicn_min=0.1,
            sicn_max=0.8,
            sicn_mean=0.45,
            sicn_p5=0.135,
            sicn_histogram=[0] * 20,
            gamma_min=0.2,
            gamma_mean=0.55,
            gamma_histogram=[0] * 20,
            volume_min=1.0,
            volume_max=2.0,
            volume_mean=1.5,
            volume_std=0.5,
            avg_quality=0.45,
            element_sicn=[0.1, 0.8],
            element_gamma=[0.2, 0.9],
            element_volume=[1.0, 2.0],
            element_tags=[20, 10],
        )
        reordered = _align_quality_report_to_element_tags(quality, [10, 20])
        self.assertEqual(reordered.element_sicn, [0.8, 0.1])
        with self.assertRaises(GmshQualityExtractionError):
            _align_quality_report_to_element_tags(quality, [10, 30])


class NumericContractTests(unittest.TestCase):
    @staticmethod
    def _neighbor_tet_mesh() -> MeshData:
        return MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [0.0, 0.0, -2.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3], [0, 2, 1, 4]], dtype=np.int32),
            element_markers=np.asarray([1, 0], dtype=np.int32),
            boundary_faces=np.zeros((0, 3), dtype=np.int32),
            boundary_markers=np.zeros((0,), dtype=np.int32),
        )

    def test_adjacent_growth_measures_full_face_pairs_and_worst_owner(self) -> None:
        report = measure_adjacent_size_growth(
            self._neighbor_tet_mesh(),
            resolved_growth_rate=3.0,
            tolerance=0.0,
        )
        self.assertEqual(report.metric_definition_id, "adjacent_size_growth.v1")
        self.assertEqual(report.candidate_face_count, 1)
        self.assertEqual(report.evaluated_pair_count, 1)
        self.assertEqual(report.violation_count, 0)
        self.assertTrue(report.is_valid)
        self.assertEqual((report.worst_pairs[0].left_ordinal, report.worst_pairs[0].right_ordinal), (0, 1))
        self.assertEqual(report.worst_pairs[0].face_nodes, (0, 1, 2))

    def test_adjacent_growth_gate_fails_with_structured_worst_pair(self) -> None:
        report = measure_adjacent_size_growth(
            self._neighbor_tet_mesh(),
            resolved_growth_rate=1.1,
        )
        self.assertFalse(report.is_valid)
        self.assertGreater(report.violation_count, 0)
        with self.assertRaises(MeshGrowthValidationError) as caught:
            validate_adjacent_size_growth(
                self._neighbor_tet_mesh(),
                resolved_growth_rate=1.1,
            )
        self.assertEqual(caught.exception.code, "adjacent_size_growth_exceeded")
        self.assertEqual(caught.exception.pointer, "/quality/adjacent_size_growth")

    def test_adjacent_growth_rate_one_is_not_an_active_grading_policy(self) -> None:
        with self.assertRaisesRegex(ValueError, "greater than 1.0"):
            measure_adjacent_size_growth(
                self._neighbor_tet_mesh(),
                resolved_growth_rate=1.0,
            )

    def test_airbox_growth_rate_one_is_rejected_at_typed_boundary(self) -> None:
        with self.assertRaisesRegex(ValueError, "airbox_growth_rate"):
            AirboxOptions(grading_ratio=1.0)

    def test_family_metrics_use_physical_edges_not_cell_diagonals(self) -> None:
        raw, _families, _family_rows, _scope_rows = _cell_metrics(_mixed_mesh())
        # The prism has a non-edge corner-to-corner diagonal of sqrt(3), while
        # its longest actual triangular-base edge is sqrt(2).  A diagonal in
        # ``cell.max_edge`` would therefore be a false quality failure.
        self.assertAlmostEqual(float(raw["cell.max_edge.v1"][1]), np.sqrt(2.0))
        self.assertLess(float(raw["cell.max_edge.v1"][1]), np.sqrt(3.0))
    def test_mesh_options_reject_nonfinite_bool_and_fractional_integer(self) -> None:
        invalid = (
            lambda: MeshOptions(size_factor=float("nan")),
            lambda: MeshOptions(growth_rate=float("inf")),
            lambda: MeshOptions(through_thickness_symmetric="false"),
            lambda: MeshOptions(size_from_curvature=3.9),
            lambda: MeshOptions(algorithm_3d=True),
            lambda: MeshOptions(sweep_direction="diagonal"),
        )
        for factory in invalid:
            with self.subTest(factory=factory), self.assertRaises(ValueError):
                factory()

    def test_sweep_direction_is_consumed_by_typed_generator_boundary(self) -> None:
        slab = Box((4.0, 2.0, 1.0), name="slab")
        self.assertEqual(
            _resolve_sweep_axis(
                slab,
                options=MeshOptions(sweep_direction="x"),
                fallback_axis=2,
            ),
            0,
        )
        self.assertEqual(
            _resolve_sweep_axis(
                slab,
                options=MeshOptions(sweep_direction="auto"),
                fallback_axis=2,
            ),
            2,
        )
        with self.assertRaises(ValueError):
            _resolve_sweep_axis(
                Cylinder(radius=2.0, height=1.0),
                options=MeshOptions(sweep_direction="x"),
                fallback_axis=2,
            )

    def test_named_sweep_face_selectors_fail_closed_before_gmsh(self) -> None:
        options = MeshOptions(sweep_source="bottom")
        with self.assertRaisesRegex(ValueError, "geometry-identity-aware consumer"):
            generate_swept_mesh(
                Box((4.0, 2.0, 1.0), name="slab"),
                hmax=1.0,
                n_layers=1,
                options=options,
            )

    def test_mesh_control_helpers_reject_nonfinite_bool_and_bad_vectors(self) -> None:
        with self.assertRaises((TypeError, ValueError)):
            nearest_surface_to_point(point=[0.0, float("nan"), 0.0])
        with self.assertRaises((TypeError, ValueError)):
            nearest_surface_to_point(point=[0.0, 0.0, 0.0], count=3.5)
        with self.assertRaises((TypeError, ValueError)):
            boundary_layers(
                count=1,
                first_layer_thickness=1.0,
                target_surface_tags=[2.5],
            )

    def test_sweep_distribution_rejects_nonfinite_growth(self) -> None:
        for value in (float("nan"), float("inf"), True, "1.5"):
            with self.subTest(value=value), self.assertRaises((TypeError, ValueError)):
                SweepDistribution(kind="geometric", num_layers=2, growth_rate=value)

    def test_degenerate_cleanup_blocks_stale_quality_publication(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [0.25, 0.25, 0.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3], [0, 1, 2, 4]], dtype=np.int32),
            element_markers=np.asarray([1, 1], dtype=np.int32),
            boundary_faces=np.zeros((0, 3), dtype=np.int32),
            boundary_markers=np.zeros((0,), dtype=np.int32),
            quality=object(),  # an existing pre-mutation summary is enough
        )
        with self.assertRaises(MeshQualityUnavailableError) as caught:
            _drop_degenerate_tetrahedra(
                mesh,
                context="quality guard test",
                fallbacks_triggered=[],
            )
        error = caught.exception
        self.assertEqual(error.code, "quality_unavailable_after_topology_mutation")
        self.assertEqual(error.pointer, "/quality")
        self.assertEqual((error.old_element_count, error.new_element_count), (2, 1))
        self.assertEqual(error.to_dict()["schema_version"], "mesh_quality_failure.v2")
        self.assertEqual(error.to_dict()["details"]["new_element_count"], 1)

    def test_degenerate_cleanup_without_quality_clears_quality_fields(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [0.25, 0.25, 0.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3], [0, 1, 2, 4]], dtype=np.int32),
            element_markers=np.asarray([1, 1], dtype=np.int32),
            boundary_faces=np.zeros((0, 3), dtype=np.int32),
            boundary_markers=np.zeros((0,), dtype=np.int32),
        )
        cleaned = _drop_degenerate_tetrahedra(
            mesh,
            context="quality-less cleanup test",
            fallbacks_triggered=[],
        )
        self.assertIsNone(cleaned.quality)
        self.assertIsNone(cleaned.per_domain_quality)
        self.assertEqual(cleaned.n_elements, 1)

    def test_component_identity_rejects_bbox_tie(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3], [0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1, 2], dtype=np.int32),
            boundary_faces=np.zeros((0, 3), dtype=np.int32),
            boundary_markers=np.zeros((0,), dtype=np.int32),
        )
        geometries = [Box((1.0, 1.0, 1.0), name="left"), Box((1.0, 1.0, 1.0), name="right")]
        with self.assertRaises(ComponentIdentityResolutionError) as caught:
            _match_geometry_bounds_to_source_markers(geometries, mesh)
        self.assertEqual(caught.exception.code, "component_identity_ambiguous")
        self.assertIn("tie", str(caught.exception))

    def test_component_identity_rejects_no_overlap(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.zeros((0, 3), dtype=np.int32),
            boundary_markers=np.zeros((0,), dtype=np.int32),
        )
        with self.assertRaises(ComponentIdentityResolutionError) as caught:
            _match_geometry_bounds_to_source_markers([Box((1.0, 1.0, 1.0), name="far").translate((5.0, 0.0, 0.0))], mesh)
        self.assertEqual(caught.exception.code, "component_identity_ambiguous")
        self.assertIn("no positive bbox overlap", str(caught.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
