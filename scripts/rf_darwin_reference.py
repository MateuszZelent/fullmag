"""Harmonic A-phi Darwin ECE comparison operator for linear tetrahedra.

Uses the same edge basis, terminal surfaces and material operators as the
frequency-domain Maxwell reference. This is a research comparison only.
"""

from dataclasses import dataclass

import numpy as np
from scipy import sparse
from scipy.sparse.linalg import splu

from rf_fullwave_reference import gradient_incidence, terminal_trace


@dataclass(frozen=True)
class DarwinSolution:
    electric_edge_v: np.ndarray
    curl_edge_v: np.ndarray
    scalar_potential_v: np.ndarray
    terminal_currents_a: dict[str, complex]
    terminal_voltages_v: dict[str, complex]
    relative_residual: float
    gauge_relative_residual: float
    gauge_force_relative_residual: float
    power_in_w: float
    power_joule_w: float
    power_mix_w: float


def _vertex_selection(vertex_count, selected):
    return sparse.csr_matrix(
        (np.ones(len(selected)), (selected, np.arange(len(selected)))),
        shape=(vertex_count, len(selected)),
    )


def _scaled_solve(matrix, rhs):
    # The Ampere, continuity and gauge equations carry different units.
    # Sparse diagonal equilibration changes the linear coordinates only.
    row_norm = np.asarray(abs(matrix).sum(axis=1)).ravel()
    if np.any(~np.isfinite(row_norm) | (row_norm <= 0)):
        raise ValueError("Darwin system contains a missing or invalid equation")
    row_scale = 1.0 / row_norm
    scaled_rows = matrix.multiply(row_scale[:, None]).tocsr()
    column_norm = np.asarray(abs(scaled_rows).sum(axis=0)).ravel()
    if np.any(~np.isfinite(column_norm) | (column_norm <= 0)):
        raise ValueError("Darwin system contains an unconstrained unknown")
    column_scale = 1.0 / column_norm
    scaled_matrix = scaled_rows.multiply(column_scale[None, :]).tocsc()
    result = column_scale * splu(scaled_matrix).solve(row_scale * rhs)
    if not np.all(np.isfinite(result)):
        raise ValueError("non-finite Darwin solution")
    residual = matrix @ result - rhs
    scale = abs(matrix) @ np.abs(result) + np.abs(rhs)
    return result, _relative_residual(residual, scale)


def _relative_residual(residual, scale):
    if len(residual) == 0:
        return 0.0
    absolute = np.abs(residual)
    if np.any(~np.isfinite(absolute) | ~np.isfinite(scale)):
        raise ValueError("non-finite Darwin residual")
    # Each row has a scale in its own units, including the gauge rows.
    return float(np.max(np.divide(absolute, scale, out=absolute.copy(), where=scale > 0)))


def solve_darwin_ece(system, terminals, voltages_v, loads_ohm):
    """Solve with peak phasors, exp(+i omega t) and currents into the domain."""
    vertex_count = len(system.points_m)
    trace = terminal_trace(
        vertex_count, system.edges, system.boundary_faces,
        terminals, voltages_v, loads_ohm,
    )
    boundary_vertices = np.unique(system.boundary_faces)
    inside_vertices = np.setdiff1d(np.arange(vertex_count), boundary_vertices)
    interior_selection = _vertex_selection(vertex_count, inside_vertices)
    p_map = sparse.hstack((trace.potential_map, interior_selection), format="csr")
    grad = gradient_incidence(vertex_count, system.edges)
    grad_free = (grad @ p_map).tocsr()
    grad_lift = grad @ trace.potential_lift_v
    grad_test = (grad @ interior_selection).tocsr()
    inside_edges = trace.interior_edges
    edge_count = len(inside_edges)
    potential_count = p_map.shape[1]
    gauge_count = len(inside_vertices)
    frequency_factor = 1j * system.omega

    # u = i omega A in voltage edge coordinates. The electric field has
    # edge coefficients -u - grad(phi). Multiplying the continuity equation
    # by i omega is only a row scaling and preserves all port reactions.
    complex_conductance = system.sigma_matrix + frequency_factor * system.epsilon_matrix
    sigma_inside = system.sigma_matrix[:, inside_edges]
    potential_flux = complex_conductance @ grad_free
    lift_flux = complex_conductance @ grad_lift
    curl_inside = system.curl_matrix[inside_edges, :][:, inside_edges]
    gauge = (system.mass_matrix @ grad_test)[inside_edges, :]
    load_stamp = np.zeros(potential_count, dtype=complex)
    for name, column in trace.load_columns.items():
        load_stamp[column] += 1.0 / loads_ohm[name]

    continuity = grad_free.T @ potential_flux
    if trace.load_columns:
        continuity += sparse.diags(load_stamp, format="csr")
    mixed_matrix = sparse.bmat(
        [
            [curl_inside + frequency_factor * sigma_inside[inside_edges, :],
             frequency_factor * potential_flux[inside_edges, :], gauge],
            [frequency_factor * (grad_free.T @ sigma_inside),
             frequency_factor * continuity,
             sparse.csr_matrix((potential_count, gauge_count))],
            [gauge.T, sparse.csr_matrix((gauge_count, potential_count)),
             sparse.csr_matrix((gauge_count, gauge_count))],
        ],
        format="csr",
    )
    rhs = -frequency_factor * np.concatenate(
        (lift_flux[inside_edges], grad_free.T @ lift_flux, np.zeros(gauge_count))
    )
    solution, residual = _scaled_solve(mixed_matrix, rhs)
    u_inside = solution[:edge_count]
    phi = trace.potential_lift_v + p_map @ solution[edge_count:edge_count + potential_count]
    grad_phi = grad @ phi
    u = np.zeros(len(system.edges), dtype=complex)
    u[inside_edges] = u_inside

    flux = system.sigma_matrix @ u + complex_conductance @ grad_phi
    # F = -J_total in the documented sign convention. Integration against a
    # terminal's nodal indicator yields current entering the domain.
    reactions = grad.T @ flux
    currents = {name: complex(np.sum(reactions[nodes]))
                for name, nodes in trace.terminal_nodes.items()}
    voltages = {name: complex(phi[nodes[0]]) for name, nodes in trace.terminal_nodes.items()}
    power_in = 0.5 * sum(voltages[name] * current.conjugate()
                         for name, current in currents.items()).real
    electric_edge = -u - grad_phi
    joule = 0.5 * np.vdot(electric_edge, system.sigma_matrix @ electric_edge).real
    mix = 0.5 * system.omega * np.vdot(grad_phi, system.epsilon_matrix @ u).imag

    gauge_relative_residual = _relative_residual(
        gauge.T @ u_inside, abs(gauge.T) @ np.abs(u_inside),
    )
    ampere_scale = abs(curl_inside) @ np.abs(u_inside) + system.omega * (
        abs(sigma_inside[inside_edges, :]) @ np.abs(u_inside)
        + abs(complex_conductance[inside_edges, :]) @ np.abs(grad_phi)
    )
    gauge_force = _relative_residual(
        gauge @ solution[edge_count + potential_count:], ampere_scale,
    )
    return DarwinSolution(
        electric_edge_v=electric_edge,
        curl_edge_v=-u,
        scalar_potential_v=phi,
        terminal_currents_a=currents,
        terminal_voltages_v=voltages,
        relative_residual=residual,
        gauge_relative_residual=gauge_relative_residual,
        gauge_force_relative_residual=gauge_force,
        power_in_w=float(power_in),
        power_joule_w=float(joule),
        power_mix_w=float(mix),
    )
