"""Validated reusable equilibrium artifacts for the periodic-antidot examples."""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "fem_periodic_antidot_equilibrium_cache.v2"
IDENTITY_SCHEMA_VERSION = "fem_periodic_antidot_equilibrium_identity.v1"
CACHE_IDENTITY_NAMESPACE = "fem_periodic_antidot_equilibrium_cache_identity.v1"
_SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


@dataclass(frozen=True)
class PeriodicAntidotEquilibriumCache:
    """Paths and provenance loaded from one immutable equilibrium cache."""

    root: Path
    manifest: dict[str, Any]
    domain_mesh_path: Path
    equilibrium_state_path: Path
    magnetic_state_path: Path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return f"sha256:{digest.hexdigest()}"


def _canonical_json_sha256(namespace: str, value: Any) -> str:
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid equilibrium cache identity payload: {exc}") from exc
    digest = hashlib.sha256()
    digest.update(namespace.encode("utf-8"))
    digest.update(b"\0")
    digest.update(encoded)
    return f"sha256:{digest.hexdigest()}"


def _require_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{label} must be a canonical sha256 digest")
    return value


def _require_finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} must be a finite number")
    return result


def _validate_completion(manifest: dict[str, Any]) -> None:
    completion = manifest.get("completion")
    if not isinstance(completion, dict):
        raise ValueError("equilibrium cache completion must be an object")
    required = {
        "status": "completed",
        "converged": True,
        "stop_reason": "torque",
        "metric_kind": "max_torque_apm",
        "metric_unit": "A/m",
    }
    for key, expected in required.items():
        if completion.get(key) != expected:
            raise ValueError(f"equilibrium cache completion.{key} is not accepted")
    metric_value = _require_finite_number(
        completion.get("metric_value"), "equilibrium cache completion.metric_value"
    )
    threshold = _require_finite_number(
        completion.get("threshold"), "equilibrium cache completion.threshold"
    )
    if metric_value < 0.0 or threshold <= 0.0 or metric_value > threshold:
        raise ValueError("equilibrium cache completion does not satisfy its torque threshold")
    equilibrium = manifest.get("equilibrium")
    if not isinstance(equilibrium, dict):
        raise ValueError("equilibrium cache equilibrium must be an object")
    if (
        equilibrium.get("final_torque_apm") != metric_value
        or equilibrium.get("torque_tolerance_a_per_m") != threshold
    ):
        raise ValueError("equilibrium cache completion and equilibrium metadata disagree")


def _validate_cache_identity(manifest: dict[str, Any]) -> dict[str, Any]:
    expected = _require_sha256(
        manifest.get("cache_identity_sha256"),
        "equilibrium cache cache_identity_sha256",
    )
    payload = dict(manifest)
    payload.pop("cache_identity_sha256", None)
    actual = _canonical_json_sha256(CACHE_IDENTITY_NAMESPACE, payload)
    if actual != expected:
        raise ValueError("equilibrium cache identity failed its canonical sha256 check")
    identity = manifest.get("identity")
    if not isinstance(identity, dict):
        raise ValueError("equilibrium cache identity must be an object")
    if identity.get("schema_version") != IDENTITY_SCHEMA_VERSION:
        raise ValueError("unsupported equilibrium cache identity schema")
    for key in (
        "source_problem_sha256",
        "execution_plan_sha256",
        "equilibrium_contract_sha256",
        "mesh_content_sha256",
        "node_indexing_sha256",
        "part_registry_sha256",
    ):
        _require_sha256(identity.get(key), f"equilibrium cache identity.{key}")
    return identity


def _relative_artifact(root: Path, manifest: dict[str, Any], key: str) -> Path:
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict):
        raise ValueError("equilibrium cache manifest.artifacts must be an object")
    item = artifacts.get(key)
    if not isinstance(item, dict):
        raise ValueError(f"equilibrium cache manifest.artifacts.{key} must be an object")
    relative = item.get("path")
    expected_digest = item.get("sha256")
    if not isinstance(relative, str) or not relative.strip():
        raise ValueError(f"equilibrium cache artifact {key} path is missing")
    relative_path = Path(relative)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise ValueError(f"equilibrium cache artifact {key} path must stay below the cache root")
    path = (root / relative_path).resolve()
    if root.resolve() not in path.parents:
        raise ValueError(f"equilibrium cache artifact {key} escapes the cache root")
    if not path.is_file():
        raise ValueError(f"equilibrium cache artifact {key} is missing: {path}")
    if not isinstance(expected_digest, str) or _sha256(path) != expected_digest:
        raise ValueError(f"equilibrium cache artifact {key} failed its sha256 check")
    return path


def load_periodic_antidot_equilibrium_cache(cache_root: str | Path) -> PeriodicAntidotEquilibriumCache:
    """Load and hash-verify a cache before it can affect a simulation."""

    root = Path(cache_root).expanduser().resolve()
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise ValueError(f"periodic-antidot equilibrium cache manifest is missing: {manifest_path}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid periodic-antidot equilibrium cache manifest: {exc}") from exc
    if not isinstance(manifest, dict):
        raise ValueError("periodic-antidot equilibrium cache manifest must be an object")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("unsupported periodic-antidot equilibrium cache schema")
    if manifest.get("kind") != "fem_periodic_antidot_equilibrium_cache":
        raise ValueError("unsupported periodic-antidot equilibrium cache kind")
    if manifest.get("scenario") != "relax_then_eigenmodes_k0":
        raise ValueError("equilibrium cache scenario is not the periodic-antidot K0 scenario")
    identity = _validate_cache_identity(manifest)
    _validate_completion(manifest)
    domain_mesh_path = _relative_artifact(root, manifest, "domain_mesh")
    equilibrium_state_path = _relative_artifact(root, manifest, "equilibrium_state")
    magnetic_state_path = _relative_artifact(root, manifest, "magnetic_state")
    try:
        domain_mesh = json.loads(domain_mesh_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid equilibrium cache domain mesh: {exc}") from exc
    if not isinstance(domain_mesh, dict):
        raise ValueError("equilibrium cache domain mesh must be an object")
    mesh = manifest.get("mesh")
    if not isinstance(mesh, dict):
        raise ValueError("equilibrium cache mesh identity must be an object")
    nodes = domain_mesh.get("nodes")
    if not isinstance(nodes, list) or mesh.get("node_count") != len(nodes):
        raise ValueError("equilibrium cache mesh node count disagrees with domain_mesh.json")
    if identity["mesh_content_sha256"] != _canonical_json_sha256(
        "fem_periodic_antidot_domain_mesh.v1", domain_mesh
    ):
        raise ValueError("equilibrium cache domain mesh content identity mismatch")
    if identity["node_indexing_sha256"] != _canonical_json_sha256(
        "fem_periodic_antidot_mesh_indexing.v1",
        {"nodes": nodes, "cells": domain_mesh.get("cells")},
    ):
        raise ValueError("equilibrium cache node indexing identity mismatch")
    return PeriodicAntidotEquilibriumCache(
        root=root,
        manifest=manifest,
        domain_mesh_path=domain_mesh_path,
        equilibrium_state_path=equilibrium_state_path,
        magnetic_state_path=magnetic_state_path,
    )
