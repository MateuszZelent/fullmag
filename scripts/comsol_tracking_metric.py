"""Independent Tet4 modal algebra; no artifact or solver qualification.

Uses element bilinear forms rather than the producer's mass embedding.
All vectors are Cartesian nodal periodic envelopes on the full mesh.
"""
from __future__ import annotations

import hashlib
import struct

import numpy as np

from comsol_n0_projection import (
    _validate_mesh, _tet4_volume, _mass_inner_product, _as_real_array,
)


_TRACKING_METRIC_V1_SCHEMA = "fullmag.tracking_consistent_p1_metric.v1"
_TRACKING_METRIC_V2_SCHEMA = "fullmag.tracking_consistent_p1_metric.v2"
_TRACKING_METRIC_V1_DEFINITION = "consistent_p1_tet4_cartesian_nodal_envelope.v1"
_TRACKING_METRIC_V2_DEFINITION = "consistent_p1_native_csr_cartesian_nodal_envelope.v2"
_NATIVE_SNAPSHOT_FIELDS = {
    "generation", "magnetic_volume_m3", "row_offsets", "columns", "values_m3",
    "canonical_vertex_ids", "scalar_dof_ids", "topology_sha256",
    "marker_map_sha256", "element_mask_sha256", "canonical_dof_map_sha256",
    "csr_sha256", "source_snapshot_sha256", "identity_sha256",
}
_NATIVE_HASH_FIELDS = (
    "topology_sha256", "marker_map_sha256", "element_mask_sha256",
    "canonical_dof_map_sha256", "csr_sha256", "source_snapshot_sha256",
    "identity_sha256",
)


def _strict_int(value, *, name, minimum=0, maximum=None):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, np.integer)):
        raise ValueError(f"{name} must be an integer")
    result = int(value)
    if result < minimum or (maximum is not None and result > maximum):
        raise ValueError(f"{name} is out of range")
    return result


def _strict_int_list(value, *, name, minimum=0, maximum=None):
    if not isinstance(value, list):
        raise ValueError(f"{name} must be an integer list")
    return [
        _strict_int(item, name=f"{name}[{index}]", minimum=minimum, maximum=maximum)
        for index, item in enumerate(value)
    ]


def _strict_finite_number(value, *, name, positive=False):
    if isinstance(value, (bool, np.bool_)) or not isinstance(
        value, (int, float, np.integer, np.floating)
    ):
        raise ValueError(f"{name} must be a finite real number")
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{name} must be a finite real number") from exc
    if not np.isfinite(result) or (positive and result <= 0.0):
        raise ValueError(f"{name} must be finite" + (" and positive" if positive else ""))
    return result


def _strict_hash(value, *, name):
    digest = bytes(_strict_int_list(value, name=name, minimum=0, maximum=255))
    if len(digest) != 32 or not any(digest):
        raise ValueError(f"{name} must be a nonzero SHA-256 byte array")
    return digest


def _typed_digest_field(name, kind, value):
    name_bytes = name.encode("utf-8")
    return (
        struct.pack(">Q", len(name_bytes))
        + name_bytes
        + bytes([kind])
        + struct.pack(">Q", len(value))
        + value
    )


def _typed_digest(schema, fields):
    payload = _typed_digest_field("schema", 1, schema.encode("utf-8"))
    payload += b"".join(_typed_digest_field(name, kind, value) for name, kind, value in fields)
    return hashlib.sha256(payload).digest()


def _u64(value):
    return struct.pack(">Q", value)


def _u32(value):
    return struct.pack(">I", value)


def _f64(value):
    return struct.pack(">d", value if value != 0.0 else 0.0)


def _native_csr_digest(row_offsets, columns, values_m3):
    payload = b"".join(_u64(value) for value in row_offsets)
    payload += b"".join(_u32(value) for value in columns)
    payload += b"".join(_f64(value) for value in values_m3)
    return _typed_digest("mfem_tracking_mass.csr.v1", [("payload_be", 3, payload)])


def _native_map_digest(canonical_vertex_ids, scalar_dof_ids):
    fields = [("vertex_count", 2, _u64(len(canonical_vertex_ids)))]
    fields.extend([
        (
            name,
            3,
            b"".join(_u32(value) for value in values),
        )
        for name, values in (
            ("canonical_vertex_ids_be", canonical_vertex_ids),
            ("scalar_dof_ids_be", scalar_dof_ids),
        )
    ])
    return _typed_digest("mfem_tracking_mass.canonical_dof_map.v1", fields)


def _native_identity_digest(snapshot):
    fields = [
        ("generation", 2, _u64(snapshot["generation"])),
        ("canonical_vertex_count", 2, _u64(len(snapshot["canonical_vertex_ids"]))),
        ("nonzero_count", 2, _u64(len(snapshot["values_m3"]))),
        ("magnetic_volume_m3", 4, _f64(snapshot["magnetic_volume_m3"])),
    ]
    fields.extend(
        (name, 3, bytes(snapshot[name]))
        for name in _NATIVE_HASH_FIELDS[:-1]
    )
    return _typed_digest("mfem_tracking_mass.snapshot_identity.v1", fields)


class Tet4TrackingMetric:
    """Consistent mass restricted to explicitly selected magnetic elements."""

    def __init__(self, nodes, cells, magnetic_element_indices):
        coordinates, connectivity, selected = _validate_mesh(
            nodes, cells, magnetic_element_indices
        )
        self.nodes = coordinates.copy()
        self.cells = connectivity[selected].copy()
        volumes = np.array([
            _tet4_volume(coordinates, connectivity[index], int(index))
            for index in selected
        ])
        self.volumes_m3 = volumes
        self.scaled_volumes = volumes / volumes.max()
        if np.any(self.scaled_volumes <= 0):
            raise ValueError("mass scaling underflow")
        self.support = np.unique(self.cells)

    def envelope(self, physical_field, k_vector_rad_per_m):
        field = np.asarray(physical_field, dtype=np.complex128)
        if any(isinstance(item, (bool, np.bool_))
               for item in np.asarray(k_vector_rad_per_m, dtype=object).flat):
            raise ValueError("k must not contain booleans")
        k = _as_real_array(k_vector_rad_per_m, name="k", ndim=1)
        if field.shape != self.nodes.shape or not np.all(np.isfinite(field)):
            raise ValueError("field must be finite Cartesian nodal XYZ")
        if k.shape != (3,) or not np.all(np.isfinite(k)):
            raise ValueError("k must be a finite three-vector in rad/m")
        with np.errstate(over="ignore", invalid="ignore"):
            phase = self.nodes @ k
        if not np.all(np.isfinite(phase)):
            raise ValueError("Bloch phase overflow")
        return field * np.exp(1j * phase)[:, None]

    def inner(self, left, right):
        return _mass_inner_product(left, right, self.cells, self.scaled_volumes)

    def normalized(self, vector):
        value = np.asarray(vector, dtype=np.complex128)
        if value.shape != self.nodes.shape or not np.all(np.isfinite(value)):
            raise ValueError("envelope must be finite Cartesian nodal XYZ")
        scale = np.max(np.abs(value[self.support]))
        if scale <= 0 or not np.isfinite(scale):
            raise ValueError("zero magnetic field")
        # Air has zero weight and must not overflow during magnetic scaling.
        supported = np.zeros_like(value)
        supported[self.support] = value[self.support] / scale
        value = supported
        norm = self.inner(value, value)
        if not np.isfinite(norm) or norm.real <= 0 or abs(norm.imag) > 1e-12 * norm.real:
            raise ValueError("invalid mass norm")
        return value / np.sqrt(norm.real)

    def overlap(self, left, right):
        """Amplitude overlap, not squared modal assurance criterion."""
        return float(np.clip(abs(self.inner(
            self.normalized(left), self.normalized(right)
        )), 0, 1))

    def basis(self, vectors):
        result = []
        for vector in vectors:
            candidate = self.normalized(vector)
            for _ in range(2):
                for previous in result:
                    candidate -= self.inner(previous, candidate) * previous
            norm = self.inner(candidate, candidate).real
            if not np.isfinite(norm) or norm <= 1e-20:
                raise ValueError("rank-deficient modal subspace")
            result.append(candidate / np.sqrt(norm))
        if not result:
            raise ValueError("empty modal subspace")
        return result

    def principal_cosines(self, previous, current):
        left, right = self.basis(previous), self.basis(current)
        if len(left) != len(right):
            raise ValueError("subspace ranks differ")
        cross = np.array([[self.inner(a, b) for b in right] for a in left])
        return np.sort(np.clip(np.linalg.svd(cross, compute_uv=False), 0, 1))

    def transport(self, previous, current):
        """Return principal cosines and current basis in the previous frame.

        No raw-mode assignment is inferred. Output frame order follows the
        input previous branch order and is retained for subsequent edges.
        """
        cosines, frames, _ = self.transport_with_assignment_weights(previous, current)
        return cosines, frames

    def transport_with_assignment_weights(self, previous, current):
        """Also return weights indexed by previous branch and current raw slot."""
        left, right = self.basis(previous), self.basis(current)
        if len(left) != len(right) or len(left) < 2:
            raise ValueError("transport requires equal subspace ranks >= 2")
        cross = np.array([[self.inner(a, b) for b in right] for a in left])
        u, singular, vh = np.linalg.svd(cross)
        rotation = vh.conj().T @ u.conj().T
        frames = [sum((rotation[j, i] * right[j] for j in range(len(right))),
                      np.zeros_like(right[0])) for i in range(len(left))]
        return np.sort(np.clip(singular, 0, 1)), frames, np.clip(np.abs(rotation.T), 0, 1)

    def _validate_native_v2_metric(self, record, source_mesh_topology_sha256):
        if not isinstance(record, dict) or set(record) != {
            "schema", "definition_id", "source_mesh_topology_sha256",
            "physical_node_indices", "native_snapshot",
        }:
            raise ValueError("invalid persisted native tracking metric fields")
        if record["schema"] != _TRACKING_METRIC_V2_SCHEMA \
                or record["definition_id"] != _TRACKING_METRIC_V2_DEFINITION:
            raise ValueError("unsupported native tracking metric schema/definition")
        if not isinstance(record["source_mesh_topology_sha256"], str) \
                or not record["source_mesh_topology_sha256"] \
                or record["source_mesh_topology_sha256"] != source_mesh_topology_sha256:
            raise ValueError("native tracking metric mesh fingerprint differs")

        physical_nodes = _strict_int_list(
            record["physical_node_indices"],
            name="physical_node_indices",
            minimum=0,
            maximum=len(self.nodes) - 1,
        )
        if physical_nodes != self.support.tolist():
            raise ValueError("native tracking metric magnetic node support differs")

        snapshot = record["native_snapshot"]
        if not isinstance(snapshot, dict) or set(snapshot) != _NATIVE_SNAPSHOT_FIELDS:
            raise ValueError("invalid persisted native tracking CSR fields")
        generation = _strict_int(
            snapshot["generation"], name="native_snapshot.generation", minimum=1,
            maximum=2**64 - 1,
        )
        magnetic_volume = _strict_finite_number(
            snapshot["magnetic_volume_m3"],
            name="native_snapshot.magnetic_volume_m3",
            positive=True,
        )
        rows = len(self.nodes)
        row_offsets = _strict_int_list(
            snapshot["row_offsets"],
            name="native_snapshot.row_offsets",
            minimum=0,
            maximum=2**64 - 1,
        )
        columns = _strict_int_list(
            snapshot["columns"],
            name="native_snapshot.columns",
            minimum=0,
            maximum=2**32 - 1,
        )
        values_m3 = [
            _strict_finite_number(value, name=f"native_snapshot.values_m3[{index}]", positive=True)
            for index, value in enumerate(snapshot["values_m3"])
        ] if isinstance(snapshot["values_m3"], list) else None
        if values_m3 is None:
            raise ValueError("native_snapshot.values_m3 must be a finite positive list")
        canonical_vertex_ids = _strict_int_list(
            snapshot["canonical_vertex_ids"],
            name="native_snapshot.canonical_vertex_ids",
            minimum=0,
            maximum=2**32 - 1,
        )
        scalar_dof_ids = _strict_int_list(
            snapshot["scalar_dof_ids"],
            name="native_snapshot.scalar_dof_ids",
            minimum=0,
            maximum=2**32 - 1,
        )
        native_hashes = {
            name: _strict_hash(snapshot[name], name=f"native_snapshot.{name}")
            for name in _NATIVE_HASH_FIELDS
        }
        # The reconstructed COMSOL input does not carry native marker/source
        # payloads, so those four provenance digests are checked for their
        # typed, nonzero SHA-256 representation; CSR, map, and overall identity
        # digests are independently recomputed below.

        if len(canonical_vertex_ids) != rows \
                or canonical_vertex_ids != list(range(rows)) \
                or scalar_dof_ids != list(range(rows)):
            raise ValueError("native tracking metric canonical identity maps differ")
        if len(row_offsets) != rows + 1 or len(columns) != len(values_m3) \
                or row_offsets[0] != 0 or row_offsets[-1] != len(columns) \
                or any(left > right or right > len(columns)
                       for left, right in zip(row_offsets[:-1], row_offsets[1:], strict=True)):
            raise ValueError("native tracking metric CSR layout is invalid")

        support = set(physical_nodes)
        for row, (begin, end) in enumerate(
                zip(row_offsets[:-1], row_offsets[1:], strict=True)):
            row_columns = columns[begin:end]
            if any(column >= rows for column in row_columns) \
                    or any(left >= right for left, right in zip(row_columns, row_columns[1:])):
                raise ValueError("native tracking metric CSR columns are not sorted and bounded")
            active = row in support
            if active == (begin == end):
                raise ValueError("native tracking metric active or air-only row layout differs")
            if active and row not in row_columns:
                raise ValueError("native tracking metric active row lacks its diagonal")

        expected_entries = [dict() for _ in range(rows)]
        for connectivity, volume in zip(self.cells, self.volumes_m3, strict=True):
            coefficient = float(volume) / 20.0
            for row in connectivity:
                row = int(row)
                for column in connectivity:
                    column = int(column)
                    expected_entries[row][column] = expected_entries[row].get(column, 0.0) \
                        + coefficient * (2.0 if row == column else 1.0)
        expected_offsets = [0]
        expected_columns = []
        expected_values = []
        for entries in expected_entries:
            for column in sorted(entries):
                expected_columns.append(column)
                expected_values.append(entries[column])
            expected_offsets.append(len(expected_columns))
        if row_offsets != expected_offsets or columns != expected_columns \
                or not np.allclose(values_m3, expected_values, rtol=1e-12, atol=0.0) \
                or not np.isclose(
                    magnetic_volume,
                    float(np.sum(self.volumes_m3)),
                    rtol=1e-12,
                    atol=0.0,
                ):
            raise ValueError("native tracking metric CSR differs from independent Tet4 mass")

        if native_hashes["csr_sha256"] != _native_csr_digest(row_offsets, columns, values_m3) \
                or native_hashes["canonical_dof_map_sha256"] != _native_map_digest(
                    canonical_vertex_ids, scalar_dof_ids
                ):
            raise ValueError("native tracking metric CSR or map digest differs")
        identity_snapshot = {
            "generation": generation,
            "magnetic_volume_m3": magnetic_volume,
            "canonical_vertex_ids": canonical_vertex_ids,
            "values_m3": values_m3,
            **native_hashes,
        }
        if native_hashes["identity_sha256"] != _native_identity_digest(identity_snapshot):
            raise ValueError("native tracking metric identity digest differs")

    def validate_persisted_metric(self, record, source_mesh_topology_sha256):
        """Bind the producer's compact mass record to reconstructed geometry."""
        if isinstance(record, dict) and record.get("schema") == _TRACKING_METRIC_V2_SCHEMA:
            self._validate_native_v2_metric(record, source_mesh_topology_sha256)
            return
        keys = {"schema", "definition_id", "source_mesh_topology_sha256",
                "physical_node_indices", "tetra", "volumes_m3"}
        if not isinstance(record, dict) or set(record) != keys:
            raise ValueError("invalid persisted tracking metric fields")
        if record["schema"] != _TRACKING_METRIC_V1_SCHEMA \
                or record["definition_id"] != _TRACKING_METRIC_V1_DEFINITION:
            raise ValueError("unsupported tracking metric schema/definition")
        if record["source_mesh_topology_sha256"] != source_mesh_topology_sha256:
            raise ValueError("tracking metric mesh fingerprint differs")
        nodes = record["physical_node_indices"]
        tetra = record["tetra"]
        if not isinstance(nodes, list) or any(type(x) is not int for x in nodes) \
                or nodes != self.support.tolist():
            raise ValueError("tracking metric magnetic node support differs")
        if not isinstance(tetra, list) or any(
            not isinstance(row, list) or len(row) != 4 or any(type(x) is not int for x in row)
            for row in tetra
        ) or tetra != np.searchsorted(self.support, self.cells).tolist():
            raise ValueError("tracking metric compact connectivity differs")
        if any(isinstance(item, (bool, np.bool_))
               for item in np.asarray(record["volumes_m3"], dtype=object).flat):
            raise ValueError("tracking metric volumes must not contain booleans")
        volumes = _as_real_array(record["volumes_m3"], name="volumes_m3", ndim=1)
        if volumes.shape != self.volumes_m3.shape or np.any(volumes <= 0) \
                or not np.allclose(volumes, self.volumes_m3, rtol=1e-12, atol=0):
            raise ValueError("tracking metric volumes differ from geometry")
