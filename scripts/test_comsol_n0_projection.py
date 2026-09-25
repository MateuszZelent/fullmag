"""Regression tests for the standalone C1 n=0 projection helper."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from comsol_n0_projection import tet4_n0_projection


def _mesh() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Two magnetic Tet4s with different volumes and one remote air Tet4."""

    nodes = np.asarray(
        [
            # Magnetic Tet4 0: volume 1/6.
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            # Magnetic Tet4 1: volume 1/3.
            [3.0, 0.0, 0.0],
            [4.0, 0.0, 0.0],
            [3.0, 2.0, 0.0],
            [3.0, 0.0, 1.0],
            # Remote air Tet4.
            [100.0, 100.0, 100.0],
            [101.0, 100.0, 100.0],
            [100.0, 101.0, 100.0],
            [100.0, 100.0, 101.0],
        ],
        dtype=np.float64,
    )
    cells = np.asarray(
        [
            [0, 1, 2, 3],
            [4, 5, 6, 7],
            [8, 9, 10, 11],
        ],
        dtype=np.int64,
    )
    return nodes, cells, np.asarray([0, 1], dtype=np.int64)


def _constant_physical_field(
    nodes: np.ndarray,
    k_vector: np.ndarray,
    envelope: np.ndarray | None = None,
) -> np.ndarray:
    if envelope is None:
        envelope = np.asarray([0.0, 1.0 + 0.25j, -0.35 + 0.1j], dtype=np.complex128)
    return np.exp(-1j * (nodes @ k_vector))[:, np.newaxis] * envelope[np.newaxis, :]


def test_constant_envelope_uses_consistent_tet4_mass_and_v_over_4_mean() -> None:
    nodes, cells, selected = _mesh()
    field = np.zeros((nodes.shape[0], 3), dtype=np.complex128)
    # Different constant transverse values on the two magnetic elements.
    field[:4, 1] = 1.0
    field[4:8, 2] = 1.0

    result = tet4_n0_projection(nodes, cells, selected, field, np.zeros(3))

    # V0=1/6 and V1=1/3, so the V/4 row-sum mean is (1/3, 2/3).
    # The field is constant inside each Tet4; therefore the consistent mass
    # norm reduces to V times the elementwise constant squared magnitude.
    assert result["projection_residual"] == pytest.approx(4.0 / 9.0)
    assert result["longitudinal_leakage_fraction"] == pytest.approx(0.0)
    assert result["mass_metric"] == "tet4_consistent_p1_v_over_20_i_plus_ones"
    assert result["mean_metric"] == "tet4_lumped_row_sum_v_over_4"


def test_correct_physical_bloch_phase_is_demodulated() -> None:
    nodes, cells, selected = _mesh()
    k_vector = np.asarray([0.37, -0.21, 0.43])
    field = _constant_physical_field(nodes, k_vector)

    result = tet4_n0_projection(nodes, cells, selected, field, k_vector)

    assert result["projection_residual"] == pytest.approx(0.0, abs=2e-30)
    assert result["longitudinal_leakage_fraction"] == pytest.approx(0.0)
    assert result["demodulation"] == "exp_plus_i_k_dot_r"
    assert result["threshold"] is None


def test_inverse_bloch_phase_is_detected_as_nonuniform() -> None:
    nodes, cells, selected = _mesh()
    k_vector = np.asarray([0.37, -0.21, 0.43])
    envelope = np.asarray([0.0, 1.0, 0.2j], dtype=np.complex128)
    inverse_phase_field = (
        np.exp(1j * (nodes @ k_vector))[:, np.newaxis] * envelope[np.newaxis, :]
    )

    result = tet4_n0_projection(
        nodes, cells, selected, inverse_phase_field, k_vector
    )

    assert result["projection_residual"] > 1.0e-4


@pytest.mark.parametrize("scale", [1.0e-100, 1.0e100])
def test_global_phase_and_extreme_field_scales_do_not_change_metrics(
    scale: float,
) -> None:
    nodes, cells, selected = _mesh()
    k_vector = np.asarray([0.13, 0.07, -0.19])
    base_field = _constant_physical_field(nodes, k_vector)
    phase = np.exp(0.731j)

    base = tet4_n0_projection(nodes, cells, selected, base_field, k_vector)
    scaled = tet4_n0_projection(
        nodes,
        cells,
        selected,
        base_field * phase * scale,
        k_vector,
    )

    assert scaled["projection_residual"] == pytest.approx(
        base["projection_residual"], abs=2e-30
    )
    assert scaled["longitudinal_leakage_fraction"] == pytest.approx(
        base["longitudinal_leakage_fraction"], abs=2e-30
    )


def test_nonconstant_thickness_envelope_has_nonzero_constant_projection_residual() -> None:
    nodes, cells, selected = _mesh()
    field = np.zeros((nodes.shape[0], 3), dtype=np.complex128)
    field[:, 1] = 1.0 + 0.4 * nodes[:, 2]
    field[:, 2] = 0.25

    result = tet4_n0_projection(nodes, cells, selected, field, np.zeros(3))

    assert result["projection_residual"] > 0.0
    assert result["projection_residual"] < 1.0


def test_air_nodes_with_large_field_are_not_included_in_scale_or_metric() -> None:
    nodes, cells, selected = _mesh()
    k_vector = np.asarray([0.22, -0.11, 0.09])
    magnetic_field = _constant_physical_field(nodes, k_vector)
    magnetic_field[8:] = 1.0e100 + 1.0e100j

    result = tet4_n0_projection(nodes, cells, selected, magnetic_field, k_vector)

    assert result["field_scale"] == pytest.approx(1.0307764064044151)
    assert result["projection_residual"] == pytest.approx(0.0, abs=2e-30)
    assert result["magnetic_node_count"] == 8


@pytest.mark.parametrize(
    ("mutator", "message"),
    [
        (lambda n, c, s, f, k: (n, c, [0, 0], f, k), "duplicate"),
        (
            lambda n, c, s, f, k: (
                n,
                c,
                s,
                np.full_like(f, np.nan),
                k,
            ),
            "field must be finite",
        ),
        (
            lambda n, c, s, f, k: (n, c, s, f, [0.0, np.inf, 0.0]),
            "k_vector must be finite",
        ),
        (
            lambda n, c, s, f, k: (
                n,
                np.asarray([[0, 1, 2, 2], [4, 5, 6, 7], [8, 9, 10, 11]]),
                s,
                f,
                k,
            ),
            "duplicate node ids",
        ),
        (
            lambda n, c, s, f, k: (
                n,
                c,
                s,
                f,
                k,
            ),
            "outside cells",
        ),
    ],
)
def test_rejects_malformed_inputs(mutator, message: str) -> None:
    nodes, cells, selected = _mesh()
    field = _constant_physical_field(nodes, np.zeros(3))
    k_vector = np.zeros(3)
    mutated = mutator(nodes, cells, selected, field, k_vector)

    if message == "outside cells":
        mutated = (
            nodes,
            cells,
            np.asarray([3]),
            field,
            k_vector,
        )

    with pytest.raises(ValueError, match=message):
        tet4_n0_projection(*mutated)


def test_rejects_degenerate_selected_tet4() -> None:
    nodes, cells, selected = _mesh()
    degenerate_cells = cells.copy()
    degenerate_cells[1] = [4, 5, 6, 6]
    field = _constant_physical_field(nodes, np.zeros(3))

    with pytest.raises(ValueError, match="duplicate node ids"):
        tet4_n0_projection(nodes, degenerate_cells, [1], field, np.zeros(3))


def test_rejects_zero_magnetic_field_and_zero_transverse_field() -> None:
    nodes, cells, selected = _mesh()

    with pytest.raises(ValueError, match="zero on the selected magnetic support"):
        tet4_n0_projection(
            nodes,
            cells,
            selected,
            np.zeros((nodes.shape[0], 3), dtype=np.complex128),
            np.zeros(3),
        )

    longitudinal_only = np.zeros((nodes.shape[0], 3), dtype=np.complex128)
    longitudinal_only[:, 0] = 1.0
    with pytest.raises(ValueError, match="transverse magnetic field is zero"):
        tet4_n0_projection(
            nodes,
            cells,
            selected,
            longitudinal_only,
            np.zeros(3),
        )


def test_rejects_out_of_range_and_non_integer_connectivity() -> None:
    nodes, cells, selected = _mesh()
    field = _constant_physical_field(nodes, np.zeros(3))

    out_of_range = cells.copy()
    out_of_range[0, 0] = nodes.shape[0]
    with pytest.raises(ValueError, match="outside nodes"):
        tet4_n0_projection(nodes, out_of_range, selected, field, np.zeros(3))

    non_integer = cells.astype(np.float64)
    non_integer[0, 0] = 0.5
    with pytest.raises(ValueError, match="integer"):
        tet4_n0_projection(nodes, non_integer, selected, field, np.zeros(3))
def test_consistent_mass_residual_differs_from_lumped_mass_for_single_tet() -> None:
    nodes, cells, _ = _mesh()
    field = np.zeros((nodes.shape[0], 3), dtype=np.complex128)
    # Single nonzero transverse nodal value on a Tet4.  The V/4 mean is 1/4.
    field[0, 1] = 1.0

    result = tet4_n0_projection(nodes, cells, [0], field, np.zeros(3))

    # Consistent V/20*(I+ones): residual/original = 3/8.
    # A diagonal V/4 lumped norm would incorrectly produce 3/4.
    assert result["projection_residual"] == pytest.approx(3.0 / 8.0)


def test_zero_mean_linear_thickness_profile_is_orthogonal_to_constant() -> None:
    nodes, cells, _ = _mesh()
    field = np.zeros((nodes.shape[0], 3), dtype=np.complex128)
    # On the standard Tet4, z - 1/4 has V/4 mean zero and eta=1.
    field[:4, 1] = nodes[:4, 2] - 0.25

    result = tet4_n0_projection(nodes, cells, [0], field, np.zeros(3))

    assert result["mean_demodulated_transverse_yz_scaled"][0] == pytest.approx(
        [0.0, 0.0]
    )
    assert result["projection_residual"] == pytest.approx(1.0)


@pytest.mark.parametrize("bad_indices", [[True], [True, 0], ["0"], [0.0]])
def test_rejects_bool_string_and_float_element_ids(bad_indices) -> None:
    nodes, cells, _ = _mesh()
    field = _constant_physical_field(nodes, np.zeros(3))

    with pytest.raises(ValueError, match="integer"):
        tet4_n0_projection(nodes, cells, bad_indices, field, np.zeros(3))


def test_rejects_non_numeric_real_arrays() -> None:
    nodes, cells, selected = _mesh()
    field = _constant_physical_field(nodes, np.zeros(3))

    with pytest.raises(ValueError, match="finite real numeric"):
        tet4_n0_projection(nodes.astype(bool), cells, selected, field, np.zeros(3))

    with pytest.raises(ValueError, match="finite numeric"):
        tet4_n0_projection(nodes, cells, selected, field.astype(str), np.zeros(3))


def test_rejects_geometrically_degenerate_tet4_with_distinct_nodes() -> None:
    nodes, cells, _ = _mesh()
    degenerate_nodes = nodes.copy()
    degenerate_nodes[4:8] = np.asarray(
        [
            [3.0, 0.0, 0.0],
            [4.0, 0.0, 0.0],
            [5.0, 0.0, 0.0],
            [3.0, 0.0, 1.0],
        ]
    )
    field = _constant_physical_field(degenerate_nodes, np.zeros(3))

    with pytest.raises(ValueError, match="degenerate"):
        tet4_n0_projection(
            degenerate_nodes,
            cells,
            [1],
            field,
            np.zeros(3),
        )
