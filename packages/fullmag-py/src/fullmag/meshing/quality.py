from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import math

import numpy as np

from .gmsh_bridge import MeshData
from ._gmsh_types import (
    FEM_CELL_ARITIES,
    _MIXED_CELL_LOCAL_EDGES,
    _MIXED_CELL_LOCAL_FACETS,
    _cell_jacobian_determinants,
    _mixed_cell_signed_and_absolute_volume,
)
from fullmag._validation import parse_finite_float


class MeshValidationCompatibilityError(ValueError):
    """Raised when the legacy tet4-only validator receives typed topology.

    ``MeshData.elements`` is intentionally only a compatibility view for
    tetrahedral meshes.  Keeping this rejection in the public validator (and
    before touching that view) makes the migration failure deterministic and
    gives callers a stable way to route a mixed artifact to
    :func:`validate_typed_mesh`.
    """

    def __init__(self, *, families: tuple[str, ...]) -> None:
        self.code = "tet4_only_validator_mixed_topology"
        self.pointer = "/cell_types"
        self.families = families
        rendered = ", ".join(families) if families else "unknown"
        super().__init__(
            f"{self.code} at {self.pointer}: validate_mesh is a deprecated "
            f"tet4-only compatibility API; use validate_typed_mesh for {rendered}"
        )


@dataclass(frozen=True, slots=True)
class MeshValidationReport:
    """Basic mesh validation report (inverted elements, volume range)."""

    n_nodes: int
    n_elements: int
    n_boundary_faces: int
    n_inverted: int
    min_volume: float
    max_volume: float
    is_valid: bool


@dataclass(frozen=True, slots=True)
class MeshFamilyValidationReport:
    """Quality summary for one typed FEM cell family."""

    family: str
    n_elements: int
    n_inverted: int
    min_volume: float
    max_volume: float
    is_valid: bool


@dataclass(frozen=True, slots=True)
class TypedMeshValidationReport:
    """Quality summary for a variable-arity ``MeshData`` topology.

    ``families`` is ordered by the canonical ``FEM_CELL_ARITIES`` dispatch
    order, not by the order in which cells happened to arrive from Gmsh.  A
    consumer can therefore compare reports deterministically across runs.
    """

    n_nodes: int
    n_elements: int
    n_boundary_faces: int
    n_inverted: int
    min_volume: float
    max_volume: float
    families: tuple[MeshFamilyValidationReport, ...]
    is_valid: bool

    @property
    def family_reports(self) -> tuple[MeshFamilyValidationReport, ...]:
        """Compatibility/readability alias for callers using report wording."""

        return self.families


@dataclass(frozen=True, slots=True)
class AdjacentSizeGrowthPair:
    """One full-face neighbor comparison for ``adjacent_size_growth.v1``.

    The characteristic cell size is the maximum physical edge length.  This
    is intentionally conservative and family-neutral: unlike a volume-derived
    cube root it cannot hide a long edge in a prism, pyramid, or hex element.
    ``face_nodes`` is sorted only for identity; element ordinals remain the
    canonical ordering used by topology/FMMQ carriers.
    """

    left_ordinal: int
    right_ordinal: int
    face_nodes: tuple[int, ...]
    left_family: str
    right_family: str
    left_marker: int
    right_marker: int
    left_role: str
    right_role: str
    left_size_m: float
    right_size_m: float
    ratio: float

    def to_dict(self) -> dict[str, object]:
        return {
            "left_ordinal": self.left_ordinal,
            "right_ordinal": self.right_ordinal,
            "face_nodes": list(self.face_nodes),
            "left_family": self.left_family,
            "right_family": self.right_family,
            "left_marker": self.left_marker,
            "right_marker": self.right_marker,
            "left_role": self.left_role,
            "right_role": self.right_role,
            "left_size_m": self.left_size_m,
            "right_size_m": self.right_size_m,
            "ratio": self.ratio,
        }


@dataclass(frozen=True, slots=True)
class AdjacentSizeGrowthScope:
    """Aggregated growth statistics for one family/marker/role pair."""

    scope: str
    pair_count: int
    ratio_min: float
    ratio_p50: float
    ratio_p95: float
    ratio_max: float
    violation_count: int

    def to_dict(self) -> dict[str, object]:
        return {
            "scope": self.scope,
            "pair_count": self.pair_count,
            "ratio_min": self.ratio_min,
            "ratio_p50": self.ratio_p50,
            "ratio_p95": self.ratio_p95,
            "ratio_max": self.ratio_max,
            "violation_count": self.violation_count,
        }


@dataclass(frozen=True, slots=True)
class AdjacentSizeGrowthReport:
    """Post-mesh evidence for the resolved face-neighbor growth contract."""

    schema_version: str
    metric_definition_id: str
    element_count: int
    candidate_face_count: int
    evaluated_pair_count: int
    skipped_nonmanifold_face_count: int
    invalid_size_element_count: int
    resolved_growth_rate: float
    tolerance: float
    allowed_ratio: float
    ratio_min: float
    ratio_p50: float
    ratio_p95: float
    ratio_max: float
    violation_count: int
    scopes: tuple[AdjacentSizeGrowthScope, ...]
    worst_pairs: tuple[AdjacentSizeGrowthPair, ...]
    is_valid: bool
    # The full channel is retained in compact form for FMMQ publication.  The
    # human/API report deliberately exposes only ``worst_pairs`` so a large
    # mesh does not duplicate every face-neighbor record in JSON diagnostics.
    pair_ordinals: tuple[tuple[int, int], ...] = ()
    pair_ratios: tuple[float, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "metric_definition_id": self.metric_definition_id,
            "element_count": self.element_count,
            "candidate_face_count": self.candidate_face_count,
            "evaluated_pair_count": self.evaluated_pair_count,
            "skipped_nonmanifold_face_count": self.skipped_nonmanifold_face_count,
            "invalid_size_element_count": self.invalid_size_element_count,
            "resolved_growth_rate": self.resolved_growth_rate,
            "tolerance": self.tolerance,
            "allowed_ratio": self.allowed_ratio,
            "ratio_min": self.ratio_min,
            "ratio_p50": self.ratio_p50,
            "ratio_p95": self.ratio_p95,
            "ratio_max": self.ratio_max,
            "violation_count": self.violation_count,
            "scopes": [scope.to_dict() for scope in self.scopes],
            "worst_pairs": [pair.to_dict() for pair in self.worst_pairs],
            "is_valid": self.is_valid,
        }


class MeshGrowthValidationError(ValueError):
    """Structured failure raised when post-mesh growth exceeds the contract."""

    def __init__(self, report: AdjacentSizeGrowthReport) -> None:
        self.code = "adjacent_size_growth_exceeded"
        self.pointer = "/quality/adjacent_size_growth"
        self.report = report
        super().__init__(
            f"{self.code} at {self.pointer}: maximum ratio "
            f"{report.ratio_max:.6g} exceeds allowed {report.allowed_ratio:.6g} "
            f"({report.violation_count} violating face-neighbor pairs)"
        )

    def to_dict(self) -> dict[str, object]:
        """Return a machine-readable failure envelope plus full report details."""

        return {
            "schema_version": "mesh_quality_failure.v2",
            "code": self.code,
            "pointer": self.pointer,
            "metric_id": self.report.metric_definition_id,
            "threshold": self.report.allowed_ratio,
            "observed": self.report.ratio_max,
            "comparator": "<=",
            "family": None,
            "material_region": None,
            "zone": None,
            "element_ordinals": sorted(
                {
                    ordinal
                    for pair in self.report.worst_pairs
                    for ordinal in (pair.left_ordinal, pair.right_ordinal)
                }
            ),
            "policy_fingerprint": None,
            "topology_fingerprint": None,
            "evidence_path": None,
            "details": self.report.to_dict(),
        }


class MeshQualityFailureV2(ValueError):
    """Structured, serializable quality-gate failure.

    The human-readable message is deliberately accompanied by all identity
    and scope fields needed by API/CI consumers; callers must not parse text to
    find the failing metric or element.
    """

    def __init__(
        self,
        *,
        code: str,
        metric_id: str,
        threshold: float | None,
        observed: float | None,
        comparator: str,
        family: str | None = None,
        material_region: int | None = None,
        zone: str | None = None,
        element_ordinals: tuple[int, ...] = (),
        policy_fingerprint: str | None = None,
        topology_fingerprint: str | None = None,
        evidence_path: str | None = None,
    ) -> None:
        self.code = str(code)
        self.pointer = f"/quality/{metric_id}"
        self.metric_id = metric_id
        self.threshold = threshold
        self.observed = observed
        self.comparator = comparator
        self.family = family
        self.material_region = material_region
        self.zone = zone
        self.element_ordinals = tuple(int(value) for value in element_ordinals)
        self.policy_fingerprint = policy_fingerprint
        self.topology_fingerprint = topology_fingerprint
        self.evidence_path = evidence_path
        super().__init__(
            f"{self.code} at {self.pointer}: observed={observed!r} "
            f"{comparator} threshold={threshold!r}"
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": "mesh_quality_failure.v2",
            "code": self.code,
            "pointer": self.pointer,
            "metric_id": self.metric_id,
            "threshold": self.threshold,
            "observed": self.observed,
            "comparator": self.comparator,
            "family": self.family,
            "material_region": self.material_region,
            "zone": self.zone,
            "element_ordinals": list(self.element_ordinals),
            "policy_fingerprint": self.policy_fingerprint,
            "topology_fingerprint": self.topology_fingerprint,
            "evidence_path": self.evidence_path,
        }


@dataclass(frozen=True, slots=True)
class TypedQualityScopeSummary:
    """Family/region/role projection used by quality resources."""

    scope_id: str
    family: str
    material_region: int
    mesh_role: str
    zone: str
    element_count: int
    metrics: dict[str, dict[str, object]]
    worst_ordinals: tuple[int, ...]
    violation_count: int
    violating_ordinals: tuple[int, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "scope_id": self.scope_id,
            "family": self.family,
            "material_region": self.material_region,
            "mesh_role": self.mesh_role,
            "zone": self.zone,
            "element_count": self.element_count,
            "metrics": {
                str(metric): dict(values) for metric, values in self.metrics.items()
            },
            "worst_ordinals": list(self.worst_ordinals),
            "violation_count": self.violation_count,
            "violating_ordinals": list(self.violating_ordinals),
        }


@dataclass(frozen=True, slots=True)
class TypedQualitySummary:
    """Deterministic, family-aware quality summary for every typed cell."""

    schema_version: str
    metric_definitions: tuple[str, ...]
    element_count: int
    assigned_element_count: int
    unassigned_element_count: int
    scopes: tuple[TypedQualityScopeSummary, ...]
    is_valid: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "metric_definitions": list(self.metric_definitions),
            "element_count": self.element_count,
            "assigned_element_count": self.assigned_element_count,
            "unassigned_element_count": self.unassigned_element_count,
            "scopes": [scope.to_dict() for scope in self.scopes],
            "is_valid": self.is_valid,
        }


def _metric_stats(values: np.ndarray, *, unit: str) -> dict[str, object]:
    finite = np.asarray(values, dtype=np.float64)
    if finite.ndim != 1 or finite.size == 0 or not np.all(np.isfinite(finite)):
        raise ValueError("typed quality metric values must be a non-empty finite vector")
    return {
        "unit": unit,
        "count": int(finite.size),
        "min": float(np.min(finite)),
        "p01": float(np.percentile(finite, 1.0)),
        "p05": float(np.percentile(finite, 5.0)),
        "p50": float(np.percentile(finite, 50.0)),
        "p95": float(np.percentile(finite, 95.0)),
        "max": float(np.max(finite)),
    }


def build_typed_quality_summary(
    mesh: MeshData,
    *,
    thresholds: dict[str, dict[str, float]] | None = None,
    worst_limit: int = 20,
    policy_fingerprint: str | None = None,
    topology_fingerprint: str | None = None,
    evidence_path: str | None = None,
) -> TypedQualitySummary:
    """Build family/region/role summaries without a tet4 compatibility view.

    The canonical metrics currently emitted are ``cell.volume.v1``,
    ``cell.max_edge.v1`` and ``signed_jacobian.<family>.v1``.  Thresholds are
    optional because the scientific policy owns their values; when provided,
    violation counts and bounded worst ordinals are included in each scope.
    """

    if not isinstance(mesh, MeshData):
        raise TypeError("build_typed_quality_summary expects a MeshData instance")
    if isinstance(worst_limit, bool) or int(worst_limit) < 1:
        raise ValueError("worst_limit must be a positive integer")
    threshold_map = thresholds or {}
    if not isinstance(threshold_map, dict):
        raise TypeError("thresholds must be a mapping of metric IDs to rules")
    normalized_thresholds: dict[str, dict[str, float]] = {}
    for metric_id, rule in threshold_map.items():
        if not isinstance(metric_id, str) or not metric_id.strip() or not isinstance(rule, dict):
            raise ValueError("quality thresholds require non-empty metric IDs and object rules")
        normalized: dict[str, float] = {}
        for bound in ("minimum", "maximum"):
            if bound in rule and rule[bound] is not None:
                parsed = parse_finite_float(
                    rule[bound],
                    f"/quality/thresholds/{metric_id}/{bound}",
                    allow_numeric_string=False,
                )
                normalized[bound] = float(parsed)
        if "minimum" in normalized and "maximum" in normalized and normalized["minimum"] > normalized["maximum"]:
            raise ValueError(f"quality threshold minimum exceeds maximum for {metric_id!r}")
        normalized_thresholds[metric_id] = normalized
    for fam in ("tet", "tet4", "prism", "prism6", "hex", "hex8", "pyramid", "pyramid5"):
        skew_id = f"skewness.{fam}.v1"
        unif_id = f"edge_length_uniformity.{fam}.v1"
        if skew_id in normalized_thresholds and unif_id in normalized_thresholds:
            s_rule = normalized_thresholds[skew_id]
            u_rule = normalized_thresholds[unif_id]
            for bound in ("minimum", "maximum"):
                if bound in s_rule and bound in u_rule:
                    if not math.isclose(s_rule[bound], u_rule[bound], rel_tol=1e-7, abs_tol=1e-9):
                        raise ValueError(f"Conflicting quality thresholds for {skew_id} and {unif_id}")
        elif skew_id in normalized_thresholds:
            normalized_thresholds[unif_id] = dict(normalized_thresholds[skew_id])
        elif unif_id in normalized_thresholds:
            normalized_thresholds[skew_id] = dict(normalized_thresholds[unif_id])
    cells: dict[str, list[tuple[int, int, str, float, float, float, float, float]]] = {}
    assigned = 0
    cell_parts = mesh.cell_mesh_parts.tolist()
    for ordinal, raw_family in enumerate(mesh.cell_types.tolist()):
        family = str(raw_family)
        marker = int(mesh.element_markers[ordinal])
        role = (
            str(cell_parts[ordinal])
            if len(cell_parts) == mesh.n_elements and str(cell_parts[ordinal]).strip()
            else ("air" if marker == 0 else "magnetic")
        )
        coordinates = mesh.nodes[mesh.cell_node_ids(ordinal)]
        _signed, volume = _mixed_cell_signed_and_absolute_volume(family, coordinates)
        edges = _cell_edge_pairs(family)
        edge_lengths = np.asarray(
            [np.linalg.norm(coordinates[left] - coordinates[right]) for left, right in edges],
            dtype=np.float64,
        )
        determinants = _cell_jacobian_determinants(family, coordinates)
        max_edge = float(np.max(edge_lengths)) if edge_lengths.size else float("nan")
        min_edge = float(np.min(edge_lengths)) if edge_lengths.size else float("nan")
        edge_aspect = (
            float(max_edge / min_edge)
            if np.isfinite(max_edge) and np.isfinite(min_edge) and min_edge > 0.0
            else float("nan")
        )
        edge_cv = (
            float(np.std(edge_lengths) / np.mean(edge_lengths))
            if edge_lengths.size and np.isfinite(np.mean(edge_lengths)) and np.mean(edge_lengths) > 0.0
            else float("nan")
        )
        skewness = float(1.0 / (1.0 + edge_cv)) if np.isfinite(edge_cv) else float("nan")
        signed_jacobian = float(np.min(determinants)) if determinants.size else float("nan")
        cell_metrics = {
            "cell.volume.v1": float(volume),
            "cell.max_edge.v1": max_edge,
            f"signed_jacobian.{family}.v1": signed_jacobian,
            f"edge_aspect.{family}.v1": edge_aspect,
            f"skewness.{family}.v1": skewness,
            f"edge_length_uniformity.{family}.v1": skewness,
        }
        for metric_id, observed in cell_metrics.items():
            if not np.isfinite(observed):
                raise MeshQualityFailureV2(
                    code="mesh_quality_nonfinite",
                    metric_id=metric_id,
                    threshold=None,
                    observed=observed,
                    comparator="must_be_finite",
                    family=family,
                    material_region=marker,
                    zone="global",
                    element_ordinals=(ordinal,),
                    policy_fingerprint=policy_fingerprint,
                    topology_fingerprint=topology_fingerprint,
                    evidence_path=evidence_path,
                )
        key = f"{family}|marker:{marker}|role:{role}|zone:global"
        cells.setdefault(key, []).append(
            (ordinal, marker, role, float(volume), max_edge, signed_jacobian, edge_aspect, skewness)
        )
        assigned += 1

    scope_reports: list[TypedQualityScopeSummary] = []
    metric_definitions: set[str] = {"cell.volume.v1", "cell.max_edge.v1"}
    for key, entries in sorted(cells.items()):
        family, marker_token, role_token, zone_token = key.split("|", 3)
        marker = int(marker_token.split(":", 1)[1])
        role = role_token.split(":", 1)[1]
        zone = zone_token.split(":", 1)[1]
        ordinals = np.asarray([entry[0] for entry in entries], dtype=np.int64)
        volumes = np.asarray([entry[3] for entry in entries], dtype=np.float64)
        edges = np.asarray([entry[4] for entry in entries], dtype=np.float64)
        jacobians = np.asarray([entry[5] for entry in entries], dtype=np.float64)
        aspects = np.asarray([entry[6] for entry in entries], dtype=np.float64)
        skewness = np.asarray([entry[7] for entry in entries], dtype=np.float64)
        metrics = {
            "cell.volume.v1": _metric_stats(volumes, unit="m^3"),
            "cell.max_edge.v1": _metric_stats(edges, unit="m"),
            f"signed_jacobian.{family}.v1": _metric_stats(jacobians, unit="m^3"),
            f"edge_aspect.{family}.v1": _metric_stats(aspects, unit="1"),
            f"skewness.{family}.v1": _metric_stats(skewness, unit="1"),
            f"edge_length_uniformity.{family}.v1": _metric_stats(skewness, unit="1"),
        }
        metric_definitions.add(f"signed_jacobian.{family}.v1")
        metric_definitions.add(f"edge_aspect.{family}.v1")
        metric_definitions.add(f"skewness.{family}.v1")
        metric_definitions.add(f"edge_length_uniformity.{family}.v1")
        violating: list[int] = []
        for metric_id, values in (
            ("cell.volume.v1", volumes),
            ("cell.max_edge.v1", edges),
            (f"signed_jacobian.{family}.v1", jacobians),
            (f"edge_aspect.{family}.v1", aspects),
            (f"skewness.{family}.v1", skewness),
            (f"edge_length_uniformity.{family}.v1", skewness),
        ):
            rule = normalized_thresholds.get(metric_id, {})
            minimum = rule.get("minimum")
            maximum = rule.get("maximum")
            if minimum is not None:
                violating.extend(int(index) for index in ordinals[values < float(minimum)])
            if maximum is not None:
                violating.extend(int(index) for index in ordinals[values > float(maximum)])
        violating = sorted(set(violating))
        # Select worst cells by the smallest positive volume first; this is a
        # deterministic, family-independent sliver signal.
        order = np.argsort(np.where(np.isfinite(volumes), volumes, np.inf), kind="stable")
        worst = tuple(int(ordinals[index]) for index in order[: int(worst_limit)])
        scope_reports.append(
            TypedQualityScopeSummary(
                scope_id=key,
                family=family,
                material_region=marker,
                mesh_role=role,
                zone=zone,
                element_count=len(entries),
                metrics=metrics,
                worst_ordinals=worst,
                violation_count=len(violating),
                violating_ordinals=tuple(violating[: int(worst_limit)]),
            )
        )
    return TypedQualitySummary(
        schema_version="typed_quality_summary.v1",
        metric_definitions=tuple(sorted(metric_definitions)),
        element_count=mesh.n_elements,
        assigned_element_count=assigned,
        unassigned_element_count=mesh.n_elements - assigned,
        scopes=tuple(scope_reports),
        is_valid=bool(
            assigned == mesh.n_elements
            and all(scope.violation_count == 0 for scope in scope_reports)
            and all(
                all(
                    np.isfinite(float(value))
                    for value in (
                        metric.get("min"),
                        metric.get("max"),
                    )
                )
                for scope in scope_reports
                for metric in scope.metrics.values()
            )
        ),
    )


def validate_typed_quality_summary(
    mesh: MeshData,
    *,
    thresholds: dict[str, dict[str, float]],
    policy_fingerprint: str | None = None,
    topology_fingerprint: str | None = None,
    evidence_path: str | None = None,
    worst_limit: int = 20,
) -> TypedQualitySummary:
    """Build a typed summary and raise a structured failure on the first gate.

    Thresholds are evaluated against the corresponding summary extrema.  The
    selected scope and bounded violating ordinals are preserved in the error,
    so API/CI callers can render a useful failure without reparsing prose.
    """

    resolved_thresholds = dict(thresholds)
    for fam in ("tet", "tet4", "prism", "prism6", "hex", "hex8", "pyramid", "pyramid5"):
        skew_id = f"skewness.{fam}.v1"
        unif_id = f"edge_length_uniformity.{fam}.v1"
        if skew_id in resolved_thresholds and unif_id in resolved_thresholds:
            s_rule = resolved_thresholds[skew_id]
            u_rule = resolved_thresholds[unif_id]
            for bound in ("minimum", "maximum"):
                if bound in s_rule and bound in u_rule:
                    if not math.isclose(float(s_rule[bound]), float(u_rule[bound]), rel_tol=1e-7, abs_tol=1e-9):
                        raise ValueError(f"Conflicting quality thresholds for {skew_id} and {unif_id}")
        elif skew_id in resolved_thresholds:
            resolved_thresholds[unif_id] = dict(resolved_thresholds[skew_id])
        elif unif_id in resolved_thresholds:
            resolved_thresholds[skew_id] = dict(resolved_thresholds[unif_id])

    summary = build_typed_quality_summary(
        mesh,
        thresholds=resolved_thresholds,
        worst_limit=worst_limit,
        policy_fingerprint=policy_fingerprint,
        topology_fingerprint=topology_fingerprint,
        evidence_path=evidence_path,
    )
    for scope in summary.scopes:
        for metric_id, metric in scope.metrics.items():
            rule = resolved_thresholds.get(metric_id, {})
            minimum = rule.get("minimum")
            maximum = rule.get("maximum")
            if minimum is not None and float(metric["min"]) < float(minimum):
                raise MeshQualityFailureV2(
                    code="mesh_quality_threshold_exceeded",
                    metric_id=metric_id,
                    threshold=float(minimum),
                    observed=float(metric["min"]),
                    comparator="<",
                    family=scope.family,
                    material_region=scope.material_region,
                    zone=scope.zone,
                    element_ordinals=scope.violating_ordinals,
                    policy_fingerprint=policy_fingerprint,
                    topology_fingerprint=topology_fingerprint,
                    evidence_path=evidence_path,
                )
            if maximum is not None and float(metric["max"]) > float(maximum):
                raise MeshQualityFailureV2(
                    code="mesh_quality_threshold_exceeded",
                    metric_id=metric_id,
                    threshold=float(maximum),
                    observed=float(metric["max"]),
                    comparator=">",
                    family=scope.family,
                    material_region=scope.material_region,
                    zone=scope.zone,
                    element_ordinals=scope.violating_ordinals,
                    policy_fingerprint=policy_fingerprint,
                    topology_fingerprint=topology_fingerprint,
                    evidence_path=evidence_path,
                )
    return summary


def _cell_edge_pairs(family: str) -> tuple[tuple[int, int], ...]:
    try:
        return _MIXED_CELL_LOCAL_EDGES[family]
    except KeyError:
        raise ValueError(f"unknown cell family {family!r}")


def _cell_max_edge_sizes(mesh: MeshData) -> np.ndarray:
    sizes = np.full(mesh.n_elements, np.nan, dtype=np.float64)
    for ordinal, raw_family in enumerate(mesh.cell_types.tolist()):
        family = str(raw_family)
        coordinates = mesh.nodes[mesh.cell_node_ids(ordinal)]
        edges = _cell_edge_pairs(family)
        lengths = np.asarray(
            [np.linalg.norm(coordinates[left] - coordinates[right]) for left, right in edges],
            dtype=np.float64,
        )
        if lengths.size and np.all(np.isfinite(lengths)) and np.all(lengths > 0.0):
            sizes[ordinal] = float(np.max(lengths))
    return sizes


def measure_adjacent_size_growth(
    mesh: MeshData,
    *,
    resolved_growth_rate: float | None = None,
    scope_growth_rates: dict[str, float] | None = None,
    tolerance: float = 0.0,
    require_pairs: bool = True,
    worst_limit: int = 20,
) -> AdjacentSizeGrowthReport:
    """Measure full-face neighbor size ratios without consulting Gmsh hints.

    Every supported volume family contributes its canonical local faces.  A
    face with exactly two owners is a candidate; non-manifold faces are
    reported and excluded from ratios.  Missing/invalid edge sizes and an
    empty candidate set are invalid evidence when ``require_pairs`` is true.
    """

    if not isinstance(mesh, MeshData):
        raise TypeError("measure_adjacent_size_growth expects a MeshData instance")
    if resolved_growth_rate is None and not scope_growth_rates:
        raise ValueError("resolved_growth_rate or scope_growth_rates must be provided")
    if resolved_growth_rate is not None:
        if isinstance(resolved_growth_rate, bool) or not np.isfinite(float(resolved_growth_rate)):
            raise ValueError("resolved_growth_rate must be finite and positive")
        if float(resolved_growth_rate) <= 1.0:
            raise ValueError(
                "resolved_growth_rate must be finite and greater than 1.0; "
                "use None to disable the adjacent-growth gate"
            )
        growth = float(resolved_growth_rate)
    else:
        growth = max(float(r) for r in scope_growth_rates.values())
    if scope_growth_rates:
        for sk, sv in scope_growth_rates.items():
            if isinstance(sv, bool) or not np.isfinite(float(sv)) or float(sv) <= 1.0:
                raise ValueError(f"scope_growth_rates[{sk!r}] must be finite and greater than 1.0")
    if isinstance(tolerance, bool) or not np.isfinite(float(tolerance)) or float(tolerance) < 0.0:
        raise ValueError("tolerance must be finite and non-negative")
    if isinstance(worst_limit, bool) or int(worst_limit) < 1:
        raise ValueError("worst_limit must be a positive integer")

    tolerance_value = float(tolerance)
    allowed_ratio = growth * (1.0 + tolerance_value)
    sizes = _cell_max_edge_sizes(mesh)
    invalid_size_element_count = int(np.count_nonzero(~np.isfinite(sizes)))

    def _pair_allowed_ratio(
        l_fam: str, l_mark: int, l_rol: str,
        r_fam: str, r_mark: int, r_rol: str,
    ) -> float:
        if not scope_growth_rates:
            return allowed_ratio
        r_l = (
            scope_growth_rates.get(f"{l_fam}|marker:{l_mark}|role:{l_rol}")
            or scope_growth_rates.get(l_rol)
            or scope_growth_rates.get(str(l_mark))
            or growth
        )
        r_r = (
            scope_growth_rates.get(f"{r_fam}|marker:{r_mark}|role:{r_rol}")
            or scope_growth_rates.get(r_rol)
            or scope_growth_rates.get(str(r_mark))
            or growth
        )
        pair_rate = r_l if (l_mark == r_mark and l_rol == r_rol) else max(r_l, r_r)
        return pair_rate * (1.0 + tolerance_value)

    face_owners: dict[tuple[int, ...], list[int]] = {}
    for ordinal, raw_family in enumerate(mesh.cell_types.tolist()):
        family = str(raw_family)
        try:
            local_faces = _MIXED_CELL_LOCAL_FACETS[family]
        except KeyError as exc:
            raise ValueError(f"unknown cell family {family!r}") from exc
        nodes = mesh.cell_node_ids(ordinal)
        for local_face in local_faces:
            key = tuple(sorted(int(nodes[index]) for index in local_face))
            face_owners.setdefault(key, []).append(ordinal)

    candidate_face_count = 0
    skipped_nonmanifold = 0
    pairs: list[AdjacentSizeGrowthPair] = []
    scope_ratios: dict[str, list[float]] = {}
    for face_nodes, owners in sorted(face_owners.items()):
        unique_owners = sorted(set(owners))
        if len(unique_owners) != 2:
            if len(unique_owners) > 2:
                skipped_nonmanifold += 1
            continue
        candidate_face_count += 1
        left, right = unique_owners
        left_size = sizes[left]
        right_size = sizes[right]
        if not np.isfinite(left_size) or not np.isfinite(right_size):
            continue
        ratio = max(float(left_size / right_size), float(right_size / left_size))
        if not np.isfinite(ratio) or ratio <= 0.0:
            continue
        left_family = str(mesh.cell_types[left])
        right_family = str(mesh.cell_types[right])
        left_marker = int(mesh.element_markers[left])
        right_marker = int(mesh.element_markers[right])
        cell_parts = mesh.cell_mesh_parts.tolist()
        left_role = (
            str(cell_parts[left])
            if len(cell_parts) == mesh.n_elements and str(cell_parts[left]).strip()
            else "unknown"
        )
        right_role = (
            str(cell_parts[right])
            if len(cell_parts) == mesh.n_elements and str(cell_parts[right]).strip()
            else "unknown"
        )
        pair = AdjacentSizeGrowthPair(
            left_ordinal=left,
            right_ordinal=right,
            face_nodes=face_nodes,
            left_family=left_family,
            right_family=right_family,
            left_marker=left_marker,
            right_marker=right_marker,
            left_role=left_role,
            right_role=right_role,
            left_size_m=float(left_size),
            right_size_m=float(right_size),
            ratio=ratio,
        )
        pairs.append(pair)
        for family, marker, role in (
            (left_family, left_marker, left_role),
            (right_family, right_marker, right_role),
        ):
            scope_ratios.setdefault(f"{family}|marker:{marker}|role:{role}", []).append(ratio)

    pairs.sort(key=lambda pair: (-pair.ratio, pair.left_ordinal, pair.right_ordinal, pair.face_nodes))
    ratios = np.asarray([pair.ratio for pair in pairs], dtype=np.float64)
    scopes: list[AdjacentSizeGrowthScope] = []
    for scope, values in sorted(scope_ratios.items()):
        scoped = np.asarray(values, dtype=np.float64)
        s_rate = growth
        if scope_growth_rates:
            s_family, s_marker_tok, s_role_tok = scope.split("|", 2)
            s_marker = s_marker_tok.split(":", 1)[1]
            s_role = s_role_tok.split(":", 1)[1]
            s_rate = (
                scope_growth_rates.get(scope)
                or scope_growth_rates.get(s_role)
                or scope_growth_rates.get(s_marker)
                or growth
            )
        s_allowed = s_rate * (1.0 + tolerance_value)
        scopes.append(
            AdjacentSizeGrowthScope(
                scope=scope,
                pair_count=int(scoped.size),
                ratio_min=float(np.min(scoped)),
                ratio_p50=float(np.percentile(scoped, 50.0)),
                ratio_p95=float(np.percentile(scoped, 95.0)),
                ratio_max=float(np.max(scoped)),
                violation_count=int(np.count_nonzero(scoped > s_allowed)),
            )
        )

    ratio_min = float(np.min(ratios)) if ratios.size else 0.0
    ratio_p50 = float(np.percentile(ratios, 50.0)) if ratios.size else 0.0
    ratio_p95 = float(np.percentile(ratios, 95.0)) if ratios.size else 0.0
    ratio_max = float(np.max(ratios)) if ratios.size else 0.0
    violation_count = sum(
        1 for p in pairs
        if p.ratio > _pair_allowed_ratio(
            p.left_family, p.left_marker, p.left_role,
            p.right_family, p.right_marker, p.right_role,
        )
    )
    is_valid = (
        invalid_size_element_count == 0
        and skipped_nonmanifold == 0
        and (not require_pairs or candidate_face_count > 0)
        and bool(ratios.size or not require_pairs)
        and violation_count == 0
    )
    # Keep the compact full channel in canonical ordinal order.  The public
    # ``worst_pairs`` list above is intentionally sorted by descending ratio,
    # but FMMQ ordinal channels must be strictly lexicographically ordered.
    metric_pairs = sorted(
        pairs,
        key=lambda pair: (pair.left_ordinal, pair.right_ordinal, pair.face_nodes),
    )
    return AdjacentSizeGrowthReport(
        schema_version="adjacent_size_growth.v1",
        metric_definition_id="adjacent_size_growth.v1",
        element_count=mesh.n_elements,
        candidate_face_count=candidate_face_count,
        evaluated_pair_count=int(ratios.size),
        skipped_nonmanifold_face_count=skipped_nonmanifold,
        invalid_size_element_count=invalid_size_element_count,
        resolved_growth_rate=growth,
        tolerance=tolerance_value,
        allowed_ratio=allowed_ratio,
        ratio_min=ratio_min,
        ratio_p50=ratio_p50,
        ratio_p95=ratio_p95,
        ratio_max=ratio_max,
        violation_count=violation_count,
        scopes=tuple(scopes),
        worst_pairs=tuple(pairs[: int(worst_limit)]),
        is_valid=bool(is_valid),
        pair_ordinals=tuple(
            (int(pair.left_ordinal), int(pair.right_ordinal)) for pair in metric_pairs
        ),
        pair_ratios=tuple(float(pair.ratio) for pair in metric_pairs),
    )


def validate_adjacent_size_growth(
    mesh: MeshData,
    *,
    resolved_growth_rate: float | None = None,
    scope_growth_rates: dict[str, float] | None = None,
    tolerance: float = 0.0,
    require_pairs: bool = True,
    worst_limit: int = 20,
) -> AdjacentSizeGrowthReport:
    """Measure and raise a structured failure when the post-mesh gate fails."""

    report = measure_adjacent_size_growth(
        mesh,
        resolved_growth_rate=resolved_growth_rate,
        scope_growth_rates=scope_growth_rates,
        tolerance=tolerance,
        require_pairs=require_pairs,
        worst_limit=worst_limit,
    )
    if not report.is_valid:
        raise MeshGrowthValidationError(report)
    return report


def _tet4_validation_report(mesh: MeshData) -> MeshValidationReport:
    """Run the historical report calculation after the compatibility guard."""

    volumes: list[float] = []
    inverted = 0

    for element in mesh.elements:
        n0, n1, n2, n3 = (int(v) for v in element)
        p0 = mesh.nodes[n0]
        p1 = mesh.nodes[n1]
        p2 = mesh.nodes[n2]
        p3 = mesh.nodes[n3]
        mat = np.column_stack([p1 - p0, p2 - p0, p3 - p0])
        signed_volume = float(np.linalg.det(mat) / 6.0)
        if not np.isfinite(signed_volume) or signed_volume <= 0.0:
            inverted += 1
        volumes.append(abs(signed_volume) if np.isfinite(signed_volume) else 0.0)

    min_volume = min(volumes) if volumes else 0.0
    max_volume = max(volumes) if volumes else 0.0
    is_valid = (
        mesh.n_nodes >= 4
        and mesh.n_elements > 0
        and inverted == 0
        and min_volume > 0.0
    )

    return MeshValidationReport(
        n_nodes=mesh.n_nodes,
        n_elements=mesh.n_elements,
        n_boundary_faces=mesh.n_boundary_faces,
        n_inverted=inverted,
        min_volume=min_volume,
        max_volume=max_volume,
        is_valid=is_valid,
    )


def validate_mesh(mesh: MeshData) -> MeshValidationReport:
    """Validate a legacy tet4 mesh.

    This API is retained for downstream tet4 users.  It deliberately rejects
    mixed topology before accessing ``MeshData.elements``; mixed artifacts
    must use :func:`validate_typed_mesh` instead.
    """

    if not isinstance(mesh, MeshData):
        raise TypeError("validate_mesh expects a MeshData instance")
    mesh.validate()
    families = tuple(sorted({str(value) for value in mesh.cell_types.tolist()}))
    if families != ("tet4",) and families:
        raise MeshValidationCompatibilityError(families=families)
    return _tet4_validation_report(mesh)


def validate_typed_mesh(
    mesh: MeshData,
    *,
    strict: bool = False,
) -> TypedMeshValidationReport:
    """Validate all supported FEM cell families without tet4 coercion.

    The ordinary mode mirrors the historical report semantics (positive
    signed cell volume and non-zero volume).  ``strict=True`` additionally
    dispatches each family through its Jacobian evaluator, catching a locally
    inverted/degenerate prism, pyramid, or hex even when a tetrahedral volume
    decomposition would hide that defect.
    """

    if not isinstance(mesh, MeshData):
        raise TypeError("validate_typed_mesh expects a MeshData instance")
    mesh.validate()

    by_family: dict[str, list[tuple[float, float, bool]]] = {}
    for ordinal, family_value in enumerate(mesh.cell_types.tolist()):
        family = str(family_value)
        coordinates = mesh.nodes[mesh.cell_node_ids(ordinal)]
        signed_volume, absolute_volume = _mixed_cell_signed_and_absolute_volume(
            family,
            coordinates,
        )
        valid = (
            np.isfinite(signed_volume)
            and np.isfinite(absolute_volume)
            and signed_volume > 0.0
            and absolute_volume > 0.0
        )
        if strict:
            determinants = _cell_jacobian_determinants(family, coordinates)
            valid = bool(
                valid
                and np.all(np.isfinite(determinants))
                and np.all(determinants > 0.0)
            )
        by_family.setdefault(family, []).append(
            (signed_volume, absolute_volume, bool(valid))
        )

    family_reports: list[MeshFamilyValidationReport] = []
    for family in sorted(by_family):
        values = by_family[family]
        volumes = [value[1] if np.isfinite(value[1]) else 0.0 for value in values]
        n_inverted = sum(not value[2] for value in values)
        family_reports.append(
            MeshFamilyValidationReport(
                family=family,
                n_elements=len(values),
                n_inverted=n_inverted,
                min_volume=min(volumes) if volumes else 0.0,
                max_volume=max(volumes) if volumes else 0.0,
                is_valid=bool(values) and n_inverted == 0,
            )
        )

    all_volumes = [report.min_volume for report in family_reports if report.n_elements]
    max_volumes = [report.max_volume for report in family_reports if report.n_elements]
    n_inverted = sum(report.n_inverted for report in family_reports)
    nodes_finite = bool(np.all(np.isfinite(mesh.nodes)))
    is_valid = bool(
        nodes_finite
        and mesh.n_nodes >= 4
        and mesh.n_elements > 0
        and n_inverted == 0
        and all(report.is_valid for report in family_reports)
        and bool(all_volumes)
        and min(all_volumes) > 0.0
    )
    return TypedMeshValidationReport(
        n_nodes=mesh.n_nodes,
        n_elements=mesh.n_elements,
        n_boundary_faces=mesh.n_boundary_faces,
        n_inverted=n_inverted,
        min_volume=min(all_volumes) if all_volumes else 0.0,
        max_volume=max(max_volumes) if max_volumes else 0.0,
        families=tuple(family_reports),
        is_valid=is_valid,
    )


def validate_typed_mesh_strict(mesh: MeshData) -> TypedMeshValidationReport:
    """Strict Jacobian-dispatched alias for explicit production call sites."""

    return validate_typed_mesh(mesh, strict=True)
