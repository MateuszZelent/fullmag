"""Private mesh-exact straight stubs; preparation never qualifies a field basis."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import hashlib
import json
import math
from typing import Mapping, Sequence

import numpy as np

from fullmag.model.current_transport import (
    CurrentSourceDrive,
    CurrentSourceInterfacePair,
    CurrentSourceOuterTerminal,
    CurrentSourceTerminalObservation,
    ExternalLeadCurrentSource,
    TerminalLeadExtension,
    _source_freeze,
    _source_text,
)
from ._gmsh_types import MeshData


_MAX_CELLS = 1 << 20
_MAX_ITEMS = 4 * _MAX_CELLS
_U64_MAX = (1 << 64) - 1
_EPS = np.finfo(np.float64).eps
_TET_FACES = ((1, 2, 3), (0, 3, 2), (0, 1, 3), (0, 2, 1))


@dataclass(frozen=True, slots=True)
class PreparedAntennaExternalLeadSource:
    source: ExternalLeadCurrentSource
    lead_mesh: MeshData
    receipt: Mapping[str, object]


class _DisjointSet:
    def __init__(self, count: int) -> None:
        self.parent = list(range(count))

    def root(self, item: int) -> int:
        while item != self.parent[item]:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def join(self, first: int, second: int) -> None:
        first, second = self.root(first), self.root(second)
        if first != second:
            self.parent[max(first, second)] = min(first, second)


def _positive_tet(nodes: np.ndarray, tet: Sequence[int], *, orient: bool) -> tuple[int, ...]:
    result = tuple(int(v) for v in tet)
    edges = nodes[list(result)[1:]] - nodes[result[0]]
    scale = float(np.max(np.abs(edges)))
    if not math.isfinite(scale) or scale == 0 or len(set(result)) != 4:
        raise ValueError("tet4 is singular or repeats vertices")
    determinant = float(np.linalg.det(edges / scale))
    if not math.isfinite(determinant) or abs(determinant) <= 64 * _EPS:
        raise ValueError("tet4 is singular or numerically degenerate")
    if determinant < 0:
        if not orient:
            raise ValueError("device tet4 must have positive orientation")
        result = (result[0], result[2], result[1], result[3])
    return result


def _topology(mesh: MeshData):
    """Actual face components must be in bijection with P1 vertex components."""
    if not 0 < mesh.n_elements <= _MAX_CELLS or not 0 < mesh.n_nodes <= _MAX_ITEMS:
        raise ValueError("mesh exceeds bounded tetrahedral support")
    mesh.validate()
    if not np.all(np.isfinite(mesh.nodes)) or np.any(mesh.cell_types != "tet4") or np.any(mesh.facet_types != "tri3"):
        raise ValueError("straight stubs require finite Tet4/Tri3 mesh")
    if np.any(mesh.facet_roles != "exterior") or mesh.periodic_boundary_pairs or mesh.periodic_node_pairs or mesh.periodic_mesh_certificate:
        raise ValueError("straight stubs require exterior facets without periodic relations")
    faces = defaultdict(list)
    volume = _DisjointSet(mesh.n_elements)
    p1 = _DisjointSet(mesh.n_nodes)
    used, cell_keys = set(), set()
    for index, tet in enumerate(mesh.elements):
        tet = _positive_tet(mesh.nodes, tet, orient=False)
        key = tuple(sorted(tet))
        if key in cell_keys:
            raise ValueError("device has duplicate tetrahedral cells")
        cell_keys.add(key)
        used.update(tet)
        for vertex in tet[1:]:
            p1.join(tet[0], vertex)
        for local_face in _TET_FACES:
            face = tuple(tet[i] for i in local_face)
            faces[tuple(sorted(face))].append((index, face))
    if len(used) != mesh.n_nodes:
        raise ValueError("device has unused vertices")
    for entries in faces.values():
        if len(entries) > 2:
            raise ValueError("mesh has nonmanifold face incidence")
        if len(entries) == 2:
            first, second = entries
            face = first[1]
            points = mesh.nodes[list(face)]
            normal = np.cross(points[1] - points[0], points[2] - points[0])
            opposite = next(v for v in mesh.elements[second[0]] if int(v) not in face)
            if float(np.dot(normal, mesh.nodes[int(opposite)] - points[0])) <= 0:
                raise ValueError("adjacent tetrahedra occupy the same side of their shared face")
            volume.join(first[0], second[0])
    by_volume, by_p1 = {}, {}
    components = []
    for index, tet in enumerate(mesh.elements):
        vroot, proot = volume.root(index), p1.root(int(tet[0]))
        if by_volume.setdefault(vroot, proot) != proot or by_p1.setdefault(proot, vroot) != vroot:
            raise ValueError("vertex/edge-only shorting is unsupported")
        components.append(vroot)
    exterior = {key: entries[0] for key, entries in faces.items() if len(entries) == 1}
    authored = [tuple(sorted(int(v) for v in face)) for face in mesh.boundary_faces]
    if len(set(authored)) != len(authored) or set(authored) != exterior.keys():
        raise ValueError("facets must cover exactly the actual tetrahedral exterior")
    return exterior, components


def _connected(adjacency: Mapping[int, set[int]]) -> bool:
    if not adjacency:
        return False
    reached, pending = set(), [next(iter(adjacency))]
    while pending:
        vertex = pending.pop()
        if vertex not in reached:
            reached.add(vertex)
            pending.extend(adjacency[vertex] - reached)
    return reached == adjacency.keys()


def _cap(mesh: MeshData, extension: TerminalLeadExtension, exterior, components):
    marker_set = set(extension.boundary_markers)
    if not marker_set <= set(int(v) for v in mesh.boundary_markers):
        raise ValueError("selected boundary marker does not exist in the actual mesh")
    selected = [tuple(sorted(int(v) for v in face)) for face, marker in zip(
        mesh.boundary_faces, mesh.boundary_markers, strict=True
    ) if int(marker) in marker_set]
    vertices = sorted({v for face in selected for v in face})
    if len({tuple(mesh.nodes[v]) for v in vertices}) != len(vertices):
        raise ValueError("terminal cap has coincident distinct vertex identities")
    roots = {components[exterior[face][0]] for face in selected}
    if len(roots) != 1:
        raise ValueError("a terminal cap spans physical components")
    root = next(iter(roots))
    direction = np.asarray(extension.outward_direction_xyz)
    origin = mesh.nodes[vertices[0]]
    relative = mesh.nodes - origin
    scale = float(np.max(np.abs(relative)))
    tolerance = 512 * _EPS * scale
    signed_distance = relative @ direction
    if np.any(np.abs(signed_distance[vertices]) > tolerance):
        raise ValueError("selected cap is not planar perpendicular to its outward direction")
    if np.any(signed_distance > tolerance):
        raise ValueError("outward plane does not separate the stub from all device vertices")
    coplanar = {face for face, entry in exterior.items() if components[entry[0]] == root
                and np.all(np.abs(signed_distance[list(face)]) <= tolerance)}
    if set(selected) != coplanar:
        raise ValueError("selected markers do not cover the complete terminal cap")
    edges, adjacency, links = defaultdict(int), defaultdict(set), defaultdict(lambda: defaultdict(set))
    area = 0.0
    for face in selected:
        oriented = exterior[face][1]
        points = mesh.nodes[list(oriented)]
        normal = np.cross(points[1] - points[0], points[2] - points[0])
        norm = float(np.linalg.norm(normal))
        if not math.isfinite(norm) or norm == 0 or float(np.dot(normal / norm, direction)) < 1 - 1e-10:
            raise ValueError("cap direction disagrees with the actual outward normals")
        area += norm / 2
        for a, b in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])):
            edges[tuple(sorted((a, b)))] += 1
            adjacency[a].add(b)
            adjacency[b].add(a)
        for vertex in face:
            a, b = [v for v in face if v != vertex]
            links[vertex][a].add(b)
            links[vertex][b].add(a)
    if any(count > 2 for count in edges.values()) or len(vertices) - len(edges) + len(selected) != 1 or not _connected(adjacency):
        raise ValueError("cap must be a connected manifold disk")
    boundary = defaultdict(set)
    for (a, b), count in edges.items():
        if count == 1:
            boundary[a].add(b)
            boundary[b].add(a)
    if not _connected(boundary) or any(len(neighbours) != 2 for neighbours in boundary.values()):
        raise ValueError("cap boundary must be one simple cycle")
    for vertex, link in links.items():
        degrees = sorted(len(neighbours) for neighbours in link.values())
        expected = [1, 1] + [2] * (len(link) - 2) if vertex in boundary else [2] * len(link)
        if not _connected(link) or degrees != expected:
            raise ValueError("cap has nonmanifold vertex incidence")
    first = min(boundary)
    polygon, previous, current = [first], first, min(boundary[first])
    while current != first:
        polygon.append(current)
        following = next(v for v in boundary[current] if v != previous)
        previous, current = current, following
        if len(polygon) > len(boundary):
            raise ValueError("cap boundary is not a disk cycle")
    if len(polygon) != len(boundary):
        raise ValueError("cap has multiple boundary cycles")
    points = relative[polygon] / scale
    turns = [float(np.dot(np.cross(points[(i + 1) % len(points)] - point,
                                  points[(i + 2) % len(points)] - points[(i + 1) % len(points)]), direction))
             for i, point in enumerate(points)]
    if not (all(v >= -512 * _EPS for v in turns) or all(v <= 512 * _EPS for v in turns)):
        raise ValueError("nonconvex terminal caps are unsupported")
    turning_angle = math.fsum(math.atan2(turns[i], float(np.dot(
        points[(i + 1) % len(points)] - point,
        points[(i + 2) % len(points)] - points[(i + 1) % len(points)]
    ))) for i, point in enumerate(points))
    if abs(abs(turning_angle) - 2 * math.pi) > 1e-8:
        raise ValueError("cap boundary must be a simple convex polygon with winding one")
    polygon_area = abs(math.fsum(float(np.dot(np.cross(point, points[(i + 1) % len(points)]), direction))
                                  for i, point in enumerate(points))) / 2
    if polygon_area == 0 or abs(area / scale**2 - polygon_area) > 1e-10 * polygon_area:
        raise ValueError("cap triangulation does not fill its convex boundary")
    return selected, vertices, root


def prepare_antenna_external_lead_source(
    *, device_mesh: MeshData, extensions: Sequence[TerminalLeadExtension],
    drives: Sequence[CurrentSourceDrive], revision: str,
) -> PreparedAntennaExternalLeadSource:
    """Extrude explicitly selected contacts, preserving authored current controls."""
    if not isinstance(device_mesh, MeshData):
        raise TypeError("device_mesh must be MeshData")
    identity = device_mesh.vertex_identity
    if identity is None or identity["issuer"] != "gmsh_node_tags.v1":
        raise ValueError("device mesh requires retained actual gmsh_node_tags.v1 identity")
    device_ids = tuple(identity["vertex_ids"])
    if len(device_ids) != device_mesh.n_nodes or len(set(device_ids)) != len(device_ids) or any(
        type(value) is not int or not 0 < value <= _U64_MAX for value in device_ids
    ):
        raise ValueError("device vertex identity is invalid")
    extensions, drives = tuple(extensions), tuple(drives)
    if not 2 <= len(extensions) <= 128 or not all(isinstance(e, TerminalLeadExtension) for e in extensions):
        raise ValueError("extensions require two or more bounded typed electrodes")
    if len({e.id for e in extensions}) != len(extensions) or len({e.observation_id for e in extensions}) != len(extensions):
        raise ValueError("extension and observation IDs must be unique")
    if not drives or len(drives) > _MAX_ITEMS or not all(isinstance(d, CurrentSourceDrive) for d in drives):
        raise ValueError("drives require bounded explicit CurrentSourceDrive values")
    if len(drives) * len(extensions) > _MAX_ITEMS:
        raise ValueError("aggregate drive controls exceed the source item budget")
    revision = _source_text(revision, "revision")
    exterior, components = _topology(device_mesh)
    prepared, occupied, boxes = [], set(), []
    component_terminals = defaultdict(list)
    node_count = cell_count = pair_count = 0
    for extension in sorted(extensions, key=lambda e: e.id):
        faces, vertices, root = _cap(device_mesh, extension, exterior, components)
        if occupied.intersection(vertices):
            raise ValueError("terminal caps must have disjoint reaction DOF")
        occupied.update(vertices)
        vertices.sort(key=lambda v: device_ids[v])
        node_count += len(vertices) * (extension.layers + 1)
        cell_count += 3 * len(faces) * extension.layers
        pair_count += len(faces)
        if node_count > _MAX_ITEMS or cell_count > _MAX_CELLS or pair_count > _MAX_ITEMS:
            raise ValueError("extrusion exceeds bounded source support before allocation")
        endpoints = device_mesh.nodes[vertices] + extension.length_m * np.asarray(extension.outward_direction_xyz)
        if not np.all(np.isfinite(endpoints)):
            raise ValueError("extruded coordinates are non-finite")
        low = np.minimum(device_mesh.nodes[vertices].min(axis=0), endpoints.min(axis=0))
        high = np.maximum(device_mesh.nodes[vertices].max(axis=0), endpoints.max(axis=0))
        for previous_low, previous_high in boxes:
            if not np.any((high < previous_low) | (previous_high < low)):
                raise ValueError("overlapping AABBs: strict stub separation certification is unsupported")
        boxes.append((low, high))
        component_terminals[root].append(extension.id)
        prepared.append((extension, faces, vertices))
    if set(component_terminals) != set(components) or any(len(v) < 2 for v in component_terminals.values()):
        raise ValueError("every device component requires at least two explicit outer electrodes")
    if sum(len(v) - 1 for v in component_terminals.values()) > 64:
        raise ValueError("independent terminal controls exceed the native budget of 64")
    terminal_ids = {e.id for e in extensions}
    for drive in drives:
        if set(drive.outer_terminal_currents_a) != terminal_ids:
            raise ValueError("each drive must cover exactly all outer terminals")
        for terminals in component_terminals.values():
            values = [drive.outer_terminal_currents_a[t] for t in terminals]
            try:
                signed, absolute = math.fsum(values), math.fsum(abs(v) for v in values)
            except OverflowError as error:
                raise ValueError("component current sums must be finite") from error
            # Same SI gate as fullmag-plan antenna_current_source materialization.
            if not math.isfinite(signed) or not math.isfinite(absolute) or abs(signed) > 1e-18 + 1e-10 * absolute:
                raise ValueError("signed outer current imbalance in an electrical component")
    first_id = max(device_ids) + 1
    if first_id + node_count - 1 > _U64_MAX:
        raise ValueError("generated lead vertex IDs overflow u64 before allocation")
    nodes = np.empty((node_count, 3), dtype=np.float64)
    cells, sigma, element_markers, pairs, terminals, observations = [], [], [], [], [], []
    interface_faces, outer_faces = {}, {}
    node_offset = 0
    for branch, (extension, faces, vertices) in enumerate(prepared):
        count = len(vertices)
        local = {v: i for i, v in enumerate(vertices)}
        for layer in range(extension.layers + 1):
            start = node_offset + layer * count
            nodes[start:start + count] = device_mesh.nodes[vertices] if layer == 0 else (
                device_mesh.nodes[vertices] + (layer * extension.length_m / extension.layers) * np.asarray(extension.outward_direction_xyz)
            )
        branch_pair_ids, branch_outer_faces = [], []
        for ordinal, face in enumerate(sorted(faces, key=lambda f: tuple(sorted(device_ids[v] for v in f)))):
            ordered = sorted(face, key=lambda v: device_ids[v])
            base = tuple(node_offset + local[v] for v in ordered)
            for layer in range(extension.layers):
                a, b, c = (v + layer * count for v in base)
                aa, bb, cc = a + count, b + count, c + count
                for tet in ((a, b, c, cc), (a, b, bb, cc), (a, aa, bb, cc)):
                    cells.append(_positive_tet(nodes, tet, orient=True))
                    sigma.append(extension.conductivity_spm)
                    element_markers.append(branch + 1)
            lead_face = tuple(first_id + v for v in base)
            pair_id = f"{extension.id}:interface:{ordinal}"
            pairs.append(CurrentSourceInterfacePair(pair_id, tuple(device_ids[v] for v in ordered), lead_face,
                         tuple((device_ids[v], first_id + node_offset + local[v]) for v in ordered)))
            branch_pair_ids.append(pair_id)
            interface_faces[tuple(sorted(base))] = 3 * branch + 1
            outer = tuple(v + extension.layers * count for v in base)
            outer_faces[tuple(sorted(outer))] = 3 * branch + 2
            branch_outer_faces.append(tuple(first_id + v for v in outer))
        terminals.append(CurrentSourceOuterTerminal(extension.id, tuple(branch_outer_faces)))
        observations.append(CurrentSourceTerminalObservation(extension.observation_id, extension.object_id, tuple(branch_pair_ids)))
        node_offset += (extension.layers + 1) * count
    incidence = defaultdict(list)
    for index, tet in enumerate(cells):
        for local_face in _TET_FACES:
            face = tuple(tet[i] for i in local_face)
            incidence[tuple(sorted(face))].append((face, element_markers[index]))
    if any(len(v) > 2 for v in incidence.values()):
        raise ValueError("generated staircase topology is nonmanifold")
    exterior_entries = [(key, entries[0]) for key, entries in sorted(incidence.items()) if len(entries) == 1]
    if not interface_faces.keys() <= {key for key, _ in exterior_entries} or not outer_faces.keys() <= {key for key, _ in exterior_entries}:
        raise ValueError("generated interfaces and electrodes must be actual exterior faces")
    boundary = [entry[0] for _, entry in exterior_entries]
    boundary_markers = [interface_faces.get(key, outer_faces.get(key, 3 * entry[1])) for key, entry in exterior_entries]
    lead_mesh = MeshData.from_legacy_tet4(nodes=nodes, elements=cells, element_markers=element_markers,
        boundary_faces=boundary, boundary_markers=boundary_markers, vertex_identity=None)
    _topology(lead_mesh)
    # The source schema intentionally excludes UI mesh statistics. Build its
    # exact supported carrier from the generated arrays; retain the complete
    # MeshData separately, rather than weakening the source validator.
    source_mesh = {"mesh_name": "antenna-straight-stub-lead", "nodes": lead_mesh.nodes.tolist(),
        "cells": {"types": lead_mesh.cell_types.tolist(), "offsets": lead_mesh.cell_offsets.tolist(),
                  "nodes": lead_mesh.cell_nodes.tolist(), "global_ordinals": lead_mesh.cell_global_ordinals.tolist(),
                  "mesh_parts": lead_mesh.cell_mesh_parts.tolist()},
        "element_markers": lead_mesh.element_markers.tolist(),
        "facets": {"types": lead_mesh.facet_types.tolist(), "roles": lead_mesh.facet_roles.tolist(),
                   "offsets": lead_mesh.facet_offsets.tolist(), "nodes": lead_mesh.facet_nodes.tolist(),
                   "global_ordinals": lead_mesh.facet_global_ordinals.tolist()},
        "boundary_markers": lead_mesh.boundary_markers.tolist()}
    source = ExternalLeadCurrentSource(revision=revision, device_stable_vertex_ids=device_ids,
        lead_mesh=source_mesh, lead_stable_vertex_ids=tuple(range(first_id, first_id + node_count)),
        lead_conductivity_spm_per_element=tuple(sigma), interface_pairs=tuple(pairs),
        outer_terminals=tuple(terminals), terminal_observations=tuple(observations), drives=drives)
    input_mesh = device_mesh.to_ir("antenna-straight-stub-device")
    input_identity = {"device_mesh": input_mesh, "device_stable_vertex_ids": list(device_ids)}
    receipt = _source_freeze({"schema_version": "antenna_lead_preparation.v1",
        "policy": "isolated_branch_straight_stubs.v1", "issuer": "antenna_straight_stub_ids.v1",
        "status": "input_prepared_not_solved", "field_scope": "external_electrode_truncation",
        "capabilities": {"per_ampere_basis": False, "source_fft": False, "llg_drive": False},
        "revision": revision, **input_identity,
        "input_mesh_sha256": hashlib.sha256(json.dumps(input_identity, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest(),
        "extensions": [{name: getattr(e, name) for name in TerminalLeadExtension.__dataclass_fields__} for e, _, _ in prepared],
        "drives": [drive.to_ir() for drive in drives], "lead_stable_vertex_ids": list(source.lead_stable_vertex_ids),
        "lead_node_count": node_count, "lead_cell_count": cell_count})
    for array in (lead_mesh.nodes, lead_mesh.cell_nodes, lead_mesh.element_markers, lead_mesh.facet_nodes, lead_mesh.boundary_markers):
        array.setflags(write=False)
    return PreparedAntennaExternalLeadSource(source, lead_mesh, receipt)
