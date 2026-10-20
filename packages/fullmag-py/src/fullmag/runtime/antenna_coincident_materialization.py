"""Prepare complete coincident loops only in a detached geometry-full execution IR."""
from __future__ import annotations

import copy
from dataclasses import dataclass

import numpy as np

from fullmag.model.current_transport import CurrentTransport
from fullmag.model.discretization import DiscretizationHints, PerObjectMeshRecipe
from fullmag.model.geometry import MicrostripAntennaLayout
from fullmag.runtime.transport_identity import tagged_json_digest


@dataclass(frozen=True, slots=True)
class PreparedCoincidentCurrentSource:
    """Generated input-only source; never a caller-authored accepted state."""
    revision: str
    object_id: str
    geometry_id: str
    mesh_digest: str
    authored_input_digest: str
    materials_digest: str
    stable_vertex_ids: tuple[int, ...]
    closure: dict[str, object]
    material_parts: tuple[dict[str, object], ...]
    terminal_observations: tuple[dict[str, object], ...]

    def to_ir(self) -> dict[str, object]:
        return copy.deepcopy({"schema_version": "conservative_current_source.v2",
            "kind": "closed_geometry_potential_jump", "revision": self.revision,
            "object_id": self.object_id, "geometry_id": self.geometry_id,
            "mesh_digest": self.mesh_digest, "authored_input_digest": self.authored_input_digest,
            "materials_digest": self.materials_digest, "stable_vertex_ids": list(self.stable_vertex_ids),
            "closure": self.closure, "material_parts": list(self.material_parts),
            "terminal_observations": list(self.terminal_observations)})


def _exact_identity_preimage(value, *, field=None):
    """Preserve u64 carrier IDs and ordinals without numeric JSON rounding."""
    if isinstance(value, dict):
        return {key: _exact_identity_preimage(item, field=key) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_exact_identity_preimage(item, field=field) for item in value]
    if field in {"stable_vertex_ids", "face_vertex_ids", "minus_face_vertex_ids", "plus_face_vertex_ids",
                 "element_ordinals", "part_cell_ordinal", "bridge_cell_ordinal"}:
        return str(value)
    return value


def _material_binding(transport, geometry, mesh, owner):
    assignments = transport.materials
    parts = (geometry.signal_part_id, geometry.return_part_id,
             geometry.inlet_connection_part_id, geometry.outlet_connection_part_id)
    if not assignments or len(assignments) > 2**32:
        raise ValueError("coincident source requires bounded owning charge.materials")
    if any(assignment.region.object_id != owner for assignment in assignments):
        raise ValueError("coincident material assignment belongs to another object")
    whole = [index for index, assignment in enumerate(assignments) if assignment.region.region_id is None]
    if whole:
        if len(assignments) != 1:
            raise ValueError("whole-object and part assignments overlap; no precedence is allowed")
        indices = {part: whole[0] for part in parts}
    else:
        indices = {}
        for index, assignment in enumerate(assignments):
            part = assignment.region.region_id
            if part not in parts or part in indices:
                raise ValueError("material assignment must bind each exact part once")
            indices[part] = index
        if set(indices) != set(parts):
            raise ValueError("coincident material assignments do not cover all four parts")
    if not np.array_equal(mesh.cell_global_ordinals, np.arange(mesh.n_elements)):
        raise ValueError("coincident source requires exact ordered cell ordinals")
    expected = (geometry.conductivity_s_per_m, geometry.conductivity_s_per_m,
                geometry.inlet_connection_conductivity_s_per_m, geometry.outlet_connection_conductivity_s_per_m)
    sigma = np.full(mesh.n_elements, np.nan)
    records = []
    for marker, (part, authored_sigma) in enumerate(zip(parts, expected), 1):
        assignment = assignments[indices[part]]
        material = assignment.material
        if any(value is not None for value in (material.sigma_parallel_Spm, material.sigma_perpendicular_Spm, material.sigma_AHE_Spm)):
            raise ValueError("coincident loop requires isotropic scalar charge conductivity")
        if not np.isfinite(material.sigma_Spm) or material.sigma_Spm <= 0.0 or material.sigma_Spm != authored_sigma:
            raise ValueError("charge.materials conductivity differs from the explicit geometry part conductivity")
        cells = np.flatnonzero(mesh.element_markers == marker)
        if len(cells) == 0:
            raise ValueError("coincident mesh lost a material part")
        sigma[cells] = material.sigma_Spm
        records.append({"part_id": part, "element_ordinals": cells.tolist(), "material_assignment_index": indices[part]})
    if not np.isfinite(sigma).all() or np.any(sigma <= 0.0):
        raise ValueError("coincident material coverage must contain every cell exactly once")
    records.sort(key=lambda item: item["part_id"])
    digest = tagged_json_digest({"schema": "antenna_coincident_material_binding.v2",
        "assignments": [assignment.to_ir() for assignment in assignments],
        "material_parts": _exact_identity_preimage(records), "resolved_conductivity_spm_per_element": sigma.tolist()})
    return records, digest


def materialize_antenna_coincident_loops(problem, ir, *, geometries, discretization, mesh_workflow,
                                        runtime_device_override=None):
    transports = [module for module in problem.current_modules if isinstance(module, CurrentTransport)
                  and module.structured_current_closure is not None
                  and module.structured_current_closure.schema_version == "structured_current_closure.v2"]
    if not transports:
        return
    selection = ir["problem_meta"]["runtime_metadata"]["runtime_selection"]
    if (ir["backend_policy"]["requested_backend"] != "fem"
            or ir["backend_policy"]["execution_precision"] != "double"
            or ir["validation_profile"]["execution_mode"] != "strict"
            or (runtime_device_override or selection.get("device")) not in {"cpu", "auto"}
            or discretization is None or discretization.fem is None or discretization.fem.order != 1):
        raise ValueError("coincident preparation requires explicit FEM P1 strict/double CPU or auto; no fallback")
    geometry_ids = problem._geometry_object_ids()
    geometry_by_owner = {}
    for geometry in geometries:
        owner = geometry_ids.get(geometry.geometry_name)
        if owner is not None:
            if owner in geometry_by_owner:
                raise ValueError("coincident geometry owner is ambiguous")
            geometry_by_owner[owner] = geometry
    from fullmag.model.problem import BackendTarget, build_geometry_assets_for_request
    from fullmag.meshing._antenna_coincident_cut import prepare_antenna_coincident_loop, coincident_terminal_observations
    assets = dict(ir.get("geometry_assets") or {"fdm_grid_assets": [], "fem_mesh_assets": []})
    object_assets = list(assets["fem_mesh_assets"])
    replacements, receipts = {}, []
    seen_owners = set()
    for transport in transports:
        owners = {region.object_id for region in transport.domain}
        if len(owners) != 1 or any(region.region_id is not None for region in transport.domain):
            raise ValueError("coincident preparation requires one complete original conductor object")
        owner = next(iter(owners))
        if owner in seen_owners:
            raise ValueError("one geometry cannot bind multiple coincident source preparations")
        seen_owners.add(owner)
        geometry = geometry_by_owner.get(owner)
        if not isinstance(geometry, MicrostripAntennaLayout) or not geometry.closed_loop:
            raise ValueError("coincident source must bind an explicit closed microstrip geometry")
        ports = [port for port in problem.antenna_port_modes
                 if port.source_object_id == owner and port.current_transport_id == transport.name]
        if len(ports) != 1:
            raise ValueError("coincident source requires one authored port with terminal observation references")
        closure = transport.structured_current_closure
        if (ports[0].schema_version != "antenna_port_mode.v3" or ports[0].normalization is None
                or ports[0].normalization.source_cut_ref != closure.source_cuts[0].source_cut_id):
            raise ValueError("coincident source requires explicit port v3 normalization bound to its sourcecut")
        independent_workflow = {key: value for key, value in (mesh_workflow or {}).items()
            if key not in {"domain_mesh_source", "domain_region_markers", "domain_object_region_markers"}}
        raw_meshes = {}
        recipes = {magnet.geometry.geometry_name: magnet.mesh for magnet in problem.magnets
                   if magnet.geometry.geometry_name == geometry.geometry_name and isinstance(magnet.mesh, PerObjectMeshRecipe)}
        build_geometry_assets_for_request(requested_backend=BackendTarget.FEM, geometries=[geometry],
            discretization=DiscretizationHints(fem=discretization.fem), mesh_workflow=independent_workflow,
            per_object_recipes=recipes,
            geometry_object_ids=geometry_ids, _realized_object_mesh_sink=raw_meshes,
            _coincident_closures={geometry.geometry_name: closure})
        raw = raw_meshes[geometry.geometry_name]
        prepared = prepare_antenna_coincident_loop(closure, geometry=geometry, object_id=owner,
                                                  hmax_m=discretization.fem.hmax, raw_mesh=raw)
        material_parts, materials_digest = _material_binding(transport, geometry, prepared.mesh, owner)
        observations = coincident_terminal_observations(raw, prepared, geometry=geometry, object_id=owner, port=ports[0])
        mesh_digest = prepared.mesh.topology_fingerprint_v3()
        full_closure = prepared.closure.to_ir()
        closure_body = {key: value for key, value in full_closure.items() if key not in {"revision", "digest"}}
        intent = {"schema": "antenna_coincident_prepared_input.v2", "object_id": owner,
            "geometry": geometry.to_ir(), "authored_closure": closure.to_ir(), "mesh_digest": mesh_digest,
            "stable_vertex_ids": _exact_identity_preimage(list(prepared.stable_vertex_ids), field="stable_vertex_ids"),
            "closure": _exact_identity_preimage(closure_body), "materials_digest": materials_digest,
            "material_parts": _exact_identity_preimage(material_parts),
            "terminal_observations": _exact_identity_preimage(observations), "port": ports[0].to_ir(),
            "gauge": transport.gauge.to_ir(), "solver": transport.solver.to_ir(),
            "requested_execution": selection, "backend_policy": ir["backend_policy"],
            "validation_profile": ir["validation_profile"], "mesh_workflow": independent_workflow,
            "per_object_recipes": {name: recipe.to_ir() for name, recipe in recipes.items()}}
        digest = tagged_json_digest(intent)
        full_closure.update(revision=digest, digest=digest)
        source = PreparedCoincidentCurrentSource(digest, owner, geometry.geometry_name, mesh_digest,
            digest, materials_digest, prepared.stable_vertex_ids, full_closure, tuple(material_parts), tuple(observations))
        payload = transport.to_ir()
        del payload["structured_current_closure"]
        payload["conservative_current_source"] = source.to_ir()
        payload["boundaries"] = []
        replacements[transport.name] = payload
        object_assets = [asset for asset in object_assets if asset["geometry_name"] != geometry.geometry_name]
        object_assets.append({"geometry_name": geometry.geometry_name, "mesh_source": None,
                             "mesh": prepared.mesh.to_ir(geometry.geometry_name)})
        receipt = dict(prepared.receipt, input_digest=digest, mesh_revision=mesh_digest,
            geometry_digest=tagged_json_digest(geometry.to_ir()), materials_digest=materials_digest,
            source_cut_digest=tagged_json_digest(_exact_identity_preimage(closure_body)),
            authored_intent=closure.to_ir(), terminal_observation_count=len(observations),
            prepared_mesh_workflow=copy.deepcopy(independent_workflow),
            prepared_per_object_recipes={name: recipe.to_ir() for name, recipe in recipes.items()})
        receipts.append({"current_transport_id": transport.name, "object_id": owner,
                         "geometry_id": geometry.geometry_name, "preparation": receipt})
    assets["fem_mesh_assets"] = object_assets
    ir["geometry_assets"] = assets
    ir["current_modules"] = [replacements.get(module.get("name"), module) for module in ir["current_modules"]]
    graph = dict(ir["physics_graph"])
    graph["modules"] = [dict(module, family_payload=copy.deepcopy(replacements[module["id"]]))
        if module["kind"] == "current_transport" and module["id"] in replacements else module
        for module in graph["modules"]]
    ir["physics_graph"] = graph
    ir["problem_meta"]["runtime_metadata"]["antenna_coincident_preparations"] = receipts
