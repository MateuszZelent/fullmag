"""Append one immutable Fullmag SP4 application attempt to a CSV ledger."""

from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
from typing import Any, Iterable

import numpy as np

from fullmag.meshing._gmsh_types import MixedLayerTopologyCertificate
from tests.standard_problems.mumag.sp4.common.metrics import (
    find_first_zero_crossing,
    reference_envelope_metrics,
)
from tests.standard_problems.mumag.sp4.common.references import (
    Trajectory,
    parse_albuquerque_trace,
    parse_oommf_odt,
)


class CollectionError(ValueError):
    """Raised when an application artifact cannot safely enter the ledger."""


FIELDNAMES = (
    "attempt_id",
    "collected_at_utc",
    "phase",
    "scenario",
    "case",
    "relaxation_algorithm",
    "integrator",
    "timestep_policy",
    "requested_device",
    "execution_engine",
    "precision",
    "execution_mode",
    "fallback_used",
    "demag_realization",
    "demag_operator_mode",
    "demag_iterations",
    "demag_final_residual",
    "mesh_topology_fingerprint",
    "mesh_node_count",
    "mesh_element_count",
    "mesh_certificate_status",
    "mesh_node_plane_count",
    "mesh_magnetic_prism6_count",
    "mesh_magnetic_tet4_count",
    "mesh_magnetic_pyramid5_count",
    "airbox_x_m",
    "airbox_y_m",
    "airbox_z_m",
    "magnetic_hmax_m",
    "film_layers",
    "fixed_dt_s",
    "dt_initial_s",
    "dt_min_s",
    "dt_max_s",
    "max_error",
    "sample_count",
    "step_start",
    "step_stop",
    "time_start_s",
    "time_stop_s",
    "crossing_time_s",
    "nist_crossing_min_s",
    "nist_crossing_max_s",
    "nist_rmse_mx",
    "nist_rmse_my",
    "nist_rmse_mz",
    "nist_envelope_rms_mx",
    "nist_envelope_rms_my",
    "nist_envelope_rms_mz",
    "final_mx",
    "final_my",
    "final_mz",
    "relaxation_converged",
    "relaxation_stop_reason",
    "relaxation_stop_metric",
    "relaxation_stop_value",
    "relaxation_stop_threshold",
    "relaxation_torque_limit_T",
    "initial_E_total_J",
    "energy_drop_J",
    "max_energy_increase_J",
    "final_E_total_J",
    "final_max_torque_T",
    "wall_time_s",
    "status",
    "failure_category",
    "failure_detail",
    "artifact_dir",
    "metadata_sha256",
    "scalars_sha256",
)

_DYNAMICS_SCENARIO = re.compile(
    r"^(case_[ab])_(heun|rk23|rk4|rk45)_(fixed|adaptive)(?:_[a-z0-9_]+)?$"
)
_DIRECT_RELAXATION_SCENARIO = re.compile(
    r"^relax_(projected_gradient_bb|nonlinear_cg)$"
)
_LLG_RELAXATION_SCENARIO = re.compile(
    r"^relax_llg_(heun|rk23|rk4|rk45)_(fixed_dt_[0-9a-z]+|adaptive)$"
)
_TOPOLOGY_SCENARIO = "mesh_single_prism_layer"

RELAXATION_TORQUE_LIMIT_T = 1e-5
_MIXED_TOPOLOGY_LEDGER_FIELDS = frozenset(
    {
        "mesh_certificate_status",
        "mesh_node_plane_count",
        "mesh_magnetic_prism6_count",
        "mesh_magnetic_tet4_count",
        "mesh_magnetic_pyramid5_count",
    }
)
_LEGACY_FIELDNAMES = tuple(
    name for name in FIELDNAMES if name not in _MIXED_TOPOLOGY_LEDGER_FIELDS
)


@dataclass(frozen=True)
class ScenarioInfo:
    phase: str
    case: str | None
    relaxation_algorithm: str | None
    integrator: str | None
    timestep_policy: str | None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise CollectionError(f"missing metadata: {path}") from exc
    except json.JSONDecodeError as exc:
        raise CollectionError(f"invalid metadata JSON: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise CollectionError(f"invalid metadata object: {path}")
    return value


def _read_scalars(
    path: Path,
    *,
    scenario: ScenarioInfo,
) -> list[dict[str, float]]:
    try:
        stream = path.open(newline="", encoding="utf-8")
    except FileNotFoundError as exc:
        raise CollectionError(f"missing scalar artifact: {path}") from exc
    with stream:
        reader = csv.DictReader(stream)
        fieldnames = list(reader.fieldnames or ())
        required = {
            "step",
            "time",
            "mx",
            "my",
            "mz",
            "E_total",
            "max_torque_T",
        }
        missing = required - set(fieldnames)
        if missing:
            raise CollectionError(f"missing scalar columns: {sorted(missing)}")
        rows: list[dict[str, float]] = []
        for index, raw in enumerate(reader, start=2):
            if None in raw or any(value is None or value.strip() == "" for value in raw.values()):
                raise CollectionError(f"malformed scalar row {index}")
            try:
                row = {name: float(raw[name]) for name in fieldnames}
            except ValueError as exc:
                raise CollectionError(f"non-numeric scalar value in row {index}") from exc
            if not all(math.isfinite(value) for value in row.values()):
                raise CollectionError(f"non-finite scalar value in row {index}")
            rows.append(row)
    if len(rows) < 2:
        raise CollectionError("scalar trace must contain at least two samples")
    steps = [row["step"] for row in rows]
    if any(right <= left for left, right in zip(steps, steps[1:])):
        raise CollectionError("scalar step must be strictly increasing")
    times = [row["time"] for row in rows]
    direct_minimizer = scenario.relaxation_algorithm in {
        "projected_gradient_bb",
        "nonlinear_cg",
    }
    if direct_minimizer:
        if any(time != 0.0 for time in times):
            raise CollectionError("direct minimizer must not advance physical time")
    elif any(right <= left for left, right in zip(times, times[1:])):
        raise CollectionError("scalar time must be strictly increasing")
    return rows


def _nested(value: Any, *keys: str, default: Any = None) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            return default
        current = current[key]
    return current


def _first(*values: Any) -> Any:
    return next((value for value in values if value is not None), None)


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CollectionError("ledger value is non-finite")
        return format(value, ".17g")
    return str(value)


def _scenario_info(scenario: str) -> ScenarioInfo:
    match = _DYNAMICS_SCENARIO.fullmatch(scenario)
    if match is not None:
        return ScenarioInfo("dynamics", match.group(1), None, match.group(2), match.group(3))
    match = _DIRECT_RELAXATION_SCENARIO.fullmatch(scenario)
    if match is not None:
        return ScenarioInfo("relaxation", None, match.group(1), None, None)
    match = _LLG_RELAXATION_SCENARIO.fullmatch(scenario)
    if match is not None:
        policy = "adaptive" if match.group(2) == "adaptive" else "fixed"
        return ScenarioInfo(
            "relaxation",
            None,
            "llg_overdamped",
            match.group(1),
            policy,
        )
    if scenario == _TOPOLOGY_SCENARIO:
        return ScenarioInfo("topology", None, None, None, None)
    raise CollectionError(f"unsupported SP4 scenario name: {scenario}")


@lru_cache(maxsize=2)
def _references(case: str) -> tuple[Trajectory, ...]:
    root = Path(__file__).parents[1] / "references" / "nist"
    index = "1" if case == "case_a" else "2"
    letter = "a" if case == "case_a" else "b"
    return (
        parse_oommf_odt(root / "oommf" / f"stdprob4{letter}.odt"),
        parse_albuquerque_trace(root / "albuquerque" / f"FIELD_{index}_SM_DT25.TXT"),
        parse_albuquerque_trace(root / "albuquerque" / f"FIELD_{index}_LM_DT25.TXT"),
    )


def _reference_metrics(case: str, trace: Trajectory) -> dict[str, Any]:
    references = _references(case)
    start = max([float(trace.time_s[0]), *(float(item.time_s[0]) for item in references)])
    stop = min([float(trace.time_s[-1]), *(float(item.time_s[-1]) for item in references)])
    grid = trace.time_s[(trace.time_s >= start) & (trace.time_s <= stop)]
    if len(grid) < 2:
        raise CollectionError("trajectory does not overlap the NIST traces")
    metrics = reference_envelope_metrics(trace, list(references), grid_s=grid)
    crossings = [find_first_zero_crossing(item) for item in references]
    return {
        "nist_crossing_min_s": min(crossings),
        "nist_crossing_max_s": max(crossings),
        "nist_rmse": metrics["rmse"],
        "nist_envelope_rms": metrics["normalized_rms"],
    }


def _timestep_values(metadata: dict[str, Any]) -> dict[str, Any]:
    provenance = metadata.get("execution_provenance", {})
    policy = provenance.get("timestep_policy", {}) if isinstance(provenance, dict) else {}
    resolved = policy.get("resolved", policy) if isinstance(policy, dict) else {}
    requested = policy.get("requested", {}) if isinstance(policy, dict) else {}
    if not isinstance(resolved, dict):
        resolved = {}
    if not isinstance(requested, dict):
        requested = {}
    integrator = _first(
        provenance.get("resolved_integrator") if isinstance(provenance, dict) else None,
        provenance.get("integrator") if isinstance(provenance, dict) else None,
        resolved.get("integrator"),
    )
    kind = _first(
        resolved.get("kind"),
        policy.get("kind") if isinstance(policy, dict) else None,
    )
    return {
        "integrator": integrator,
        "timestep_policy": kind,
        "fixed_dt_s": _first(
            resolved.get("timestep_s"),
            resolved.get("fixed_dt"),
            policy.get("fixed_dt") if isinstance(policy, dict) else None,
        ),
        "dt_initial_s": _first(resolved.get("dt_initial_s"), resolved.get("dt_initial")),
        "dt_min_s": _first(resolved.get("dt_min_s"), resolved.get("dt_min")),
        "dt_max_s": _first(resolved.get("dt_max_s"), resolved.get("dt_max")),
        "max_error": _first(
            resolved.get("atol"),
            requested.get("atol"),
            resolved.get("max_error"),
        ),
    }


def _empty_timestep_values() -> dict[str, None]:
    return {
        "integrator": None,
        "timestep_policy": None,
        "fixed_dt_s": None,
        "dt_initial_s": None,
        "dt_min_s": None,
        "dt_max_s": None,
        "max_error": None,
    }


def _validated_timestep_values(
    metadata: dict[str, Any],
    scenario: ScenarioInfo,
) -> dict[str, Any]:
    if scenario.phase == "topology" or scenario.relaxation_algorithm in {
        "projected_gradient_bb",
        "nonlinear_cg",
    }:
        return _empty_timestep_values()
    values = _timestep_values(metadata)
    if values["integrator"] != scenario.integrator:
        raise CollectionError(
            "resolved integrator does not match the scenario: "
            f"{values['integrator']} != {scenario.integrator}"
        )
    if values["timestep_policy"] != scenario.timestep_policy:
        raise CollectionError(
            "resolved timestep policy does not match the scenario: "
            f"{values['timestep_policy']} != {scenario.timestep_policy}"
        )
    return values


def _mixed_topology_certificate_values(
    mesh: dict[str, Any],
    *,
    required: bool,
    runtime_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    empty = {
        "mesh_certificate_status": None,
        "mesh_node_plane_count": None,
        "mesh_magnetic_prism6_count": None,
        "mesh_magnetic_tet4_count": None,
        "mesh_magnetic_pyramid5_count": None,
    }
    report = mesh.get("mesh_build_report")
    certificate = (
        report.get("mixed_layer_topology_certificate")
        if isinstance(report, dict)
        else None
    )
    if not isinstance(certificate, dict):
        if required:
            raise CollectionError("mixed layer topology certificate metadata missing")
        return empty

    planes = certificate.get("magnetic_plane_coordinates_m")
    counts_by_marker = certificate.get("cell_family_counts_by_marker")
    magnetic_counts = counts_by_marker.get("1") if isinstance(counts_by_marker, dict) else None
    if not isinstance(planes, list) or not isinstance(magnetic_counts, dict):
        if required:
            raise CollectionError("mixed layer topology certificate evidence is malformed")
        return empty

    values = {
        "mesh_certificate_status": certificate.get("certificate_status"),
        "mesh_node_plane_count": len(planes),
        "mesh_magnetic_prism6_count": magnetic_counts.get("prism6", 0),
        "mesh_magnetic_tet4_count": magnetic_counts.get("tet4", 0),
        "mesh_magnetic_pyramid5_count": magnetic_counts.get("pyramid5", 0),
    }
    if not required:
        return values

    if report.get("build_mode") != "single_geometry_geo_mixed":
        raise CollectionError("topology smoke requires single_geometry_geo_mixed build evidence")
    if report.get("fallbacks_triggered") != []:
        raise CollectionError("mesh build report fallbacks must be empty")
    if report.get("degraded") is not False:
        raise CollectionError("mesh build report must prove degraded=false")
    if report.get("orphan_entities") != []:
        raise CollectionError("mesh build report must prove no orphan entities")
    try:
        parsed = MixedLayerTopologyCertificate.from_dict(certificate)
    except (TypeError, ValueError) as exc:
        raise CollectionError(f"invalid mixed layer topology certificate: {exc}") from exc

    if parsed.topology_fingerprint != mesh.get("topology_fingerprint"):
        raise CollectionError("mixed layer topology certificate fingerprint differs from mesh")
    if parsed.requested_layer_count != 1 or parsed.realized_layer_count != 1:
        raise CollectionError("topology smoke requires exactly one layer and two magnetic node planes")
    if len(parsed.magnetic_plane_coordinates_m) != 2:
        raise CollectionError("topology smoke requires exactly one layer and two magnetic node planes")
    parsed_magnetic_counts = parsed.cell_family_counts_by_marker.get("1", {})
    if set(parsed_magnetic_counts) != {"prism6"} or parsed_magnetic_counts.get("prism6", 0) <= 0:
        raise CollectionError("topology smoke requires prism6-only magnetic cells")
    if not isinstance(runtime_metadata, dict):
        raise CollectionError("topology smoke runtime metadata is malformed")
    domain_frame = runtime_metadata.get("domain_frame")
    if not isinstance(domain_frame, dict):
        raise CollectionError("topology smoke domain frame metadata is missing")
    magnetic_min = domain_frame.get("object_bounds_min")
    magnetic_max = domain_frame.get("object_bounds_max")
    universe = domain_frame.get("declared_universe")
    if (
        not isinstance(magnetic_min, (list, tuple))
        or not isinstance(magnetic_max, (list, tuple))
        or len(magnetic_min) != 3
        or len(magnetic_max) != 3
        or not isinstance(universe, dict)
    ):
        raise CollectionError("topology smoke authored bounds metadata is missing")
    universe_size = universe.get("size")
    universe_center = universe.get("center")
    if (
        not isinstance(universe_size, (list, tuple))
        or not isinstance(universe_center, (list, tuple))
        or len(universe_size) != 3
        or len(universe_center) != 3
    ):
        raise CollectionError("topology smoke authored airbox metadata is missing")
    try:
        magnetic_min_values = tuple(float(value) for value in magnetic_min)
        magnetic_max_values = tuple(float(value) for value in magnetic_max)
        universe_size_values = tuple(float(value) for value in universe_size)
        universe_center_values = tuple(float(value) for value in universe_center)
    except (TypeError, ValueError) as exc:
        raise CollectionError("topology smoke authored bounds metadata is malformed") from exc
    airbox_min = tuple(
        center - 0.5 * size
        for center, size in zip(universe_center_values, universe_size_values, strict=True)
    )
    airbox_max = tuple(
        center + 0.5 * size
        for center, size in zip(universe_center_values, universe_size_values, strict=True)
    )

    def bounds_match(actual: tuple[float, ...], expected: tuple[float, ...]) -> bool:
        return all(
            math.isclose(left, right, rel_tol=1.0e-8, abs_tol=1.0e-18)
            for left, right in zip(actual, expected, strict=True)
        )

    if not bounds_match(parsed.magnetic_bounds_min_m, magnetic_min_values) or not bounds_match(
        parsed.magnetic_bounds_max_m, magnetic_max_values
    ):
        raise CollectionError("mixed topology magnetic bounds differ from runtime metadata")
    if not bounds_match(parsed.airbox_bounds_min_m, airbox_min) or not bounds_match(
        parsed.airbox_bounds_max_m, airbox_max
    ):
        raise CollectionError("mixed topology airbox bounds differ from runtime metadata")
    magnetic_volume = math.prod(
        maximum - minimum
        for minimum, maximum in zip(magnetic_min_values, magnetic_max_values, strict=True)
    )
    shared_domain_volume = math.prod(universe_size_values)
    air_volume = shared_domain_volume - magnetic_volume
    if not all(
        math.isclose(value, magnetic_volume, rel_tol=1.0e-8, abs_tol=0.0)
        for value in (parsed.magnetic_volume_m3, parsed.expected_magnetic_volume_m3)
    ):
        raise CollectionError("mixed topology magnetic volume differs from runtime metadata")
    if not all(
        math.isclose(value, shared_domain_volume, rel_tol=1.0e-8, abs_tol=0.0)
        for value in (
            parsed.shared_domain_volume_m3,
            parsed.expected_shared_domain_volume_m3,
        )
    ) or not math.isclose(parsed.air_volume_m3, air_volume, rel_tol=1.0e-8, abs_tol=0.0):
        raise CollectionError("mixed topology shared-domain volume differs from runtime metadata")
    provenance = report.get("mixed_topology_provenance")
    if not isinstance(provenance, dict):
        raise CollectionError("mixed topology provenance missing from mesh build report")
    expected_provenance = {
        "requested_topology": "mixed_p1",
        "resolved_topology": "mixed_p1",
        "accepted_certificate_fingerprint": parsed.topology_fingerprint,
        "requested_device": "cpu",
        "precision": "double",
        "capability_status": "implemented",
    }
    for name, expected in expected_provenance.items():
        if provenance.get(name) != expected:
            raise CollectionError(
                f"mixed topology provenance {name} must be {expected!r}"
            )
    return {
        "mesh_certificate_status": parsed.certificate_status,
        "mesh_node_plane_count": len(parsed.magnetic_plane_coordinates_m),
        "mesh_magnetic_prism6_count": parsed_magnetic_counts.get("prism6", 0),
        "mesh_magnetic_tet4_count": parsed_magnetic_counts.get("tet4", 0),
        "mesh_magnetic_pyramid5_count": parsed_magnetic_counts.get("pyramid5", 0),
    }


def _relaxation_qualification(metadata: dict[str, Any]) -> dict[str, Any]:
    for key in (
        "fem_cpu_relaxation_qualification",
        "fem_gpu_relaxation_qualification",
    ):
        value = metadata.get(key)
        if isinstance(value, dict):
            return value
    raise CollectionError("relaxation qualification metadata missing")


def _relaxation_metrics(
    metadata: dict[str, Any],
    rows: list[dict[str, float]],
    scenario: ScenarioInfo,
) -> dict[str, Any]:
    qualification = _relaxation_qualification(metadata)
    algorithm = qualification.get("relaxation_algorithm")
    if algorithm != scenario.relaxation_algorithm:
        raise CollectionError(
            "relaxation algorithm does not match the scenario: "
            f"{algorithm} != {scenario.relaxation_algorithm}"
        )
    if qualification.get("converged") is not True:
        raise CollectionError("relaxation did not converge")

    try:
        final_torque_t = float(qualification["final_torque_t"])
    except (KeyError, TypeError, ValueError) as exc:
        raise CollectionError("relaxation final torque metadata missing") from exc
    if not math.isfinite(final_torque_t):
        raise CollectionError("relaxation final torque is non-finite")
    if final_torque_t > RELAXATION_TORQUE_LIMIT_T:
        raise CollectionError(
            "relaxation torque exceeds the SP4 limit: "
            f"{final_torque_t:.17g} > {RELAXATION_TORQUE_LIMIT_T:.17g} T"
        )

    energies = [row["E_total"] for row in rows]
    increases = [right - left for left, right in zip(energies, energies[1:])]
    max_increase = max([0.0, *increases])
    energy_scale = max(max(abs(value) for value in energies), 1e-30)
    energy_budget = 1e-10 * energy_scale
    if max_increase > energy_budget:
        raise CollectionError(
            "relaxation energy increased beyond the numerical budget: "
            f"{max_increase:.17g} > {energy_budget:.17g} J"
        )

    return {
        "relaxation_converged": True,
        "relaxation_stop_reason": qualification.get("stop_reason"),
        "relaxation_stop_metric": qualification.get("stop_metric_name"),
        "relaxation_stop_value": qualification.get("stop_metric_value"),
        "relaxation_stop_threshold": qualification.get("stop_threshold"),
        "relaxation_torque_limit_T": RELAXATION_TORQUE_LIMIT_T,
        "initial_E_total_J": energies[0],
        "energy_drop_J": energies[0] - energies[-1],
        "max_energy_increase_J": max_increase,
        "final_E_total_J": energies[-1],
        "final_max_torque_T": final_torque_t,
    }


def _wall_time(metadata: dict[str, Any], artifacts: Path) -> Any:
    direct = metadata.get("wall_time_s")
    if direct is not None:
        return direct
    receipt = artifacts.parent / "run_receipt.json"
    if receipt.is_file():
        try:
            value = json.loads(receipt.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise CollectionError(f"invalid run receipt JSON: {receipt}: {exc}") from exc
        if isinstance(value, dict):
            return value.get("wall_time_s")
    return None


def _existing_rows(ledger: Path) -> list[dict[str, str]]:
    if not ledger.exists():
        return []
    with ledger.open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        schema = tuple(reader.fieldnames or ())
        rows = list(reader)
    if schema == FIELDNAMES:
        return rows
    if schema == _LEGACY_FIELDNAMES:
        return [{name: row.get(name, "") for name in FIELDNAMES} for row in rows]
    raise CollectionError("existing ledger schema does not match the SP4 schema")


def _resolve_artifacts(path: Path) -> Path:
    path = Path(path)
    if (path / "metadata.json").is_file():
        return path
    bundled = path / "artifacts"
    if (bundled / "metadata.json").is_file():
        return bundled
    return path


def _append_atomic(ledger: Path, row: dict[str, str]) -> None:
    ledger.parent.mkdir(parents=True, exist_ok=True)
    existing = _existing_rows(ledger)
    if any(item["attempt_id"] == row["attempt_id"] for item in existing):
        raise CollectionError(f"attempt ID already exists: {row['attempt_id']}")
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            newline="",
            encoding="utf-8",
            dir=ledger.parent,
            prefix=f".{ledger.name}.",
            delete=False,
        ) as stream:
            temporary = Path(stream.name)
            writer = csv.DictWriter(stream, fieldnames=FIELDNAMES, lineterminator="\n")
            writer.writeheader()
            writer.writerows(existing)
            writer.writerow(row)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, ledger)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def collect_attempt(
    artifacts: Path,
    ledger: Path,
    *,
    scenario: str,
    attempt_id: str,
) -> dict[str, str]:
    """Validate application artifacts and append one completed attempt."""

    if not attempt_id.strip():
        raise CollectionError("attempt ID must not be empty")
    scenario_info = _scenario_info(scenario)
    artifacts = _resolve_artifacts(Path(artifacts))
    metadata_path = artifacts / "metadata.json"
    metadata = _json(metadata_path)
    scalars_path = artifacts / "scalars.csv"
    rows = (
        []
        if scenario_info.phase == "topology"
        else _read_scalars(scalars_path, scenario=scenario_info)
    )

    requested = metadata.get("requested_execution", {})
    provenance = metadata.get("execution_provenance", {})
    demag = metadata.get("demag_runtime", {})
    mesh = metadata.get("mesh", {})
    if not all(isinstance(item, dict) for item in (requested, provenance, demag, mesh)):
        raise CollectionError("metadata execution, demag, or mesh section is malformed")
    timestep = _validated_timestep_values(metadata, scenario_info)
    runtime = _nested(metadata, "problem_meta", "runtime_metadata", default={})
    airbox = _nested(runtime, "domain_frame", "declared_universe", "size", default=(None, None, None))
    per_geometry = _nested(runtime, "mesh_workflow", "per_geometry", default=[])
    magnetic_mesh = per_geometry[0] if isinstance(per_geometry, list) and per_geometry else {}
    if not isinstance(airbox, (list, tuple)) or len(airbox) != 3:
        airbox = (None, None, None)
    if not isinstance(magnetic_mesh, dict):
        magnetic_mesh = {}
    topology_certificate = _mixed_topology_certificate_values(
        mesh,
        required=scenario_info.phase == "topology",
        runtime_metadata=runtime if isinstance(runtime, dict) else None,
    )
    final = rows[-1] if rows else {}
    direct_minimizer = scenario_info.relaxation_algorithm in {
        "projected_gradient_bb",
        "nonlinear_cg",
    }

    phase_metrics: dict[str, Any]
    if scenario_info.phase == "topology":
        phase_metrics = {}
    elif scenario_info.phase == "dynamics":
        trace = Trajectory(
            np.asarray([item["time"] for item in rows], dtype=float),
            np.asarray(
                [[item["mx"], item["my"], item["mz"]] for item in rows],
                dtype=float,
            ),
            str(scalars_path),
        )
        try:
            crossing = find_first_zero_crossing(trace)
            reference = _reference_metrics(str(scenario_info.case), trace)
        except ValueError as exc:
            raise CollectionError(str(exc)) from exc
        rmse = reference["nist_rmse"]
        envelope = reference["nist_envelope_rms"]
        phase_metrics = {
            "crossing_time_s": crossing,
            "nist_crossing_min_s": reference["nist_crossing_min_s"],
            "nist_crossing_max_s": reference["nist_crossing_max_s"],
            "nist_rmse_mx": rmse[0],
            "nist_rmse_my": rmse[1],
            "nist_rmse_mz": rmse[2],
            "nist_envelope_rms_mx": envelope[0],
            "nist_envelope_rms_my": envelope[1],
            "nist_envelope_rms_mz": envelope[2],
            "final_E_total_J": final["E_total"],
            "final_max_torque_T": final["max_torque_T"],
        }
    else:
        phase_metrics = _relaxation_metrics(metadata, rows, scenario_info)

    values: dict[str, Any] = {
        "attempt_id": attempt_id,
        "collected_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "phase": scenario_info.phase,
        "scenario": scenario,
        "case": scenario_info.case,
        "relaxation_algorithm": scenario_info.relaxation_algorithm,
        **timestep,
        "requested_device": requested.get("device"),
        "execution_engine": provenance.get("execution_engine"),
        "precision": _first(provenance.get("precision"), requested.get("precision")),
        "execution_mode": requested.get("mode"),
        "fallback_used": provenance.get("lossy_fallback_used"),
        "demag_realization": _first(
            provenance.get("resolved_demag_realization"),
            demag.get("realization"),
        ),
        "demag_operator_mode": _first(
            provenance.get("fem_demag_operator_mode"),
            demag.get("operator_mode"),
        ),
        "demag_iterations": demag.get("actual_iterations"),
        "demag_final_residual": demag.get("final_residual_norm"),
        "mesh_topology_fingerprint": mesh.get("topology_fingerprint"),
        "mesh_node_count": mesh.get("node_count"),
        "mesh_element_count": mesh.get("element_count"),
        **topology_certificate,
        "airbox_x_m": airbox[0],
        "airbox_y_m": airbox[1],
        "airbox_z_m": airbox[2],
        "magnetic_hmax_m": _first(
            magnetic_mesh.get("maximum_element_size"),
            magnetic_mesh.get("hmax"),
        ),
        "film_layers": magnetic_mesh.get("through_thickness_elements"),
        "sample_count": len(rows) if rows else None,
        "step_start": rows[0].get("step") if rows else None,
        "step_stop": final.get("step"),
        "time_start_s": None if direct_minimizer or not rows else rows[0]["time"],
        "time_stop_s": None if direct_minimizer or not rows else final["time"],
        "final_mx": final.get("mx"),
        "final_my": final.get("my"),
        "final_mz": final.get("mz"),
        **phase_metrics,
        "wall_time_s": _wall_time(metadata, artifacts),
        "status": metadata.get("status", "completed"),
        "failure_category": "",
        "failure_detail": "",
        "artifact_dir": str(artifacts.resolve()),
        "metadata_sha256": _sha256(metadata_path),
        "scalars_sha256": _sha256(scalars_path) if rows else None,
    }
    row = {name: _cell(values.get(name)) for name in FIELDNAMES}
    _append_atomic(Path(ledger), row)
    return row


def record_failed_attempt(
    ledger: Path,
    *,
    scenario: str,
    attempt_id: str,
    requested_device: str,
    category: str,
    detail: str,
    wall_time_s: float | None = None,
    artifact_dir: Path | None = None,
) -> dict[str, str]:
    """Append an execution/artifact failure without inventing physics metrics."""

    if not attempt_id.strip():
        raise CollectionError("attempt ID must not be empty")
    scenario_info = _scenario_info(scenario)
    if requested_device not in {"cpu", "gpu"}:
        raise CollectionError("requested device must be cpu or gpu")
    if category not in {
        "execution_failure",
        "artifact_failure",
        "convergence_failure",
        "physics_failure",
    }:
        raise CollectionError(f"unsupported failure category: {category}")
    if not detail.strip():
        raise CollectionError("failure detail must not be empty")
    values: dict[str, Any] = {
        "attempt_id": attempt_id,
        "collected_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "phase": scenario_info.phase,
        "scenario": scenario,
        "case": scenario_info.case,
        "relaxation_algorithm": scenario_info.relaxation_algorithm,
        "integrator": scenario_info.integrator,
        "timestep_policy": scenario_info.timestep_policy,
        "requested_device": requested_device,
        "wall_time_s": wall_time_s,
        "status": category,
        "failure_category": category,
        "failure_detail": detail,
        "artifact_dir": str(Path(artifact_dir).resolve()) if artifact_dir else "",
    }
    row = {name: _cell(values.get(name)) for name in FIELDNAMES}
    _append_atomic(Path(ledger), row)
    return row


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--attempt-id", required=True)
    parser.add_argument("--failure-category")
    parser.add_argument("--failure-detail")
    parser.add_argument("--requested-device", choices=("cpu", "gpu"))
    parser.add_argument("--wall-time-s", type=float)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.failure_category is not None:
            if args.requested_device is None or args.failure_detail is None:
                raise CollectionError(
                    "failure recording requires --requested-device and --failure-detail"
                )
            row = record_failed_attempt(
                args.ledger,
                scenario=args.scenario,
                attempt_id=args.attempt_id,
                requested_device=args.requested_device,
                category=args.failure_category,
                detail=args.failure_detail,
                wall_time_s=args.wall_time_s,
                artifact_dir=args.artifacts,
            )
        else:
            if args.artifacts is None:
                raise CollectionError("completed collection requires --artifacts")
            row = collect_attempt(
                args.artifacts,
                args.ledger,
                scenario=args.scenario,
                attempt_id=args.attempt_id,
            )
    except CollectionError as exc:
        raise SystemExit(f"SP4 collection failed: {exc}") from exc
    print(json.dumps(row, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
