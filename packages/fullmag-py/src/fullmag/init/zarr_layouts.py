"""Structured Zarr field-state layouts.

``save_magnetization`` and ``save_field_state`` write row arrays ([N], [N, C],
[T, N, C]); ``state_io`` reads those directly.  This module decodes the grid
layouts that other writers use and flattens one frame to fullmag's FDM cell
order ``k = ix + nx * (iy + ny * iz)`` (x fastest, then y, then z), which is
also the OVF data order:

* MuMax3 and its Zarr forks, and fullmag's ``fullmag.output_store.v1``:
  ``[t, z, y, x, c]`` or one frame ``[z, y, x, c]``.  The mesh comes from the
  store attributes ``Nx Ny Nz``, ``dx dy dz`` and ``Tx Ty Tz``.
* fullmag's regular field series ``artifacts/fields/<q>.zarr``:
  ``[sample, component, cell]`` stored component-major, with the FDM grid in
  the ``layout`` attribute.

fullmag's stage-autosave arrays ``stages/stage_*/fields/<q>`` ([sample, value])
record neither their per-cell component order nor their grid, so they are
rejected with an explanation instead of being guessed.  Stage tables are not
field states.

The module also finds the state array of a store opened without ``dataset=``
and maps a path that points at an array to its store root.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

LAYOUT_ROWS = "rows"
LAYOUT_MUMAX3_TZYXC = "mumax3_tzyxc"
LAYOUT_MUMAX3_ZYXC = "mumax3_zyxc"
LAYOUT_FULLMAG_FIELD_SERIES = "fullmag_field_series"
LAYOUT_FULLMAG_STAGE_AUTOSAVE = "fullmag_stage_autosave"
LAYOUT_FULLMAG_TABLE = "fullmag_table"

_MUMAX3_DIMS = ["t", "z", "y", "x", "c"]
_SERIES_AXES = ["sample", "component", "cell"]
# Dataset names tried first when a Zarr store is opened without ``dataset=``.
_MAGNETIZATION_ZARR_DATASETS = ("values", "m", "magnetization", "fields/m")
_FIELD_ZARR_DATASETS = ("fields/m", "fields/H_eff", "values", "m", "magnetization")
# Relative tolerance between Tx and Nx * dx; both are written from the same
# float64 mesh, so a larger gap means the attributes describe another grid.
_EXTENT_REL_TOL = 1.0e-6


@dataclass(frozen=True, slots=True)
class StructuredZarrState:
    """One decoded frame: ``values`` is ``[N, C]`` float64 in solver cell order."""

    values: Any
    layout: str
    grid_shape: tuple[int, int, int] | None
    grid_spacing: tuple[float, float, float] | None
    grid_origin: tuple[float, float, float] | None
    origin_explicit: bool


def classify_zarr_state_layout(shape: tuple[int, ...], array_attrs: Mapping[str, Any]) -> str:
    """Name the layout of a Zarr array from its shape and its own attributes."""
    dimension_order = _string_list(array_attrs.get("dimension_order"))
    if dimension_order == ["sample", "value"]:
        return LAYOUT_FULLMAG_STAGE_AUTOSAVE
    if dimension_order == ["sample", "quantity"]:
        return LAYOUT_FULLMAG_TABLE
    if len(shape) == 3 and (
        _string_list(array_attrs.get("axes")) == _SERIES_AXES
        or array_attrs.get("storage_layout") == "soa_component_major"
    ):
        return LAYOUT_FULLMAG_FIELD_SERIES
    if len(shape) == 5:
        return LAYOUT_MUMAX3_TZYXC
    if len(shape) == 4:
        return LAYOUT_MUMAX3_ZYXC
    return LAYOUT_ROWS


def zarr_component_count(shape: tuple[int, ...], layout: str) -> int | None:
    """Component count of a structured layout, or ``None`` for other layouts."""
    if layout in {LAYOUT_MUMAX3_TZYXC, LAYOUT_MUMAX3_ZYXC}:
        return int(shape[-1])
    if layout == LAYOUT_FULLMAG_FIELD_SERIES:
        return int(shape[1])
    return None


def zarr_quantity_hint(array_attrs: Mapping[str, Any]) -> str | None:
    """Quantity name that fullmag writers record on the array itself."""
    nested = array_attrs.get("fullmag")
    candidates = [
        nested.get("quantity_id") if isinstance(nested, Mapping) else None,
        array_attrs.get("observable"),
        array_attrs.get("quantity"),
    ]
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def read_structured_zarr_state(
    array: Any,
    *,
    array_attrs: Mapping[str, Any],
    store_attrs: Mapping[str, Any],
    sample: int,
    label: str,
) -> StructuredZarrState:
    """Decode one frame of a structured Zarr array (see the module docstring).

    ``array`` needs ``shape`` and NumPy-style indexing; only the selected frame
    is read.  ``sample`` indexes the time/sample axis, a negative value selects
    the last frame.  Raises ``ValueError`` for layouts that cannot be decoded
    unambiguously and ``IndexError`` for an out-of-range sample.
    """
    shape = tuple(int(extent) for extent in array.shape)
    layout = classify_zarr_state_layout(shape, array_attrs)
    if layout == LAYOUT_FULLMAG_STAGE_AUTOSAVE:
        raise ValueError(
            f"Zarr dataset '{label}' is a fullmag stage-autosave array [sample, value] "
            f"with shape {shape}; it records neither the per-cell component order "
            "(interleaved x,y,z for host snapshots, component-major for native "
            "GPU/FEM snapshots) nor the grid, so it cannot be loaded as a state. "
            "Load the run's artifacts/fields/<quantity>.zarr series instead, or "
            "write the state with fullmag.save_field_state()"
        )
    if layout == LAYOUT_FULLMAG_TABLE:
        raise ValueError(
            f"Zarr dataset '{label}' is a fullmag scalar table [sample, quantity], not a field state"
        )
    if layout in {LAYOUT_MUMAX3_TZYXC, LAYOUT_MUMAX3_ZYXC}:
        return _read_mumax3(array, shape, layout, array_attrs, store_attrs, sample, label)
    if layout == LAYOUT_FULLMAG_FIELD_SERIES:
        return _read_field_series(array, shape, array_attrs, sample, label)
    raise ValueError(f"Zarr dataset '{label}' with shape {shape} is not a structured grid layout")


def _read_mumax3(
    array: Any,
    shape: tuple[int, ...],
    layout: str,
    array_attrs: Mapping[str, Any],
    store_attrs: Mapping[str, Any],
    sample: int,
    label: str,
) -> StructuredZarrState:
    np = _numpy()
    has_time = layout == LAYOUT_MUMAX3_TZYXC
    dims = _MUMAX3_DIMS if has_time else _MUMAX3_DIMS[1:]
    components = shape[-1]
    if components not in (1, 3):
        raise ValueError(
            f"Zarr dataset '{label}' with shape {shape} is read as the MuMax3 layout "
            f"[{', '.join(dims)}]; its last (component) axis must have 1 or 3 entries, got {components}"
        )
    nested = array_attrs.get("fullmag")
    declared_dims = _string_list(nested.get("dims")) if isinstance(nested, Mapping) else None
    if declared_dims is not None and declared_dims != dims:
        raise ValueError(
            f"Zarr dataset '{label}' declares dims {declared_dims}, expected {dims} for shape {shape}"
        )
    _check_component_order(array_attrs, components, label)
    nz, ny, nx = shape[-4], shape[-3], shape[-2]
    if min(nx, ny, nz) <= 0:
        raise ValueError(f"Zarr dataset '{label}' has an empty grid, shape {shape}")

    attrs = {**store_attrs, **array_attrs}
    grid_shape = (nx, ny, nz)
    _check_declared_grid(attrs, grid_shape, shape, label)
    spacing = _mumax3_spacing(attrs, grid_shape, label)
    origin = _optional_vec3(attrs, ("grid_origin", "origin"), label)

    if has_time:
        frame = array[_frame_index(sample, shape[0], label)]
    else:
        if sample > 0:
            raise IndexError(
                f"Zarr dataset '{label}' has no time axis (shape {shape}); sample must be -1 or 0, got {sample}"
            )
        frame = array[...]
    # C order of [z, y, x, c] gives k = ix + nx * (iy + ny * iz): x fastest.
    values = np.ascontiguousarray(np.asarray(frame, dtype=np.float64)).reshape(
        (nx * ny * nz, components)
    )
    _require_finite(values, label)
    return StructuredZarrState(
        values=values,
        layout=layout,
        grid_shape=grid_shape,
        grid_spacing=spacing,
        grid_origin=origin if origin is not None else ((0.0, 0.0, 0.0) if spacing else None),
        origin_explicit=origin is not None,
    )


def _read_field_series(
    array: Any,
    shape: tuple[int, ...],
    array_attrs: Mapping[str, Any],
    sample: int,
    label: str,
) -> StructuredZarrState:
    np = _numpy()
    sample_count, components, cells = shape
    if components not in (1, 3):
        raise ValueError(
            f"Zarr dataset '{label}' is a fullmag field series [sample, component, cell]; "
            f"its component axis must have 1 or 3 entries, got {components}"
        )
    _check_component_order(array_attrs, components, label)
    if sample_count == 0:
        raise ValueError(
            f"Zarr dataset '{label}' is a fullmag field series with no published samples (shape {shape})"
        )
    frame = np.asarray(array[_frame_index(sample, sample_count, label)], dtype=np.float64)
    values = np.ascontiguousarray(frame.T)
    _require_finite(values, label)

    grid_shape: tuple[int, int, int] | None = None
    spacing: tuple[float, float, float] | None = None
    origin: tuple[float, float, float] | None = None
    layout = array_attrs.get("layout")
    if isinstance(layout, Mapping) and "fdm" in {layout.get("backend"), layout.get("kind")}:
        raw_grid = layout.get("grid_cells", layout.get("grid"))
        if raw_grid is not None:
            grid_shape = _grid3(raw_grid, f"{label} layout.grid_cells")
            if grid_shape[0] * grid_shape[1] * grid_shape[2] != cells:
                raise ValueError(
                    f"Zarr dataset '{label}' layout grid {grid_shape} does not match its {cells} cells"
                )
            spacing = _optional_vec3(layout, ("cell_size",), label, positive=True)
            origin = _optional_vec3(layout, ("origin_m",), label)
    return StructuredZarrState(
        values=values,
        layout=LAYOUT_FULLMAG_FIELD_SERIES,
        grid_shape=grid_shape,
        grid_spacing=spacing,
        grid_origin=origin if origin is not None else ((0.0, 0.0, 0.0) if spacing else None),
        origin_explicit=origin is not None,
    )


def attrs_to_dict(attrs: Any) -> dict[str, Any]:
    """Copy Zarr/HDF5 attributes into plain Python values (NumPy scalars, bytes decoded)."""
    plain: dict[str, Any] = {}
    for key in attrs:
        value = attrs[key]
        if hasattr(value, "item"):
            try:
                value = value.item()
            except Exception:
                pass
        if isinstance(value, bytes):
            value = value.decode("utf-8")
        plain[str(key)] = value
    return plain


def find_zarr_state_dataset(root: Any, path: Path, *, vector_only: bool) -> str | None:
    """Pick the state array of a Zarr store opened without ``dataset=``.

    A root array is used as is.  Otherwise the preferred names come first, then
    the arrays found in the store: exactly one array with a component axis is
    used, several raise (pass ``dataset=``), and a 1-D array is the last resort
    as before, unless the store holds grid arrays (then 1-D arrays are scalar
    series, not states).  Arrays under a ``table`` group (MuMax3 and fullmag
    tables) are never candidates; a fullmag stage-autosave array is returned
    only when nothing else exists, so that the reader explains why it cannot be
    loaded.  Only shapes and attributes are read here, never array data.
    """
    if hasattr(root, "shape"):
        return ""

    preferred = _MAGNETIZATION_ZARR_DATASETS if vector_only else _FIELD_ZARR_DATASETS
    for candidate in preferred:
        try:
            target = root[candidate]
        except Exception:
            continue
        if not hasattr(target, "shape"):
            continue
        if not vector_only or _zarr_state_candidate(target, vector_only=True) is not None:
            return candidate

    found: dict[str, list[str]] = {"grid": [], "flat": [], "stage": []}
    structured_seen = False

    def visitor(name: str, obj: Any) -> None:
        nonlocal structured_seen
        if not hasattr(obj, "shape") or "table" in name.split("/")[:-1]:
            return
        shape = tuple(int(extent) for extent in obj.shape)
        layout = classify_zarr_state_layout(shape, attrs_to_dict(getattr(obj, "attrs", {})))
        structured_seen = structured_seen or zarr_component_count(shape, layout) is not None
        kind = _zarr_state_candidate(obj, vector_only=vector_only)
        if kind is not None:
            found[kind].append(name)

    if hasattr(root, "visititems"):
        root.visititems(visitor)
    if structured_seen:
        found["flat"].clear()
    if len(found["grid"]) > 1:
        raise ValueError(
            f"{path} contains several candidate state arrays {found['grid']}; pass dataset= to choose one"
        )
    for kind in ("grid", "flat", "stage"):
        if found[kind]:
            return found[kind][0]
    return None


def _zarr_state_candidate(array: Any, *, vector_only: bool) -> str | None:
    """Classify a Zarr array for discovery: ``grid``, ``flat``, ``stage`` or ``None``."""
    shape = tuple(int(extent) for extent in array.shape)
    attrs = attrs_to_dict(getattr(array, "attrs", {}))
    layout = classify_zarr_state_layout(shape, attrs)
    if layout == LAYOUT_FULLMAG_TABLE:
        return None
    if layout == LAYOUT_FULLMAG_STAGE_AUTOSAVE:
        return "stage"
    components = zarr_component_count(shape, layout)
    if components is not None:
        return "grid" if components == 3 or (components == 1 and not vector_only) else None
    if len(shape) == 1:
        return "flat" if not vector_only or shape[0] % 3 == 0 else None
    if len(shape) in (2, 3):
        return "grid" if (shape[-1] == 3 if vector_only else shape[-1] > 0) else None
    return None


def zarr_node_kind(directory: Path) -> str | None:
    """Return ``array`` or ``group`` for a Zarr v2/v3 directory node, else ``None``."""
    if (directory / ".zarray").is_file():
        return "array"
    if (directory / ".zgroup").is_file():
        return "group"
    metadata_path = directory / "zarr.json"
    if metadata_path.is_file():
        try:
            node_type = json.loads(metadata_path.read_text(encoding="utf-8")).get("node_type")
        except (OSError, ValueError, AttributeError):
            return None
        return node_type if node_type in {"array", "group"} else None
    return None


def split_zarr_array_path(path: Path) -> tuple[Path, str | None]:
    """Map a path to an array inside a directory store to ``(store root, array path)``.

    Returns ``(path, None)`` when ``path`` is not an array directory.  The store
    root is the outermost enclosing Zarr group, so its attributes (for example
    MuMax3's mesh ``Nx``..``dz``) stay available; a standalone array store gives
    an empty array path.
    """
    if path.name.lower().endswith(".zip") or not path.is_dir() or zarr_node_kind(path) != "array":
        return path, None
    root = path
    parts: list[str] = []
    while root.parent != root and zarr_node_kind(root.parent) == "group":
        parts.insert(0, root.name)
        root = root.parent
    return root, "/".join(parts)


def _check_declared_grid(
    attrs: Mapping[str, Any],
    grid_shape: tuple[int, int, int],
    shape: tuple[int, ...],
    label: str,
) -> None:
    for axis, key in enumerate(("Nx", "Ny", "Nz")):
        if key not in attrs:
            continue
        declared = _integer(attrs[key], key, label)
        if declared != grid_shape[axis]:
            raise ValueError(
                f"Zarr dataset '{label}' shape {shape} gives (Nx, Ny, Nz)={grid_shape}, "
                f"but the store declares {key}={declared}; the array axes are not [.., z, y, x, c]"
            )
    if attrs.get("grid_shape") is not None:
        declared_shape = _grid3(attrs["grid_shape"], f"{label} grid_shape")
        if declared_shape != grid_shape:
            raise ValueError(
                f"Zarr dataset '{label}' shape {shape} gives grid {grid_shape}, "
                f"but grid_shape={declared_shape}"
            )


def _mumax3_spacing(
    attrs: Mapping[str, Any],
    grid_shape: tuple[int, int, int],
    label: str,
) -> tuple[float, float, float] | None:
    cell = _keyed_positive_vec3(attrs, ("dx", "dy", "dz"), label)
    if cell is None:
        cell = _optional_vec3(attrs, ("grid_spacing", "spacing"), label, positive=True)
    extent = _keyed_positive_vec3(attrs, ("Tx", "Ty", "Tz"), label)
    if extent is None:
        return cell
    if cell is None:
        return (
            extent[0] / grid_shape[0],
            extent[1] / grid_shape[1],
            extent[2] / grid_shape[2],
        )
    for axis, name in enumerate("xyz"):
        expected = grid_shape[axis] * cell[axis]
        if not math.isclose(extent[axis], expected, rel_tol=_EXTENT_REL_TOL):
            raise ValueError(
                f"Zarr dataset '{label}': T{name}={extent[axis]!r} m does not equal "
                f"N{name} * d{name} = {grid_shape[axis]} * {cell[axis]!r} m"
            )
    return cell


def _keyed_positive_vec3(
    attrs: Mapping[str, Any],
    keys: tuple[str, str, str],
    label: str,
) -> tuple[float, float, float] | None:
    if not all(key in attrs for key in keys):
        return None
    values = tuple(_finite_float(attrs[key], key, label) for key in keys)
    for key, value in zip(keys, values):
        if value <= 0.0:
            raise ValueError(f"Zarr dataset '{label}': {key} must be positive, got {value!r}")
    return values  # type: ignore[return-value]


def _optional_vec3(
    attrs: Mapping[str, Any],
    keys: tuple[str, ...],
    label: str,
    *,
    positive: bool = False,
) -> tuple[float, float, float] | None:
    for key in keys:
        raw = attrs.get(key)
        if raw is None:
            continue
        if hasattr(raw, "tolist"):
            raw = raw.tolist()
        if not isinstance(raw, (list, tuple)) or len(raw) != 3:
            raise ValueError(f"Zarr dataset '{label}': {key} must be a 3-vector, got {raw!r}")
        values = tuple(_finite_float(component, key, label) for component in raw)
        if positive and any(value <= 0.0 for value in values):
            raise ValueError(f"Zarr dataset '{label}': {key} must be positive, got {values!r}")
        return values  # type: ignore[return-value]
    return None


def _check_component_order(attrs: Mapping[str, Any], components: int, label: str) -> None:
    if components != 3:
        return
    nested = attrs.get("fullmag")
    for raw in (
        attrs.get("component_order"),
        nested.get("components") if isinstance(nested, Mapping) else None,
    ):
        if raw is None:
            continue
        order = [raw.lower()] if isinstance(raw, str) else _string_list(raw)
        if order not in (["x", "y", "z"], ["xyz"]):
            raise ValueError(
                f"Zarr dataset '{label}' stores components in order {raw!r}; only x, y, z is supported"
            )


def _frame_index(sample: int, count: int, label: str) -> int:
    if count <= 0:
        raise ValueError(f"Zarr dataset '{label}' contains no frames")
    index = sample if sample >= 0 else count - 1
    if index >= count:
        raise IndexError(f"sample index {sample} is out of range for {count} samples")
    return index


def _grid3(raw: Any, label: str) -> tuple[int, int, int]:
    if hasattr(raw, "tolist"):
        raw = raw.tolist()
    if not isinstance(raw, (list, tuple)) or len(raw) != 3:
        raise ValueError(f"{label} must list three cell counts, got {raw!r}")
    dims = tuple(_integer(value, "grid", label) for value in raw)
    if any(dim <= 0 for dim in dims):
        raise ValueError(f"{label} must contain positive cell counts, got {dims!r}")
    return dims  # type: ignore[return-value]


def _integer(raw: Any, key: str, label: str) -> int:
    value = _finite_float(raw, key, label)
    if not value.is_integer():
        raise ValueError(f"Zarr dataset '{label}': {key} must be an integer, got {raw!r}")
    return int(value)


def _finite_float(raw: Any, key: str, label: str) -> float:
    if hasattr(raw, "item"):
        raw = raw.item()
    if isinstance(raw, bool):
        raise ValueError(f"Zarr dataset '{label}': {key} must be a number, got {raw!r}")
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Zarr dataset '{label}': {key} must be a number, got {raw!r}") from exc
    if not math.isfinite(value):
        raise ValueError(f"Zarr dataset '{label}': {key} must be finite, got {raw!r}")
    return value


def _string_list(raw: Any) -> list[str] | None:
    if hasattr(raw, "tolist"):
        raw = raw.tolist()
    if isinstance(raw, (list, tuple)) and all(isinstance(item, str) for item in raw):
        return [item.lower() for item in raw]
    return None


def _require_finite(values: Any, label: str) -> None:
    np = _numpy()
    if not np.all(np.isfinite(values)):
        raise ValueError(f"Zarr dataset '{label}' contains non-finite field values")


def _numpy() -> Any:
    import numpy as np

    return np
