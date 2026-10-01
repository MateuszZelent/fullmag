"""Read native per-sample equilibrium/state pairs without filename guessing."""
import hashlib
import json
import math
from pathlib import Path
from collections.abc import Mapping

import verify_fem_frequency_domain_eigen_artifacts as verifier
from comsol_linearization_binding import validate_linearization_binding
from comsol_mesh_identity import mesh_topology_fingerprint_v2, mesh_topology_fingerprint_v3
from comsol_magnetic_support import magnetic_element_indices, tet4_cells


def physics_signature_from_plan(plan):
    """Match eigen_shared_domain.rs physics_signature JSON Value preimage."""
    for key in ("enable_exchange", "enable_demag"):
        if type(plan.get(key)) is not bool:
            raise ValueError(f"resolved boolean {key} is required")
    realization = None
    if plan["enable_demag"]:
        name = plan.get("demag_realization")
        if name is None:
            name = "poisson_robin"
        if name not in ("poisson_dirichlet", "poisson_robin", "bem", "fredkin_koehler", "fmm"):
            raise ValueError("canonical resolved demag realization is required")
        realization = "fem_" + name
    payload = {
        "enable_exchange": plan["enable_exchange"], "enable_demag": plan["enable_demag"],
        "external_field_a_per_m": plan["external_field"],
        "gyromagnetic_ratio": plan["gyromagnetic_ratio"],
        "damping": plan["material"]["damping"], "operator": plan["operator"],
        "demag_realization": realization,
    }
    return "sha256:" + hashlib.sha256(verifier.serde_json_compact_bytes(payload)).hexdigest()


def sample_state_paths(manifest, sample_index):
    if type(sample_index) is not int or sample_index < 0:
        raise ValueError("sample_index must be a nonnegative integer")
    artifacts = manifest.get("artifacts") if isinstance(manifest, Mapping) else None
    if not isinstance(artifacts, Mapping):
        raise ValueError("manifest.artifacts are required")
    v8_keys = {
        "equilibrium_artifact_v8_path",
        "equilibrium_artifact_v8_paths",
        "linearization_state_v7_path",
        "linearization_state_v7_paths",
    }
    v7_keys = {
        "equilibrium_artifact_v7_path",
        "equilibrium_artifact_v7_paths",
        "linearization_state_v6_path",
        "linearization_state_v6_paths",
    }
    def has_declared_path(keys):
        return any(
            key in artifacts
            and artifacts.get(key) is not None
            and artifacts.get(key) != []
            for key in keys
        )

    for key in v8_keys | v7_keys:
        if key not in artifacts:
            continue
        value = artifacts.get(key)
        if key.endswith("_paths"):
            if not isinstance(value, list):
                raise ValueError(f"{key} must be a list")
        elif not isinstance(value, str) or not value.strip():
            raise ValueError(f"{key} must be a non-empty path")

    has_v8 = has_declared_path(v8_keys)
    has_v7 = has_declared_path(v7_keys)
    if has_v8 and has_v7:
        raise ValueError("mixed v8/v7 and legacy v7/v6 state paths")
    if has_v8:
        families = (
            ("equilibrium_artifact_v8", "equilibrium_artifact.v8.json"),
            ("linearization_state_v7", "linearization_state.v7.json"),
        )
    elif has_v7:
        families = (
            ("equilibrium_artifact_v7", "equilibrium_artifact.v7.json"),
            ("linearization_state_v6", "linearization_state.v6.json"),
        )
    else:
        raise ValueError("manifest has no supported equilibrium/state paths")

    selected = []
    requested_sample_keys = []
    sample_key_sets = []
    for stem, filename in families:
        singular = artifacts.get(stem + "_path")
        plural = artifacts.get(stem + "_paths")
        if singular is not None and plural is not None:
            raise ValueError("ambiguous singular and per-sample state paths")
        if singular is not None:
            expected = "eigen/metadata/" + filename
            if sample_index != 0 or singular != expected:
                raise ValueError("single-state path does not match sample zero")
            requested_sample_keys.append("")
            sample_key_sets.append({""})
        else:
            expected = f"eigen/metadata/sample_{sample_index:04d}/" + filename
            if (
                not isinstance(plural, list)
                or not plural
                or any(not isinstance(item, str) for item in plural)
                or len(set(plural)) != len(plural)
            ):
                raise ValueError("missing or duplicated per-sample state paths")
            keys = set()
            for item in plural:
                normalized = Path(item).as_posix()
                prefix = "eigen/metadata/"
                if (
                    not normalized.startswith(prefix)
                    or not normalized.endswith(filename)
                    or ".." in Path(item).parts
                ):
                    raise ValueError("invalid per-sample state path")
                key = normalized[len(prefix) : -len(filename)].rstrip("/")
                if key in keys:
                    raise ValueError("duplicate per-sample filename key")
                keys.add(key)
            requested_sample_keys.append(f"sample_{sample_index:04d}")
            sample_key_sets.append(keys)
        selected.append(expected)
    if sample_key_sets[0] != sample_key_sets[1]:
        raise ValueError("equilibrium/state sample filename keys do not match")
    for requested_key, keys in zip(requested_sample_keys, sample_key_sets):
        if requested_key not in keys:
            raise ValueError("missing requested per-sample state path")
    return tuple(selected)


def read_sample_equilibrium(root, manifest, metadata, mode, sample_index, *, mesh_signature=None):
    """Bind the actual state to a mode; acceptance and field checks are mandatory.

    The mesh signature is recomputed from canonical metadata. An optional
    expected signature is an additional check, never a replacement.
    """
    root = Path(root)
    paths = sample_state_paths(manifest, sample_index)
    objects, hashes = [], []
    for relative in paths:
        path = root / relative
        for candidate in (path, *path.parents):
            if candidate.is_symlink() or (hasattr(candidate, "is_junction") and candidate.is_junction()):
                raise ValueError("state artifact path contains a link")
            if candidate == root:
                break
        data = path.read_bytes()
        objects.append(json.loads(data))
        hashes.append({"path": relative, "sha256": "sha256:" + hashlib.sha256(data).hexdigest()})
    equilibrium, state = objects
    if equilibrium.get("schema_version") == "equilibrium_artifact.v8":
        verifier.validate_equilibrium_artifact_v8_payload(
            equilibrium, mode.get("equilibrium_artifact_sha256")
        )
        verifier.validate_linearization_state_v7_payload(
            state,
            equilibrium,
            mode.get("linearization_state_sha256"),
        )
    else:
        verifier.validate_equilibrium_artifact_v7_payload(
            equilibrium, mode.get("equilibrium_artifact_sha256")
        )
    plan = metadata["execution_plan"]["backend_plan"]
    fields = (plan.get("external_field"), equilibrium.get("external_field_a_per_m"))
    for field in fields:
        if not isinstance(field, list) or len(field) != 3 or any(type(x) not in (int, float) or not math.isfinite(x) for x in field):
            raise ValueError("finite external field is required in plan and equilibrium")
    if fields[0] != fields[1]:
        raise ValueError("equilibrium external field differs from the numeric plan")
    if equilibrium.get("physics_signature") != physics_signature_from_plan(plan):
        raise ValueError("equilibrium physics signature differs from the numeric plan")
    mesh = plan["mesh"]
    computed_signature = mesh_topology_fingerprint_v2(mesh)
    if mesh_signature is not None and mesh_signature != computed_signature:
        raise ValueError("expected mesh signature differs from the input mesh")
    cells = tet4_cells(mesh)
    elements = magnetic_element_indices(mesh, plan.get("mesh_parts"))
    nodes = sorted({node for element in elements for node in cells[element]})
    result = validate_linearization_binding(
        equilibrium,
        state,
        mode,
        nodes,
        node_count=len(mesh["nodes"]),
        mesh_signature=computed_signature,
        modal_mesh_signature=mesh_topology_fingerprint_v3(mesh),
    )
    result["file_hashes"] = hashes
    result["sample_index"] = sample_index
    return result
