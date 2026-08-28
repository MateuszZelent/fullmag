"""Deterministic schema for certified mixed-mesh artifact bindings."""

from __future__ import annotations

from dataclasses import dataclass
import json
import re
from hashlib import sha256
from typing import Mapping


RECEIPT_SCHEMA_V1 = "fullmag.mesh-certification-receipt.v1"
RECEIPT_SCHEMA_V2 = "fullmag.mesh-certification-receipt.v2"
ARTIFACT_SCHEMA_V2 = "fullmag.mesh-artifact.v2"
MIXED_CERTIFICATE_SCHEMA = "fullmag.mixed-layer-topology-certificate.v1"
MIXED_CERTIFIER_ALGORITHM = "fullmag.mixed-certificate.rust-rayon.v1"
MIXED_REPAIR_ALGORITHM = "fullmag.mixed-tet-repair.v1"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _require_exact_keys(
    value: Mapping[str, object],
    expected: set[str],
    *,
    label: str,
) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        raise ValueError(f"{label} fields differ: missing={missing}, unknown={unknown}")


def _require_sha256(value: object, *, label: str) -> str:
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{label} must be 64 lowercase hexadecimal characters")
    return value


def _require_positive_int(value: object, *, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return value


def _mapping(value: object, *, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be an object")
    return value


@dataclass(frozen=True, slots=True)
class ArtifactMemberBindingV1:
    name: str
    bytes: int
    sha256: str

    def __post_init__(self) -> None:
        if self.name not in {"topology.npz", "build-report.json"}:
            raise ValueError("receipt member name is unsupported")
        _require_positive_int(self.bytes, label=f"{self.name}.bytes")
        _require_sha256(self.sha256, label=f"{self.name}.sha256")

    @classmethod
    def from_dict(cls, value: Mapping[str, object], *, expected_name: str):
        _require_exact_keys(value, {"name", "bytes", "sha256"}, label=expected_name)
        if value["name"] != expected_name:
            raise ValueError(f"member name must be {expected_name!r}")
        return cls(
            name=expected_name,
            bytes=_require_positive_int(value["bytes"], label=f"{expected_name}.bytes"),
            sha256=_require_sha256(value["sha256"], label=f"{expected_name}.sha256"),
        )

    @classmethod
    def from_bytes(cls, name: str, payload: bytes):
        return cls(name=name, bytes=len(payload), sha256=sha256(payload).hexdigest())

    def to_dict(self) -> dict[str, object]:
        return {"name": self.name, "bytes": self.bytes, "sha256": self.sha256}


@dataclass(frozen=True, slots=True)
class CertificateBindingV1:
    schema: str
    payload_sha256: str
    algorithm_id: str

    def __post_init__(self) -> None:
        if self.schema != MIXED_CERTIFICATE_SCHEMA:
            raise ValueError("certificate schema is unsupported")
        _require_sha256(self.payload_sha256, label="certificate.payload_sha256")
        if self.algorithm_id != MIXED_CERTIFIER_ALGORITHM:
            raise ValueError("certificate algorithm_id is unsupported")

    @classmethod
    def from_dict(cls, value: Mapping[str, object]):
        _require_exact_keys(
            value,
            {"schema", "payload_sha256", "algorithm_id"},
            label="certificate",
        )
        if value["schema"] != MIXED_CERTIFICATE_SCHEMA:
            raise ValueError("certificate schema is unsupported")
        if value["algorithm_id"] != MIXED_CERTIFIER_ALGORITHM:
            raise ValueError("certificate algorithm_id is unsupported")
        return cls(
            schema=MIXED_CERTIFICATE_SCHEMA,
            payload_sha256=_require_sha256(
                value["payload_sha256"], label="certificate.payload_sha256"
            ),
            algorithm_id=MIXED_CERTIFIER_ALGORITHM,
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "schema": self.schema,
            "payload_sha256": self.payload_sha256,
            "algorithm_id": self.algorithm_id,
        }


@dataclass(frozen=True, slots=True)
class AuthoringBindingV1:
    document_sha256: str
    resolved_policy_sha256: str

    def __post_init__(self) -> None:
        _require_sha256(self.document_sha256, label="authoring.document_sha256")
        _require_sha256(
            self.resolved_policy_sha256,
            label="authoring.resolved_policy_sha256",
        )

    @classmethod
    def from_dict(cls, value: Mapping[str, object]):
        _require_exact_keys(
            value,
            {"document_sha256", "resolved_policy_sha256"},
            label="authoring",
        )
        return cls(
            document_sha256=_require_sha256(
                value["document_sha256"], label="authoring.document_sha256"
            ),
            resolved_policy_sha256=_require_sha256(
                value["resolved_policy_sha256"],
                label="authoring.resolved_policy_sha256",
            ),
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "document_sha256": self.document_sha256,
            "resolved_policy_sha256": self.resolved_policy_sha256,
        }


@dataclass(frozen=True, slots=True)
class ProducerBindingV1:
    source_snapshot_sha256: str
    gmsh_version: str
    repair_algorithm_id: str
    repair_method: str
    repair_iterations: int
    gmsh_threads: int
    certifier_backend: str
    certifier_threads: int

    def __post_init__(self) -> None:
        _require_sha256(
            self.source_snapshot_sha256,
            label="producer.source_snapshot_sha256",
        )
        if self.gmsh_version != "4.15.2":
            raise ValueError("producer.gmsh_version must be '4.15.2'")
        if self.repair_algorithm_id != MIXED_REPAIR_ALGORITHM:
            raise ValueError("producer.repair_algorithm_id is unsupported")
        if self.repair_method != "Relocate3D":
            raise ValueError("producer.repair_method must be 'Relocate3D'")
        repair_iterations = _require_positive_int(
            self.repair_iterations,
            label="producer.repair_iterations",
        )
        if repair_iterations != 1:
            raise ValueError("producer.repair_iterations must be 1")
        gmsh_threads = _require_positive_int(
            self.gmsh_threads,
            label="producer.gmsh_threads",
        )
        if gmsh_threads != 1:
            raise ValueError("producer.gmsh_threads must be 1")
        if self.certifier_backend != "rust_rayon":
            raise ValueError("producer.certifier_backend must be 'rust_rayon'")
        _require_positive_int(
            self.certifier_threads, label="producer.certifier_threads"
        )

    @classmethod
    def from_dict(cls, value: Mapping[str, object]):
        expected = {
            "source_snapshot_sha256",
            "gmsh_version",
            "repair_algorithm_id",
            "repair_method",
            "repair_iterations",
            "gmsh_threads",
            "certifier_backend",
            "certifier_threads",
        }
        _require_exact_keys(value, expected, label="producer")
        if value["gmsh_version"] != "4.15.2":
            raise ValueError("producer.gmsh_version must be '4.15.2'")
        if value["repair_algorithm_id"] != MIXED_REPAIR_ALGORITHM:
            raise ValueError("producer.repair_algorithm_id is unsupported")
        if value["repair_method"] != "Relocate3D":
            raise ValueError("producer.repair_method must be 'Relocate3D'")
        repair_iterations = _require_positive_int(
            value["repair_iterations"],
            label="producer.repair_iterations",
        )
        if repair_iterations != 1:
            raise ValueError("producer.repair_iterations must be 1")
        gmsh_threads = _require_positive_int(
            value["gmsh_threads"],
            label="producer.gmsh_threads",
        )
        if gmsh_threads != 1:
            raise ValueError("producer.gmsh_threads must be 1")
        if value["certifier_backend"] != "rust_rayon":
            raise ValueError("producer.certifier_backend must be 'rust_rayon'")
        return cls(
            source_snapshot_sha256=_require_sha256(
                value["source_snapshot_sha256"],
                label="producer.source_snapshot_sha256",
            ),
            gmsh_version="4.15.2",
            repair_algorithm_id=MIXED_REPAIR_ALGORITHM,
            repair_method="Relocate3D",
            repair_iterations=repair_iterations,
            gmsh_threads=gmsh_threads,
            certifier_backend="rust_rayon",
            certifier_threads=_require_positive_int(
                value["certifier_threads"], label="producer.certifier_threads"
            ),
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "source_snapshot_sha256": self.source_snapshot_sha256,
            "gmsh_version": self.gmsh_version,
            "repair_algorithm_id": self.repair_algorithm_id,
            "repair_method": self.repair_method,
            "repair_iterations": self.repair_iterations,
            "gmsh_threads": self.gmsh_threads,
            "certifier_backend": self.certifier_backend,
            "certifier_threads": self.certifier_threads,
        }


@dataclass(frozen=True, slots=True)
class MeshCountsV1:
    nodes: int
    cells: int
    facets: int

    def __post_init__(self) -> None:
        _require_positive_int(self.nodes, label="mesh_counts.nodes")
        _require_positive_int(self.cells, label="mesh_counts.cells")
        _require_positive_int(self.facets, label="mesh_counts.facets")

    @classmethod
    def from_dict(cls, value: Mapping[str, object]):
        _require_exact_keys(value, {"nodes", "cells", "facets"}, label="mesh_counts")
        return cls(
            nodes=_require_positive_int(value["nodes"], label="mesh_counts.nodes"),
            cells=_require_positive_int(value["cells"], label="mesh_counts.cells"),
            facets=_require_positive_int(value["facets"], label="mesh_counts.facets"),
        )

    def to_dict(self) -> dict[str, int]:
        return {"nodes": self.nodes, "cells": self.cells, "facets": self.facets}


@dataclass(frozen=True, slots=True)
class CertificationReceiptBindingsV1:
    resolved_policy_sha256: str
    source_snapshot_sha256: str
    gmsh_version: str
    repair_algorithm_id: str
    repair_method: str
    repair_iterations: int
    gmsh_threads: int
    certifier_algorithm_id: str
    certifier_backend: str
    certifier_threads: int

    def __post_init__(self) -> None:
        _require_sha256(self.resolved_policy_sha256, label="resolved_policy_sha256")
        ProducerBindingV1.from_dict(
            {
                "source_snapshot_sha256": self.source_snapshot_sha256,
                "gmsh_version": self.gmsh_version,
                "repair_algorithm_id": self.repair_algorithm_id,
                "repair_method": self.repair_method,
                "repair_iterations": self.repair_iterations,
                "gmsh_threads": self.gmsh_threads,
                "certifier_backend": self.certifier_backend,
                "certifier_threads": self.certifier_threads,
            }
        )
        if self.certifier_algorithm_id != MIXED_CERTIFIER_ALGORITHM:
            raise ValueError("certifier_algorithm_id is unsupported")

    def producer(self) -> ProducerBindingV1:
        return ProducerBindingV1.from_dict(
            {
                "source_snapshot_sha256": self.source_snapshot_sha256,
                "gmsh_version": self.gmsh_version,
                "repair_algorithm_id": self.repair_algorithm_id,
                "repair_method": self.repair_method,
                "repair_iterations": self.repair_iterations,
                "gmsh_threads": self.gmsh_threads,
                "certifier_backend": self.certifier_backend,
                "certifier_threads": self.certifier_threads,
            }
        )


_RECEIPT_COMMON_FIELDS = {
    "schema",
    "artifact_schema",
    "topology_member",
    "build_report_member",
    "topology_fingerprint_v3",
    "certificate",
    "authoring",
    "producer",
    "mesh_counts",
}


def _validate_receipt_common(receipt: object, *, expected_schema: str) -> None:
    if getattr(receipt, "schema") != expected_schema:
        raise ValueError("certification receipt schema is unsupported")
    if getattr(receipt, "artifact_schema") != ARTIFACT_SCHEMA_V2:
        raise ValueError("certification receipt artifact_schema is unsupported")
    topology_member = getattr(receipt, "topology_member")
    if not isinstance(topology_member, ArtifactMemberBindingV1) or (
        topology_member.name != "topology.npz"
    ):
        raise ValueError("certification receipt topology_member is invalid")
    build_report_member = getattr(receipt, "build_report_member")
    if not isinstance(build_report_member, ArtifactMemberBindingV1) or (
        build_report_member.name != "build-report.json"
    ):
        raise ValueError("certification receipt build_report_member is invalid")
    _require_sha256(
        getattr(receipt, "topology_fingerprint_v3"),
        label="topology_fingerprint_v3",
    )
    if not isinstance(getattr(receipt, "certificate"), CertificateBindingV1):
        raise TypeError("certification receipt certificate is invalid")
    if not isinstance(getattr(receipt, "authoring"), AuthoringBindingV1):
        raise TypeError("certification receipt authoring is invalid")
    if not isinstance(getattr(receipt, "producer"), ProducerBindingV1):
        raise TypeError("certification receipt producer is invalid")
    if not isinstance(getattr(receipt, "mesh_counts"), MeshCountsV1):
        raise TypeError("certification receipt mesh_counts is invalid")


def _receipt_common_from_dict(
    value: Mapping[str, object],
    *,
    expected_schema: str,
    extra_fields: set[str] | None = None,
) -> dict[str, object]:
    _require_exact_keys(
        value,
        _RECEIPT_COMMON_FIELDS | (extra_fields or set()),
        label="certification receipt",
    )
    if value["schema"] != expected_schema:
        raise ValueError("certification receipt schema is unsupported")
    if value["artifact_schema"] != ARTIFACT_SCHEMA_V2:
        raise ValueError("certification receipt artifact_schema is unsupported")
    return {
        "topology_member": ArtifactMemberBindingV1.from_dict(
            _mapping(value["topology_member"], label="topology_member"),
            expected_name="topology.npz",
        ),
        "build_report_member": ArtifactMemberBindingV1.from_dict(
            _mapping(value["build_report_member"], label="build_report_member"),
            expected_name="build-report.json",
        ),
        "topology_fingerprint_v3": _require_sha256(
            value["topology_fingerprint_v3"], label="topology_fingerprint_v3"
        ),
        "certificate": CertificateBindingV1.from_dict(
            _mapping(value["certificate"], label="certificate")
        ),
        "authoring": AuthoringBindingV1.from_dict(
            _mapping(value["authoring"], label="authoring")
        ),
        "producer": ProducerBindingV1.from_dict(
            _mapping(value["producer"], label="producer")
        ),
        "mesh_counts": MeshCountsV1.from_dict(
            _mapping(value["mesh_counts"], label="mesh_counts")
        ),
    }


def _receipt_common_from_components(
    *,
    topology_bytes: bytes,
    build_report_bytes: bytes,
    topology_fingerprint_v3: str,
    certificate_payload_sha256: str,
    authoring_document_sha256: str,
    bindings: CertificationReceiptBindingsV1,
    mesh_counts: Mapping[str, object],
) -> dict[str, object]:
    return {
        "topology_member": ArtifactMemberBindingV1.from_bytes(
            "topology.npz", topology_bytes
        ),
        "build_report_member": ArtifactMemberBindingV1.from_bytes(
            "build-report.json", build_report_bytes
        ),
        "topology_fingerprint_v3": _require_sha256(
            topology_fingerprint_v3.removeprefix("sha256:"),
            label="topology_fingerprint_v3",
        ),
        "certificate": CertificateBindingV1.from_dict(
            {
                "schema": MIXED_CERTIFICATE_SCHEMA,
                "payload_sha256": certificate_payload_sha256.removeprefix("sha256:"),
                "algorithm_id": bindings.certifier_algorithm_id,
            }
        ),
        "authoring": AuthoringBindingV1.from_dict(
            {
                "document_sha256": authoring_document_sha256,
                "resolved_policy_sha256": bindings.resolved_policy_sha256,
            }
        ),
        "producer": bindings.producer(),
        "mesh_counts": MeshCountsV1.from_dict(mesh_counts),
    }


def _receipt_common_to_dict(receipt: object) -> dict[str, object]:
    return {
        "schema": getattr(receipt, "schema"),
        "artifact_schema": getattr(receipt, "artifact_schema"),
        "topology_member": getattr(receipt, "topology_member").to_dict(),
        "build_report_member": getattr(receipt, "build_report_member").to_dict(),
        "topology_fingerprint_v3": getattr(receipt, "topology_fingerprint_v3"),
        "certificate": getattr(receipt, "certificate").to_dict(),
        "authoring": getattr(receipt, "authoring").to_dict(),
        "producer": getattr(receipt, "producer").to_dict(),
        "mesh_counts": getattr(receipt, "mesh_counts").to_dict(),
    }


def _receipt_json_bytes(receipt: object) -> bytes:
    return json.dumps(
        getattr(receipt, "to_dict")(),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


@dataclass(frozen=True, slots=True)
class CertificationReceiptV1:
    topology_member: ArtifactMemberBindingV1
    build_report_member: ArtifactMemberBindingV1
    topology_fingerprint_v3: str
    certificate: CertificateBindingV1
    authoring: AuthoringBindingV1
    producer: ProducerBindingV1
    mesh_counts: MeshCountsV1
    schema: str = RECEIPT_SCHEMA_V1
    artifact_schema: str = ARTIFACT_SCHEMA_V2

    def __post_init__(self) -> None:
        _validate_receipt_common(self, expected_schema=RECEIPT_SCHEMA_V1)

    @classmethod
    def from_dict(cls, value: Mapping[str, object]):
        return cls(
            **_receipt_common_from_dict(
                value,
                expected_schema=RECEIPT_SCHEMA_V1,
            )
        )

    @classmethod
    def from_components(cls, **components: object):
        return cls(**_receipt_common_from_components(**components))  # type: ignore[arg-type]

    def to_dict(self) -> dict[str, object]:
        return _receipt_common_to_dict(self)

    def to_json_bytes(self) -> bytes:
        return _receipt_json_bytes(self)


@dataclass(frozen=True, slots=True)
class CertificationReceiptV2:
    topology_member: ArtifactMemberBindingV1
    build_report_member: ArtifactMemberBindingV1
    topology_fingerprint_v3: str
    semantic_manifest_sha256: str
    certificate: CertificateBindingV1
    authoring: AuthoringBindingV1
    producer: ProducerBindingV1
    mesh_counts: MeshCountsV1
    schema: str = RECEIPT_SCHEMA_V2
    artifact_schema: str = ARTIFACT_SCHEMA_V2

    def __post_init__(self) -> None:
        _validate_receipt_common(self, expected_schema=RECEIPT_SCHEMA_V2)
        _require_sha256(
            self.semantic_manifest_sha256,
            label="semantic_manifest_sha256",
        )

    @classmethod
    def from_dict(cls, value: Mapping[str, object]):
        common = _receipt_common_from_dict(
            value,
            expected_schema=RECEIPT_SCHEMA_V2,
            extra_fields={"semantic_manifest_sha256"},
        )
        return cls(
            **common,
            semantic_manifest_sha256=_require_sha256(
                value["semantic_manifest_sha256"],
                label="semantic_manifest_sha256",
            ),
        )

    @classmethod
    def from_components(
        cls,
        *,
        semantic_manifest_sha256: str,
        **components: object,
    ):
        return cls(
            **_receipt_common_from_components(**components),  # type: ignore[arg-type]
            semantic_manifest_sha256=_require_sha256(
                semantic_manifest_sha256.removeprefix("sha256:"),
                label="semantic_manifest_sha256",
            ),
        )

    def to_dict(self) -> dict[str, object]:
        payload = _receipt_common_to_dict(self)
        payload["semantic_manifest_sha256"] = self.semantic_manifest_sha256
        return payload

    def to_json_bytes(self) -> bytes:
        return _receipt_json_bytes(self)
