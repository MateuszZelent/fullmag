#!/usr/bin/env python3
"""Write the shared FMVP/FMTB decoder fixtures (ADR 0068 spec §6).

The encoders below follow ``crates/fullmag-api/src/field_store.rs`` byte for
byte.  The same ``.bin`` files are decoded by the Python client
(``test_live_client_data.py``) and the Control Room codec
(``fieldVectorCodec.fixtures.test.ts``); both compare against ``expected.json``.

Run: ``python packages/fullmag-py/tests/fixtures/fmvp/generate_fixtures.py``.
"""
from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path
from typing import Any, Optional, Sequence

HERE = Path(__file__).resolve().parent
INDEXING_CODES = {"full_domain": 0, "explicit_node_indices": 1, "sampled_node_indices": 2, "legacy_count_only": 3}
ARTIFACT_CODES = {"source_nodes": 4, "sample_nodes": 5, "point_samples": 6, "tet4_cell_local_nodes": 7, "cell_centers": 8}


def align8(value: int) -> int:
    return (value + 7) & ~7


def header(version: int, n_comp: int, metadata_len: int, value_count: int, grid: Sequence[int], quantity: str) -> bytes:
    quantity_bytes = quantity.encode("utf-8")[:16].ljust(16, b"\0")
    return b"FMVP" + bytes([version, 1, n_comp, 0]) + struct.pack("<II3I", metadata_len, value_count, *grid) + quantity_bytes + b"\0" * 4


def values_bytes(values: Sequence[float]) -> bytes:
    return struct.pack(f"<{len(values)}d", *values)


def encode_v2(quantity: str, n_comp: int, grid: Sequence[int], values: Sequence[float]) -> bytes:
    return header(2, n_comp, 0, len(values), grid, quantity) + values_bytes(values)


def encode_v3_to_v5(
    version: int,
    quantity: str,
    n_comp: int,
    grid: Sequence[int],
    values: Sequence[float],
    *,
    domain_generation_id: str,
    indexing: str,
    node_indices: Sequence[int] = (),
    topology_revision: int = 0,
    topology_hash: bytes = b"\0" * 32,
    scope_kind: str = "",
    scope_id: str = "",
    source: Optional[tuple[str, str, int, str]] = None,
) -> bytes:
    source_kind, source_id, source_revision, field_generation = source or ("", "", 0, "")
    texts = [scope_kind, scope_id, domain_generation_id, source_kind, source_id, field_generation]
    if version == 3:
        texts = texts[:3]
    if version == 5:
        texts.append(quantity)
    encoded = [text.encode("utf-8") for text in texts]
    fixed = {3: 68, 4: 80, 5: 88}[version]
    metadata_version = {3: 2, 4: 3, 5: 4}[version]
    block = bytearray(b"FMMI")
    block += struct.pack("<HHH", metadata_version, 0, len(encoded[2]))
    if version >= 4:
        block += struct.pack("<HHH", len(encoded[3]), len(encoded[4]), len(encoded[5]))
    else:
        block += b"\0" * 6
    block += struct.pack("<Q", topology_revision) + topology_hash
    block += struct.pack("<IIHH", INDEXING_CODES[indexing], len(node_indices), len(encoded[0]), len(encoded[1]))
    if version >= 4:
        block += struct.pack("<Q", source_revision) + b"\0" * 4
    if version == 5:
        block += struct.pack("<H", len(encoded[6])) + b"\0" * 6
    assert len(block) == fixed
    for text in encoded:
        block += text
    block += struct.pack(f"<{len(node_indices)}I", *node_indices)
    block += b"\0" * (align8(len(block)) - len(block))
    return header(version, n_comp, len(block), len(values), grid, quantity) + bytes(block) + values_bytes(values)


def encode_v6(
    quantity: str,
    n_comp: int,
    values: Sequence[float],
    *,
    indexing: str,
    identities: Sequence[Any],
    scope_kind: str,
    scope_id: str,
    payload_seed: str,
    source_revision: int,
) -> bytes:
    digest = hashlib.sha256(payload_seed.encode("utf-8")).digest()
    revision = struct.unpack_from("<Q", digest, 0)[0]
    generation = digest.hex()
    source_id = "sha256:" + hashlib.sha256((payload_seed + ":source").encode()).hexdigest()
    field_generation = "sha256:" + hashlib.sha256((payload_seed + ":field").encode()).hexdigest()
    strings = [scope_kind, scope_id, generation, "artifact_inspection", source_id, field_generation]
    code = ARTIFACT_CODES[indexing]
    stride = 24 if code == 7 else 8
    count = len(identities)
    block = bytearray(b"FMMI") + struct.pack("<HH", 4, 0)
    for text in strings[2:]:
        block += struct.pack("<H", len(text.encode()))
    block += struct.pack("<Q", revision) + digest
    block += struct.pack("<IIHHQIII", code, count, len(scope_kind.encode()), len(scope_id.encode()), source_revision, stride, code, 0)
    assert len(block) == 88
    for text in strings:
        block += text.encode("utf-8")
    for identity in identities:
        if code == 7:
            element, local, stable = identity
            block += struct.pack("<QB7xQ", element, local, stable)
        else:
            block += struct.pack("<Q", identity)
    block += b"\0" * (align8(len(block)) - len(block))
    return header(6, n_comp, len(block), len(values), (count, 1, 1), quantity) + bytes(block) + values_bytes(values)


def encode_fmtb(revision: int, schema_revision: int, cursor: tuple[int, int], total: int, rows: Sequence[Sequence[float]], resync: bool) -> bytes:
    columns = len(rows[0]) if rows else 0
    flat = [value for row in rows for value in row]
    return (
        b"FMTB"
        + struct.pack("<HH6QI", 1, 1 if resync else 0, revision, schema_revision, cursor[0], cursor[1], total, len(rows), columns)
        + values_bytes(flat)
    )


LONG_ID = "mode_eigen_k0__ąbranch_0007_real_imag"  # 16-byte header prefix cuts the two-byte "ą"


def fixtures() -> dict[str, tuple[bytes, dict[str, Any]]]:
    hash_a = hashlib.sha256(b"topology-a").digest()
    cases: dict[str, tuple[bytes, dict[str, Any]]] = {}
    grid_values = [float(i) * 0.5 - 1.0 for i in range(2 * 3 * 1 * 3)]
    cases["v2_grid"] = (encode_v2("m", 3, (2, 3, 1), grid_values), {"formatVersion": 2, "quantityId": "m", "nComp": 3, "grid": [2, 3, 1], "indexing": "legacy_count_only", "values": grid_values})
    cases["v3_full_domain"] = (
        encode_v3_to_v5(3, "H_eff", 3, (2, 1, 1), [1e5, 0, 0, -1e5, 0, 2.5], domain_generation_id="gen-3", indexing="full_domain", topology_revision=7, topology_hash=hash_a, scope_kind="full"),
        {"formatVersion": 3, "quantityId": "H_eff", "nComp": 3, "grid": [2, 1, 1], "indexing": "full_domain", "values": [1e5, 0, 0, -1e5, 0, 2.5], "domainGenerationId": "gen-3", "meshTopologyRevision": "7", "meshTopologyHash": hash_a.hex(), "scopeKind": "full"},
    )
    cases["v4_live_explicit"] = (
        encode_v3_to_v5(4, "m", 3, (3, 1, 1), [1, 0, 0, 0, 1, 0, 0, 0, 1], domain_generation_id="gen-4", indexing="explicit_node_indices", node_indices=(10, 4, 99), topology_revision=3, topology_hash=hash_a, scope_kind="object", scope_id="disk", source=("live", "run-1", 42, "field-gen-9")),
        {"formatVersion": 4, "quantityId": "m", "nComp": 3, "grid": [3, 1, 1], "indexing": "explicit_node_indices", "values": [1, 0, 0, 0, 1, 0, 0, 0, 1], "nodeIndices": [10, 4, 99], "domainGenerationId": "gen-4", "meshTopologyRevision": "3", "meshTopologyHash": hash_a.hex(), "scopeKind": "object", "scopeId": "disk", "sourceKind": "live", "sourceId": "run-1", "sourceRevision": "42", "fieldGenerationId": "field-gen-9"},
    )
    complex_values = [0.1, -0.2, 0.3, 0.4, 0.0, 1.0]
    cases["v5_long_id_qualified"] = (
        encode_v3_to_v5(5, LONG_ID, 6, (1, 1, 1), complex_values, domain_generation_id="gen-5", indexing="full_domain", topology_revision=11, topology_hash=hash_a, scope_kind="magnetic_only", source=("observation_frame", "frame-2", 5, "fg-5")),
        {"formatVersion": 5, "quantityId": LONG_ID, "nComp": 6, "grid": [1, 1, 1], "indexing": "full_domain", "values": complex_values, "domainGenerationId": "gen-5", "meshTopologyRevision": "11", "meshTopologyHash": hash_a.hex(), "scopeKind": "magnetic_only", "sourceKind": "observation_frame", "sourceId": "frame-2", "sourceRevision": "5", "fieldGenerationId": "fg-5"},
    )
    cases["v5_absent_topology"] = (
        encode_v3_to_v5(5, "E_density", 1, (4, 1, 1), [1.0, 2.0, 3.0, 4.0], domain_generation_id="gen-6", indexing="legacy_count_only"),
        {"formatVersion": 5, "quantityId": "E_density", "nComp": 1, "grid": [4, 1, 1], "indexing": "legacy_count_only", "values": [1.0, 2.0, 3.0, 4.0], "domainGenerationId": "gen-6", "meshTopologyRevision": None, "meshTopologyHash": None},
    )
    v6 = encode_v6("m_mode", 3, [0.5, 0.5, 0.0, -0.5, 0.5, 0.0], indexing="source_nodes", identities=[2**40 + 7, 3], scope_kind="object", scope_id="bar", payload_seed="v6-source-nodes", source_revision=9)
    cases["v6_source_nodes"] = (v6, {"formatVersion": 6, "quantityId": "m_mode", "nComp": 3, "grid": [2, 1, 1], "indexing": "source_nodes", "values": [0.5, 0.5, 0.0, -0.5, 0.5, 0.0], "artifactIdentityIds": [str(2**40 + 7), "3"], "scopeKind": "object", "scopeId": "bar", "sourceKind": "artifact_inspection", "sourceRevision": "9"})
    tet_ids = [(5, 0, 100), (5, 1, 101), (5, 2, 102), (5, 3, 103)]
    tet_values = [float(i) for i in range(12)]
    cases["v6_tet4"] = (
        encode_v6("m", 3, tet_values, indexing="tet4_cell_local_nodes", identities=tet_ids, scope_kind="full", scope_id="", payload_seed="v6-tet4", source_revision=1),
        {"formatVersion": 6, "quantityId": "m", "nComp": 3, "grid": [4, 1, 1], "indexing": "tet4_cell_local_nodes", "values": tet_values, "artifactIdentityIds": ["100", "101", "102", "103"], "scopeKind": "full", "scopeId": None, "sourceKind": "artifact_inspection", "sourceRevision": "1"},
    )
    rows = [[0.0, 1.0, -0.5], [1e-12, 0.9, -0.4]]
    cases["fmtb_rows"] = (
        encode_fmtb(12, 3, (40, 42), 42, rows, False),
        {"revision": 12, "schemaRevision": 3, "cursorStart": 40, "cursorEnd": 42, "totalRows": 42, "resyncRequired": False, "rowCount": 2, "columnCount": 3, "values": [v for row in rows for v in row]},
    )
    return cases


def main() -> None:
    expected = {}
    for name, (payload, description) in fixtures().items():
        (HERE / f"{name}.bin").write_bytes(payload)
        expected[name] = description
    (HERE / "expected.json").write_bytes((json.dumps(expected, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
