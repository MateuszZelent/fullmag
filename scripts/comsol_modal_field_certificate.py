#!/usr/bin/env python3
"""Independent certificate for exported complex Bloch modal vector fields.

The native publisher writes vector.bin as little-endian float64 values in
AoS order [real_x, imag_x, real_y, imag_y, real_z, imag_z] for every node in
full mesh node order. This checker reads those bytes and verifies

    u[node_b] = exp(-i * dot(k, R)) * u[node_a].

A declared digest, phase digest, or solver residual is never accepted as a
substitute for inspecting the actual vector field. The public function
validate_modal_field_certificate accepts explicit (sample_index, raw_mode_index)
selections so a gate can validate only its branch-table witnesses.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import stat
import struct
from typing import Any, Mapping, Sequence


CERTIFICATE_SCHEMA = "fullmag.comsol-modal-field-certificate.v1"
DEFAULT_PHASE_TOLERANCE = 1.0e-8
DEFAULT_GEOMETRY_ABS_TOLERANCE_M = 1.0e-12
DEFAULT_GEOMETRY_REL_TOLERANCE = 1.0e-8
CANONICAL_PHASE_CONVENTION = "exp_minus_i_k_dot_delta_r"
EXPECTED_PAYLOAD_ENCODING = "f64_interleaved_real_imag_xyz"
EXPECTED_BINARY_LAYOUT = "complex_f64_pairs_little_endian"
EXPECTED_INDEXING = "full_domain_node_order"
EXPECTED_COMPONENT_BASIS = "global_xyz"


def _finite(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_reparse(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & 0x400
    )


def _regular_file(path: Path) -> bool:
    try:
        return path.is_file() and not _is_reparse(path)
    except OSError:
        return False


def _regular_directory(path: Path) -> bool:
    try:
        return path.is_dir() and not _is_reparse(path)
    except OSError:
        return False


def _sha256_bytes(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def _file_record(path: Path, data: bytes, case_dir: Path) -> dict[str, Any]:
    try:
        relative = path.relative_to(case_dir).as_posix()
    except ValueError:
        relative = str(path)
    return {"path": relative, "size_bytes": len(data), "sha256": _sha256_bytes(data)}


def _safe_relative_path(
    root: Path, raw: object, label: str, reasons: list[str]
) -> Path | None:
    if not isinstance(raw, str) or not raw or "\\" in raw or "\x00" in raw:
        reasons.append(f"{label} is not a canonical relative POSIX path")
        return None
    relative = PurePosixPath(raw)
    if (
        relative.is_absolute()
        or relative.as_posix() != raw
        or any(part in {"", ".", ".."} for part in raw.split("/"))
    ):
        reasons.append(f"{label} is not a canonical relative POSIX path")
        return None
    candidate = root
    for part in relative.parts:
        candidate /= part
        if candidate.exists() and _is_reparse(candidate):
            reasons.append(f"{label} traverses a reparse point")
            return None
    return candidate


def _read_json(
    path: Path,
    *,
    label: str,
    case_dir: Path,
    file_hashes: dict[str, dict[str, Any]],
    reasons: list[str],
) -> dict[str, Any] | None:
    if not _regular_file(path):
        reasons.append(f"{label} is missing or is not a regular file: {path}")
        return None
    try:
        data = path.read_bytes()
    except OSError as error:
        reasons.append(f"{label} cannot be read: {error}")
        return None
    record = _file_record(path, data, case_dir)
    file_hashes[record["path"]] = record
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeError, ValueError) as error:
        reasons.append(f"{label} is not valid UTF-8 JSON: {error}")
        return None
    if not isinstance(value, dict):
        reasons.append(f"{label} JSON root must be an object")
        return None
    return value


def _read_bytes(
    path: Path,
    *,
    label: str,
    case_dir: Path,
    file_hashes: dict[str, dict[str, Any]],
    reasons: list[str],
) -> bytes | None:
    if not _regular_file(path):
        reasons.append(f"{label} is missing or is not a regular file: {path}")
        return None
    try:
        data = path.read_bytes()
    except OSError as error:
        reasons.append(f"{label} cannot be read: {error}")
        return None
    record = _file_record(path, data, case_dir)
    file_hashes[record["path"]] = record
    return data


def _vec3(value: object, label: str, reasons: list[str]) -> tuple[float, float, float] | None:
    if not isinstance(value, list) or len(value) != 3 or not all(_finite(item) for item in value):
        reasons.append(f"{label} must be a finite length-3 vector")
        return None
    return tuple(float(item) for item in value)  # type: ignore[return-value]


def _nonnegative_int(mapping: Mapping[str, Any], key: str, label: str, reasons: list[str]) -> int | None:
    value = mapping.get(key)
    if not _integer(value) or int(value) < 0:
        reasons.append(f"{label}.{key} must be a non-negative integer")
        return None
    return int(value)


def _discover_mode_paths(case_dir: Path, reasons: list[str]) -> list[Path]:
    root = case_dir / "eigen" / "modes"
    if not _regular_directory(root):
        reasons.append(f"modal metadata directory is missing: {root}")
        return []
    paths: list[Path] = []
    try:
        sample_dirs = sorted(root.iterdir(), key=lambda path: path.name)
    except OSError as error:
        reasons.append(f"modal metadata directory cannot be enumerated: {error}")
        return []
    for sample_dir in sample_dirs:
        if not sample_dir.name.startswith("sample_"):
            continue
        if not _regular_directory(sample_dir):
            reasons.append(f"modal sample directory is missing or unsafe: {sample_dir}")
            continue
        try:
            paths.extend(
                sorted(
                    (
                        path
                        for path in sample_dir.iterdir()
                        if path.name.startswith("mode_")
                        and path.suffix == ".json"
                        and _regular_file(path)
                    ),
                    key=lambda path: path.name,
                )
            )
        except OSError as error:
            reasons.append(f"modal sample directory cannot be enumerated: {error}")
    if not paths:
        reasons.append("no published mode metadata found under eigen/modes/sample_*/mode_*.json")
    return paths


def _normalize_selections(
    selections: Sequence[object] | None, reasons: list[str]
) -> list[tuple[int, int]] | None:
    if selections is None:
        return None
    normalized: list[tuple[int, int]] = []
    for index, raw in enumerate(selections):
        sample: object
        mode: object
        if isinstance(raw, Mapping):
            sample = raw.get("sample_index")
            mode = raw.get("raw_mode_index")
        elif isinstance(raw, Sequence) and not isinstance(raw, (str, bytes)) and len(raw) == 2:
            sample, mode = raw[0], raw[1]
        else:
            reasons.append(
                f"mode_selections[{index}] must be (sample_index, raw_mode_index) or an object with those keys"
            )
            continue
        if not _integer(sample) or int(sample) < 0 or not _integer(mode) or int(mode) < 0:
            reasons.append(f"mode_selections[{index}] contains invalid non-negative indices")
            continue
        pair = (int(sample), int(mode))
        if pair in normalized:
            reasons.append(f"mode_selections contains duplicate selection {pair}")
        else:
            normalized.append(pair)
    if not normalized:
        reasons.append("mode_selections must contain at least one selection")
    return normalized


def _selected_mode_paths(
    case_dir: Path,
    selections: list[tuple[int, int]] | None,
    reasons: list[str],
) -> tuple[list[tuple[Path, tuple[int, int] | None]], str]:
    if selections is None:
        return [(path, None) for path in _discover_mode_paths(case_dir, reasons)], "discovered_all"
    paths: list[tuple[Path, tuple[int, int] | None]] = []
    for sample_index, raw_mode_index in selections:
        path = (
            case_dir
            / "eigen"
            / "modes"
            / f"sample_{sample_index:04d}"
            / f"mode_{raw_mode_index:04d}.json"
        )
        if not _regular_file(path):
            reasons.append(
                f"selected mode ({sample_index}, {raw_mode_index}) metadata is missing: {path}"
            )
        else:
            paths.append((path, (sample_index, raw_mode_index)))
    return paths, "explicit"


def _spin_wave_contract(
    backend_plan: Mapping[str, Any],
    node_pair_ids: Sequence[str],
    reasons: list[str],
) -> tuple[str | None, list[str], str | None]:
    raw = backend_plan.get("spin_wave_bc")
    kind: str | None = None
    phase_convention: str | None = None
    requested: list[str] = []
    explicit_pairs = isinstance(raw, Mapping) and "pair_ids" in raw
    if isinstance(raw, str):
        kind = raw
    elif isinstance(raw, Mapping):
        if isinstance(raw.get("kind"), str):
            kind = raw["kind"]
        raw_phase = raw.get("phase_convention")
        if raw_phase is None:
            phase_convention = CANONICAL_PHASE_CONVENTION
        elif isinstance(raw_phase, str) and raw_phase == CANONICAL_PHASE_CONVENTION:
            phase_convention = raw_phase
        else:
            reasons.append(
                "backend_plan.spin_wave_bc.phase_convention must be "
                f"{CANONICAL_PHASE_CONVENTION!r} when present"
            )
        pair_ids = raw.get("pair_ids")
        if explicit_pairs:
            if not isinstance(pair_ids, list) or not pair_ids or not all(
                isinstance(item, str) and item for item in pair_ids
            ):
                reasons.append("backend_plan.spin_wave_bc.pair_ids must be non-empty strings")
            else:
                requested.extend(pair_ids)
        if not explicit_pairs and not requested and raw.get("boundary_pair_id") is not None:
            boundary_id = raw["boundary_pair_id"]
            if not isinstance(boundary_id, str) or not boundary_id:
                reasons.append("backend_plan.spin_wave_bc.boundary_pair_id is invalid")
            else:
                requested.append(boundary_id)
    else:
        reasons.append("backend_plan.spin_wave_bc is missing or malformed")
        phase_convention = CANONICAL_PHASE_CONVENTION
    if phase_convention is None:
        phase_convention = CANONICAL_PHASE_CONVENTION
    if kind not in {"periodic", "floquet"}:
        reasons.append("modal field certificate requires spin_wave_bc.kind periodic or floquet")
    if len(set(requested)) != len(requested):
        reasons.append("backend_plan.spin_wave_bc contains duplicate pair IDs")
    if not explicit_pairs and not requested:
        requested = list(dict.fromkeys(node_pair_ids))
    return kind, requested, phase_convention


def _pair_contract(
    backend_plan: Mapping[str, Any],
    node_count: int,
    reasons: list[str],
) -> dict[str, Any]:
    mesh = backend_plan.get("mesh")
    if not isinstance(mesh, Mapping):
        reasons.append("backend_plan.mesh is missing or malformed")
        return {"selected_pairs": [], "requested_pair_ids": [], "node_pair_ids": [], "boundary_pair_ids": [], "missing_pair_ids": []}
    if not isinstance(mesh.get("nodes"), list) or len(mesh["nodes"]) != node_count:
        reasons.append("backend_plan.mesh.nodes does not match full mesh node count")
    node_coordinates: list[tuple[float, float, float] | None] = []
    raw_mesh_nodes = mesh.get("nodes")
    if isinstance(raw_mesh_nodes, list):
        for index, raw_node in enumerate(raw_mesh_nodes):
            node_coordinates.append(
                _vec3(raw_node, f"backend_plan.mesh.nodes[{index}]", reasons)
            )
    raw_nodes = mesh.get("periodic_node_pairs")
    raw_boundaries = mesh.get("periodic_boundary_pairs")
    if not isinstance(raw_nodes, list):
        reasons.append("backend_plan.mesh.periodic_node_pairs is missing or malformed")
        raw_nodes = []
    if not isinstance(raw_boundaries, list):
        reasons.append("backend_plan.mesh.periodic_boundary_pairs is missing or malformed")
        raw_boundaries = []

    by_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    node_ids: list[str] = []
    for index, raw in enumerate(raw_nodes):
        label = f"backend_plan.mesh.periodic_node_pairs[{index}]"
        if not isinstance(raw, Mapping):
            reasons.append(f"{label} must be an object")
            continue
        pair_id = raw.get("pair_id")
        a, b = raw.get("node_a"), raw.get("node_b")
        if (
            not isinstance(pair_id, str)
            or not pair_id
            or not _integer(a)
            or not _integer(b)
            or int(a) < 0
            or int(b) < 0
            or int(a) >= node_count
            or int(b) >= node_count
            or int(a) == int(b)
        ):
            reasons.append(f"{label} has invalid pair_id or node endpoints")
            continue
        pair = {"pair_id": pair_id, "node_a": int(a), "node_b": int(b)}
        by_id[pair_id].append(pair)
        if pair_id not in node_ids:
            node_ids.append(pair_id)

    boundary_by_id: dict[str, tuple[float, float, float]] = {}
    boundary_ids: list[str] = []
    for index, raw in enumerate(raw_boundaries):
        label = f"backend_plan.mesh.periodic_boundary_pairs[{index}]"
        if not isinstance(raw, Mapping) or not isinstance(raw.get("pair_id"), str) or not raw["pair_id"]:
            reasons.append(f"{label} has invalid pair_id")
            continue
        pair_id = raw["pair_id"]
        translation = _vec3(raw.get("translation"), f"{label}.translation", reasons)
        if translation is None:
            continue
        if not any(item != 0.0 for item in translation):
            reasons.append(f"{label}.translation must be non-zero")
        if pair_id in boundary_by_id:
            reasons.append(f"duplicate periodic boundary pair_id {pair_id!r}")
            continue
        boundary_by_id[pair_id] = translation
        boundary_ids.append(pair_id)

    kind, requested, phase_convention = _spin_wave_contract(backend_plan, node_ids, reasons)
    missing_nodes = sorted(set(requested) - set(by_id))
    missing_boundaries = sorted(set(requested) - set(boundary_by_id))
    if missing_nodes:
        reasons.append("requested pair IDs absent from periodic_node_pairs: " + ", ".join(missing_nodes))
    if missing_boundaries:
        reasons.append("requested pair IDs absent from periodic_boundary_pairs: " + ", ".join(missing_boundaries))

    selected: list[dict[str, Any]] = []
    for pair_id in requested:
        translation = boundary_by_id.get(pair_id)
        if translation is None:
            continue
        selected.extend({**pair, "translation": translation} for pair in by_id[pair_id])
    for pair in selected:
        a, b = pair["node_a"], pair["node_b"]
        source = node_coordinates[a] if a < len(node_coordinates) else None
        destination = node_coordinates[b] if b < len(node_coordinates) else None
        if source is None or destination is None:
            pair["geometry_status"] = "unavailable"
            continue
        delta = tuple(destination[index] - source[index] for index in range(3))
        translation = tuple(float(item) for item in pair["translation"])
        residual = max(abs(delta[index] - translation[index]) for index in range(3))
        scale = max(
            1.0e-30,
            *(abs(item) for item in (*delta, *translation)),
        )
        tolerance = DEFAULT_GEOMETRY_ABS_TOLERANCE_M + (
            DEFAULT_GEOMETRY_REL_TOLERANCE * scale
        )
        pair.update(
            {
                "geometry_delta_m": list(delta),
                "geometry_residual_m": residual,
                "geometry_tolerance_m": tolerance,
                "geometry_status": "pass" if residual <= tolerance else "fail",
            }
        )
        if residual > tolerance:
            reasons.append(
                f"pair {pair['pair_id']} node coordinate delta does not match translation "
                f"(residual {residual:.6g} m > tolerance {tolerance:.6g} m)"
            )
    if not selected:
        reasons.append("no requested periodic node pairs are available for phase validation")
    return {
        "kind": kind,
        "phase_convention": phase_convention,
        "requested_pair_ids": requested,
        "node_pair_ids": node_ids,
        "boundary_pair_ids": boundary_ids,
        "missing_pair_ids": sorted(set(missing_nodes) | set(missing_boundaries)),
        "selected_pairs": selected,
    }


def _pair_report(contract: Mapping[str, Any]) -> dict[str, Any]:
    selected = contract.get("selected_pairs", [])
    return {
        "kind": contract.get("kind"),
        "requested_pair_ids": list(contract.get("requested_pair_ids", [])),
        "node_pair_ids": list(contract.get("node_pair_ids", [])),
        "boundary_pair_ids": list(contract.get("boundary_pair_ids", [])),
        "missing_pair_ids": list(contract.get("missing_pair_ids", [])),
        "selected_pair_count": len(selected) if isinstance(selected, list) else 0,
        "selected_pairs": [
            {
                "pair_id": item["pair_id"],
                "node_a": item["node_a"],
                "node_b": item["node_b"],
                "translation_m": list(item["translation"]),
                "geometry_delta_m": list(item.get("geometry_delta_m", [])),
                "geometry_residual_m": item.get("geometry_residual_m"),
                "geometry_tolerance_m": item.get("geometry_tolerance_m"),
                "geometry_status": item.get("geometry_status"),
            }
            for item in selected
            if isinstance(item, Mapping)
        ],
    }


def _payload_path(
    mode: Mapping[str, Any], label: str, node_count: int, reasons: list[str]
) -> str | None:
    for key, expected in (
        ("payload_encoding", EXPECTED_PAYLOAD_ENCODING),
        ("binary_layout", EXPECTED_BINARY_LAYOUT),
        ("component_basis", EXPECTED_COMPONENT_BASIS),
    ):
        if mode.get(key) != expected:
            reasons.append(f"{label}.{key} must be {expected!r}")
    identity = mode.get("source_mesh_identity")
    if not isinstance(identity, Mapping) or identity.get("indexing") != EXPECTED_INDEXING:
        reasons.append(f"{label}.source_mesh_identity.indexing must be {EXPECTED_INDEXING!r}")
    if not isinstance(identity, Mapping) or identity.get("node_count") != node_count:
        reasons.append(f"{label}.source_mesh_identity.node_count must equal {node_count}")
    if mode.get("mode_field_sample_count") != node_count:
        reasons.append(f"{label}.mode_field_sample_count must equal {node_count}")
    if mode.get("complex_pair_count") not in (None, node_count * 3):
        reasons.append(f"{label}.complex_pair_count must equal {node_count * 3}")
    if mode.get("payload_value_count") not in (None, node_count * 6):
        reasons.append(f"{label}.payload_value_count must equal {node_count * 6}")
    path = mode.get("compatibility_binary_payload_path")
    if not isinstance(path, str) or not path.endswith("/vector.bin"):
        reasons.append(f"{label}.compatibility_binary_payload_path must name vector.bin")
        return None
    return path


def _validate_mode(
    path: Path,
    mode: Mapping[str, Any],
    *,
    case_dir: Path,
    expected_selection: tuple[int, int] | None,
    node_count: int,
    contract: Mapping[str, Any],
    phase_tolerance: float,
    hashes: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    label = path.as_posix()
    local: list[str] = []
    relative = path.relative_to(case_dir).as_posix()
    report: dict[str, Any] = {"metadata_path": relative, "status": "fail", "reasons": local, "phase_checks": []}
    for key in ("frequency_real_hz", "frequency_imag_hz", "source_mesh_topology_sha256"):
        report[key] = mode.get(key)
    sample = _nonnegative_int(mode, "sample_index", label, local)
    raw_mode = _nonnegative_int(mode, "raw_mode_index", label, local)
    if sample is not None:
        report["sample_index"] = sample
    if raw_mode is not None:
        report["raw_mode_index"] = raw_mode
    if expected_selection is not None and (sample, raw_mode) != expected_selection:
        local.append(f"{label} metadata identity does not match selected {expected_selection}")
    k = _vec3(mode.get("k_vector"), f"{label}.k_vector", local)
    if k is not None:
        report["k_vector_rad_per_m"] = list(k)

    relative_payload = _payload_path(mode, label, node_count, local)
    if sample is not None and raw_mode is not None:
        expected_metadata = f"eigen/modes/sample_{sample:04d}/mode_{raw_mode:04d}.json"
        expected_payload = f"eigen/mode_fields/sample_{sample:04d}/mode_{raw_mode:04d}/vector.bin"
        if relative != expected_metadata:
            local.append(f"{label} metadata path does not match its sample/raw mode identity")
        if relative_payload != expected_payload:
            local.append(f"{label} payload path does not match its sample/raw mode identity")
            relative_payload = None
    payload_path = (
        _safe_relative_path(case_dir, relative_payload, f"{label}.payload_path", local)
        if relative_payload is not None
        else None
    )
    expected_bytes = node_count * 6 * struct.calcsize("<d")
    data = (
        _read_bytes(payload_path, label=f"{label}.vector.bin", case_dir=case_dir, file_hashes=hashes, reasons=local)
        if payload_path is not None
        else None
    )
    vectors: list[tuple[complex, complex, complex]] = []
    if data is not None:
        actual = _file_record(payload_path, data, case_dir)
        report.update({"vector_path": actual["path"], "vector_size_bytes": len(data), "vector_sha256": actual["sha256"]})
        if len(data) != expected_bytes:
            local.append(f"{label}.vector.bin length {len(data)} does not equal expected {expected_bytes}")
        if mode.get("payload_sha256") != actual["sha256"]:
            local.append(f"{label}.payload_sha256 does not match actual vector.bin bytes")
        if len(data) == expected_bytes:
            try:
                values = struct.unpack(f"<{node_count * 6}d", data)
            except struct.error as error:
                values = ()
                local.append(f"{label}.vector.bin cannot be decoded as float64: {error}")
            nonfinite = [i for i, value in enumerate(values) if not math.isfinite(value)]
            if nonfinite:
                local.append(f"{label}.vector.bin contains non-finite scalar indices {nonfinite[:8]}")
            vectors = [
                tuple(complex(values[node * 6 + comp * 2], values[node * 6 + comp * 2 + 1]) for comp in range(3))
                for node in range(node_count)
            ]
            max_abs = max((abs(comp) for vector in vectors for comp in vector), default=0.0)
            report.update({"max_component_abs": max_abs, "nonzero_node_count": sum(any(comp != 0j for comp in vector) for vector in vectors)})
            if max_abs == 0.0:
                local.append(f"{label}.vector.bin is identically zero")
            if max_abs > 0.0 and not nonfinite and k is not None:
                informative_by_pair_id: dict[str, bool] = defaultdict(bool)
                for pair in contract.get("selected_pairs", []):
                    a, b = pair["node_a"], pair["node_b"]
                    source, destination = vectors[a], vectors[b]
                    translation = tuple(float(item) for item in pair["translation"])
                    argument = math.fsum(x * y for x, y in zip(k, translation))
                    expected = complex(math.cos(argument), -math.sin(argument))
                    scale = max((abs(comp) for comp in (*source, *destination)), default=0.0)
                    # Normalize by the whole nonzero mode, not its possibly
                    # vanishing trace. Zero boundary values satisfy Bloch.
                    relative_residual = max((
                        abs(destination[i] / max_abs - expected * (source[i] / max_abs))
                        for i in range(3)
                    ), default=0.0)
                    residual = relative_residual * max_abs
                    pair_result = {
                        "pair_id": pair["pair_id"],
                        "node_a": a,
                        "node_b": b,
                        "translation_m": list(translation),
                        "expected_phase": [expected.real, expected.imag],
                        "max_abs_residual": residual,
                        "relative_residual": relative_residual,
                        "residual_normalization": "whole_mode_max_component",
                        "informative": scale > 0.0,
                        "status": "pass",
                    }
                    if scale == 0.0:
                        pair_result["phase_validation"] = "vacuous_zero_field"
                    elif not math.isfinite(relative_residual) or relative_residual > phase_tolerance:
                        informative_by_pair_id[pair["pair_id"]] = True
                        pair_result["phase_validation"] = "checked"
                        pair_result["status"] = "fail"
                        local.append(f"{label} pair {pair['pair_id']} phase residual {relative_residual:.6g} exceeds tolerance {phase_tolerance:.6g}")
                    else:
                        informative_by_pair_id[pair["pair_id"]] = True
                        pair_result["phase_validation"] = "checked"
                    report["phase_checks"].append(pair_result)
                group_status: dict[str, str] = {}
                for pair_id in contract.get("requested_pair_ids", []):
                    if pair_id not in {item["pair_id"] for item in contract.get("selected_pairs", [])}:
                        continue
                    if informative_by_pair_id[pair_id]:
                        group_status[pair_id] = "qualified_informative_field"
                    else:
                        group_status[pair_id] = "constraint_satisfied_zero_trace"
                report["pair_group_status"] = group_status
            elif not nonfinite and k is None:
                local.append(f"{label} cannot validate phase because k_vector is invalid")
    report["status"] = "pass" if not local else "fail"
    return report


def validate_modal_field_certificate(
    case_dir: Path,
    *,
    mode_selections: Sequence[object] | None = None,
    selected_modes: Sequence[object] | None = None,
    metadata_path: Path | None = None,
    phase_tolerance: float = DEFAULT_PHASE_TOLERANCE,
) -> dict[str, Any]:
    """Validate selected exported mode fields and return a JSON report.

    mode_selections contains objects or two-item sequences of
    (sample_index, raw_mode_index). selected_modes is a compatibility alias.
    If neither is supplied, all published sample/mode metadata is inspected;

    a gate should pass its explicit branch-table selections.
    """

    case_dir = Path(case_dir)
    reasons: list[str] = []
    hashes: dict[str, dict[str, Any]] = {}
    if mode_selections is not None and selected_modes is not None:
        reasons.append("provide only one of mode_selections and selected_modes")
    selections = mode_selections if mode_selections is not None else selected_modes
    normalized = _normalize_selections(selections, reasons)
    if not _finite(phase_tolerance) or float(phase_tolerance) <= 0.0:
        reasons.append("phase_tolerance must be finite and positive")
        phase_tolerance = DEFAULT_PHASE_TOLERANCE

    base: dict[str, Any] = {
        "schema_version": CERTIFICATE_SCHEMA,
        "status": "fail",
        "qualification": "NOT VERIFIED",
        "case_dir": str(case_dir),
        "selection_policy": "explicit" if normalized is not None else "discovered_all",
        "requested_modes": (
            [{"sample_index": a, "raw_mode_index": b} for a, b in normalized]
            if normalized is not None
            else None
        ),
        "phase_convention": "u[node_b] = exp(-i * dot(k, translation_m)) * u[node_a]",
        "phase_tolerance": float(phase_tolerance),
        "backend_plan": {"mesh_node_count": None, "spin_wave_bc_kind": None},
        "pair_contract": {},
        "mode_count": 0,
        "validated_mode_count": 0,
        "modes": [],
        "file_hashes": [],
        "reasons": reasons,
    }
    if not _regular_directory(case_dir):
        reasons.append(f"case directory is missing or unsafe: {case_dir}")
        return base

    native_metadata = (
        Path(metadata_path) if metadata_path is not None else case_dir / "metadata.json"
    )
    metadata = _read_json(native_metadata, label="native metadata.json", case_dir=case_dir, file_hashes=hashes, reasons=reasons)
    backend_plan: Mapping[str, Any] | None = None
    contract: dict[str, Any] = {"selected_pairs": [], "requested_pair_ids": [], "node_pair_ids": [], "boundary_pair_ids": [], "missing_pair_ids": []}
    node_count: int | None = None
    if metadata is not None:
        execution = metadata.get("execution_plan")
        candidate = execution.get("backend_plan") if isinstance(execution, Mapping) else None
        if not isinstance(candidate, Mapping):
            reasons.append("metadata.execution_plan.backend_plan is missing or malformed")
        else:
            backend_plan = candidate
            mesh = backend_plan.get("mesh")
            nodes = mesh.get("nodes") if isinstance(mesh, Mapping) else None
            if not isinstance(nodes, list) or not nodes:
                reasons.append("backend_plan.mesh.nodes is missing or empty")
            else:
                node_count = len(nodes)
                contract = _pair_contract(backend_plan, node_count, reasons)
                base["backend_plan"] = {"mesh_node_count": node_count, "spin_wave_bc_kind": contract.get("kind")}
                base["pair_contract"] = _pair_report(contract)

    paths, selection_policy = _selected_mode_paths(case_dir, normalized, reasons)
    base["selection_policy"] = selection_policy
    for index, (path, expected) in enumerate(paths):
        local_reasons: list[str] = []
        mode = _read_json(path, label=f"mode metadata {path}", case_dir=case_dir, file_hashes=hashes, reasons=local_reasons)
        if mode is None:
            report = {"metadata_path": path.relative_to(case_dir).as_posix(), "status": "fail", "reasons": local_reasons, "phase_checks": []}
        elif node_count is None:
            report = {"metadata_path": path.relative_to(case_dir).as_posix(), "status": "fail", "reasons": ["backend plan mesh node count is unavailable"], "phase_checks": []}
        else:
            report = _validate_mode(
                path,
                mode,
                case_dir=case_dir,
                expected_selection=expected,
                node_count=node_count,
                contract=contract,
                phase_tolerance=float(phase_tolerance),
                hashes=hashes,
            )
        base["modes"].append(report)
        reasons.extend(f"{report['metadata_path']}: {item}" for item in report.get("reasons", []))

    base["mode_count"] = len(base["modes"])
    base["validated_mode_count"] = sum(item.get("status") == "pass" for item in base["modes"])
    base["file_hashes"] = [hashes[key] for key in sorted(hashes)]
    if not base["modes"]:
        reasons.append("no modal fields were available for independent certification")
    if (
        base["modes"]
        and all(item.get("status") == "pass" for item in base["modes"])
        and not reasons
    ):
        base["status"] = "pass"
        base["qualification"] = "QUALIFIED"
    return base


def validate_comsol_modal_field_certificate(
    case_dir: Path,
    *,
    mode_selections: Sequence[object] | None = None,
    selected_modes: Sequence[object] | None = None,
    metadata_path: Path | None = None,
    phase_tolerance: float = DEFAULT_PHASE_TOLERANCE,
) -> dict[str, Any]:
    """Alias for callers using the COMSOL gate name."""
    return validate_modal_field_certificate(
        case_dir,
        mode_selections=mode_selections,
        selected_modes=selected_modes,
        metadata_path=metadata_path,
        phase_tolerance=phase_tolerance,
    )


def _parse_mode_argument(value: str) -> tuple[int, int]:
    pieces = value.split(":", 1)
    if len(pieces) != 2:
        raise argparse.ArgumentTypeError("mode selection must be SAMPLE:RAW_MODE")
    try:
        sample, raw_mode = (int(piece) for piece in pieces)
    except ValueError as error:
        raise argparse.ArgumentTypeError("mode selection indices must be integers") from error
    if sample < 0 or raw_mode < 0:
        raise argparse.ArgumentTypeError("mode selection indices must be non-negative")
    return sample, raw_mode


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case_dir", type=Path)
    parser.add_argument("--metadata", type=Path, dest="metadata_path")
    parser.add_argument("--mode", action="append", type=_parse_mode_argument, default=None, metavar="SAMPLE:RAW_MODE")
    parser.add_argument("--phase-tolerance", type=float, default=DEFAULT_PHASE_TOLERANCE)
    args = parser.parse_args(argv)
    report = validate_modal_field_certificate(
        args.case_dir,
        mode_selections=args.mode,
        metadata_path=args.metadata_path,
        phase_tolerance=args.phase_tolerance,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
