"""Build canonical MeshData from the exact layered-box tetrahedralization."""
from __future__ import annotations

from collections.abc import Mapping
from numbers import Integral, Real
import math
from typing import Literal

import numpy as np
from numpy.typing import NDArray

from ._gmsh_types import MeshData
from ._layered_box_tetrahedralization import tetrahedralize_layered_box


_INTERFACE_MARKER = 10
_MAGNETIC_MARKER = 1
_AIR_MARKER = 0
_BOUNDARY_PAIR_KEYS = {
    "pair_id",
    "marker_a",
    "marker_b",
    "axis_hint",
    "translation",
    "tolerance_m",
}
_NODE_PAIR_KEYS = {"pair_id", "node_a", "node_b"}


def _positive_integer(value: object, name: str) -> int:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Integral):
        raise TypeError(f"{name} must be an integer")
    result = int(value)
    if result <= 0:
        raise ValueError(f"{name} must be positive")
    return result


def _finite_real(value: object, name: str) -> float:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Real):
        raise TypeError(f"{name} must be a real number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _sequence_of_mappings(value: object, name: str) -> tuple[Mapping[str, object], ...]:
    if not isinstance(value, (tuple, list)):
        raise TypeError(f"{name} must be a list or tuple of mappings")
    result: list[Mapping[str, object]] = []
    for index, entry in enumerate(value):
        if not isinstance(entry, Mapping):
            raise TypeError(f"{name}[{index}] must be a mapping")
        result.append(entry)
    return tuple(result)


def _validate_schema(
    entry: Mapping[str, object],
    *,
    name: str,
    allowed: set[str],
    required: set[str],
) -> None:
    unknown = set(entry) - allowed
    missing = required - set(entry)
    if unknown:
        raise ValueError(f"{name} has unknown fields: {sorted(unknown)}")
    if missing:
        raise ValueError(f"{name} is missing required fields: {sorted(missing)}")


def _pair_id(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value.strip()


def _normalize_periodic_patch_z_bounds(
    value: object,
    *,
    planes: NDArray[np.float64],
) -> dict[tuple[str, int, int], tuple[float, float]]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise TypeError("periodic_patch_z_bounds must be a mapping")

    plane_index = {float(plane): index for index, plane in enumerate(planes)}
    normalized: dict[tuple[str, int, int], tuple[float, float]] = {}
    for raw_key, raw_bounds in value.items():
        if not isinstance(raw_key, tuple) or len(raw_key) != 3:
            raise TypeError(
                "periodic_patch_z_bounds keys must be (pair_id, marker_a, marker_b) tuples"
            )
        key = (
            _pair_id(raw_key[0], "periodic_patch_z_bounds pair_id"),
            _positive_integer(raw_key[1], "periodic_patch_z_bounds marker_a"),
            _positive_integer(raw_key[2], "periodic_patch_z_bounds marker_b"),
        )
        if key[1] == key[2]:
            raise ValueError("periodic_patch_z_bounds must use distinct side markers")
        if key in normalized:
            raise ValueError(f"ambiguous periodic patch z scope key {key!r}")

        if (
            not isinstance(raw_bounds, (tuple, list, np.ndarray))
            or isinstance(raw_bounds, (str, bytes))
            or np.iscomplexobj(raw_bounds)
        ):
            raise TypeError(
                "periodic_patch_z_bounds values must contain two finite real z bounds"
            )
        try:
            raw = np.asarray(raw_bounds, dtype=object)
        except (TypeError, ValueError, OverflowError) as exc:
            raise TypeError(
                "periodic_patch_z_bounds values must contain two finite real z bounds"
            ) from exc
        if raw.shape != (2,):
            raise ValueError(
                "periodic_patch_z_bounds values must contain two finite real z bounds"
            )
        z_low = _finite_real(raw[0], f"periodic_patch_z_bounds[{key!r}][0]")
        z_high = _finite_real(raw[1], f"periodic_patch_z_bounds[{key!r}][1]")
        if z_low >= z_high:
            raise ValueError(
                f"periodic patch z scope {key!r} must be strictly increasing"
            )
        if z_low not in plane_index or z_high not in plane_index:
            raise ValueError(
                f"periodic patch z scope {key!r} endpoints must be exact layer planes"
            )
        normalized[key] = (z_low, z_high)
    return normalized


def _normalize_boundary_pairs(
    value: object,
    *,
    bounds_xy: tuple[float, float, float, float],
    planes: NDArray[np.float64],
    outer_boundary_marker: int,
    periodic_patch_z_bounds: object,
) -> tuple[list[dict[str, object]], dict[str, dict[str, object]]]:
    entries = _sequence_of_mappings(value, "periodic_boundary_pairs")
    explicit_scopes = _normalize_periodic_patch_z_bounds(
        periodic_patch_z_bounds,
        planes=planes,
    )
    normalized: list[dict[str, object]] = []
    by_id: dict[str, dict[str, object]] = {}
    groups: dict[str, list[dict[str, object]]] = {}
    seen_marker_rows: set[tuple[str, int, int]] = set()
    required_scope_keys: set[tuple[str, int, int]] = set()
    used_markers: set[int] = {_INTERFACE_MARKER, outer_boundary_marker}
    axis_owner: dict[int, str] = {}
    axis_limits = {
        0: (bounds_xy[0], bounds_xy[1]),
        1: (bounds_xy[2], bounds_xy[3]),
    }

    for index, entry in enumerate(entries):
        name = f"periodic_boundary_pairs[{index}]"
        _validate_schema(
            entry,
            name=name,
            allowed=_BOUNDARY_PAIR_KEYS,
            required={"pair_id", "marker_a", "marker_b", "translation", "tolerance_m"},
        )
        pair_id = _pair_id(entry["pair_id"], f"{name}.pair_id")
        marker_a = _positive_integer(entry["marker_a"], f"{name}.marker_a")
        marker_b = _positive_integer(entry["marker_b"], f"{name}.marker_b")
        if marker_a == marker_b:
            raise ValueError(f"{name} must use distinct side markers")
        marker_row = (pair_id, marker_a, marker_b)
        if marker_row in seen_marker_rows:
            raise ValueError(f"duplicate periodic pair_id scope {marker_row!r}")
        seen_marker_rows.add(marker_row)
        if marker_a in used_markers or marker_b in used_markers:
            raise ValueError(
                f"{name} markers must be distinct from interface marker 10, "
                "outer boundary marker, and every other periodic marker"
            )
        used_markers.update((marker_a, marker_b))

        raw_translation = entry["translation"]
        if not isinstance(raw_translation, (tuple, list, np.ndarray)):
            raise TypeError(f"{name}.translation must contain three real values")
        if np.asarray(raw_translation).shape != (3,):
            raise ValueError(f"{name}.translation must contain three real values")
        translation = tuple(
            _finite_real(component, f"{name}.translation[{axis}]")
            for axis, component in enumerate(raw_translation)
        )
        nonzero_axes = [axis for axis, component in enumerate(translation) if component != 0.0]
        if len(nonzero_axes) != 1 or nonzero_axes[0] not in (0, 1):
            raise ValueError(f"{name}.translation must be an axis-aligned x or y translation")
        axis = nonzero_axes[0]
        axis_name = "x" if axis == 0 else "y"
        if "axis_hint" in entry:
            raw_axis_hint = entry["axis_hint"]
            if not isinstance(raw_axis_hint, str) or raw_axis_hint not in ("x", "y"):
                raise ValueError(f"{name}.axis_hint must be 'x' or 'y'")
            hinted_axis = 0 if raw_axis_hint == "x" else 1
            if hinted_axis != axis:
                raise ValueError(f"{name}.axis_hint does not match its translation")

        previous_pair_id = axis_owner.get(axis)
        if previous_pair_id is not None and previous_pair_id != pair_id:
            raise ValueError(f"only one periodic pair per axis is supported ({axis_name})")
        axis_owner[axis] = pair_id

        low, high = axis_limits[axis]
        width = high - low
        if translation[axis] not in (width, -width):
            raise ValueError(
                f"{name}.translation must equal the exact {axis_name}-box width"
            )
        tolerance = _finite_real(entry["tolerance_m"], f"{name}.tolerance_m")
        if tolerance < 0.0:
            raise ValueError(f"{name}.tolerance_m must be nonnegative")

        side_a = "min" if translation[axis] > 0.0 else "max"
        side_b = "max" if translation[axis] > 0.0 else "min"
        pair = {
            "pair_id": pair_id,
            "marker_a": marker_a,
            "marker_b": marker_b,
            "axis_hint": axis_name,
            "translation": list(translation),
            "tolerance_m": tolerance,
            "_axis": axis,
            "_side_a": side_a,
            "_side_b": side_b,
        }
        logical_pair = by_id.get(pair_id)
        if logical_pair is None:
            by_id[pair_id] = pair
        elif (
            tuple(logical_pair["translation"]) != translation
            or float(logical_pair["tolerance_m"]) != tolerance
            or int(logical_pair["_axis"]) != axis
            or str(logical_pair["_side_a"]) != side_a
            or str(logical_pair["_side_b"]) != side_b
        ):
            raise ValueError(
                f"periodic pair_id {pair_id!r} has inconsistent translation, "
                "direction, or tolerance across marker patches"
            )
        normalized.append(pair)
        groups.setdefault(pair_id, []).append(pair)

    domain_low = float(planes[0])
    domain_high = float(planes[-1])
    for pair_id, rows in groups.items():
        if len(rows) == 1:
            row = rows[0]
            key = (pair_id, int(row["marker_a"]), int(row["marker_b"]))
            explicit_scope = explicit_scopes.get(key)
            if explicit_scope is None:
                row["_z_low"] = domain_low
                row["_z_high"] = domain_high
                continue
            if explicit_scope != (domain_low, domain_high):
                raise ValueError(
                    f"single periodic patch z scope for {pair_id!r} must cover "
                "the full exact z domain"
                )
            required_scope_keys.add(key)
            row["_z_low"], row["_z_high"] = explicit_scope
            continue

        group_keys = {
            (pair_id, int(row["marker_a"]), int(row["marker_b"]))
            for row in rows
        }
        missing = group_keys - set(explicit_scopes)
        if missing:
            raise ValueError(
                f"missing z scope for periodic pair_id {pair_id!r}: {sorted(missing)!r}"
            )
        required_scope_keys.update(group_keys)
        for row in rows:
            key = (pair_id, int(row["marker_a"]), int(row["marker_b"]))
            row["_z_low"], row["_z_high"] = explicit_scopes[key]

        ordered_rows = sorted(
            rows,
            key=lambda row: (float(row["_z_low"]), float(row["_z_high"])),
        )
        cursor = domain_low
        for row in ordered_rows:
            z_low = float(row["_z_low"])
            z_high = float(row["_z_high"])
            if z_low > cursor:
                raise ValueError(f"periodic patch z scopes for {pair_id!r} contain a gap")
            if z_low < cursor:
                raise ValueError(f"periodic patch z scopes for {pair_id!r} overlap")
            cursor = z_high
        if cursor < domain_high:
            raise ValueError(f"periodic patch z scopes for {pair_id!r} contain a gap")
        if cursor > domain_high:
            raise ValueError(f"periodic patch z scopes for {pair_id!r} overlap")

    unexpected = set(explicit_scopes) - required_scope_keys
    if unexpected:
        raise ValueError(
            f"unexpected periodic patch z scope keys: {sorted(unexpected)!r}"
        )

    normalized.sort(
        key=lambda pair: (
            str(pair["pair_id"]),
            int(pair["marker_a"]),
            int(pair["marker_b"]),
        )
    )
    return normalized, by_id


def _normalize_node_pairs(
    value: object,
    *,
    pair_by_id: Mapping[str, dict[str, object]],
    node_count: int,
) -> tuple[list[dict[str, object]], dict[str, dict[int, int]]]:
    entries = _sequence_of_mappings(value, "periodic_node_pairs")
    if entries and not pair_by_id:
        raise ValueError("periodic_node_pairs require periodic_boundary_pairs")

    normalized: list[dict[str, object]] = []
    maps: dict[str, dict[int, int]] = {pair_id: {} for pair_id in pair_by_id}
    destinations: dict[str, set[int]] = {pair_id: set() for pair_id in pair_by_id}
    seen_rows: set[tuple[str, int, int]] = set()

    for index, entry in enumerate(entries):
        name = f"periodic_node_pairs[{index}]"
        _validate_schema(
            entry,
            name=name,
            allowed=_NODE_PAIR_KEYS,
            required=_NODE_PAIR_KEYS,
        )
        pair_id = _pair_id(entry["pair_id"], f"{name}.pair_id")
        if pair_id not in pair_by_id:
            raise ValueError(f"{name} references unknown periodic pair_id {pair_id!r}")
        node_a = _positive_or_zero_integer(entry["node_a"], f"{name}.node_a")
        node_b = _positive_or_zero_integer(entry["node_b"], f"{name}.node_b")
        if node_a >= node_count or node_b >= node_count:
            raise ValueError(f"{name} contains an out-of-range node index")
        if node_a == node_b:
            raise ValueError(f"{name} must connect distinct nodes")
        row = (pair_id, node_a, node_b)
        if row in seen_rows:
            raise ValueError(f"duplicate periodic node pair {row!r}")
        seen_rows.add(row)
        mapping = maps[pair_id]
        if node_a in mapping:
            raise ValueError(f"periodic node map {pair_id!r} is not one-to-one on side A")
        if node_b in destinations[pair_id]:
            raise ValueError(f"periodic node map {pair_id!r} is not bijective")
        mapping[node_a] = node_b
        destinations[pair_id].add(node_b)
        normalized.append({"pair_id": pair_id, "node_a": node_a, "node_b": node_b})

    normalized.sort(key=lambda pair: (str(pair["pair_id"]), int(pair["node_a"]), int(pair["node_b"])))
    return normalized, maps


def _positive_or_zero_integer(value: object, name: str) -> int:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Integral):
        raise TypeError(f"{name} must be an integer")
    result = int(value)
    if result < 0:
        raise ValueError(f"{name} must be nonnegative")
    return result


def _classify_cells(
    nodes: NDArray[np.float64],
    planes: NDArray[np.float64],
    cells: NDArray[np.int32],
    magnetic_z_bounds: object,
) -> NDArray[np.int32]:
    if (
        not isinstance(magnetic_z_bounds, (tuple, list, np.ndarray))
        or isinstance(magnetic_z_bounds, (str, bytes))
        or np.iscomplexobj(magnetic_z_bounds)
    ):
        raise TypeError("magnetic_z_bounds must contain two finite real plane values")
    try:
        raw_body_bounds = np.asarray(magnetic_z_bounds, dtype=object)
    except (TypeError, ValueError, OverflowError) as exc:
        raise TypeError("magnetic_z_bounds must contain two finite real plane values") from exc
    if raw_body_bounds.shape != (2,):
        raise ValueError("magnetic_z_bounds must contain two finite real plane values")
    body_low = _finite_real(raw_body_bounds[0], "magnetic_z_bounds[0]")
    body_high = _finite_real(raw_body_bounds[1], "magnetic_z_bounds[1]")
    plane_index = {float(plane): index for index, plane in enumerate(planes)}
    if body_low == body_high:
        raise ValueError("magnetic_z_bounds must be distinct existing layer planes")
    if body_low not in plane_index or body_high not in plane_index:
        raise ValueError("magnetic_z_bounds must be existing layer planes")
    low_body_index = plane_index[body_low]
    high_body_index = plane_index[body_high]
    if low_body_index >= high_body_index:
        raise ValueError("magnetic_z_bounds must be in increasing order")
    if not (float(planes[0]) <= body_low < body_high <= float(planes[-1])):
        raise ValueError("magnetic_z_bounds must lie inside the total box")

    markers = np.empty(len(cells), dtype=np.int32)
    for ordinal, cell in enumerate(cells):
        cell_plane_indices: list[int] = []
        for node_id in cell:
            plane = float(nodes[int(node_id), 2])
            index = plane_index.get(plane)
            if index is None:
                raise ValueError("kernel tetrahedron contains a node off the exact layer planes")
            cell_plane_indices.append(index)
        cell_low = min(cell_plane_indices)
        cell_high = max(cell_plane_indices)
        if cell_high != cell_low + 1:
            raise ValueError("kernel tetrahedron does not lie in one exact layer slab")
        magnetic = low_body_index <= cell_low and cell_high <= high_body_index
        markers[ordinal] = _MAGNETIC_MARKER if magnetic else _AIR_MARKER

    if not np.any(markers == _MAGNETIC_MARKER):
        raise ValueError("layered box contains no magnetic tetrahedra")
    if not np.any(markers == _AIR_MARKER):
        raise ValueError("layered box contains no air tetrahedra")
    return markers


def _outward_face(cell: NDArray[np.int32], omitted: int) -> tuple[int, int, int]:
    face = [int(cell[index]) for index in range(4) if index != omitted]
    # The kernel returns positive-orientation tetrahedra. This is their induced
    # boundary orientation, so one-owner faces point out of the box and a
    # magnetic owner's interface face points from magnetic material into air.
    if omitted % 2:
        face[1], face[2] = face[2], face[1]
    return (face[0], face[1], face[2])


def _box_side(
    face: tuple[int, int, int],
    nodes: NDArray[np.float64],
    bounds_xy: tuple[float, float, float, float],
    z_bounds: tuple[float, float],
) -> tuple[int, str]:
    points = nodes[np.asarray(face, dtype=np.int64)]
    limits = (
        (0, bounds_xy[0], "min"),
        (0, bounds_xy[1], "max"),
        (1, bounds_xy[2], "min"),
        (1, bounds_xy[3], "max"),
        (2, z_bounds[0], "min"),
        (2, z_bounds[1], "max"),
    )
    matches = [
        (axis, side)
        for axis, coordinate, side in limits
        if np.all(points[:, axis] == coordinate)
    ]
    if len(matches) != 1:
        raise ValueError("kernel exterior facet is not on exactly one box side")
    return matches[0]


def _side_nodes(
    nodes: NDArray[np.float64], axis: int, side: str, bounds_xy: tuple[float, float, float, float]
) -> set[int]:
    coordinate = (
        bounds_xy[0] if axis == 0 and side == "min" else
        bounds_xy[1] if axis == 0 else
        bounds_xy[2] if side == "min" else
        bounds_xy[3]
    )
    return {
        int(index)
        for index in np.flatnonzero(nodes[:, axis] == coordinate)
    }


def _validate_periodic_topology(
    *,
    nodes: NDArray[np.float64],
    facets: list[tuple[tuple[int, int, int], str, int]],
    bounds_xy: tuple[float, float, float, float],
    boundary_pairs: list[dict[str, object]],
    node_maps: Mapping[str, dict[int, int]],
    node_pairs: list[dict[str, object]],
) -> None:
    if not boundary_pairs:
        if node_pairs:
            raise ValueError("periodic_node_pairs require periodic_boundary_pairs")
        return

    pairs_by_id: dict[str, list[dict[str, object]]] = {}
    for pair in boundary_pairs:
        pairs_by_id.setdefault(str(pair["pair_id"]), []).append(pair)

    def face_is_on_side(face: tuple[int, int, int], axis: int, side: str) -> bool:
        if axis == 0:
            coordinate = bounds_xy[0] if side == "min" else bounds_xy[1]
        else:
            coordinate = bounds_xy[2] if side == "min" else bounds_xy[3]
        return bool(np.all(nodes[np.asarray(face, dtype=np.int64), axis] == coordinate))

    for pair_id, patches in pairs_by_id.items():
        pair = patches[0]
        axis = int(pair["_axis"])
        side_a = str(pair["_side_a"])
        side_b = str(pair["_side_b"])
        side_a_nodes = _side_nodes(nodes, axis, side_a, bounds_xy)
        side_b_nodes = _side_nodes(nodes, axis, side_b, bounds_xy)
        mapping = node_maps[pair_id]
        if len(side_a_nodes) != len(side_b_nodes):
            raise ValueError(f"periodic node map {pair_id!r} has unequal side node counts")
        if set(mapping) != side_a_nodes or set(mapping.values()) != side_b_nodes:
            raise ValueError(
                f"periodic node map {pair_id!r} must bijectively cover every node on both sides"
            )

        translation = np.asarray(pair["translation"], dtype=np.float64)
        tolerance = float(pair["tolerance_m"])
        for node_a, node_b in mapping.items():
            delta = nodes[node_b] - nodes[node_a]
            residual = float(np.max(np.abs(delta - translation)))
            if residual > tolerance:
                raise ValueError(
                    f"periodic node translation for {pair_id!r} exceeds tolerance_m"
                )

        source_union: list[tuple[int, int, int]] = []
        destination_union: list[tuple[int, int, int]] = []
        source_union_nodes: set[int] = set()
        destination_union_nodes: set[int] = set()
        for patch in patches:
            marker_a = int(patch["marker_a"])
            marker_b = int(patch["marker_b"])
            z_low = float(patch["_z_low"])
            z_high = float(patch["_z_high"])
            side_a_facets = [
                face
                for face, role, marker in facets
                if role == "periodic_seam" and marker == marker_a
            ]
            side_b_facets = [
                face
                for face, role, marker in facets
                if role == "periodic_seam" and marker == marker_b
            ]
            if not side_a_facets or not side_b_facets:
                raise ValueError(f"periodic facet patch {pair_id!r} has an empty side")

            for label, patch_facets, side in (
                ("side-A", side_a_facets, side_a),
                ("side-B", side_b_facets, side_b),
            ):
                patch_nodes: set[int] = set()
                for face in patch_facets:
                    if not face_is_on_side(face, axis, side):
                        raise ValueError(
                            f"periodic facet patch {pair_id!r} contains a facet on the wrong side"
                        )
                    z_values = nodes[np.asarray(face, dtype=np.int64), 2]
                    if float(np.min(z_values)) < z_low or float(np.max(z_values)) > z_high:
                        raise ValueError(
                            f"periodic facet patch {pair_id!r} extends outside its exact z scope"
                        )
                    patch_nodes.update(face)
                side_nodes = side_a_nodes if side == side_a else side_b_nodes
                expected_patch_nodes = {
                    node
                    for node in side_nodes
                    if z_low <= float(nodes[node, 2]) <= z_high
                }
                if patch_nodes != expected_patch_nodes:
                    raise ValueError(
                        f"periodic facet patch {pair_id!r} does not cover every scoped {label} node"
                    )

            mapped_triangles: set[tuple[int, int, int]] = set()
            for face in side_a_facets:
                if any(node not in mapping for node in face):
                    raise ValueError(
                        f"periodic facet patch {pair_id!r} has an unmapped side-A node"
                    )
                mapped_triangles.add(tuple(sorted(mapping[node] for node in face)))
            destination_triangles = {
                tuple(sorted(face)) for face in side_b_facets
            }
            if (
                len(mapped_triangles) != len(side_a_facets)
                or len(destination_triangles) != len(side_b_facets)
                or mapped_triangles != destination_triangles
            ):
                raise ValueError(
                    f"periodic facet patch {pair_id!r} has mismatched complete triangle sets"
                )
            source_union.extend(side_a_facets)
            destination_union.extend(side_b_facets)
            source_union_nodes.update(node for face in side_a_facets for node in face)
            destination_union_nodes.update(node for face in side_b_facets for node in face)

        if source_union_nodes != side_a_nodes or destination_union_nodes != side_b_nodes:
            raise ValueError(
                f"periodic facet patches for {pair_id!r} do not cover all side nodes"
            )

        def side_facets(side: str) -> list[tuple[int, int, int]]:
            return [
                face
                for face, _role, _marker in facets
                if face_is_on_side(face, axis, side)
            ]

        source_keys = [tuple(sorted(face)) for face in source_union]
        destination_keys = [tuple(sorted(face)) for face in destination_union]
        expected_source = {
            tuple(sorted(face)) for face in side_facets(side_a)
        }
        expected_destination = {
            tuple(sorted(face)) for face in side_facets(side_b)
        }
        if (
            len(source_keys) != len(set(source_keys))
            or len(destination_keys) != len(set(destination_keys))
            or set(source_keys) != expected_source
            or set(destination_keys) != expected_destination
        ):
            raise ValueError(
                f"periodic facet patches for {pair_id!r} do not form the complete side unions"
            )

    pair_ids = sorted(pairs_by_id)
    for left_index, left_id in enumerate(pair_ids):
        for right_id in pair_ids[left_index + 1 :]:
            left_map = node_maps[left_id]
            right_map = node_maps[right_id]
            for source in set(left_map).intersection(right_map):
                left_then_right = right_map.get(left_map[source])
                right_then_left = left_map.get(right_map[source])
                if left_then_right is None or left_then_right != right_then_left:
                    raise ValueError("periodic edge/corner node mappings do not commute")


def build_layered_box_mesh_data(
    nodes: NDArray[np.float64] | list[list[float]],
    layer_planes: NDArray[np.float64] | list[float] | tuple[float, ...],
    bounds_xy: tuple[float, float, float, float] | list[float],
    *,
    magnetic_z_bounds: tuple[float, float] | list[float],
    outer_boundary_marker: int,
    periodic_boundary_pairs: tuple[dict[str, object], ...] | list[dict[str, object]] = (),
    periodic_node_pairs: tuple[dict[str, object], ...] | list[dict[str, object]] = (),
    periodic_patch_z_bounds: Mapping[
        tuple[str, int, int], tuple[float, float]
    ] | None = None,
    tetrahedralization_method: Literal["freudenthal", "delaunay"] = "freudenthal",
) -> MeshData:
    """Return canonical tet4/tri3 ``MeshData`` for a layered rectangular box.

    The selected private kernel is the topology authority: it validates the
    exact SI nodes and planes, preserves node order, uses every node, and proves
    positive cells plus exact slab coverage. This adapter assigns magnetic
    marker 1 and air marker 0 from whole-slab containment, then derives all
    exterior and magnetic-air facets from tetrahedron incidence. Repeated rows
    for one periodic pair require exact z ranges in periodic_patch_z_bounds; a
    single full-side row may omit them. It does not create periodic certificates,
    quality reports, or realization evidence. Kernel selection is explicit;
    errors are propagated without fallback or regenerating connectivity.
    """
    if not isinstance(tetrahedralization_method, str) or tetrahedralization_method not in (
        "freudenthal", "delaunay"
    ):
        raise ValueError("tetrahedralization_method must be 'freudenthal' or 'delaunay'")
    if tetrahedralization_method == "delaunay":
        from ._layered_box_delaunay import tetrahedralize_layered_box_delaunay

        cells = tetrahedralize_layered_box_delaunay(
            nodes, layer_planes, bounds_xy,
            periodic_boundary_pairs=periodic_boundary_pairs,
            periodic_node_pairs=periodic_node_pairs,
            periodic_patch_z_bounds=periodic_patch_z_bounds,
        )
    else:
        cells = tetrahedralize_layered_box(nodes, layer_planes, bounds_xy)
    coordinates = np.asarray(nodes, dtype=np.float64)
    planes = np.asarray(layer_planes, dtype=np.float64)
    raw_bounds = np.asarray(bounds_xy, dtype=np.float64)
    if raw_bounds.shape != (4,):
        raise ValueError("bounds_xy must contain xmin, xmax, ymin, ymax")
    normalized_bounds = tuple(float(value) for value in raw_bounds)
    z_bounds = (float(planes[0]), float(planes[-1]))

    outer_marker = _positive_integer(outer_boundary_marker, "outer_boundary_marker")
    if outer_marker == _INTERFACE_MARKER:
        raise ValueError("outer_boundary_marker must be distinct from interface marker 10")
    element_markers = _classify_cells(
        coordinates, planes, cells, magnetic_z_bounds
    )
    boundary_pairs, pair_by_id = _normalize_boundary_pairs(
        periodic_boundary_pairs,
        bounds_xy=normalized_bounds,
        planes=planes,
        outer_boundary_marker=outer_marker,
        periodic_patch_z_bounds=periodic_patch_z_bounds,
    )
    node_pairs, node_maps = _normalize_node_pairs(
        periodic_node_pairs,
        pair_by_id=pair_by_id,
        node_count=len(coordinates),
    )

    side_patches: dict[tuple[int, str], list[dict[str, object]]] = {}
    for pair in boundary_pairs:
        axis = int(pair["_axis"])
        side_patches.setdefault((axis, str(pair["_side_a"])), []).append(pair)
        side_patches.setdefault((axis, str(pair["_side_b"])), []).append(pair)

    incidence: dict[
        tuple[int, int, int], list[tuple[int, tuple[int, int, int]]]
    ] = {}
    for ordinal, cell in enumerate(cells):
        for omitted in range(4):
            oriented = _outward_face(cell, omitted)
            key = tuple(sorted(oriented))
            incidence.setdefault(key, []).append((ordinal, oriented))

    derived: list[tuple[tuple[int, int, int], str, int]] = []
    for key in sorted(incidence):
        owners = incidence[key]
        if len(owners) > 2:
            raise ValueError("tetrahedral face has more than two incident cells")
        if len(owners) == 2:
            owner_a, owner_b = owners
            marker_a = int(element_markers[owner_a[0]])
            marker_b = int(element_markers[owner_b[0]])
            if marker_a == marker_b:
                continue
            if {marker_a, marker_b} != {_MAGNETIC_MARKER, _AIR_MARKER}:
                raise ValueError("internal facet has unsupported region markers")
            magnetic_owner = owner_a if marker_a == _MAGNETIC_MARKER else owner_b
            derived.append((magnetic_owner[1], "material_interface", _INTERFACE_MARKER))
            continue

        face = owners[0][1]
        axis, side = _box_side(face, coordinates, normalized_bounds, z_bounds)
        matching_patches = side_patches.get((axis, side), [])
        if not matching_patches:
            derived.append((face, "exterior", outer_marker))
            continue

        face_z = coordinates[np.asarray(face, dtype=np.int64), 2]
        z_low = float(np.min(face_z))
        z_high = float(np.max(face_z))
        scoped_matches = [
            pair
            for pair in matching_patches
            if float(pair["_z_low"]) <= z_low and z_high <= float(pair["_z_high"])
        ]
        if len(scoped_matches) != 1:
            raise ValueError(
                f"periodic exterior facet on {axis=}, {side=} does not match exactly one z patch"
            )
        pair = scoped_matches[0]
        marker = int(pair["marker_a"] if side == pair["_side_a"] else pair["marker_b"])
        derived.append((face, "periodic_seam", marker))

    _validate_periodic_topology(
        nodes=coordinates,
        facets=derived,
        bounds_xy=normalized_bounds,
        boundary_pairs=boundary_pairs,
        node_maps=node_maps,
        node_pairs=node_pairs,
    )

    # ``derived`` is keyed by sorted node IDs above, while each stored face
    # retains its induced outward orientation (or magnetic-to-air orientation).
    derived_by_key = {tuple(sorted(face)): (face, role, marker) for face, role, marker in derived}
    if len(derived_by_key) != len(derived):
        raise ValueError("derived exterior/interface facets contain duplicates")
    ordered_facets = [derived_by_key[key] for key in sorted(derived_by_key)]
    facet_nodes = np.asarray([face for face, _role, _marker in ordered_facets], dtype=np.int32)
    facet_roles = np.asarray([role for _face, role, _marker in ordered_facets], dtype=np.str_)
    boundary_markers = np.asarray([marker for _face, _role, marker in ordered_facets], dtype=np.int32)

    return MeshData(
        nodes=coordinates,
        cell_types=np.full(len(cells), "tet4", dtype="<U4"),
        cell_offsets=np.arange(0, 4 * len(cells) + 1, 4, dtype=np.int64),
        cell_nodes=np.asarray(cells, dtype=np.int32).reshape(-1),
        element_markers=element_markers,
        facet_types=np.full(len(ordered_facets), "tri3", dtype="<U4"),
        facet_roles=facet_roles,
        facet_offsets=np.arange(0, 3 * len(ordered_facets) + 1, 3, dtype=np.int64),
        facet_nodes=facet_nodes.reshape(-1),
        boundary_markers=boundary_markers,
        cell_global_ordinals=np.arange(len(cells), dtype=np.int64),
        facet_global_ordinals=np.arange(len(ordered_facets), dtype=np.int64),
        periodic_boundary_pairs=[
            {
                key: value
                for key, value in pair.items()
                if not key.startswith("_")
            }
            for pair in boundary_pairs
        ],
        periodic_node_pairs=node_pairs,
    )
