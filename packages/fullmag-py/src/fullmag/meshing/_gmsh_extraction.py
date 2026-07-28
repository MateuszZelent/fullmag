from __future__ import annotations

from dataclasses import replace
import hashlib
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from fullmag._progress import emit_progress

from ._gmsh_types import (
    SUPPORTED_BOUNDARY_ELEMENTS,
    SUPPORTED_VOLUME_ELEMENTS,
    MeshData,
    MeshOptions,
    MeshQualityReport,
)
from ._gmsh_infra import _import_meshio


class UnsupportedGmshElementError(ValueError):
    """Raised when a Gmsh element cannot be represented by :class:`MeshData`."""

    def __init__(
        self,
        *,
        element_type: int | str,
        name: str,
        dimension: int,
        order: int,
        arity: int,
        primary_arity: int,
        context: str,
    ) -> None:
        self.element_type = element_type
        self.element_name = name
        self.dimension = int(dimension)
        self.order = int(order)
        self.arity = int(arity)
        self.primary_arity = int(primary_arity)
        self.context = context
        self.rejected_element_types = [
            {
                "element_type": element_type,
                "name": name,
                "dimension": self.dimension,
                "order": self.order,
                "arity": self.arity,
                "primary_arity": self.primary_arity,
                "context": context,
            }
        ]
        super().__init__(
            f"unsupported Gmsh element type {element_type} ({name}) in {context}: "
            f"dimension={self.dimension}, order={self.order}, arity={self.arity}, "
            f"primary_arity={self.primary_arity}"
        )


def _gmsh_element_properties(
    gmsh: Any,
    element_type: int,
    *,
    dimension: int,
    supported: dict[int, tuple[str, int]],
    context: str,
) -> tuple[int, str]:
    """Resolve one exact supported Gmsh element type before reading connectivity."""
    name, element_dimension, order, arity, _parametric, primary_arity = (
        gmsh.model.mesh.getElementProperties(int(element_type))
    )
    expected = supported.get(int(element_type))
    if (
        expected is None
        or int(element_dimension) != int(dimension)
        or int(arity) != int(expected[1])
        or int(primary_arity) != int(expected[1])
    ):
        raise UnsupportedGmshElementError(
            element_type=int(element_type),
            name=str(name),
            dimension=int(element_dimension),
            order=int(order),
            arity=int(arity),
            primary_arity=int(primary_arity),
            context=context,
        )
    return int(arity), str(expected[0])


def _validate_gmsh_element_blocks(gmsh: Any, *, dimension: int) -> None:
    """Validate all elements in one dimension before selecting physical groups."""
    supported = SUPPORTED_VOLUME_ELEMENTS if dimension == 3 else SUPPORTED_BOUNDARY_ELEMENTS
    element_types, _tags, _node_tags = gmsh.model.mesh.getElements(dim=dimension)
    for element_type in element_types:
        _gmsh_element_properties(
            gmsh,
            int(element_type),
            dimension=dimension,
            supported=supported,
            context=("volume extraction" if dimension == 3 else "boundary extraction"),
        )


def _cell_blocks(mesh: Any, allowed: set[str], allow_empty: bool = False) -> NDArray[np.int32]:
    blocks = [
        np.asarray(cell_block.data, dtype=np.int32)
        for cell_block in mesh.cells
        if cell_block.type in allowed
    ]
    if blocks:
        return np.concatenate(blocks, axis=0)
    if allow_empty:
        width = 3 if "triangle" in allowed else 4
        return np.zeros((0, width), dtype=np.int32)
    raise ValueError(f"mesh does not contain required cell types: {sorted(allowed)}")


def _first_cell_block(mesh: Any, allowed: set[str], allow_empty: bool = False) -> NDArray[np.int32]:
    blocks = _cell_blocks(mesh, allowed, allow_empty=allow_empty)
    if blocks.shape[0] == 0:
        return blocks
    for cell_block in mesh.cells:
        if cell_block.type in allowed:
            return np.asarray(cell_block.data, dtype=np.int32)
    return blocks


def _semantic_marker_from_name(name: str | None, marker: int) -> int:
    normalized = (name or "").strip().lower().replace("-", "_").replace(" ", "_")
    if normalized in {"air", "airbox", "air_box", "__air__"}:
        return 0
    return int(marker)


def _meshio_physical_name_map(mesh: Any, *, dim: int | None = None) -> dict[int, str]:
    field_data = getattr(mesh, "field_data", {}) or {}
    result: dict[int, str] = {}
    for name, raw in field_data.items():
        values = np.asarray(raw).reshape(-1)
        if values.size == 0:
            continue
        marker = int(values[0])
        field_dim = int(values[1]) if values.size > 1 else None
        if dim is None or field_dim is None or field_dim == dim:
            result[marker] = str(name)
    return result


def _meshio_cell_markers(mesh: Any, *, cell_type: str, fallback: int = 1) -> NDArray[np.int32]:
    cell_blocks = list(getattr(mesh, "cells", []))
    matching_indices = [
        index for index, cell_block in enumerate(cell_blocks)
        if getattr(cell_block, "type", None) == cell_type
    ]
    if not matching_indices:
        width = 3 if cell_type == "triangle" else 4
        return np.ones((0,), dtype=np.int32) if width else np.ones((0,), dtype=np.int32)

    total = sum(int(np.asarray(cell_blocks[index].data).shape[0]) for index in matching_indices)
    markers = np.full(total, int(fallback), dtype=np.int32)

    def apply_block_values(values_by_block: list[Any], name_map: dict[int, str]) -> bool:
        offset = 0
        applied = False
        for block_index in matching_indices:
            count = int(np.asarray(cell_blocks[block_index].data).shape[0])
            if block_index < len(values_by_block):
                values = np.asarray(values_by_block[block_index], dtype=np.int32).reshape(-1)
                if values.shape[0] == count:
                    for local_index, marker in enumerate(values):
                        markers[offset + local_index] = _semantic_marker_from_name(
                            name_map.get(int(marker)),
                            int(marker),
                        )
                    applied = True
            offset += count
        return applied

    dim = 2 if cell_type == "triangle" else 3
    name_map = _meshio_physical_name_map(mesh, dim=dim)
    cell_data = getattr(mesh, "cell_data", {}) or {}
    for key in ("gmsh:physical", "medit:ref"):
        values_by_block = cell_data.get(key)
        if values_by_block is not None and apply_block_values(list(values_by_block), name_map):
            return markers

    cell_sets = getattr(mesh, "cell_sets", {}) or {}
    if cell_sets:
        offset_by_block: dict[int, int] = {}
        offset = 0
        for block_index in matching_indices:
            offset_by_block[block_index] = offset
            offset += int(np.asarray(cell_blocks[block_index].data).shape[0])
        next_marker = 1
        applied = False
        for set_name in sorted(cell_sets):
            semantic_marker = _semantic_marker_from_name(str(set_name), next_marker)
            if semantic_marker != 0:
                next_marker += 1
            for block_index, indices in enumerate(cell_sets[set_name]):
                if block_index not in offset_by_block:
                    continue
                block_count = int(np.asarray(cell_blocks[block_index].data).shape[0])
                for local_index in np.asarray(indices, dtype=np.int64).reshape(-1):
                    if 0 <= int(local_index) < block_count:
                        markers[offset_by_block[block_index] + int(local_index)] = semantic_marker
                        applied = True
        if applied:
            return markers

    return markers


def _read_mesh_file(path: Path) -> MeshData:
    meshio = _import_meshio()
    mesh = meshio.read(path)
    _reject_unsupported_meshio_elements(mesh)
    nodes = np.asarray(mesh.points[:, :3], dtype=np.float64)
    cell_types, cell_offsets, cell_nodes, element_markers = _meshio_typed_topology(
        mesh,
        _MESHIO_VOLUME_TYPES,
    )
    facet_types, facet_offsets, facet_nodes, boundary_markers = _meshio_typed_topology(
        mesh,
        _MESHIO_FACET_TYPES,
    )
    facet_roles = _derive_facet_roles(
        cell_types,
        cell_offsets,
        cell_nodes,
        element_markers,
        facet_offsets,
        facet_nodes,
        boundary_markers,
    )
    mesh = MeshData(
        nodes=nodes,
        cell_types=cell_types,
        cell_offsets=cell_offsets,
        cell_nodes=cell_nodes,
        element_markers=element_markers,
        facet_types=facet_types,
        facet_roles=facet_roles,
        facet_offsets=facet_offsets,
        facet_nodes=facet_nodes,
        boundary_markers=boundary_markers,
        cell_global_ordinals=np.arange(len(cell_types), dtype=np.int64),
        facet_global_ordinals=np.arange(len(facet_types), dtype=np.int64),
    )
    return mesh


_MESHIO_SUPPORTED_ELEMENTS: dict[str, tuple[int, int, int]] = {
    "tetra": (3, 1, 4),
    "wedge": (3, 1, 6),
    "prism": (3, 1, 6),
    "pyramid": (3, 1, 5),
    "hexahedron": (3, 1, 8),
    "triangle": (2, 1, 3),
    "quad": (2, 1, 4),
}

# Gmsh linear element IDs are an ingress detail. Keep the conversion to the
# canonical Fullmag local-node order explicit even where the current mapping
# is identity, so a future family cannot accidentally inherit prefix/order
# assumptions. Gmsh 4.15 Prism 6 uses bottom (0,1,2), top (3,4,5), matching
# Fullmag's positive-reference ``prism6`` convention.
_GMSH_TO_FULLMAG_NODE_PERMUTATION: dict[int, tuple[int, ...]] = {
    2: (0, 1, 2),
    3: (0, 1, 2, 3),
    4: (0, 1, 2, 3),
    5: (0, 1, 2, 3, 4, 5, 6, 7),
    6: (0, 1, 2, 3, 4, 5),
    7: (0, 1, 2, 3, 4),
}


def _canonical_gmsh_nodes(element_type: int, nodes: list[int]) -> list[int]:
    try:
        permutation = _GMSH_TO_FULLMAG_NODE_PERMUTATION[int(element_type)]
    except KeyError as exc:
        raise ValueError(
            f"missing canonical Fullmag node permutation for Gmsh element type {element_type}"
        ) from exc
    if len(nodes) != len(permutation):
        raise ValueError(
            f"Gmsh element type {element_type} has {len(nodes)} nodes; "
            f"canonical permutation expects {len(permutation)}"
        )
    return [nodes[index] for index in permutation]
_MESHIO_VOLUME_TYPES = {
    "tetra": "tet4",
    "wedge": "prism6",
    "prism": "prism6",
    "pyramid": "pyramid5",
    "hexahedron": "hex8",
}

_CELL_LOCAL_FACETS: dict[str, tuple[tuple[int, ...], ...]] = {
    "tet4": ((0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3)),
    "prism6": ((0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)),
    "pyramid5": ((0, 3, 2, 1), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)),
    "hex8": ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)),
}


def _drop_unattached_provisional_facets(
    cell_types: object,
    cell_offsets: object,
    cell_nodes: object,
    facet_types: list[str],
    facet_offsets: NDArray[np.int64],
    facet_nodes: NDArray[np.int32],
    boundary_markers: NDArray[np.int32],
    provisional_interface_markers: set[int],
) -> tuple[list[str], NDArray[np.int64], NDArray[np.int32], NDArray[np.int32]]:
    """Drop only declared provisional facets absent from volume topology.

    Gmsh can retain triangles from the embedded STL constraint which are not
    faces of any generated tetrahedron.  They are useful during generation but
    are not valid ``MeshData`` facets and are recreated from the frozen mesh
    after the air cells are clipped.
    """
    types = np.asarray(cell_types, dtype=np.str_)
    offsets = np.asarray(cell_offsets, dtype=np.int64)
    nodes = np.asarray(cell_nodes, dtype=np.int32)
    volume_facets: set[tuple[int, ...]] = set()
    for ordinal, cell_type in enumerate(types.tolist()):
        item = nodes[offsets[ordinal] : offsets[ordinal + 1]]
        for local_facet in _CELL_LOCAL_FACETS[cell_type]:
            volume_facets.add(
                tuple(sorted(int(item[index]) for index in local_facet))
            )

    kept_types: list[str] = []
    kept_offsets = [0]
    kept_nodes: list[int] = []
    kept_markers: list[int] = []
    for ordinal, facet_type in enumerate(facet_types):
        item = facet_nodes[facet_offsets[ordinal] : facet_offsets[ordinal + 1]]
        marker = int(boundary_markers[ordinal])
        key = tuple(sorted(int(node) for node in item))
        if marker in provisional_interface_markers and key not in volume_facets:
            continue
        kept_types.append(facet_type)
        kept_nodes.extend(int(node) for node in item)
        kept_offsets.append(len(kept_nodes))
        kept_markers.append(marker)
    return (
        kept_types,
        np.asarray(kept_offsets, dtype=np.int64),
        np.asarray(kept_nodes, dtype=np.int32),
        np.asarray(kept_markers, dtype=np.int32),
    )


def _is_tet4_provisional_interface_topology(
    cell_types: object,
) -> bool:
    types = np.asarray(cell_types, dtype=np.str_)
    return bool(len(types) > 0 and np.all(types == "tet4"))


def _derive_facet_roles(
    cell_types: object,
    cell_offsets: object,
    cell_nodes: object,
    element_markers: object,
    facet_offsets: object,
    facet_nodes: object,
    boundary_markers: object,
    *,
    periodic_markers: set[int] | None = None,
    provisional_interface_markers: set[int] | None = None,
) -> list[str]:
    types = np.asarray(cell_types, dtype=np.str_)
    offsets = np.asarray(cell_offsets, dtype=np.int64)
    nodes = np.asarray(cell_nodes, dtype=np.int32)
    markers = np.asarray(element_markers, dtype=np.int32)
    adjacency: dict[tuple[int, ...], list[int]] = {}
    for ordinal, cell_type in enumerate(types.tolist()):
        item = nodes[offsets[ordinal] : offsets[ordinal + 1]]
        for local_facet in _CELL_LOCAL_FACETS[cell_type]:
            key = tuple(sorted(int(item[index]) for index in local_facet))
            adjacency.setdefault(key, []).append(int(markers[ordinal]))

    face_offsets = np.asarray(facet_offsets, dtype=np.int64)
    face_nodes = np.asarray(facet_nodes, dtype=np.int32)
    face_markers = np.asarray(boundary_markers, dtype=np.int32)
    seams = periodic_markers or set()
    provisional_interfaces = provisional_interface_markers or set()
    provisional_interface_allowed = _is_tet4_provisional_interface_topology(types)
    roles: list[str] = []
    for ordinal in range(len(face_offsets) - 1):
        if int(face_markers[ordinal]) in seams:
            roles.append("periodic_seam")
            continue
        key = tuple(sorted(int(node) for node in face_nodes[face_offsets[ordinal] : face_offsets[ordinal + 1]]))
        adjacent = adjacency.get(key, [])
        if len(adjacent) == 1:
            roles.append("exterior")
        elif len(adjacent) == 2 and adjacent[0] != adjacent[1]:
            roles.append("material_interface")
        elif (
            len(adjacent) == 2
            and int(face_markers[ordinal]) in provisional_interfaces
            and provisional_interface_allowed
        ):
            # Frozen-submesh air generation temporarily meshes both sides of
            # its embedded marker-10 surface as air.  The inside cells are
            # clipped immediately after extraction, making this the certified
            # magnetic-air interface.  Keep this exception explicit so an
            # arbitrary same-region internal facet still fails closed.
            roles.append("material_interface")
        else:
            raise ValueError(
                f"facet {ordinal} cannot derive a canonical role from volume adjacency {adjacent}"
            )
    return roles
_MESHIO_FACET_TYPES = {"triangle": "tri3", "quad": "quad4"}
_MESHIO_IGNORED_LOWER_DIM_ELEMENTS: dict[str, tuple[int, int, int]] = {
    "vertex": (0, 1, 1),
    "line": (1, 1, 2),
    "line3": (1, 2, 3),
}


def _reject_unsupported_meshio_elements(mesh: Any) -> None:
    """Reject every non-empty cell block not representable by MeshData."""
    for cell_block in getattr(mesh, "cells", []):
        cell_type = str(getattr(cell_block, "type", "unknown"))
        data = np.asarray(getattr(cell_block, "data", []))
        if data.size == 0:
            continue
        metadata = _MESHIO_SUPPORTED_ELEMENTS.get(cell_type)
        if metadata is not None:
            continue
        if cell_type in _MESHIO_IGNORED_LOWER_DIM_ELEMENTS:
            continue
        dimension = 3 if cell_type in {"hexahedron", "prism", "pyramid", "wedge", "tetra10"} else 2
        order = 2 if any(token in cell_type for token in ("10", "6", "20", "27", "18", "15", "9")) else 1
        arity = int(data.shape[1]) if data.ndim == 2 else int(data.size)
        raise UnsupportedGmshElementError(
            element_type=cell_type,
            name=cell_type,
            dimension=dimension,
            order=order,
            arity=arity,
            primary_arity=arity,
            context="mesh file import",
        )


def _meshio_typed_topology(
    mesh: Any,
    type_map: dict[str, str],
) -> tuple[list[str], NDArray[np.int64], NDArray[np.int32], NDArray[np.int32]]:
    markers_by_type = {
        source_type: _meshio_cell_markers(mesh, cell_type=source_type)
        for source_type in type_map
    }
    marker_offsets = {source_type: 0 for source_type in type_map}
    types: list[str] = []
    offsets = [0]
    nodes: list[int] = []
    markers: list[int] = []
    for block in getattr(mesh, "cells", []):
        source_type = str(getattr(block, "type", ""))
        canonical_type = type_map.get(source_type)
        if canonical_type is None:
            continue
        data = np.asarray(block.data, dtype=np.int32)
        type_markers = markers_by_type[source_type]
        marker_offset = marker_offsets[source_type]
        for local_index, row in enumerate(data):
            types.append(canonical_type)
            nodes.extend(int(node) for node in row)
            offsets.append(len(nodes))
            markers.append(int(type_markers[marker_offset + local_index]))
        marker_offsets[source_type] += len(data)
    return (
        types,
        np.asarray(offsets, dtype=np.int64),
        np.asarray(nodes, dtype=np.int32),
        np.asarray(markers, dtype=np.int32),
    )


def _extract_mesh_data(
    gmsh: Any,
    quality: MeshQualityReport | None = None,
    has_physical_groups: bool = False,
    per_domain_quality: dict[int, MeshQualityReport] | None = None,
    periodic_pair_specs: list[dict[str, object]] | None = None,
    provisional_interface_markers: set[int] | None = None,
) -> MeshData:
    emit_progress("Gmsh: extracting mesh data")
    node_tags, coords, _ = gmsh.model.mesh.getNodes()
    if len(node_tags) == 0:
        raise ValueError("gmsh produced an empty node set")

    node_index = {int(tag): idx for idx, tag in enumerate(node_tags)}
    nodes = np.asarray(coords, dtype=np.float64).reshape(-1, 3)

    # Validate the complete topology, including ungrouped entities, before
    # region-aware extraction can silently skip an unsupported block.
    _validate_gmsh_element_blocks(gmsh, dimension=3)
    _validate_gmsh_element_blocks(gmsh, dimension=2)

    extracted_element_tags: list[int] = []

    if has_physical_groups:
        # ── Region-aware extraction via physical groups ──
        physical_names_3d = {
            int(phys_tag): gmsh.model.getPhysicalName(3, int(phys_tag))
            for _dim, phys_tag in gmsh.model.getPhysicalGroups(dim=3)
        }
        physical_names_2d = {
            int(phys_tag): gmsh.model.getPhysicalName(2, int(phys_tag))
            for _dim, phys_tag in gmsh.model.getPhysicalGroups(dim=2)
        }
        cell_types: list[str] = []
        cell_offsets = [0]
        cell_nodes: list[int] = []
        markers_list: list[int] = []
        for _dim, phys_tag in gmsh.model.getPhysicalGroups(dim=3):
            semantic_marker = _semantic_marker_from_name(
                physical_names_3d.get(int(phys_tag)),
                int(phys_tag),
            )
            entities = gmsh.model.getEntitiesForPhysicalGroup(3, phys_tag)
            for entity in entities:
                elem_types, elem_tags, node_ids = gmsh.model.mesh.getElements(3, entity)
                for etype, tags, nids in zip(elem_types, elem_tags, node_ids):
                    num_nodes, kind = _gmsh_element_properties(
                        gmsh,
                        int(etype),
                        dimension=3,
                        supported=SUPPORTED_VOLUME_ELEMENTS,
                        context="volume extraction",
                    )
                    flat = [node_index[int(t)] for t in nids]
                    block_tags = [int(tag) for tag in tags]
                    for element_offset, start in enumerate(range(0, len(flat), num_nodes)):
                        cell_types.append(kind)
                        cell_nodes.extend(
                            _canonical_gmsh_nodes(
                                int(etype),
                                flat[start : start + num_nodes],
                            )
                        )
                        cell_offsets.append(len(cell_nodes))
                        markers_list.append(semantic_marker)
                        if element_offset < len(block_tags):
                            extracted_element_tags.append(block_tags[element_offset])

        facet_types: list[str] = []
        facet_offsets = [0]
        facet_nodes: list[int] = []
        bmarkers_list: list[int] = []
        for _dim, phys_tag in gmsh.model.getPhysicalGroups(dim=2):
            semantic_marker = _semantic_marker_from_name(
                physical_names_2d.get(int(phys_tag)),
                int(phys_tag),
            )
            entities = gmsh.model.getEntitiesForPhysicalGroup(2, phys_tag)
            for entity in entities:
                elem_types, _elem_tags, node_ids = gmsh.model.mesh.getElements(2, entity)
                for etype, nids in zip(elem_types, node_ids):
                    num_nodes, kind = _gmsh_element_properties(
                        gmsh,
                        int(etype),
                        dimension=2,
                        supported=SUPPORTED_BOUNDARY_ELEMENTS,
                        context="boundary extraction",
                    )
                    flat = [node_index[int(t)] for t in nids]
                    for start in range(0, len(flat), num_nodes):
                        facet_types.append(kind)
                        facet_nodes.extend(
                            _canonical_gmsh_nodes(
                                int(etype),
                                flat[start : start + num_nodes],
                            )
                        )
                        facet_offsets.append(len(facet_nodes))
                        bmarkers_list.append(semantic_marker)

        cell_offsets_array = np.asarray(cell_offsets, dtype=np.int64)
        cell_nodes_array = np.asarray(cell_nodes, dtype=np.int32)
        element_markers = (
            np.asarray(markers_list, dtype=np.int32)
            if markers_list
            else np.zeros(0, dtype=np.int32)
        )
        facet_offsets_array = np.asarray(facet_offsets, dtype=np.int64)
        facet_nodes_array = np.asarray(facet_nodes, dtype=np.int32)
        boundary_markers = (
            np.asarray(bmarkers_list, dtype=np.int32)
            if bmarkers_list
            else np.zeros(0, dtype=np.int32)
        )
    else:
        # ── Legacy single-region path ──
        element_blocks = gmsh.model.mesh.getElements(dim=3)
        for block in element_blocks[1]:
            extracted_element_tags.extend(int(tag) for tag in block)
        cell_types, cell_offsets_array, cell_nodes_array = _extract_gmsh_typed_connectivity(
            gmsh, element_blocks, node_index, dimension=3
        )

        boundary_blocks = gmsh.model.mesh.getElements(dim=2)
        facet_types, facet_offsets_array, facet_nodes_array = _extract_gmsh_typed_connectivity(
            gmsh, boundary_blocks, node_index, dimension=2
        )

        element_markers = np.ones(len(cell_types), dtype=np.int32)
        boundary_markers = np.ones(len(facet_types), dtype=np.int32)
        if periodic_pair_specs:
            if any(kind != "tet4" for kind in cell_types) or any(
                kind != "tri3" for kind in facet_types
            ):
                raise ValueError(
                    "mixed topology with periodic pairs is not qualified; periodic extraction requires tet4/tri3"
                )
            boundary_markers = _extract_periodic_surface_markers(
                gmsh,
                node_index,
                facet_nodes_array.reshape((-1, 3)),
                periodic_pair_specs,
            )

    if provisional_interface_markers:
        if not _is_tet4_provisional_interface_topology(cell_types):
            raise ValueError(
                "provisional interface extraction is restricted to the "
                "tet4 frozen-air workflow"
            )
        (
            facet_types,
            facet_offsets_array,
            facet_nodes_array,
            boundary_markers,
        ) = _drop_unattached_provisional_facets(
            cell_types,
            cell_offsets_array,
            cell_nodes_array,
            facet_types,
            facet_offsets_array,
            facet_nodes_array,
            boundary_markers,
            provisional_interface_markers,
        )

    aligned_quality = _align_quality_report_to_element_tags(
        quality,
        extracted_element_tags,
    )
    tet4_only = all(kind == "tet4" for kind in cell_types)
    if not tet4_only:
        # Gmsh's historical SICN/gamma report in this path is calibrated for
        # tetrahedra. Do not relabel it as a mixed-family quality metric.
        aligned_quality = None
    elements = cell_nodes_array.reshape((-1, 4)) if tet4_only else None
    aligned_per_domain_quality = (
        build_per_domain_quality_from_mesh_arrays(
            nodes,
            elements,
            element_markers,
            aligned_quality,
        )
        if aligned_quality is not None and elements is not None
        else per_domain_quality
    )
    if periodic_pair_specs:
        if not tet4_only or any(kind != "tri3" for kind in facet_types):
            raise ValueError(
                "mixed topology with periodic pairs is not qualified; periodic extraction requires tet4/tri3"
            )
        _orient_periodic_boundary_faces(
            nodes,
            elements,
            facet_nodes_array.reshape((-1, 3)),
            boundary_markers,
            periodic_pair_specs,
        )
    periodic_boundary_pairs, periodic_node_pairs = _extract_periodic_pairs(
        gmsh,
        node_index,
        periodic_pair_specs or [],
    )

    facet_roles = _derive_facet_roles(
        cell_types,
        cell_offsets_array,
        cell_nodes_array,
        element_markers,
        facet_offsets_array,
        facet_nodes_array,
        boundary_markers,
        periodic_markers={
            int(marker)
            for spec in (periodic_pair_specs or [])
            for marker in (spec.get("marker_a"), spec.get("marker_b"))
            if marker is not None
        },
        provisional_interface_markers=provisional_interface_markers,
    )
    return MeshData(
        nodes=nodes,
        cell_types=cell_types,
        cell_offsets=cell_offsets_array,
        cell_nodes=cell_nodes_array,
        element_markers=element_markers,
        facet_types=facet_types,
        facet_roles=facet_roles,
        facet_offsets=facet_offsets_array,
        facet_nodes=facet_nodes_array,
        boundary_markers=boundary_markers,
        cell_global_ordinals=np.arange(len(cell_types), dtype=np.int64),
        facet_global_ordinals=np.arange(len(facet_types), dtype=np.int64),
        periodic_boundary_pairs=periodic_boundary_pairs,
        periodic_node_pairs=periodic_node_pairs,
        quality=aligned_quality,
        per_domain_quality=aligned_per_domain_quality,
    )


def _orient_periodic_boundary_faces(
    nodes: np.ndarray,
    elements: np.ndarray,
    boundary_faces: np.ndarray,
    boundary_markers: np.ndarray,
    periodic_pair_specs: list[dict[str, object]],
) -> None:
    """Orient periodic outer faces away from their owning tetrahedron.

    Gmsh may return a periodic surface's triangle winding in the same local
    direction on both translated copies.  The v6 certificate intentionally
    checks opposed outward normals, so normalize only the explicitly periodic
    boundary faces against the adjacent volume element before publishing the
    mesh IR.
    """
    periodic_markers = {
        int(spec["marker_a"])
        for spec in periodic_pair_specs
    } | {
        int(spec["marker_b"])
        for spec in periodic_pair_specs
    }
    if not periodic_markers or boundary_faces.size == 0 or elements.size == 0:
        return
    face_owner: dict[tuple[int, int, int], int] = {}
    for element_index, element in enumerate(elements):
        for opposite in range(4):
            face = tuple(
                int(element[index])
                for index in range(4)
                if index != opposite
            )
            face_owner.setdefault(tuple(sorted(face)), element_index)
    for index, (face, marker) in enumerate(zip(boundary_faces, boundary_markers, strict=False)):
        if int(marker) not in periodic_markers:
            continue
        owner_index = face_owner.get(tuple(sorted(int(node) for node in face)))
        if owner_index is None:
            continue
        element = elements[owner_index]
        opposite = next(
            (int(node) for node in element if int(node) not in {int(value) for value in face}),
            None,
        )
        if opposite is None:
            continue
        a, b, c = (nodes[int(node)] for node in face)
        normal = np.cross(b - a, c - a)
        if float(np.dot(normal, nodes[opposite] - a)) > 0.0:
            boundary_faces[index, 1], boundary_faces[index, 2] = (
                boundary_faces[index, 2],
                boundary_faces[index, 1],
            )
    return None


def certify_extracted_periodic_mesh(
    nodes: NDArray[np.float64],
    boundary_faces: NDArray[np.int32],
    boundary_markers: NDArray[np.int32],
    periodic_boundary_pairs: list[dict[str, object]],
    periodic_node_pairs: list[dict[str, object]],
) -> dict[str, object]:
    """Certify periodic topology after Gmsh extraction.

    Gmsh's ``setPeriodic`` relation is only input evidence.  This verifier
    checks the extracted node bijection, translated face vertex sets,
    opposite face orientation, and multi-axis corner/edge commutation before
    the mesh is handed to the Rust v6 certificate builder.
    """
    coordinates = np.asarray(nodes, dtype=np.float64)
    faces = np.asarray(boundary_faces, dtype=np.int32)
    markers = np.asarray(boundary_markers, dtype=np.int32)
    if faces.ndim != 2 or faces.shape[1] != 3 or markers.shape != (faces.shape[0],):
        raise ValueError("periodic certificate requires triangular boundary faces and markers")
    if not periodic_boundary_pairs:
        raise ValueError("periodic certificate requires boundary pair metadata")

    maps: dict[str, dict[int, int]] = {}
    for raw_pair in periodic_node_pairs:
        pair_id = str(raw_pair.get("pair_id", "")).strip()
        if not pair_id:
            raise ValueError("periodic node pair has an empty pair_id")
        node_a = int(raw_pair.get("node_a", -1))
        node_b = int(raw_pair.get("node_b", -1))
        if node_a < 0 or node_b < 0 or node_a >= len(coordinates) or node_b >= len(coordinates):
            raise ValueError(f"periodic node pair '{pair_id}' references an invalid node")
        mapping = maps.setdefault(pair_id, {})
        previous = mapping.get(node_a)
        if previous is not None and previous != node_b:
            raise ValueError(f"periodic node bijection for '{pair_id}' has conflicting source mapping")
        if node_b in mapping.values() and previous != node_b:
            raise ValueError(f"periodic node bijection for '{pair_id}' has duplicate destination mapping")
        mapping[node_a] = node_b

    marker_faces: dict[int, list[int]] = {}
    for index, marker in enumerate(markers.tolist()):
        marker_faces.setdefault(int(marker), []).append(index)

    pair_ids: set[str] = set()
    for raw_pair in periodic_boundary_pairs:
        pair_id = str(raw_pair.get("pair_id", "")).strip()
        marker_a = int(raw_pair.get("marker_a", -1))
        marker_b = int(raw_pair.get("marker_b", -1))
        mapping = maps.get(pair_id)
        if mapping is None:
            raise ValueError(f"periodic face pair '{pair_id}' has no extracted node bijection")
        source_faces = marker_faces.get(marker_a, [])
        destination_faces = marker_faces.get(marker_b, [])
        if not source_faces or len(source_faces) != len(destination_faces):
            raise ValueError(
                f"periodic face bijection for '{pair_id}' is incomplete: "
                f"{len(source_faces)} source faces vs {len(destination_faces)} destination faces"
            )
        destination_by_vertices = {
            frozenset(int(node) for node in faces[index]): index
            for index in destination_faces
        }
        if len(destination_by_vertices) != len(destination_faces):
            raise ValueError(f"periodic face bijection for '{pair_id}' has duplicate destination faces")
        translation = np.asarray(raw_pair.get("translation", [0.0, 0.0, 0.0]), dtype=np.float64)
        if translation.shape != (3,) or not np.all(np.isfinite(translation)):
            raise ValueError(f"periodic face pair '{pair_id}' has an invalid translation")
        tolerance = float(raw_pair.get("tolerance_m", 0.0))
        if not np.isfinite(tolerance) or tolerance < 0.0:
            raise ValueError(f"periodic face pair '{pair_id}' has an invalid tolerance")
        tolerance = max(tolerance, np.finfo(np.float64).eps * max(1.0, float(np.ptp(coordinates))))
        for node_a, node_b in mapping.items():
            residual = float(np.max(np.abs(coordinates[node_a] + translation - coordinates[node_b])))
            if residual > tolerance:
                raise ValueError(
                    f"periodic node translation residual for '{pair_id}' is {residual:.3e}, "
                    f"above tolerance {tolerance:.3e}"
                )
        for source_index in source_faces:
            source_face = faces[source_index]
            mapped_vertices = frozenset(mapping.get(int(node), -1) for node in source_face)
            if -1 in mapped_vertices or mapped_vertices not in destination_by_vertices:
                raise ValueError(f"periodic face bijection for '{pair_id}' is incomplete")
            destination_index = destination_by_vertices[mapped_vertices]
            source_normal = np.cross(
                coordinates[source_face[1]] - coordinates[source_face[0]],
                coordinates[source_face[2]] - coordinates[source_face[0]],
            )
            destination_face = faces[destination_index]
            destination_normal = np.cross(
                coordinates[destination_face[1]] - coordinates[destination_face[0]],
                coordinates[destination_face[2]] - coordinates[destination_face[0]],
            )
            source_norm = float(np.linalg.norm(source_normal))
            destination_norm = float(np.linalg.norm(destination_normal))
            if source_norm == 0.0 or destination_norm == 0.0 or float(np.dot(source_normal, destination_normal)) >= 0.0:
                raise ValueError(f"periodic face normals for '{pair_id}' are not mirrored")
        pair_ids.add(pair_id)

    ordered_pair_ids = sorted(pair_ids)
    for left_index, left_id in enumerate(ordered_pair_ids):
        for right_id in ordered_pair_ids[left_index + 1 :]:
            left_map = maps[left_id]
            right_map = maps[right_id]
            shared_sources = set(left_map).intersection(right_map)
            for source in shared_sources:
                left_then_right = right_map.get(left_map[source])
                right_then_left = left_map.get(right_map[source])
                if left_then_right is None or right_then_left is None or left_then_right != right_then_left:
                    raise ValueError(
                        f"periodic edge/corner closure does not commute for '{left_id}' and '{right_id}'"
                    )

    topology_digest = hashlib.sha256(
        np.ascontiguousarray(coordinates).tobytes()
        + np.ascontiguousarray(faces).tobytes()
        + np.ascontiguousarray(markers).tobytes()
    ).hexdigest()
    return {
        "schema_version": "periodic_mesh_certificate.v6",
        "certificate_status": "accepted",
        "axis_pair_count": len(pair_ids),
        "node_pair_count": len(periodic_node_pairs),
        "face_pair_count": len(periodic_boundary_pairs),
        "corner_edge_cycle_unique": True,
        "topology_fingerprint": f"sha256:{topology_digest}",
    }


def _extract_periodic_surface_markers(
    gmsh: Any,
    node_index: dict[int, int],
    boundary_faces: NDArray[np.int32],
    periodic_pair_specs: list[dict[str, object]],
) -> NDArray[np.int32]:
    """Recover periodic surface markers for legacy non-physical extraction."""
    surface_markers: dict[int, int] = {}
    for spec in periodic_pair_specs:
        for surface_key, marker_key in (("master_tag", "marker_a"), ("slave_tag", "marker_b")):
            surface_tag = int(spec[surface_key])
            marker = int(spec.get(marker_key, surface_tag))
            previous = surface_markers.get(surface_tag)
            if previous is not None and previous != marker:
                raise ValueError(f"periodic surface {surface_tag} has conflicting extracted markers")
            surface_markers[surface_tag] = marker

    marker_by_face: dict[tuple[int, int, int], int] = {}
    for surface_tag, marker in surface_markers.items():
        element_blocks = gmsh.model.mesh.getElements(2, surface_tag)
        for element_type, node_blocks in zip(element_blocks[0], element_blocks[2], strict=False):
            arity, _ = _gmsh_element_properties(
                gmsh,
                int(element_type),
                dimension=2,
                supported=SUPPORTED_BOUNDARY_ELEMENTS,
                context="periodic surface extraction",
            )
            flat = [node_index[int(tag)] for tag in node_blocks]
            for start in range(0, len(flat), arity):
                face = tuple(sorted(flat[start : start + arity]))
                if len(face) != 3:
                    raise ValueError(f"periodic surface {surface_tag} produced a non-triangular face")
                previous = marker_by_face.get(face)
                if previous is not None and previous != marker:
                    raise ValueError(f"periodic face {face} belongs to conflicting surfaces")
                marker_by_face[face] = marker

    markers = np.ones(boundary_faces.shape[0], dtype=np.int32)
    for index, face in enumerate(boundary_faces):
        markers[index] = marker_by_face.get(tuple(sorted(int(node) for node in face)), 1)
    return markers


def _extract_periodic_pairs(
    gmsh: Any,
    node_index: dict[int, int],
    periodic_pair_specs: list[dict[str, object]],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    if not periodic_pair_specs:
        return [], []

    boundary_pairs: list[dict[str, object]] = []
    seen_boundary_pairs: set[tuple[str, int, int]] = set()
    node_pairs: list[dict[str, object]] = []
    seen_nodes: set[tuple[str, int, int]] = set()

    for spec in periodic_pair_specs:
        pair_id = str(spec.get("pair_id", "")).strip()
        if not pair_id:
            continue
        slave_tag = int(spec["slave_tag"])
        master_tag = int(spec["master_tag"])
        try:
            tag_master, node_tags, node_tags_master, _affine = gmsh.model.mesh.getPeriodicNodes(  # type: ignore[attr-defined]
                2,
                slave_tag,
            )
        except Exception as exc:  # pragma: no cover - depends on gmsh diagnostics
            raise ValueError(
                f"gmsh did not provide periodic node pairs for '{pair_id}' surface {slave_tag}"
            ) from exc
        if int(tag_master) != master_tag:
            raise ValueError(
                f"gmsh periodic pair '{pair_id}' mapped surface {slave_tag} to master "
                f"{int(tag_master)}, expected {master_tag}"
            )
        if len(node_tags) != len(node_tags_master) or len(node_tags) == 0:
            raise ValueError(
                f"gmsh periodic pair '{pair_id}' has no node correspondence"
            )
        marker_a = int(spec.get("marker_a", master_tag))
        marker_b = int(spec.get("marker_b", slave_tag))
        boundary_key = (pair_id, marker_a, marker_b)
        if boundary_key not in seen_boundary_pairs:
            seen_boundary_pairs.add(boundary_key)
            boundary_pairs.append(
                {
                    "pair_id": pair_id,
                    "marker_a": marker_a,
                    "marker_b": marker_b,
                    "translation": list(spec.get("translation", [0.0, 0.0, 0.0])),
                    "tolerance_m": float(spec.get("tolerance_m", 0.0)),
                }
            )
        for slave_node_tag, master_node_tag in zip(node_tags, node_tags_master, strict=False):
            node_a = node_index.get(int(master_node_tag))
            node_b = node_index.get(int(slave_node_tag))
            if node_a is None or node_b is None or node_a == node_b:
                continue
            key = (pair_id, node_a, node_b)
            if key in seen_nodes:
                continue
            seen_nodes.add(key)
            node_pairs.append(
                {
                    "pair_id": pair_id,
                    "node_a": node_a,
                    "node_b": node_b,
                }
            )

    return boundary_pairs, node_pairs


def _align_quality_report_to_element_tags(
    quality: MeshQualityReport | None,
    extracted_element_tags: list[int],
) -> MeshQualityReport | None:
    """Align per-element Gmsh quality arrays to the extracted MeshData element order."""
    if quality is None:
        return None
    source_tags = quality.element_tags
    if (
        not source_tags
        or not extracted_element_tags
        or len(source_tags) != len(extracted_element_tags)
        or source_tags == extracted_element_tags
    ):
        return quality

    tag_to_index = {int(tag): index for index, tag in enumerate(source_tags)}
    try:
        order = [tag_to_index[int(tag)] for tag in extracted_element_tags]
    except KeyError:
        return quality

    def reorder(values: list[float] | None) -> list[float] | None:
        if values is None or len(values) != len(order):
            return values
        return [float(values[index]) for index in order]

    return replace(
        quality,
        element_sicn=reorder(quality.element_sicn),
        element_gamma=reorder(quality.element_gamma),
        element_volume=reorder(quality.element_volume),
        element_tags=[int(tag) for tag in extracted_element_tags],
    )


def _tetra_abs_volumes(
    nodes: NDArray[np.float64],
    elements: NDArray[np.int32],
) -> NDArray[np.float64]:
    if elements.size == 0:
        return np.zeros(0, dtype=np.float64)
    pts = nodes[elements]
    signed = np.einsum(
        "ij,ij->i",
        pts[:, 1] - pts[:, 0],
        np.cross(pts[:, 2] - pts[:, 0], pts[:, 3] - pts[:, 0]),
    ) / 6.0
    return np.abs(signed)


def build_per_domain_quality_from_mesh_arrays(
    nodes: NDArray[np.float64],
    elements: NDArray[np.int32],
    element_markers: NDArray[np.int32],
    quality: MeshQualityReport | None,
) -> dict[int, MeshQualityReport] | None:
    """Build per-domain quality from final mesh markers and aligned element arrays."""
    if quality is None or quality.element_sicn is None or quality.element_gamma is None:
        return None
    sicn = np.asarray(quality.element_sicn, dtype=np.float64)
    gamma = np.asarray(quality.element_gamma, dtype=np.float64)
    markers = np.asarray(element_markers, dtype=np.int32)
    if sicn.size != elements.shape[0] or gamma.size != elements.shape[0] or markers.size != elements.shape[0]:
        return None
    volumes = (
        np.asarray(quality.element_volume, dtype=np.float64)
        if quality.element_volume is not None and len(quality.element_volume) == elements.shape[0]
        else _tetra_abs_volumes(nodes, elements)
    )
    return extract_per_domain_quality(markers, sicn, gamma, volumes)


def extract_per_domain_quality(
    element_markers: NDArray[np.int32],
    sicn_values: NDArray[np.float64],
    gamma_values: NDArray[np.float64],
    volume_values: NDArray[np.float64],
) -> dict[int, MeshQualityReport]:
    """Compute quality metrics grouped per domain (element marker).

    Args:
        element_markers: Per-element domain marker array.
        sicn_values: Per-element SICN quality values.
        gamma_values: Per-element gamma quality values.
        volume_values: Per-element volume values.

    Returns:
        Mapping from marker integer to :class:`MeshQualityReport`.
    """
    result: dict[int, MeshQualityReport] = {}
    for marker in np.unique(element_markers):
        mask = element_markers == marker
        s = sicn_values[mask]
        g = gamma_values[mask]
        v = volume_values[mask]
        if s.size == 0:
            continue
        sicn_hist, _ = np.histogram(s, bins=20, range=(-1.0, 1.0))
        gamma_hist, _ = np.histogram(g, bins=20, range=(0.0, 1.0))
        result[int(marker)] = MeshQualityReport(
            n_elements=int(mask.sum()),
            sicn_min=float(np.min(s)),
            sicn_max=float(np.max(s)),
            sicn_mean=float(np.mean(s)),
            sicn_p5=float(np.percentile(s, 5)),
            sicn_histogram=sicn_hist.tolist(),
            gamma_min=float(np.min(g)),
            gamma_mean=float(np.mean(g)),
            gamma_histogram=gamma_hist.tolist(),
            volume_min=float(np.min(v)),
            volume_max=float(np.max(v)),
            volume_mean=float(np.mean(v)),
            volume_std=float(np.std(v)),
            avg_quality=float(np.mean(s)),
        )
    return result


def _extract_quality_metrics(
    gmsh: Any,
    opts: MeshOptions,
    element_markers: NDArray[np.int32] | None = None,
) -> tuple[MeshQualityReport, dict[int, MeshQualityReport] | None]:
    """Extract per-element quality metrics from the current Gmsh mesh."""
    emit_progress("Gmsh: extracting quality metrics")

    # Collect all 3D element tags
    elem_types, elem_tags_blocks, _ = gmsh.model.mesh.getElements(dim=3)
    all_tags: list[int] = []
    for block in elem_tags_blocks:
        all_tags.extend(int(t) for t in block)

    if not all_tags:
        return MeshQualityReport(
            n_elements=0,
            sicn_min=0.0, sicn_max=0.0, sicn_mean=0.0, sicn_p5=0.0,
            sicn_histogram=[0] * 20,
            gamma_min=0.0, gamma_mean=0.0,
            gamma_histogram=[0] * 20,
            volume_min=0.0, volume_max=0.0, volume_mean=0.0, volume_std=0.0,
            avg_quality=0.0,
        ), None

    sicn = np.asarray(gmsh.model.mesh.getElementQualities(all_tags, "minSICN"))
    gamma = np.asarray(gmsh.model.mesh.getElementQualities(all_tags, "gamma"))
    vols = np.asarray(gmsh.model.mesh.getElementQualities(all_tags, "volume"))
    avg_q = gmsh.option.getNumber("Mesh.AvgQuality")
    resolved_markers = (
        np.asarray(element_markers, dtype=np.int32)
        if element_markers is not None and len(element_markers) == len(all_tags)
        else _extract_element_markers_for_tags(gmsh, all_tags)
    )

    sicn_hist, _ = np.histogram(sicn, bins=20, range=(-1.0, 1.0))
    gamma_hist, _ = np.histogram(gamma, bins=20, range=(0.0, 1.0))

    return MeshQualityReport(
        n_elements=len(all_tags),
        sicn_min=float(np.min(sicn)),
        sicn_max=float(np.max(sicn)),
        sicn_mean=float(np.mean(sicn)),
        sicn_p5=float(np.percentile(sicn, 5)),
        sicn_histogram=sicn_hist.tolist(),
        gamma_min=float(np.min(gamma)),
        gamma_mean=float(np.mean(gamma)),
        gamma_histogram=gamma_hist.tolist(),
        volume_min=float(np.min(vols)),
        volume_max=float(np.max(vols)),
        volume_mean=float(np.mean(vols)),
        volume_std=float(np.std(vols)),
        avg_quality=float(avg_q),
        element_sicn=sicn.tolist() if opts.per_element_quality else None,
        element_gamma=gamma.tolist() if opts.per_element_quality else None,
        element_volume=vols.tolist() if opts.per_element_quality else None,
        element_tags=[int(tag) for tag in all_tags],
    ), (
        extract_per_domain_quality(
            resolved_markers,
            sicn,
            gamma,
            vols,
        )
        if resolved_markers is not None and len(resolved_markers) == len(all_tags)
        else None
    )


def _extract_element_markers_for_tags(
    gmsh: Any,
    all_tags: list[int],
) -> NDArray[np.int32] | None:
    """Return physical-group markers aligned to ``all_tags`` order."""
    if not all_tags:
        return np.zeros(0, dtype=np.int32)
    tag_to_marker: dict[int, int] = {}
    try:
        physical_groups = gmsh.model.getPhysicalGroups(dim=3)
    except Exception:
        physical_groups = []
    if not physical_groups:
        return None
    for _dim, phys_tag in physical_groups:
        try:
            entities = gmsh.model.getEntitiesForPhysicalGroup(3, phys_tag)
        except Exception:
            continue
        for entity in entities:
            try:
                _types, tag_blocks, _node_blocks = gmsh.model.mesh.getElements(3, entity)
            except Exception:
                continue
            for block in tag_blocks:
                for tag in block:
                    tag_to_marker[int(tag)] = int(phys_tag)
    if not tag_to_marker:
        return None
    return np.asarray([tag_to_marker.get(tag, 1) for tag in all_tags], dtype=np.int32)


def _extract_gmsh_typed_connectivity(
    gmsh: Any,
    element_blocks: tuple[list[int], list[np.ndarray], list[np.ndarray]],
    node_index: dict[int, int],
    *,
    dimension: int,
) -> tuple[list[str], NDArray[np.int64], NDArray[np.int32]]:
    element_types, _, node_tags_blocks = element_blocks
    types: list[str] = []
    offsets = [0]
    nodes: list[int] = []
    for element_type, tags in zip(element_types, node_tags_blocks):
        num_nodes, kind = _gmsh_element_properties(
            gmsh,
            int(element_type),
            dimension=dimension,
            supported=(
                SUPPORTED_VOLUME_ELEMENTS
                if dimension == 3
                else SUPPORTED_BOUNDARY_ELEMENTS
            ),
            context=("volume extraction" if dimension == 3 else "boundary extraction"),
        )
        flat = [node_index[int(tag)] for tag in tags]
        if len(flat) % num_nodes != 0:
            raise ValueError(
                f"gmsh connectivity for element type {element_type} has {len(flat)} "
                f"entries, not divisible by {num_nodes}"
            )
        for start in range(0, len(flat), num_nodes):
            types.append(kind)
            nodes.extend(
                _canonical_gmsh_nodes(
                    int(element_type),
                    flat[start : start + num_nodes],
                )
            )
            offsets.append(len(nodes))
    return (
        types,
        np.asarray(offsets, dtype=np.int64),
        np.asarray(nodes, dtype=np.int32),
    )


def _extract_gmsh_connectivity(
    gmsh: Any,
    element_blocks: tuple[list[int], list[np.ndarray], list[np.ndarray]],
    node_index: dict[int, int],
    nodes_per_element: int,
) -> NDArray[np.int32]:
    """Derived legacy fixed-arity view used only by tet4/tri3 callers."""
    dimension = 3 if nodes_per_element == 4 else 2
    expected = "tet4" if dimension == 3 else "tri3"
    types, _offsets, nodes = _extract_gmsh_typed_connectivity(
        gmsh,
        element_blocks,
        node_index,
        dimension=dimension,
    )
    if any(kind != expected for kind in types):
        raise ValueError(
            f"{expected}-only compatibility extraction cannot represent typed mixed connectivity"
        )
    return nodes.reshape((-1, nodes_per_element))


# ---------------------------------------------------------------------------
# Adaptive remeshing with PostView background size field
# ---------------------------------------------------------------------------
