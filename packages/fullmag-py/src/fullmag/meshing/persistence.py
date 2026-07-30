"""Lossless FEM mesh persistence and explicit Gmsh interchange."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Mapping, Sequence
import zipfile

import numpy as np

from fullmag._core import validate_mesh_ir

from ._gmsh_extraction import _read_mesh_file
from ._gmsh_infra import _import_meshio
from ._gmsh_types import (
    MeshData,
    MeshQualityReport,
    MeshRealizationReport,
    MixedLayerTopologyCertificate,
)


ARTIFACT_SCHEMA = "fullmag.mesh-artifact.v1"
AUTHORING_SCHEMA = "fullmag.mesh-authoring-fingerprint.v1"
_COORDINATE_SCALES = {"m": 1.0, "mm": 1.0e-3, "um": 1.0e-6, "nm": 1.0e-9}


class MeshArtifactError(ValueError):
    """Base error for persisted FEM mesh artifacts."""


class MeshArtifactCorruptionError(MeshArtifactError):
    """Raised when a native artifact member does not match its digest."""


class MeshArtifactVersionError(MeshArtifactError):
    """Raised when a native artifact uses an unsupported schema."""


class MeshConfigurationMismatch(MeshArtifactError):
    """Raised when saved and current mesh-producing authoring inputs differ."""

    def __init__(self, differences: Sequence[str]) -> None:
        self.differences = tuple(differences)
        rendered = ", ".join(self.differences) if self.differences else "unknown"
        super().__init__(f"mesh authoring configuration differs at: {rendered}")


class MeshSemanticMappingError(MeshArtifactError):
    """Raised when external physical groups cannot be mapped unambiguously."""


@dataclass(frozen=True, slots=True)
class MeshArtifact:
    mesh: MeshData
    mesh_name: str
    authoring_document: dict[str, object]
    authoring_fingerprint: str
    topology_fingerprint: str
    region_markers: list[dict[str, object]]
    object_region_markers: list[dict[str, object]]
    boundary_map: dict[str, int]
    build_report: dict[str, object] | None = None
    provenance: dict[str, object] | None = None


def mesh_data_from_ir(payload: Mapping[str, object]) -> MeshData:
    """Reconstruct canonical ``MeshData`` from a v2 ``MeshIR`` mapping."""
    cells = payload.get("cells")
    facets = payload.get("facets")
    if not isinstance(cells, Mapping) or not isinstance(facets, Mapping):
        raise ValueError("MeshIR persistence requires typed cells and facets")
    per_domain_quality = payload.get("per_domain_quality", {})
    return MeshData(
        nodes=payload["nodes"],
        cell_types=cells["types"],
        cell_offsets=cells["offsets"],
        cell_nodes=cells["nodes"],
        element_markers=payload["element_markers"],
        facet_types=facets["types"],
        facet_roles=facets["roles"],
        facet_offsets=facets["offsets"],
        facet_nodes=facets["nodes"],
        boundary_markers=payload["boundary_markers"],
        cell_global_ordinals=cells.get("global_ordinals", []),
        facet_global_ordinals=facets.get("global_ordinals", []),
        cell_mesh_parts=cells.get("mesh_parts", []),
        periodic_boundary_pairs=list(payload.get("periodic_boundary_pairs", [])),
        periodic_node_pairs=list(payload.get("periodic_node_pairs", [])),
        periodic_mesh_certificate=payload.get("periodic_mesh_certificate"),
        per_domain_quality={
            int(marker): _quality_from_dict(report)
            for marker, report in dict(per_domain_quality).items()
        } or None,
        realization_report=(
            MeshRealizationReport.from_dict(dict(payload["mesh_realization_report"]))
            if payload.get("mesh_realization_report") is not None
            else None
        ),
        mixed_layer_topology_certificate=(
            MixedLayerTopologyCertificate.from_dict(
                dict(payload["mixed_layer_topology_certificate"])
            )
            if payload.get("mixed_layer_topology_certificate") is not None
            else None
        ),
    )


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def mesh_authoring_fingerprint(document: Mapping[str, object]) -> str:
    payload = _canonical_json({"schema": AUTHORING_SCHEMA, "inputs": document})
    return f"sha256:{sha256(payload).hexdigest()}"


def _mapping_differences(expected: object, actual: object, prefix: str = "") -> list[str]:
    if isinstance(expected, Mapping) and isinstance(actual, Mapping):
        differences: list[str] = []
        for key in sorted(set(expected) | set(actual)):
            path = f"{prefix}.{key}" if prefix else str(key)
            if key not in expected or key not in actual:
                differences.append(path)
            else:
                differences.extend(_mapping_differences(expected[key], actual[key], path))
        return differences
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return [prefix or "inputs"]
        differences = []
        for index, (expected_item, actual_item) in enumerate(zip(expected, actual, strict=True)):
            path = f"{prefix}[{index}]"
            differences.extend(_mapping_differences(expected_item, actual_item, path))
        return differences
    return [] if expected == actual else [prefix or "inputs"]


def _quality_to_dict(report: MeshQualityReport | None) -> dict[str, object] | None:
    return asdict(report) if report is not None else None


def _quality_from_dict(payload: object) -> MeshQualityReport | None:
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise MeshArtifactCorruptionError("quality metadata must be an object")
    return MeshQualityReport(**payload)


def _serialize_mesh(mesh: MeshData) -> bytes:
    stream = BytesIO()
    np.savez_compressed(
        stream,
        nodes=mesh.nodes,
        cell_types=mesh.cell_types,
        cell_offsets=mesh.cell_offsets,
        cell_nodes=mesh.cell_nodes,
        element_markers=mesh.element_markers,
        facet_types=mesh.facet_types,
        facet_roles=mesh.facet_roles,
        facet_offsets=mesh.facet_offsets,
        facet_nodes=mesh.facet_nodes,
        boundary_markers=mesh.boundary_markers,
        cell_global_ordinals=mesh.cell_global_ordinals,
        facet_global_ordinals=mesh.facet_global_ordinals,
        cell_mesh_parts=mesh.cell_mesh_parts,
        metadata_json=np.asarray(
            json.dumps(
                {
                    "periodic_boundary_pairs": mesh.periodic_boundary_pairs,
                    "periodic_node_pairs": mesh.periodic_node_pairs,
                    "periodic_mesh_certificate": mesh.periodic_mesh_certificate,
                    "quality": _quality_to_dict(mesh.quality),
                    "per_domain_quality": {
                        str(marker): _quality_to_dict(report)
                        for marker, report in (mesh.per_domain_quality or {}).items()
                    },
                    "realization_report": (
                        mesh.realization_report.to_dict()
                        if mesh.realization_report is not None
                        else None
                    ),
                    "mixed_layer_topology_certificate": (
                        mesh.mixed_layer_topology_certificate.to_dict()
                        if mesh.mixed_layer_topology_certificate is not None
                        else None
                    ),
                },
                sort_keys=True,
            )
        ),
    )
    return stream.getvalue()


def _deserialize_mesh(payload: bytes) -> MeshData:
    try:
        data = np.load(BytesIO(payload), allow_pickle=False)
        metadata = json.loads(str(data["metadata_json"]))
        realization = metadata.get("realization_report")
        certificate = metadata.get("mixed_layer_topology_certificate")
        return MeshData(
            nodes=data["nodes"],
            cell_types=data["cell_types"],
            cell_offsets=data["cell_offsets"],
            cell_nodes=data["cell_nodes"],
            element_markers=data["element_markers"],
            facet_types=data["facet_types"],
            facet_roles=data["facet_roles"],
            facet_offsets=data["facet_offsets"],
            facet_nodes=data["facet_nodes"],
            boundary_markers=data["boundary_markers"],
            cell_global_ordinals=data["cell_global_ordinals"],
            facet_global_ordinals=data["facet_global_ordinals"],
            cell_mesh_parts=data["cell_mesh_parts"],
            periodic_boundary_pairs=metadata.get("periodic_boundary_pairs", []),
            periodic_node_pairs=metadata.get("periodic_node_pairs", []),
            periodic_mesh_certificate=metadata.get("periodic_mesh_certificate"),
            quality=_quality_from_dict(metadata.get("quality")),
            per_domain_quality={
                int(marker): _quality_from_dict(report)
                for marker, report in metadata.get("per_domain_quality", {}).items()
            } or None,
            realization_report=(
                MeshRealizationReport.from_dict(realization) if realization is not None else None
            ),
            mixed_layer_topology_certificate=(
                MixedLayerTopologyCertificate.from_dict(certificate)
                if certificate is not None
                else None
            ),
        )
    except MeshArtifactError:
        raise
    except Exception as exc:
        raise MeshArtifactCorruptionError(f"invalid topology.npz: {exc}") from exc


def _normalize_markers(markers: Sequence[Mapping[str, object]]) -> list[dict[str, object]]:
    result = [
        {"geometry_name": str(entry["geometry_name"]), "marker": int(entry["marker"])}
        for entry in markers
    ]
    names = [str(entry["geometry_name"]) for entry in result]
    values = [int(entry["marker"]) for entry in result]
    if any(not name for name in names) or len(names) != len(set(names)):
        raise MeshSemanticMappingError("region marker names must be non-empty and unique")
    if any(marker <= 0 for marker in values) or len(values) != len(set(values)):
        raise MeshSemanticMappingError("region marker values must be positive and unique")
    return result


def save_mesh_artifact(
    path: str | Path,
    *,
    mesh: MeshData,
    mesh_name: str,
    authoring_document: Mapping[str, object],
    region_markers: Sequence[Mapping[str, object]],
    object_region_markers: Sequence[Mapping[str, object]] = (),
    boundary_map: Mapping[str, int] | None = None,
    build_report: Mapping[str, object] | None = None,
    provenance: Mapping[str, object] | None = None,
) -> Path:
    target = Path(path)
    if target.suffix != ".fullmag-mesh":
        raise ValueError("native mesh artifacts must use .fullmag-mesh; use study.mesh.export() for .msh")
    target.parent.mkdir(parents=True, exist_ok=True)
    mesh.validate_strict(require_positive_orientation=True)
    mesh_ir = mesh.to_ir(mesh_name)
    if validate_mesh_ir(mesh_ir) is False:
        raise ValueError("mesh failed Rust MeshIR validation")
    regions = _normalize_markers(region_markers)
    object_regions = _normalize_markers(object_region_markers)
    topology = _serialize_mesh(mesh)
    report_bytes = _canonical_json(dict(build_report)) if build_report is not None else None
    members = {"topology.npz": topology}
    if report_bytes is not None:
        members["build-report.json"] = report_bytes
    authoring = dict(authoring_document)
    manifest = {
        "schema": ARTIFACT_SCHEMA,
        "minimum_reader_schema": ARTIFACT_SCHEMA,
        "coordinate_unit": "m",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "mesh_name": mesh_name,
        "topology_fingerprint_version": "v3",
        "topology_fingerprint": mesh.topology_fingerprint_v3(),
        "authoring_schema": AUTHORING_SCHEMA,
        "authoring_document": authoring,
        "authoring_fingerprint": mesh_authoring_fingerprint(authoring),
        "region_markers": regions,
        "object_region_markers": object_regions,
        "boundary_map": dict(sorted((boundary_map or {}).items())),
        "provenance": dict(provenance or {"origin": "generated"}),
        "build_report_present": report_bytes is not None,
        "members": {
            name: {"sha256": sha256(content).hexdigest(), "bytes": len(content)}
            for name, content in sorted(members.items())
        },
    }
    manifest_bytes = _canonical_json(manifest)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", manifest_bytes)
            for name, content in sorted(members.items()):
                archive.writestr(name, content)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def load_mesh_artifact(
    path: str | Path,
    *,
    expected_authoring_document: Mapping[str, object] | None = None,
) -> MeshArtifact:
    source = Path(path)
    if source.suffix != ".fullmag-mesh":
        raise ValueError("study.mesh.load() accepts only .fullmag-mesh artifacts")
    try:
        with zipfile.ZipFile(source, "r") as archive:
            manifest = json.loads(archive.read("manifest.json"))
            if manifest.get("schema") != ARTIFACT_SCHEMA:
                raise MeshArtifactVersionError(
                    f"unsupported mesh artifact schema {manifest.get('schema')!r}"
                )
            members: dict[str, bytes] = {}
            for name, descriptor in manifest.get("members", {}).items():
                content = archive.read(name)
                if sha256(content).hexdigest() != descriptor.get("sha256"):
                    raise MeshArtifactCorruptionError(f"digest mismatch for {name}")
                if len(content) != int(descriptor.get("bytes", -1)):
                    raise MeshArtifactCorruptionError(f"byte length mismatch for {name}")
                members[name] = content
    except (MeshArtifactError, FileNotFoundError):
        raise
    except Exception as exc:
        raise MeshArtifactCorruptionError(f"invalid native mesh artifact: {exc}") from exc
    if "topology.npz" not in members:
        raise MeshArtifactCorruptionError("native mesh artifact is missing topology.npz")
    mesh = _deserialize_mesh(members["topology.npz"])
    topology_fingerprint = mesh.topology_fingerprint_v3()
    if topology_fingerprint != manifest.get("topology_fingerprint"):
        raise MeshArtifactCorruptionError("topology fingerprint does not match manifest")
    mesh_name = str(manifest.get("mesh_name", ""))
    if not mesh_name or validate_mesh_ir(mesh.to_ir(mesh_name)) is False:
        raise MeshArtifactCorruptionError("mesh failed Rust MeshIR validation")
    authoring = manifest.get("authoring_document")
    if not isinstance(authoring, dict):
        raise MeshArtifactCorruptionError("manifest authoring_document must be an object")
    fingerprint = mesh_authoring_fingerprint(authoring)
    if fingerprint != manifest.get("authoring_fingerprint"):
        raise MeshArtifactCorruptionError("authoring fingerprint does not match manifest")
    if expected_authoring_document is not None:
        differences = _mapping_differences(authoring, dict(expected_authoring_document))
        if differences:
            raise MeshConfigurationMismatch(differences)
    build_report = None
    if manifest.get("build_report_present"):
        if "build-report.json" not in members:
            raise MeshArtifactCorruptionError("native mesh artifact is missing build-report.json")
        build_report = json.loads(members["build-report.json"])
    return MeshArtifact(
        mesh=mesh,
        mesh_name=mesh_name,
        authoring_document=authoring,
        authoring_fingerprint=fingerprint,
        topology_fingerprint=topology_fingerprint,
        region_markers=_normalize_markers(manifest.get("region_markers", [])),
        object_region_markers=_normalize_markers(manifest.get("object_region_markers", [])),
        boundary_map={
            str(name): int(marker) for name, marker in manifest.get("boundary_map", {}).items()
        },
        build_report=build_report,
        provenance=dict(manifest.get("provenance", {})),
    )


_MESHIO_CELL_NAMES = {
    "tet4": "tetra",
    "prism6": "wedge",
    "pyramid5": "pyramid",
    "hex8": "hexahedron",
    "tri3": "triangle",
    "quad4": "quad",
}


def _blocks(
    types: np.ndarray, offsets: np.ndarray, nodes: np.ndarray, markers: np.ndarray
) -> tuple[list[tuple[str, np.ndarray]], list[np.ndarray]]:
    cells: list[tuple[str, np.ndarray]] = []
    marker_blocks: list[np.ndarray] = []
    for kind in dict.fromkeys(types.tolist()):
        indices = np.flatnonzero(types == kind)
        block = np.asarray(
            [nodes[offsets[index] : offsets[index + 1]] for index in indices],
            dtype=np.int32,
        )
        cells.append((_MESHIO_CELL_NAMES[str(kind)], block))
        marker_blocks.append(markers[indices].astype(np.int32))
    return cells, marker_blocks


def export_gmsh_mesh(artifact: MeshArtifact, path: str | Path) -> Path:
    target = Path(path)
    if target.suffix.lower() != ".msh":
        raise ValueError("Gmsh interchange export requires a .msh destination")
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".msh", dir=target.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        _write_gmsh41_ascii(artifact, temporary)
        payload = temporary.read_bytes()
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    sidecar = Path(f"{target}.fullmag.json")
    sidecar_payload = {
        "schema": "fullmag.mesh-interchange.v1",
        "coordinate_unit": "m",
        "msh_sha256": sha256(payload).hexdigest(),
        "source_topology_fingerprint": artifact.topology_fingerprint,
        "region_markers": artifact.region_markers,
        "object_region_markers": artifact.object_region_markers,
        "boundary_map": artifact.boundary_map,
        "cell_global_ordinals": artifact.mesh.cell_global_ordinals.tolist(),
        "facet_global_ordinals": artifact.mesh.facet_global_ordinals.tolist(),
        "cell_mesh_parts": artifact.mesh.cell_mesh_parts.tolist(),
        "periodic_boundary_pairs": artifact.mesh.periodic_boundary_pairs,
        "periodic_node_pairs": artifact.mesh.periodic_node_pairs,
    }
    sidecar.write_bytes(_canonical_json(sidecar_payload))
    return target


_GMSH_ELEMENT_IDS = {
    "tri3": 2,
    "quad4": 3,
    "tet4": 4,
    "hex8": 5,
    "prism6": 6,
    "pyramid5": 7,
}


def _write_gmsh41_ascii(artifact: MeshArtifact, target: Path) -> None:
    mesh = artifact.mesh
    region_names = {
        int(entry["marker"]): str(entry["geometry_name"])
        for entry in artifact.region_markers
    }
    boundary_names = {int(marker): name for name, marker in artifact.boundary_map.items()}
    volume_markers = sorted(set(int(value) for value in mesh.element_markers.tolist()))
    surface_markers = sorted(set(int(value) for value in mesh.boundary_markers.tolist()))
    if any(marker <= 0 for marker in (*volume_markers, *surface_markers)):
        raise MeshSemanticMappingError(
            "Gmsh export currently requires positive volume and boundary markers"
        )
    missing_regions = sorted(set(volume_markers) - set(region_names))
    missing_boundaries = sorted(set(surface_markers) - set(boundary_names))
    if missing_regions or missing_boundaries:
        raise MeshSemanticMappingError(
            f"Gmsh export requires names for all markers; missing volumes={missing_regions}, "
            f"surfaces={missing_boundaries}"
        )
    lower = mesh.nodes.min(axis=0)
    upper = mesh.nodes.max(axis=0)
    physical_names = [
        *(f'3 {marker} "{region_names[marker]}"' for marker in volume_markers),
        *(f'2 {marker} "{boundary_names[marker]}"' for marker in surface_markers),
    ]
    element_blocks: list[tuple[int, int, int, list[tuple[int, np.ndarray]]]] = []
    next_tag = 1
    for dimension, types, offsets, nodes, markers in (
        (3, mesh.cell_types, mesh.cell_offsets, mesh.cell_nodes, mesh.element_markers),
        (2, mesh.facet_types, mesh.facet_offsets, mesh.facet_nodes, mesh.boundary_markers),
    ):
        for marker in sorted(set(int(value) for value in markers.tolist())):
            for kind in dict.fromkeys(types[markers == marker].tolist()):
                entries = []
                for index in np.flatnonzero((markers == marker) & (types == kind)):
                    entries.append(
                        (next_tag, nodes[offsets[index] : offsets[index + 1]] + 1)
                    )
                    next_tag += 1
                element_blocks.append((dimension, marker, _GMSH_ELEMENT_IDS[str(kind)], entries))
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write("$MeshFormat\n4.1 0 8\n$EndMeshFormat\n")
        handle.write(f"$PhysicalNames\n{len(physical_names)}\n")
        handle.write("\n".join(physical_names))
        handle.write("\n$EndPhysicalNames\n")
        handle.write(f"$Entities\n0 0 {len(surface_markers)} {len(volume_markers)}\n")
        bounds = " ".join(f"{value:.17g}" for value in (*lower, *upper))
        for marker in surface_markers:
            handle.write(f"{marker} {bounds} 1 {marker} 0\n")
        for marker in volume_markers:
            handle.write(f"{marker} {bounds} 1 {marker} 0\n")
        handle.write("$EndEntities\n")
        node_entity = volume_markers[0]
        handle.write(
            f"$Nodes\n1 {mesh.n_nodes} 1 {mesh.n_nodes}\n"
            f"3 {node_entity} 0 {mesh.n_nodes}\n"
        )
        handle.write("\n".join(str(index) for index in range(1, mesh.n_nodes + 1)))
        handle.write("\n")
        for point in mesh.nodes:
            handle.write(" ".join(f"{value:.17g}" for value in point) + "\n")
        handle.write("$EndNodes\n")
        handle.write(
            f"$Elements\n{len(element_blocks)} {next_tag - 1} 1 {next_tag - 1}\n"
        )
        for dimension, marker, element_type, entries in element_blocks:
            handle.write(f"{dimension} {marker} {element_type} {len(entries)}\n")
            for tag, nodes in entries:
                handle.write(f"{tag} {' '.join(str(int(node)) for node in nodes)}\n")
        handle.write("$EndElements\n")


def import_gmsh_mesh(
    path: str | Path,
    *,
    region_map: Mapping[str, int] | None = None,
    boundary_map: Mapping[str, int] | None = None,
    coordinate_unit: str | None = None,
) -> MeshArtifact:
    source = Path(path)
    if source.suffix.lower() != ".msh":
        raise ValueError("Gmsh interchange import requires a .msh source")
    sidecar_path = Path(f"{source}.fullmag.json")
    sidecar: dict[str, object] = {}
    if sidecar_path.exists():
        sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
        if sidecar.get("msh_sha256") != sha256(source.read_bytes()).hexdigest():
            raise MeshArtifactCorruptionError("Gmsh sidecar digest does not match .msh")
    resolved_unit = coordinate_unit or sidecar.get("coordinate_unit")
    if resolved_unit not in _COORDINATE_SCALES:
        raise ValueError("coordinate_unit must be explicitly provided as m, mm, um, or nm")
    mesh = _read_mesh_file(source)
    scale = _COORDINATE_SCALES[str(resolved_unit)]
    if scale != 1.0:
        mesh = MeshData(
            nodes=mesh.nodes * scale,
            cell_types=mesh.cell_types,
            cell_offsets=mesh.cell_offsets,
            cell_nodes=mesh.cell_nodes,
            element_markers=mesh.element_markers,
            facet_types=mesh.facet_types,
            facet_roles=mesh.facet_roles,
            facet_offsets=mesh.facet_offsets,
            facet_nodes=mesh.facet_nodes,
            boundary_markers=mesh.boundary_markers,
            cell_global_ordinals=np.arange(mesh.n_elements, dtype=np.int64),
            facet_global_ordinals=np.arange(mesh.n_boundary_faces, dtype=np.int64),
            cell_mesh_parts=mesh.cell_mesh_parts,
        )
    regions_raw = region_map
    if regions_raw is None:
        regions_raw = {
            str(entry["geometry_name"]): int(entry["marker"])
            for entry in sidecar.get("region_markers", [])
        }
    if not regions_raw:
        raise MeshSemanticMappingError("region_map is required when no matching Fullmag sidecar exists")
    boundaries_raw = boundary_map or sidecar.get("boundary_map", {})
    regions = [
        {"geometry_name": str(name), "marker": int(marker)}
        for name, marker in regions_raw.items()
    ]
    present_markers = set(int(value) for value in mesh.element_markers.tolist())
    declared_markers = set(int(value) for value in regions_raw.values())
    if present_markers - {0} != declared_markers:
        raise MeshSemanticMappingError(
            f"volume markers {sorted(present_markers)} do not match region_map {sorted(declared_markers)}"
        )
    mesh.validate_strict(require_positive_orientation=True)
    if validate_mesh_ir(mesh.to_ir("study_domain")) is False:
        raise ValueError("imported Gmsh mesh failed Rust MeshIR validation")
    return MeshArtifact(
        mesh=mesh,
        mesh_name="study_domain",
        authoring_document={"external_mesh": str(source), "coordinate_unit": resolved_unit},
        authoring_fingerprint=mesh_authoring_fingerprint(
            {"external_mesh": str(source), "coordinate_unit": resolved_unit}
        ),
        topology_fingerprint=mesh.topology_fingerprint_v3(),
        region_markers=_normalize_markers(regions),
        object_region_markers=_normalize_markers(sidecar.get("object_region_markers", [])),
        boundary_map={str(name): int(marker) for name, marker in dict(boundaries_raw).items()},
        build_report=None,
        provenance={"origin": "gmsh_import", "source": str(source)},
    )
