"""Same-mesh cross-run field matching diagnostic.

This module compares hash-bound full-field contexts loaded by
load_tracking_fields. It matches supplied candidate clusters by the
consistent P1 Tet4 magnetic mass metric; raw solver IDs are audit labels only.
A result is never a solver or scientific qualification.
"""
from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np

from comsol_tracking_assignment import maximum_weight_assignment
from comsol_tracking_metric import Tet4TrackingMetric


REPORT_SCHEMA = "fullmag.comsol-cross-run-field-matching.v1"
_HASH_RE = re.compile(r"sha256:[0-9a-f]{64}")


def _sequence(value: object) -> bool:
    return isinstance(value, Sequence) and not isinstance(
        value, (str, bytes, bytearray)
    )


def _finite_number(value: object, label: str) -> float:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite numeric scalar")
    try:
        converted = float(value)
    except (OverflowError, ValueError):
        raise ValueError(f"{label} must be a finite numeric scalar") from None
    if not math.isfinite(converted):
        raise ValueError(f"{label} must be a finite numeric scalar")
    return converted


def _nonnegative_integer(value: object, label: str) -> int:
    if type(value) is not int or value < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return value


def _fingerprint(value: object, label: str) -> str:
    if not isinstance(value, str) or _HASH_RE.fullmatch(value) is None:
        raise ValueError(f"{label} must be a non-empty sha256 fingerprint")
    return value


def _validate_hash_context(value: object, label: str) -> list[dict[str, str]]:
    if not _sequence(value) or not value:
        raise ValueError(f"{label} file_hashes must be a non-empty sequence")
    result: list[dict[str, str]] = []
    paths: set[str] = set()
    for index, item in enumerate(value):
        if not isinstance(item, Mapping):
            raise ValueError(f"{label} file_hashes[{index}] must be a mapping")
        path, digest = item.get("path"), item.get("sha256")
        if not isinstance(path, str) or not path.strip() or path in paths:
            raise ValueError(f"{label} file hash paths must be non-empty and unique")
        if not isinstance(digest, str) or _HASH_RE.fullmatch(digest) is None:
            raise ValueError(f"{label} file_hashes[{index}] has an invalid sha256")
        paths.add(path)
        result.append({"path": path, "sha256": digest})
    return result


def _metric_arrays(metric: Tet4TrackingMetric, label: str) -> dict[str, np.ndarray]:
    if not isinstance(metric, Tet4TrackingMetric):
        raise ValueError(f"{label} metric must be a Tet4TrackingMetric")
    nodes = np.asarray(metric.nodes)
    cells = np.asarray(metric.cells)
    support = np.asarray(metric.support)
    volumes = np.asarray(metric.volumes_m3)
    scaled_volumes = np.asarray(metric.scaled_volumes)
    if nodes.ndim != 2 or nodes.shape[1:] != (3,) or nodes.shape[0] == 0 \
            or nodes.dtype.kind not in "fiu" or not np.all(np.isfinite(nodes)):
        raise ValueError(f"{label} metric nodes must be finite Cartesian coordinates")
    if cells.ndim != 2 or cells.shape[1:] != (4,) or cells.shape[0] == 0 \
            or cells.dtype.kind not in "iu" or np.any(cells < 0) \
            or np.any(cells >= len(nodes)):
        raise ValueError(f"{label} metric cells must be valid Tet4 connectivity")
    if support.ndim != 1 or support.dtype.kind not in "iu" \
            or not np.array_equal(support, np.unique(cells)):
        raise ValueError(f"{label} metric support differs from Tet4 connectivity")
    if volumes.shape != (len(cells),) or volumes.dtype.kind not in "fiu" \
            or not np.all(np.isfinite(volumes)) or np.any(volumes <= 0):
        raise ValueError(f"{label} metric volumes must be finite and positive")
    if scaled_volumes.shape != volumes.shape or scaled_volumes.dtype.kind not in "fiu" \
            or not np.all(np.isfinite(scaled_volumes)) or np.any(scaled_volumes <= 0):
        raise ValueError(f"{label} metric scaled volumes must be finite and positive")
    return {
        "nodes": nodes,
        "cells": cells,
        "support": support,
        "volumes_m3": volumes,
        "scaled_volumes": scaled_volumes,
    }


def _validate_same_mesh(
    left: Mapping[str, Any], right: Mapping[str, Any]
) -> tuple[str, dict[str, np.ndarray]]:
    left_fingerprint = _fingerprint(
        left.get("source_mesh_topology_sha256"), "left source_mesh_topology_sha256"
    )
    right_fingerprint = _fingerprint(
        right.get("source_mesh_topology_sha256"), "right source_mesh_topology_sha256"
    )
    if left_fingerprint != right_fingerprint:
        raise ValueError("cross-run mesh topology fingerprints differ")
    left_arrays = _metric_arrays(left.get("metric"), "left")
    right_arrays = _metric_arrays(right.get("metric"), "right")
    for name in ("nodes", "cells", "support", "volumes_m3", "scaled_volumes"):
        if not np.array_equal(left_arrays[name], right_arrays[name]):
            raise ValueError(f"cross-run Tet4 metric {name} differ")
    return left_fingerprint, left_arrays


def _finite_vector(value: object, label: str) -> tuple[float, float, float]:
    if not _sequence(value) or len(value) != 3:
        raise ValueError(f"{label} must contain three finite components")
    result = tuple(
        _finite_number(component, f"{label}[{index}]")
        for index, component in enumerate(value)
    )
    return result  # type: ignore[return-value]


def _relative_complex_frequency_distance(
    left_real: float,
    left_imag: float,
    right_real: float,
    right_imag: float,
) -> float:
    scale = max(abs(left_real), abs(left_imag), abs(right_real), abs(right_imag))
    if scale == 0.0:
        return 0.0
    return math.hypot(
        left_real / scale - right_real / scale,
        left_imag / scale - right_imag / scale,
    )


def _context_modes(
    context: object, label: str
) -> tuple[
    Tet4TrackingMetric,
    dict[tuple[int, int], dict[str, Any]],
    dict[int, tuple[float, float, float]],
    list[dict[str, str]],
    str,
]:
    if not isinstance(context, Mapping):
        raise ValueError(f"{label} context must be a load_tracking_fields mapping")
    metric = context.get("metric")
    if not isinstance(metric, Tet4TrackingMetric):
        raise ValueError(f"{label} context has no Tet4TrackingMetric")
    _metric_arrays(metric, label)
    fingerprint = _fingerprint(
        context.get("source_mesh_topology_sha256"),
        f"{label} source_mesh_topology_sha256",
    )
    hashes = _validate_hash_context(context.get("file_hashes"), label)
    source_modes = context.get("modes")
    if not isinstance(source_modes, Mapping) or not source_modes:
        raise ValueError(f"{label} context must contain a non-empty modes mapping")

    modes: dict[tuple[int, int], dict[str, Any]] = {}
    sample_k: dict[int, tuple[float, float, float]] = {}
    for key, source_mode in source_modes.items():
        if not isinstance(key, tuple) or len(key) != 2:
            raise ValueError(f"{label} mode keys must be (sample_index, raw_mode_index)")
        sample_index = _nonnegative_integer(key[0], f"{label} sample_index")
        raw_mode_index = _nonnegative_integer(key[1], f"{label} raw_mode_index")
        if not isinstance(source_mode, Mapping):
            raise ValueError(f"{label} mode {(sample_index, raw_mode_index)} must be a mapping")
        identity = (sample_index, raw_mode_index)
        if identity in modes:
            raise ValueError(f"{label} contains duplicate modal identity {identity}")

        k_vector = _finite_vector(
            source_mode.get("k_vector_rad_per_m"),
            f"{label} mode {identity} k_vector_rad_per_m",
        )
        previous_k = sample_k.setdefault(sample_index, k_vector)
        if previous_k != k_vector:
            raise ValueError(f"{label} sample {sample_index} modes have different signed k")
        frequency_real = _finite_number(
            source_mode.get("frequency_real_hz"),
            f"{label} mode {identity} frequency_real_hz",
        )
        frequency_imag = _finite_number(
            source_mode.get("frequency_imag_hz"),
            f"{label} mode {identity} frequency_imag_hz",
        )
        raw_field = np.asarray(source_mode.get("envelope"))
        if raw_field.dtype.kind not in "iufc":
            raise ValueError(f"{label} mode {identity} envelope must be a numeric array")
        field = np.asarray(raw_field, dtype=np.complex128)
        if field.shape != metric.nodes.shape or not np.all(np.isfinite(field)):
            raise ValueError(
                f"{label} mode {identity} envelope must be finite Cartesian nodal XYZ"
            )
        try:
            metric.normalized(field)
        except (ValueError, FloatingPointError) as error:
            raise ValueError(
                f"{label} mode {identity} has invalid magnetic norm: {error}"
            ) from error
        modes[identity] = {
            "envelope": field,
            "k_vector_rad_per_m": k_vector,
            "frequency_real_hz": frequency_real,
            "frequency_imag_hz": frequency_imag,
        }
    return metric, modes, sample_k, hashes, fingerprint


def _validate_clusters(
    cluster_map: object,
    *,
    sample_indices: set[int],
    modes: Mapping[tuple[int, int], Mapping[str, Any]],
    metric: Tet4TrackingMetric,
    side: str,
    degeneration_relative_tolerance: float,
) -> dict[int, list[list[int]]]:
    if not isinstance(cluster_map, Mapping):
        raise ValueError(f"{side} clusters must map every sample_index to raw-ID groups")
    indexed: dict[int, object] = {}
    for sample_index, sample_clusters in cluster_map.items():
        sample_index = _nonnegative_integer(sample_index, f"{side} cluster sample_index")
        if sample_index in indexed:
            raise ValueError(f"{side} clusters contain duplicate sample_index")
        indexed[sample_index] = sample_clusters
    if set(indexed) != sample_indices:
        raise ValueError(f"{side} cluster sample coverage differs from the supplied inventory")

    result: dict[int, list[list[int]]] = {}
    for sample_index in sorted(sample_indices):
        source_groups = indexed[sample_index]
        if not _sequence(source_groups) or not source_groups:
            raise ValueError(f"{side} sample {sample_index} requires non-empty explicit clusters")
        expected_ids = {raw for sample, raw in modes if sample == sample_index}
        seen: set[int] = set()
        groups: list[list[int]] = []
        for cluster_index, source_group in enumerate(source_groups):
            if not _sequence(source_group) or not source_group:
                raise ValueError(
                    f"{side} sample {sample_index} cluster {cluster_index} must be non-empty"
                )
            group = [
                _nonnegative_integer(raw, f"{side} sample {sample_index} raw_mode_index")
                for raw in source_group
            ]
            if len(set(group)) != len(group) or seen.intersection(group):
                raise ValueError(f"{side} sample {sample_index} clusters are not a partition")
            if any(raw not in expected_ids for raw in group):
                raise ValueError(f"{side} sample {sample_index} cluster contains an unknown raw ID")
            seen.update(group)

            anchor = modes[(sample_index, group[0])]
            vectors = []
            for raw in group:
                mode = modes[(sample_index, raw)]
                distance = _relative_complex_frequency_distance(
                    anchor["frequency_real_hz"],
                    anchor["frequency_imag_hz"],
                    mode["frequency_real_hz"],
                    mode["frequency_imag_hz"],
                )
                if distance > degeneration_relative_tolerance:
                    raise ValueError(
                        f"{side} sample {sample_index} cluster {cluster_index} frequencies "
                        "are not degenerate within the caller tolerance"
                    )
                vectors.append(mode["envelope"])
            try:
                metric.basis(vectors)
            except (ValueError, FloatingPointError) as error:
                raise ValueError(
                    f"{side} sample {sample_index} cluster {cluster_index} is rank deficient: {error}"
                ) from error
            groups.append(group)
        if seen != expected_ids:
            missing = sorted(expected_ids - seen)
            raise ValueError(
                f"{side} sample {sample_index} clusters do not cover candidate inventory; "
                f"missing raw IDs={missing}"
            )
        result[sample_index] = groups
    return result


def _best_admissible_alternative(
    weights: np.ndarray,
    selected: Sequence[int],
    overlap_floor: float,
) -> tuple[float | None, int]:
    """Find the best full alternative satisfying the caller score floor.

    For each selected edge, zero it and use the shared Hungarian helper. The
    transformed weights first maximize the count of floor-admissible edges,
    then maximize their original score sum. A partial assignment containing a
    below-floor edge is discarded.
    """
    row_count, _ = weights.shape
    best_total: float | None = None
    best_exclusion_count = 0
    for forbidden_row, forbidden_column in enumerate(selected):
        allowed = weights >= overlap_floor
        allowed[forbidden_row, forbidden_column] = False
        transformed = np.zeros_like(weights)
        transformed[allowed] = (
            row_count + weights[allowed]
        ) / (row_count + 1)
        alternative, _ = maximum_weight_assignment(transformed)
        if alternative[forbidden_row] == forbidden_column:
            continue
        scores = weights[np.arange(row_count), alternative]
        if np.any(scores < overlap_floor):
            continue
        total = float(np.sum(scores, dtype=np.float64))
        if best_total is None or total > best_total:
            best_total = total
            best_exclusion_count = 1
        elif total == best_total:
            best_exclusion_count += 1
    return best_total, best_exclusion_count


def _match_sample(
    metric: Tet4TrackingMetric,
    left_modes: Mapping[tuple[int, int], Mapping[str, Any]],
    right_modes: Mapping[tuple[int, int], Mapping[str, Any]],
    sample_index: int,
    left_groups: list[list[int]],
    right_groups: list[list[int]],
    overlap_floor: float,
    ambiguity_tolerance: float,
    mesh_fingerprint: str,
) -> dict[str, Any]:
    if len(right_groups) < len(left_groups):
        raise ValueError(
            f"sample {sample_index} has fewer right clusters than left clusters"
        )

    pair_scores: list[dict[str, Any]] = []
    weights = np.zeros((len(left_groups), len(right_groups)), dtype=np.float64)
    for left_index, left_group in enumerate(left_groups):
        for right_index, right_group in enumerate(right_groups):
            left_rank, right_rank = len(left_group), len(right_group)
            cosines: list[float] = []
            score = 0.0
            compatible = left_rank == right_rank
            if compatible:
                left_vectors = [
                    left_modes[(sample_index, raw)]["envelope"] for raw in left_group
                ]
                right_vectors = [
                    right_modes[(sample_index, raw)]["envelope"] for raw in right_group
                ]
                if left_rank == 1:
                    score = metric.overlap(left_vectors[0], right_vectors[0])
                    cosines = [score]
                else:
                    measured = np.asarray(
                        metric.principal_cosines(left_vectors, right_vectors),
                        dtype=np.float64,
                    )
                    if measured.shape != (left_rank,) or not np.all(np.isfinite(measured)):
                        raise ValueError("principal-cosine measurement returned an invalid rank")
                    cosines = [float(value) for value in measured]
                    score = min(cosines)
                if not math.isfinite(score) or not 0.0 <= score <= 1.0:
                    raise ValueError("field overlap score is outside [0, 1]")
            weights[left_index, right_index] = score
            pair_scores.append({
                "left_cluster_index": left_index,
                "right_cluster_index": right_index,
                "left_raw_mode_indices": list(left_group),
                "right_raw_mode_indices": list(right_group),
                "left_rank": left_rank,
                "right_rank": right_rank,
                "rank_compatible": compatible,
                "principal_cosines": cosines,
                "score": score,
            })

    row_count = len(left_groups)
    eligible = weights >= overlap_floor
    transformed = np.zeros_like(weights)
    transformed[eligible] = (
        row_count + weights[eligible]
    ) / (row_count + 1)
    selected, _ = maximum_weight_assignment(transformed)
    selected_scores = weights[np.arange(row_count), selected]
    optimum_total = float(np.sum(selected_scores, dtype=np.float64))
    selected_pairs: list[dict[str, Any]] = []
    used_right: set[int] = set()
    reasons: list[str] = []
    for left_index, right_index in enumerate(selected):
        used_right.add(right_index)
        pair = pair_scores[left_index * len(right_groups) + right_index]
        selected_pairs.append(dict(pair))
        if selected_scores[left_index] < overlap_floor:
            reasons.append(
                f"assigned field score {selected_scores[left_index]:.17g} "
                f"is below overlap_floor for left cluster {left_index}"
            )

    alternative_total, alternative_exclusions = _best_admissible_alternative(
        weights, selected, overlap_floor
    )
    assignment_gap = (
        None if alternative_total is None
        else max(0.0, float(optimum_total) - alternative_total)
    )
    if assignment_gap is not None and assignment_gap <= ambiguity_tolerance:
        reasons.append(
            f"global assignment gap {assignment_gap:.17g} is not above "
            "ambiguity_tolerance"
        )

    return {
        "sample_index": sample_index,
        "k_vector_rad_per_m": list(
            left_modes[(sample_index, left_groups[0][0])]["k_vector_rad_per_m"]
        ),
        "status": "not_verified" if reasons else "pass",
        "reasons": reasons,
        "candidate_inventory": {
            "left_mode_count": sum(len(group) for group in left_groups),
            "right_mode_count": sum(len(group) for group in right_groups),
            "left_cluster_count": len(left_groups),
            "right_cluster_count": len(right_groups),
            "all_supplied_left_clusters_assigned": len(selected_pairs) == len(left_groups),
            "unmatched_right_cluster_indices": [
                index for index in range(len(right_groups)) if index not in used_right
            ],
            "expected_spectral_completeness": "must_be_bound_by_caller",
        },
        "clusters": {
            "left": [
                {"cluster_index": index, "raw_mode_indices": list(group), "rank": len(group)}
                for index, group in enumerate(left_groups)
            ],
            "right": [
                {"cluster_index": index, "raw_mode_indices": list(group), "rank": len(group)}
                for index, group in enumerate(right_groups)
            ],
        },
        "pair_scores": pair_scores,
        "assignment": {
            "left_to_right_cluster_indices": list(selected),
            "assigned_pairs": selected_pairs,
            "overlap_floor": overlap_floor,
            "total_score": float(optimum_total),
            "best_admissible_alternative_total_score": alternative_total,
            "assignment_gap": assignment_gap,
            "edge_exclusions_with_admissible_alternative": alternative_exclusions,
            "ambiguity_tolerance": ambiguity_tolerance,
            "mesh_topology_sha256": mesh_fingerprint,
        },
    }


def match_cross_run_modes(
    left_context: Mapping[str, Any],
    right_context: Mapping[str, Any],
    *,
    left_clusters: Mapping[int, Sequence[Sequence[int]]],
    right_clusters: Mapping[int, Sequence[Sequence[int]]],
    overlap_floor: float,
    ambiguity_tolerance: float,
    degeneration_relative_tolerance: float,
) -> dict[str, Any]:
    """Match supplied candidate fields across runs on the exact same Tet4 mesh.

    left_context and right_context are the complete mappings returned by
    load_tracking_fields for their supplied selections. Cluster maps must
    explicitly partition every returned (sample, raw-mode) candidate.
    Frequencies only check the caller's within-run degeneracy clusters; signed
    k is required to agree exactly and neither frequency nor raw IDs enters
    the field-matching score.

    A returned status of pass means only that this diagnostic found a
    floor-qualified, unambiguous field-similarity assignment against the
    supplied inventories. Overall scientific qualification is always
    NOT VERIFIED; callers must bind bundle provenance, expected candidate
    completeness, spectral quality, and physical applicability.
    """
    floor = _finite_number(overlap_floor, "overlap_floor")
    if floor <= 0.0 or floor > 1.0:
        raise ValueError("overlap_floor must be positive and at most one")
    ambiguity = _finite_number(ambiguity_tolerance, "ambiguity_tolerance")
    if ambiguity < 0.0:
        raise ValueError("ambiguity_tolerance must be non-negative")
    degeneration = _finite_number(
        degeneration_relative_tolerance,
        "degeneration_relative_tolerance",
    )
    if degeneration < 0.0:
        raise ValueError("degeneration_relative_tolerance must be non-negative")

    left_metric, left_modes, left_k, left_hashes, left_fingerprint = _context_modes(
        left_context, "left"
    )
    right_metric, right_modes, right_k, right_hashes, right_fingerprint = _context_modes(
        right_context, "right"
    )
    mesh_fingerprint, _ = _validate_same_mesh(left_context, right_context)
    if left_fingerprint != mesh_fingerprint or right_fingerprint != mesh_fingerprint:
        raise ValueError("cross-run mesh fingerprint context is inconsistent")

    left_samples, right_samples = set(left_k), set(right_k)
    if left_samples != right_samples:
        raise ValueError("cross-run sample coverage differs")
    for sample_index in sorted(left_samples):
        if left_k[sample_index] != right_k[sample_index]:
            raise ValueError(
                f"sample {sample_index} has different signed k vectors across runs"
            )

    left_group_map = _validate_clusters(
        left_clusters,
        sample_indices=left_samples,
        modes=left_modes,
        metric=left_metric,
        side="left",
        degeneration_relative_tolerance=degeneration,
    )
    right_group_map = _validate_clusters(
        right_clusters,
        sample_indices=right_samples,
        modes=right_modes,
        metric=right_metric,
        side="right",
        degeneration_relative_tolerance=degeneration,
    )

    samples = [
        _match_sample(
            left_metric,
            left_modes,
            right_modes,
            sample_index,
            left_group_map[sample_index],
            right_group_map[sample_index],
            floor,
            ambiguity,
            mesh_fingerprint,
        )
        for sample_index in sorted(left_samples)
    ]
    status = "pass" if all(item["status"] == "pass" for item in samples) else "not_verified"
    return {
        "schema": REPORT_SCHEMA,
        "status": status,
        "diagnostic_only": True,
        "qualification": "NOT VERIFIED",
        "matching_basis": "consistent_p1_tet4_cartesian_nodal_envelope",
        "identity_boundary": "field_similarity_assignment_only_not_physical_mode_qualification",
        "raw_mode_indices": "audit_labels_only_not_matching_identity",
        "frequencies": "used_only_for_explicit_within_run_cluster_degeneracy_validation",
        "signed_k_policy": "exact_same_vector_per_sample_in_rad_per_m",
        "spectral_completeness": "expected_candidate_inventory_must_be_bound_by_caller",
        "bundle_provenance": "hash_bound_context_required_and_provenance_scope_must_be_bound_by_caller",
        "metric": {
            "definition": "consistent_p1_tet4_magnetic_mass",
            "mesh_topology_sha256": mesh_fingerprint,
            "node_count": int(len(left_metric.nodes)),
            "magnetic_tet4_count": int(len(left_metric.cells)),
            "magnetic_support_node_count": int(len(left_metric.support)),
        },
        "caller_thresholds": {
            "overlap_floor": floor,
            "ambiguity_tolerance": ambiguity,
            "degeneration_relative_tolerance": degeneration,
        },
        "inputs": {
            "left_file_hashes": left_hashes,
            "right_file_hashes": right_hashes,
            "left_sample_count": len(left_samples),
            "right_sample_count": len(right_samples),
            "paired_sample_indices": sorted(left_samples),
        },
        "samples": samples,
    }