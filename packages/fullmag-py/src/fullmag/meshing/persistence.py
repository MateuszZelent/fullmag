"""Lossless FEM mesh persistence and explicit Gmsh interchange."""

from __future__ import annotations

from dataclasses import asdict, dataclass, fields, replace
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
from typing import Mapping, Sequence
import zipfile

import numpy as np

from fullmag._core import (
    certify_mixed_mesh_arrays,
    preflight_mixed_mesh_arrays,
    validate_mesh_ir,
)

from ._certification_receipt import (
    ARTIFACT_SCHEMA_V2,
    MIXED_CERTIFIER_ALGORITHM,
    RECEIPT_SCHEMA_V1,
    RECEIPT_SCHEMA_V2,
    CertificationReceiptBindingsV1,
    CertificationReceiptV1,
    CertificationReceiptV2,
)
from ._gmsh_extraction import _read_mesh_file
from ._gmsh_extraction import _derive_facet_roles
from ._gmsh_infra import _import_meshio
from ._gmsh_types import (
    MeshData,
    MeshQualityReport,
    MeshRealizationReport,
    MixedLayerTopologyCertificate,
    _TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
    _bind_trusted_topology_fingerprint_v3,
    _bind_trusted_topology_fingerprint_v3_from_native,
    _certificate_payload_sha256,
    _mint_trusted_native_preflight_receipt_proof,
)


ARTIFACT_SCHEMA_V1 = "fullmag.mesh-artifact.v1"
ARTIFACT_SCHEMA = ARTIFACT_SCHEMA_V1
AUTHORING_SCHEMA = "fullmag.mesh-authoring-fingerprint.v1"
INTERCHANGE_SCHEMA = "fullmag.mesh-interchange.v1"
COMSOL_INTERCHANGE_SCHEMA = "fullmag.mesh-comsol-interchange.v1"
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


def _atomic_write_bytes(target: Path, payload: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        temporary.write_bytes(payload)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


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


def _deserialize_mesh_with_detached_certificate(
    payload: bytes,
) -> tuple[MeshData, MixedLayerTopologyCertificate | None]:
    try:
        data = np.load(BytesIO(payload), allow_pickle=False)
        metadata = json.loads(str(data["metadata_json"]))
        realization = metadata.get("realization_report")
        certificate_payload = metadata.get("mixed_layer_topology_certificate")
        certificate = (
            MixedLayerTopologyCertificate.from_dict(certificate_payload)
            if certificate_payload is not None
            else None
        )
        mesh = MeshData(
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
            mixed_layer_topology_certificate=None,
        )
        return mesh, certificate
    except MeshArtifactError:
        raise
    except Exception as exc:
        raise MeshArtifactCorruptionError(f"invalid topology.npz: {exc}") from exc


def _deserialize_mesh(payload: bytes) -> MeshData:
    mesh, certificate = _deserialize_mesh_with_detached_certificate(payload)
    if certificate is None:
        return mesh
    try:
        return replace(mesh, mixed_layer_topology_certificate=certificate)
    except Exception as exc:
        raise MeshArtifactCorruptionError(
            f"invalid mixed certificate in topology.npz: {exc}"
        ) from exc


def _attach_native_certificate_without_revalidation(
    mesh_without_certificate: MeshData,
    certificate: MixedLayerTopologyCertificate,
) -> MeshData:
    """Attach a certificate after the native engine already audited the mesh.

    ``MeshData.__post_init__`` intentionally certifies mixed meshes when a
    certificate is present.  Persistence has just performed that exact native
    audit and checked its fingerprint/payload result, so calling ``replace``
    here would walk every CSR array a second time.  The helper is private and
    is only used at those checked native seams; realization-report validation
    remains explicit below.
    """
    if mesh_without_certificate.mixed_layer_topology_certificate is not None:
        raise ValueError("native certificate attachment requires an unsigned mesh")
    if not isinstance(certificate, MixedLayerTopologyCertificate):
        raise TypeError("native certificate attachment requires a mixed certificate")
    result = object.__new__(MeshData)
    for descriptor in fields(MeshData):
        value = (
            certificate
            if descriptor.name == "mixed_layer_topology_certificate"
            else getattr(mesh_without_certificate, descriptor.name)
        )
        object.__setattr__(result, descriptor.name, value)
    result._validate_realization_report()
    return result


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


def _validate_semantic_marker_coverage(
    mesh: MeshData,
    *,
    region_markers: Sequence[Mapping[str, object]],
    object_region_markers: Sequence[Mapping[str, object]],
    boundary_map: Mapping[str, int],
) -> None:
    declared_volume = {
        int(entry["marker"])
        for entry in (*region_markers, *object_region_markers)
    }
    present_volume = set(int(value) for value in mesh.element_markers.tolist()) - {0}
    if present_volume != declared_volume:
        raise MeshSemanticMappingError(
            f"volume markers {sorted(present_volume)} do not match declared semantic "
            f"markers {sorted(declared_volume)}"
        )
    declared_boundary = set(int(value) for value in boundary_map.values())
    present_boundary = set(int(value) for value in mesh.boundary_markers.tolist())
    if present_boundary != declared_boundary:
        raise MeshSemanticMappingError(
            f"boundary markers {sorted(present_boundary)} do not match boundary_map "
            f"{sorted(declared_boundary)}"
        )


def _document_sha256(document: Mapping[str, object]) -> str:
    return sha256(_canonical_json(dict(document))).hexdigest()


def _semantic_manifest_sha256(
    *,
    region_markers: object,
    object_region_markers: object,
    boundary_map: object,
) -> str:
    def normalized_markers(value: object, *, label: str) -> list[dict[str, object]]:
        if not isinstance(value, (list, tuple)) or any(
            not isinstance(entry, Mapping) for entry in value
        ):
            raise ValueError(f"{label} must be an array of marker objects")
        return sorted(
            _normalize_markers(value),  # type: ignore[arg-type]
            key=lambda entry: (str(entry["geometry_name"]), int(entry["marker"])),
        )

    if not isinstance(boundary_map, Mapping):
        raise ValueError("boundary_map must be an object")
    projection = {
        "region_markers": normalized_markers(
            region_markers,
            label="region_markers",
        ),
        "object_region_markers": normalized_markers(
            object_region_markers,
            label="object_region_markers",
        ),
        "boundary_map": dict(
            sorted((str(name), int(marker)) for name, marker in boundary_map.items())
        ),
    }
    return sha256(_canonical_json(projection)).hexdigest()


def _member_descriptors(members: Mapping[str, bytes]) -> dict[str, dict[str, object]]:
    return {
        name: {"sha256": sha256(content).hexdigest(), "bytes": len(content)}
        for name, content in sorted(members.items())
    }


def _write_native_artifact(
    target: Path,
    *,
    manifest: Mapping[str, object],
    members: Mapping[str, bytes],
) -> None:
    manifest_bytes = _canonical_json(dict(manifest))
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


def _read_native_artifact(
    source: Path,
) -> tuple[dict[str, object], dict[str, bytes]]:
    try:
        with zipfile.ZipFile(source, "r") as archive:
            names = archive.namelist()
            if len(names) != len(set(names)):
                raise MeshArtifactCorruptionError(
                    "native mesh artifact contains duplicate member names"
                )
            manifest = json.loads(archive.read("manifest.json"))
            if not isinstance(manifest, dict):
                raise MeshArtifactCorruptionError("manifest.json must contain an object")
            schema = manifest.get("schema")
            if schema not in {ARTIFACT_SCHEMA_V1, ARTIFACT_SCHEMA_V2}:
                raise MeshArtifactVersionError(
                    f"unsupported mesh artifact schema {schema!r}"
                )
            descriptors = manifest.get("members")
            if not isinstance(descriptors, Mapping):
                raise MeshArtifactCorruptionError("manifest members must be an object")
            if schema == ARTIFACT_SCHEMA_V2:
                required = {
                    "topology.npz",
                    "build-report.json",
                    "certification-receipt.json",
                }
                if set(descriptors) != required or set(names) != required | {"manifest.json"}:
                    raise MeshArtifactCorruptionError(
                        "v2 native mesh artifact has an invalid member set"
                    )
            members: dict[str, bytes] = {}
            for name, raw_descriptor in descriptors.items():
                if not isinstance(name, str) or not isinstance(raw_descriptor, Mapping):
                    raise MeshArtifactCorruptionError("manifest member descriptor is invalid")
                if set(raw_descriptor) != {"sha256", "bytes"}:
                    raise MeshArtifactCorruptionError(
                        f"manifest descriptor fields are invalid for {name}"
                    )
                content = archive.read(name)
                if sha256(content).hexdigest() != raw_descriptor.get("sha256"):
                    raise MeshArtifactCorruptionError(f"digest mismatch for {name}")
                expected_bytes = raw_descriptor.get("bytes")
                if (
                    isinstance(expected_bytes, bool)
                    or not isinstance(expected_bytes, int)
                    or len(content) != expected_bytes
                ):
                    raise MeshArtifactCorruptionError(f"byte length mismatch for {name}")
                members[name] = content
    except (MeshArtifactError, FileNotFoundError):
        raise
    except Exception as exc:
        raise MeshArtifactCorruptionError(f"invalid native mesh artifact: {exc}") from exc
    if "topology.npz" not in members:
        raise MeshArtifactCorruptionError("native mesh artifact is missing topology.npz")
    return manifest, members


def _bindings_from_manifest(
    manifest: Mapping[str, object],
) -> CertificationReceiptBindingsV1:
    raw = manifest.get("certification_bindings")
    if not isinstance(raw, Mapping):
        raise MeshArtifactCorruptionError(
            "v2 manifest certification_bindings must be an object"
        )
    expected = {
        "resolved_policy_sha256",
        "source_snapshot_sha256",
        "gmsh_version",
        "repair_algorithm_id",
        "repair_method",
        "repair_iterations",
        "gmsh_threads",
        "certifier_algorithm_id",
        "certifier_backend",
        "certifier_threads",
    }
    if set(raw) != expected:
        raise MeshArtifactCorruptionError(
            "v2 manifest certification_bindings fields are invalid"
        )
    try:
        return CertificationReceiptBindingsV1(**dict(raw))
    except (TypeError, ValueError) as exc:
        raise MeshArtifactCorruptionError(
            f"invalid v2 manifest certification bindings: {exc}"
        ) from exc


def _receipt_from_members(
    members: Mapping[str, bytes],
) -> CertificationReceiptV1 | CertificationReceiptV2:
    try:
        payload = json.loads(members["certification-receipt.json"])
        if not isinstance(payload, Mapping):
            raise ValueError("receipt JSON must contain an object")
        schema = payload.get("schema")
        if schema == RECEIPT_SCHEMA_V1:
            return CertificationReceiptV1.from_dict(payload)
        if schema == RECEIPT_SCHEMA_V2:
            return CertificationReceiptV2.from_dict(payload)
        raise ValueError(f"certification receipt schema {schema!r} is unsupported")
    except MeshArtifactError:
        raise
    except Exception as exc:
        raise MeshArtifactCorruptionError(
            f"invalid certification-receipt.json: {exc}"
        ) from exc


def _validate_v2_receipt(
    *,
    manifest: Mapping[str, object],
    members: Mapping[str, bytes],
    mesh: MeshData,
    certificate: MixedLayerTopologyCertificate,
    topology_fingerprint_v3: str,
) -> tuple[
    CertificationReceiptV1 | CertificationReceiptV2,
    CertificationReceiptBindingsV1,
]:
    receipt = _receipt_from_members(members)
    bindings = _bindings_from_manifest(manifest)
    authoring = manifest.get("authoring_document")
    if not isinstance(authoring, Mapping):
        raise MeshArtifactCorruptionError(
            "manifest authoring_document must be an object"
        )
    try:
        components = {
            "topology_bytes": members["topology.npz"],
            "build_report_bytes": members["build-report.json"],
            "topology_fingerprint_v3": topology_fingerprint_v3,
            "certificate_payload_sha256": _certificate_payload_sha256(certificate),
            "authoring_document_sha256": _document_sha256(authoring),
            "bindings": bindings,
            "mesh_counts": {
                "nodes": mesh.n_nodes,
                "cells": mesh.n_elements,
                "facets": mesh.n_boundary_faces,
            },
        }
        if isinstance(receipt, CertificationReceiptV2):
            expected = CertificationReceiptV2.from_components(
                **components,
                semantic_manifest_sha256=_semantic_manifest_sha256(
                    region_markers=manifest.get("region_markers"),
                    object_region_markers=manifest.get("object_region_markers"),
                    boundary_map=manifest.get("boundary_map"),
                ),
            )
        else:
            expected = CertificationReceiptV1.from_components(**components)
    except (TypeError, ValueError) as exc:
        raise MeshArtifactCorruptionError(
            f"certification receipt binding is invalid: {exc}"
        ) from exc
    if receipt != expected:
        raise MeshArtifactCorruptionError(
            "certification receipt does not match artifact contents and bindings"
        )
    if certificate.gmsh_version != receipt.producer.gmsh_version:
        raise MeshArtifactCorruptionError(
            "mixed certificate Gmsh version does not match certification receipt"
        )
    if certificate.effective_gmsh_thread_count != receipt.producer.gmsh_threads:
        raise MeshArtifactCorruptionError(
            "mixed certificate Gmsh thread count does not match certification receipt"
        )
    return receipt, bindings


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
    certification_bindings: CertificationReceiptBindingsV1 | None = None,
    _native_certificate_result: object | None = None,
) -> Path:
    target = Path(path)
    if target.suffix != ".fullmag-mesh":
        raise ValueError("native mesh artifacts must use .fullmag-mesh; use study.mesh.export() for .msh")
    target.parent.mkdir(parents=True, exist_ok=True)
    # A mixed certificate already contains the complete per-cell geometry
    # evidence (including orientation and degeneracy checks).  Re-running the
    # Python ``validate_strict`` loop here makes persistence scale linearly in
    # Python over every cell and turns a large SP4 save into a multi-minute
    # operation.  Reuse the native certificate result when available; retain
    # the Python validator for source-only runtimes and un-certified meshes.
    # The internal shared-domain cache may already have run the native
    # certifier to discover its Rayon thread count before constructing the
    # receipt bindings.  Reuse that exact result instead of certifying the
    # same large CSR mesh a second time.  The argument is private on purpose:
    # public callers continue to get the normal fail-closed validation path.
    native_certificate = _native_certificate_result
    certificate = mesh.mixed_layer_topology_certificate
    if certificate is not None:
        if native_certificate is None:
            native_certificate = certify_mixed_mesh_arrays(
                mesh=mesh,
                metadata={"mesh_name": mesh_name},
                certificate=certificate.to_dict(),
                require_native=certification_bindings is not None,
            )
        if native_certificate is not None:
            # The native certifier computes and validates the v3 fingerprint
            # over the exact CSR arrays.  Recomputing that byte stream in
            # Python here duplicates a large linear pass for SP4 meshes.
            expected_fingerprint = native_certificate.topology_fingerprint_v3
            expected_payload = _certificate_payload_sha256(certificate)
            if (
                not native_certificate.validated_claimed_certificate
                or native_certificate.topology_fingerprint_v3 != expected_fingerprint
                or native_certificate.certificate_payload_sha256 != expected_payload
            ):
                if certification_bindings is not None:
                    raise ValueError(
                        "native mixed certificate result does not match mesh certificate"
                    )
                native_certificate = None
    native_mixed_certificate_validated = bool(
        native_certificate is not None
        and native_certificate.validated_claimed_certificate
    )
    if native_certificate is None:
        mesh.validate_strict(require_positive_orientation=True)
    topology_fingerprint = (
        native_certificate.topology_fingerprint_v3
        if native_certificate is not None
        else mesh.topology_fingerprint_v3()
    )
    if not native_mixed_certificate_validated:
        mesh_ir = mesh.to_ir(mesh_name)
        if validate_mesh_ir(mesh_ir) is False:
            raise ValueError("mesh failed Rust MeshIR validation")
    regions = _normalize_markers(region_markers)
    object_regions = _normalize_markers(object_region_markers)
    boundaries = {str(name): int(marker) for name, marker in (boundary_map or {}).items()}
    _validate_semantic_marker_coverage(
        mesh,
        region_markers=regions,
        object_region_markers=object_regions,
        boundary_map=boundaries,
    )
    topology = _serialize_mesh(mesh)
    report_bytes = _canonical_json(dict(build_report)) if build_report is not None else None
    members = {"topology.npz": topology}
    if report_bytes is not None:
        members["build-report.json"] = report_bytes
    authoring = dict(authoring_document)
    schema = ARTIFACT_SCHEMA_V1
    artifact_provenance = dict(provenance or {"origin": "generated"})
    if certification_bindings is not None:
        if not isinstance(certification_bindings, CertificationReceiptBindingsV1):
            raise TypeError(
                "certification_bindings must be CertificationReceiptBindingsV1"
            )
        if report_bytes is None:
            raise ValueError("certified artifact v2 requires build_report")
        certificate = mesh.mixed_layer_topology_certificate
        if certificate is None:
            raise ValueError("certified artifact v2 requires a mixed certificate")
        if (
            certificate.gmsh_version != certification_bindings.gmsh_version
            or certificate.effective_gmsh_thread_count
            != certification_bindings.gmsh_threads
        ):
            raise ValueError(
                "mixed certificate Gmsh provenance does not match v2 bindings"
            )
        native = native_certificate
        if native is None:  # pragma: no cover - require_native contract
            native = certify_mixed_mesh_arrays(
                mesh=mesh,
                metadata={"mesh_name": mesh_name},
                certificate=certificate.to_dict(),
                require_native=True,
            )
        if native is None:  # pragma: no cover - require_native contract
            raise RuntimeError("native mixed mesh certifier is required")
        expected_payload = _certificate_payload_sha256(certificate)
        if (
            not native.validated_claimed_certificate
            or native.topology_fingerprint_v3 != topology_fingerprint
            or native.certificate_payload_sha256 != expected_payload
            or native.algorithm_id != certification_bindings.certifier_algorithm_id
            or native.rayon_threads != certification_bindings.certifier_threads
        ):
            raise ValueError("native mixed certificate result does not match v2 bindings")
        receipt = CertificationReceiptV2.from_components(
            topology_bytes=topology,
            build_report_bytes=report_bytes,
            topology_fingerprint_v3=native.topology_fingerprint_v3,
            semantic_manifest_sha256=_semantic_manifest_sha256(
                region_markers=regions,
                object_region_markers=object_regions,
                boundary_map=boundaries,
            ),
            certificate_payload_sha256=expected_payload,
            authoring_document_sha256=_document_sha256(authoring),
            bindings=certification_bindings,
            mesh_counts={
                "nodes": mesh.n_nodes,
                "cells": mesh.n_elements,
                "facets": mesh.n_boundary_faces,
            },
        )
        members["certification-receipt.json"] = receipt.to_json_bytes()
        schema = ARTIFACT_SCHEMA_V2
        artifact_provenance.update(
            {
                "certifier_backend": "rust_rayon",
                "production_qualified": True,
            }
        )
    manifest = {
        "schema": schema,
        "minimum_reader_schema": schema,
        "coordinate_unit": "m",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "mesh_name": mesh_name,
        "topology_fingerprint_version": "v3",
        "topology_fingerprint": topology_fingerprint,
        "authoring_schema": AUTHORING_SCHEMA,
        "authoring_document": authoring,
        "authoring_fingerprint": mesh_authoring_fingerprint(authoring),
        "region_markers": regions,
        "object_region_markers": object_regions,
        "boundary_map": dict(sorted(boundaries.items())),
        "provenance": artifact_provenance,
        "build_report_present": report_bytes is not None,
        "members": _member_descriptors(members),
    }
    if certification_bindings is not None:
        manifest["certification_bindings"] = asdict(certification_bindings)
    _write_native_artifact(target, manifest=manifest, members=members)
    return target


def load_mesh_artifact(
    path: str | Path,
    *,
    expected_authoring_document: Mapping[str, object] | None = None,
) -> MeshArtifact:
    return _load_mesh_artifact_full_audit(
        path,
        expected_authoring_document=expected_authoring_document,
        require_native=False,
        artifact_trust="portable_full_audit",
    )


def _load_mesh_artifact_forced_audit(path: str | Path) -> MeshArtifact:
    return _load_mesh_artifact_full_audit(
        path,
        expected_authoring_document=None,
        require_native=True,
        artifact_trust="forced_audit",
    )


def _load_mesh_artifact_full_audit(
    path: str | Path,
    *,
    expected_authoring_document: Mapping[str, object] | None,
    require_native: bool,
    artifact_trust: str,
) -> MeshArtifact:
    source = Path(path)
    if source.suffix != ".fullmag-mesh":
        raise ValueError("study.mesh.load() accepts only .fullmag-mesh artifacts")
    manifest, members = _read_native_artifact(source)
    schema = manifest["schema"]
    receipt: CertificationReceiptV1 | CertificationReceiptV2 | None = None
    native_backend = "python_reference"
    if schema == ARTIFACT_SCHEMA_V2:
        unsigned, certificate = _deserialize_mesh_with_detached_certificate(
            members["topology.npz"]
        )
        if certificate is None:
            raise MeshArtifactCorruptionError("v2 artifact is missing mixed certificate")
        native = certify_mixed_mesh_arrays(
            mesh=unsigned,
            metadata={"mesh_name": str(manifest.get("mesh_name", ""))},
            certificate=certificate.to_dict(),
            require_native=require_native,
        )
        topology_fingerprint = (
            native.topology_fingerprint_v3
            if native is not None
            else unsigned.topology_fingerprint_v3()
        )
        receipt, _ = _validate_v2_receipt(
            manifest=manifest,
            members=members,
            mesh=unsigned,
            certificate=certificate,
            topology_fingerprint_v3=topology_fingerprint,
        )
        if native is not None:
            if (
                not native.validated_claimed_certificate
                or native.topology_fingerprint_v3
                != f"sha256:{receipt.topology_fingerprint_v3}"
                or native.certificate_payload_sha256
                != f"sha256:{receipt.certificate.payload_sha256}"
                or native.algorithm_id != receipt.certificate.algorithm_id
                or native.rayon_threads != receipt.producer.certifier_threads
            ):
                raise MeshArtifactCorruptionError(
                    "native certificate audit does not match certification receipt"
                )
            native_backend = "rust_rayon"
        try:
            mesh = (
                _attach_native_certificate_without_revalidation(unsigned, certificate)
                if native is not None
                else replace(unsigned, mixed_layer_topology_certificate=certificate)
            )
        except Exception as exc:
            raise MeshArtifactCorruptionError(
                f"full mixed certificate audit failed: {exc}"
            ) from exc
    else:
        # Keep the certificate detached while reading legacy v1 topology.  A
        # v1 payload used to be constructed as signed MeshData, stripped back
        # to unsigned MeshData for the native audit, and then validated a third
        # time.  The detached form lets the native result validate the exact
        # arrays once, after which the signed constructor can take its
        # certificate fast path.
        unsigned, certificate = _deserialize_mesh_with_detached_certificate(
            members["topology.npz"]
        )
        mesh = unsigned
        if certificate is not None:
            native = certify_mixed_mesh_arrays(
                mesh=mesh,
                metadata={"mesh_name": str(manifest.get("mesh_name", ""))},
                certificate=certificate.to_dict(),
                require_native=require_native,
            )
            if native is not None:
                if (
                    not native.validated_claimed_certificate
                    or native.topology_fingerprint_v3
                    != certificate.topology_fingerprint
                    or native.certificate_payload_sha256
                    != _certificate_payload_sha256(certificate)
                    or native.algorithm_id != MIXED_CERTIFIER_ALGORITHM
                ):
                    raise MeshArtifactCorruptionError(
                        "native certificate audit does not match legacy mixed artifact"
                    )
                native_backend = "rust_rayon"
                topology_fingerprint = native.topology_fingerprint_v3
                try:
                    mesh = _attach_native_certificate_without_revalidation(
                        mesh, certificate
                    )
                except Exception as exc:
                    raise MeshArtifactCorruptionError(
                        f"full mixed certificate audit failed: {exc}"
                    ) from exc
            else:
                try:
                    mesh = replace(mesh, mixed_layer_topology_certificate=certificate)
                except Exception as exc:
                    raise MeshArtifactCorruptionError(
                        f"full mixed certificate audit failed: {exc}"
                    ) from exc
                topology_fingerprint = mesh.topology_fingerprint_v3()
        else:
            topology_fingerprint = mesh.topology_fingerprint_v3()
    manifest_fingerprint = manifest.get("topology_fingerprint")
    if topology_fingerprint != manifest_fingerprint:
        raise MeshArtifactCorruptionError("topology fingerprint does not match manifest")
    mesh_name = str(manifest.get("mesh_name", ""))
    if not mesh_name:
        raise MeshArtifactCorruptionError("mesh failed Rust MeshIR validation")
    # The native mixed certificate path has already parsed the complete typed
    # mesh and validated its structural, orientation, degeneracy, conformity,
    # and executable mixed-topology evidence.  Rebuilding a JSON MeshIR here
    # only to run the same broad preflight repeats a large Python allocation and
    # serialization pass for every certified SP4 artifact.  Keep the generic
    # MeshIR validator for legacy or source-only artifacts.
    if native_backend != "rust_rayon" and validate_mesh_ir(mesh.to_ir(mesh_name)) is False:
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
    regions = _normalize_markers(manifest.get("region_markers", []))
    object_regions = _normalize_markers(manifest.get("object_region_markers", []))
    boundaries = {
        str(name): int(marker) for name, marker in manifest.get("boundary_map", {}).items()
    }
    _validate_semantic_marker_coverage(
        mesh,
        region_markers=regions,
        object_region_markers=object_regions,
        boundary_map=boundaries,
    )
    build_report = None
    if manifest.get("build_report_present"):
        if "build-report.json" not in members:
            raise MeshArtifactCorruptionError("native mesh artifact is missing build-report.json")
        build_report = json.loads(members["build-report.json"])
    loaded_provenance = dict(manifest.get("provenance", {}))
    if schema == ARTIFACT_SCHEMA_V2:
        loaded_provenance.update(
            {
                "artifact_trust": artifact_trust,
                "certifier_backend": native_backend,
                "production_qualified": native_backend == "rust_rayon",
            }
        )
    else:
        loaded_provenance.update(
            {
                "artifact_trust": "legacy_v1_full_audit",
                "certifier_backend": native_backend,
                "production_qualified": native_backend == "rust_rayon",
            }
        )
    return MeshArtifact(
        mesh=mesh,
        mesh_name=mesh_name,
        authoring_document=authoring,
        authoring_fingerprint=fingerprint,
        topology_fingerprint=topology_fingerprint,
        region_markers=regions,
        object_region_markers=object_regions,
        boundary_map=boundaries,
        build_report=build_report,
        provenance=loaded_provenance,
    )


def _load_trusted_cached_mesh_artifact(
    path: Path,
    *,
    expected_authoring_sha256: str,
    expected_policy_sha256: str,
    expected_source_snapshot_sha256: str,
    expected_gmsh_version: str,
    expected_repair_algorithm_id: str,
    expected_certifier_algorithm_id: str,
    use_native_fingerprint: bool = False,
) -> MeshArtifact:
    source = Path(path)
    if source.suffix != ".fullmag-mesh":
        raise ValueError("trusted mesh cache accepts only .fullmag-mesh artifacts")
    manifest, members = _read_native_artifact(source)
    if manifest.get("schema") != ARTIFACT_SCHEMA_V2:
        raise MeshArtifactVersionError(
            f"schema {manifest.get('schema')} is never eligible for trusted fast path"
        )
    unsigned, certificate = _deserialize_mesh_with_detached_certificate(
        members["topology.npz"]
    )
    if certificate is None:
        raise MeshArtifactCorruptionError("v2 artifact is missing mixed certificate")
    native = None
    if use_native_fingerprint:
        # Parse the receipt before native preflight so its bounded counts can
        # be used as the expected structural contract.  The manifest
        # fingerprint is deliberately supplied as an expectation; Rust then
        # computes the canonical value and rejects any mismatch before the
        # trusted constructor receives the mesh.
        receipt_hint = _receipt_from_members(members)
        if not isinstance(receipt_hint, CertificationReceiptV2):
            raise MeshArtifactVersionError(
                "receipt v1 is never eligible for trusted fast loading"
            )
        manifest_fingerprint = manifest.get("topology_fingerprint")
        if (
            not isinstance(manifest_fingerprint, str)
            or not manifest_fingerprint.startswith("sha256:")
            or len(manifest_fingerprint) != len("sha256:") + 64
        ):
            raise MeshArtifactCorruptionError(
                "trusted cache manifest topology fingerprint is invalid"
            )
        native = preflight_mixed_mesh_arrays(
            mesh=unsigned,
            expected={
                "counts": receipt_hint.mesh_counts.to_dict(),
                "topology_fingerprint_v3": manifest_fingerprint,
            },
            require_native=False,
        )
        if native is None:
            audited = load_mesh_artifact(source)
            provenance = dict(audited.provenance or {})
            provenance["artifact_trust"] = "bypassed_native_unavailable"
            return replace(audited, provenance=provenance)
        topology_context = _bind_trusted_topology_fingerprint_v3_from_native(
            mesh_without_certificate=unsigned,
            native_preflight=native,
            _receipt_capability=_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
        )
    else:
        topology_context = _bind_trusted_topology_fingerprint_v3(
            mesh_without_certificate=unsigned,
            _receipt_capability=_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
        )
    topology_fingerprint = topology_context.topology_fingerprint_v3
    receipt, _ = _validate_v2_receipt(
        manifest=manifest,
        members=members,
        mesh=unsigned,
        certificate=certificate,
        topology_fingerprint_v3=topology_fingerprint,
    )
    if not isinstance(receipt, CertificationReceiptV2):
        raise MeshArtifactVersionError(
            "receipt v1 is never eligible for trusted fast loading"
        )
    if mesh_authoring_fingerprint(manifest["authoring_document"]) != manifest.get(
        "authoring_fingerprint"
    ):
        raise MeshArtifactCorruptionError(
            "authoring fingerprint does not match manifest"
        )
    if topology_fingerprint != manifest.get("topology_fingerprint"):
        raise MeshArtifactCorruptionError("topology fingerprint does not match manifest")
    expected_bindings = {
        "document_sha256": expected_authoring_sha256,
        "resolved_policy_sha256": expected_policy_sha256,
        "source_snapshot_sha256": expected_source_snapshot_sha256,
        "gmsh_version": expected_gmsh_version,
        "repair_algorithm_id": expected_repair_algorithm_id,
        "certifier_algorithm_id": expected_certifier_algorithm_id,
    }
    actual_bindings = {
        "document_sha256": receipt.authoring.document_sha256,
        "resolved_policy_sha256": receipt.authoring.resolved_policy_sha256,
        "source_snapshot_sha256": receipt.producer.source_snapshot_sha256,
        "gmsh_version": receipt.producer.gmsh_version,
        "repair_algorithm_id": receipt.producer.repair_algorithm_id,
        "certifier_algorithm_id": receipt.certificate.algorithm_id,
    }
    if actual_bindings != expected_bindings:
        raise MeshArtifactCorruptionError(
            "trusted cache receipt does not match expected bindings"
        )
    expected_preflight = {
        "counts": receipt.mesh_counts.to_dict(),
        "topology_fingerprint_v3": f"sha256:{receipt.topology_fingerprint_v3}",
    }
    if native is None:
        native = preflight_mixed_mesh_arrays(
            mesh=unsigned,
            expected=expected_preflight,
            require_native=False,
        )
    if native is None:
        audited = load_mesh_artifact(source)
        provenance = dict(audited.provenance or {})
        provenance["artifact_trust"] = "bypassed_native_unavailable"
        return replace(audited, provenance=provenance)
    proof = _mint_trusted_native_preflight_receipt_proof(
        mesh_without_certificate=unsigned,
        certificate=certificate,
        native_preflight=native,
        topology_context=topology_context,
        expected_topology_fingerprint_v3=receipt.topology_fingerprint_v3,
        expected_certificate_payload_sha256=receipt.certificate.payload_sha256,
        expected_counts=receipt.mesh_counts.to_dict(),
        _receipt_capability=_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
    )
    mesh = MeshData._from_trusted_native_preflight_receipt(
        mesh_without_certificate=unsigned,
        certificate=certificate,
        proof=proof,
    )
    authoring = manifest.get("authoring_document")
    if not isinstance(authoring, dict):
        raise MeshArtifactCorruptionError("manifest authoring_document must be an object")
    regions = _normalize_markers(manifest.get("region_markers", []))
    object_regions = _normalize_markers(manifest.get("object_region_markers", []))
    boundaries = {
        str(name): int(marker) for name, marker in manifest.get("boundary_map", {}).items()
    }
    _validate_semantic_marker_coverage(
        mesh,
        region_markers=regions,
        object_region_markers=object_regions,
        boundary_map=boundaries,
    )
    build_report = json.loads(members["build-report.json"])
    provenance = dict(manifest.get("provenance", {}))
    provenance.update(
        {
            "artifact_trust": "trusted_cache_fast",
            "certifier_backend": "rust_rayon",
            "production_qualified": True,
        }
    )
    return MeshArtifact(
        mesh=mesh,
        mesh_name=str(manifest.get("mesh_name", "")),
        authoring_document=authoring,
        authoring_fingerprint=str(manifest.get("authoring_fingerprint", "")),
        topology_fingerprint=topology_fingerprint,
        region_markers=regions,
        object_region_markers=object_regions,
        boundary_map=boundaries,
        build_report=build_report,
        provenance=provenance,
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
        volume_export_map, surface_export_map = _write_gmsh41_ascii(artifact, temporary)
        payload = temporary.read_bytes()
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    sidecar = Path(f"{target}.fullmag.json")
    sidecar_payload = {
        "schema": INTERCHANGE_SCHEMA,
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
        "volume_marker_fullmag_to_gmsh": {
            str(marker): exported for marker, exported in volume_export_map.items()
        },
        "surface_marker_fullmag_to_gmsh": {
            str(marker): exported for marker, exported in surface_export_map.items()
        },
    }
    _atomic_write_bytes(sidecar, _canonical_json(sidecar_payload))
    return target


_GMSH_ELEMENT_IDS = {
    "tri3": 2,
    "quad4": 3,
    "tet4": 4,
    "hex8": 5,
    "prism6": 6,
    "pyramid5": 7,
}


def _positive_export_tags(markers: Sequence[int]) -> dict[int, int]:
    used = {marker for marker in markers if marker > 0}
    next_tag = max(used, default=0) + 1
    result: dict[int, int] = {}
    for marker in markers:
        if marker > 0:
            result[marker] = marker
        else:
            while next_tag in used:
                next_tag += 1
            result[marker] = next_tag
            used.add(next_tag)
            next_tag += 1
    return result


def _write_gmsh41_ascii(
    artifact: MeshArtifact, target: Path
) -> tuple[dict[int, int], dict[int, int]]:
    mesh = artifact.mesh
    region_names = {
        int(entry["marker"]): str(entry["geometry_name"])
        for entry in artifact.region_markers
    }
    boundary_names = {int(marker): name for name, marker in artifact.boundary_map.items()}
    volume_markers = sorted(set(int(value) for value in mesh.element_markers.tolist()))
    surface_markers = sorted(set(int(value) for value in mesh.boundary_markers.tolist()))
    volume_export_map = _positive_export_tags(volume_markers)
    surface_export_map = _positive_export_tags(surface_markers)
    region_names.setdefault(0, "airbox")
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
        *(
            f'3 {volume_export_map[marker]} "{region_names[marker]}"'
            for marker in volume_markers
        ),
        *(
            f'2 {surface_export_map[marker]} "{boundary_names[marker]}"'
            for marker in surface_markers
        ),
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
            exported = surface_export_map[marker]
            handle.write(f"{exported} {bounds} 1 {exported} 0\n")
        for marker in volume_markers:
            exported = volume_export_map[marker]
            handle.write(f"{exported} {bounds} 1 {exported} 0\n")
        handle.write("$EndEntities\n")
        node_entity = volume_export_map[volume_markers[0]]
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
            exported = (
                volume_export_map[marker] if dimension == 3 else surface_export_map[marker]
            )
            handle.write(f"{dimension} {exported} {element_type} {len(entries)}\n")
            for tag, nodes in entries:
                handle.write(f"{tag} {' '.join(str(int(node)) for node in nodes)}\n")
        handle.write("$EndElements\n")
    return volume_export_map, surface_export_map


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
        try:
            sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise MeshArtifactCorruptionError(f"invalid Gmsh sidecar: {exc}") from exc
        if sidecar.get("schema") != INTERCHANGE_SCHEMA:
            raise MeshArtifactVersionError(
                f"unsupported mesh interchange schema {sidecar.get('schema')!r}"
            )
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
    volume_translation = {
        int(exported): int(fullmag)
        for fullmag, exported in dict(
            sidecar.get("volume_marker_fullmag_to_gmsh", {})
        ).items()
    }
    surface_translation = {
        int(exported): int(fullmag)
        for fullmag, exported in dict(
            sidecar.get("surface_marker_fullmag_to_gmsh", {})
        ).items()
    }
    if not sidecar and (region_map is not None or boundary_map is not None):
        external = _import_meshio().read(source)
        for name, values in (external.field_data or {}).items():
            marker, dimension = (int(value) for value in np.asarray(values).reshape(-1)[:2])
            if dimension == 3 and region_map is not None and name in region_map:
                volume_translation[marker] = int(region_map[name])
            if dimension == 2 and boundary_map is not None and name in boundary_map:
                surface_translation[marker] = int(boundary_map[name])
    if volume_translation or surface_translation:
        mesh = _remap_mesh_markers(mesh, volume_translation, surface_translation)
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
    source_sha256 = sha256(source.read_bytes()).hexdigest()
    external_authoring = {
        "external_mesh_sha256": source_sha256,
        "coordinate_unit": resolved_unit,
    }
    return MeshArtifact(
        mesh=mesh,
        mesh_name="study_domain",
        authoring_document=external_authoring,
        authoring_fingerprint=mesh_authoring_fingerprint(external_authoring),
        topology_fingerprint=mesh.topology_fingerprint_v3(),
        region_markers=_normalize_markers(regions),
        object_region_markers=_normalize_markers(sidecar.get("object_region_markers", [])),
        boundary_map={str(name): int(marker) for name, marker in dict(boundaries_raw).items()},
        build_report=None,
        provenance={
            "origin": "gmsh_import",
            "source": str(source),
            "source_sha256": source_sha256,
        },
    )


def _remap_mesh_markers(
    mesh: MeshData,
    volume_translation: Mapping[int, int],
    surface_translation: Mapping[int, int],
) -> MeshData:
    element_markers = np.asarray(
        [volume_translation.get(int(marker), int(marker)) for marker in mesh.element_markers],
        dtype=np.int32,
    )
    boundary_markers = np.asarray(
        [surface_translation.get(int(marker), int(marker)) for marker in mesh.boundary_markers],
        dtype=np.int32,
    )
    cell_mesh_parts = np.asarray(
        ["far_air" if marker == 0 else "magnetic" for marker in element_markers]
    )
    return MeshData(
        nodes=mesh.nodes,
        cell_types=mesh.cell_types,
        cell_offsets=mesh.cell_offsets,
        cell_nodes=mesh.cell_nodes,
        element_markers=element_markers,
        facet_types=mesh.facet_types,
        facet_roles=mesh.facet_roles,
        facet_offsets=mesh.facet_offsets,
        facet_nodes=mesh.facet_nodes,
        boundary_markers=boundary_markers,
        cell_global_ordinals=np.arange(mesh.n_elements, dtype=np.int64),
        facet_global_ordinals=np.arange(mesh.n_boundary_faces, dtype=np.int64),
        cell_mesh_parts=cell_mesh_parts,
    )


_COMSOL_TYPE_NAMES = {
    "tri3": "tri",
    "quad4": "quad",
    "tet4": "tet",
    "pyramid5": "pyr",
    "prism6": "prism",
    "hex8": "hex",
}
_COMSOL_TO_FULLMAG_TYPES = {value: key for key, value in _COMSOL_TYPE_NAMES.items()}
_COMSOL_ARITIES = {
    "tri": 3,
    "quad": 4,
    "tet": 4,
    "pyr": 5,
    "prism": 6,
    "hex": 8,
}
_COMSOL_IGNORED_LOWER_DIMENSIONAL_ARITIES = {"vtx": 1, "edg": 2}


def export_comsol_mesh(artifact: MeshArtifact, path: str | Path) -> Path:
    """Export a linear 3D mesh as COMSOL Multiphysics text format v4."""
    target = Path(path)
    if target.suffix.lower() != ".mphtxt":
        raise ValueError("COMSOL interchange export requires a .mphtxt destination")
    mesh = artifact.mesh
    unsupported = sorted(
        (set(mesh.cell_types.tolist()) | set(mesh.facet_types.tolist()))
        - set(_COMSOL_TYPE_NAMES)
    )
    if unsupported:
        raise MeshSemanticMappingError(
            f"COMSOL export does not support element families {unsupported}"
        )
    volume_markers = sorted(set(int(value) for value in mesh.element_markers.tolist()))
    surface_markers = sorted(set(int(value) for value in mesh.boundary_markers.tolist()))
    volume_export_map = _positive_export_tags(volume_markers)
    surface_export_map = {marker: index for index, marker in enumerate(surface_markers)}
    blocks: list[tuple[str, np.ndarray, np.ndarray]] = []
    for types, offsets, nodes, markers, marker_map in (
        (
            mesh.cell_types,
            mesh.cell_offsets,
            mesh.cell_nodes,
            mesh.element_markers,
            volume_export_map,
        ),
        (
            mesh.facet_types,
            mesh.facet_offsets,
            mesh.facet_nodes,
            mesh.boundary_markers,
            surface_export_map,
        ),
    ):
        for kind in dict.fromkeys(types.tolist()):
            indices = np.flatnonzero(types == kind)
            connectivity = np.asarray(
                [nodes[offsets[index] : offsets[index + 1]] for index in indices],
                dtype=np.int64,
            )
            entities = np.asarray(
                [marker_map[int(markers[index])] for index in indices], dtype=np.int64
            )
            blocks.append((_COMSOL_TYPE_NAMES[str(kind)], connectivity, entities))
    lines = [
        "# Created by Fullmag for COMSOL Multiphysics mesh import.",
        "0 1 # Major & minor version",
        "1 # number of tags",
        "5 mesh1",
        "1 # number of types",
        "3 obj",
        "0 0 1",
        "4 Mesh # class",
        "4 # Mesh serialization version (COMSOL v4/v44)",
        "3 # space dimension",
        f"{mesh.n_nodes} # number of mesh vertices",
        "0 # lowest mesh vertex index",
        "# Mesh vertex coordinates (metres)",
    ]
    lines.extend(" ".join(f"{float(value):.17g}" for value in point) for point in mesh.nodes)
    lines.append(f"{len(blocks)} # number of element types")
    for block_index, (kind, connectivity, entities) in enumerate(blocks):
        lines.extend(
            [
                f"# Type #{block_index}",
                f"{len(kind)} {kind} # type name",
                f"{_COMSOL_ARITIES[kind]} # number of vertices per element",
                f"{len(connectivity)} # number of elements",
                "# Elements",
            ]
        )
        lines.extend(" ".join(str(int(node)) for node in row) for row in connectivity)
        lines.extend(
            [
                f"{len(entities)} # number of geometric entity indices",
                "# Geometric entity indices",
            ]
        )
        lines.extend(str(int(marker)) for marker in entities)
    payload = ("\n".join(lines) + "\n").encode("utf-8")
    _atomic_write_bytes(target, payload)
    sidecar = Path(f"{target}.fullmag.json")
    _atomic_write_bytes(
        sidecar,
        _canonical_json(
            {
                "schema": COMSOL_INTERCHANGE_SCHEMA,
                "coordinate_unit": "m",
                "mphtxt_sha256": sha256(payload).hexdigest(),
                "source_topology_fingerprint": artifact.topology_fingerprint,
                "region_markers": artifact.region_markers,
                "object_region_markers": artifact.object_region_markers,
                "boundary_map": artifact.boundary_map,
                "cell_global_ordinals": artifact.mesh.cell_global_ordinals.tolist(),
                "facet_global_ordinals": artifact.mesh.facet_global_ordinals.tolist(),
                "cell_mesh_parts": artifact.mesh.cell_mesh_parts.tolist(),
                "periodic_boundary_pairs": artifact.mesh.periodic_boundary_pairs,
                "periodic_node_pairs": artifact.mesh.periodic_node_pairs,
                "volume_marker_fullmag_to_comsol": {
                    str(marker): exported
                    for marker, exported in volume_export_map.items()
                },
                "surface_marker_fullmag_to_comsol": {
                    str(marker): exported
                    for marker, exported in surface_export_map.items()
                },
                "comsol_mesh_serialization_version": 4,
            }
        ),
    )
    return target


def _comsol_tokens(path: Path) -> list[str]:
    tokens: list[str] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            tokens.extend(line.split("#", 1)[0].split())
    except (OSError, UnicodeError) as exc:
        raise MeshArtifactCorruptionError(f"invalid COMSOL text mesh: {exc}") from exc
    return tokens


def import_comsol_mesh(
    path: str | Path,
    *,
    region_map: Mapping[str, int] | None = None,
    boundary_map: Mapping[str, int] | None = None,
    region_entity_map: Mapping[int, int] | None = None,
    boundary_entity_map: Mapping[int, int] | None = None,
    coordinate_unit: str | None = None,
) -> MeshArtifact:
    """Import COMSOL Multiphysics text mesh serialization version 4."""
    source = Path(path)
    if source.suffix.lower() != ".mphtxt":
        raise ValueError("COMSOL interchange import requires a .mphtxt source")
    sidecar_path = Path(f"{source}.fullmag.json")
    sidecar: dict[str, object] = {}
    if sidecar_path.exists():
        try:
            sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise MeshArtifactCorruptionError(f"invalid COMSOL sidecar: {exc}") from exc
        if sidecar.get("schema") != COMSOL_INTERCHANGE_SCHEMA:
            raise MeshArtifactVersionError(
                f"unsupported COMSOL interchange schema {sidecar.get('schema')!r}"
            )
        if sidecar.get("mphtxt_sha256") != sha256(source.read_bytes()).hexdigest():
            raise MeshArtifactCorruptionError("COMSOL sidecar digest does not match .mphtxt")
    resolved_unit = coordinate_unit or sidecar.get("coordinate_unit")
    if resolved_unit not in _COORDINATE_SCALES:
        raise ValueError("coordinate_unit must be explicitly provided as m, mm, um, or nm")
    tokens = _comsol_tokens(source)
    cursor = 0

    def take() -> str:
        nonlocal cursor
        if cursor >= len(tokens):
            raise MeshArtifactCorruptionError("truncated COMSOL text mesh")
        value = tokens[cursor]
        cursor += 1
        return value

    def take_int() -> int:
        try:
            return int(take())
        except ValueError as exc:
            raise MeshArtifactCorruptionError("invalid integer in COMSOL text mesh") from exc

    def take_string() -> str:
        length = take_int()
        value = take()
        if len(value) != length:
            raise MeshArtifactCorruptionError("invalid length-prefixed COMSOL string")
        return value

    if (take_int(), take_int()) != (0, 1):
        raise MeshArtifactVersionError("unsupported COMSOL text file version")
    for _ in range(take_int()):
        take_string()
    for _ in range(take_int()):
        take_string()
    if (take_int(), take_int(), take_int()) != (0, 0, 1) or take_string() != "Mesh":
        raise MeshArtifactCorruptionError("COMSOL text file does not contain a Mesh object")
    mesh_version = take_int()
    if mesh_version != 4:
        raise MeshArtifactVersionError(
            f"unsupported COMSOL Mesh serialization version {mesh_version}; export as v44"
        )
    if take_int() != 3:
        raise MeshArtifactVersionError("only three-dimensional COMSOL meshes are supported")
    node_count = take_int()
    lowest_index = take_int()
    if lowest_index != 0:
        raise MeshArtifactVersionError("COMSOL mesh vertex indices must start at zero")
    coordinates = np.asarray(
        [[float(take()), float(take()), float(take())] for _ in range(node_count)],
        dtype=np.float64,
    ) * _COORDINATE_SCALES[str(resolved_unit)]
    cell_types: list[str] = []
    cell_nodes: list[int] = []
    cell_offsets = [0]
    element_markers: list[int] = []
    facet_types: list[str] = []
    facet_nodes: list[int] = []
    facet_offsets = [0]
    boundary_markers: list[int] = []
    for _ in range(take_int()):
        comsol_kind = take_string()
        expected_arity = _COMSOL_ARITIES.get(
            comsol_kind,
            _COMSOL_IGNORED_LOWER_DIMENSIONAL_ARITIES.get(comsol_kind),
        )
        if expected_arity is None:
            raise MeshSemanticMappingError(
                f"unsupported COMSOL element type {comsol_kind!r}"
            )
        arity = take_int()
        if arity != expected_arity:
            raise MeshSemanticMappingError(
                f"unsupported higher-order COMSOL {comsol_kind} element with {arity} nodes"
            )
        count = take_int()
        rows = [[take_int() for _ in range(arity)] for _ in range(count)]
        marker_count = take_int()
        if marker_count != count:
            raise MeshArtifactCorruptionError(
                f"COMSOL {comsol_kind} entity count does not match element count"
            )
        markers = [take_int() for _ in range(count)]
        if comsol_kind in _COMSOL_IGNORED_LOWER_DIMENSIONAL_ARITIES:
            continue
        kind = _COMSOL_TO_FULLMAG_TYPES[comsol_kind]
        if kind in {"tri3", "quad4"}:
            for row, marker in zip(rows, markers, strict=True):
                facet_types.append(kind)
                facet_nodes.extend(row)
                facet_offsets.append(len(facet_nodes))
                boundary_markers.append(marker)
        else:
            for row, marker in zip(rows, markers, strict=True):
                cell_types.append(kind)
                cell_nodes.extend(row)
                cell_offsets.append(len(cell_nodes))
                element_markers.append(marker)
    if cursor != len(tokens):
        raise MeshArtifactVersionError(
            "COMSOL text mesh contains additional objects; export mesh only as v44"
        )
    volume_translation = {
        int(exported): int(fullmag)
        for fullmag, exported in dict(
            sidecar.get("volume_marker_fullmag_to_comsol", {})
        ).items()
    }
    surface_translation = {
        int(exported): int(fullmag)
        for fullmag, exported in dict(
            sidecar.get("surface_marker_fullmag_to_comsol", {})
        ).items()
    }
    if not sidecar:
        if (
            region_map is None
            or boundary_map is None
            or region_entity_map is None
            or boundary_entity_map is None
        ):
            raise MeshSemanticMappingError(
                "region_map, boundary_map, region_entity_map, and "
                "boundary_entity_map are required without a matching Fullmag sidecar"
            )
        volume_translation = {
            int(external): int(fullmag)
            for external, fullmag in region_entity_map.items()
        }
        surface_translation = {
            int(external): int(fullmag)
            for external, fullmag in boundary_entity_map.items()
        }
    element_markers_array = np.asarray(
        [volume_translation.get(marker, marker) for marker in element_markers],
        dtype=np.int32,
    )
    boundary_markers_array = np.asarray(
        [surface_translation.get(marker, marker) for marker in boundary_markers],
        dtype=np.int32,
    )
    cell_types_array = np.asarray(cell_types)
    cell_offsets_array = np.asarray(cell_offsets, dtype=np.int64)
    cell_nodes_array = np.asarray(cell_nodes, dtype=np.int32)
    facet_offsets_array = np.asarray(facet_offsets, dtype=np.int64)
    facet_nodes_array = np.asarray(facet_nodes, dtype=np.int32)
    facet_roles = _derive_facet_roles(
        cell_types_array,
        cell_offsets_array,
        cell_nodes_array,
        element_markers_array,
        facet_offsets_array,
        facet_nodes_array,
        boundary_markers_array,
    )
    mesh = MeshData(
        nodes=coordinates,
        cell_types=cell_types_array,
        cell_offsets=cell_offsets_array,
        cell_nodes=cell_nodes_array,
        element_markers=element_markers_array,
        facet_types=np.asarray(facet_types),
        facet_roles=facet_roles,
        facet_offsets=facet_offsets_array,
        facet_nodes=facet_nodes_array,
        boundary_markers=boundary_markers_array,
        cell_global_ordinals=np.arange(len(cell_types), dtype=np.int64),
        facet_global_ordinals=np.arange(len(facet_types), dtype=np.int64),
        cell_mesh_parts=np.asarray(
            ["far_air" if marker == 0 else "magnetic" for marker in element_markers_array]
        ),
    )
    mesh.validate_strict(require_positive_orientation=True)
    if validate_mesh_ir(mesh.to_ir("study_domain")) is False:
        raise ValueError("imported COMSOL mesh failed Rust MeshIR validation")
    regions_raw = region_map or {
        str(entry["geometry_name"]): int(entry["marker"])
        for entry in sidecar.get("region_markers", [])
    }
    boundaries_raw = boundary_map or sidecar.get("boundary_map", {})
    if not regions_raw or not boundaries_raw:
        raise MeshSemanticMappingError("COMSOL mesh semantic maps are incomplete")
    present_volume_markers = set(int(value) for value in mesh.element_markers.tolist())
    declared_volume_markers = set(int(value) for value in regions_raw.values())
    if present_volume_markers - {0} != declared_volume_markers:
        raise MeshSemanticMappingError(
            f"volume markers {sorted(present_volume_markers)} do not match "
            f"region_map {sorted(declared_volume_markers)}"
        )
    present_boundary_markers = set(int(value) for value in mesh.boundary_markers.tolist())
    declared_boundary_markers = set(int(value) for value in dict(boundaries_raw).values())
    if present_boundary_markers != declared_boundary_markers:
        raise MeshSemanticMappingError(
            f"boundary markers {sorted(present_boundary_markers)} do not match "
            f"boundary_map {sorted(declared_boundary_markers)}"
        )
    source_sha256 = sha256(source.read_bytes()).hexdigest()
    external_authoring = {
        "external_mesh_sha256": source_sha256,
        "coordinate_unit": resolved_unit,
    }
    return MeshArtifact(
        mesh=mesh,
        mesh_name="study_domain",
        authoring_document=external_authoring,
        authoring_fingerprint=mesh_authoring_fingerprint(external_authoring),
        topology_fingerprint=mesh.topology_fingerprint_v3(),
        region_markers=_normalize_markers(
            [
                {"geometry_name": str(name), "marker": int(marker)}
                for name, marker in regions_raw.items()
            ]
        ),
        object_region_markers=_normalize_markers(
            sidecar.get("object_region_markers", [])
        ),
        boundary_map={
            str(name): int(marker) for name, marker in dict(boundaries_raw).items()
        },
        build_report=None,
        provenance={
            "origin": "comsol_import",
            "source": str(source),
            "source_sha256": source_sha256,
            "comsol_mesh_serialization_version": mesh_version,
        },
    )
