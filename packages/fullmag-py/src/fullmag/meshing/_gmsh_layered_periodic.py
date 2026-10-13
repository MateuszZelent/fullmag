from __future__ import annotations

from collections.abc import Mapping, Sequence
import math
from numbers import Integral, Real
from typing import Any

import numpy as np


def _finite_real(value: object, name: str) -> float:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Real):
        raise TypeError(f"{name} must be a real number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _positive_integer(value: object, name: str) -> int:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Integral):
        raise TypeError(f"{name} must be an integer")
    result = int(value)
    if result <= 0:
        raise ValueError(f"{name} must be positive")
    return result


def _freeze_record(value: object) -> object:
    """Return a stable snapshot for detecting accidental input-record mutation."""
    if isinstance(value, Mapping):
        entries = [(_freeze_record(key), _freeze_record(item)) for key, item in value.items()]
        return ("mapping", tuple(sorted(entries, key=repr)))
    if isinstance(value, np.ndarray):
        return ("array", value.dtype.str, tuple(value.shape), value.tobytes())
    if isinstance(value, (list, tuple)):
        return ("sequence", tuple(_freeze_record(item) for item in value))
    if isinstance(value, np.generic):
        return _freeze_record(value.item())
    if isinstance(value, float):
        return ("float", value.hex())
    if isinstance(value, Real) and not isinstance(value, bool):
        return ("real", float(value).hex())
    if value is None or isinstance(value, (str, int, bool, bytes)):
        return (type(value).__qualname__, value)
    return (type(value).__qualname__, repr(value))


def _layer_planes(value: object) -> tuple[float, ...]:
    if isinstance(value, (str, bytes)):
        raise TypeError("layer_planes_si_m must be a one-dimensional sequence of real values")
    try:
        raw = list(value)  # type: ignore[arg-type]
    except TypeError as exc:
        raise TypeError(
            "layer_planes_si_m must be a one-dimensional sequence of real values"
        ) from exc
    if len(raw) < 2:
        raise ValueError("layer_planes_si_m must contain at least two planes")
    planes = tuple(
        _finite_real(item, f"layer_planes_si_m[{index}]")
        for index, item in enumerate(raw)
    )
    if any(left >= right for left, right in zip(planes, planes[1:])):
        raise ValueError("layer_planes_si_m must be strictly increasing")
    return planes


def _surface_z_bounds_si(
    gmsh: Any,
    surface_tag: int,
    *,
    gmsh_units_per_m: float,
) -> tuple[float, float]:
    try:
        node_tags, coordinates, _parametric = gmsh.model.mesh.getNodes(
            2,
            surface_tag,
            includeBoundary=True,
            returnParametricCoord=False,
        )
    except Exception as exc:
        raise ValueError(f"could not read Gmsh nodes for periodic surface {surface_tag}") from exc

    tags = np.asarray(node_tags)
    if tags.ndim != 1 or tags.size == 0:
        raise ValueError(f"periodic surface {surface_tag} has an empty node set")
    if np.iscomplexobj(tags) or not np.issubdtype(tags.dtype, np.integer):
        raise TypeError(f"periodic surface {surface_tag} returned invalid node tags")
    if np.any(tags <= 0) or len(set(int(tag) for tag in tags)) != int(tags.size):
        raise ValueError(f"periodic surface {surface_tag} returned invalid or duplicate node tags")

    if np.iscomplexobj(coordinates):
        raise TypeError(f"periodic surface {surface_tag} returned complex node coordinates")
    coords = np.asarray(coordinates, dtype=np.float64)
    if coords.ndim == 1:
        if coords.size != 3 * tags.size:
            raise ValueError(
                f"periodic surface {surface_tag} returned inconsistent node coordinates"
            )
        coords = coords.reshape((-1, 3))
    elif coords.shape != (tags.size, 3):
        raise ValueError(f"periodic surface {surface_tag} returned inconsistent node coordinates")
    if not np.all(np.isfinite(coords)):
        raise ValueError(f"periodic surface {surface_tag} returned non-finite coordinates")

    z_si = [float(value) / gmsh_units_per_m for value in coords[:, 2]]
    if not all(math.isfinite(value) for value in z_si):
        raise ValueError(f"periodic surface {surface_tag} z coordinates overflowed SI conversion")
    return min(z_si), max(z_si)


def periodic_patch_z_bounds_from_gmsh(
    gmsh: Any,
    periodic_surface_specs: Sequence[Mapping[str, object]],
    *,
    gmsh_units_per_m: float,
    layer_planes_si_m: Sequence[float],
) -> dict[tuple[str, int, int], tuple[float, float]]:
    """Derive exact adapter scopes from explicit Gmsh periodic surface provenance.

    ``gmsh_units_per_m`` is the same coordinate divisor used by mesh extraction to convert Gmsh node
    coordinates to SI. Surface-interior nodes may
    lie between authored planes; only each patch's min/max z endpoints must be
    exact authored planes. This helper reads surface tags from canonical specs,
    never edits those source records, and does not certify mesh topology.
    """
    scale = _finite_real(gmsh_units_per_m, "gmsh_units_per_m")
    if scale <= 0.0:
        raise ValueError("gmsh_units_per_m must be positive")
    planes = _layer_planes(layer_planes_si_m)
    if not isinstance(periodic_surface_specs, Sequence) or isinstance(
        periodic_surface_specs, (str, bytes)
    ):
        raise TypeError("periodic_surface_specs must be a sequence of mappings")
    if not periodic_surface_specs:
        return {}

    source_snapshot = _freeze_record(periodic_surface_specs)
    required = {
        "pair_id",
        "marker_a",
        "marker_b",
        "master_tag",
        "slave_tag",
        "axis_hint",
        "translation",
        "tolerance_m",
    }
    scopes: dict[tuple[str, int, int], tuple[float, float]] = {}
    surface_owners: dict[int, tuple[str, int, int]] = {}
    markers_seen: set[int] = set()
    authored_by_pair: dict[str, tuple[str, tuple[float, float, float], float]] = {}
    pair_id_by_axis: dict[str, str] = {}

    for index, raw_spec in enumerate(periodic_surface_specs):
        if not isinstance(raw_spec, Mapping):
            raise TypeError(f"periodic_surface_specs[{index}] must be a mapping")
        missing = required - set(raw_spec)
        if missing:
            raise ValueError(
                f"periodic_surface_specs[{index}] is missing fields {sorted(missing)}"
            )

        pair_id = raw_spec["pair_id"]
        if not isinstance(pair_id, str) or not pair_id or pair_id.strip() != pair_id:
            raise ValueError(
                f"periodic_surface_specs[{index}].pair_id must be a non-empty canonical string"
            )
        axis = raw_spec["axis_hint"]
        if axis not in ("x", "y"):
            raise ValueError(
                f"periodic_surface_specs[{index}] supports only lateral x/y periodic surfaces"
            )
        marker_a = _positive_integer(
            raw_spec["marker_a"], f"periodic_surface_specs[{index}].marker_a"
        )
        marker_b = _positive_integer(
            raw_spec["marker_b"], f"periodic_surface_specs[{index}].marker_b"
        )
        key = (pair_id, marker_a, marker_b)
        if key in scopes:
            raise ValueError(f"duplicate periodic surface spec key {key!r}")
        if marker_a == marker_b or marker_a in markers_seen or marker_b in markers_seen:
            raise ValueError(f"periodic_surface_specs[{index}] has duplicate or identical markers")
        markers_seen.update((marker_a, marker_b))
        master_tag = _positive_integer(
            raw_spec["master_tag"], f"periodic_surface_specs[{index}].master_tag"
        )
        slave_tag = _positive_integer(
            raw_spec["slave_tag"], f"periodic_surface_specs[{index}].slave_tag"
        )
        if master_tag == slave_tag:
            raise ValueError(f"periodic_surface_specs[{index}] master and slave tags must differ")

        translation_value = raw_spec["translation"]
        if (
            not isinstance(translation_value, (tuple, list, np.ndarray))
            or np.asarray(translation_value).shape != (3,)
        ):
            raise ValueError(
                f"periodic_surface_specs[{index}].translation must have three components"
            )
        translation = tuple(
            _finite_real(value, f"periodic_surface_specs[{index}].translation[{axis_index}]")
            for axis_index, value in enumerate(translation_value)
        )
        nonzero_axes = [
            axis_index for axis_index, value in enumerate(translation) if value != 0.0
        ]
        expected_axis = 0 if axis == "x" else 1
        if nonzero_axes != [expected_axis]:
            raise ValueError(
                f"periodic_surface_specs[{index}] axis_hint does not match its translation"
            )
        tolerance = _finite_real(
            raw_spec["tolerance_m"], f"periodic_surface_specs[{index}].tolerance_m"
        )
        if tolerance < 0.0:
            raise ValueError(f"periodic_surface_specs[{index}].tolerance_m must be nonnegative")

        for tag in (master_tag, slave_tag):
            owner = surface_owners.get(tag)
            if owner is not None:
                raise ValueError(f"periodic surface tag {tag} is used by more than one spec")
            surface_owners[tag] = key

        authored = (str(axis), translation, tolerance)
        previous_authored = authored_by_pair.get(pair_id)
        if previous_authored is not None and previous_authored != authored:
            raise ValueError(
                f"periodic pair {pair_id!r} has inconsistent authored periodic records"
            )
        authored_by_pair[pair_id] = authored
        previous_pair = pair_id_by_axis.get(str(axis))
        if previous_pair is not None and previous_pair != pair_id:
            raise ValueError(
                f"multiple logical periodic pair IDs are authored for axis {axis!r}"
            )
        pair_id_by_axis[str(axis)] = pair_id

        master_bounds = _surface_z_bounds_si(gmsh, master_tag, gmsh_units_per_m=scale)
        slave_bounds = _surface_z_bounds_si(gmsh, slave_tag, gmsh_units_per_m=scale)
        for label, surface_tag, bounds in (
            ("master", master_tag, master_bounds),
            ("slave", slave_tag, slave_bounds),
        ):
            low, high = bounds
            if low >= high:
                raise ValueError(
                    f"periodic {label} surface {surface_tag} has no positive z span"
                )
            if low not in planes or high not in planes:
                raise ValueError(
                    f"periodic {label} surface endpoints must equal exact authored layer planes"
                )
        if master_bounds != slave_bounds:
            raise ValueError(
                f"periodic master/slave surface z bounds differ for {key!r}: "
                f"{master_bounds!r} != {slave_bounds!r}"
            )
        scopes[key] = master_bounds

    intervals_by_pair: dict[str, list[tuple[float, float]]] = {}
    for (pair_id, _marker_a, _marker_b), bounds in scopes.items():
        intervals_by_pair.setdefault(pair_id, []).append(bounds)
    domain = (planes[0], planes[-1])
    for pair_id, intervals in intervals_by_pair.items():
        ordered = sorted(intervals)
        if ordered[0][0] != domain[0] or ordered[-1][1] != domain[1]:
            raise ValueError(f"periodic patches for {pair_id!r} do not cover the exact z domain")
        if any(left[1] != right[0] for left, right in zip(ordered, ordered[1:])):
            raise ValueError(f"periodic patches for {pair_id!r} contain a z gap or overlap")

    if _freeze_record(periodic_surface_specs) != source_snapshot:
        raise RuntimeError("periodic_surface_specs changed during z-scope derivation")
    return {key: scopes[key] for key in sorted(scopes)}
