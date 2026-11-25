"""Surface admittance and incident-wave terms for x-normal FIT gap ports."""

from dataclasses import dataclass

import numpy as np
from scipy import sparse


@dataclass(frozen=True)
class GapPatch:
    y_bounds_m: tuple[float, float]
    z_bounds_m: tuple[float, float]
    y_direction: int


@dataclass(frozen=True)
class GapPort:
    x_m: float
    resistance_ohm: float
    patches: tuple[GapPatch, ...]
    incident_power_w: float = 0.
    phase_rad: float = 0.


def _node(axis, value):
    spacing = np.spacing(np.max(np.abs(axis)))
    matches = np.flatnonzero(np.isclose(axis, value, rtol=0., atol=8. * spacing))
    if len(matches) != 1:
        raise ValueError("A gap patch coordinate must match one grid plane")
    return int(matches[0])


def _bounds(axis, interval):
    a, b = (_node(axis, value) for value in interval)
    if a >= b:
        raise ValueError("Gap patch bounds must be increasing")
    return a, b


def assemble_gap_ports(fit, ports):
    """Return the sheet matrix in S and incident term in A before multiplication by iω."""
    x_m, y_m, z_m = fit.axes_m
    _, y_edges, z_edges = fit.edge_ids
    edge_count = len(fit.edges)
    source = np.zeros(edge_count, dtype=complex)
    rows, columns, values = [], [], []
    covered = set()
    for port in ports:
        x = _node(x_m, port.x_m)
        if x not in (0, len(x_m) - 1):
            raise ValueError("A gap port must lie on the exterior x boundary")
        if (not port.patches or not np.isfinite([port.resistance_ohm, port.incident_power_w, port.phase_rad]).all()
                or port.resistance_ohm <= 0. or port.incident_power_w < 0.):
            raise ValueError("A gap port needs patches, finite R > 0, P ≥ 0 and phase")
        branch_resistance = len(port.patches) * port.resistance_ohm
        incident_voltage = np.sqrt(2. * port.resistance_ohm * port.incident_power_w) * np.exp(1j * port.phase_rad)
        for patch in port.patches:
            if patch.y_direction not in (-1, 1):
                raise ValueError("A gap patch needs y direction +1 or −1")
            y0, y1 = _bounds(y_m, patch.y_bounds_m)
            z0, z1 = _bounds(z_m, patch.z_bounds_m)
            length, width = y_m[y1] - y_m[y0], z_m[z1] - z_m[z0]
            sheet_admittance = length / (branch_resistance * width)
            incident_h = patch.y_direction * sheet_admittance * incident_voltage / length
            for y in range(y0, y1):
                dy = y_m[y + 1] - y_m[y]
                for z in range(z0, z1):
                    cell = (x, y, z)
                    if cell in covered:
                        raise ValueError("Gap port patches overlap")
                    covered.add(cell)
                    dz = z_m[z + 1] - z_m[z]
                    edges_y = y_edges[x, y, z:z + 2]
                    edges_z = z_edges[x, y:y + 2, z]
                    source[edges_y] += incident_h * dz
                    for (a, b), scale in ((edges_y, dz / dy), (edges_z, dy / dz)):
                        weight = sheet_admittance * scale / 6.
                        rows.extend((a, a, b, b))
                        columns.extend((a, b, a, b))
                        values.extend((2. * weight, weight, weight, 2. * weight))
    sheet = sparse.coo_matrix((values, (rows, columns)), shape=(edge_count, edge_count)).tocsr()
    return sheet, source


@dataclass(frozen=True)
class GapPortSolution:
    electric_edge_v: np.ndarray
    relative_residual: float
    power_joule_w: float
    power_surface_w: float
    power_source_w: float


def solve_gap_ports(fit, ports, *, pec_edges):
    """Solve the full-wave FIT equation with specified tangential PEC edge constraints."""
    from rf_fullwave_reference import _solve

    sheet, incident = assemble_gap_ports(fit, ports)
    fixed = np.asarray(pec_edges)
    edge_count = len(fit.edges)
    if (fixed.ndim != 1 or (fixed.size and not np.issubdtype(fixed.dtype, np.integer))
            or np.any(fixed < 0) or np.any(fixed >= edge_count)):
        raise ValueError("PEC edges must be valid edge indices")
    free = np.setdiff1d(np.arange(edge_count), fixed)
    iw = 1j * fit.omega
    admittance = sparse.diags(fit.sigma_s + iw * fit.epsilon_f)
    operator = (fit.curl_matrix + iw * (admittance + sheet)).tocsr()
    result = np.zeros(edge_count, dtype=complex)
    result[free], residual = _solve(operator[free][:, free], iw * incident[free])
    power_joule = .5 * np.vdot(result, fit.sigma_s * result).real
    power_surface = .5 * np.vdot(result, sheet @ result).real
    power_source = .5 * np.vdot(result, incident).real
    return GapPortSolution(result, residual, float(power_joule), float(power_surface), float(power_source))
