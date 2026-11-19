"""Gmsh STL shell recovery with source-element ownership and strict domains."""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Mapping

import numpy as np

from ._stl_shells import ShellInput, ShellTopology, classify_closed_shells


class StlTopologyError(ValueError):
    """Invalid/ambiguous imported domains; meshing fallbacks must not hide this."""


def surface_element_tags(gmsh: Any) -> set[int]:
    _, tags, _ = gmsh.model.mesh.getElements(2)
    return {int(tag) for block in tags for tag in block}


def merge_owned_stl(gmsh: Any, path: object, owner: str, owners: dict[int, str]) -> None:
    before = surface_element_tags(gmsh)
    try:
        gmsh.merge(str(path))
    except Exception as exc:
        raise StlTopologyError(f'Cannot establish closed STL source topology for {owner!r}: {exc}') from exc
    after = surface_element_tags(gmsh)
    if not before.issubset(after):
        raise StlTopologyError('STL merge changed existing source element identities')
    added = after-before
    if not added:
        raise StlTopologyError(f'STL component {owner!r} imported no new surface elements')
    owners.update((tag, owner) for tag in added)


def classify_owned_stl_shells(
    gmsh: Any,
    element_owners: Mapping[int,str],
    *,
    reparametrize: bool = False,
) -> ShellTopology:
    try:
        gmsh.model.mesh.classifySurfaces(
            40.0*np.pi/180.0,
            boundary=True,
            forReparametrization=reparametrize,
            curveAngle=np.pi,
        )
    except Exception as exc:
        raise StlTopologyError(
            f'Cannot establish closed STL shell topology during classification: {exc}'
        ) from exc
    return recover_shell_topology(gmsh,element_owners)


def recover_shell_topology(gmsh: Any, element_owners: Mapping[int, str]) -> ShellTopology:
    """Resolve ownership from source elements, never spatial overlap guesses."""
    node_tags, coordinates, _ = gmsh.model.mesh.getNodes()
    node_tags = np.asarray(node_tags,dtype=np.int64)
    order = np.argsort(node_tags)
    sorted_tags = node_tags[order]
    coordinates = np.asarray(coordinates,dtype=np.float64).reshape(-1,3)[order]
    surface_triangles: dict[int,np.ndarray] = {}
    surface_owners: dict[int,str] = {}
    observed: set[int] = set()
    for _, tag in gmsh.model.getEntities(2):
        types, element_tags, node_blocks = gmsh.model.mesh.getElements(2,tag)
        triangles = []
        provenance = set()
        has_foreign = False
        for kind, tags, nodes in zip(types,element_tags,node_blocks):
            tags = [int(value) for value in tags]
            owned = [value in element_owners for value in tags]
            if not any(owned):
                has_foreign |= bool(tags)
                continue
            if not all(owned) or int(kind) != 2:
                raise StlTopologyError('Classified STL surface has mixed/unsupported source element identity')
            provenance.update(element_owners[value] for value in tags)
            observed.update(tags)
            indices = np.searchsorted(sorted_tags,np.asarray(nodes,dtype=np.int64))
            if np.any(indices>=len(sorted_tags)) or not np.array_equal(sorted_tags[indices],np.asarray(nodes)):
                raise StlTopologyError('STL triangle references missing source node identities')
            triangles.append(coordinates[indices].reshape(-1,3,3))
        if triangles:
            if has_foreign or len(provenance) != 1:
                raise StlTopologyError('Classified STL surface has ambiguous source-component ownership')
            surface_triangles[int(tag)] = np.concatenate(triangles)
            surface_owners[int(tag)] = provenance.pop()
    if observed != set(element_owners):
        raise StlTopologyError('Gmsh classification lost or changed source STL element identities')
    parents = {tag:tag for tag in surface_triangles}

    def find(tag):
        while parents[tag] != tag:
            parents[tag] = parents[parents[tag]]
            tag = parents[tag]
        return tag

    edge_surfaces = defaultdict(list)
    for tag in surface_triangles:
        for _, edge in gmsh.model.getBoundary([(2,tag)],oriented=False):
            edge_surfaces[abs(int(edge))].append(tag)
    for tags in edge_surfaces.values():
        for tag in tags[1:]:
            parents[find(tag)] = find(tags[0])
    groups = defaultdict(list)
    for tag in surface_triangles:
        groups[find(tag)].append(tag)
    shells = []
    for tags in groups.values():
        provenance = {surface_owners[tag] for tag in tags}
        if len(provenance) != 1:
            raise StlTopologyError('A connected STL shell has ambiguous source-component ownership')
        shells.append(ShellInput(provenance.pop(),tuple(tags),np.concatenate([surface_triangles[tag] for tag in tags])))
    try:
        topology = classify_closed_shells(shells)
    except ValueError as exc:
        raise StlTopologyError(f'Invalid closed STL shell topology: {exc}') from exc
    # Different objects may occupy a cavity, but a material nested directly
    # inside another material would overlap; it cannot become an implicit hole.
    for index, parent in enumerate(topology.parent_indices):
        if topology.depths[index]%2 and parent is not None and topology.shells[index].owner != topology.shells[parent].owner:
            raise StlTopologyError('Nested STL component materials overlap; cavity boundary ownership differs from its parent')
    return topology


def shell_surface_loops(gmsh: Any, topology: ShellTopology) -> list[int]:
    return [gmsh.model.geo.addSurfaceLoop([
        (tag if topology.signed_volumes[index]>0 else -tag)
        for tag in shell.surface_tags
    ]) for index,shell in enumerate(topology.shells)]


def material_shell_volumes(gmsh: Any, topology: ShellTopology) -> tuple[dict[str,list[int]],dict[str,list[int]]]:
    loops = shell_surface_loops(gmsh,topology)
    volumes: dict[str,list[int]] = {}
    surfaces: dict[str,list[int]] = {}
    for index,shell in enumerate(topology.shells):
        volumes.setdefault(shell.owner,[])
        surfaces.setdefault(shell.owner,[]).extend(shell.surface_tags)
        if topology.depths[index]%2 == 0:
            holes = [loops[j] for j,parent in enumerate(topology.parent_indices) if parent == index]
            volumes[shell.owner].append(gmsh.model.geo.addVolume([loops[index],*holes]))
    if any(not tags for tags in volumes.values()):
        raise StlTopologyError('STL component has no independently owned material domain')
    gmsh.model.geo.synchronize()
    return volumes,surfaces
