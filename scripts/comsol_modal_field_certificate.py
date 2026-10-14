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
import re
import stat
import struct
from typing import Any, Mapping, Sequence

import frequency_domain_generation


CERTIFICATE_SCHEMA = "fullmag.comsol-modal-field-certificate.v1"
POTENTIAL_CERTIFICATE_SCHEMA = "fullmag.comsol-modal-potential-phase-certificate.v1"
EXPECTED_PHYSICAL_POTENTIAL_SCHEMA = "fem_modal_physical_potential.v1"
EXPECTED_PHYSICAL_POTENTIAL_REPRESENTATION = "full_physical_phasor"
EXPECTED_PHYSICAL_POTENTIAL_PHASOR_CONVENTION = "exp(+i*omega*t)"
EXPECTED_PHYSICAL_POTENTIAL_RECONSTRUCTION = (
    "phi_full[node] = C_phi[node,class] * phi_reduced[class]"
)
EXPECTED_PHYSICAL_POTENTIAL_NORMALIZATION = (
    "same_complex_scale_as_published_magnetization_mode"
)
DEFAULT_PHASE_TOLERANCE = 1.0e-8
DEFAULT_GEOMETRY_ABS_TOLERANCE_M = 1.0e-12
DEFAULT_GEOMETRY_REL_TOLERANCE = 1.0e-8
CANONICAL_PHASE_CONVENTION = "exp_minus_i_k_dot_delta_r"
EXPECTED_PAYLOAD_ENCODING = "f64_interleaved_real_imag_xyz"
EXPECTED_BINARY_LAYOUT = "complex_f64_pairs_little_endian"
EXPECTED_INDEXING = "full_domain_node_order"
EXPECTED_COMPONENT_BASIS = "global_xyz"
_CAPTURE_UNSET = object()
_MODE_MEMBER_PATTERN = re.compile(
    r"^eigen/modes/sample_([0-9]{4,})/mode_([0-9]{4,})\.json$"
)


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


def _validate_root_components(root: Path) -> None:
    """Reject links in the captured root path before any marker lookup."""
    root = Path(root)
    if not root.is_absolute():
        raise ValueError("artifact root must be absolute")
    parts = root.parts
    current = Path(root.anchor)
    for component in parts[1:]:
        current = current / component
        try:
            info = current.lstat()
        except FileNotFoundError:
            return
        except OSError as error:
            raise ValueError(f"artifact root path cannot be inspected: {current}: {error}") from error
        if stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400):
            raise ValueError(f"artifact root traverses a symlink or reparse point: {current}")
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError(f"artifact root component is not a directory: {current}")

class ArtifactBundleReader:
    """Read one captured generation or a legacy case through a shared byte cache.

    Nested certificate, field-loader, and replay callers pass the same reader so
    a logical member is verified and read once, then every consumer parses those
    exact bytes. A legacy bundle stays readable but has no generation binding.
    """

    def __init__(self, root: Path, *, generation_capture: object = _CAPTURE_UNSET) -> None:
        self.root = Path(root).absolute()
        _validate_root_components(self.root)
        self._source_root = self.root
        self._current_fence_status = "pending"
        self.generation = (
            frequency_domain_generation.capture(self.root)
            if generation_capture is _CAPTURE_UNSET
            else generation_capture
        )
        if self.generation is not None:
            if not isinstance(self.generation, frequency_domain_generation.GenerationCapture):
                raise ValueError("invalid frequency-domain generation capture")
            if self.generation.root != self.root.resolve():
                raise ValueError("frequency-domain generation capture belongs to another root")
        self._raw: dict[str, bytes] = {}
        self._records: dict[str, dict[str, Any]] = {}

    @staticmethod
    def _logical(relative: object) -> str:
        if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative or "\x00" in relative:
            raise ValueError("artifact path is not a canonical logical path")
        parsed = PurePosixPath(relative)
        if (
            parsed.is_absolute()
            or parsed.as_posix() != relative
            or any(part in {"", ".", ".."} for part in relative.split("/"))
        ):
            raise ValueError("artifact path is not a canonical logical path")
        return relative

    def logical_path(self, relative: str) -> Path:
        logical = self._logical(relative)
        return self.root.joinpath(*PurePosixPath(logical).parts)

    def has_member(self, relative: str) -> bool:
        logical = self._logical(relative)
        if self.generation is not None:
            return logical in self.generation.members
        path = self.logical_path(logical)
        reasons: list[str] = []
        safe = _safe_relative_path(self.root, logical, "artifact member", reasons)
        return safe is not None and _regular_file(path)

    def iter_members(self, prefix: str) -> tuple[str, ...]:
        if self.generation is None:
            return ()
        return self.generation.iter_members(prefix)

    def read_bytes(self, relative: str, *, maximum_bytes: int | None = None) -> bytes:
        logical = self._logical(relative)
        if maximum_bytes is not None and (
            isinstance(maximum_bytes, bool)
            or not isinstance(maximum_bytes, int)
            or maximum_bytes < 0
        ):
            raise ValueError("artifact byte bound must be a nonnegative integer")
        cached = self._raw.get(logical)
        if cached is not None:
            if maximum_bytes is not None and len(cached) > maximum_bytes:
                raise ValueError(f"artifact member exceeds reader byte budget: {logical}")
            return cached
        if self.generation is not None:
            data = self.generation.read_member(logical, maximum_bytes=maximum_bytes)
        else:
            path = self.logical_path(logical)
            reasons: list[str] = []
            safe = _safe_relative_path(self.root, logical, "artifact member", reasons)
            if safe is None or not _regular_file(safe):
                raise FileNotFoundError(f"artifact member is missing or unsafe: {logical}")
            with safe.open("rb") as stream:
                if maximum_bytes is None:
                    data = stream.read()
                else:
                    if isinstance(maximum_bytes, bool) or not isinstance(maximum_bytes, int) or maximum_bytes < 0:
                        raise ValueError("artifact byte bound must be a nonnegative integer")
                    data = stream.read(maximum_bytes + 1)
                    if len(data) > maximum_bytes:
                        raise ValueError(f"artifact member exceeds reader byte budget: {logical}")
        self._raw[logical] = data
        self._records[logical] = {
            "path": logical,
            "size_bytes": len(data),
            "sha256": _sha256_bytes(data),
        }
        return data

    def record_for(self, relative: str) -> dict[str, Any]:
        logical = self._logical(relative)
        record = self._records.get(logical)
        if record is None:
            raise ValueError(f"artifact member has not been read: {logical}")
        return dict(record)

    def read_json(
        self,
        relative: str,
        *,
        maximum_bytes: int = frequency_domain_generation.DEFAULT_MAX_JSON_BYTES,
    ) -> Any:
        data = self.read_bytes(relative, maximum_bytes=maximum_bytes)
        try:
            return json.loads(data.decode("utf-8"))
        except (UnicodeError, ValueError) as error:
            raise ValueError(f"artifact JSON is not valid bounded UTF-8 JSON: {relative}: {error}") from error

    def generation_descriptor(self) -> dict[str, Any]:
        capture = self.generation
        if capture is None:
            return {
                "generation_binding_status": (
                    "stale" if self._current_fence_status == "stale" else "not_verified"
                ),
                "generation_id": None,
                "schema_version": None,
                "immutable": False,
                "marker_path": None,
                "marker_sha256": None,
                "producer": None,
                "current_fence_status": self._current_fence_status,
            }
        producer = capture.producer
        return {
            "generation_binding_status": (
                "stale"
                if self._current_fence_status == "stale"
                else ("immutable_verified" if capture.is_immutable() else "byte_verified_mutable")
            ),
            "current_fence_status": self._current_fence_status,
            "generation_id": capture.generation_id,
            "schema_version": capture.schema_version,
            "immutable": capture.is_immutable(),
            "marker_path": capture.marker_path,
            "marker_sha256": capture.marker_sha256,
            "producer": (
                {
                    "run_id": producer.run_id,
                    "stage_id": producer.stage_id,
                    "stage_kind": producer.stage_kind,
                }
                if producer is not None
                else None
            ),
        }

    def ensure_current(self) -> None:
        try:
            current = frequency_domain_generation.capture(self._source_root)
        except (OSError, ValueError):
            self._current_fence_status = "stale"
            raise
        if self.generation is None:
            if current is not None:
                self._current_fence_status = "stale"
                raise frequency_domain_generation.GenerationError(
                    "frequency-domain generation appeared during artifact read"
                )
            self._current_fence_status = "no_generation_marker"
            return
        if (
            current is None
            or current.marker_sha256 != self.generation.marker_sha256
            or current.generation_id != self.generation.generation_id
            or current.schema_version != self.generation.schema_version
            or current.root != self.generation.root
        ):
            self._current_fence_status = "stale"
            raise frequency_domain_generation.GenerationError(
                "frequency-domain generation changed during artifact read"
            )
        self._current_fence_status = "current"


def _safe_relative_path(
    root: Path, raw: object, label: str, reasons: list[str]
) -> Path | None:
    if not isinstance(raw, str) or not raw or "\\" in raw or ":" in raw or "\x00" in raw:
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
    reader: ArtifactBundleReader | None = None,
) -> dict[str, Any] | None:
    try:
        if reader is not None:
            relative = path.relative_to(case_dir).as_posix()
            data = reader.read_bytes(
                relative,
                maximum_bytes=frequency_domain_generation.DEFAULT_MAX_JSON_BYTES,
            )
            record = reader.record_for(relative)
        else:
            if not _regular_file(path):
                reasons.append(f"{label} is missing or is not a regular file: {path}")
                return None
            data = path.read_bytes()
            record = _file_record(path, data, case_dir)
    except (OSError, ValueError) as error:
        reasons.append(f"{label} cannot be read: {error}")
        return None
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
    maximum_bytes: int,
    reader: ArtifactBundleReader | None = None,
) -> bytes | None:
    if not _integer(maximum_bytes) or maximum_bytes < 0:
        reasons.append(f"{label} expected byte bound is invalid")
        return None
    try:
        if reader is not None:
            relative = path.relative_to(case_dir).as_posix()
            data = reader.read_bytes(relative, maximum_bytes=maximum_bytes)
            record = reader.record_for(relative)
        else:
            if not _regular_file(path):
                reasons.append(f"{label} is missing or is not a regular file: {path}")
                return None
            with path.open("rb") as stream:
                data = stream.read(maximum_bytes + 1)
            if len(data) > maximum_bytes:
                reasons.append(f"{label} exceeds expected byte count {maximum_bytes}")
                return None
            record = _file_record(path, data, case_dir)
    except (OSError, ValueError) as error:
        if label.endswith(".potential_full.bin") and isinstance(error, ValueError):
            reasons.append(
                f"{label} cannot be read (expected maximum byte length {maximum_bytes}): {error}"
            )
        else:
            reasons.append(f"{label} cannot be read: {error}")
        return None
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
    reader: ArtifactBundleReader | None = None,
) -> tuple[list[tuple[Path, tuple[int, int] | None]], str]:
    if selections is None:
        if reader is not None and reader.generation is not None:
            paths: list[tuple[Path, tuple[int, int] | None]] = []
            for logical in reader.iter_members("eigen/modes"):
                match = _MODE_MEMBER_PATTERN.fullmatch(logical)
                if match is None:
                    continue
                paths.append((reader.logical_path(logical), (int(match.group(1)), int(match.group(2)))))
            if not paths:
                reasons.append("no declared mode metadata found under eigen/modes/sample_*/mode_*.json")
            return paths, "discovered_generation_members"
        return [(path, None) for path in _discover_mode_paths(case_dir, reasons)], "discovered_all"
    paths: list[tuple[Path, tuple[int, int] | None]] = []
    for sample_index, raw_mode_index in selections:
        relative = (
            f"eigen/modes/sample_{sample_index:04d}/mode_{raw_mode_index:04d}.json"
        )
        path = reader.logical_path(relative) if reader is not None else case_dir.joinpath(*PurePosixPath(relative).parts)
        present = reader.has_member(relative) if reader is not None else _regular_file(path)
        if not present:
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
            existing = boundary_by_id[pair_id]
            scale = max(
                1.0e-30,
                *(abs(item) for item in (*existing, *translation)),
            )
            tolerance = DEFAULT_GEOMETRY_ABS_TOLERANCE_M + (
                DEFAULT_GEOMETRY_REL_TOLERANCE * scale
            )
            if max(
                abs(existing[index] - translation[index]) for index in range(3)
            ) > tolerance:
                reasons.append(
                    f"conflicting periodic boundary translations for pair_id {pair_id!r}"
                )
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
    reader: ArtifactBundleReader | None = None,
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
    payload_path = None
    if relative_payload is not None:
        payload_path = (
            reader.logical_path(relative_payload)
            if reader is not None
            else _safe_relative_path(case_dir, relative_payload, f"{label}.payload_path", local)
        )
    expected_bytes = node_count * 6 * struct.calcsize("<d")
    data = (
        _read_bytes(
            payload_path,
            label=f"{label}.vector.bin",
            case_dir=case_dir,
            file_hashes=hashes,
            reasons=local,
            maximum_bytes=expected_bytes,
            reader=reader,
        )
        if payload_path is not None
        else None
    )
    vectors: list[tuple[complex, complex, complex]] = []
    if data is not None:
        actual = (
            reader.record_for(relative_payload)
            if reader is not None and relative_payload is not None
            else _file_record(payload_path, data, case_dir)
        )
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
    bundle_reader: ArtifactBundleReader | None = None,
    final_fence: bool = True,
) -> dict[str, Any]:
    """Validate selected exported mode fields and return a JSON report.

    mode_selections contains objects or two-item sequences of
    (sample_index, raw_mode_index). selected_modes is a compatibility alias.
    If neither is supplied, all published sample/mode metadata is inspected;

    a gate should pass its explicit branch-table selections.
    """

    case_dir = Path(case_dir).absolute()
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
        "artifact_generation": {
            "generation_binding_status": "not_verified",
            "generation_id": None,
            "schema_version": None,
            "immutable": False,
            "marker_path": None,
            "marker_sha256": None,
            "producer": None,
        },
        "reasons": reasons,
    }
    if not _regular_directory(case_dir):
        reasons.append(f"case directory is missing or unsafe: {case_dir}")
        return base

    reader = bundle_reader
    if reader is None:
        try:
            reader = ArtifactBundleReader(case_dir)
        except (OSError, ValueError) as error:
            reasons.append(f"frequency-domain artifact generation capture failed: {error}")
            return base
    elif reader.root != case_dir.absolute():
        reasons.append("artifact bundle reader belongs to another case directory")
        return base
    base["artifact_generation"] = reader.generation_descriptor()

    native_metadata = (
        Path(metadata_path) if metadata_path is not None else case_dir / "metadata.json"
    )
    # Bind caller-supplied metadata to this case before reading or hashing it.
    try:
        relative_metadata = native_metadata.absolute().relative_to(case_dir.absolute())
    except ValueError:
        reasons.append("native metadata.json must be contained in case_dir")
        return base
    logical_metadata = relative_metadata.as_posix()
    try:
        native_metadata = (
            reader.logical_path(logical_metadata)
            if reader.generation is not None
            else _safe_relative_path(case_dir, logical_metadata, "native metadata.json", reasons)
        )
    except ValueError as error:
        reasons.append(f"native metadata.json path is invalid: {error}")
        return base
    if native_metadata is None:
        return base
    metadata = _read_json(
        native_metadata,
        label="native metadata.json",
        case_dir=case_dir,
        file_hashes=hashes,
        reasons=reasons,
        reader=reader,
    )
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

    paths, selection_policy = _selected_mode_paths(case_dir, normalized, reasons, reader)
    base["selection_policy"] = selection_policy
    for index, (path, expected) in enumerate(paths):
        local_reasons: list[str] = []
        mode = _read_json(
            path,
            label=f"mode metadata {path}",
            case_dir=case_dir,
            file_hashes=hashes,
            reasons=local_reasons,
            reader=reader,
        )
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
                reader=reader,
            )
        base["modes"].append(report)
        reasons.extend(f"{report['metadata_path']}: {item}" for item in report.get("reasons", []))

    base["mode_count"] = len(base["modes"])
    base["validated_mode_count"] = sum(item.get("status") == "pass" for item in base["modes"])
    base["file_hashes"] = [hashes[key] for key in sorted(hashes)]
    if not base["modes"]:
        reasons.append("no modal fields were available for independent certification")
    if final_fence:
        try:
            reader.ensure_current()
        except (OSError, ValueError) as error:
            reasons.append(f"frequency-domain artifact generation final fence failed: {error}")
        base["artifact_generation"] = reader.generation_descriptor()
    if (
        base["modes"]
        and all(item.get("status") == "pass" for item in base["modes"])
        and not reasons
    ):
        base["status"] = "pass"
        base["qualification"] = "QUALIFIED"
    return base


def _is_sha256_digest(value: object) -> bool:
    if not isinstance(value, str) or len(value) != 71 or not value.startswith("sha256:"):
        return False
    return all(character in "0123456789abcdef" for character in value[7:])


def validate_modal_potential_phase_certificate(
    case_dir: Path,
    *,
    mode_selections: Sequence[object] | None = None,
    phase_tolerance: float = DEFAULT_PHASE_TOLERANCE,
    bundle_reader: ArtifactBundleReader | None = None,
    final_fence: bool = True,
) -> dict[str, Any]:
    """Replay exported full-node scalar-potential Floquet seams from disk.

    The full physical potential is required. The reduced `potential_real_split.bin`
    coefficient payload is deliberately not a fallback because it is not indexed
    in full-domain node order. A successful seam replay is not a Poisson/gauge
    certificate: the current physical-potential manifest contains no independently
    replayable operator or gauge constraint, so the overall result remains NOT
    VERIFIED until that evidence is published.
    """

    case_dir = Path(case_dir).absolute()
    reasons: list[str] = []
    hashes: dict[str, dict[str, Any]] = {}
    selections = _normalize_selections(mode_selections, reasons)
    if not _finite(phase_tolerance) or float(phase_tolerance) <= 0.0:
        reasons.append("phase_tolerance must be finite and positive")
        phase_tolerance = DEFAULT_PHASE_TOLERANCE

    base: dict[str, Any] = {
        "schema_version": POTENTIAL_CERTIFICATE_SCHEMA,
        "status": "not_verified",
        "qualification": "NOT VERIFIED",
        "case_dir": str(case_dir),
        "selection_policy": "explicit",
        "requested_modes": (
            [{"sample_index": sample, "raw_mode_index": mode} for sample, mode in selections]
            if selections is not None
            else None
        ),
        "spatial_phase_convention": (
            "phi[node_b] = exp(-i * dot(k_rad_per_m, translation_m)) * phi[node_a]"
        ),
        "phasor_convention": EXPECTED_PHYSICAL_POTENTIAL_PHASOR_CONVENTION,
        "phase_tolerance": float(phase_tolerance),
        "phase_status": "not_verified",
        "gauge_status": "not_verified",
        "gauge_reason": (
            "physical_potential.v1 does not publish the Poisson operator or an "
            "independently replayable gauge constraint; producer flags and residuals "
            "are not accepted as gauge evidence"
        ),
        "mode_count": 0,
        "validated_mode_count": 0,
        "modes": [],
        "file_hashes": [],
        "artifact_generation": {
            "generation_binding_status": "not_verified",
            "generation_id": None,
            "schema_version": None,
            "immutable": False,
            "marker_path": None,
            "marker_sha256": None,
            "producer": None,
        },
        "reasons": reasons,
    }
    if selections is None:
        reasons.append("potential phase replay requires explicit branch-selected modes")
        return base
    if not _regular_directory(case_dir):
        reasons.append(f"case directory is missing or unsafe: {case_dir}")
        return base
    reader = bundle_reader
    if reader is None:
        try:
            reader = ArtifactBundleReader(case_dir)
        except (OSError, ValueError) as error:
            reasons.append(f"frequency-domain artifact generation capture failed: {error}")
            return base
    elif reader.root != case_dir.absolute():
        reasons.append("artifact bundle reader belongs to another case directory")
        return base
    base["artifact_generation"] = reader.generation_descriptor()
    if reader.generation is None and not _regular_directory(case_dir / "eigen"):
        reasons.append("potential phase replay requires the published eigen artifact directory")
        return base

    metadata_path = (
        reader.logical_path("metadata.json")
        if reader.generation is not None
        else _safe_relative_path(case_dir, "metadata.json", "native metadata.json", reasons)
    )
    metadata = (
        _read_json(
            metadata_path,
            label="native metadata.json",
            case_dir=case_dir,
            file_hashes=hashes,
            reasons=reasons,
            reader=reader,
        )
        if metadata_path is not None
        else None
    )
    backend_plan: Mapping[str, Any] | None = None
    contract: dict[str, Any] = {
        "selected_pairs": [],
        "requested_pair_ids": [],
        "node_pair_ids": [],
        "boundary_pair_ids": [],
        "missing_pair_ids": [],
    }
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
                if set(contract.get("requested_pair_ids", [])) != set(
                    contract.get("node_pair_ids", [])
                ):
                    reasons.append(
                        "full-potential phase replay requires every periodic node-pair ID "
                        "used by the shared-domain scalar map"
                    )
                if contract.get("kind") not in {"floquet", "periodic"}:
                    reasons.append("full-potential phase replay requires a Floquet or periodic boundary contract")

    contract_invalid = bool(reasons)

    paths, _selection_policy = _selected_mode_paths(case_dir, selections, reasons, reader)
    selection_paths_complete = len(paths) == len(selections)
    mode_reports: list[dict[str, Any]] = []
    any_phase_failure = False
    all_modes_phase_pass = (
        bool(paths)
        and selection_paths_complete
        and node_count is not None
        and backend_plan is not None
    )
    for mode_path, expected_selection in paths:
        local: list[str] = []
        unverified: list[str] = []
        relative_mode = mode_path.relative_to(case_dir).as_posix()
        mode_report: dict[str, Any] = {
            "metadata_path": relative_mode,
            "sample_index": expected_selection[0] if expected_selection else None,
            "raw_mode_index": expected_selection[1] if expected_selection else None,
            "status": "not_verified",
            "phase_status": "not_verified",
            "phase_checks": [],
            "reasons": local,
        }
        mode = _read_json(
            mode_path,
            label=f"mode metadata {relative_mode}",
            case_dir=case_dir,
            file_hashes=hashes,
            reasons=local,
            reader=reader,
        )
        if mode is None or node_count is None or backend_plan is None:
            local.append("mode metadata or source mesh is unavailable for potential replay")
            all_modes_phase_pass = False
            mode_reports.append(mode_report)
            reasons.extend(f"{relative_mode}: {reason}" for reason in local)
            continue

        sample = _nonnegative_int(mode, "sample_index", relative_mode, local)
        raw_mode = _nonnegative_int(mode, "raw_mode_index", relative_mode, local)
        if expected_selection is None or (sample, raw_mode) != expected_selection:
            local.append("mode metadata identity does not match its selected sample/raw-mode pair")
        mode_report.update(
            {
                "sample_index": sample,
                "raw_mode_index": raw_mode,
                "frequency_real_hz": mode.get("frequency_real_hz"),
                "frequency_imag_hz": mode.get("frequency_imag_hz"),
            }
        )
        for identity_key in (
            "source_mesh_topology_sha256",
            "operator_input_signature_sha256",
            "phase_constraint_sha256",
        ):
            mode_report[identity_key] = mode.get(identity_key)
        k = _vec3(mode.get("k_vector"), f"{relative_mode}.k_vector", local)
        if k is not None:
            mode_report["k_vector_rad_per_m"] = list(k)

        manifest_relative = (
            f"eigen/mode_fields/sample_{expected_selection[0]:04d}/"
            f"mode_{expected_selection[1]:04d}/physical_potential.v1.json"
        )
        manifest_path = (
            reader.logical_path(manifest_relative)
            if reader.generation is not None
            else _safe_relative_path(
                case_dir,
                manifest_relative,
                f"{relative_mode}.physical_potential_manifest",
                local,
            )
        )
        manifest = (
            _read_json(
                manifest_path,
                label=f"physical potential manifest {manifest_relative}",
                case_dir=case_dir,
                file_hashes=hashes,
                reasons=local,
                reader=reader,
            )
            if manifest_path is not None
            else None
        )
        if manifest is None:
            all_modes_phase_pass = False
            if manifest_path is None or reader.has_member(manifest_relative):
                mode_report["status"] = "fail"
            mode_reports.append(mode_report)
            reasons.extend(f"{relative_mode}: {reason}" for reason in local)
            continue

        if manifest.get("schema_version") != EXPECTED_PHYSICAL_POTENTIAL_SCHEMA:
            local.append("physical potential manifest has an unsupported schema_version")
        manifest_sample = manifest.get("sample_index")
        manifest_mode = manifest.get("mode_index")
        if (
            not _integer(manifest_sample)
            or not _integer(manifest_mode)
            or (int(manifest_sample), int(manifest_mode)) != expected_selection
        ):
            local.append("physical potential manifest sample/mode identity does not match its selected mode")
        if manifest.get("representation") != EXPECTED_PHYSICAL_POTENTIAL_REPRESENTATION:
            local.append("physical potential manifest representation must be full_physical_phasor")
        if manifest.get("phasor_convention") != EXPECTED_PHYSICAL_POTENTIAL_PHASOR_CONVENTION:
            local.append("physical potential manifest has an unsupported temporal phasor convention")
        if manifest.get("reconstruction") != EXPECTED_PHYSICAL_POTENTIAL_RECONSTRUCTION:
            local.append("physical potential manifest has an unsupported C_phi reconstruction")
        if manifest.get("normalization") != EXPECTED_PHYSICAL_POTENTIAL_NORMALIZATION:
            local.append("physical potential manifest has an unsupported normalization contract")

        for identity_key in (
            "source_mesh_topology_sha256",
            "operator_input_signature_sha256",
            "phase_constraint_sha256",
        ):
            mode_identity = mode.get(identity_key)
            manifest_identity = manifest.get(identity_key)
            if not _is_sha256_digest(mode_identity) or manifest_identity != mode_identity:
                local.append(
                    f"physical potential {identity_key} is missing, malformed, or differs from its mode metadata"
                )

        potential_ref = manifest.get("potential")
        if not isinstance(potential_ref, Mapping):
            local.append("physical potential manifest potential reference is missing or malformed")
            potential_ref = {}
        expected_payload_relative = (
            f"eigen/mode_fields/sample_{expected_selection[0]:04d}/"
            f"mode_{expected_selection[1]:04d}/potential_full.bin"
        )
        declared_payload_relative = potential_ref.get("path")
        if declared_payload_relative != expected_payload_relative:
            local.append("physical potential payload path does not match its selected sample/raw-mode identity")
        if (
            potential_ref.get("dtype") != "float64"
            or potential_ref.get("byte_order") != "little"
            or potential_ref.get("layout") != "node_major_real_imag"
            or potential_ref.get("association") != "source_mesh_nodes"
            or potential_ref.get("unit") != "A"
        ):
            local.append("physical potential payload has an unsupported dtype, layout, association, or unit")
        payload_count = potential_ref.get("count")
        if not _integer(payload_count) or int(payload_count) != node_count:
            local.append("physical potential payload node count does not match the source mesh")

        expected_bytes = node_count * 2 * struct.calcsize("<d")
        payload_path = (
            reader.logical_path(expected_payload_relative)
            if reader.generation is not None
            else _safe_relative_path(
                case_dir,
                expected_payload_relative,
                f"{relative_mode}.potential_full.bin",
                local,
            )
        )
        payload = (
            _read_bytes(
                payload_path,
                label=f"{relative_mode}.potential_full.bin",
                case_dir=case_dir,
                file_hashes=hashes,
                reasons=local,
                maximum_bytes=expected_bytes,
                reader=reader,
            )
            if payload_path is not None
            else None
        )
        values: list[complex] = []
        if payload is not None:
            actual = (
                reader.record_for(expected_payload_relative)
                if reader.generation is not None
                else _file_record(payload_path, payload, case_dir)
            )
            mode_report.update(
                {
                    "potential_path": actual["path"],
                    "potential_size_bytes": len(payload),
                    "potential_sha256": actual["sha256"],
                }
            )
            if len(payload) != expected_bytes:
                local.append(
                    f"potential_full.bin length {len(payload)} does not equal expected {expected_bytes}"
                )
            if potential_ref.get("sha256") != actual["sha256"]:
                local.append("physical potential manifest SHA-256 does not match potential_full.bin bytes")
            if len(payload) == expected_bytes:
                try:
                    scalars = struct.unpack(f"<{node_count * 2}d", payload)
                except struct.error as error:
                    scalars = ()
                    local.append(f"potential_full.bin cannot be decoded as float64: {error}")
                if len(scalars) == node_count * 2:
                    nonfinite = [index for index, value in enumerate(scalars) if not math.isfinite(value)]
                    if nonfinite:
                        local.append(
                            f"potential_full.bin contains non-finite scalar indices {nonfinite[:8]}"
                        )
                    else:
                        values = [
                            complex(scalars[node * 2], scalars[node * 2 + 1])
                            for node in range(node_count)
                        ]

        phase_checks: list[dict[str, Any]] = []
        try:
            max_abs = max((abs(value) for value in values), default=0.0)
        except (OverflowError, ValueError):
            max_abs = math.inf
        mode_report["max_potential_abs"] = max_abs if math.isfinite(max_abs) else None
        if not math.isfinite(max_abs):
            local.append("potential_full.bin has a non-finite derived magnitude")
        elif values and k is not None and contract.get("selected_pairs"):
            informative_pair_count = 0
            for pair in contract["selected_pairs"]:
                a, b = pair["node_a"], pair["node_b"]
                if (
                    pair.get("geometry_status") != "pass"
                    or a < 0
                    or b < 0
                    or a >= len(values)
                    or b >= len(values)
                ):
                    local.append(f"potential phase pair {pair.get('pair_id')!r} lacks verified geometry")
                    continue
                if contract.get("kind") == "floquet":
                    translation = tuple(float(item) for item in pair["translation"])
                    try:
                        argument = math.fsum(x * y for x, y in zip(k, translation))
                    except (OverflowError, ValueError):
                        argument = math.inf
                    if not math.isfinite(argument):
                        local.append(
                            f"potential phase argument for pair {pair['pair_id']} is non-finite"
                        )
                        phase_checks.append(
                            {
                                "pair_id": pair["pair_id"],
                                "node_a": a,
                                "node_b": b,
                                "translation_m": list(pair["translation"]),
                                "relative_residual": None,
                                "residual_normalization": "whole_potential_max_abs",
                                "informative": False,
                                "phase_validation": "unavailable_nonfinite_phase_argument",
                                "status": "fail",
                            }
                        )
                        continue
                    expected_phase = complex(math.cos(argument), -math.sin(argument))
                else:
                    expected_phase = 1.0 + 0.0j
                trace_scale = max(abs(values[a]), abs(values[b]))
                if trace_scale == 0.0:
                    phase_checks.append(
                        {
                            "pair_id": pair["pair_id"],
                            "node_a": a,
                            "node_b": b,
                            "translation_m": list(pair["translation"]),
                            "expected_phase": [expected_phase.real, expected_phase.imag],
                            "relative_residual": None,
                            "residual_finite": None,
                            "residual_normalization": "whole_potential_max_abs",
                            "informative": False,
                            "phase_validation": (
                                "vacuous_zero_potential" if max_abs == 0.0 else "vacuous_zero_trace"
                            ),
                            "status": "not_verified",
                        }
                    )
                    unverified.append(
                        f"potential phase pair {pair['pair_id']} has a zero periodic trace; "
                        "phase evidence is uninformative"
                    )
                    continue
                residual = abs(values[b] / max_abs - expected_phase * (values[a] / max_abs))
                residual_finite = math.isfinite(residual)
                phase_result = {
                    "pair_id": pair["pair_id"],
                    "node_a": a,
                    "node_b": b,
                    "translation_m": list(pair["translation"]),
                    "expected_phase": [expected_phase.real, expected_phase.imag],
                    "relative_residual": residual if residual_finite else None,
                    "residual_finite": residual_finite,
                    "residual_normalization": "whole_potential_max_abs",
                    "informative": True,
                    "phase_validation": "checked",
                    "status": "pass",
                }
                informative_pair_count += 1
                if not residual_finite or residual > float(phase_tolerance):
                    phase_result["status"] = "fail"
                    local.append(
                        f"potential phase residual for pair {pair['pair_id']} is {residual:.6g}, "
                        f"above tolerance {float(phase_tolerance):.6g}"
                    )
                phase_checks.append(phase_result)
            mode_report["informative_pair_count"] = informative_pair_count
            if informative_pair_count == 0:
                unverified.append("no periodic pair has an informative nonzero potential trace")
            if max_abs == 0.0:
                unverified.append(
                    "potential_full.bin is identically zero; this is physically possible but provides no phase evidence"
                )
        else:
            if k is None:
                local.append("potential phase replay cannot use an invalid mode k_vector")
            if not contract.get("selected_pairs"):
                local.append("potential phase replay has no complete periodic node-pair coverage")

        mode_report["phase_checks"] = phase_checks
        if local:
            mode_report["status"] = "fail"
            mode_report["phase_status"] = "fail"
            any_phase_failure = True
            all_modes_phase_pass = False
        elif unverified:
            mode_report["status"] = "not_verified"
            mode_report["phase_status"] = "not_verified"
            mode_report["phase_evidence_status"] = "uninformative"
            mode_report["unverified_reasons"] = unverified
            all_modes_phase_pass = False
        elif phase_checks and all(item["status"] == "pass" for item in phase_checks):
            mode_report["status"] = "pass"
            mode_report["phase_status"] = "pass"
        else:
            all_modes_phase_pass = False
        mode_reports.append(mode_report)
        reasons.extend(f"{relative_mode}: {reason}" for reason in local)
        reasons.extend(f"{relative_mode}: {reason}" for reason in unverified)

    base["modes"] = mode_reports
    base["mode_count"] = len(mode_reports)
    base["validated_mode_count"] = sum(item.get("phase_status") == "pass" for item in mode_reports)
    base["phase_status"] = (
        "fail"
        if any_phase_failure or contract_invalid
        else "pass"
        if all_modes_phase_pass
        else "not_verified"
    )
    if base["phase_status"] == "pass":
        reasons.append(base["gauge_reason"])
        base["status"] = "not_verified"
    elif any_phase_failure or contract_invalid:
        base["status"] = "fail"
    else:
        base["status"] = "not_verified"
    base["file_hashes"] = [hashes[key] for key in sorted(hashes)]
    fence_failed = False
    if final_fence:
        try:
            reader.ensure_current()
        except (OSError, ValueError) as error:
            fence_failed = True
            reasons.append(f"frequency-domain artifact generation final fence failed: {error}")
        base["artifact_generation"] = reader.generation_descriptor()
    if fence_failed:
        base["status"] = "fail"
        base["phase_status"] = "fail"
    return base


def validate_comsol_modal_field_certificate(
    case_dir: Path,
    *,
    mode_selections: Sequence[object] | None = None,
    selected_modes: Sequence[object] | None = None,
    metadata_path: Path | None = None,
    phase_tolerance: float = DEFAULT_PHASE_TOLERANCE,
    bundle_reader: ArtifactBundleReader | None = None,
    final_fence: bool = True,
) -> dict[str, Any]:
    """Alias for callers using the COMSOL gate name."""
    return validate_modal_field_certificate(
        case_dir,
        mode_selections=mode_selections,
        selected_modes=selected_modes,
        metadata_path=metadata_path,
        phase_tolerance=phase_tolerance,
        bundle_reader=bundle_reader,
        final_fence=final_fence,
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
