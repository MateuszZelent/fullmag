#!/usr/bin/env python3
"""Render and export actual bimeron/cylinder M fields without running Fullmag.

Accepted input is either:
- a completed run directory with fields/m/manifest.json,
  fields/m/layer-<id>/step_000000.json and the actual terminal step file,
  metadata.json, scalars.csv, and a provenance record (or --run-id); or
- an explicit NPZ using schema ``fullmag.bimeron-matrix-arrays.v1``. The NPZ
  must contain initial/final M arrays for both objects, masks, grids, scalar
  rows, and a UTF-8 ``metadata_json`` scalar. A demagnetizing-field-plane NPZ
  is not a substitute for these M arrays.

The command writes four deterministic data renders and an uncompressed,
little-endian Zarr v2 bundle. It never runs a solver and never fills a missing
terminal field from the initial state. Existing case output directories are
preserved and cause an error rather than being overwritten.

The explicit NPZ schema uses ``metadata_json`` and ``scalar_columns_json``
UTF-8 string scalars, a numeric ``scalars`` matrix, and (for each of ``film``
and ``cylinder``) ``*_native_grid`` [nx,ny,nz], ``*_native_origin_m``,
``*_cell_size_m``, ``*_mask`` [nz,ny,nx], and ``*_initial_m``/``*_final_m``
arrays [nz,ny,nx,3] in xyz component order. Its metadata must include the
matrix case ID, completion/execution/provenance objects, and per-object IDs.
Test-only synthetic NPZ fixtures are rejected by the production entry point.

These cases use BB energy minimization. It does not integrate LLG physical
dynamics; damping alpha remains material metadata and must not be interpreted
as a physical relaxation time. Elapsed solver wall time is reported separately.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

# Matplotlib otherwise falls back to a home directory that may not be writable.
# Keep a private font/config cache for this process when the host has no setting.
_MPL_CONFIG = None
if not os.environ.get("MPLCONFIGDIR"):
    _MPL_CONFIG = tempfile.TemporaryDirectory(prefix="fullmag-matrix-mpl-")
    os.environ["MPLCONFIGDIR"] = _MPL_CONFIG.name

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
MATRIX_MANIFEST = ROOT / "manifest.json"
MATRIX_SCHEMA = "fullmag.bimeron_material_matrix.v1"
COLLECTION_SCHEMA = "fullmag.bimeron-matrix-collection.v1"
ARRAYS_SCHEMA = "fullmag.bimeron-matrix-arrays.v1"
ZARR_SCHEMA = "fullmag.bimeron-matrix-zarr.v1"
PLOT_RENDERER = "fullmag-bimeron-matrix-data-render.v1"
REGION_INACTIVE = (1 << 32) - 1
CASE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
FIELD_STEPS_RE = re.compile(r"^step_(\d{6,})\.json$")
MAX_3D_ARROWS_PER_LAYER = 512
TIME_SEMANTICS = (
    "BB energy minimization does not integrate LLG physical dynamics; damping alpha is material metadata, "
    "not a physical relaxation time."
)
PNG_SIZE_INCHES = (8.0, 6.0)
PNG_DPI = 120
CAMERA = {"elevation_deg": 23.0, "azimuth_deg": -53.0, "projection": "orthographic"}
COLOR_ENCODING = "RGB=(Mx+1,My+1,Mz+1)/2 after unit-direction normalization; fixed [-1,1] range"
SURFACE_COLORS = {"film": "#7c94ad", "cylinder": "#c58c63"}


class DataError(RuntimeError):
    """Input is incomplete, inconsistent, or not safe to collect."""


@dataclass(frozen=True)
class LayerData:
    key: str
    object_id: str
    magnet_name: str
    native_grid: tuple[int, int, int]  # nx, ny, nz
    native_origin_m: np.ndarray
    cell_size_m: np.ndarray
    active_mask: np.ndarray  # nz, ny, nx
    initial_m: np.ndarray  # nz, ny, nx, 3
    final_m: np.ndarray  # nz, ny, nx, 3
    source_metadata: dict[str, Any]


@dataclass(frozen=True)
class CaseData:
    case_id: str
    run_id: str
    source_sha256: str
    status: str
    steps: int
    max_steps: int
    converged: bool
    max_torque_T: float | None
    wall_time_s: float | None
    energies_J: dict[str, float | None]
    execution: dict[str, Any]
    material: dict[str, Any]
    film_initial: str
    dot_mx: int
    layers: dict[str, LayerData]
    scalar_columns: tuple[str, ...]
    scalar_values: np.ndarray
    completion: dict[str, Any]
    provenance: dict[str, Any]
    input_hashes: dict[str, str]
    input_kind: str


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def _read_json(path: Path) -> dict[str, Any]:
    _require_plain_file(path)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DataError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise DataError(f"expected a JSON object in {path}")
    return value


def _is_link(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        is_junction = getattr(path, "is_junction", None)
        return bool(is_junction()) if callable(is_junction) else False
    except OSError as exc:
        raise DataError(f"cannot inspect path {path}: {exc}") from exc


def _require_plain_file(path: Path) -> None:
    if _is_link(path):
        raise DataError(f"refusing a symlink or junction input: {path}")
    if not path.is_file():
        raise DataError(f"required input file is missing: {path}")


def _require_plain_directory(path: Path) -> None:
    if _is_link(path):
        raise DataError(f"refusing a symlink or junction directory: {path}")
    if not path.is_dir():
        raise DataError(f"required input directory is missing: {path}")


def _validate_path_chain(path: Path, *, allow_missing_leaf: bool = False) -> Path:
    """Reject links/junctions on the existing path chain, then resolve it."""
    candidate = Path(os.path.abspath(path))
    current = Path(candidate.anchor)
    parts = candidate.parts[1:]
    for index, part in enumerate(parts):
        current = current / part
        if allow_missing_leaf and index == len(parts) - 1 and not current.exists():
            continue
        if current.exists() and _is_link(current):
            raise DataError(f"refusing a symlink or junction in path: {current}")
    return candidate.resolve(strict=False)


def _as_finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool):
        raise DataError(f"{label} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise DataError(f"{label} must be a finite number") from exc
    if not math.isfinite(number):
        raise DataError(f"{label} is not finite")
    return number


def _as_nonnegative_integer(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise DataError(f"{label} must be a non-negative integer")
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise DataError(f"{label} must be a non-negative integer") from exc
    try:
        numeric = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise DataError(f"{label} must be a non-negative integer") from exc
    if number < 0 or not math.isfinite(numeric) or numeric != number:
        raise DataError(f"{label} must be a non-negative integer")
    return number


def _case_id(value: Any) -> str:
    if not isinstance(value, str) or not CASE_ID_RE.fullmatch(value) or ".." in value:
        raise DataError(f"invalid case_id {value!r}")
    return value


def load_matrix_manifest(path: Path = MATRIX_MANIFEST) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    manifest = _read_json(path)
    if manifest.get("schema") != MATRIX_SCHEMA or manifest.get("case_count") != 12:
        raise DataError(f"unexpected matrix manifest schema/content in {path}")
    integrity = manifest.get("integrity")
    if not isinstance(integrity, dict) or not isinstance(integrity.get("payload_sha256"), str):
        raise DataError("matrix manifest has no integrity digest")
    payload = dict(manifest)
    payload.pop("integrity", None)
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if _sha256_bytes(canonical) != integrity["payload_sha256"]:
        raise DataError("matrix manifest integrity digest does not match")
    cases = manifest.get("cases")
    if not isinstance(cases, list) or len(cases) != 12:
        raise DataError("matrix manifest must contain exactly 12 cases")
    by_id: dict[str, dict[str, Any]] = {}
    for case in cases:
        if not isinstance(case, dict):
            raise DataError("matrix manifest contains a malformed case")
        identifier = _case_id(case.get("case_id"))
        if identifier in by_id:
            raise DataError(f"duplicate case_id in matrix manifest: {identifier}")
        digest = case.get("script_sha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise DataError(f"invalid script SHA-256 for {identifier}")
        by_id[identifier] = case
    return manifest, by_id


def _spec_fields(case_spec: dict[str, Any]) -> tuple[str, int, dict[str, Any]]:
    film = case_spec.get("film_material")
    film_state = case_spec.get("initial_states", {}).get("film")
    cylinder_state = case_spec.get("initial_states", {}).get("cylinder")
    if not isinstance(film, dict) or not isinstance(film_state, dict) or not isinstance(cylinder_state, dict):
        raise DataError("case specification lacks material or initial-state metadata")
    material_id = {"rdmi_current": "current_rdmi"}.get(str(film.get("key")), str(film.get("key")))
    labels = {"current_rdmi": "rDMI (bieżące)", "yig": "YIG", "permalloy": "Permalloy"}
    if material_id not in labels:
        raise DataError(f"unsupported matrix material key {film.get('key')!r}")
    dot_m = cylinder_state.get("m")
    if not isinstance(dot_m, list) or len(dot_m) != 3:
        raise DataError("case specification has no explicit cylinder initial vector")
    dot_mx = _as_finite_number(dot_m[0], "cylinder initial mx")
    if dot_mx not in (-1.0, 1.0):
        raise DataError("cylinder initial mx must be -1 or 1")
    material = {
        "id": material_id,
        "label": labels[material_id],
        "Ms_Apm": film["Ms_A_per_m"],
        "Aex_Jpm": film["Aex_J_per_m"],
        "Ku_Jpm3": film["Ku1_J_per_m3"],
        "D_Jpm2": film["D_J_per_m2"],
        "alpha": film["alpha"],
    }
    return str(film_state["key"]), int(dot_mx), material


def _matrix_geometry(manifest: dict[str, Any], layer_name: str) -> tuple[np.ndarray, np.ndarray, tuple[int, int, int]]:
    common = manifest.get("common_configuration", {})
    geometry = common.get("geometry", {})
    mesh = common.get("mesh", {})
    cell = np.asarray(mesh.get("cell_size_m"), dtype=np.float64)
    if cell.shape != (3,) or not np.isfinite(cell).all() or np.any(cell <= 0):
        raise DataError("matrix manifest has invalid common cell size")
    item = geometry.get("film" if layer_name == "film" else "cylinder")
    if not isinstance(item, dict):
        raise DataError(f"matrix manifest has no {layer_name} geometry")
    if layer_name == "film":
        size = np.asarray(item.get("size_m"), dtype=np.float64)
        center = np.asarray(item.get("center_m"), dtype=np.float64)
    else:
        size = np.asarray([2 * item.get("radius_m", 0), 2 * item.get("radius_m", 0), item.get("height_m", 0)], dtype=np.float64)
        center = np.asarray(item.get("center_m"), dtype=np.float64)
    if size.shape != (3,) or center.shape != (3,) or not np.isfinite(size).all() or not np.isfinite(center).all():
        raise DataError(f"matrix manifest has invalid {layer_name} dimensions")
    grid_float = size / cell
    grid = np.rint(grid_float).astype(np.int64)
    if np.any(grid <= 0) or not np.allclose(grid_float, grid, rtol=0, atol=1e-9):
        raise DataError(f"{layer_name} size is not an integer number of common cells")
    origin = center - size / 2
    return origin, cell, tuple(int(value) for value in grid)


def _validate_layer_geometry(layer: LayerData, manifest: dict[str, Any]) -> None:
    expected_origin, expected_cell, expected_grid = _matrix_geometry(manifest, layer.key)
    if layer.native_grid != expected_grid:
        raise DataError(
            f"{layer.object_id}: native grid {layer.native_grid} does not match expected {expected_grid}"
        )
    if not np.allclose(layer.native_origin_m, expected_origin, rtol=0, atol=2e-15):
        raise DataError(f"{layer.object_id}: native origin differs from the matrix geometry")
    if not np.allclose(layer.cell_size_m, expected_cell, rtol=0, atol=2e-15):
        raise DataError(f"{layer.object_id}: native cell size differs from the matrix cell")


def _mask_from_metadata(
    layer_entry: dict[str, Any], plan_layer: dict[str, Any] | None, grid: tuple[int, int, int]
) -> np.ndarray:
    count = math.prod(grid)
    active = None
    if plan_layer is not None:
        candidate = plan_layer.get("native_active_mask")
        if isinstance(candidate, list):
            if len(candidate) != count or any(value not in (True, False, 0, 1) for value in candidate):
                raise DataError(f"{layer_entry.get('object_id')}: invalid native_active_mask")
            active = np.asarray(candidate, dtype=np.bool_)
    if active is None:
        candidate = layer_entry.get("native_active_mask")
        if isinstance(candidate, list):
            if len(candidate) != count or any(value not in (True, False, 0, 1) for value in candidate):
                raise DataError(f"{layer_entry.get('object_id')}: invalid native_active_mask")
            active = np.asarray(candidate, dtype=np.bool_)
    if active is None:
        region = layer_entry.get("native_region_mask")
        if region is None and plan_layer is not None:
            region = plan_layer.get("native_region_mask")
        if isinstance(region, list):
            if len(region) != count:
                raise DataError(f"{layer_entry.get('object_id')}: native_region_mask length mismatch")
            try:
                region_values = np.asarray(region, dtype=np.uint64)
            except (TypeError, ValueError, OverflowError) as exc:
                raise DataError(f"{layer_entry.get('object_id')}: invalid native_region_mask") from exc
            active = region_values != REGION_INACTIVE
    if active is None or active.size != count:
        raise DataError(f"{layer_entry.get('object_id')}: no authoritative active mask in native metadata")

    active_count = layer_entry.get("active_cell_count")
    if active_count is None and plan_layer is not None:
        active_count = plan_layer.get("active_cell_count")
    if active_count is not None and int(active.sum()) != _as_nonnegative_integer(active_count, "active_cell_count"):
        raise DataError(f"{layer_entry.get('object_id')}: mask count disagrees with active_cell_count")
    nx, ny, nz = grid
    return active.reshape((nz, ny, nx), order="C")


def _make_layer_data(
    key: str,
    entry: dict[str, Any],
    plan_layer: dict[str, Any] | None,
    initial_values: Any,
    final_values: Any,
    manifest: dict[str, Any],
) -> LayerData:
    object_id = str(entry.get("object_id") or "")
    if not object_id:
        raise DataError(f"{key} layer has no object_id")
    if plan_layer is not None and str(plan_layer.get("object_id") or "") != object_id:
        raise DataError(f"{key} field and execution-plan object identities differ")
    raw_grid = entry.get("native_grid")
    if not isinstance(raw_grid, list) or len(raw_grid) != 3:
        raise DataError(f"{object_id}: native_grid must be [nx,ny,nz]")
    grid = tuple(_as_nonnegative_integer(value, f"{object_id}.native_grid") for value in raw_grid)
    if any(value <= 0 for value in grid):
        raise DataError(f"{object_id}: native_grid dimensions must be positive")
    origin = np.asarray(entry.get("native_origin"), dtype=np.float64)
    cell = np.asarray(entry.get("native_cell_size"), dtype=np.float64)
    if origin.shape != (3,) or cell.shape != (3,) or not np.isfinite(origin).all() or not np.isfinite(cell).all() or np.any(cell <= 0):
        raise DataError(f"{object_id}: invalid native origin or cell size")
    nx, ny, nz = grid
    expected_shape = (nx * ny * nz, 3)
    initial = np.asarray(initial_values, dtype=np.float64)
    final = np.asarray(final_values, dtype=np.float64)
    if initial.shape != expected_shape:
        raise DataError(f"{object_id}: initial M shape {initial.shape}, expected {expected_shape}")
    if final.shape != expected_shape:
        raise DataError(f"{object_id}: final M shape {final.shape}, expected {expected_shape}")
    if not np.isfinite(initial).all():
        raise DataError(f"{object_id}: initial M contains NaN or infinity")
    if not np.isfinite(final).all():
        raise DataError(f"{object_id}: final M contains NaN or infinity")
    mask = _mask_from_metadata(entry, plan_layer, grid)
    if not mask.any():
        raise DataError(f"{object_id}: active mask is empty")
    initial_4d = initial.reshape((nz, ny, nx, 3), order="C")
    final_4d = final.reshape((nz, ny, nx, 3), order="C")
    active_initial_norm = np.linalg.norm(initial_4d[mask], axis=1)
    active_final_norm = np.linalg.norm(final_4d[mask], axis=1)
    if np.any(active_initial_norm <= 0) or np.any(active_final_norm <= 0):
        raise DataError(f"{object_id}: active M includes a zero vector")
    layer = LayerData(
        key=key,
        object_id=object_id,
        magnet_name=str(entry.get("magnet_name") or object_id),
        native_grid=grid,
        native_origin_m=origin,
        cell_size_m=cell,
        active_mask=mask,
        initial_m=initial_4d,
        final_m=final_4d,
        source_metadata=entry,
    )
    _validate_layer_geometry(layer, manifest)
    return layer


def _find_one(paths: Iterable[Path], label: str) -> Path:
    found = [path for path in paths if path.is_file()]
    if not found:
        raise DataError(f"missing {label}; searched: {', '.join(str(path) for path in paths)}")
    if len(found) != 1:
        raise DataError(f"ambiguous {label}: {', '.join(str(path) for path in found)}")
    _require_plain_file(found[0])
    return found[0]


def _load_scalars_csv(path: Path) -> tuple[tuple[str, ...], np.ndarray, dict[str, int]]:
    _require_plain_file(path)
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            columns = tuple(str(value).strip() for value in (reader.fieldnames or ()))
            if not columns or any(not value for value in columns):
                raise DataError(f"scalar CSV has no valid header: {path}")
            rows: list[list[float]] = []
            for row_index, row in enumerate(reader):
                if not row or all(value is None or not value.strip() for value in row.values()):
                    continue
                if any(row.get(column) is None for column in columns):
                    raise DataError(f"scalar CSV row {row_index + 2} has missing columns")
                rows.append([_as_finite_number(row[column], f"scalars row {row_index + 2} {column}") for column in columns])
    except OSError as exc:
        raise DataError(f"cannot read scalar CSV {path}: {exc}") from exc
    if not rows:
        raise DataError(f"scalar CSV contains no rows: {path}")
    values = np.asarray(rows, dtype=np.float64)
    lookup: dict[str, int] = {}
    for index, column in enumerate(columns):
        normalized = re.sub(r"[^a-z0-9]", "", column.lower())
        if normalized in lookup:
            raise DataError(f"duplicate normalized scalar column {column!r}")
        lookup[normalized] = index
    for required in ("step", "mx", "my", "mz", "etotal", "maxtorquet"):
        if required not in lookup and not (required == "maxtorquet" and "maxtorquet" in lookup):
            raise DataError(f"scalar CSV is missing required quantity {required!r}")
    steps_float = values[:, lookup["step"]]
    steps_int = steps_float.astype(np.int64)
    if not np.array_equal(steps_float, steps_int.astype(np.float64)) or np.any(steps_int < 0):
        raise DataError("scalar CSV step column must contain non-negative integers")
    if steps_int[0] != 0 or np.any(np.diff(steps_int) <= 0):
        raise DataError("scalar CSV must start at step 0 and then increase strictly")
    return columns, values, lookup


def _load_scalar_arrays(columns: tuple[str, ...], values: Any) -> tuple[np.ndarray, dict[str, int]]:
    matrix = np.asarray(values, dtype=np.float64)
    if matrix.ndim != 2 or matrix.shape[0] < 1 or matrix.shape[1] != len(columns):
        raise DataError("NPZ scalar matrix shape does not match scalar column names")
    if not np.isfinite(matrix).all():
        raise DataError("scalar matrix contains NaN or infinity")
    lookup = {re.sub(r"[^a-z0-9]", "", name.lower()): index for index, name in enumerate(columns)}
    if len(lookup) != len(columns):
        raise DataError("scalar column names are not unique")
    for required in ("step", "mx", "my", "mz", "etotal", "maxtorquet"):
        if required not in lookup:
            raise DataError(f"scalar matrix is missing required quantity {required!r}")
    step_values = matrix[:, lookup["step"]]
    step_int = step_values.astype(np.int64)
    if not np.array_equal(step_values, step_int.astype(np.float64)) or step_int[0] != 0 or np.any(np.diff(step_int) <= 0):
        raise DataError("scalar matrix must start at step 0 and then increase by integer steps")
    return matrix, lookup


def _extract_run_summary(
    metadata: dict[str, Any],
    run_provenance: dict[str, Any],
    cli_run_id: str | None,
    spec: dict[str, Any],
    columns: tuple[str, ...],
    scalar_values: np.ndarray,
    scalar_lookup: dict[str, int],
) -> dict[str, Any]:
    case_id = _case_id(spec.get("case_id"))
    metadata_name = metadata.get("problem_name")
    if metadata_name and str(metadata_name) != case_id:
        raise DataError(f"native problem_name {metadata_name!r} does not match case_id {case_id!r}")
    status = metadata.get("status")
    completion = metadata.get("completion")
    if status != "completed" or not isinstance(completion, dict) or completion.get("status") != "completed":
        raise DataError(f"run is pending/incomplete: metadata status={status!r}, completion={completion!r}")
    converged = completion.get("converged")
    if not isinstance(converged, bool):
        raise DataError("completed run is missing an explicit boolean completion.converged")
    requested = metadata.get("requested_execution")
    provenance_execution = metadata.get("execution_provenance")
    if not isinstance(requested, dict) or not isinstance(provenance_execution, dict):
        raise DataError("native metadata lacks requested execution or execution provenance")
    resolution = provenance_execution.get("execution_resolution")
    if not isinstance(resolution, dict) or not isinstance(resolution.get("resolved_execution"), dict):
        raise DataError("native execution provenance lacks resolved_execution")
    resolved = resolution["resolved_execution"]
    execution = {
        "requested": {"backend": requested.get("backend"), "device": requested.get("device")},
        "resolved": {"backend": resolved.get("backend"), "device": resolved.get("device")},
        "precision": {"requested": requested.get("precision"), "resolved": resolved.get("precision")},
        "mode": {"requested": requested.get("mode"), "resolved": resolved.get("mode")},
        "execution_engine": provenance_execution.get("execution", {}).get("execution_engine")
        if isinstance(provenance_execution.get("execution"), dict) else None,
        "fallback_occurred": resolution.get("fallback_occurred"),
    }
    for mode in ("requested", "resolved"):
        if execution[mode] != {"backend": "fdm", "device": "gpu"}:
            raise DataError(f"{mode} execution is not explicitly FDM GPU: {execution[mode]}")
    if execution["fallback_occurred"] not in (False, None):
        raise DataError("FDM GPU result records an execution fallback")

    steps_float = scalar_values[-1, scalar_lookup["step"]]
    steps = _as_nonnegative_integer(steps_float, "terminal scalar step")
    if steps == 0 and int(scalar_values.shape[0]) > 1:
        raise DataError("scalar rows contain samples but terminal step is still zero")
    expected_steps = spec.get("max_steps")
    max_steps = _as_nonnegative_integer(expected_steps, "matrix max_steps")
    if max_steps != 3000 or steps > max_steps:
        raise DataError(f"terminal step {steps} is inconsistent with max_steps={max_steps}")
    max_torque = _as_finite_number(scalar_values[-1, scalar_lookup["maxtorquet"]], "terminal max_torque_T")

    def scalar_quantity(*names: str) -> float | None:
        for name in names:
            index = scalar_lookup.get(re.sub(r"[^a-z0-9]", "", name.lower()))
            if index is not None:
                return float(scalar_values[-1, index])
        return None

    energies = {
        "total": scalar_quantity("E_total", "total_energy"),
        "exchange": scalar_quantity("E_ex"),
        "demag": scalar_quantity("E_demag"),
        "external": scalar_quantity("E_ext"),
        "anisotropy": scalar_quantity("E_ani"),
        "rotated_dmi": scalar_quantity("E_rotated_dmi"),
        "dmi": scalar_quantity("E_dmi"),
        "drive": scalar_quantity("E_drive"),
    }
    if energies["total"] is None:
        raise DataError("terminal scalar row has no E_total")

    provenance_run_id = run_provenance.get("run_id")
    metadata_run_id = metadata.get("run_id")
    chosen_run_id = cli_run_id or provenance_run_id or metadata_run_id
    if cli_run_id and provenance_run_id and cli_run_id != provenance_run_id:
        raise DataError("--run-id disagrees with the input provenance record")
    if cli_run_id and metadata_run_id and cli_run_id != metadata_run_id:
        raise DataError("--run-id disagrees with native metadata")
    if not isinstance(chosen_run_id, str) or not chosen_run_id.strip():
        raise DataError("run_id is missing; provide it in provenance or with --run-id")

    expected_source_hash = spec.get("script_sha256")
    provided_source_hash = run_provenance.get("source_sha256")
    if provided_source_hash is not None and provided_source_hash != expected_source_hash:
        raise DataError("input provenance source_sha256 differs from the matrix script SHA-256")
    source_sha256 = str(expected_source_hash)
    if not re.fullmatch(r"[0-9a-f]{64}", source_sha256):
        raise DataError("matrix case source SHA-256 is invalid")
    wall_time = run_provenance.get("wall_time_s", completion.get("wall_time_s"))
    if wall_time is not None:
        wall_time = _as_finite_number(wall_time, "wall_time_s")
        if wall_time < 0:
            raise DataError("wall_time_s cannot be negative")
    film_initial, dot_mx, material = _spec_fields(spec)
    return {
        "case_id": case_id,
        "run_id": chosen_run_id,
        "source_sha256": source_sha256,
        "status": "completed",
        "steps": steps,
        "max_steps": max_steps,
        "converged": converged,
        "max_torque_T": max_torque,
        "wall_time_s": wall_time,
        "energies_J": energies,
        "execution": execution,
        "material": material,
        "film_initial": film_initial,
        "dot_mx": dot_mx,
        "completion": completion,
        "provenance": {
            "run_record": run_provenance,
            "native_execution_provenance": provenance_execution,
            "native_requested_execution": requested,
            "native_source_hash": metadata.get("source_hash"),
        },
    }


def _execution_plan_layers(metadata: dict[str, Any]) -> dict[str, dict[str, Any]]:
    execution_plan = metadata.get("execution_plan")
    backend_plan = execution_plan.get("backend_plan") if isinstance(execution_plan, dict) else None
    raw_layers = backend_plan.get("layers") if isinstance(backend_plan, dict) else None
    if not isinstance(raw_layers, list):
        raise DataError("native metadata has no execution_plan.backend_plan.layers")
    layers: dict[str, dict[str, Any]] = {}
    for item in raw_layers:
        if not isinstance(item, dict):
            raise DataError("execution plan contains a malformed layer")
        object_id = item.get("object_id")
        if not isinstance(object_id, str) or not object_id:
            continue
        if object_id in layers:
            raise DataError(f"duplicate execution-plan object_id {object_id!r}")
        layers[object_id] = item
    expected = {"bimeron-film", "upper-cylinder"}
    if set(layers) != expected:
        raise DataError(f"execution-plan layers {sorted(layers)} do not match {sorted(expected)}")
    return layers


def _validate_runtime_materials(metadata: dict[str, Any], spec: dict[str, Any]) -> None:
    plan_layers = _execution_plan_layers(metadata)
    film_expected = spec["film_material"]
    cylinder_expected = {"Ms_A_per_m": 1.3e6, "Aex_J_per_m": 10e-12, "Ku1_J_per_m3": 0.0, "D_J_per_m2": 0.0}
    for object_id, expected in (("bimeron-film", film_expected), ("upper-cylinder", cylinder_expected)):
        layer = plan_layers[object_id]
        material = layer.get("material")
        if not isinstance(material, dict):
            raise DataError(f"execution-plan layer {object_id} has no material fields")
        aliases = {
            "Ms_A_per_m": "saturation_magnetisation",
            "Aex_J_per_m": "exchange_stiffness",
            "Ku1_J_per_m3": "uniaxial_anisotropy_ku1",
        }
        for field_name, plan_name in aliases.items():
            actual = _as_finite_number(material.get(plan_name), f"{object_id}.{plan_name}")
            target = _as_finite_number(expected[field_name], f"expected {field_name}")
            if not math.isclose(actual, target, rel_tol=1e-12, abs_tol=1e-18):
                raise DataError(f"{object_id}: {plan_name}={actual} does not match matrix value {target}")
        expected_dmi = _as_finite_number(expected.get("D_J_per_m2", 0.0), f"{object_id}.expected D")
        actual_dmi = _as_finite_number(layer.get("rotated_interfacial_dmi", 0.0), f"{object_id}.rotated_interfacial_dmi")
        if not math.isclose(actual_dmi, expected_dmi, rel_tol=0, abs_tol=1e-15):
            raise DataError(f"{object_id}: rotated interfacial DMI {actual_dmi} does not match matrix value {expected_dmi}")
    if plan_layers["upper-cylinder"].get("rotated_interfacial_dmi") not in (0, 0.0, None):
        raise DataError("upper cylinder must not have rotated interfacial DMI")


def _load_run_provenance(input_dir: Path) -> tuple[dict[str, Any], Path | None]:
    candidates = [
        input_dir / "provenance.json",
        input_dir / "run-provenance.json",
        input_dir / "native" / "provenance.json",
        input_dir / "native" / "run-provenance.json",
    ]
    found = [path for path in candidates if path.is_file()]
    if len(found) > 1:
        raise DataError(f"ambiguous run provenance files: {', '.join(str(path) for path in found)}")
    if not found:
        return {}, None
    return _read_json(found[0]), found[0]


def _load_accepted_worker_directory(
    input_dir: Path,
    manifest: dict[str, Any],
    specs: dict[str, dict[str, Any]],
    requested_case_id: str | None,
    cli_run_id: str | None,
) -> CaseData:
    input_dir = Path(os.path.abspath(input_dir))
    _require_plain_directory(input_dir)
    input_dir = input_dir.resolve()

    metadata_candidates = [input_dir / "native" / "metadata.json", input_dir / "metadata.json"]
    scalar_candidates = [input_dir / "native" / "scalars.csv", input_dir / "scalars.csv"]
    field_manifest_candidates = [input_dir / "fields" / "m" / "manifest.json", input_dir / "native" / "fields" / "m" / "manifest.json"]
    metadata_path = _find_one(metadata_candidates, "native metadata.json")
    scalar_path = _find_one(scalar_candidates, "native scalars.csv")
    fields_manifest_path = _find_one(field_manifest_candidates, "fields/m/manifest.json")
    metadata = _read_json(metadata_path)
    fields_manifest = _read_json(fields_manifest_path)
    if fields_manifest.get("schema_version") != "fdm_multilayer_field_manifest.v1" or fields_manifest.get("observable") != "m":
        raise DataError("fields/m manifest is not an FDM multilayer magnetization manifest")
    if fields_manifest.get("component_order") != ["x", "y", "z"]:
        raise DataError("fields/m manifest component order must be xyz")
    field_root = fields_manifest_path.parent
    provenance, provenance_path = _load_run_provenance(input_dir)
    hinted_case_id = requested_case_id or provenance.get("case_id") or metadata.get("problem_name")
    case_id = _case_id(hinted_case_id)
    spec = specs.get(case_id)
    if spec is None:
        raise DataError(f"case_id {case_id!r} is not present in the matrix manifest")
    if requested_case_id and provenance.get("case_id") and provenance["case_id"] != requested_case_id:
        raise DataError("--case-id disagrees with the provenance case_id")
    if metadata.get("problem_name") and metadata.get("problem_name") != case_id:
        raise DataError("native problem_name disagrees with selected case_id")
    _validate_runtime_materials(metadata, spec)
    columns, scalar_values, scalar_lookup = _load_scalars_csv(scalar_path)
    summary = _extract_run_summary(metadata, provenance, cli_run_id, spec, columns, scalar_values, scalar_lookup)

    layout = metadata.get("artifact_layout")
    layout_layers = layout.get("layers") if isinstance(layout, dict) else None
    manifest_layers = fields_manifest.get("layers")
    if not isinstance(layout_layers, list) or not isinstance(manifest_layers, list):
        raise DataError("native metadata or fields/m manifest lacks layer layout")
    layout_by_id: dict[str, dict[str, Any]] = {}
    for item in layout_layers:
        if not isinstance(item, dict) or not isinstance(item.get("object_id"), str):
            raise DataError("artifact_layout has a malformed layer")
        object_id = item["object_id"]
        if object_id in layout_by_id:
            raise DataError(f"duplicate artifact-layout object_id {object_id!r}")
        layout_by_id[object_id] = item
    plan_layers = _execution_plan_layers(metadata)
    required_ids = {"bimeron-film", "upper-cylinder"}
    if set(layout_by_id) != required_ids:
        raise DataError(f"artifact layout layers {sorted(layout_by_id)} do not match the matrix objects")
    manifest_by_id: dict[str, dict[str, Any]] = {}
    for item in manifest_layers:
        if not isinstance(item, dict) or not isinstance(item.get("object_id"), str):
            raise DataError("fields/m manifest contains a malformed layer")
        if item["object_id"] in manifest_by_id:
            raise DataError(f"duplicate fields/m object_id {item['object_id']!r}")
        manifest_by_id[item["object_id"]] = item
    if set(manifest_by_id) != required_ids:
        raise DataError(f"fields/m layers {sorted(manifest_by_id)} do not match the matrix objects")

    terminal_step = summary["steps"]
    layers: dict[str, LayerData] = {}
    field_hashes: dict[str, str] = {}
    for key, object_id in (("film", "bimeron-film"), ("cylinder", "upper-cylinder")):
        layout_entry = layout_by_id[object_id]
        manifest_entry = manifest_by_id[object_id]
        directory_name = manifest_entry.get("directory")
        if not isinstance(directory_name, str) or not directory_name.startswith("layer-") or Path(directory_name).name != directory_name:
            raise DataError(f"{object_id}: invalid per-layer directory in fields/m manifest")
        if manifest_entry.get("file_pattern") not in (None, f"{directory_name}/step_{{step:06}}.json"):
            raise DataError(f"{object_id}: unexpected field file pattern")
        initial_path = field_root / directory_name / "step_000000.json"
        final_path = field_root / directory_name / f"step_{terminal_step:06d}.json"
        _require_plain_directory(initial_path.parent)
        _require_plain_file(initial_path)
        if not final_path.is_file():
            raise DataError(
                f"pending: missing terminal M field for {object_id} at accepted step {terminal_step}; "
                "initial state will not be copied as final"
            )
        _require_plain_file(final_path)
        initial_field = _read_json(initial_path)
        final_field = initial_field if initial_path == final_path else _read_json(final_path)
        for label, field, expected_step in (("initial", initial_field, 0), ("final", final_field, terminal_step)):
            if field.get("observable") != "m" or field.get("step") != expected_step:
                raise DataError(f"{object_id}: {label} field quantity/step does not match its path")
            if field.get("component_count") != 3 or field.get("component_order") != "xyz":
                raise DataError(f"{object_id}: {label} field must contain xyz vectors")
            if field.get("location") != "cell" or field.get("scope") != "layer":
                raise DataError(f"{object_id}: {label} field is not a per-cell layer field")
            field_layer = field.get("layer")
            if not isinstance(field_layer, dict) or field_layer.get("object_id") != object_id:
                raise DataError(f"{object_id}: {label} field layer identity mismatch")
            if field_layer.get("native_grid") != layout_entry.get("native_grid"):
                raise DataError(f"{object_id}: {label} field grid differs from native artifact layout")
            if not isinstance(field.get("provenance"), dict):
                raise DataError(f"{object_id}: {label} field has no execution provenance")
        layer_entry = dict(manifest_entry)
        for field_name in ("native_grid", "native_origin", "native_cell_size", "native_region_mask", "native_active_mask", "active_cell_count"):
            if field_name not in layer_entry and field_name in layout_entry:
                layer_entry[field_name] = layout_entry[field_name]
            if field_name not in layer_entry and field_name in initial_field["layer"]:
                layer_entry[field_name] = initial_field["layer"][field_name]
        if layer_entry.get("native_grid") != layout_entry.get("native_grid"):
            raise DataError(f"{object_id}: per-layer manifest grid differs from artifact layout")
        layer = _make_layer_data(
            key,
            layer_entry,
            plan_layers[object_id],
            initial_field.get("values"),
            final_field.get("values"),
            manifest,
        )
        layers[key] = layer
        field_hashes[f"{key}.initial"] = _sha256_file(initial_path)
        field_hashes[f"{key}.final"] = _sha256_file(final_path)

    input_hashes = {
        "native_metadata_sha256": _sha256_file(metadata_path),
        "scalars_sha256": _sha256_file(scalar_path),
        "field_manifest_sha256": _sha256_file(fields_manifest_path),
        **{f"field_{name}_sha256": digest for name, digest in field_hashes.items()},
    }
    if provenance_path is not None:
        input_hashes["run_provenance_sha256"] = _sha256_file(provenance_path)
    summary["provenance"] = {
        **summary["provenance"],
        "accepted_worker_field_manifest": fields_manifest,
        "native_metadata_path_name": metadata_path.name,
        "scalars_path_name": scalar_path.name,
        "input_file_hashes": input_hashes,
    }
    return CaseData(
        **{key: summary[key] for key in (
            "case_id", "run_id", "source_sha256", "status", "steps", "max_steps", "converged",
            "max_torque_T", "wall_time_s", "energies_J", "execution", "material", "film_initial", "dot_mx", "completion",
        )},
        layers=layers,
        scalar_columns=columns,
        scalar_values=scalar_values,
        provenance=summary["provenance"],
        input_hashes=input_hashes,
        input_kind="accepted_worker_field_json",
    )


def _npz_text_scalar(archive: Any, key: str) -> str:
    if key not in archive.files:
        raise DataError(f"NPZ is missing required {key!r}")
    value = np.asarray(archive[key])
    if value.shape not in ((), (1,)) or value.dtype.kind not in "US":
        raise DataError(f"NPZ {key!r} must be a UTF-8 string scalar")
    scalar = value.item()
    if isinstance(scalar, bytes):
        try:
            return scalar.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise DataError(f"NPZ {key!r} is not UTF-8") from exc
    return str(scalar)


def _npz_array(archive: Any, key: str, dtype: Any | None = None) -> np.ndarray:
    if key not in archive.files:
        raise DataError(f"pending: NPZ is missing required array {key!r}")
    value = np.asarray(archive[key])
    if value.dtype.kind not in "biuf":
        raise DataError(f"NPZ array {key!r} has unsupported dtype {value.dtype}")
    array = np.asarray(value, dtype=dtype) if dtype is not None else value
    if array.dtype.kind in "fc" and not np.isfinite(array).all():
        raise DataError(f"NPZ array {key!r} contains NaN or infinity")
    return array


def _load_explicit_npz(
    path: Path,
    manifest: dict[str, Any],
    specs: dict[str, dict[str, Any]],
    requested_case_id: str | None,
    cli_run_id: str | None,
    *,
    allow_test_fixture: bool = False,
) -> CaseData:
    _require_plain_file(path)
    try:
        archive = np.load(path, allow_pickle=False)
    except (OSError, ValueError) as exc:
        raise DataError(f"cannot open NPZ {path}: {exc}") from exc
    with archive:
        try:
            metadata = json.loads(_npz_text_scalar(archive, "metadata_json"))
        except json.JSONDecodeError as exc:
            raise DataError(f"NPZ metadata_json is invalid: {exc}") from exc
        if not isinstance(metadata, dict) or metadata.get("schema_version") != ARRAYS_SCHEMA:
            raise DataError(f"NPZ metadata must use schema {ARRAYS_SCHEMA!r}")
        if metadata.get("test_fixture_only") is True and not allow_test_fixture:
            raise DataError("synthetic test fixtures are not accepted by the production collector")
        case_id = _case_id(requested_case_id or metadata.get("case_id"))
        if metadata.get("case_id") != case_id:
            raise DataError("NPZ metadata case_id disagrees with selected case_id")
        spec = specs.get(case_id)
        if spec is None:
            raise DataError(f"case_id {case_id!r} is not present in the matrix manifest")
        columns_text = _npz_text_scalar(archive, "scalar_columns_json")
        try:
            columns_json = json.loads(columns_text)
        except json.JSONDecodeError as exc:
            raise DataError(f"NPZ scalar_columns_json is invalid: {exc}") from exc
        if not isinstance(columns_json, list) or not all(isinstance(item, str) for item in columns_json):
            raise DataError("NPZ scalar_columns_json must be a list of strings")
        columns = tuple(columns_json)
        scalar_values, scalar_lookup = _load_scalar_arrays(columns, _npz_array(archive, "scalars", np.float64))
        run_provenance = metadata.get("provenance")
        if not isinstance(run_provenance, dict):
            raise DataError("NPZ metadata must contain a provenance object")
        summary = _extract_run_summary(metadata, run_provenance, cli_run_id, spec, columns, scalar_values, scalar_lookup)
        layer_specs = metadata.get("layers")
        if not isinstance(layer_specs, dict) or set(layer_specs) != {"film", "cylinder"}:
            raise DataError("NPZ metadata layers must contain exactly film and cylinder")
        layers: dict[str, LayerData] = {}
        for key in ("film", "cylinder"):
            layer_spec = layer_specs[key]
            if not isinstance(layer_spec, dict):
                raise DataError(f"NPZ {key} layer metadata is malformed")
            object_id = "bimeron-film" if key == "film" else "upper-cylinder"
            grid = _npz_array(archive, f"{key}_native_grid", np.int64)
            origin = _npz_array(archive, f"{key}_native_origin_m", np.float64)
            cell = _npz_array(archive, f"{key}_cell_size_m", np.float64)
            mask = _npz_array(archive, f"{key}_mask", np.uint8)
            if grid.shape != (3,) or origin.shape != (3,) or cell.shape != (3,):
                raise DataError(f"NPZ {key} grid/origin/cell arrays must have length 3")
            grid_tuple = tuple(_as_nonnegative_integer(item, f"NPZ {key} grid") for item in grid.tolist())
            nx, ny, nz = grid_tuple
            expected_shape = (nz, ny, nx, 3)
            initial = _npz_array(archive, f"{key}_initial_m", np.float64)
            final = _npz_array(archive, f"{key}_final_m", np.float64)
            if initial.shape != expected_shape:
                raise DataError(f"NPZ {key} initial M shape {initial.shape}, expected {expected_shape}")
            if final.shape != expected_shape:
                raise DataError(f"NPZ {key} final M shape {final.shape}, expected {expected_shape}")
            mask_shape = (nz, ny, nx)
            if mask.shape != mask_shape or np.any((mask != 0) & (mask != 1)):
                raise DataError(f"NPZ {key} mask shape/values are invalid")
            layer = LayerData(
                key=key,
                object_id=str(layer_spec.get("object_id", object_id)),
                magnet_name=str(layer_spec.get("magnet_name", object_id)),
                native_grid=grid_tuple,
                native_origin_m=origin,
                cell_size_m=cell,
                active_mask=mask.astype(np.bool_),
                initial_m=initial,
                final_m=final,
                source_metadata=layer_spec,
            )
            if layer.object_id != object_id:
                raise DataError(f"NPZ {key} object_id does not match the matrix contract")
            if not np.isfinite(initial).all() or not np.isfinite(final).all():
                raise DataError(f"NPZ {key} M arrays contain NaN or infinity")
            if not layer.active_mask.any():
                raise DataError(f"NPZ {key} active mask is empty")
            if np.any(np.linalg.norm(initial[layer.active_mask], axis=1) <= 0) or np.any(np.linalg.norm(final[layer.active_mask], axis=1) <= 0):
                raise DataError(f"NPZ {key} active M includes a zero vector")
            _validate_layer_geometry(layer, manifest)
            layers[key] = layer
        if "final_film_m" not in archive.files or "final_cylinder_m" not in archive.files:
            raise DataError("pending: NPZ has no final M array for both objects; initial arrays will not be copied")
        input_hashes = {"npz_sha256": _sha256_file(path)}
        summary["provenance"] = {
            **summary["provenance"],
            "npz_metadata": metadata,
            "input_file_hashes": input_hashes,
        }
    return CaseData(
        **{key: summary[key] for key in (
            "case_id", "run_id", "source_sha256", "status", "steps", "max_steps", "converged",
            "max_torque_T", "wall_time_s", "energies_J", "execution", "material", "film_initial", "dot_mx", "completion",
        )},
        layers=layers,
        scalar_columns=columns,
        scalar_values=scalar_values,
        provenance=summary["provenance"],
        input_hashes=input_hashes,
        input_kind="explicit_real_npz",
    )


def _unit_direction(values: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(values, axis=-1, keepdims=True)
    if np.any(norm <= 0) or not np.isfinite(norm).all():
        raise DataError("cannot render a zero or non-finite active magnetization vector")
    return values / norm


def _rgb(values: np.ndarray) -> np.ndarray:
    return np.clip(0.5 * (_unit_direction(values) + 1.0), 0.0, 1.0)


def _layer_top_surface(layer: LayerData, state: str) -> tuple[np.ndarray, np.ndarray]:
    vectors = layer.initial_m if state == "initial" else layer.final_m
    mask = layer.active_mask
    nz, ny, nx = mask.shape
    has_active = np.any(mask, axis=0)
    top_index = nz - 1 - np.argmax(mask[::-1], axis=0)
    y_index, x_index = np.indices((ny, nx))
    selected = vectors[top_index, y_index, x_index]
    colors = np.zeros((ny, nx, 3), dtype=np.float64)
    colors[has_active] = _rgb(selected[has_active])
    return colors, has_active


def _layer_center_z(layer: LayerData) -> float:
    return float(layer.native_origin_m[2] + 0.5 * layer.native_grid[2] * layer.cell_size_m[2])


def _render_2d(case: CaseData, state: str, target: Path) -> None:
    fig, ax = plt.subplots(figsize=PNG_SIZE_INCHES, dpi=PNG_DPI)
    fig.subplots_adjust(left=0.11, right=0.98, bottom=0.11, top=0.88)
    for layer_index, layer in enumerate(sorted(case.layers.values(), key=_layer_center_z)):
        rgb, visible = _layer_top_surface(layer, state)
        rgba = np.concatenate((rgb, visible.astype(np.float64)[..., None]), axis=-1)
        nx, ny, _ = layer.native_grid
        dx, dy = layer.cell_size_m[:2]
        x0, y0 = layer.native_origin_m[:2]
        extent = (
            (x0 / 1e-9),
            ((x0 + nx * dx) / 1e-9),
            (y0 / 1e-9),
            ((y0 + ny * dy) / 1e-9),
        )
        ax.imshow(rgba, origin="lower", extent=extent, interpolation="nearest", zorder=layer_index + 2)
    ax.set_xlim(-310, 310)
    ax.set_ylim(-310, 310)
    ax.set_aspect("equal", adjustable="box")
    ax.set_xlabel("x [nm]")
    ax.set_ylabel("y [nm]")
    step = 0 if state == "initial" else case.steps
    ax.set_title(f"{case.case_id} · {state} M · accepted step {step}\n{COLOR_ENCODING}", fontsize=8)
    ax.grid(False)
    fig.savefig(
        target,
        format="png",
        dpi=PNG_DPI,
        metadata={"Software": PLOT_RENDERER, "Description": "Render z zapisanych danych M; nie jest zrzutem UI."},
    )
    plt.close(fig)


def _mask_row_runs(mask: np.ndarray) -> Iterable[tuple[int, int, int]]:
    """Return (row, col_start, col_stop) runs for true values in a 2D mask."""
    for row_index, row in enumerate(mask):
        padded = np.pad(np.asarray(row, dtype=np.int8), (1, 1))
        transitions = np.diff(padded)
        starts = np.flatnonzero(transitions == 1)
        stops = np.flatnonzero(transitions == -1)
        for start, stop in zip(starts.tolist(), stops.tolist()):
            yield row_index, start, stop


def _active_surface_faces(layer: LayerData) -> list[list[tuple[float, float, float]]]:
    """Build only exposed voxel faces, coalescing contiguous runs on each plane.

    The mask, rather than a bounding box, defines each face. This keeps the
    cylinder's stepped circular rim and any holes in an accepted native mask.
    Faces are grouped into row runs so the 600x600 film does not become hundreds
    of thousands of individual surface patches.
    """
    mask = layer.active_mask
    nz, ny, nx = mask.shape
    ox, oy, oz = layer.native_origin_m
    dx, dy, dz = layer.cell_size_m
    faces: list[list[tuple[float, float, float]]] = []

    # Horizontal faces. For every z cell, only active cells with no active
    # neighbor across that z face contribute to the visible material surface.
    for z_index in range(nz):
        lower = mask[z_index] & (True if z_index == 0 else ~mask[z_index - 1])
        upper = mask[z_index] & (True if z_index == nz - 1 else ~mask[z_index + 1])
        for exposed, face_z in ((lower, oz + z_index * dz), (upper, oz + (z_index + 1) * dz)):
            for y_index, x_start, x_stop in _mask_row_runs(exposed):
                x0 = ox + x_start * dx
                x1 = ox + x_stop * dx
                y0 = oy + y_index * dy
                y1 = y0 + dy
                z_nm = face_z / 1e-9
                faces.append([
                    (x0 / 1e-9, y0 / 1e-9, z_nm),
                    (x1 / 1e-9, y0 / 1e-9, z_nm),
                    (x1 / 1e-9, y1 / 1e-9, z_nm),
                    (x0 / 1e-9, y1 / 1e-9, z_nm),
                ])

    # Faces normal to x. Each plane is reduced to contiguous y-runs per z row.
    for x_index in range(nx):
        left = mask[:, :, x_index] & (True if x_index == 0 else ~mask[:, :, x_index - 1])
        right = mask[:, :, x_index] & (True if x_index == nx - 1 else ~mask[:, :, x_index + 1])
        for exposed, face_x in ((left, ox + x_index * dx), (right, ox + (x_index + 1) * dx)):
            for z_index, y_start, y_stop in _mask_row_runs(exposed):
                y0 = oy + y_start * dy
                y1 = oy + y_stop * dy
                z0 = oz + z_index * dz
                z1 = z0 + dz
                x_nm, y0_nm, y1_nm = face_x / 1e-9, y0 / 1e-9, y1 / 1e-9
                faces.append([
                    (x_nm, y0_nm, z0 / 1e-9),
                    (x_nm, y1_nm, z0 / 1e-9),
                    (x_nm, y1_nm, z1 / 1e-9),
                    (x_nm, y0_nm, z1 / 1e-9),
                ])

    # Faces normal to y. Each plane is reduced to contiguous x-runs per z row.
    for y_index in range(ny):
        lower = mask[:, y_index, :] & (True if y_index == 0 else ~mask[:, y_index - 1, :])
        upper = mask[:, y_index, :] & (True if y_index == ny - 1 else ~mask[:, y_index + 1, :])
        for exposed, face_y in ((lower, oy + y_index * dy), (upper, oy + (y_index + 1) * dy)):
            for z_index, x_start, x_stop in _mask_row_runs(exposed):
                x0 = ox + x_start * dx
                x1 = ox + x_stop * dx
                z0 = oz + z_index * dz
                z1 = z0 + dz
                y_nm, x0_nm, x1_nm = face_y / 1e-9, x0 / 1e-9, x1 / 1e-9
                faces.append([
                    (x0_nm, y_nm, z0 / 1e-9),
                    (x1_nm, y_nm, z0 / 1e-9),
                    (x1_nm, y_nm, z1 / 1e-9),
                    (x0_nm, y_nm, z1 / 1e-9),
                ])
    return faces


def _sample_active_points(mask: np.ndarray, maximum: int = MAX_3D_ARROWS_PER_LAYER) -> np.ndarray:
    """Select a deterministic, spatially distributed subset of active [z,y,x] cells."""
    active_points = np.argwhere(mask)
    if maximum <= 0:
        raise DataError("3D arrow sample limit must be positive")
    if len(active_points) <= maximum:
        return active_points
    sample_indices = np.linspace(0, len(active_points) - 1, num=maximum, dtype=np.int64)
    return active_points[sample_indices]


def _render_3d(case: CaseData, state: str, target: Path) -> None:
    fig = plt.figure(figsize=PNG_SIZE_INCHES, dpi=PNG_DPI)
    ax = fig.add_subplot(111, projection="3d")
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    # Draw the same two object surfaces and camera in all 12 scenarios; M is
    # shown by sampled arrows, while object colors stay fixed across cases.
    for layer in sorted(case.layers.values(), key=_layer_center_z):
        faces = _active_surface_faces(layer)
        ax.add_collection3d(Poly3DCollection(
            faces,
            facecolors=SURFACE_COLORS.get(layer.key, "#8a929a"),
            edgecolors="none",
            alpha=0.28,
            zsort="average",
        ))

    for layer in case.layers.values():
        vectors = layer.initial_m if state == "initial" else layer.final_m
        points = _sample_active_points(layer.active_mask)
        z_index, y_index, x_index = points.T
        nx, ny, nz = layer.native_grid
        ox, oy, oz = layer.native_origin_m
        dx, dy, dz = layer.cell_size_m
        x = (ox + (x_index + 0.5) * dx) / 1e-9
        y = (oy + (y_index + 0.5) * dy) / 1e-9
        z = (oz + (z_index + 0.5) * dz) / 1e-9
        m = vectors[z_index, y_index, x_index]
        colors = _rgb(m)
        ax.quiver(
            x, y, z,
            m[:, 0], m[:, 1], m[:, 2],
            length=2.4,
            normalize=True,
            arrow_length_ratio=0.30,
            linewidth=0.45,
            colors=colors,
        )
    ax.set_xlim(-310, 310)
    ax.set_ylim(-310, 310)
    ax.set_zlim(-5, 60)
    ax.set_box_aspect((600, 600, 65))
    ax.set_proj_type("ortho")
    ax.view_init(elev=CAMERA["elevation_deg"], azim=CAMERA["azimuth_deg"])
    ax.set_xlabel("x [nm]", labelpad=4)
    ax.set_ylabel("y [nm]", labelpad=4)
    ax.set_zlabel("z [nm]", labelpad=2)
    step = 0 if state == "initial" else case.steps
    ax.set_title(f"{case.case_id} · {state} M · accepted step {step}\n{COLOR_ENCODING}", fontsize=8, pad=10)
    fig.subplots_adjust(left=0.02, right=0.98, bottom=0.02, top=0.88)
    fig.savefig(
        target,
        format="png",
        dpi=PNG_DPI,
        metadata={"Software": PLOT_RENDERER, "Description": "Render z zapisanych danych M; nie jest zrzutem UI."},
    )
    plt.close(fig)


def render_case_pngs(case: CaseData, plot_directory: Path) -> dict[str, str]:
    _require_plain_directory(plot_directory.parent)
    if plot_directory.exists():
        raise DataError(f"plot output already exists and will not be overwritten: {plot_directory}")
    plot_directory.mkdir()
    outputs = {
        "initial_2d": plot_directory / "initial_2d.png",
        "initial_3d": plot_directory / "initial_3d.png",
        "final_2d": plot_directory / "final_2d.png",
        "final_3d": plot_directory / "final_3d.png",
    }
    _render_2d(case, "initial", outputs["initial_2d"])
    _render_3d(case, "initial", outputs["initial_3d"])
    _render_2d(case, "final", outputs["final_2d"])
    _render_3d(case, "final", outputs["final_3d"])
    hashes: dict[str, str] = {}
    for name, path in outputs.items():
        if not path.is_file() or path.stat().st_size == 0:
            raise DataError(f"renderer did not produce a non-empty {name} PNG")
        try:
            with Image.open(path) as image:
                if image.format != "PNG" or image.size != (PNG_SIZE_INCHES[0] * PNG_DPI, PNG_SIZE_INCHES[1] * PNG_DPI):
                    raise DataError(f"invalid PNG format or dimensions for {path}")
                image.verify()
        except (OSError, ValueError) as exc:
            raise DataError(f"invalid rendered PNG {path}: {exc}") from exc
        hashes[name] = _sha256_file(path)
    return hashes


def _zarr_group(path: Path, attrs: dict[str, Any] | None = None) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / ".zgroup").write_bytes(_json_bytes({"zarr_format": 2}))
    (path / ".zattrs").write_bytes(_json_bytes(attrs or {}))


def write_zarr_array(path: Path, array: np.ndarray, chunks: tuple[int, ...] | None = None, attrs: dict[str, Any] | None = None) -> None:
    """Write one standard uncompressed, C-order Zarr v2 array."""
    if path.exists():
        raise DataError(f"Zarr array already exists: {path}")
    value = np.asarray(array)
    if value.dtype.kind not in "biuf" or value.dtype.kind == "O":
        raise DataError(f"unsupported Zarr array dtype {value.dtype}")
    if value.dtype.kind in "fc" and not np.isfinite(value).all():
        raise DataError("refusing to export NaN or infinity to Zarr")
    if value.dtype.kind == "f":
        value = np.asarray(value, dtype="<f8", order="C")
        dtype = "<f8"
        fill_value: int | float = 0.0
    elif value.dtype.kind in "iu":
        if value.dtype.kind == "u" and value.dtype.itemsize == 1:
            value = np.asarray(value, dtype="|u1", order="C")
            dtype = "|u1"
        else:
            if value.dtype.kind == "u" and value.size and int(value.max()) > np.iinfo(np.int64).max:
                raise DataError("unsigned integer data exceed the supported int64 range")
            value = np.asarray(value, dtype="<i8", order="C")
            dtype = "<i8"
        fill_value = 0
    elif value.dtype.kind == "b":
        value = np.asarray(value, dtype="|u1", order="C")
        dtype = "|u1"
        fill_value = 0
    else:
        raise DataError(f"unsupported Zarr array dtype {value.dtype}")
    if value.ndim == 0 or any(dimension <= 0 for dimension in value.shape):
        raise DataError("Zarr arrays must have at least one positive dimension")
    if chunks is None:
        chunks = tuple(min(size, 64) for size in value.shape)
    if len(chunks) != value.ndim or any(isinstance(size, bool) or size <= 0 for size in chunks):
        raise DataError("Zarr chunk shape must be positive and match array rank")
    chunk_shape = tuple(min(int(size), int(length)) for size, length in zip(chunks, value.shape))
    path.mkdir(parents=True)
    metadata = {
        "zarr_format": 2,
        "shape": list(value.shape),
        "chunks": list(chunk_shape),
        "dtype": dtype,
        "compressor": None,
        "fill_value": fill_value,
        "order": "C",
        "filters": None,
        "dimension_separator": ".",
    }
    (path / ".zarray").write_bytes(_json_bytes(metadata))
    (path / ".zattrs").write_bytes(_json_bytes(attrs or {}))
    chunk_counts = [math.ceil(size / chunk) for size, chunk in zip(value.shape, chunk_shape)]
    import itertools

    for coordinates in itertools.product(*(range(count) for count in chunk_counts)):
        starts = tuple(coord * chunk for coord, chunk in zip(coordinates, chunk_shape))
        slices = tuple(slice(start, min(start + chunk, size)) for start, chunk, size in zip(starts, chunk_shape, value.shape))
        # Zarr v2 chunks keep the full declared chunk shape, including chunks
        # that overhang the array edge. Padding outside the logical array uses
        # the metadata fill value (zero here).
        chunk_data = np.zeros(chunk_shape, dtype=value.dtype)
        local_shape = tuple(part.stop - part.start for part in slices)
        local_slices = tuple(slice(0, length) for length in local_shape)
        chunk_data[local_slices] = value[slices]
        chunk_data = np.ascontiguousarray(chunk_data)
        key = ".".join(str(index) for index in coordinates)
        (path / key).write_bytes(chunk_data.tobytes(order="C"))


def read_zarr_array(path: Path) -> np.ndarray:
    """Read the exact uncompressed Zarr v2 subset emitted by this module."""
    metadata = _read_json(path / ".zarray")
    if (
        metadata.get("zarr_format") != 2
        or metadata.get("compressor") is not None
        or metadata.get("filters") not in (None, [])
        or metadata.get("order") != "C"
        or metadata.get("dimension_separator") not in (None, ".")
    ):
        raise DataError(f"unsupported Zarr v2 array encoding at {path}")
    shape, chunks = metadata.get("shape"), metadata.get("chunks")
    if not isinstance(shape, list) or not isinstance(chunks, list) or len(shape) != len(chunks) or not shape:
        raise DataError(f"invalid Zarr shape/chunks at {path}")
    dtype_name = metadata.get("dtype")
    if dtype_name not in ("<f8", "<i8", "|u1"):
        raise DataError(f"unsupported Zarr dtype {dtype_name!r} at {path}")
    dtype = np.dtype(dtype_name)
    result = np.zeros(tuple(shape), dtype=dtype)
    chunk_counts = [math.ceil(size / chunk) for size, chunk in zip(shape, chunks)]
    import itertools

    for coordinates in itertools.product(*(range(count) for count in chunk_counts)):
        starts = tuple(coord * chunk for coord, chunk in zip(coordinates, chunks))
        slices = tuple(slice(start, min(start + chunk, size)) for start, chunk, size in zip(starts, chunks, shape))
        chunk_path = path / ".".join(str(index) for index in coordinates)
        _require_plain_file(chunk_path)
        payload = chunk_path.read_bytes()
        expected_bytes = math.prod(chunks) * dtype.itemsize
        if len(payload) != expected_bytes:
            raise DataError(f"Zarr chunk {chunk_path} has {len(payload)} bytes; expected {expected_bytes}")
        full_chunk = np.frombuffer(payload, dtype=dtype).reshape(tuple(chunks), order="C")
        local_shape = tuple(part.stop - part.start for part in slices)
        local_slices = tuple(slice(0, length) for length in local_shape)
        result[slices] = full_chunk[local_slices]
    if result.dtype.kind == "f" and not np.isfinite(result).all():
        raise DataError(f"Zarr array at {path} contains NaN or infinity")
    return result


def write_case_zarr(case: CaseData, target: Path) -> None:
    if target.exists():
        raise DataError(f"Zarr output already exists and will not be overwritten: {target}")
    target.mkdir(parents=True)
    _zarr_group(target, {
        "schema_version": ZARR_SCHEMA,
        "case_id": case.case_id,
        "run_id": case.run_id,
        "source_sha256": case.source_sha256,
        "status": case.status,
        "steps": case.steps,
        "max_steps": case.max_steps,
        "converged": case.converged,
        "plot_provenance": {"kind": "data_render", "renderer": PLOT_RENDERER},
        "time_semantics": TIME_SEMANTICS,
        "provenance_group": "provenance",
    })
    initial_group = target / "initial"
    final_group = target / "final"
    _zarr_group(initial_group, {"accepted_step": 0, "physical_time_s": None, "time_semantics": TIME_SEMANTICS})
    _zarr_group(final_group, {"accepted_step": case.steps, "physical_time_s": None, "time_semantics": TIME_SEMANTICS})
    grid_group = target / "grid"
    mask_group = target / "masks"
    _zarr_group(grid_group)
    _zarr_group(mask_group)
    for layer_key, layer in case.layers.items():
        for state_name, values, state_root in (
            ("initial", layer.initial_m, initial_group),
            ("final", layer.final_m, final_group),
        ):
            object_group = state_root / layer_key
            _zarr_group(object_group, {"object_id": layer.object_id, "magnet_name": layer.magnet_name})
            write_zarr_array(
                object_group / "m",
                values,
                chunks=(1, min(64, values.shape[1]), min(64, values.shape[2]), 3),
                attrs={"unit": "1", "component_order": ["x", "y", "z"], "location": "cell"},
            )
        layer_grid = grid_group / layer_key
        _zarr_group(layer_grid, {"object_id": layer.object_id})
        write_zarr_array(layer_grid / "native_grid", np.asarray(layer.native_grid, dtype=np.int64), chunks=(3,), attrs={"axes": ["x", "y", "z"]})
        write_zarr_array(layer_grid / "native_origin_m", layer.native_origin_m, chunks=(3,), attrs={"unit": "m", "coordinate": "world lower cell corner"})
        write_zarr_array(layer_grid / "cell_size_m", layer.cell_size_m, chunks=(3,), attrs={"unit": "m"})
        write_zarr_array(mask_group / layer_key, layer.active_mask.astype(np.uint8), chunks=(1, min(64, layer.active_mask.shape[1]), min(64, layer.active_mask.shape[2])), attrs={"object_id": layer.object_id, "true_means": "active magnetic cell"})
    scalar_group = target / "scalars"
    _zarr_group(scalar_group, {"columns": list(case.scalar_columns), "units": "from native scalar artifact", "terminal_step": case.steps})
    write_zarr_array(scalar_group / "values", case.scalar_values, chunks=(min(128, case.scalar_values.shape[0]), case.scalar_values.shape[1]))
    provenance_group = target / "provenance"
    _zarr_group(provenance_group, {
        "schema_version": "fullmag.bimeron-matrix-provenance.v1",
        "input_kind": case.input_kind,
        "execution": case.execution,
        "material": case.material,
        "film_initial": case.film_initial,
        "dot_mx": case.dot_mx,
        "completion": case.completion,
        "source_provenance": case.provenance,
        "input_hashes": case.input_hashes,
        "layer_metadata": {key: layer.source_metadata for key, layer in case.layers.items()},
    })


def _collection_fragment(
    case: CaseData,
    plot_hashes: dict[str, str],
    output_root: Path,
    case_output: Path,
) -> dict[str, Any]:
    relative_case = case_output.relative_to(output_root).as_posix()
    plots = {name: f"{relative_case}/plots/{name}.png" for name in ("initial_2d", "initial_3d", "final_2d", "final_3d")}
    geometry = {
        "film_size_m": [600e-9, 600e-9, 10e-9],
        "cylinder_radius_m": 50e-9,
        "cylinder_height_m": 30e-9,
        "gap_m": 5e-9,
        "cell_m": [2.5e-9, 2.5e-9, 2.5e-9],
    }
    return {
        "schema_version": COLLECTION_SCHEMA,
        "case_id": case.case_id,
        "status": case.status,
        "steps": case.steps,
        "max_steps": case.max_steps,
        "converged": case.converged,
        "material": case.material,
        "film_initial": case.film_initial,
        "dot_mx": case.dot_mx,
        "run_id": case.run_id,
        "max_torque_T": case.max_torque_T,
        "wall_time_s": case.wall_time_s,
        "energies_J": case.energies_J,
        "execution": case.execution,
        "source_sha256": case.source_sha256,
        "geometry": geometry,
        "zarr_path": f"{relative_case}/result.zarr",
        "plots": plots,
        "plot_provenance": {
            "kind": "data_render",
            "renderer": PLOT_RENDERER,
            "ui_screenshot": False,
            "source_kind": case.input_kind,
            "initial_step": 0,
            "final_step": case.steps,
            "camera": CAMERA,
            "color_encoding": COLOR_ENCODING,
            "surface_colors": SURFACE_COLORS,
            "max_3d_arrows_per_layer": MAX_3D_ARROWS_PER_LAYER,
            "png_sha256": plot_hashes,
            "input_hashes": case.input_hashes,
        },
        "completion": case.completion,
        "time_semantics": TIME_SEMANTICS,
        "native_provenance": case.provenance,
    }


def _refuse_overwrite(path: Path) -> None:
    if path.exists() or _is_link(path):
        raise DataError(f"output exists and is preserved; choose a new output root: {path}")


def collect_case(
    input_path: Path,
    output_root: Path,
    *,
    case_id: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    manifest, specs = load_matrix_manifest()
    input_path = Path(os.path.abspath(input_path))
    if input_path.suffix.lower() == ".npz":
        case = _load_explicit_npz(input_path, manifest, specs, case_id, run_id)
    elif input_path.is_dir():
        case = _load_accepted_worker_directory(input_path, manifest, specs, case_id, run_id)
    else:
        raise DataError(f"input must be a case directory or an explicit NPZ file: {input_path}")

    output_root = Path(os.path.abspath(output_root))
    output_root_resolved = _validate_path_chain(output_root, allow_missing_leaf=True)
    input_resolved = _validate_path_chain(input_path)
    if input_resolved == output_root_resolved or input_resolved in output_root_resolved.parents or output_root_resolved in input_resolved.parents:
        raise DataError("input and output paths may not contain one another")
    if not output_root.exists():
        output_root.mkdir(parents=True, exist_ok=True)
    _require_plain_directory(output_root)
    output_root = output_root.resolve()
    case_output = output_root / case.case_id
    _refuse_overwrite(case_output)
    case_output.mkdir()
    plot_hashes = render_case_pngs(case, case_output / "plots")
    write_case_zarr(case, case_output / "result.zarr")
    fragment = _collection_fragment(case, plot_hashes, output_root, case_output)
    (case_output / "collection.json").write_bytes(_json_bytes(fragment))
    return fragment


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="completed case output directory or explicit real-M NPZ")
    parser.add_argument("--output-root", type=Path, required=True, help="new results root; existing case output is never overwritten")
    parser.add_argument("--case-id", help="matrix case ID; defaults to provenance or native problem_name")
    parser.add_argument("--run-id", help="run ID from the accepted-worker receipt when no provenance.json contains it")
    args = parser.parse_args(argv)
    try:
        fragment = collect_case(args.input, args.output_root, case_id=args.case_id, run_id=args.run_id)
    except (DataError, OSError) as exc:
        print(f"collection failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(fragment, sort_keys=True, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
