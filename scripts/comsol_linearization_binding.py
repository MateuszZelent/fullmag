"""Cross-check actual magnetic m0 and content identities used by a mode.

This primitive complements (not replaces) equilibrium acceptance validation.
The caller supplies the independently checked equilibrium signature and the
modal source signature separately. No initial magnetization from the plan is
substituted.
"""
import hashlib
import math
from collections.abc import Mapping
from verify_fem_frequency_domain_eigen_artifacts import (
    equilibrium_artifact_v7_digest,
    equilibrium_artifact_v8_digest,
    serde_json_compact_bytes,
)


def _sha256_token(value, name):
    if not isinstance(value, str) or not value.startswith("sha256:") or len(value) != 71:
        raise ValueError(f"{name} must be a sha256 identity")
    if any(char not in "0123456789abcdef" for char in value[7:]):
        raise ValueError(f"{name} must be a lowercase sha256 identity")
    return value


def _validate_v8_material_identity(payload, name):
    canonical = _sha256_token(payload.get("material_signature"), f"{name}.material_signature")
    _sha256_token(
        payload.get("material_provenance_signature"),
        f"{name}.material_provenance_signature",
    )
    if payload.get("material_identity_kind") != "canonical_equilibrium_material.v2":
        raise ValueError(f"{name}.material_identity_kind is not canonical_equilibrium_material.v2")
    if payload.get("material_provenance_scope") != "materialization_plan":
        raise ValueError(f"{name}.material_provenance_scope is not materialization_plan")
    return canonical


def validate_linearization_binding(
    equilibrium,
    state,
    mode,
    magnetic_nodes,
    *,
    node_count,
    mesh_signature,
    modal_mesh_signature=None,
):
    if not all(isinstance(value, Mapping) for value in (equilibrium, state, mode)):
        raise ValueError("equilibrium, state and mode must be objects")
    equilibrium_schema = equilibrium.get("schema_version")
    state_schema = state.get("schema_version")
    if equilibrium_schema == "equilibrium_artifact.v8" and state_schema == "LinearizationState.v7":
        schema_family = "v8"
        equilibrium_id_prefix = "equilibrium_artifact.v8:"
        state_id_prefix = "LinearizationState.v7:"
        digest_fn = equilibrium_artifact_v8_digest
    elif equilibrium_schema == "equilibrium_artifact.v7" and state_schema == "LinearizationState.v6":
        schema_family = "legacy"
        equilibrium_id_prefix = "equilibrium_artifact.v7:"
        state_id_prefix = "LinearizationState.v6:"
        digest_fn = equilibrium_artifact_v7_digest
    else:
        raise ValueError("equilibrium/state schema pair is unsupported")
    if equilibrium.get("accepted_for_linearization") is not True:
        raise ValueError(f"accepted {equilibrium_schema} is required")
    if state.get("accepted_for_frequency_operator") is not True:
        raise ValueError(f"accepted {state_schema} is required")
    eq_digest = digest_fn(dict(equilibrium))
    if equilibrium.get("content_sha256") != eq_digest or mode.get("equilibrium_artifact_sha256") != eq_digest:
        raise ValueError("mode equilibrium content binding mismatch")
    eq_id = equilibrium_id_prefix + eq_digest.removeprefix("sha256:")
    if equilibrium.get("equilibrium_id") != eq_id or state.get("source_equilibrium_id") != eq_id or state.get("source_equilibrium_artifact") != eq_digest:
        raise ValueError("linearization equilibrium identity mismatch")
    preimage = dict(state)
    preimage.pop("content_sha256", None)
    preimage.pop("linearization_state_id", None)
    state_digest = "sha256:" + hashlib.sha256(serde_json_compact_bytes(preimage)).hexdigest()
    if state.get("content_sha256") != state_digest or mode.get("linearization_state_sha256") != state_digest:
        raise ValueError("mode linearization content binding mismatch")
    if state.get("linearization_state_id") != state_id_prefix + state_digest.removeprefix("sha256:"):
        raise ValueError("linearization state ID mismatch")
    if not isinstance(mesh_signature, str) or not mesh_signature:
        raise ValueError("independently checked mesh signature is required")
    if modal_mesh_signature is None:
        modal_mesh_signature = mesh_signature
    if (
        equilibrium.get("mesh_signature") != mesh_signature
        or state.get("mesh_signature") != mesh_signature
        or mode.get("source_mesh_topology_sha256") != modal_mesh_signature
    ):
        raise ValueError("mesh signature mismatch")
    for key in ("physics_signature", "boundary_signature", "static_demag_signature"):
        if not isinstance(equilibrium.get(key), str) or not equilibrium[key] or state.get(key) != equilibrium[key]:
            raise ValueError(f"{key} mismatch")
    if schema_family == "v8":
        equilibrium_material_signature = _validate_v8_material_identity(
            equilibrium, "equilibrium_artifact"
        )
        state_material_signature = _validate_v8_material_identity(
            state, "linearization_state"
        )
        if state_material_signature != equilibrium_material_signature:
            raise ValueError("canonical material_signature mismatch")
    elif (
        not isinstance(equilibrium.get("material_signature"), str)
        or not equilibrium["material_signature"]
        or state.get("material_signature") != equilibrium["material_signature"]
    ):
        raise ValueError("material_signature mismatch")
    if type(node_count) is not int or node_count <= 0:
        raise ValueError("positive full node_count is required")
    if not isinstance(magnetic_nodes, (list, tuple)) or not magnetic_nodes or any(type(i) is not int or not 0 <= i < node_count for i in magnetic_nodes) or len(set(magnetic_nodes)) != len(magnetic_nodes):
        raise ValueError("unique full-mesh magnetic node indices are required")
    fields = [equilibrium.get("m0"), state.get("m0")]
    for field in fields:
        if not isinstance(field, list) or len(field) != node_count:
            raise ValueError("m0 does not use full mesh node order")
        for vector in field:
            if not isinstance(vector, list) or len(vector) != 3 or any(type(x) not in (int, float) or not math.isfinite(x) for x in vector):
                raise ValueError("m0 contains malformed or nonfinite vectors")
    for index in magnetic_nodes:
        left, right = fields[0][index], fields[1][index]
        if left != right:
            raise ValueError("magnetic m0 differs between equilibrium and operator")
        if abs(math.hypot(*left) - 1.0) > 1e-8:
            raise ValueError("magnetic m0 is not normalized")
    return {"equilibrium_sha256": eq_digest, "linearization_sha256": state_digest,
            "magnetic_node_indices": list(magnetic_nodes), "magnetic_m0": [fields[0][i] for i in magnetic_nodes]}
