"""Small manufactured tests for the standalone Maxwell FEM reference."""

from functools import partial

import numpy as np
import pytest
from scipy.constants import c, epsilon_0, mu_0

from rf_fullwave_reference import assemble


def brick(subdivisions=1):
    axis = np.linspace(0.0, 1.0, subdivisions + 1)
    points = np.array(np.meshgrid(axis, axis, axis, indexing="ij")).reshape(3, -1).T
    ids = np.arange(len(points)).reshape((len(axis),) * 3)
    cells = []
    for i, j, k in np.ndindex((subdivisions,) * 3):
        a, b, c_, d, e, f, g, h = ids[i:i+2, j:j+2, k:k+2].ravel()
        cells.extend(((a,b,d,h), (a,b,f,h), (a,c_,d,h), (a,c_,g,h), (a,e,f,h), (a,e,g,h)))
    return points, np.asarray(cells)


def test_whitney_basis_reproduces_constant_electric_field():
    points, cells = brick()
    system = assemble(points, cells, 0.0, 1.0, 1e6)
    explicit_e = np.array([1.0, -2.0, 1j])
    edge_dofs = (points[system.edges[:, 1]] - points[system.edges[:, 0]]) @ explicit_e
    sample = points[cells].mean(axis=1)
    electric, magnetic = system.sample(edge_dofs, sample, np.arange(len(cells)))
    np.testing.assert_allclose(electric, np.broadcast_to(explicit_e, electric.shape), atol=1e-12)
    np.testing.assert_allclose(magnetic, 0, atol=1e-12)


def test_ece_conserves_current_and_power_in_dc_limit():
    points, cells = brick(2)
    system = assemble(points, cells, 10.0, 1.0, 1e3)
    terminals = {
        "drive": np.flatnonzero(points[:, 0] == 0),
        "return": np.flatnonzero(points[:, 0] == 1),
    }
    solved = system.solve_ece(terminals, {"drive": 1, "return": 0}, {})
    current = solved.terminal_currents_a["drive"]
    assert current.real == pytest.approx(10, rel=0.05)
    assert solved.terminal_currents_a["return"] == pytest.approx(-current, rel=1e-10)
    assert solved.power_joule_w == pytest.approx(current.real/2, rel=1e-10)
    assert solved.relative_residual < 1e-10
    terminals["load"] = np.flatnonzero((points[:, 1] == 0) & (points[:, 0] == 0.5))
    with pytest.raises(ValueError, match="surface"):
        system.solve_ece(terminals, {"drive": 1, "return": 0}, {"load": 50})


def test_ece_load_current_uses_inward_orientation():
    points, cells = brick(4)
    system = assemble(points, cells, 10.0, 1.0, 5e4)
    x, y, _ = points.T
    terminals = {
        "drive": np.flatnonzero(x == 0),
        "return": np.flatnonzero(x == 1),
        "load": np.flatnonzero((y == 0) & (x >= .25) & (x <= .75)),
    }
    load = 0.4 + .2j
    solved = system.solve_ece(terminals, {"drive": 1, "return": 0}, {"load": load})
    assert solved.terminal_currents_a["load"] == pytest.approx(
        -solved.terminal_voltages_v["load"]/load, rel=1e-9
    )
    assert abs(sum(solved.terminal_currents_a.values())) < 1e-9
    assert solved.power_joule_w == pytest.approx(solved.power_in_w, rel=1e-9)


def test_full_wave_reproduces_direction_of_manufactured_travelling_wave():
    points, cells = brick(5)
    frequency = 3e7
    omega = 2 * np.pi * frequency
    k = omega / c
    system = assemble(points, cells, 0.0, 1.0, frequency)
    edge = system.edges[system.boundary_edges]
    a, b = points[edge[:, 0]], points[edge[:, 1]]
    x0, x1 = a[:, 0], b[:, 0]
    # Exact peak field line integral in the ascending edge orientation.
    traces = (b[:, 1] - a[:, 1]) * np.exp(-1j*k*(x0+x1)/2) * np.sinc(k*(x1-x0)/(2*np.pi))
    electric_dofs = system.solve_tangential(traces)
    sample = points[cells].mean(axis=1)
    e, h = system.sample(electric_dofs, sample, np.arange(len(cells)))
    ey = np.exp(-1j*k*sample[:, 0])
    hz = k/(omega*mu_0) * ey
    assert np.linalg.norm(e[:, 1] - ey)/np.linalg.norm(ey) < 0.08
    assert np.linalg.norm(h[:, 2] - hz)/np.linalg.norm(hz) < 0.12


def test_reject_degenerate_tetrahedron():
    points, cells = brick()
    points[:, 2] = 0
    with pytest.raises(ValueError, match="degenerate"):
        assemble(points, cells, 0, 1, 1e6)


def test_ece_retains_dielectric_current_when_wavelength_is_much_larger_than_domain():
    points, cells = brick(2)
    length = 2e-6
    frequency = 2e6
    dielectric = 14.7
    system = assemble(points * length, cells, 0, dielectric, frequency)
    terminals = dict(drive=np.flatnonzero(points[:, 0] == 0),
                     ground=np.flatnonzero(points[:, 0] == 1))
    result = system.solve_ece(terminals, dict(drive=1, ground=0), {})
    expected = 1j * 2 * np.pi * frequency * epsilon_0 * dielectric * length
    assert result.terminal_currents_a["drive"] / expected == pytest.approx(1, rel=1e-5)
    assert result.terminal_currents_a["ground"] / expected == pytest.approx(-1, rel=1e-5)

@pytest.mark.parametrize("model", ["maxwell", "darwin"])
def test_floating_load_returns_current_through_tied_output_electrodes(model):
    from rf_darwin_reference import solve_darwin_ece

    points, cells = brick(6)
    system = assemble(points, cells, 10.0, 1.0, 5e4)
    x, y, _ = points.T
    end = x == 1
    terminals = {
        "drive": np.flatnonzero(x == 0),
        "ground": np.flatnonzero((y == 0) & (x >= 2/6) & (x <= 4/6)),
        "signal_out": np.flatnonzero(end & (y >= 2/6) & (y <= 4/6)),
        "left_out": np.flatnonzero(end & (y <= 1/6)),
        "right_out": np.flatnonzero(end & (y >= 5/6 - 1e-12)),
    }
    impedance = 0.4 + 0.2j
    branch = ("signal_out", ("left_out", "right_out"), impedance)
    solve = system.solve_ece if model == "maxwell" else partial(solve_darwin_ece, system)
    result = solve(terminals, {"drive": 1, "ground": 0}, {}, floating_load=branch)
    v, i = result.terminal_voltages_v, result.terminal_currents_a
    assert v["left_out"] == v["right_out"]
    assert abs(v["left_out"]) > 1e-3
    assert abs(i["right_out"]) > 1e-3
    resistor_current = (v["signal_out"] - v["left_out"]) / impedance
    assert abs(resistor_current) > 1e-3
    assert i["signal_out"] == pytest.approx(-resistor_current, abs=1e-9)
    assert i["left_out"] + i["right_out"] == pytest.approx(resistor_current, abs=1e-9)
    assert sum(i.values()) == pytest.approx(0, abs=1e-9)
    correction = result.power_mix_w if model == "darwin" else 0
    assert result.power_in_w == pytest.approx(result.power_joule_w + correction, rel=1e-9)

    with pytest.raises(ValueError, match="floating"):
        solve(terminals, {"drive": 1, "ground": 0}, {},
              floating_load=("signal_out", ("left_out", "left_out"), impedance))
