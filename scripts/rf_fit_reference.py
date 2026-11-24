"""Full-wave finite integration on an orthogonal Cartesian primal/dual grid."""

from dataclasses import dataclass
from itertools import product

import numpy as np
from scipy import sparse
from scipy.constants import epsilon_0, mu_0


def _pair(axis, ndim=3):
    low, high = [slice(None)] * ndim, [slice(None)] * ndim
    low[axis], high[axis] = slice(None, -1), slice(1, None)
    return tuple(low), tuple(high)


def _transverse_slots(axis):
    u, v = (axis + 1) % 3, (axis + 2) % 3
    for a, b in product((0, 1), repeat=2):
        slices = [slice(None)] * 3
        slices[u] = _pair(u)[a][u]
        slices[v] = _pair(v)[b][v]
        yield tuple(slices), u, v, a, b


def _number_lattice(shape, offset):
    return np.arange(offset, offset + np.prod(shape), dtype=np.int64).reshape(shape)


def _topology(shape):
    nodes = _number_lattice(shape, 0)
    edge_ids, face_ids, endpoints = [], [], []
    edge_count = face_count = 0
    for axis in range(3):
        lo, hi = _pair(axis)
        endpoints.append(np.column_stack((nodes[lo].ravel(), nodes[hi].ravel())))
        edges = _number_lattice(nodes[lo].shape, edge_count)
        edge_ids.append(edges)
        edge_count += edges.size
        face_shape = tuple(n if k == axis else n - 1 for k, n in enumerate(shape))
        faces = _number_lattice(face_shape, face_count)
        face_ids.append(faces)
        face_count += faces.size
    edges = np.vstack(endpoints)
    order = np.lexsort((edges[:, 1], edges[:, 0]))
    inverse = np.empty_like(order)
    inverse[order] = np.arange(len(order))
    edges = edges[order]
    edge_ids = tuple(inverse[ids] for ids in edge_ids)
    face_ids = tuple(face_ids)
    gradient = sparse.csr_matrix((np.tile((-1, 1), edge_count),
                                  (np.repeat(np.arange(edge_count), 2), edges.ravel())),
                                 shape=(edge_count, nodes.size))

    curl_entries = []
    boundary_triangles = []
    for axis, ids in enumerate(face_ids):
        u, v = (axis+1) % 3, (axis+2) % 3
        ulo, uhi = _pair(u)
        vlo, vhi = _pair(v)
        circulation = (edge_ids[u][vlo], edge_ids[v][uhi], edge_ids[u][vhi], edge_ids[v][ulo])
        curl_entries.append(np.stack(circulation, axis=-1).reshape(-1, 4))
        quad = np.stack((nodes[ulo][vlo], nodes[uhi][vlo], nodes[uhi][vhi], nodes[ulo][vhi]), axis=-1)
        wall = np.take(quad, [0, -1], axis=axis).reshape(-1, 4)
        boundary_triangles.extend((wall[:, [0, 1, 2]], wall[:, [0, 2, 3]]))
    curl = sparse.csr_matrix((np.tile((1, 1, -1, -1), face_count),
                              (np.repeat(np.arange(face_count), 4), np.vstack(curl_entries).ravel())),
                             shape=(face_count, edge_count))
    div_faces = [ids[side] for a, ids in enumerate(face_ids) for side in _pair(a)]
    cell_count = div_faces[0].size
    divergence = sparse.csr_matrix((np.tile((-1, 1) * 3, cell_count),
                                    (np.repeat(np.arange(cell_count), 6),
                                     np.stack(div_faces, axis=-1).ravel())),
                                   shape=(cell_count, face_count))
    coords = np.asarray(np.unravel_index(edges.T, shape))
    fixed = (coords[:, 0] == coords[:, 1]) & (
        (coords[:, 0] == 0) | (coords[:, 0] == np.asarray(shape)[:, None] - 1))
    boundary_edges = np.flatnonzero(np.any(fixed, axis=0))
    boundary_faces = np.sort(np.vstack(boundary_triangles), axis=1)
    return edges, edge_ids, face_ids, boundary_edges, boundary_faces, gradient, curl, divergence


def _material(values, shape, *, allow_zero):
    field = np.broadcast_to(np.asarray(values, dtype=float), shape).copy()
    if not np.isfinite(field).all() or np.any(field < 0 if allow_zero else field <= 0):
        raise ValueError("FIT materials must be finite and passive")
    return field


def _material_weights(widths, edge_ids, face_ids, sigma, epsilon, mu):
    edge_measure = np.zeros(sum(e.size for e in edge_ids))
    epsilon_measure = np.zeros_like(edge_measure)
    face_measure = np.zeros(sum(f.size for f in face_ids))
    for axis in range(3):
        u, v = (axis+1) % 3, (axis+2) % 3
        weight = widths[u] * widths[v] / (4 * widths[axis])
        for slots, *_ in _transverse_slots(axis):
            ids = edge_ids[axis][slots]
            edge_measure[ids] += sigma * weight
            epsilon_measure[ids] += epsilon * weight
        face_weight = widths[axis] / (2 * mu * widths[u] * widths[v])
        for slots in _pair(axis):
            face_measure[face_ids[axis][slots]] += face_weight
    return edge_measure, epsilon_measure, face_measure


@dataclass(frozen=True)
class FitSystem:
    axes_m: tuple
    points_m: np.ndarray
    edges: np.ndarray
    edge_ids: tuple
    face_ids: tuple
    boundary_edges: np.ndarray
    boundary_faces: np.ndarray
    gradient: sparse.csr_matrix
    curl: sparse.csr_matrix
    divergence: sparse.csr_matrix
    sigma_s: np.ndarray
    epsilon_f: np.ndarray
    nu_per_h: np.ndarray
    conductivity_spm: np.ndarray
    permeability_hpm: np.ndarray
    omega: float

    @property
    def curl_matrix(self):
        return (self.curl.T @ sparse.diags(self.nu_per_h) @ self.curl).tocsr()

    def solve_ece(self, terminals, voltages_v, loads_ohm, *, floating_load=None):
        """Excite the FIT mesh through the matched FEM circuit boundary."""
        from rf_fullwave_reference import MaxwellSolution, _cotree_edges, _solve, terminal_trace

        pairs = self.boundary_faces[:, ((0, 1), (0, 2), (1, 2))].reshape(-1, 2)
        trace_edges = np.unique(pairs, axis=0)
        trace = terminal_trace(len(self.points_m), trace_edges, self.boundary_faces,
                               terminals, voltages_v, loads_ohm, floating_load=floating_load)
        interior_edges = np.setdiff1d(np.arange(len(self.edges)), self.boundary_edges, assume_unique=True)
        cotree, interior_nodes = _cotree_edges(len(self.points_m), self.edges,
                                              self.boundary_faces, interior_edges)
        free = sparse.csr_matrix((np.ones(len(cotree)), (cotree, np.arange(len(cotree)))),
                                 shape=(len(self.edges), len(cotree)))
        internal = sparse.csr_matrix((np.ones(len(interior_nodes)), (interior_nodes, np.arange(len(interior_nodes)))),
                                     shape=(len(self.points_m), len(interior_nodes)))
        potential_map = sparse.hstack((trace.potential_map, internal), format="csr")
        transform = sparse.hstack((free, -(self.gradient @ potential_map)), format="csr")
        lift = -(self.gradient @ trace.potential_lift_v)

        admittance = self.sigma_s + 1j * self.omega * self.epsilon_f
        iw = 1j * self.omega
        cq = self.curl[:, cotree]
        curl = cq.T @ sparse.diags(self.nu_per_h) @ cq
        operator = sparse.block_diag((curl, sparse.csr_matrix((potential_map.shape[1],)*2)), format="csr")
        stamp = sparse.block_diag((sparse.csr_matrix((len(cotree),)*2), trace.load_admittance_s,
                                  sparse.csr_matrix((len(interior_nodes),)*2)), format="csr")
        operator += iw * ((transform.T @ sparse.diags(admittance) @ transform) + stamp)
        coefficients, residual = _solve(operator, -iw * (transform.T @ (admittance * lift)))

        field = lift + transform @ coefficients
        curl_field = free @ coefficients[:len(cotree)]
        potential = trace.potential_lift_v + potential_map @ coefficients[len(cotree):]
        reaction = -(self.gradient.T @ (admittance * field))
        voltages = {name: complex(potential[nodes[0]]) for name, nodes in trace.terminal_nodes.items()}
        currents = {name: complex(reaction[nodes].sum()) for name, nodes in trace.terminal_nodes.items()}
        heat = .5 * np.vdot(field, self.sigma_s * field).real
        supplied = .5 * sum((voltage * currents[name].conjugate()).real for name, voltage in voltages.items())
        return MaxwellSolution(field, curl_field, voltages, currents, residual, float(heat), float(supplied))

    def locate(self, points_m):
        points = np.asarray(points_m, dtype=float)
        if points.ndim != 2 or points.shape[1] != 3 or not np.isfinite(points).all():
            raise ValueError("FIT probes need finite N × 3 coordinates")
        indices, local, widths = [], [], []
        for axis, coords in enumerate(self.axes_m):
            p = points[:, axis]
            if np.any(p < coords[0]) or np.any(p > coords[-1]):
                raise ValueError("FIT probe lies outside the grid")
            i = np.minimum(np.searchsorted(coords, p, side="right") - 1, len(coords)-2)
            width = coords[i+1] - coords[i]
            indices.append(i)
            local.append((p - coords[i]) / width)
            widths.append(width)
        return np.asarray(indices), np.asarray(local), np.asarray(widths)

    def sample(self, electric_edge_v, points_m, *, curl_edge_v):
        electric_field = np.asarray(electric_edge_v, dtype=complex)
        curl_field = np.asarray(curl_edge_v, dtype=complex)
        if (electric_field.shape != (len(self.edges),) or curl_field.shape != electric_field.shape
                or not np.isfinite(electric_field).all() or not np.isfinite(curl_field).all()):
            raise ValueError("FIT electric input must contain one finite voltage per edge")
        cells, local, widths = self.locate(points_m)
        fields = np.zeros((len(local.T), 3), dtype=complex)
        magnetic = np.zeros_like(fields)
        b = -(self.curl @ curl_field) / (1j * self.omega)
        for axis, ids in enumerate(self.edge_ids):
            for _, u, v, a, b_offset in _transverse_slots(axis):
                corner = cells.copy()
                corner[u] += a
                corner[v] += b_offset
                wu = local[u] if a else 1 - local[u]
                wv = local[v] if b_offset else 1 - local[v]
                fields[:, axis] += wu * wv * electric_field[ids[tuple(corner)]] / widths[axis]
            high = cells.copy()
            high[axis] += 1
            ids = self.face_ids[axis]
            flux = (1 - local[axis]) * b[ids[tuple(cells)]] + local[axis] * b[ids[tuple(high)]]
            u, v = (axis+1) % 3, (axis+2) % 3
            magnetic[:, axis] = flux / (widths[u] * widths[v] * self.permeability_hpm[tuple(cells)])
        return fields, magnetic


def assemble(axes_m, conductivity_spm, relative_permittivity, frequency_hz, relative_permeability=1.):
    axes = tuple(np.asarray(a, dtype=float) for a in axes_m)
    if len(axes) != 3 or any(a.ndim != 1 or len(a) < 2 or not np.isfinite(a).all()
                            or np.any(np.diff(a) <= 0) for a in axes):
        raise ValueError("FIT needs three strictly increasing finite coordinate axes")
    if not np.isfinite(frequency_hz) or frequency_hz <= 0:
        raise ValueError("FIT requires a finite positive frequency")
    shape = tuple(len(a) for a in axes)
    cell_shape = tuple(n-1 for n in shape)
    sigma = _material(conductivity_spm, cell_shape, allow_zero=True)
    epsilon = epsilon_0 * _material(relative_permittivity, cell_shape, allow_zero=False)
    mu = mu_0 * _material(relative_permeability, cell_shape, allow_zero=False)
    widths = tuple(np.diff(a).reshape(tuple(-1 if i == axis else 1 for i in range(3)))
                   for axis, a in enumerate(axes))
    points = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1).reshape(-1, 3)
    edges, edge_ids, face_ids, boundary_edges, boundary_faces, gradient, curl, div = _topology(shape)
    weights = _material_weights(widths, edge_ids, face_ids, sigma, epsilon, mu)
    return FitSystem(axes, points, edges, edge_ids, face_ids, boundary_edges, boundary_faces,
                     gradient, curl, div, *weights, sigma, mu, 2*np.pi*frequency_hz)
