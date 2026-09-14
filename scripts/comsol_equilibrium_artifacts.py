"""Read native per-sample equilibrium/state pairs without filename guessing."""
import hashlib
import json
from pathlib import Path
from collections.abc import Mapping

import verify_fem_frequency_domain_eigen_artifacts as verifier
from comsol_linearization_binding import validate_linearization_binding
from comsol_mesh_identity import mesh_topology_fingerprint_v2
from comsol_magnetic_support import magnetic_element_indices, tet4_cells


def sample_state_paths(manifest, sample_index):
    if type(sample_index) is not int or sample_index < 0:
        raise ValueError("sample_index must be a nonnegative integer")
    artifacts = manifest.get("artifacts") if isinstance(manifest, Mapping) else None
    if not isinstance(artifacts, Mapping):
        raise ValueError("manifest.artifacts are required")
    selected = []
    for stem, filename in (("equilibrium_artifact_v7", "equilibrium_artifact.v7.json"), ("linearization_state_v6", "linearization_state.v6.json")):
        singular = artifacts.get(stem + "_path")
        plural = artifacts.get(stem + "_paths")
        if singular is not None and plural is not None:
            raise ValueError("ambiguous singular and per-sample state paths")
        if singular is not None:
            expected = "eigen/metadata/" + filename
            if sample_index != 0 or singular != expected:
                raise ValueError("single-state path does not match sample zero")
        else:
            expected = f"eigen/metadata/sample_{sample_index:04d}/" + filename
            if not isinstance(plural, list) or any(not isinstance(item, str) for item in plural) or len(set(plural)) != len(plural) or expected not in plural:
                raise ValueError("missing or duplicated per-sample state path")
        selected.append(expected)
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
    verifier.validate_equilibrium_artifact_v7_payload(equilibrium, mode.get("equilibrium_artifact_sha256"))
    plan = metadata["execution_plan"]["backend_plan"]
    mesh = plan["mesh"]
    computed_signature = mesh_topology_fingerprint_v2(mesh)
    if mesh_signature is not None and mesh_signature != computed_signature:
        raise ValueError("expected mesh signature differs from the input mesh")
    cells = tet4_cells(mesh)
    elements = magnetic_element_indices(mesh, plan.get("mesh_parts"))
    nodes = sorted({node for element in elements for node in cells[element]})
    result = validate_linearization_binding(equilibrium, state, mode, nodes, node_count=len(mesh["nodes"]), mesh_signature=computed_signature)
    result["file_hashes"] = hashes
    result["sample_index"] = sample_index
    return result
