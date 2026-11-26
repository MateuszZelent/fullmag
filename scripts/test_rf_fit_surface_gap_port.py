"""Analytic checks for the two-gap admittance and incident power stamp."""

import numpy as np
from numpy.testing import assert_allclose
import pytest

from rf_fit_reference import assemble


def reference():
    return assemble(([0., 1.], [0., 1., 2., 3., 4.], [0., .2, .5]), 0., 1., 1e9)


def test_nonuniform_rectangles_conserve_resistance_power_and_polarity():
    from rf_fit_surface_gap_port import GapPatch, GapPort, assemble_gap_ports

    fit = reference()
    patches = (GapPatch((0., 1.), (0., .5), +1), GapPatch((3., 4.), (0., .5), -1))
    port = GapPort(0., 50., patches, incident_power_w=2., phase_rad=np.pi / 3.)
    sheet, incident = assemble_gap_ports(fit, (port,))
    edge_points = fit.points_m[fit.edges]
    _, ey, ez = np.diff(edge_points, axis=1)[:, 0, :].T
    signed_test = ey * np.where(edge_points[:, :, 1].mean(axis=1) < 2., 1., -1.)
    assert_allclose(sheet.toarray(), sheet.toarray().T, rtol=0, atol=0)
    assert_allclose([ey @ (sheet @ ey), ez @ (sheet @ ez)], [1. / 50., 1. / 50.], rtol=1e-14)
    assert_allclose(ey @ incident, 0., atol=1e-15)
    assert_allclose(ez @ incident, 0., atol=1e-15)
    assert_allclose(signed_test @ incident, 2. * np.sqrt(2. * 50. * 2.) * np.exp(1j * np.pi / 3.) / 50.)
    first_edges = fit.edge_ids[1][0, 0, :]
    assert_allclose(sheet[first_edges][:, first_edges].toarray(),
                    np.array([[.4, .2, 0.], [.2, 1., .3], [0., .3, .6]]) / (6. * 50.))


def test_unexcited_load_keeps_admittance_and_disjoint_ports_accumulate():
    from rf_fit_surface_gap_port import GapPatch, GapPort, assemble_gap_ports

    fit = reference()
    patch = GapPatch((0., 1.), (0., .5), +1)
    inlet, outlet = GapPort(0., 50., (patch,), incident_power_w=1.), GapPort(1., 50., (patch,))
    in_matrix, inlet_source = assemble_gap_ports(fit, (inlet,))
    out_matrix, outlet_source = assemble_gap_ports(fit, (outlet,))
    combined, source = assemble_gap_ports(fit, (inlet, outlet))
    assert out_matrix.nnz > 0
    assert_allclose(outlet_source, 0., atol=0)
    assert_allclose(source, inlet_source, atol=0)
    assert (combined - in_matrix - out_matrix).nnz == 0


def test_patch_geometry_must_align_to_mesh_and_be_disjoint():
    from rf_fit_surface_gap_port import GapPatch, GapPort, assemble_gap_ports

    fit = reference()
    patch = GapPatch((0., 1.), (0., .5), +1)
    with pytest.raises(ValueError, match="overlap"):
        assemble_gap_ports(fit, (GapPort(0., 50., (patch, patch)),))
    nonconforming = GapPatch((.25, 1.), (0., .5), +1)
    with pytest.raises(ValueError, match="grid plane"):
        assemble_gap_ports(fit, (GapPort(0., 50., (nonconforming,)),))


@pytest.mark.parametrize("load_ratio", [1., 2.])
def test_tem_guide_recovers_known_voltage_phase_and_load_power(load_ratio):
    from scipy.constants import epsilon_0, mu_0
    from rf_fit_surface_gap_port import GapPatch, GapPort, assemble_gap_ports, solve_gap_ports

    frequency, length, height, width = 1e9, .15, .02, .03
    eta = np.sqrt(mu_0 / epsilon_0)
    resistance = eta * height / width
    axes = (np.linspace(0., length, 81), np.linspace(0., height, 4), np.linspace(0., width, 4))
    fit = assemble(axes, 0., 1., frequency)
    patch = GapPatch((0., height), (0., width), +1)
    ports = (GapPort(0., resistance, (patch,), incident_power_w=1.),
             GapPort(length, load_ratio * resistance, (patch,)))
    y = fit.points_m[fit.edges, 1]
    pec_edges = np.flatnonzero(np.all(y == 0., axis=1) | np.all(y == height, axis=1))
    solution = solve_gap_ports(fit, ports, pec_edges=pec_edges)
    field = solution.electric_edge_v
    assert solution.relative_residual < 1e-11
    assert_allclose(solution.power_source_w, solution.power_surface_w, rtol=1e-11)
    assert_allclose(solution.power_joule_w, 0., atol=0.)
    assert_allclose(field[pec_edges], 0., atol=0.)

    reflection = (load_ratio - 1.) / (load_ratio + 1.)
    load, _ = assemble_gap_ports(fit, ports[1:])
    assert_allclose(.5 * np.vdot(field, load @ field).real, 1. - reflection**2, rtol=1e-3)
    x = np.linspace(.011, .136, 11)
    samples = np.column_stack((x, np.full_like(x, height / 2.), np.full_like(x, width / 2.)))
    e, h = fit.sample(field, samples, curl_edge_v=field)
    k = 2. * np.pi * frequency * np.sqrt(mu_0 * epsilon_0)
    forward = np.sqrt(2. * resistance) / height * np.exp(-1j * k * x)
    backwards = reflection * forward * np.exp(-2j * k * (length - x))
    assert_allclose(e[:, 1], forward + backwards, rtol=2e-3)
    # H_z is a face flux divided by face area. Its axial observable is the
    # cell average rather than the continuum point field at an off-centre probe.
    ax = axes[0]
    cell = np.searchsorted(ax, x) - 1
    midpoint = (ax[cell] + ax[cell + 1]) / 2.
    dx = ax[cell + 1] - ax[cell]
    forward_mid = np.sqrt(2. * resistance) / height * np.exp(-1j * k * midpoint)
    backward_mid = reflection * forward_mid * np.exp(-2j * k * (length - midpoint))
    face_average = (forward_mid - backward_mid) * np.sinc(k * dx / (2. * np.pi)) / eta
    assert_allclose(h[:, 2], face_average, rtol=2e-3)
