"""FMVP/FMTB decoding and data-plane reads (ADR 0068 F2, spec python-live-client-v1 §6)."""
from __future__ import annotations

import json
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from live_api_fake import FakeFullmagApi

from fullmag.client import Client
from fullmag.client._transport import HttpTransport
from fullmag.client.fmtb import TableRowsDecodeError, decode_table_rows
from fullmag.client.fmvp import FieldVectorDecodeError, decode_field_vector

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "fmvp"
EXPECTED = json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))


def _load(name: str) -> bytes:
    return (FIXTURES / f"{name}.bin").read_bytes()


def test_fixtures_are_reproducible(tmp_path) -> None:
    script = FIXTURES / "generate_fixtures.py"
    before = {path.name: path.read_bytes() for path in FIXTURES.iterdir() if path.suffix in {".bin", ".json"}}
    subprocess.run([sys.executable, "-B", str(script)], check=True)
    after = {path.name: path.read_bytes() for path in FIXTURES.iterdir() if path.suffix in {".bin", ".json"}}
    assert before == after


@pytest.mark.parametrize("name", sorted(name for name in EXPECTED if not name.startswith("fmtb")))
def test_field_vector_fixtures_match_shared_expectation(name: str) -> None:
    decoded = decode_field_vector(_load(name))
    actual = {
        "formatVersion": decoded.format_version,
        "quantityId": decoded.quantity_id,
        "nComp": decoded.n_comp,
        "grid": list(decoded.grid),
        "indexing": decoded.indexing,
        "values": decoded.values.reshape(-1).tolist(),
        "nodeIndices": None if decoded.node_indices is None else decoded.node_indices.tolist(),
        "domainGenerationId": decoded.domain_generation_id,
        "meshTopologyRevision": decoded.mesh_topology_revision,
        "meshTopologyHash": decoded.mesh_topology_hash,
        "scopeKind": decoded.scope_kind,
        "scopeId": decoded.scope_id,
        "sourceKind": decoded.source_kind,
        "sourceId": decoded.source_id,
        "sourceRevision": decoded.source_revision,
        "fieldGenerationId": decoded.field_generation_id,
        "artifactIdentityIds": None if decoded.artifact_identity_ids is None else [str(v) for v in decoded.artifact_identity_ids.tolist()],
    }
    for key, value in EXPECTED[name].items():
        assert actual[key] == value, key


def test_long_quantity_id_survives_utf8_prefix_cut() -> None:
    decoded = decode_field_vector(_load("v5_long_id_qualified"))
    assert decoded.quantity_id == "mode_eigen_k0__ąbranch_0007_real_imag"
    assert decoded.as_complex().shape == (1, 3)


def test_fdm_grid_is_x_fastest() -> None:
    decoded = decode_field_vector(_load("v2_grid"))
    grid = decoded.as_grid()
    assert grid.shape == (1, 3, 2, 3)
    # point index = x + nx * (y + ny * z)
    assert np.array_equal(grid[0, 1, 0], decoded.values[2])


def test_table_rows_fixture() -> None:
    rows = decode_table_rows(_load("fmtb_rows"), columns=("t", "mx", "my"))
    expected = EXPECTED["fmtb_rows"]
    assert rows.values.shape == (expected["rowCount"], expected["columnCount"])
    assert rows.column("mx").tolist() == [1.0, 0.9]
    assert (rows.revision, rows.cursor_end, rows.resync_required) == (12, 42, False)


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda b: b"XMVP" + b[4:], "magic"),
        (lambda b: b[:4] + bytes([9]) + b[5:], "version"),
        (lambda b: b[:-8], "size mismatch"),
        (lambda b: b[:28] + b"Xode" + b[32:], "prefix"),
    ],
)
def test_malformed_payloads_are_rejected(mutate, message) -> None:
    with pytest.raises(FieldVectorDecodeError, match=message):
        decode_field_vector(mutate(_load("v5_long_id_qualified")))


def test_malformed_table_rows_are_rejected() -> None:
    payload = _load("fmtb_rows")
    with pytest.raises(TableRowsDecodeError):
        decode_table_rows(payload[:-1])
    with pytest.raises(TableRowsDecodeError):
        decode_table_rows(payload[:4] + struct.pack("<H", 2) + payload[6:])


def test_client_reads_field_and_tables_into_numpy() -> None:
    field_bytes = _load("v4_live_explicit")
    rows_bytes = _load("fmtb_rows")
    with FakeFullmagApi() as api:
        api.route(
            "GET",
            "/v2/sessions/current/data/fields/m/samples/vector",
            lambda request: (304, None, {}) if request.headers.get("if-none-match") == '"e1"' else (200, field_bytes, {"ETag": '"e1"'}),
        )
        api.route(
            "GET",
            "/v2/sessions/current/data/tables/scalars/rows.bin",
            (200, rows_bytes, {"Content-Type": "application/vnd.fullmag.table-rows.v1+octet-stream"}),
        )
        client = Client(transport=HttpTransport(api.url, retry_budget_s=1.0, sleep=lambda _s: None))
        first = client.data.read_field("m")
        assert first is not None and first.values.shape == (3, 3)
        assert client.data.read_field("m") is first, "unchanged ETag must reuse the cached decode"
        assert api.find("GET", "/v2/sessions/current/data/fields/m/samples/vector")[-1].headers["if-none-match"] == '"e1"'
        rows = client.data.read_table("scalars", columns=("t", "mx", "my"))
        assert rows.column("my").tolist() == [-0.5, -0.4]
