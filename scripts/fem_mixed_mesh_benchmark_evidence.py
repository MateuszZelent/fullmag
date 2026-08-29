"""Pure schema, aggregation, and gate logic for mixed-mesh benchmark evidence."""

from __future__ import annotations

import math
import re
import sys
from datetime import datetime, timezone
from typing import Mapping, Sequence


SCHEMA = "fullmag.fem-mixed-mesh-performance.v2"
SOURCE_IDENTITY_SCHEMA = "fullmag.source-snapshot.v2"
GMSH_VERSION = "4.15.2"
PRODUCTION_REPAIR_METHOD = "default"
REPAIR_METHODS = ("default", "Relocate3D", "Netgen")
REPAIR_METHOD_OVERRIDES = ("Relocate3D", "Netgen")
CELL_FAMILIES = ("prism6", "pyramid5", "tet4")
PHASE_TIMING_FIELDS = (
    "authoring_resolve_s",
    "cache_lookup_s",
    "occ_build_s",
    "gmsh_generate_s",
    "gmsh_repair_s",
    "gmsh_extract_s",
    "orientation_s",
    "certificate_python_s",
    "certificate_native_s",
    "artifact_serialize_s",
    "artifact_hash_verify_s",
    "artifact_deserialize_s",
    "native_preflight_s",
    "total_s",
)
_TOP_LEVEL_FIELDS = {
    "schema",
    "generated_at",
    "source_identity",
    "environment",
    "scenario",
    "mesh",
    "quality",
    "runs",
    "summary",
    "gate",
}
_SOURCE_IDENTITY_FIELDS = {
    "schema",
    "head_commit_full",
    "head_tree_sha256",
    "git_status_porcelain_v1",
    "dirty_path_content",
    "source_snapshot_dirty",
    "dirty_content_sha256",
    "source_snapshot_sha256",
}
_QUALITY_FIELDS = {
    "requested_layers",
    "realized_layers",
    "non_manifold_faces",
    "same_side_two_owner_faces",
    "relative_volume_error",
    "scaled_jacobian_p05_by_family",
}
_SUMMARY_STATS = {"p50", "p95", "max"}
_HEX40 = re.compile(r"[0-9a-f]{40}\Z")
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")


def linear_percentile(values: Sequence[float], quantile: float) -> float:
    """Return the linearly interpolated quantile used by the evidence schema."""
    if not values:
        raise ValueError("percentile requires at least one value")
    if not math.isfinite(quantile) or not 0.0 <= quantile <= 1.0:
        raise ValueError("percentile quantile must be finite and in [0, 1]")
    ordered = sorted(float(value) for value in values)
    if any(not math.isfinite(value) for value in ordered):
        raise ValueError("percentile values must be finite")
    position = quantile * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def make_gate(mode: str, failures: Sequence[str]) -> dict[str, object]:
    normalized = [str(failure) for failure in failures]
    if mode == "baseline":
        return {"status": "baseline_recorded", "failures": normalized}
    if mode != "qualification":
        raise ValueError(f"unsupported benchmark mode: {mode}")
    return {
        "status": "release_pass" if not normalized else "release_fail",
        "failures": normalized,
    }


def _require_mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be an object")
    return value


def _require_exact_fields(
    value: Mapping[str, object], fields: set[str], label: str
) -> None:
    missing = sorted(fields - set(value))
    extra = sorted(set(value) - fields)
    if missing or extra:
        raise ValueError(f"{label} fields differ: missing={missing}, extra={extra}")


def _require_positive_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return value


def _require_nonnegative_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return value


def _require_finite(
    value: object, label: str, *, nonnegative: bool = True
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a binary64-compatible number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} must be finite")
    if nonnegative and result < 0.0:
        raise ValueError(f"{label} must be non-negative")
    return result


def _require_hex(value: object, expression: re.Pattern[str], label: str) -> str:
    if not isinstance(value, str) or expression.fullmatch(value) is None:
        raise ValueError(f"{label} has an invalid lowercase hexadecimal digest")
    return value


def _normalize_sha256(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a SHA-256 string")
    return _require_hex(value.removeprefix("sha256:"), _HEX64, label)


def _validate_generated_at(value: object) -> None:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("generated_at must be RFC3339 UTC")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ValueError("generated_at must be RFC3339 UTC") from error
    if parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise ValueError("generated_at must be RFC3339 UTC")


def _validate_quality(value: object, label: str) -> dict[str, object]:
    quality = _require_mapping(value, label)
    _require_exact_fields(quality, _QUALITY_FIELDS, label)
    requested = _require_positive_int(
        quality["requested_layers"], f"{label}.requested_layers"
    )
    realized = _require_positive_int(
        quality["realized_layers"], f"{label}.realized_layers"
    )
    if requested != realized:
        raise ValueError(f"{label} requested and realized layers differ")
    jacobians = _require_mapping(
        quality["scaled_jacobian_p05_by_family"],
        f"{label}.scaled_jacobian_p05_by_family",
    )
    _require_exact_fields(
        jacobians,
        set(CELL_FAMILIES),
        f"{label}.scaled_jacobian_p05_by_family",
    )
    return {
        "requested_layers": requested,
        "realized_layers": realized,
        "non_manifold_faces": _require_nonnegative_int(
            quality["non_manifold_faces"], f"{label}.non_manifold_faces"
        ),
        "same_side_two_owner_faces": _require_nonnegative_int(
            quality["same_side_two_owner_faces"],
            f"{label}.same_side_two_owner_faces",
        ),
        "relative_volume_error": _require_finite(
            quality["relative_volume_error"], f"{label}.relative_volume_error"
        ),
        "scaled_jacobian_p05_by_family": {
            family: _require_finite(
                jacobians[family],
                f"{label}.scaled_jacobian_p05_by_family.{family}",
            )
            for family in CELL_FAMILIES
        },
    }


def _binary64_certificate_equal(left: float, right: float) -> bool:
    tolerance = max(
        1.0e-12 * max(abs(left), abs(right)),
        16.0 * sys.float_info.epsilon,
    )
    return abs(left - right) <= tolerance


def _quality_equal(
    left: Mapping[str, object], right: Mapping[str, object]
) -> bool:
    exact_fields = (
        "requested_layers",
        "realized_layers",
        "non_manifold_faces",
        "same_side_two_owner_faces",
    )
    if any(left[field] != right[field] for field in exact_fields):
        return False
    if not _binary64_certificate_equal(
        float(left["relative_volume_error"]),
        float(right["relative_volume_error"]),
    ):
        return False
    left_jacobians = _require_mapping(
        left["scaled_jacobian_p05_by_family"], "left quality jacobians"
    )
    right_jacobians = _require_mapping(
        right["scaled_jacobian_p05_by_family"], "right quality jacobians"
    )
    return all(
        _binary64_certificate_equal(
            float(left_jacobians[family]), float(right_jacobians[family])
        )
        for family in CELL_FAMILIES
    )


def _summary_stats(values: Sequence[float]) -> dict[str, float] | None:
    if not values:
        return None
    return {
        "p50": linear_percentile(values, 0.50),
        "p95": linear_percentile(values, 0.95),
        "max": max(values),
    }


def _python_audit_samples(run: Mapping[str, object], label: str) -> list[float]:
    samples = run["python_audit_samples_s"]
    if not isinstance(samples, list):
        raise ValueError(f"{label}.python_audit_samples_s must be an array")
    return [
        _require_finite(sample, f"{label}.python_audit_samples_s[{index}]")
        for index, sample in enumerate(samples)
    ]


def _summarize(runs: Sequence[Mapping[str, object]]) -> dict[str, object]:
    timings: dict[str, dict[str, float] | None] = {}
    for field in PHASE_TIMING_FIELDS:
        values = [
            float(_require_mapping(run["timings"], "timings")[field])
            for run in runs
            if field not in run["unavailable_phase_timings"]
        ]
        timings[field] = _summary_stats(values)
    python_audit_values = [
        sample
        for index, run in enumerate(runs)
        for sample in _python_audit_samples(run, f"runs[{index}]")
    ]
    rss_values = [
        float(run["peak_rss_bytes"])
        for run in runs
        if run["memory_status"] == "measured"
    ]
    return {
        "timings": timings,
        "python_audit_s": _summary_stats(python_audit_values),
        "peak_rss_bytes": _summary_stats(rss_values),
    }


def _run_failures(runs: Sequence[Mapping[str, object]]) -> list[str]:
    failures: list[str] = []
    if len({str(run["topology_fingerprint_v3"]) for run in runs}) != 1:
        failures.append("topology fingerprint differs across measured runs")
    reference = _validate_quality(runs[0]["quality"], "runs[0].quality")
    if any(
        not _quality_equal(
            _validate_quality(run["quality"], f"runs[{index}].quality"),
            reference,
        )
        for index, run in enumerate(runs[1:], start=1)
    ):
        failures.append("normalized quality differs across measured runs")
    if any(bool(run["degraded"]) for run in runs):
        failures.append("at least one measured run is degraded")
    if any(run["memory_status"] != "measured" for run in runs):
        failures.append("peak RSS was not measured for every run")
    for index, run in enumerate(runs):
        quality = _validate_quality(run["quality"], f"runs[{index}].quality")
        if quality["requested_layers"] != 1 or quality["realized_layers"] != 1:
            failures.append(f"runs[{index}] does not preserve exact layer count 1")
        if quality["non_manifold_faces"] != 0:
            failures.append(f"runs[{index}] has non-manifold faces")
        if quality["same_side_two_owner_faces"] != 0:
            failures.append(f"runs[{index}] has same-side two-owner faces")
        if float(quality["relative_volume_error"]) > 1.0e-8:
            failures.append(f"runs[{index}] exceeds relative volume error 1e-8")
        p05 = _require_mapping(
            quality["scaled_jacobian_p05_by_family"],
            f"runs[{index}].quality.scaled_jacobian_p05_by_family",
        )
        for family in CELL_FAMILIES:
            if float(p05[family]) < 0.1:
                failures.append(f"runs[{index}] {family} p05 is below 0.1")
    return failures


def _validate_summary(value: object) -> dict[str, object]:
    summary = _require_mapping(value, "summary")
    _require_exact_fields(
        summary,
        {"timings", "python_audit_s", "peak_rss_bytes"},
        "summary",
    )
    timings = _require_mapping(summary["timings"], "summary.timings")
    _require_exact_fields(timings, set(PHASE_TIMING_FIELDS), "summary.timings")
    normalized_timings: dict[str, object] = {}
    for field in PHASE_TIMING_FIELDS:
        if timings[field] is None:
            normalized_timings[field] = None
            continue
        stats = _require_mapping(timings[field], f"summary.timings.{field}")
        _require_exact_fields(stats, _SUMMARY_STATS, f"summary.timings.{field}")
        normalized_timings[field] = {
            stat: _require_finite(stats[stat], f"summary.timings.{field}.{stat}")
            for stat in _SUMMARY_STATS
        }
    python_audit = summary["python_audit_s"]
    if python_audit is None:
        normalized_python_audit = None
    else:
        python_audit_stats = _require_mapping(python_audit, "summary.python_audit_s")
        _require_exact_fields(
            python_audit_stats, _SUMMARY_STATS, "summary.python_audit_s"
        )
        normalized_python_audit = {
            stat: _require_finite(
                python_audit_stats[stat], f"summary.python_audit_s.{stat}"
            )
            for stat in _SUMMARY_STATS
        }
    if summary["peak_rss_bytes"] is None:
        return {
            "timings": normalized_timings,
            "python_audit_s": normalized_python_audit,
            "peak_rss_bytes": None,
        }
    peak_rss = _require_mapping(
        summary["peak_rss_bytes"], "summary.peak_rss_bytes"
    )
    _require_exact_fields(peak_rss, _SUMMARY_STATS, "summary.peak_rss_bytes")
    return {
        "timings": normalized_timings,
        "python_audit_s": normalized_python_audit,
        "peak_rss_bytes": {
            stat: _require_finite(
                peak_rss[stat], f"summary.peak_rss_bytes.{stat}"
            )
            for stat in _SUMMARY_STATS
        },
    }


def validate_evidence_document(document: Mapping[str, object]) -> None:
    """Validate one immutable mixed-mesh performance evidence document."""
    root = _require_mapping(document, "evidence")
    _require_exact_fields(root, _TOP_LEVEL_FIELDS, "evidence")
    if root["schema"] != SCHEMA:
        raise ValueError(f"schema must be {SCHEMA}")
    _validate_generated_at(root["generated_at"])

    source = _require_mapping(root["source_identity"], "source_identity")
    _require_exact_fields(source, _SOURCE_IDENTITY_FIELDS, "source_identity")
    if source["schema"] != SOURCE_IDENTITY_SCHEMA:
        raise ValueError(f"source_identity.schema must be {SOURCE_IDENTITY_SCHEMA}")
    _require_hex(source["head_commit_full"], _HEX40, "head_commit_full")
    for field in (
        "head_tree_sha256",
        "dirty_content_sha256",
        "source_snapshot_sha256",
    ):
        _require_hex(source[field], _HEX64, field)
    if not isinstance(source["git_status_porcelain_v1"], list):
        raise ValueError("git_status_porcelain_v1 must be an array")
    if not isinstance(source["dirty_path_content"], list):
        raise ValueError("dirty_path_content must be an array")
    if not isinstance(source["source_snapshot_dirty"], bool):
        raise ValueError("source_snapshot_dirty must be boolean")

    environment = _require_mapping(root["environment"], "environment")
    _require_exact_fields(
        environment,
        {
            "python_version",
            "gmsh_version",
            "certifier_algorithm",
            "platform",
            "cpu_model",
            "logical_cpus",
        },
        "environment",
    )
    for field in ("python_version", "certifier_algorithm", "platform", "cpu_model"):
        if not isinstance(environment[field], str) or not environment[field]:
            raise ValueError(f"environment.{field} must be a non-empty string")
    if environment["gmsh_version"] != GMSH_VERSION:
        raise ValueError(f"environment.gmsh_version must be {GMSH_VERSION}")
    _require_positive_int(environment["logical_cpus"], "logical_cpus")

    scenario = _require_mapping(root["scenario"], "scenario")
    _require_exact_fields(
        scenario,
        {
            "id",
            "requested_layers",
            "repair_method",
            "gmsh_threads",
            "rayon_threads",
            "python_audit_runs",
        },
        "scenario",
    )
    if scenario["id"] != "sp4_mixed":
        raise ValueError("scenario.id must be sp4_mixed")
    scenario_layers = _require_positive_int(
        scenario["requested_layers"], "requested_layers"
    )
    if scenario["gmsh_threads"] != 1:
        raise ValueError("scenario.gmsh_threads must be exactly one")
    _require_positive_int(scenario["rayon_threads"], "rayon_threads")
    if scenario["repair_method"] not in REPAIR_METHODS:
        raise ValueError("scenario.repair_method is unsupported")
    python_audit_runs = _require_nonnegative_int(
        scenario["python_audit_runs"],
        "scenario.python_audit_runs",
    )

    mesh = _require_mapping(root["mesh"], "mesh")
    _require_exact_fields(
        mesh, {"nodes", "cells", "facets", "topology_fingerprint_v3"}, "mesh"
    )
    for field in ("nodes", "cells", "facets"):
        _require_positive_int(mesh[field], f"mesh.{field}")
    mesh_fingerprint = _require_hex(
        mesh["topology_fingerprint_v3"], _HEX64, "mesh.topology_fingerprint_v3"
    )
    root_quality = _validate_quality(root["quality"], "quality")
    if root_quality["requested_layers"] != scenario_layers:
        raise ValueError("scenario and quality requested layers differ")

    runs = root["runs"]
    if not isinstance(runs, list) or not runs:
        raise ValueError("runs must be a non-empty array")
    normalized: list[tuple[Mapping[str, object], dict[str, object], str]] = []
    warm_fingerprints: set[str] = set()
    all_fingerprints: set[str] = set()
    for index, raw_run in enumerate(runs):
        run = _require_mapping(raw_run, f"runs[{index}]")
        _require_exact_fields(
            run,
            {
                "kind",
                "index",
                "timings",
                "python_audit_samples_s",
                "unavailable_phase_timings",
                "peak_rss_bytes",
                "memory_status",
                "topology_fingerprint_v3",
                "quality",
                "degraded",
            },
            f"runs[{index}]",
        )
        if run["kind"] not in {"cold", "warm"}:
            raise ValueError(f"runs[{index}].kind must be cold or warm")
        _require_nonnegative_int(run["index"], f"runs[{index}].index")
        timings = _require_mapping(run["timings"], f"runs[{index}].timings")
        _require_exact_fields(
            timings, set(PHASE_TIMING_FIELDS), f"runs[{index}].timings"
        )
        for field in PHASE_TIMING_FIELDS:
            _require_finite(timings[field], f"runs[{index}].timings.{field}")
        if float(timings["total_s"]) <= 0.0:
            raise ValueError(f"runs[{index}].timings.total_s must be positive")
        unavailable = run["unavailable_phase_timings"]
        if (
            not isinstance(unavailable, list)
            or any(
                not isinstance(field, str) or field not in PHASE_TIMING_FIELDS
                for field in unavailable
            )
            or len(set(unavailable)) != len(unavailable)
        ):
            raise ValueError(
                f"runs[{index}].unavailable_phase_timings must contain unique phase names"
            )
        for field in unavailable:
            if timings[field] != 0.0:
                raise ValueError(
                    f"runs[{index}].timings.{field} must be zero when unavailable"
                )
        python_audit_samples = _python_audit_samples(run, f"runs[{index}]")
        if len(python_audit_samples) != python_audit_runs:
            raise ValueError(
                f"runs[{index}].python_audit_samples_s must contain exactly "
                f"{python_audit_runs} samples"
            )
        memory_status = run["memory_status"]
        if memory_status == "measured":
            _require_positive_int(
                run["peak_rss_bytes"], f"runs[{index}].peak_rss_bytes"
            )
        elif memory_status == "not_measured":
            if run["peak_rss_bytes"] is not None:
                raise ValueError("not_measured peak_rss_bytes must be null")
        else:
            raise ValueError("memory_status must be measured or not_measured")
        fingerprint = _require_hex(
            run["topology_fingerprint_v3"],
            _HEX64,
            f"runs[{index}].topology_fingerprint_v3",
        )
        quality = _validate_quality(run["quality"], f"runs[{index}].quality")
        if not isinstance(run["degraded"], bool):
            raise ValueError(f"runs[{index}].degraded must be boolean")
        normalized.append((run, quality, fingerprint))
        all_fingerprints.add(fingerprint)
        if run["kind"] == "warm":
            warm_fingerprints.add(fingerprint)

    if len(warm_fingerprints) > 1:
        raise ValueError("warm runs have mixed topology fingerprint values")
    if len(all_fingerprints) > 1:
        raise ValueError("measured runs have mixed topology fingerprint values")
    for index, (run, quality, fingerprint) in enumerate(normalized):
        if fingerprint != mesh_fingerprint:
            raise ValueError(f"runs[{index}] topology fingerprint differs from mesh")
        if not _quality_equal(quality, root_quality):
            raise ValueError(f"runs[{index}] quality differs from evidence quality")

    normalized_runs = [run for run, _, _ in normalized]
    if _validate_summary(root["summary"]) != _summarize(normalized_runs):
        raise ValueError("summary does not match statistics recalculated from runs")
    gate = _require_mapping(root["gate"], "gate")
    _require_exact_fields(gate, {"status", "failures"}, "gate")
    status = gate["status"]
    if status not in {"baseline_recorded", "release_pass", "release_fail"}:
        raise ValueError("gate.status is unsupported")
    if status == "baseline_recorded" and scenario["repair_method"] != PRODUCTION_REPAIR_METHOD:
        raise ValueError("baseline_recorded requires canonical repair method default")
    failures = gate["failures"]
    if not isinstance(failures, list) or any(
        not isinstance(failure, str) for failure in failures
    ):
        raise ValueError("gate.failures must be an array of strings")
    if status == "release_pass":
        if failures:
            raise ValueError("release_pass requires empty gate failures")
        if any(run["memory_status"] != "measured" for run, _, _ in normalized):
            raise ValueError("release_pass requires measured RSS for every run")
        if any(bool(run["degraded"]) for run, _, _ in normalized):
            raise ValueError("release_pass requires degraded=false for every run")
    elif status == "release_fail" and not failures:
        raise ValueError("release_fail requires at least one gate failure")
    expected_failures = _run_failures(normalized_runs)
    if failures != expected_failures:
        raise ValueError("gate.failures must exactly match failures recalculated from runs")
    if status != "baseline_recorded":
        expected_status = "release_pass" if not expected_failures else "release_fail"
        if status != expected_status:
            raise ValueError(
                f"gate.status must be {expected_status} for recalculated failures"
            )
