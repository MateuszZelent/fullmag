#!/usr/bin/env python3
"""Unit tests for hysteresis playback API/data-plane validation."""

from __future__ import annotations

import json
import shutil
import struct
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_hysteresis_playback_data_plane.py"


def write_playback_fixture(
    root: Path,
    *,
    average_weights: list[float] | None = None,
    point_average: list[float] | None = None,
) -> None:
    field_root = root / "hysteresis.zarr" / "fields" / "m"
    field_root.mkdir(parents=True)
    (root / "hysteresis_snapshots" / "hysteresis_point_001").mkdir(parents=True)
    expected_average = point_average or [0.5, 0.5, 0.0]

    (root / "hysteresis_points.json").write_text(
        json.dumps(
            [
                {
                    "point_id": 0,
                    "field_value_mT": 25.0,
                    "m_avg": expected_average,
                    "snapshot_id": "hysteresis_point_001",
                }
            ]
        )
    )
    (root / "hysteresis.zarr" / ".zgroup").write_text(json.dumps({"zarr_format": 2}))
    root_attrs = {"preferred_container": "zarr", "quantity_ids": ["m"]}
    field_attrs = {
        "quantity_id": "m",
        "axes": ["point", "component", "spatial_sample"],
        "storage_layout": "soa_component_major",
        "cell_count": 2,
    }
    if average_weights is not None:
        root_attrs["average_weights_ref"] = "fields/m/average_weights"
        field_attrs["average_weights_ref"] = "average_weights"
    (root / "hysteresis.zarr" / ".zattrs").write_text(json.dumps(root_attrs))
    (field_root / ".zarray").write_text(
        json.dumps(
            {
                "zarr_format": 2,
                "shape": [1, 3, 2],
                "chunks": [1, 3, 2],
                "dtype": "<f8",
                "compressor": None,
                "fill_value": 0.0,
                "order": "C",
                "filters": None,
                "dimension_separator": ".",
            }
        )
    )
    (field_root / ".zattrs").write_text(json.dumps(field_attrs))
    (field_root / "samples.csv").write_text(
        "\n".join(
            [
                "sample_index,snapshot_id,point_id,field_value_mT,quantity_id,chunk_key,grid_x,grid_y,cell_count,grid_z,component_count,dtype",
                "0,hysteresis_point_001,0,25.0,m,0.0.0,2,1,2,1,3,<f8",
            ]
        )
        + "\n"
    )
    (field_root / "0.0.0").write_bytes(
        b"".join(struct.pack("<d", value) for value in [1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    )
    if average_weights is not None:
        weights_root = field_root / "average_weights"
        weights_root.mkdir()
        (weights_root / ".zarray").write_text(
            json.dumps(
                {
                    "zarr_format": 2,
                    "shape": [len(average_weights)],
                    "chunks": [len(average_weights)],
                    "dtype": "<f8",
                    "compressor": None,
                    "fill_value": 0.0,
                    "order": "C",
                    "filters": None,
                    "dimension_separator": ".",
                }
            )
        )
        (weights_root / "0").write_bytes(
            b"".join(struct.pack("<d", value) for value in average_weights)
        )
    (root / "hysteresis_snapshots" / "hysteresis_point_001" / "m.json").write_text(
        json.dumps(
            {
                "quantity_id": "m",
                "snapshot_id": "hysteresis_point_001",
                "layout": {"grid_cells": [2, 1, 1]},
                "values": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            }
        )
    )


def fmvp_payload(values: list[float], *, quantity_id: str = "m") -> bytes:
    payload = bytearray()
    payload.extend(b"FMVP")
    payload.extend([2, 1, 3, 0])
    payload.extend((0).to_bytes(4, "little"))
    payload.extend((len(values)).to_bytes(4, "little"))
    payload.extend((2).to_bytes(4, "little"))
    payload.extend((1).to_bytes(4, "little"))
    payload.extend((1).to_bytes(4, "little"))
    quantity_bytes = quantity_id.encode("utf-8")[:16]
    payload.extend(quantity_bytes)
    payload.extend(b"\0" * (16 - len(quantity_bytes)))
    payload.extend(b"\0" * 4)
    for value in values:
        payload.extend(struct.pack("<d", value))
    return bytes(payload)


class HysteresisApiHandler(BaseHTTPRequestHandler):
    point_m_avg = [0.5, 0.5, 0.0]
    point_count_header = "2"
    value_count_header = "6"
    received_snapshot_payload: dict | None = None
    vector_requests: list[str] = []

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_POST(self) -> None:
        if self.path != "/v1/internal/live/current/snapshot":
            self.send_error(404)
            return
        length = int(self.headers.get("content-length", "0"))
        HysteresisApiHandler.received_snapshot_payload = json.loads(
            self.rfile.read(length).decode("utf-8")
        )
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/v2/sessions/current/analysis/hysteresis/stage_0/points":
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    [
                        {
                            "point_id": 0,
                            "field_value_mT": 25.0,
                            "m_avg": HysteresisApiHandler.point_m_avg,
                            "snapshot_id": "hysteresis_point_001",
                            "snapshot_vector_resource_ref": "/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_kind=full&snapshot_id=hysteresis_point_001&stage_id=stage-000",
                        }
                    ]
                ).encode("utf-8")
            )
            return
        if parsed.path == "/v2/sessions/current/data/fields/m/samples/vector":
            query = parse_qs(parsed.query)
            HysteresisApiHandler.vector_requests.append(self.path)
            if query.get("snapshot_id") != ["hysteresis_point_001"]:
                self.send_error(400)
                return
            if query.get("stage_id") != ["stage-000"]:
                self.send_error(400)
                return
            body = fmvp_payload([1.0, 0.0, 0.0, 0.0, 1.0, 0.0])
            self.send_response(200)
            self.send_header("content-type", "application/octet-stream")
            self.send_header("x-fullmag-encoding", "FMVP;version=2")
            self.send_header("x-fullmag-quantity-id", "m")
            self.send_header("x-fullmag-component", "full")
            self.send_header("x-fullmag-snapshot-id", "hysteresis_point_001")
            self.send_header("x-fullmag-point-count", HysteresisApiHandler.point_count_header)
            self.send_header("x-fullmag-value-count", HysteresisApiHandler.value_count_header)
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)


def test_validator_syncs_artifact_dir_and_replays_snapshot_vector(tmp_path: Path) -> None:
    write_playback_fixture(tmp_path)
    HysteresisApiHandler.point_m_avg = [0.5, 0.5, 0.0]
    HysteresisApiHandler.point_count_header = "2"
    HysteresisApiHandler.value_count_header = "6"
    HysteresisApiHandler.received_snapshot_payload = None
    HysteresisApiHandler.vector_requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), HysteresisApiHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        result = subprocess.run(
            [
                sys.executable,
                str(VALIDATOR),
                f"http://127.0.0.1:{server.server_port}",
                str(tmp_path),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    assert result.returncode == 0, result.stderr + result.stdout
    assert "validated hysteresis data-plane playback" in result.stdout
    assert HysteresisApiHandler.received_snapshot_payload is not None
    session = HysteresisApiHandler.received_snapshot_payload["session"]
    assert Path(session["artifact_dir"]) == tmp_path.resolve()
    assert HysteresisApiHandler.vector_requests == [
        "/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_kind=full&snapshot_id=hysteresis_point_001&stage_id=stage-000"
    ]


def test_validator_rejects_api_payload_average_mismatch(tmp_path: Path) -> None:
    write_playback_fixture(tmp_path)
    HysteresisApiHandler.point_m_avg = [1.0, 0.0, 0.0]
    HysteresisApiHandler.point_count_header = "2"
    HysteresisApiHandler.value_count_header = "6"
    HysteresisApiHandler.received_snapshot_payload = None
    HysteresisApiHandler.vector_requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), HysteresisApiHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        result = subprocess.run(
            [
                sys.executable,
                str(VALIDATOR),
                f"http://127.0.0.1:{server.server_port}",
                str(tmp_path),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    assert result.returncode != 0
    assert "m_avg does not match API data-plane snapshot" in (
        result.stderr + result.stdout
    )


def test_validator_uses_zarr_average_weights_for_api_payload_average(
    tmp_path: Path,
) -> None:
    write_playback_fixture(
        tmp_path,
        average_weights=[3.0, 1.0],
        point_average=[0.75, 0.25, 0.0],
    )
    HysteresisApiHandler.point_m_avg = [0.75, 0.25, 0.0]
    HysteresisApiHandler.point_count_header = "2"
    HysteresisApiHandler.value_count_header = "6"
    HysteresisApiHandler.received_snapshot_payload = None
    HysteresisApiHandler.vector_requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), HysteresisApiHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        result = subprocess.run(
            [
                sys.executable,
                str(VALIDATOR),
                f"http://127.0.0.1:{server.server_port}",
                str(tmp_path),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    assert result.returncode == 0, result.stderr + result.stdout
    assert "validated hysteresis data-plane playback" in result.stdout


def test_validator_rejects_declared_average_weights_missing_store(
    tmp_path: Path,
) -> None:
    write_playback_fixture(
        tmp_path,
        average_weights=[3.0, 1.0],
        point_average=[0.75, 0.25, 0.0],
    )
    shutil.rmtree(tmp_path / "hysteresis.zarr" / "fields" / "m" / "average_weights")
    HysteresisApiHandler.point_m_avg = [0.75, 0.25, 0.0]
    HysteresisApiHandler.point_count_header = "2"
    HysteresisApiHandler.value_count_header = "6"
    HysteresisApiHandler.received_snapshot_payload = None
    HysteresisApiHandler.vector_requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), HysteresisApiHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        result = subprocess.run(
            [
                sys.executable,
                str(VALIDATOR),
                f"http://127.0.0.1:{server.server_port}",
                str(tmp_path),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    assert result.returncode != 0
    assert "missing average_weights Zarr array" in (result.stderr + result.stdout)


def test_validator_rejects_data_plane_count_header_mismatch(tmp_path: Path) -> None:
    write_playback_fixture(tmp_path)
    HysteresisApiHandler.point_m_avg = [0.5, 0.5, 0.0]
    HysteresisApiHandler.point_count_header = "2"
    HysteresisApiHandler.value_count_header = "5"
    HysteresisApiHandler.received_snapshot_payload = None
    HysteresisApiHandler.vector_requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), HysteresisApiHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        result = subprocess.run(
            [
                sys.executable,
                str(VALIDATOR),
                f"http://127.0.0.1:{server.server_port}",
                str(tmp_path),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    assert result.returncode != 0
    assert "x-fullmag-value-count" in (result.stderr + result.stdout)
