"""Private bridge to optional native helpers.

The public API remains pure Python. Native helpers stay internal and optional
until packaging for the PyO3 bridge is finalized.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Mapping

import numpy as np

if TYPE_CHECKING:
    from .meshing._gmsh_types import MeshData

try:
    import _fullmag_core as _native_core
except ImportError:  # pragma: no cover - optional bootstrap dependency
    _native_core = None


def validate_ir(ir: dict[str, Any]) -> bool | None:
    if _native_core is None:
        return None
    return bool(_native_core.validate_ir_json(json.dumps(ir)))


def validate_mesh_ir(mesh_ir: dict[str, Any]) -> bool | None:
    if _native_core is None:
        return None
    return bool(_native_core.validate_mesh_ir_json(json.dumps(mesh_ir)))


def run_problem_json(
    ir: dict[str, Any], until_seconds: float, output_dir: str | None = None
) -> dict[str, Any] | None:
    """Run a ProblemIR through the Rust reference runner.

    Returns RunResult dict on success, None if native core is not available.
    Raises ValueError if the problem is not executable in Phase 1.
    """
    if _native_core is None:
        return None
    result_json = _native_core.run_problem_json(
        json.dumps(ir), until_seconds, output_dir
    )
    return json.loads(result_json)


def sample_preset_texture_v2(
    preset_kind: str,
    params: dict[str, Any],
    points: list[tuple[float, float, float]],
    *,
    projection: str | None = None,
    rotation_quat: list[float] | tuple[float, ...] | None = None,
) -> dict[str, Any] | None:
    """Evaluate a v2 texture through the canonical Rust planner evaluator.

    Returns None only when the optional native extension is unavailable.
    """
    if _native_core is None:
        return None
    result_json = _native_core.sample_preset_texture_v2_json(
        preset_kind,
        json.dumps(params),
        json.dumps(points),
        projection,
        list(rotation_quat) if rotation_quat is not None else None,
    )
    return json.loads(result_json)


def resample_fem_to_fdm_grid(
    fem_mesh_ir: dict[str, Any],
    magnetization: list[list[float]],
    next_stage_ir: dict[str, Any],
) -> dict[str, Any] | None:
    """Resample FEM node-based magnetization to FDM grid cell centers.

    Returns dict with 'values', 'n_located', 'n_outside', 'n_total' if the
    next stage is FDM. Returns None if no resampling is needed (next stage is
    not FDM) or if native core is unavailable.
    """
    if _native_core is None:
        return None
    result_json = _native_core.resample_fem_to_fdm_grid_json(
        json.dumps(fem_mesh_ir),
        magnetization,
        json.dumps(next_stage_ir),
    )
    if result_json is None:
        return None
    return json.loads(result_json)


def extract_fem_mesh_ir(ir: dict[str, Any]) -> dict[str, Any] | None:
    """Extract the FEM mesh IR from a problem's execution plan.

    Returns the mesh IR dict if the backend resolves to FEM,
    or None if the backend is not FEM or native core is unavailable.
    """
    if _native_core is None:
        return None
    mesh_json = _native_core.extract_fem_mesh_ir_json(json.dumps(ir))
    if mesh_json is None:
        return None
    return json.loads(mesh_json)


@dataclass(frozen=True)
class NativeMixedCertificateResult:
    evidence: dict[str, object]
    topology_fingerprint_v3: str
    certificate_payload_sha256: str | None
    algorithm_id: str
    rayon_threads: int
    elapsed_ns: int
    validated_claimed_certificate: bool


@dataclass(frozen=True)
class NativeMixedPreflightResult:
    counts: dict[str, int]
    topology_fingerprint_v3: str
    elapsed_ns: int


@dataclass(frozen=True)
class _NativeMixedMeshWire:
    node_ids: np.ndarray
    node_coordinates: np.ndarray
    cell_global_ordinals: np.ndarray
    cell_topology_codes: np.ndarray
    cell_region_ids: np.ndarray
    cell_offsets: np.ndarray
    cell_connectivity: np.ndarray
    facet_global_ordinals: np.ndarray
    facet_topology_codes: np.ndarray
    facet_marker_ids: np.ndarray
    facet_offsets: np.ndarray
    facet_connectivity: np.ndarray
    metadata: dict[str, object]

    @property
    def metadata_json(self) -> str:
        return _canonical_json(self.metadata)

    def array_arguments(self) -> tuple[np.ndarray, ...]:
        return (
            self.node_ids,
            self.node_coordinates,
            self.cell_global_ordinals,
            self.cell_topology_codes,
            self.cell_region_ids,
            self.cell_offsets,
            self.cell_connectivity,
            self.facet_global_ordinals,
            self.facet_topology_codes,
            self.facet_marker_ids,
            self.facet_offsets,
            self.facet_connectivity,
        )


def _canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _encode_topology_codes(
    values: object,
    mapping: Mapping[str, int],
    *,
    label: str,
) -> np.ndarray:
    source = np.asarray(values, dtype=np.str_)
    if source.ndim != 1:
        raise ValueError(f"{label} must be one-dimensional")
    encoded = np.zeros(source.shape, dtype=np.uint8)
    recognized = np.zeros(source.shape, dtype=np.bool_)
    for name, code in mapping.items():
        selected = source == name
        encoded[selected] = np.uint8(code)
        recognized |= selected
    if not np.all(recognized):
        unknown = np.unique(source[~recognized])
        raise ValueError(f"unknown {label} {unknown[0]!s}")
    return np.ascontiguousarray(encoded)


def _native_topology_codes() -> tuple[dict[str, int], dict[str, int]]:
    function = (
        getattr(_native_core, "mixed_mesh_topology_codes_json", None)
        if _native_core is not None
        else None
    )
    if not callable(function):
        raise RuntimeError("native mixed mesh certifier is required")
    payload = json.loads(function())
    return (
        {str(name): int(code) for name, code in payload["cells"].items()},
        {str(name): int(code) for name, code in payload["facets"].items()},
    )


def _build_native_mixed_mesh_wire(
    mesh: object,
    metadata: Mapping[str, object],
) -> _NativeMixedMeshWire:
    nodes = np.asarray(getattr(mesh, "nodes"))
    if nodes.ndim != 2 or nodes.shape[1:] != (3,):
        raise ValueError("mesh nodes must have shape [N, 3]")
    node_coordinates = np.ascontiguousarray(nodes, dtype=np.float64)
    node_ids = np.arange(node_coordinates.shape[0], dtype=np.int64)
    cell_codes, facet_codes = _native_topology_codes()

    cell_topology_codes = _encode_topology_codes(
        getattr(mesh, "cell_types"), cell_codes, label="cell topology"
    )
    cell_markers = np.ascontiguousarray(
        np.asarray(getattr(mesh, "element_markers"), dtype=np.int64)
    )
    cell_parts = np.asarray(getattr(mesh, "cell_mesh_parts"), dtype=np.str_)
    if cell_markers.ndim != 1 or cell_parts.ndim != 1 or (
        len(cell_markers) != len(cell_topology_codes)
        or len(cell_parts) != len(cell_topology_codes)
    ):
        raise ValueError("cell markers and mesh parts must match the cell count")
    region_pairs = np.empty(
        len(cell_markers), dtype=[("marker", np.int64), ("mesh_part", "U32")]
    )
    region_pairs["marker"] = cell_markers
    region_pairs["mesh_part"] = cell_parts
    unique_regions, cell_region_ids = np.unique(region_pairs, return_inverse=True)
    cell_region_ids = np.ascontiguousarray(cell_region_ids, dtype=np.int64)
    cell_regions = [
        {
            "id": index,
            "marker": int(region["marker"]),
            "mesh_part": str(region["mesh_part"]),
        }
        for index, region in enumerate(unique_regions)
    ]

    facet_topology_codes = _encode_topology_codes(
        getattr(mesh, "facet_types"), facet_codes, label="facet topology"
    )
    facet_marker_ids = np.ascontiguousarray(
        np.asarray(getattr(mesh, "boundary_markers"), dtype=np.int64)
    )
    facet_roles = np.asarray(getattr(mesh, "facet_roles"), dtype=np.str_)
    if facet_marker_ids.ndim != 1 or facet_roles.ndim != 1 or (
        len(facet_marker_ids) != len(facet_topology_codes)
        or len(facet_roles) != len(facet_topology_codes)
    ):
        raise ValueError("facet markers and roles must match the facet count")
    facet_roles_by_marker: dict[str, str] = {}
    for marker in np.unique(facet_marker_ids):
        roles = np.unique(facet_roles[facet_marker_ids == marker])
        if len(roles) != 1:
            raise ValueError(f"facet marker {int(marker)} has multiple roles")
        facet_roles_by_marker[str(int(marker))] = str(roles[0])

    native_metadata = dict(metadata)
    native_metadata.update(
        {
            "cell_regions": cell_regions,
            "facet_roles_by_marker": facet_roles_by_marker,
            "periodic_boundary_pairs": list(
                getattr(mesh, "periodic_boundary_pairs", [])
            ),
            "periodic_node_pairs": list(getattr(mesh, "periodic_node_pairs", [])),
        }
    )
    return _NativeMixedMeshWire(
        node_ids=node_ids,
        node_coordinates=node_coordinates,
        cell_global_ordinals=np.ascontiguousarray(
            np.asarray(getattr(mesh, "cell_global_ordinals"), dtype=np.int64)
        ),
        cell_topology_codes=cell_topology_codes,
        cell_region_ids=cell_region_ids,
        cell_offsets=np.ascontiguousarray(
            np.asarray(getattr(mesh, "cell_offsets"), dtype=np.int64)
        ),
        cell_connectivity=np.ascontiguousarray(
            np.asarray(getattr(mesh, "cell_nodes"), dtype=np.int64)
        ),
        facet_global_ordinals=np.ascontiguousarray(
            np.asarray(getattr(mesh, "facet_global_ordinals"), dtype=np.int64)
        ),
        facet_topology_codes=facet_topology_codes,
        facet_marker_ids=facet_marker_ids,
        facet_offsets=np.ascontiguousarray(
            np.asarray(getattr(mesh, "facet_offsets"), dtype=np.int64)
        ),
        facet_connectivity=np.ascontiguousarray(
            np.asarray(getattr(mesh, "facet_nodes"), dtype=np.int64)
        ),
        metadata=native_metadata,
    )


def _require_native_mixed_function(name: str, *, require_native: bool) -> object | None:
    function = getattr(_native_core, name, None) if _native_core is not None else None
    if callable(function):
        return function
    if require_native:
        raise RuntimeError("native mixed mesh certifier is required")
    return None


def certify_mixed_mesh_arrays(
    *,
    mesh: "MeshData",
    metadata: Mapping[str, object],
    certificate: Mapping[str, object] | None,
    require_native: bool,
) -> NativeMixedCertificateResult | None:
    if certificate is not None and not isinstance(certificate, Mapping):
        raise TypeError("certificate must be a mapping or None")
    function = _require_native_mixed_function(
        "certify_mixed_mesh_arrays", require_native=require_native
    )
    if function is None:
        return None
    wire = _build_native_mixed_mesh_wire(mesh, metadata)
    result = json.loads(
        function(
            *wire.array_arguments(),
            wire.metadata_json,
            None
            if certificate is None
            else _canonical_json(certificate),
        )
    )
    if result.get("schema_version") != "fullmag.mixed-certificate-native-result.v1":
        raise ValueError("native mixed certificate result has an unsupported schema")
    return NativeMixedCertificateResult(
        evidence=dict(result["evidence"]),
        topology_fingerprint_v3=str(result["topology_fingerprint_v3"]),
        certificate_payload_sha256=result.get("certificate_payload_sha256"),
        algorithm_id=str(result["algorithm_id"]),
        rayon_threads=int(result["rayon_threads"]),
        elapsed_ns=int(result["elapsed_ns"]),
        validated_claimed_certificate=bool(result["validated_claimed_certificate"]),
    )


def preflight_mixed_mesh_arrays(
    *,
    mesh: "MeshData",
    expected: Mapping[str, object],
    require_native: bool,
) -> NativeMixedPreflightResult | None:
    function = _require_native_mixed_function(
        "preflight_mixed_mesh_arrays", require_native=require_native
    )
    if function is None:
        return None
    wire = _build_native_mixed_mesh_wire(mesh, {})
    expected_payload = {
        "metadata": wire.metadata,
        "expected": dict(expected),
    }
    result = json.loads(
        function(*wire.array_arguments(), _canonical_json(expected_payload))
    )
    if result.get("schema_version") != "fullmag.mixed-preflight-native-result.v1":
        raise ValueError("native mixed preflight result has an unsupported schema")
    return NativeMixedPreflightResult(
        counts={str(key): int(value) for key, value in result["counts"].items()},
        topology_fingerprint_v3=str(result["topology_fingerprint_v3"]),
        elapsed_ns=int(result["elapsed_ns"]),
    )
