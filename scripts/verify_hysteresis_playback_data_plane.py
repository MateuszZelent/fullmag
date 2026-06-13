#!/usr/bin/env python3
"""Validate hysteresis magnetization playback through the API data plane."""

from __future__ import annotations

import csv
import json
import math
import struct
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


HEADER_LEN = 48
SNAPSHOT_ENDPOINT = "/v1/internal/live/current/snapshot"
POINTS_ENDPOINT = "/v2/sessions/current/analysis/hysteresis/stage_0/points"


def load_json(path: Path):
    return json.loads(path.read_text())


def request_json(method: str, url: str, payload: object | None = None):
    data = None
    headers = {"accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["content-type"] = "application/json"
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=10) as response:
            raw = response.read()
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"{method} {url} failed: HTTP {error.code}: {body}") from error
    except URLError as error:
        raise SystemExit(f"{method} {url} failed: {error}") from error
    return json.loads(raw.decode("utf-8"))


def request_bytes(url: str) -> tuple[bytes, dict[str, str]]:
    req = Request(url, headers={"accept": "application/octet-stream"}, method="GET")
    try:
        with urlopen(req, timeout=10) as response:
            headers = {key.lower(): value for key, value in response.headers.items()}
            return response.read(), headers
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"GET {url} failed: HTTP {error.code}: {body}") from error
    except URLError as error:
        raise SystemExit(f"GET {url} failed: {error}") from error


def sync_artifact_dir(api_base_url: str, artifact_dir: Path) -> None:
    session_id = "hysteresis-playback-data-plane"
    request_json(
        "POST",
        urljoin(api_base_url, SNAPSHOT_ENDPOINT),
        {
            "session_id": session_id,
            "session": {
                "session_id": session_id,
                "run_id": f"run-{session_id}",
                "status": "completed",
                "interactive_session_requested": False,
                "script_path": "examples/hysteresis_waveguide_300x50x10nm.py",
                "problem_name": "Hysteresis playback data-plane verification",
                "requested_backend": "fem",
                "explicit_selection": True,
                "requested_device": "auto",
                "requested_precision": "double",
                "requested_mode": "strict",
                "requested_cpu_threads": None,
                "execution_mode": "strict",
                "precision": "double",
                "resolved_backend": "fem",
                "resolved_device": "auto",
                "resolved_precision": "double",
                "resolved_mode": "strict",
                "resolved_runtime_family": "fem",
                "resolved_engine_id": None,
                "resolved_worker": None,
                "resolved_cpu_threads": None,
                "resolved_fallback": None,
                "artifact_dir": str(artifact_dir.resolve()),
                "started_at_unix_ms": 0,
                "finished_at_unix_ms": 0,
                "plan_summary": {},
            },
        },
    )


def find_snapshot_point(points: object) -> dict:
    if not isinstance(points, list) or not points:
        raise SystemExit("hysteresis points endpoint must return a non-empty list")
    for point in points:
        if not isinstance(point, dict):
            continue
        snapshot_id = point.get("snapshot_id")
        snapshot_ref = point.get("snapshot_vector_resource_ref")
        if isinstance(snapshot_id, str) and isinstance(snapshot_ref, str):
            if "component=full" not in snapshot_ref or "scope_kind=full" not in snapshot_ref:
                raise SystemExit(
                    "snapshot_vector_resource_ref must target full m playback: "
                    f"{snapshot_ref}"
                )
            return point
    raise SystemExit("no hysteresis point exposes snapshot_id and snapshot_vector_resource_ref")


def zarr_sample_for_snapshot(artifact_dir: Path, snapshot_id: str) -> tuple[Path, int, list[int]]:
    samples_path = artifact_dir / "hysteresis.zarr" / "fields" / "m" / "samples.csv"
    if not samples_path.is_file():
        raise SystemExit(f"missing hysteresis Zarr samples.csv: {samples_path}")
    with samples_path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("snapshot_id") == snapshot_id:
                chunk_key = row.get("chunk_key")
                if not chunk_key:
                    raise SystemExit(f"missing Zarr chunk_key for snapshot {snapshot_id}")
                try:
                    cell_count = int(row.get("cell_count", "0"))
                    grid = [
                        int(row.get("grid_x", "0")),
                        int(row.get("grid_y", "0")),
                        int(row.get("grid_z", "1") or "1"),
                    ]
                except ValueError as error:
                    raise SystemExit(f"invalid Zarr sample row for {snapshot_id}: {row}") from error
                return (
                    artifact_dir / "hysteresis.zarr" / "fields" / "m" / chunk_key,
                    cell_count,
                    grid,
                )
    raise SystemExit(f"missing Zarr sample row for snapshot {snapshot_id}")


def load_zarr_values(artifact_dir: Path, snapshot_id: str) -> tuple[list[float], list[int]]:
    chunk_path, cell_count, grid = zarr_sample_for_snapshot(artifact_dir, snapshot_id)
    raw = chunk_path.read_bytes()
    expected_bytes = cell_count * 3 * 8
    if len(raw) != expected_bytes:
        raise SystemExit(
            f"invalid Zarr chunk size for {snapshot_id}: got {len(raw)}, expected {expected_bytes}"
        )
    values = [0.0] * (cell_count * 3)
    for component in range(3):
        for cell in range(cell_count):
            source_offset = (component * cell_count + cell) * 8
            values[cell * 3 + component] = struct.unpack_from("<d", raw, source_offset)[0]
    return values, grid


def load_average_weights(artifact_dir: Path, sample_count: int) -> list[float] | None:
    zarr_root = artifact_dir / "hysteresis.zarr"
    field_root = zarr_root / "fields" / "m"
    root_attrs_path = zarr_root / ".zattrs"
    field_attrs_path = field_root / ".zattrs"
    if not root_attrs_path.is_file() or not field_attrs_path.is_file():
        return None
    root_attrs = load_json(root_attrs_path)
    field_attrs = load_json(field_attrs_path)
    root_ref = root_attrs.get("average_weights_ref")
    field_ref = field_attrs.get("average_weights_ref")
    if root_ref is None and field_ref is None:
        return None
    if root_ref != "fields/m/average_weights":
        raise SystemExit(
            "weighted hysteresis data-plane playback requires "
            "hysteresis.zarr/.zattrs average_weights_ref='fields/m/average_weights'"
        )
    if field_ref != "average_weights":
        raise SystemExit(
            "weighted hysteresis data-plane playback requires "
            "hysteresis.zarr/fields/m/.zattrs average_weights_ref='average_weights'"
        )

    weights_root = field_root / "average_weights"
    zarray_path = weights_root / ".zarray"
    if not zarray_path.is_file():
        raise SystemExit(f"missing average_weights Zarr array: {zarray_path}")
    zarray = load_json(zarray_path)
    if zarray.get("shape") != [sample_count] or zarray.get("chunks") != [sample_count]:
        raise SystemExit(
            "invalid average_weights Zarr shape/chunks: "
            f"shape={zarray.get('shape')!r} chunks={zarray.get('chunks')!r}"
        )
    if zarray.get("dtype") != "<f8":
        raise SystemExit(f"unexpected average_weights dtype: {zarray.get('dtype')!r}")
    chunk_path = weights_root / "0"
    if not chunk_path.is_file():
        raise SystemExit(f"missing average_weights Zarr chunk: {chunk_path}")
    raw = chunk_path.read_bytes()
    expected_bytes = sample_count * 8
    if len(raw) != expected_bytes:
        raise SystemExit(
            f"invalid average_weights chunk size: got {len(raw)}, expected {expected_bytes}"
        )
    return [struct.unpack_from("<d", raw, index * 8)[0] for index in range(sample_count)]


def decode_fmvp(payload: bytes) -> tuple[str, int, list[int], list[float]]:
    if len(payload) < HEADER_LEN:
        raise SystemExit(f"FMVP payload too short: {len(payload)} bytes")
    if payload[:4] != b"FMVP":
        raise SystemExit("FMVP payload has invalid magic")
    version = payload[4]
    kind = payload[5]
    n_comp = payload[6]
    if version != 2 or kind != 1:
        raise SystemExit(f"unsupported FMVP header: version={version} kind={kind}")
    value_count = int.from_bytes(payload[12:16], "little")
    grid = [
        int.from_bytes(payload[16:20], "little"),
        int.from_bytes(payload[20:24], "little"),
        int.from_bytes(payload[24:28], "little"),
    ]
    quantity_raw = payload[28:44].split(b"\0", 1)[0]
    quantity_id = quantity_raw.decode("utf-8")
    expected_len = HEADER_LEN + value_count * 8
    if len(payload) != expected_len:
        raise SystemExit(f"FMVP payload size mismatch: got {len(payload)}, expected {expected_len}")
    if value_count != grid[0] * grid[1] * grid[2] * n_comp:
        raise SystemExit("FMVP value count does not match grid and component count")
    values = [
        struct.unpack_from("<d", payload, HEADER_LEN + index * 8)[0]
        for index in range(value_count)
    ]
    return quantity_id, n_comp, grid, values


def assert_values_match(snapshot_id: str, api_values: list[float], zarr_values: list[float]) -> None:
    if len(api_values) != len(zarr_values):
        raise SystemExit(
            f"value count mismatch for {snapshot_id}: API={len(api_values)} Zarr={len(zarr_values)}"
        )
    for index, (actual, expected) in enumerate(zip(api_values, zarr_values)):
        if not math.isclose(actual, expected, rel_tol=0.0, abs_tol=1e-12):
            raise SystemExit(
                f"API data-plane vector mismatch for {snapshot_id} value {index}: "
                f"got {actual}, expected {expected}"
            )


def assert_count_header(
    headers: dict[str, str],
    header_name: str,
    expected: int,
    snapshot_id: str,
) -> None:
    raw_value = headers.get(header_name)
    try:
        actual = int(str(raw_value))
    except (TypeError, ValueError) as exc:
        raise SystemExit(
            f"{header_name} must be an integer for {snapshot_id}: got {raw_value!r}"
        ) from exc
    if actual != expected:
        raise SystemExit(
            f"{header_name} mismatch for {snapshot_id}: got {actual}, expected {expected}"
        )


def average_api_values(
    snapshot_id: str,
    api_values: list[float],
    average_weights: list[float] | None,
) -> list[float]:
    if len(api_values) == 0 or len(api_values) % 3 != 0:
        raise SystemExit(
            f"API data-plane vector payload for {snapshot_id} must contain 3 components per sample"
        )
    sample_count = len(api_values) // 3
    if average_weights is not None and len(average_weights) != sample_count:
        raise SystemExit(
            f"average_weights length mismatch for {snapshot_id}: "
            f"got {len(average_weights)}, expected {sample_count}"
        )
    totals = [0.0, 0.0, 0.0]
    weight_sum = 0.0
    for sample_index in range(sample_count):
        weight = 1.0 if average_weights is None else float(average_weights[sample_index])
        if not math.isfinite(weight) or weight <= 0.0:
            continue
        for component in range(3):
            totals[component] += api_values[sample_index * 3 + component] * weight
        weight_sum += weight
    if weight_sum <= 0.0:
        raise SystemExit(f"average_weights for {snapshot_id} must contain a positive weight")
    return [component_total / weight_sum for component_total in totals]


def assert_api_average_matches_point(
    snapshot_id: str,
    point: dict,
    api_values: list[float],
    average_weights: list[float] | None,
) -> None:
    point_average = point.get("m_avg")
    if not isinstance(point_average, list) or len(point_average) != 3:
        raise SystemExit(f"invalid m_avg for {snapshot_id}: {point_average!r}")
    api_average = average_api_values(snapshot_id, api_values, average_weights)
    for component, (actual, expected) in enumerate(zip(point_average, api_average)):
        if not math.isfinite(float(actual)) or not math.isclose(
            float(actual),
            expected,
            rel_tol=0.0,
            abs_tol=1e-12,
        ):
            raise SystemExit(
                f"m_avg does not match API data-plane snapshot for {snapshot_id} "
                f"component {component}: got {actual}, expected {expected}"
            )


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: scripts/verify_hysteresis_playback_data_plane.py "
            "<api-base-url> <artifact-dir>"
        )

    api_base_url = sys.argv[1].rstrip("/") + "/"
    artifact_dir = Path(sys.argv[2])
    if not artifact_dir.is_dir():
        raise SystemExit(f"artifact directory does not exist: {artifact_dir}")

    sync_artifact_dir(api_base_url, artifact_dir)
    points = request_json("GET", urljoin(api_base_url, POINTS_ENDPOINT))
    point = find_snapshot_point(points)
    snapshot_id = point["snapshot_id"]
    snapshot_ref = point["snapshot_vector_resource_ref"]
    payload, headers = request_bytes(urljoin(api_base_url, snapshot_ref))

    if headers.get("x-fullmag-snapshot-id") != snapshot_id:
        raise SystemExit(
            "data-plane snapshot header mismatch: "
            f"got {headers.get('x-fullmag-snapshot-id')!r}, expected {snapshot_id!r}"
        )
    if headers.get("x-fullmag-quantity-id") != "m":
        raise SystemExit(f"data-plane quantity header mismatch: {headers.get('x-fullmag-quantity-id')!r}")
    if headers.get("x-fullmag-component") != "full":
        raise SystemExit(f"data-plane component header mismatch: {headers.get('x-fullmag-component')!r}")

    quantity_id, n_comp, grid, api_values = decode_fmvp(payload)
    if quantity_id != "m" or n_comp != 3:
        raise SystemExit(f"unexpected FMVP vector identity: quantity={quantity_id!r} n_comp={n_comp}")
    assert_count_header(headers, "x-fullmag-point-count", len(api_values) // n_comp, snapshot_id)
    assert_count_header(headers, "x-fullmag-value-count", len(api_values), snapshot_id)
    zarr_values, zarr_grid = load_zarr_values(artifact_dir, snapshot_id)
    if grid != zarr_grid:
        raise SystemExit(f"FMVP grid mismatch for {snapshot_id}: API={grid} Zarr={zarr_grid}")
    assert_values_match(snapshot_id, api_values, zarr_values)
    average_weights = load_average_weights(artifact_dir, len(api_values) // 3)
    assert_api_average_matches_point(snapshot_id, point, api_values, average_weights)

    print(
        "validated hysteresis data-plane playback: "
        f"points={len(points)} snapshot_id={snapshot_id} values={len(api_values)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
