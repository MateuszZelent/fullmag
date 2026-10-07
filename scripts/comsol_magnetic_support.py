"""Resolve an explicit magnetic/air element partition from native mesh parts.

No marker-number convention or node-range inference is used. This only resolves
semantic support; geometric Tet4 validation belongs to the projection helper.
"""
from collections.abc import Mapping


def tet4_cells(mesh):
    """Decode canonical FemConnectivityIR; reject legacy or mixed topology."""
    if not isinstance(mesh, Mapping) or "elements" in mesh:
        raise ValueError("canonical mesh.cells connectivity is required")
    cells = mesh.get("cells")
    if not isinstance(cells, Mapping):
        raise ValueError("mesh.cells must be canonical FemConnectivityIR")
    types, offsets, nodes = (cells.get(key) for key in ("types", "offsets", "nodes"))
    if not isinstance(types, list) or not types or any(kind != "tet4" for kind in types):
        raise ValueError("only nonempty Tet4 connectivity is supported")
    if not isinstance(offsets, list) or any(type(i) is not int for i in offsets) or offsets != list(range(0, 4 * len(types) + 1, 4)):
        raise ValueError("invalid Tet4 connectivity offsets")
    if not isinstance(nodes, list) or len(nodes) != offsets[-1] or any(type(i) is not int or i < 0 for i in nodes):
        raise ValueError("invalid Tet4 connectivity nodes")
    return [nodes[i:i + 4] for i in offsets[:-1]]


def magnetic_element_indices(mesh, mesh_parts):
    """Return sorted full-mesh element IDs, rejecting ambiguous partitions."""
    count = len(tet4_cells(mesh))
    if not isinstance(mesh_parts, list) or not mesh_parts:
        raise ValueError("explicit mesh_parts are required")
    domains = {}
    part_ids = set()
    for part in mesh_parts:
        if not isinstance(part, Mapping):
            raise ValueError("mesh part must be an object")
        role = part.get("role")
        if role in ("interface", "outer_boundary"):
            continue
        if role not in ("air", "magnetic_object"):
            raise ValueError("unsupported mesh part role")
        identity = part.get("id")
        if not isinstance(identity, str) or not identity or identity in part_ids:
            raise ValueError("volume part IDs must be unique nonempty strings")
        part_ids.add(identity)
        selector = part.get("element_selector")
        if not isinstance(selector, Mapping):
            raise ValueError("volume part requires element_selector")
        if selector.get("kind") == "element_range":
            start, length = selector.get("start"), selector.get("count")
            if type(start) is not int or type(length) is not int or start < 0 or length <= 0 or start + length > count:
                raise ValueError("invalid element range")
            selected = list(range(start, start + length))
        elif selector.get("kind") == "element_marker_set":
            markers = mesh.get("element_markers")
            wanted = selector.get("markers")
            if not isinstance(markers, list) or len(markers) != count or any(type(m) is not int or m < 0 for m in markers):
                raise ValueError("invalid full-mesh element_markers")
            if not isinstance(wanted, list) or not wanted or any(type(m) is not int or m < 0 for m in wanted) or len(set(wanted)) != len(wanted):
                raise ValueError("invalid selected markers")
            if not set(wanted).issubset(set(markers)):
                raise ValueError("selected marker has no elements")
            wanted_set = set(wanted)
            selected = [i for i, marker in enumerate(markers) if marker in wanted_set]
        else:
            raise ValueError("unsupported volume element selector")
        for element in selected:
            if element in domains:
                raise ValueError("overlapping volume element selectors")
            domains[element] = role
    if len(domains) != count:
        raise ValueError("volume parts do not partition every mesh element")
    result = sorted(i for i, role in domains.items() if role == "magnetic_object")
    if not result:
        raise ValueError("mesh has no explicit magnetic support")
    return result
