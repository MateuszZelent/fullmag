"""Readonly input-only preparation handoff; never authenticates a retained current."""
from __future__ import annotations

import copy
import hashlib
import json
import math
from types import SimpleNamespace
from pathlib import Path

from fullmag.model.antenna import AntennaRetainedCurrentSource

MAX_ASSET_BYTES = 8 * 1024 * 1024
SCHEMA = "antenna_source_preparation_asset.v1"


def _closed(value, fields, label, optional=()):
    if not isinstance(value, dict) or set(value) - set(fields) - set(optional) or set(fields) - set(value):
        raise ValueError(f"source preparation {label} has missing or unknown fields")
    return value


def _digest(value, *, prefixed=False):
    if prefixed:
        value = value[7:] if isinstance(value, str) and value.startswith("sha256:") else None
    if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError("source preparation contains an invalid SHA256 pin")


def _identifier(value):
    if not isinstance(value, str) or not value or len(value) > 4096 or value != value.strip() or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
        raise ValueError("source preparation contains an invalid identifier")


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("source preparation contains a duplicate JSON field")
        result[key] = value
    return result


def _finite(value):
    if isinstance(value, dict):
        for item in value.values():
            _finite(item)
    elif isinstance(value, list):
        for item in value:
            _finite(item)
    elif isinstance(value, float) and not math.isfinite(value):
        raise ValueError("source preparation requires finite numbers")


def decode_source_preparation(payload: bytes) -> dict:
    if not payload or len(payload) > MAX_ASSET_BYTES:
        raise ValueError("source preparation exceeds its input byte budget")
    value = json.loads(payload, object_pairs_hook=_pairs,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError("source preparation requires finite numbers")))
    _finite(value)
    _closed(value, ("schema_version", "parent_owner", "source_pins", "source_mesh", "source_object_segments",
                    "prepared_source", "authored_input_preimage", "source_preparation"), "document")
    if value["schema_version"] != SCHEMA:
        raise ValueError("unsupported source preparation schema")
    owner = _closed(value["parent_owner"], ("project_id", "run_id", "study_step_id", "native_stage_id", "task_id",
        "attempt_id", "ownership_epoch", "artifact_id", "package", "package_codec_id", "package_codec_version",
        "manifest_schema", "output_manifest_artifact_id", "output_manifest"), "parent owner")
    for key in ("project_id", "run_id", "study_step_id", "native_stage_id", "task_id", "attempt_id", "artifact_id", "output_manifest_artifact_id"):
        _identifier(owner[key])
    for key in ("package", "output_manifest"):
        ref = _closed(owner[key], ("object_ref", "byte_count"), "CAS reference")
        _digest(ref["object_ref"])
        if type(ref["byte_count"]) is not int or not 0 < ref["byte_count"] <= 512 * 1024 * 1024:
            raise ValueError("source preparation CAS reference has invalid byte count")
    AntennaRetainedCurrentSource(**{key: owner[key] for key in ("project_id", "run_id", "task_id", "attempt_id", "ownership_epoch", "artifact_id")}, object_ref=owner["package"]["object_ref"])
    if (owner["package_codec_id"], owner["package_codec_version"], owner["manifest_schema"]) != ("fullmag.antenna.closed_loop_bundle", "v1", "antenna_field_solution.v2"):
        raise ValueError("source preparation requires an original closed-loop v2 parent")
    pins = _closed(value["source_pins"], ("prepared_execution_digest", "accepted_charge_field_digest", "accepted_source_state_digest", "view_identity_digest", "current_balance_certificate_digest"), "source pins")
    for digest in pins.values():
        _digest(digest, prefixed=True)
    receipt = _closed(value["source_preparation"], ("receipt_schema_version", "run_id", "task_id", "step_id", "input_fingerprint", "preparation_id", "plan_fingerprint", "payload_sha256", "receipt_sha256"), "receipt pins")
    if receipt["receipt_schema_version"] != "task_preparation_receipt.v1":
        raise ValueError("source preparation receipt schema is unsupported")
    for key in ("run_id", "task_id", "step_id", "preparation_id"):
        _identifier(receipt[key])
    for key in ("input_fingerprint", "payload_sha256", "receipt_sha256"):
        _digest(receipt[key])
    _digest(receipt["plan_fingerprint"], prefixed=True)
    if (receipt["run_id"] != owner["run_id"] or receipt["task_id"] != owner["task_id"]
            or receipt["step_id"] != owner["study_step_id"] or receipt["preparation_id"] != "prep-" + owner["task_id"]):
        raise ValueError("source preparation receipt belongs to another owner")
    prepared = _closed(value["prepared_source"], ("schema_version", "revision", "object_id", "geometry_id", "mesh_digest", "authored_input_digest", "materials_digest", "stable_vertex_ids", "closure", "material_parts", "terminal_observations"), "prepared source")
    if prepared["schema_version"] != "conservative_current_source.v2":
        raise ValueError("source preparation requires prepared source v2")
    for key in ("object_id", "geometry_id"):
        _identifier(prepared[key])
    for key in ("revision", "mesh_digest", "authored_input_digest", "materials_digest"):
        _digest(prepared[key], prefixed=True)
    if prepared["revision"] != prepared["authored_input_digest"]:
        raise ValueError("source preparation revision differs from authored input")
    mesh = _closed(value["source_mesh"], ("mesh_name", "nodes", "cells", "element_markers", "facets", "boundary_markers"), "mesh", ("periodic_boundary_pairs", "periodic_node_pairs", "per_domain_quality"))
    _identifier(mesh["mesh_name"])
    nodes = mesh["nodes"]
    if not isinstance(nodes, list) or len(nodes) < 4 or any(not isinstance(node, list) or len(node) != 3 or any(type(c) not in (float, int) for c in node) for node in nodes):
        raise ValueError("source preparation mesh has incomplete coordinates")
    ids = prepared["stable_vertex_ids"]
    if not isinstance(ids, list) or len(ids) != len(nodes) or any(type(i) is not int or not 0 < i <= 2**64 - 1 for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("source preparation stable vertex IDs are incomplete")
    for key, family, width, markers in (("cells", "tet4", 4, "element_markers"), ("facets", "tri3", 3, "boundary_markers")):
        block = _closed(mesh[key], ("types", "offsets", "nodes", "global_ordinals"), key, ("roles",) if key == "facets" else ("mesh_parts",))
        count = len(block["types"])
        if not count or block["types"] != [family] * count or block["offsets"] != list(range(0, width * (count + 1), width)) or len(block["nodes"]) != count * width or block["global_ordinals"] != list(range(count)) or len(mesh[markers]) != count:
            raise ValueError("source preparation mesh has incomplete Tet4/Tri3 connectivity")
        if any(type(i) is not int or not 0 <= i < len(nodes) for i in block["nodes"]) or any(type(i) is not int or i <= 0 for i in mesh[markers]):
            raise ValueError("source preparation mesh contains invalid index or marker")
    if mesh.get("periodic_boundary_pairs") or mesh.get("periodic_node_pairs"):
        raise ValueError("source preparation must be nonperiodic")
    segments = value["source_object_segments"]
    if not isinstance(segments, list) or not segments:
        raise ValueError("source preparation object segments are missing")
    for segment in segments:
        _closed(segment, ("object_id", "node_start", "node_count", "element_start", "element_count", "boundary_face_start", "boundary_face_count"), "object segment", ("geometry_id",))
        if segment["object_id"] != prepared["object_id"] or segment.get("geometry_id", prepared["geometry_id"]) != prepared["geometry_id"]:
            raise ValueError("source preparation mesh belongs to another object")
        for key in ("node_start", "node_count", "element_start", "element_count", "boundary_face_start", "boundary_face_count"):
            if type(segment[key]) is not int or not 0 <= segment[key] <= 2**32 - 1:
                raise ValueError("source preparation segment range is invalid")
    closure = _closed(prepared["closure"], ("kind", "operator_version", "revision", "digest", "source_cuts"), "prepared closure")
    if closure["kind"] != "closed_geometry" or closure["operator_version"] != "fem_closed_current_geometry.v2" or not isinstance(closure["source_cuts"], list) or len(closure["source_cuts"]) != 1:
        raise ValueError("source preparation requires one coincident v2 source cut")
    for cut in closure["source_cuts"]:
        _closed(cut, ("id", "translation_m", "potential_drop_v", "face_pairs"), "prepared cut")
        if cut["translation_m"] != [0.0, 0.0, 0.0] or not cut["face_pairs"]:
            raise ValueError("source preparation requires complete coincident cut faces")
        for pair in cut["face_pairs"]:
            _closed(pair, ("minus_face_vertex_ids", "plus_face_vertex_ids"), "prepared face pair")
            for face in pair.values():
                if not isinstance(face, list) or len(face) != 3 or len(set(face)) != 3 or any(i not in ids for i in face):
                    raise ValueError("source preparation cut face has invalid stable IDs")
    if not isinstance(prepared["material_parts"], list) or not prepared["material_parts"]:
        raise ValueError("source preparation material parts are missing")
    for part in prepared["material_parts"]:
        _closed(part, ("part_id", "element_ordinals", "material_assignment_index"), "material part")
    if not isinstance(prepared["terminal_observations"], list) or not prepared["terminal_observations"]:
        raise ValueError("source preparation terminal observations are missing")
    for observation in prepared["terminal_observations"]:
        _closed(observation, ("id", "part_id", "selector", "faces", "normal_convention"), "terminal observation")
        if not observation["faces"]:
            raise ValueError("source preparation observation faces are missing")
        for face in observation["faces"]:
            _closed(face, ("face_vertex_ids", "part_cell_ordinal", "bridge_cell_ordinal"), "observation face")
    preimage = _closed(value["authored_input_preimage"], ("schema", "object_id", "geometry", "authored_closure", "mesh_digest", "stable_vertex_ids", "closure", "materials_digest", "material_parts", "terminal_observations", "port", "gauge", "solver", "requested_execution", "backend_policy", "validation_profile", "mesh_workflow", "per_object_recipes"), "historical preimage")
    if preimage["schema"] != "antenna_coincident_prepared_input.v2" or preimage["object_id"] != prepared["object_id"]:
        raise ValueError("source preparation historical preimage is invalid")
    return value


def resolve_source_preparations(problem, *, source_root, mesh_workflow, runtime, discretization):
    """Decode explicit inputs before any geometry cache or mesher can run."""
    resolved = {}
    for stage in problem.antenna_field_solve_stages:
        asset = stage.retained_source_preparation
        if asset is None:
            continue
        from fullmag.model.study import AntennaFieldSolve, FieldOnly
        if not isinstance(problem.study, (FieldOnly, AntennaFieldSolve)):
            raise ValueError("source preparation is supported only by H-only, not Relax/Run")
        if (runtime.backend_target.value != "fem" or runtime.device_target.value != "cpu"
                or runtime.execution_precision.value != "double" or runtime.execution_mode.value != "strict"
                or discretization is None or discretization.fem is None or discretization.fem.order != 1):
            raise ValueError("source preparation requires explicit FEM CPU P1 strict/double")
        path = asset.resolved_source(source_root)
        with path.open("rb") as handle:
            payload = handle.read(MAX_ASSET_BYTES + 1)
        if hashlib.sha256(payload).hexdigest() != asset.content_sha256:
            raise ValueError("source preparation asset bytes differ from content_sha256")
        document = decode_source_preparation(payload)
        owner = document["parent_owner"]
        locator = stage.retained_current_source.to_ir()
        if any(locator[key] != owner[key] for key in ("project_id", "run_id", "task_id", "attempt_id", "ownership_epoch", "artifact_id")) or locator["object_ref"] != owner["package"]["object_ref"]:
            raise ValueError("source preparation belongs to another retained parent")
        prepared = document["prepared_source"]
        if stage.source_object_id != prepared["object_id"] or prepared["geometry_id"] in resolved:
            raise ValueError("source preparation owner is different or ambiguous")
        # Only an explicitly local policy can change the frozen source. Domain
        # and inherited policies describe the independent target mesh.
        entries = (mesh_workflow or {}).get("per_geometry") or []
        historical = document["authored_input_preimage"]["mesh_workflow"].get("per_geometry") or []
        for entry in entries:
            if entry.get("geometry") == prepared["geometry_id"] and entry.get("mode") == "custom":
                if entry not in historical:
                    raise ValueError("explicit source mesh policy differs from frozen preparation")
        from fullmag.model.discretization import PerObjectMeshRecipe
        local = {magnet.geometry.geometry_name: magnet.mesh.to_ir() for magnet in problem.magnets
                 if magnet.geometry.geometry_name == prepared["geometry_id"] and isinstance(magnet.mesh, PerObjectMeshRecipe)}
        if local != document["authored_input_preimage"]["per_object_recipes"]:
            raise ValueError("explicit source per-object recipe differs from frozen preparation")
        resolved[prepared["geometry_id"]] = {"document": document, "reference": asset.to_ir(source_root=source_root), "stage": stage}
    if not resolved:
        return resolved
    # Check user declarations before any target geometry work as well.
    replacements = _source_preparation_replacements(problem, resolved)
    for item in resolved.values():
        item["current_payload"] = replacements[item["stage"].current_transport_id]
    return resolved


def _source_preparation_replacements(problem, resolved):
    """Validate current declarations without modifying historical metadata."""
    replacements = {}
    geometries = {geometry.geometry_name: geometry for geometry in problem._collect_geometries()}
    for geometry_id, item in resolved.items():
        document, stage = item["document"], item["stage"]
        modules = [module for module in problem.current_modules if module.name == stage.current_transport_id]
        if len(modules) != 1:
            raise ValueError("retained source requires one current module")
        transport = modules[0]
        closure = transport.structured_current_closure
        if closure is None or closure.schema_version != "structured_current_closure.v2":
            raise ValueError("retained source asset requires an authored v2 closure")
        preimage = document["authored_input_preimage"]
        ports = [port for port in problem.antenna_port_modes if port.id in stage.port_mode_ids]
        if (geometry_id not in geometries or geometries[geometry_id].to_ir() != preimage["geometry"]
                or closure.to_ir() != preimage["authored_closure"] or len(ports) != 1 or ports[0].to_ir() != preimage["port"]
                or transport.gauge.to_ir() != preimage["gauge"] or transport.solver.to_ir() != preimage["solver"]):
            raise ValueError("retained source authored geometry/closure/port/gauge/solver differs")
        import numpy as np
        from fullmag.runtime.antenna_coincident_materialization import _material_binding
        mesh = document["source_mesh"]
        carrier = SimpleNamespace(cell_global_ordinals=np.asarray(mesh["cells"]["global_ordinals"]),
            n_elements=len(mesh["cells"]["types"]), element_markers=np.asarray(mesh["element_markers"]))
        parts, digest = _material_binding(transport, geometries[geometry_id], carrier, stage.source_object_id)
        if parts != document["prepared_source"]["material_parts"] or digest != document["prepared_source"]["materials_digest"]:
            raise ValueError("retained source material assignments or conductivity differ")
        payload = transport.to_ir()
        del payload["structured_current_closure"]
        payload["conservative_current_source"] = {
            "kind": "retained_preparation_asset", "schema_version": "retained_preparation_asset_source.v1",
            "object_id": stage.source_object_id, "geometry_id": geometry_id,
            "preparation_asset": copy.deepcopy(item["reference"]),
            "historical_prepared_source": copy.deepcopy(document["prepared_source"]),
            "historical_preparation": copy.deepcopy(document["source_preparation"]),
            "authored_closure": closure.to_ir(),
        }
        replacements[transport.name] = payload
    return replacements


def materialize_source_preparations(problem, ir, resolved):
    """Publish the prevalidated input projection, without a second mesh or solve."""
    replacements = {item["stage"].current_transport_id: item["current_payload"] for item in resolved.values()}
    ir["current_modules"] = [replacements.get(module.get("name"), module) for module in ir["current_modules"]]
    graph = dict(ir["physics_graph"])
    graph["modules"] = [dict(module, family_payload=copy.deepcopy(replacements[module["id"]]))
        if module["kind"] == "current_transport" and module["id"] in replacements else module
        for module in graph["modules"]]
    ir["physics_graph"] = graph
