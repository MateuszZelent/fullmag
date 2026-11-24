"""Analytical and conservation checks for the research-only Darwin operator."""

from itertools import permutations, product

import numpy as np
from scipy.constants import epsilon_0

from rf_darwin_reference import solve_darwin_ece
from rf_fullwave_reference import assemble


def brick(cells_per_axis, length_m):
    count = cells_per_axis + 1
    points = np.array(list(product(range(count), repeat=3)), dtype=float)
    points *= length_m / cells_per_axis
    tetrahedra = []
    for origin in product(range(cells_per_axis), repeat=3):
        for traversal in permutations(range(3)):
            vertex = np.array(origin)
            corners = [vertex.copy()]
            for axis in traversal:
                vertex[axis] += 1
                corners.append(vertex.copy())
            indices = np.ravel_multi_index(np.array(corners).T, (count,) * 3)
            if np.linalg.det(points[indices[1:]] - points[indices[0]]) < 0:
                indices[[2, 3]] = indices[[3, 2]]
            tetrahedra.append(indices)
    terminals = {
        "drive": np.flatnonzero(points[:, 0] == length_m),
        "ground": np.flatnonzero(points[:, 0] == 0.0),
    }
    return points, np.array(tetrahedra), terminals


def test_darwin_dielectric_brick_exposes_displacement_terminal_current():
    length_m = 0.1
    freq = 1.0e8
    points, cells, terminals = brick(2, length_m)
    # Two dielectric layers of equal length. All other boundaries have zero
    # normal total flux, the exact scalar potential is piecewise linear in x.
    right = points[cells].mean(axis=1)[:, 0] > length_m / 2.0
    epsilon_r = np.where(right, 6.0, 3.0)
    system = assemble(points, cells, np.zeros(len(cells)), epsilon_r, freq)
    result = solve_darwin_ece(system, terminals, {"drive": 1.0, "ground": 0.0}, {})
    capacitance = epsilon_0 * length_m ** 2 / ((length_m / 2) / 6 + (length_m / 2) / 3)
    expected = 1j * 2 * np.pi * freq * capacitance
    np.testing.assert_allclose(result.terminal_currents_a["drive"], expected, rtol=1e-10)
    np.testing.assert_allclose(result.terminal_currents_a["ground"], -expected, rtol=1e-10)
    np.testing.assert_allclose(result.scalar_potential_v[points[:, 0] == length_m / 2], 2 / 3)
    assert result.power_joule_w == 0.0
    assert result.relative_residual < 1e-10
    assert result.gauge_relative_residual < 1e-10
    assert result.gauge_force_relative_residual < 1e-10


def test_darwin_power_includes_mixed_displacement_term():
    length_m = 0.08
    points, cells, terminals = brick(2, length_m)
    centers = points[cells].mean(axis=1)
    conductivity = np.where(centers[:, 0] < length_m / 2, 0.08, 0.02)
    epsilon_r = np.where(centers[:, 1] < length_m / 2, 2.0, 12.0)
    system = assemble(points, cells, conductivity, epsilon_r, 6.0e8)
    result = solve_darwin_ece(system, terminals, {"drive": 1.0, "ground": 0.0}, {})
    assert result.power_joule_w > 0
    assert abs(result.power_mix_w) > 1e-8 * result.power_joule_w
    np.testing.assert_allclose(result.power_in_w, result.power_joule_w + result.power_mix_w,
                               rtol=2e-10, atol=1e-14)
    assert abs(sum(result.terminal_currents_a.values())) < 1e-12


def test_darwin_load_current_enters_domain_with_negative_sign():
    length_m = 0.24
    points, cells, terminals = brick(3, length_m)
    terminals["load"] = np.flatnonzero(
        (points[:, 1] == 0.0) & (points[:, 0] > 0.0)
        & (points[:, 0] < length_m) & (points[:, 2] < length_m / 2.0)
    )
    system = assemble(points, cells, np.full(len(cells), 0.02), np.ones(len(cells)), 2.0e7)
    impedance = 22.0 + 11.0j
    result = solve_darwin_ece(system, terminals, {"drive": 1.0, "ground": 0.0}, {"load": impedance})
    load_voltage = result.scalar_potential_v[terminals["load"]]
    np.testing.assert_allclose(load_voltage, load_voltage[0])
    assert abs(load_voltage[0]) > 1e-3
    np.testing.assert_allclose(result.terminal_voltages_v["load"], load_voltage[0])
    np.testing.assert_allclose(result.terminal_currents_a["load"], -load_voltage[0] / impedance,
                               rtol=1e-10)
    assert abs(sum(result.terminal_currents_a.values())) < 1e-12
    np.testing.assert_allclose(result.power_in_w, result.power_joule_w + result.power_mix_w,
                               rtol=2e-10, atol=1e-14)
