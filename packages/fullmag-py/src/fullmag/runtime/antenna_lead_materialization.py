"""Prepare authored antenna leads only in a detached, geometry-full execution IR."""
from __future__ import annotations

import copy

from fullmag.model.current_transport import CurrentTransport, _source_thaw
from fullmag.model.discretization import DiscretizationHints, PerObjectMeshRecipe


def materialize_antenna_lead_preparations(
    problem, ir: dict[str, object], *, geometries, discretization, mesh_workflow,
    runtime_device_override: str | None = None,
) -> None:
    """Bind each intent to the exact independent device mesh, never a shared domain.

    The caller owns a newly lowered IR. No authored Python object, previous IR,
    or cached asset container is modified. This prepares inputs, not a field.
    """
    transports = [module for module in problem.current_modules
                  if isinstance(module, CurrentTransport) and module.external_lead_preparation is not None]
    if not transports:
        return
    selection = ir["problem_meta"]["runtime_metadata"]["runtime_selection"]
    if (ir["backend_policy"]["requested_backend"] != "fem"
            or ir["backend_policy"]["execution_precision"] != "double"
            or ir["validation_profile"]["execution_mode"] != "strict"
            or (runtime_device_override or selection.get("device")) not in {"cpu", "auto"}
            or discretization is None or discretization.fem is None
            or discretization.fem.order != 1):
        raise ValueError("antenna lead preparation requires explicit FEM P1 strict/double CPU or auto; no device fallback")

    geometry_ids = problem._geometry_object_ids()
    geometry_by_owner = {}
    for geometry in geometries:
        owner = geometry_ids.get(geometry.geometry_name)
        if owner is not None:
            if owner in geometry_by_owner:
                raise ValueError(f"antenna lead preparation has ambiguous geometry owner {owner!r}")
            geometry_by_owner[owner] = geometry
    requests = []
    for transport in transports:
        owners = {region.object_id for region in transport.domain}
        if len(owners) != 1 or any(region.region_id is not None for region in transport.domain):
            raise ValueError("antenna lead preparation requires one complete original device object, not subregions or a merged mesh")
        owner = next(iter(owners))
        if owner not in geometry_by_owner:
            raise ValueError(f"antenna lead preparation cannot bind immutable object_id {owner!r} to its geometry")
        if any(extension.object_id != owner for extension in transport.external_lead_preparation.extensions):
            raise ValueError("antenna lead preparation extension owner differs from the original device object")
        requests.append((transport, owner, geometry_by_owner[owner]))

    from fullmag.model.problem import BackendTarget, build_geometry_assets_for_request

    independent_geometries = {geometry.geometry_name: geometry for _, _, geometry in requests}
    meshes = {}
    # Domain-source metadata is intentionally not a per-object mesh source.
    independent_workflow = {key: value for key, value in (mesh_workflow or {}).items()
                            if key not in {"domain_mesh_source", "domain_region_markers", "domain_object_region_markers"}}
    independent_assets = build_geometry_assets_for_request(
        requested_backend=BackendTarget.FEM,
        geometries=list(independent_geometries.values()),
        discretization=DiscretizationHints(fem=discretization.fem),
        mesh_workflow=independent_workflow,
        per_object_recipes={magnet.geometry.geometry_name: magnet.mesh for magnet in problem.magnets
                            if magnet.geometry.geometry_name in independent_geometries and isinstance(magnet.mesh, PerObjectMeshRecipe)},
        geometry_object_ids=geometry_ids,
        # Serialized in-memory cache entries have no raw ordered vertex owner.
        # The existing per-object disk NPZ cache retains the actual MeshData.
        _realized_object_mesh_sink=meshes,
    )
    assets = dict(ir.get("geometry_assets") or {"fdm_grid_assets": [], "fem_mesh_assets": []})
    object_assets = list(assets["fem_mesh_assets"])
    for asset in independent_assets["fem_mesh_assets"]:
        object_assets = [existing for existing in object_assets if existing["geometry_name"] != asset["geometry_name"]]
        object_assets.append(asset)
    assets["fem_mesh_assets"] = object_assets

    replacements, receipts = {}, []
    for transport, owner, geometry in requests:
        intent = transport.external_lead_preparation
        prepared = intent.prepare(device_mesh=meshes[geometry.geometry_name])
        payload = transport.to_ir()
        del payload["external_lead_preparation"]
        payload["conservative_current_source"] = prepared.source.to_ir()
        replacements[transport.name] = payload
        receipt_keys = ("schema_version", "policy", "issuer", "status", "field_scope", "capabilities",
                        "revision", "input_mesh_sha256", "lead_node_count", "lead_cell_count")
        receipt = {key: _source_thaw(prepared.receipt[key]) for key in receipt_keys}
        receipt.update(device_node_count=meshes[geometry.geometry_name].n_nodes,
                       device_cell_count=meshes[geometry.geometry_name].n_elements)
        receipts.append({"current_transport_id": transport.name, "object_id": owner,
                         "geometry_id": geometry.geometry_name, "authored_intent": intent.to_ir(),
                         "preparation": receipt})
    ir["current_modules"] = [replacements.get(module.get("name"), module) for module in ir["current_modules"]]
    graph = dict(ir["physics_graph"])
    graph["modules"] = [dict(module, family_payload=copy.deepcopy(replacements[module["id"]]))
                        if module["kind"] == "current_transport" and module["id"] in replacements else module
                        for module in graph["modules"]]
    ir["physics_graph"] = graph
    ir["geometry_assets"] = assets
    ir["problem_meta"]["runtime_metadata"]["antenna_lead_preparations"] = receipts
