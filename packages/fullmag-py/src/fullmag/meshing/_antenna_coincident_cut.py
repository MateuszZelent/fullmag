"""Mesh-exact, full-volume microstrip loop inputs; never a solved-field certificate."""
from __future__ import annotations

from collections import Counter, defaultdict, deque
from dataclasses import dataclass, replace
import hashlib
import json

import numpy as np

from fullmag.model.current_transport import ConservativeCurrentClosedGeometry, ConservativeCurrentSourceCut, ConservativeCurrentSourceCutFacePair
from fullmag.model.geometry import MicrostripAntennaLayout
from ._gmsh_types import MeshData, MeshOptions

_TET_FACES = ((1, 2, 3), (0, 3, 2), (0, 1, 3), (0, 2, 1))
_MAX_CELLS = 1 << 20


@dataclass(frozen=True, slots=True)
class PreparedAntennaCoincidentLoop:
    mesh: MeshData
    stable_vertex_ids: tuple[int, ...]
    closure: ConservativeCurrentClosedGeometry
    conductivity_s_per_m_per_element: tuple[float, ...]
    receipt: dict[str, object]


def _faces(cells):
    faces = defaultdict(list)
    for cell_index, cell in enumerate(cells):
        for local in _TET_FACES:
            face = tuple(int(cell[i]) for i in local)
            faces[tuple(sorted(face))].append((cell_index, face))
    if any(len(owners) > 2 for owners in faces.values()):
        raise ValueError("nonmanifold tet4 mesh")
    adjacency = [[] for _ in cells]
    for owners in faces.values():
        if len(owners) == 2:
            a, b = owners[0][0], owners[1][0]
            adjacency[a].append(b)
            adjacency[b].append(a)
    seen = {0}
    queue = deque([0])
    while queue:
        for neighbour in adjacency[queue.popleft()]:
            if neighbour not in seen:
                seen.add(neighbour)
                queue.append(neighbour)
    if len(seen) != len(cells):
        raise ValueError("loop must be one face-connected conductor volume")
    return faces


def split_coincident_sourcecut(mesh, *, seam_faces, stable_vertex_ids, normal_world, source_cut_id, potential_jump_v):
    """Duplicate only topological cut vertices, keeping every Tet4 and xyz bit."""
    if not isinstance(mesh, MeshData) or not 0 < mesh.n_elements <= _MAX_CELLS:
        raise ValueError("bounded MeshData tet4 source required")
    if set(mesh.cell_types) != {"tet4"} or mesh.periodic_node_pairs or mesh.periodic_boundary_pairs:
        raise ValueError("coincident loop requires nonperiodic P1 Tet4")
    nodes = np.asarray(mesh.nodes, dtype=np.float64)
    if not np.isfinite(nodes).all():
        raise ValueError("loop nodes must be finite")
    cells = np.array(mesh.elements, copy=True)
    edges = nodes[cells[:, 1:]] - nodes[cells[:, :1]]
    lengths = np.max(np.linalg.norm(nodes[cells[:, :, None]] - nodes[cells[:, None, :]], axis=-1), axis=(1, 2))
    determinants = np.linalg.det(edges / lengths[:, None, None])
    if not np.isfinite(determinants).all() or np.any(determinants <= 1e-12):
        raise ValueError("loop Tet4 must have positive scale-normalized determinant > 1e-12")
    if any(isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, np.integer)) for value in stable_vertex_ids):
        raise ValueError("stable vertex IDs must be exact integers")
    ids = tuple(int(value) for value in stable_vertex_ids)
    if len(ids) != len(nodes) or len(set(ids)) != len(ids) or any(value <= 0 for value in ids):
        raise ValueError("exact unique stable vertex IDs required")
    seam = [tuple(sorted(int(v) for v in face)) for face in seam_faces]
    if not seam or len(set(seam)) != len(seam) or any(len(face) != 3 or len(set(face)) != 3 for face in seam):
        raise ValueError("nonempty unique triangular seam required")
    edge_owners = defaultdict(list)
    for index, face in enumerate(seam):
        for a, b in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])):
            edge_owners[tuple(sorted((a, b)))].append(index)
    rim = [edge for edge, owners in edge_owners.items() if len(owners) == 1]
    vertices = {v for face in seam for v in face}
    if any(len(owners) > 2 for owners in edge_owners.values()) or len(vertices) - len(edge_owners) + len(seam) != 1:
        raise ValueError("sourcecut must be a manifold triangulated disk")
    rim_degree = Counter(v for edge in rim for v in edge)
    if not rim or any(degree != 2 for degree in rim_degree.values()):
        raise ValueError("sourcecut must have one closed boundary rim")
    reachable = {0}
    while True:
        expanded = reachable | {i for owners in edge_owners.values() if any(i in reachable for i in owners) for i in owners}
        if expanded == reachable:
            break
        reachable = expanded
    if len(reachable) != len(seam):
        raise ValueError("sourcecut must be one connected disk")
    topology = _faces(cells)
    normal = np.asarray(normal_world, dtype=np.float64)
    if normal.shape != (3,) or not np.isfinite(normal).all() or np.linalg.norm(normal) == 0:
        raise ValueError("finite nonzero source normal required")
    normal /= np.linalg.norm(normal)
    seam_vertices = sorted({v for face in seam for v in face})
    duplicate = {v: len(nodes) + i for i, v in enumerate(seam_vertices)}
    if max(ids) + len(duplicate) > (1 << 64) - 1:
        raise ValueError("stable vertex ID overflow")
    plus_cells = set()
    for key in seam:
        owners = topology.get(key)
        if owners is None or len(owners) != 2:
            raise ValueError("sourcecut must be an actual conforming internal face")
        for cell_index, face in owners:
            xyz = nodes[list(face)]
            face_normal = np.cross(xyz[1] - xyz[0], xyz[2] - xyz[0])
            face_normal /= np.linalg.norm(face_normal)
            alignment = float(np.dot(face_normal, normal))
            if np.linalg.norm(face_normal - np.copysign(1.0, alignment) * normal) > 1e-10:
                raise ValueError("sourcecut face is not on the authored oriented plane")
            if alignment < 0:
                plus_cells.add(cell_index)
    # Propagate around seam vertices on the plus side, including edge/corner cells.
    origin = nodes[seam[0][0]]
    for index, cell in enumerate(cells):
        if any(int(v) in duplicate for v in cell) and float(np.dot(nodes[cell].mean(axis=0) - origin, normal)) > 0:
            plus_cells.add(index)
    result_nodes = np.concatenate((nodes.copy(), nodes[seam_vertices].copy()))
    for index in plus_cells:
        cells[index] = [duplicate.get(int(v), int(v)) for v in cells[index]]
    new_ids = ids + tuple(max(ids) + 1 + i for i in range(len(duplicate)))
    pairs = []
    for face in seam:
        minus = sorted(ids[v] for v in face)
        plus = sorted(new_ids[duplicate[v]] for v in face)
        pairs.append(ConservativeCurrentSourceCutFacePair(minus, plus))
    pairs.sort(key=lambda pair: (tuple(pair.minus_face_vertex_ids), tuple(pair.plus_face_vertex_ids)))
    final = _faces(cells)
    source_keys = set(seam) | {tuple(sorted(duplicate[v] for v in face)) for face in seam}
    boundary, markers = [], []
    for key, owners in final.items():
        if len(owners) == 1:
            boundary.append(owners[0][1])
            markers.append(2 if key in source_keys else 1)
    original_exterior = sum(len(owners) == 1 for owners in topology.values())
    if len(boundary) != original_exterior + 2 * len(seam):
        raise ValueError("sourcecut is incomplete or created an unauthored internal crack")
    if sum(marker == 2 for marker in markers) != 2 * len(seam):
        raise ValueError("topological split created an incomplete sourcecut")
    if result_nodes[cells].tobytes() != nodes[mesh.elements].tobytes():
        raise ValueError("sourcecut changed a source cell coordinate or volume")
    result = MeshData.from_legacy_tet4(nodes=result_nodes, elements=cells,
        element_markers=np.array(mesh.element_markers, copy=True), boundary_faces=np.asarray(boundary),
        boundary_markers=np.asarray(markers), vertex_identity=None)
    cut = ConservativeCurrentSourceCut(source_cut_id, (0.0, 0.0, 0.0), potential_jump_v, pairs,
                                      closure_operator_version="fem_closed_current_geometry.v2")
    return result, new_ids, cut


def _validate_loop_request(closure, geometry, object_id, hmax_m):
    if closure.schema_version != "structured_current_closure.v2" or not isinstance(geometry, MicrostripAntennaLayout) or not geometry.closed_loop:
        raise ValueError("explicit structured closure v2 and closed microstrip geometry required")
    if not np.isfinite(hmax_m) or hmax_m <= 0:
        raise ValueError("hmax_m must be finite positive")
    cut = closure.source_cuts[0]
    if cut.region.region_id != geometry.inlet_connection_part_id:
        raise ValueError("sourcecut region must resolve the inlet connection part")
    if not isinstance(object_id, str) or not object_id.strip() or cut.region.object_id != object_id:
        raise ValueError("sourcecut must bind the explicit immutable geometry object_id")
    offset = cut.plane.offset_m
    if not -geometry.thickness_m / 2 - geometry.return_offset_m < offset < -geometry.thickness_m / 2:
        raise ValueError("sourcecut lies outside inlet dielectric clearance")
    return cut


def realize_antenna_coincident_loop_mesh(closure, *, geometry, object_id, hmax_m, mesh_options=None):
    cut = _validate_loop_request(closure, geometry, object_id, hmax_m)
    offset = cut.plane.offset_m
    from ._gmsh_infra import _import_gmsh, _configure_gmsh_threads
    from ._gmsh_fields import _apply_mesh_options, _apply_post_mesh_options
    from ._gmsh_extraction import _extract_mesh_data, _extract_quality_metrics
    from ._gmsh_waveguides import add_antenna_layout_parts_to_occ, add_antenna_layout_terminal_physical_groups
    scale = 1e6
    gmsh = _import_gmsh()
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        _configure_gmsh_threads(gmsh)
        gmsh.model.add("fullmag_coincident_loop")
        parts = add_antenna_layout_parts_to_occ(gmsh, geometry, scale=scale, source_cut_offset_m=offset)
        gmsh.model.occ.synchronize()
        add_antenna_layout_terminal_physical_groups(gmsh, geometry, parts, scale=scale, object_id=cut.region.object_id)
        inlet = parts[geometry.inlet_connection_part_id]
        surfaces = [tag for dim, tag in gmsh.model.getBoundary(inlet, combined=False, oriented=False) if dim == 2]
        plane_normal = np.linalg.inv(np.asarray(geometry.transform.rotation_matrix)).T[:, 2]
        plane_normal /= np.linalg.norm(plane_normal)
        origin = np.asarray(geometry.transform.apply((0, 0, offset))) * scale
        selected = []
        for tag, count in sorted(Counter(abs(tag) for tag in surfaces).items()):
            if count != 2:
                continue
            # The shared interface of the two authored inlet solids owns this cut.
            center = np.asarray(gmsh.model.occ.getCenterOfMass(2, tag))
            if abs(float(np.dot(center - origin, plane_normal))) >= 1e-10:
                raise ValueError("inlet conforming interface does not match source plane")
            selected.append(tag)
        if not selected:
            raise ValueError("Gmsh did not create the authored sourcecut surface")
        gmsh.model.addPhysicalGroup(2, selected, tag=2)
        gmsh.model.setPhysicalName(2, 2, "sourcecut")
        options = mesh_options or MeshOptions()
        if options.mesh_strategy not in {None, "auto", "free_tetrahedral"} or options.periodic_pair_ids:
            raise ValueError("coincident loop supports only nonperiodic free Tet4 meshing")
        _apply_mesh_options(gmsh, hmax_m * scale, 1, options, hscale=scale)
        gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, options)
        quality, per_domain = _extract_quality_metrics(gmsh, options) if options.compute_quality else (None, None)
        raw = _extract_mesh_data(gmsh, has_physical_groups=True, provisional_interface_markers={2},
                                 quality=quality, per_domain_quality=per_domain)
    finally:
        gmsh.finalize()
    return replace(raw, nodes=raw.nodes / scale)


def prepare_antenna_coincident_loop(closure, *, geometry, object_id, hmax_m, raw_mesh=None):
    cut = _validate_loop_request(closure, geometry, object_id, hmax_m)
    mesh = (realize_antenna_coincident_loop_mesh(closure, geometry=geometry, object_id=object_id, hmax_m=hmax_m)
            if raw_mesh is None else raw_mesh)
    cut = closure.source_cuts[0]
    if not isinstance(mesh, MeshData) or mesh.vertex_identity is None:
        raise ValueError("coincident preparation requires actual mesher-produced stable vertex IDs")
    ids = mesh.vertex_identity["vertex_ids"]
    plane_normal = np.linalg.inv(np.asarray(geometry.transform.rotation_matrix)).T[:, 2]
    plane_normal /= np.linalg.norm(plane_normal)
    seam_faces = mesh.boundary_faces[mesh.boundary_markers == 2]
    local = (mesh.nodes[np.asarray(seam_faces).reshape(-1)] - np.asarray(geometry.transform.translation_m)) @ np.linalg.inv(np.asarray(geometry.transform.rotation_matrix)).T
    if len(seam_faces) == 0 or np.any(np.abs(local[:, 2] - cut.plane.offset_m) > max(geometry.length_m, geometry.thickness_m) * 1e-12):
        raise ValueError("cached sourcecut does not match the authored object-frame plane")
    normal = plane_normal if cut.plane.normal == "positive_axis" else -plane_normal
    mesh, ids, source = split_coincident_sourcecut(mesh, seam_faces=seam_faces, stable_vertex_ids=ids,
        normal_world=normal, source_cut_id=cut.source_cut_id, potential_jump_v=cut.drive.potential_jump_V)
    sigma_by_marker = {1: geometry.conductivity_s_per_m, 2: geometry.conductivity_s_per_m,
                       3: geometry.inlet_connection_conductivity_s_per_m, 4: geometry.outlet_connection_conductivity_s_per_m}
    sigma = tuple(sigma_by_marker[int(marker)] for marker in mesh.element_markers)
    payload = {"geometry": geometry.to_ir(), "authored_closure": closure.to_ir(), "hmax_m": hmax_m,
               "mesh": mesh.to_ir(geometry.geometry_name), "stable_vertex_ids": list(ids), "conductivity": list(sigma)}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    materialized = ConservativeCurrentClosedGeometry("fem_closed_current_geometry.v2", digest, digest, [source])
    receipt = {"schema_version": "antenna_coincident_loop_preparation.v2", "status": "materialized_not_solved",
               "issuer": "gmsh_conforming_loop_topological_cut.v2", "input_digest": digest,
               "object_id": object_id, "geometry_id": geometry.geometry_name,
               "node_count": mesh.n_nodes, "cell_count": mesh.n_elements, "source_face_pair_count": len(source.face_pairs),
               "current_certificate": False, "basis_qualified": False, "antenna_completion": False}
    return PreparedAntennaCoincidentLoop(mesh, ids, materialized, sigma, receipt)


def coincident_terminal_observations(raw_mesh, prepared, *, geometry, object_id, port):
    """Bind authored refs to actual internal TRI3 contacts, outward from each part."""
    from ._gmsh_waveguides import antenna_terminal_marker
    if {branch.id for branch in port.branches} != set(geometry.conductor_part_ids):
        raise ValueError("coincident port must bind the exact signal and return part IDs")
    if len(port.branches) != 2 or any(not np.isfinite(branch.signed_weight) for branch in port.branches):
        raise ValueError("coincident port requires exactly two finite-weight branches")
    references = [ref for branch in port.branches for ref in (branch.inlet_terminal_ref, branch.outlet_terminal_ref)]
    if any(not isinstance(ref, str) or not ref.strip() for ref in references) or len(set(references)) != 4:
        raise ValueError("coincident source requires four unique authored observation references")
    ids = prepared.stable_vertex_ids
    id_nodes = {identity: index for index, identity in enumerate(ids)}
    topology = _faces(prepared.mesh.elements)
    raw_ids = raw_mesh.vertex_identity["vertex_ids"]
    inverse = np.linalg.inv(np.asarray(geometry.transform.rotation_matrix))
    world_axis = inverse.T[:, 0]
    world_axis /= np.linalg.norm(world_axis)
    translation = np.asarray(geometry.transform.translation_m)
    tolerance = max(geometry.length_m, geometry.thickness_m) * 1e-12
    observations = []
    for branch in port.branches:
        part_marker = 1 if branch.id == geometry.signal_part_id else 2
        for selector, reference, bridge_marker, position, sign in (
            ("local_u_min", branch.inlet_terminal_ref, 3, 0.0, -1.0),
            ("local_u_max", branch.outlet_terminal_ref, 4, geometry.length_m, 1.0),
        ):
            marker = antenna_terminal_marker(object_id, branch.id, selector)
            raw_faces = raw_mesh.boundary_faces[raw_mesh.boundary_markers == marker]
            if len(raw_faces) == 0:
                raise ValueError("missing actual mesher-produced observation contact")
            records = []
            seen = set()
            for raw_face in raw_faces:
                key = tuple(sorted(id_nodes[raw_ids[int(node)]] for node in raw_face))
                if key in seen:
                    raise ValueError("duplicate observation contact face")
                seen.add(key)
                owners = topology.get(key, [])
                part_owners = [(cell, face) for cell, face in owners if prepared.mesh.element_markers[cell] == part_marker]
                bridge_owners = [(cell, face) for cell, face in owners if prepared.mesh.element_markers[cell] == bridge_marker]
                if len(owners) != 2 or len(part_owners) != 1 or len(bridge_owners) != 1:
                    raise ValueError("observation must have exactly the authored part and bridge Tet4 owners")
                cell, face = part_owners[0]
                xyz = prepared.mesh.nodes[list(face)]
                normal = np.cross(xyz[1] - xyz[0], xyz[2] - xyz[0])
                area_twice = np.linalg.norm(normal)
                if not np.isfinite(area_twice) or area_twice <= 0.0:
                    raise ValueError("observation face must have finite positive area")
                if np.linalg.norm(normal / area_twice - sign * world_axis) > 1e-10:
                    raise ValueError("observation face must point outward from the authored part")
                local = (xyz - translation) @ inverse.T
                if np.any(np.abs(local[:, 0] - position) > tolerance):
                    raise ValueError("observation is not on its authored local-u plane")
                face_ids = [ids[int(node)] for node in face]
                first = face_ids.index(min(face_ids))
                face_ids = face_ids[first:] + face_ids[:first]
                records.append({"face_vertex_ids": face_ids,
                                "part_cell_ordinal": int(cell), "bridge_cell_ordinal": int(bridge_owners[0][0])})
            records.sort(key=lambda item: (tuple(item["face_vertex_ids"]),
                                           item["part_cell_ordinal"], item["bridge_cell_ordinal"]))
            observations.append({"id": reference, "part_id": branch.id, "selector": selector,
                                 "faces": records, "normal_convention": "outward_from_part"})
    observations.sort(key=lambda item: item["id"])
    return observations
