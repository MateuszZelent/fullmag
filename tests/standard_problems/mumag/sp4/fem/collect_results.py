"""Append one immutable Fullmag SP4 application attempt to a CSV ledger."""

from __future__ import annotations

import argparse
import csv
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
    "scenario",
    "case",
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

_SCENARIO = re.compile(
    r"^(case_[ab])_(heun|rk23|rk4|rk45)_(fixed|adaptive)(?:_[a-z0-9_]+)?$"
)


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


def _read_scalars(path: Path) -> tuple[list[str], list[dict[str, float]]]:
    try:
        stream = path.open(newline="", encoding="utf-8")
    except FileNotFoundError as exc:
        raise CollectionError(f"missing scalar artifact: {path}") from exc
    with stream:
        reader = csv.DictReader(stream)
        fieldnames = list(reader.fieldnames or ())
        required = {"time", "mx", "my", "mz", "E_total", "max_torque_T"}
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
    times = [row["time"] for row in rows]
    if any(right <= left for left, right in zip(times, times[1:])):
        raise CollectionError("scalar time must be strictly increasing")
    return fieldnames, rows


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


def _scenario_parts(scenario: str) -> tuple[str, str, str]:
    match = _SCENARIO.fullmatch(scenario)
    if match is None:
        raise CollectionError(f"unsupported SP4 scenario name: {scenario}")
    return match.group(1), match.group(2), match.group(3)


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


def _timestep_values(
    metadata: dict[str, Any],
    name_integrator: str,
    name_policy: str,
) -> dict[str, Any]:
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
        name_integrator,
    )
    kind = _first(resolved.get("kind"), policy.get("kind") if isinstance(policy, dict) else None, name_policy)
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
        if tuple(reader.fieldnames or ()) != FIELDNAMES:
            raise CollectionError("existing ledger schema does not match the SP4 schema")
        return list(reader)


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
    case, name_integrator, name_policy = _scenario_parts(scenario)
    artifacts = _resolve_artifacts(Path(artifacts))
    metadata_path = artifacts / "metadata.json"
    scalars_path = artifacts / "scalars.csv"
    metadata = _json(metadata_path)
    _, rows = _read_scalars(scalars_path)

    trace = Trajectory(
        np.asarray([item["time"] for item in rows], dtype=float),
        np.asarray([[item["mx"], item["my"], item["mz"]] for item in rows], dtype=float),
        str(scalars_path),
    )
    try:
        crossing = find_first_zero_crossing(trace)
        reference = _reference_metrics(case, trace)
    except ValueError as exc:
        raise CollectionError(str(exc)) from exc

    requested = metadata.get("requested_execution", {})
    provenance = metadata.get("execution_provenance", {})
    demag = metadata.get("demag_runtime", {})
    mesh = metadata.get("mesh", {})
    if not all(isinstance(item, dict) for item in (requested, provenance, demag, mesh)):
        raise CollectionError("metadata execution, demag, or mesh section is malformed")
    timestep = _timestep_values(metadata, name_integrator, name_policy)
    runtime = _nested(metadata, "problem_meta", "runtime_metadata", default={})
    airbox = _nested(runtime, "domain_frame", "declared_universe", "size", default=(None, None, None))
    per_geometry = _nested(runtime, "mesh_workflow", "per_geometry", default=[])
    magnetic_mesh = per_geometry[0] if isinstance(per_geometry, list) and per_geometry else {}
    if not isinstance(airbox, (list, tuple)) or len(airbox) != 3:
        airbox = (None, None, None)
    if not isinstance(magnetic_mesh, dict):
        magnetic_mesh = {}
    rmse = reference["nist_rmse"]
    envelope = reference["nist_envelope_rms"]
    final = rows[-1]

    values: dict[str, Any] = {
        "attempt_id": attempt_id,
        "collected_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "scenario": scenario,
        "case": case,
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
        "airbox_x_m": airbox[0],
        "airbox_y_m": airbox[1],
        "airbox_z_m": airbox[2],
        "magnetic_hmax_m": _first(
            magnetic_mesh.get("maximum_element_size"),
            magnetic_mesh.get("hmax"),
        ),
        "film_layers": magnetic_mesh.get("through_thickness_elements"),
        "sample_count": len(rows),
        "time_start_s": rows[0]["time"],
        "time_stop_s": final["time"],
        "crossing_time_s": crossing,
        "nist_crossing_min_s": reference["nist_crossing_min_s"],
        "nist_crossing_max_s": reference["nist_crossing_max_s"],
        "nist_rmse_mx": rmse[0],
        "nist_rmse_my": rmse[1],
        "nist_rmse_mz": rmse[2],
        "nist_envelope_rms_mx": envelope[0],
        "nist_envelope_rms_my": envelope[1],
        "nist_envelope_rms_mz": envelope[2],
        "final_mx": final["mx"],
        "final_my": final["my"],
        "final_mz": final["mz"],
        "final_E_total_J": final["E_total"],
        "final_max_torque_T": final["max_torque_T"],
        "wall_time_s": _wall_time(metadata, artifacts),
        "status": metadata.get("status", "completed"),
        "failure_category": "",
        "failure_detail": "",
        "artifact_dir": str(artifacts.resolve()),
        "metadata_sha256": _sha256(metadata_path),
        "scalars_sha256": _sha256(scalars_path),
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
    case, integrator, timestep_policy = _scenario_parts(scenario)
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
        "scenario": scenario,
        "case": case,
        "integrator": integrator,
        "timestep_policy": timestep_policy,
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
