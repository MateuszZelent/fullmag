"""Mass-weighted n=0 envelope diagnostics for a C1 Tet4 mode.

The public helper in this module is intentionally a small post-processing
primitive.  It does not solve an eigenproblem and it does not assign a
pass/fail threshold.  It evaluates a nodal P1 constant-envelope
projection on the explicitly selected magnetic Tet4 elements.

The field convention is the physical Bloch phasor

    d(r) = u(r) exp(-i k dot r).

Consequently the exported physical field is demodulated with
exp(+i k dot r) before the projection.  The element mass is the
consistent P1 Tet4 mass V/20 * (I + ones).  The nodal mean uses the
row-sum quadrature V/4; this is the row sum of that same local mass
matrix.

Air elements are never inferred from markers or coordinates.  The caller
must pass the explicit indices of magnetic elements.
"""

from __future__ import annotations

from typing import Any

import numpy as np


_SCHEMA_VERSION = "fullmag.comsol_n0_projection.v1"
_TET_NODE_COUNT = 4
_SPACE_DIMENSION = 3
_FIELD_COMPONENTS = 3
_MASS_DENOMINATOR = 20.0
_NODE_MEAN_DENOMINATOR = 4.0


def _as_real_array(value: Any, *, name: str, ndim: int | None = None) -> np.ndarray:
    """Convert a real numeric input and reject non-finite values."""

    raw = np.asarray(value)
    if raw.dtype.kind in "bSUO":
        raise ValueError(f"{name} must be a finite real numeric array")
    if np.iscomplexobj(raw):
        try:
            imaginary = np.asarray(raw.imag, dtype=np.float64)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError(f"{name} must be a finite real numeric array") from exc
        if imaginary.size and not np.all(np.isfinite(imaginary)):
            raise ValueError(f"{name} must be finite")
        if imaginary.size and np.any(imaginary != 0.0):
            raise ValueError(f"{name} must be real")
    try:
        array = np.asarray(value, dtype=np.float64)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{name} must be a finite real numeric array") from exc
    if ndim is not None and array.ndim != ndim:
        raise ValueError(f"{name} must have {ndim} dimensions")
    if not np.all(np.isfinite(array)):
        raise ValueError(f"{name} must be finite")
    return array


def _as_index_array(value: Any, *, name: str, allow_empty: bool = False) -> np.ndarray:
    """Convert an integer index array without silently truncating other types."""

    if any(isinstance(item, (bool, np.bool_)) for item in np.asarray(value, dtype=object).flat):
        raise ValueError(f"{name} must contain integer node or element ids")
    raw = np.asarray(value)
    if raw.ndim != 1:
        raise ValueError(f"{name} must be one-dimensional")
    if raw.dtype.kind == "b" or raw.dtype.kind not in "iu":
        raise ValueError(f"{name} must contain integer node or element ids")
    if raw.size == 0 and not allow_empty:
        raise ValueError(f"{name} must not be empty")
    if raw.dtype.kind == "u" and np.any(raw > np.iinfo(np.int64).max):
        raise ValueError(f"{name} contains an out-of-range integer id")
    try:
        return np.asarray(raw, dtype=np.int64)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{name} contains an out-of-range integer id") from exc


def _validate_mesh(
    nodes: Any,
    cells: Any,
    magnetic_element_indices: Any,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    coordinates = _as_real_array(nodes, name="nodes", ndim=2)
    if coordinates.shape[1] != _SPACE_DIMENSION:
        raise ValueError("nodes must have shape (node_count, 3)")
    if coordinates.shape[0] == 0:
        raise ValueError("nodes must not be empty")

    raw_cells = np.asarray(cells)
    if raw_cells.ndim != 2 or raw_cells.shape[1] != _TET_NODE_COUNT:
        raise ValueError("cells must have shape (element_count, 4)")
    cell_indices = _as_index_array(raw_cells.reshape(-1), name="cells").reshape(
        raw_cells.shape
    )
    if np.any(cell_indices < 0) or np.any(cell_indices >= coordinates.shape[0]):
        raise ValueError("cells contains a node id outside nodes")
    selected = _as_index_array(
        magnetic_element_indices, name="magnetic_element_indices"
    )
    if np.any(selected < 0) or np.any(selected >= cell_indices.shape[0]):
        raise ValueError("magnetic_element_indices contains an element id outside cells")
    if np.unique(selected).size != selected.size:
        raise ValueError("magnetic_element_indices contains duplicate element ids")

    selected_cells = cell_indices[selected]
    for local_index, connectivity in zip(selected, selected_cells, strict=True):
        if np.unique(connectivity).size != _TET_NODE_COUNT:
            raise ValueError(
                f"selected Tet4 element {int(local_index)} contains duplicate node ids"
            )
    return coordinates, cell_indices, selected


def _tet4_volume(coordinates: np.ndarray, connectivity: np.ndarray, element_id: int) -> float:
    points = coordinates[connectivity]
    edge_1 = points[1] - points[0]
    edge_2 = points[2] - points[0]
    edge_3 = points[3] - points[0]
    determinant = float(np.dot(np.cross(edge_1, edge_2), edge_3))
    if not np.isfinite(determinant):
        raise ValueError(f"selected Tet4 element {element_id} has a non-finite volume")
    volume = abs(determinant) / 6.0
    if not np.isfinite(volume) or volume <= 0.0:
        raise ValueError(f"selected Tet4 element {element_id} is degenerate")
    return volume


def _mass_inner_product(
    left: np.ndarray,
    right: np.ndarray,
    selected_cells: np.ndarray,
    scaled_volumes: np.ndarray,
) -> complex:
    """Evaluate left^H M right without assembling a dense global matrix."""

    result = 0.0 + 0.0j
    for connectivity, volume in zip(selected_cells, scaled_volumes, strict=True):
        left_local = left[connectivity]
        right_local = right[connectivity]
        result += (float(volume) / _MASS_DENOMINATOR) * (
            np.vdot(left_local, right_local)
            + np.vdot(left_local.sum(axis=0), right_local.sum(axis=0))
        )
    return result


def _real_mass_value(value: complex, *, name: str) -> float:
    """Return a real Hermitian quadratic form, rejecting numerical corruption."""

    real_value = float(np.real(value))
    imaginary_value = float(np.imag(value))
    if not np.isfinite(real_value) or not np.isfinite(imaginary_value):
        raise ValueError(f"{name} is non-finite")
    tolerance = 128.0 * np.finfo(np.float64).eps * max(1.0, abs(real_value))
    if abs(imaginary_value) > tolerance:
        raise ValueError(f"{name} is not real within floating-point tolerance")
    if real_value < 0.0:
        raise ValueError(f"{name} is negative")
    return real_value


def _metric_vector(value: np.ndarray) -> list[list[float]]:
    return [
        [float(component.real), float(component.imag)]
        for component in np.asarray(value, dtype=np.complex128)
    ]


def tet4_n0_projection(
    nodes: Any,
    cells: Any,
    magnetic_element_indices: Any,
    field: Any,
    k_vector: Any,
) -> dict[str, Any]:
    """Compute a mass-weighted constant-envelope diagnostic for a C1 mode.

    Parameters
    ----------
    nodes:
        Full mesh coordinates with shape (node_count, 3).
    cells:
        Full Tet4 connectivity with shape (element_count, 4).
    magnetic_element_indices:
        Explicit, unique row indices in cells belonging to the magnetic
        body.  Unselected cells are treated as air and do not contribute.
    field:
        Complex physical mode field in full node order, shape
        (node_count, 3). Each row is (x, y, z).
    k_vector:
        Real wave vector in inverse metres, shape (3,).

    Returns
    -------
    dict
        Dimensionless diagnostic metrics. projection_residual is the
        direct consistent-P1 mass norm of the demodulated transverse field
        minus its nodal mean, divided by the transverse mass norm. It is
        not obtained by subtracting two nearly equal norm ratios. The
        helper deliberately does not apply a threshold or return a pass
        status.

    Notes
    -----
    This is a discrete nodal P1 projection diagnostic. It does not claim to
    be an exact transform of an underlying continuous P1 function.
    """

    coordinates, all_cells, selected_indices = _validate_mesh(
        nodes, cells, magnetic_element_indices
    )

    raw_field = np.asarray(field)
    if raw_field.dtype.kind in "bSUO":
        raise ValueError("field must be a finite numeric array")
    try:
        complex_field = np.asarray(field, dtype=np.complex128)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("field must be a finite numeric array") from exc
    if complex_field.ndim != 2 or complex_field.shape != (
        coordinates.shape[0],
        _FIELD_COMPONENTS,
    ):
        raise ValueError("field must have shape (node_count, 3)")
    if not np.all(np.isfinite(complex_field)):
        raise ValueError("field must be finite")

    wave_vector = _as_real_array(k_vector, name="k_vector", ndim=1)
    if wave_vector.shape != (_SPACE_DIMENSION,):
        raise ValueError("k_vector must have shape (3,)")

    selected_cells = all_cells[selected_indices]
    volumes = np.asarray(
        [
            _tet4_volume(coordinates, connectivity, int(element_id))
            for element_id, connectivity in zip(
                selected_indices, selected_cells, strict=True
            )
        ],
        dtype=np.float64,
    )
    volume_scale = float(np.max(volumes))
    if not np.isfinite(volume_scale) or volume_scale <= 0.0:
        raise ValueError("selected Tet4 volumes must have a positive finite maximum")
    scaled_volumes = volumes / volume_scale

    support_nodes = np.unique(selected_cells.reshape(-1))
    support_field = complex_field[support_nodes]
    field_scale = float(np.max(np.abs(support_field)))
    if not np.isfinite(field_scale) or field_scale <= 0.0:
        raise ValueError("field is zero on the selected magnetic support")
    scaled_support_field = support_field / field_scale

    phase_argument = coordinates[support_nodes] @ wave_vector
    if not np.all(np.isfinite(phase_argument)):
        raise ValueError("k_vector dot magnetic node coordinates must be finite")
    demodulated_support_field = scaled_support_field * np.exp(
        1j * phase_argument
    )[:, np.newaxis]

    support_position = np.full(coordinates.shape[0], -1, dtype=np.int64)
    support_position[support_nodes] = np.arange(support_nodes.size, dtype=np.int64)
    local_cells = support_position[selected_cells]
    if np.any(local_cells < 0):
        raise ValueError("selected magnetic cells do not map to the magnetic support")

    nodal_weights = np.zeros(support_nodes.size, dtype=np.float64)
    for connectivity, volume in zip(local_cells, scaled_volumes, strict=True):
        np.add.at(
            nodal_weights,
            connectivity,
            float(volume) / _NODE_MEAN_DENOMINATOR,
        )
    total_nodal_weight = float(np.sum(nodal_weights))
    if not np.isfinite(total_nodal_weight) or total_nodal_weight <= 0.0:
        raise ValueError("selected magnetic Tet4 nodal weights are not positive")

    demodulated_mean = (
        np.sum(
            nodal_weights[:, np.newaxis] * demodulated_support_field,
            axis=0,
        )
        / total_nodal_weight
    )
    if not np.all(np.isfinite(demodulated_mean)):
        raise ValueError("demodulated magnetic field mean is non-finite")

    transverse = demodulated_support_field[:, 1:3]
    transverse_mean = demodulated_mean[1:3]
    transverse_residual = transverse - transverse_mean[np.newaxis, :]
    longitudinal = demodulated_support_field[:, 0:1]

    transverse_norm_sq = _real_mass_value(
        _mass_inner_product(transverse, transverse, local_cells, scaled_volumes),
        name="transverse mass norm",
    )
    if transverse_norm_sq <= 0.0:
        raise ValueError("transverse magnetic field is zero")
    residual_norm_sq = _real_mass_value(
        _mass_inner_product(
            transverse_residual,
            transverse_residual,
            local_cells,
            scaled_volumes,
        ),
        name="constant-envelope residual mass norm",
    )
    longitudinal_norm_sq = _real_mass_value(
        _mass_inner_product(longitudinal, longitudinal, local_cells, scaled_volumes),
        name="longitudinal mass norm",
    )
    total_norm_sq = transverse_norm_sq + longitudinal_norm_sq
    if not np.isfinite(total_norm_sq) or total_norm_sq <= 0.0:
        raise ValueError("magnetic field mass norm is zero")
    leakage_fraction = longitudinal_norm_sq / total_norm_sq
    projection_residual = residual_norm_sq / transverse_norm_sq

    for metric_name, metric_value in (
        ("projection_residual", projection_residual),
        ("longitudinal_leakage_fraction", leakage_fraction),
    ):
        if not np.isfinite(metric_value):
            raise ValueError(f"{metric_name} is non-finite")

    return {
        "schema_version": _SCHEMA_VERSION,
        "magnetic_element_count": int(selected_indices.size),
        "magnetic_node_count": int(support_nodes.size),
        "field_scale": field_scale,
        "volume_scale": volume_scale,
        "transverse_mass_norm_sq_scaled": transverse_norm_sq,
        "longitudinal_mass_norm_sq_scaled": longitudinal_norm_sq,
        "projection_residual": float(projection_residual),
        "projection_residual_l2": float(np.sqrt(projection_residual)),
        "longitudinal_leakage_fraction": float(leakage_fraction),
        "longitudinal_leakage_relative_l2": float(np.sqrt(leakage_fraction)),
        "mean_demodulated_xyz_scaled": _metric_vector(demodulated_mean),
        "mean_demodulated_transverse_yz_scaled": _metric_vector(transverse_mean),
        "normalization": "field_divided_by_max_abs_selected_magnetic_support",
        "mass_metric": "tet4_consistent_p1_v_over_20_i_plus_ones",
        "mean_metric": "tet4_lumped_row_sum_v_over_4",
        "field_convention": "physical_exp_minus_i_k_dot_r",
        "demodulation": "exp_plus_i_k_dot_r",
        "projection_space": "constant_nodal_p1_transverse_yz",
        "threshold": None,
    }


__all__ = ["tet4_n0_projection"]
