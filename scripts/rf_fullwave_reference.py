"""Standalone lowest-order conforming E–V Maxwell reference with ECE ports.

Stores electric circulations in volts on ascending global edges. All input
geometry and volume coefficients are SI. This module is independent of the
Fullmag production runtime.
"""

from dataclasses import dataclass
from itertools import combinations

import numpy as np
from scipy import sparse
from scipy.constants import epsilon_0, mu_0
from scipy.sparse import linalg

_EDGE_I, _EDGE_J = np.asarray(list(combinations(range(4), 2))).T
_FACES = np.asarray(list(combinations(range(4), 3)))
_GAUSS_LOWER = (5 - np.sqrt(5.0)) / 20
_GAUSS_BARYCENTRIC = np.full((4, 4), _GAUSS_LOWER) + np.eye(4) / np.sqrt(5.0)


def _as_indices(values, shape, size, name):
    values = np.asarray(values)
    if (values.ndim != len(shape)
            or any(n is not None and n != v for n, v in zip(shape, values.shape))
            or not np.issubdtype(values.dtype, np.integer)
            or np.any(values < 0) or np.any(values >= size)):
        raise ValueError(f"{name} must contain valid integer indices")
    return values.astype(np.int64, copy=False)


def _material(values, count, lower_bound, strict, name):
    if np.iscomplexobj(values):
        raise ValueError(f"{name} must be real")
    try:
        values = np.broadcast_to(np.asarray(values, dtype=float), (count,))
    except ValueError as error:
        raise ValueError(f"{name} must be scalar or one value per tetrahedron") from error
    invalid = values <= lower_bound if strict else values < lower_bound
    if not np.isfinite(values).all() or invalid.any():
        raise ValueError(f"{name} must be finite and physically admissible")
    return values


def _edge_basis(gradients, barycentric):
    return (
        barycentric[..., _EDGE_I, None] * gradients[..., _EDGE_J, :]
        - barycentric[..., _EDGE_J, None] * gradients[..., _EDGE_I, :]
    )


def _boundary_edge_indices(edges, boundary_faces):
    face_edges = boundary_faces[:, ((0, 1), (0, 2), (1, 2))].reshape(-1, 2)
    dtype = np.dtype([("first", np.int64), ("second", np.int64)])
    keys = np.ascontiguousarray(edges).view(dtype).ravel()
    sought = np.ascontiguousarray(face_edges).view(dtype).ravel()
    return np.unique(np.searchsorted(keys, sought))


def gradient_incidence(points_count, edges):
    row = np.repeat(np.arange(len(edges)), 2)
    signs = np.tile([-1.0, 1.0], len(edges))
    return sparse.csr_matrix((signs, (row, edges.ravel())), shape=(len(edges), points_count))


def _solve(matrix, rhs):
    if len(rhs) == 0:
        return np.zeros(0, dtype=complex), 0.0
    scale = np.asarray(abs(matrix).max(axis=1).toarray()).ravel()
    if not np.isfinite(scale).all() or np.any(scale <= 0):
        raise ValueError("Maxwell system has a singular or invalid row")
    d = sparse.diags(1 / np.sqrt(scale))
    solution = d @ linalg.splu((d @ matrix @ d).tocsc()).solve(d @ rhs)
    response = matrix @ solution
    denominator = max(np.linalg.norm(rhs), np.linalg.norm(response))
    error = np.linalg.norm(response - rhs)
    relative_residual = error / denominator if denominator else 0.0
    if not np.isfinite(solution).all() or not np.isfinite(relative_residual):
        raise RuntimeError("Maxwell solution has nonfinite values")
    if relative_residual > 1e-5:
        raise RuntimeError(f"Maxwell unscaled residual {relative_residual:.3e} exceeds 1e-5")
    return solution, float(relative_residual)


@dataclass(frozen=True)
class TerminalTrace:
    potential_lift_v: np.ndarray
    potential_map: sparse.csr_matrix
    interior_edges: np.ndarray
    terminal_nodes: dict[str, np.ndarray]
    load_columns: dict[str, int]


def _check_closed_simple_boundary(faces, edge_indices):
    pairs = faces[:, ((0, 1), (0, 2), (1, 2))].reshape(-1, 2)
    _, counts = np.unique(pairs, return_counts=True, axis=0)
    vertices, inverse = np.unique(pairs, return_inverse=True)
    endpoints = inverse.reshape(-1, 2)
    graph = sparse.coo_matrix((np.ones(len(pairs)), endpoints.T),
                              shape=(len(vertices), len(vertices)))
    components = sparse.csgraph.connected_components(graph, directed=False, return_labels=False)
    if np.any(counts != 2) or components != 1 or len(vertices) - len(edge_indices) + len(faces) != 2:
        raise ValueError("ECE requires one closed connected genus-zero boundary")


def terminal_trace(points_count, edges, boundary_faces, terminals, voltages_v, loads_ohm):
    """Construct the nodal scalar trace with equipotential electrode patches."""
    fixed, loaded = set(voltages_v), set(loads_ohm)
    if not terminals or fixed & loaded or fixed | loaded != terminals.keys():
        raise ValueError("each terminal needs exactly one voltage or load")
    if not all(np.isfinite(complex(v)) for v in voltages_v.values()) or not any(
        complex(v) == 0 for v in voltages_v.values()
    ):
        raise ValueError("finite voltages and an explicit ground reference are required")
    if any(not np.isfinite(complex(z)) or complex(z) == 0 or complex(z).real < 0
           for z in loads_ohm.values()):
        raise ValueError("terminal impedance must be finite, nonzero and passive")

    boundary_edges = _boundary_edge_indices(edges, boundary_faces)
    _check_closed_simple_boundary(boundary_faces, boundary_edges)
    boundary_nodes = np.unique(boundary_faces)
    lift = np.zeros(points_count, dtype=complex)
    taken = np.zeros(points_count, dtype=bool)
    rows, columns = [], []
    terminal_nodes, load_columns = {}, {}
    column = 0
    for name, raw in terminals.items():
        nodes = np.unique(_as_indices(raw, (None,), points_count, "terminal vertices"))
        on_terminal = np.zeros(points_count, dtype=bool)
        on_terminal[nodes] = True
        faces = boundary_faces[on_terminal[boundary_faces].all(axis=1)]
        if len(nodes) < 3 or not np.array_equal(np.unique(faces), nodes) or taken[nodes].any():
            raise ValueError(f"terminal {name!r} needs a distinct exterior surface")
        face_edges = faces[:, ((0, 1), (0, 2), (1, 2))].reshape(-1, 2)
        local_edges = np.searchsorted(nodes, face_edges)
        graph = sparse.coo_matrix((np.ones(len(local_edges)), local_edges.T),
                                  shape=(len(nodes), len(nodes)))
        if sparse.csgraph.connected_components(graph, directed=False, return_labels=False) != 1:
            raise ValueError(f"terminal {name!r} needs one connected surface")
        taken[nodes] = True
        terminal_nodes[name] = nodes
        if name in fixed:
            lift[nodes] = complex(voltages_v[name])
        else:
            rows.extend(nodes)
            columns.extend([column] * len(nodes))
            load_columns[name] = column
            column += 1
    other = boundary_nodes[~taken[boundary_nodes]]
    rows.extend(other)
    columns.extend(range(column, column + len(other)))
    potential_map = sparse.csr_matrix(
        (np.ones(len(rows)), (rows, columns)), shape=(points_count, column + len(other)))
    internal = np.setdiff1d(np.arange(len(edges)), boundary_edges, assume_unique=True)
    return TerminalTrace(lift, potential_map, internal, terminal_nodes, load_columns)


def _cotree_edges(points_count, edges, boundary_faces, interior_edges):
    # Contract the boundary into a root. A spanning tree fixes the zero
    # circulations of the curl-carrying field without modifying physical E.
    boundary = np.unique(boundary_faces)
    internal_nodes = np.setdiff1d(np.arange(points_count), boundary, assume_unique=True)
    pairs = np.vstack((edges, np.column_stack((np.full(len(boundary), points_count), boundary))))
    graph = sparse.coo_matrix((np.ones(len(pairs)), pairs.T),
                              shape=(points_count + 1, points_count + 1)).tocsr()
    _, predecessor = sparse.csgraph.breadth_first_order(graph, points_count, directed=False)
    if np.any(predecessor[internal_nodes] < 0):
        raise ValueError("mesh interior must be connected to the exterior")
    tree_pairs = np.sort(np.column_stack((internal_nodes, predecessor[internal_nodes])), axis=1)
    keys = np.dtype([("first", np.int64), ("second", np.int64)])
    pairs_view = np.ascontiguousarray(edges).view(keys).ravel()
    tree_view = np.ascontiguousarray(tree_pairs).view(keys).ravel()
    tree_edges = np.searchsorted(pairs_view, tree_view)
    return np.setdiff1d(interior_edges, tree_edges, assume_unique=True), internal_nodes


@dataclass(frozen=True)
class MaxwellSolution:
    electric_edge_v: np.ndarray
    curl_edge_v: np.ndarray
    terminal_voltages_v: dict[str, complex]
    terminal_currents_a: dict[str, complex]
    relative_residual: float
    power_joule_w: float
    power_in_w: float


@dataclass(frozen=True)
class MaxwellSystem:
    points_m: np.ndarray
    tetrahedra: np.ndarray
    edges: np.ndarray
    boundary_faces: np.ndarray
    boundary_edges: np.ndarray
    cell_edges: np.ndarray
    gradients: np.ndarray
    cell_curls: np.ndarray
    curl_matrix: sparse.csr_matrix
    sigma_matrix: sparse.csr_matrix
    epsilon_matrix: sparse.csr_matrix
    mass_matrix: sparse.csr_matrix
    omega: float

    def _operator(self):
        return self.curl_matrix + 1j*self.omega*self.sigma_matrix - self.omega**2*self.epsilon_matrix

    def solve_tangential(self, boundary_values_v):
        values = np.asarray(boundary_values_v, dtype=complex)
        if values.shape != self.boundary_edges.shape or not np.isfinite(values).all():
            raise ValueError("expected finite circulations on the exterior edges in boundary_edges order")
        rest = np.setdiff1d(np.arange(len(self.edges)), self.boundary_edges, assume_unique=True)
        operator = self._operator()
        field = np.zeros(len(self.edges), dtype=complex)
        field[self.boundary_edges] = values
        field[rest], _ = _solve(operator[rest][:, rest], -(operator @ field)[rest])
        return field

    def solve_ece(self, terminals, voltages_v, loads_ohm):
        trace = terminal_trace(len(self.points_m), self.edges, self.boundary_faces,
                               terminals, voltages_v, loads_ohm)
        incidence = gradient_incidence(len(self.points_m), self.edges)
        rows, scalar_nodes = _cotree_edges(
            len(self.points_m), self.edges, self.boundary_faces, trace.interior_edges)
        free = sparse.csr_matrix(
            (np.ones(len(rows)), (rows, np.arange(len(rows)))), shape=(len(self.edges), len(rows)))
        nodal = sparse.csr_matrix(
            (np.ones(len(scalar_nodes)), (scalar_nodes, np.arange(len(scalar_nodes)))),
            shape=(len(self.points_m), len(scalar_nodes)))
        potential_map = sparse.hstack((trace.potential_map, nodal), format="csr")
        transform = sparse.hstack((free, -(incidence @ potential_map)), format="csr")
        lift = -(incidence @ trace.potential_lift_v)
        # Enforce discrete curl(grad)=0 algebraically. Applying a floating
        # point curl stiffness to gradient columns would swamp the much
        # smaller dielectric term at electrically short length scales.
        mass = 1j*self.omega*self.sigma_matrix - self.omega**2*self.epsilon_matrix
        curl = sparse.block_diag((self.curl_matrix[rows][:, rows],
                                  sparse.csr_matrix((potential_map.shape[1],)*2)), format="csr")
        reduced = curl + transform.T @ mass @ transform
        impedance = np.zeros(reduced.shape[0], dtype=complex)
        for name, column in trace.load_columns.items():
            impedance[len(rows) + column] = 1j*self.omega/complex(loads_ohm[name])
        reduced = reduced + sparse.diags(impedance)
        # <AE,w> = iω I_in overline(q_k), and I_in = -V_k / Z on a load.
        free_result, residual = _solve(reduced, -(transform.T @ (mass @ lift)))
        field = lift + transform @ free_result
        curl_field = free @ free_result[:len(rows)]
        potential = trace.potential_lift_v + potential_map @ free_result[len(rows):]
        current_matrix = self.sigma_matrix + 1j*self.omega*self.epsilon_matrix
        nodal_reaction = -(incidence.T @ (current_matrix @ field))
        terminal_voltages = {name: complex(potential[nodes[0]])
                             for name, nodes in trace.terminal_nodes.items()}
        currents = {name: complex(nodal_reaction[nodes].sum())
                    for name, nodes in trace.terminal_nodes.items()}
        pot_joule = 0.5*np.vdot(field, self.sigma_matrix @ field).real
        pot_in = 0.5*sum((terminal_voltages[k]*v.conjugate()).real for k, v in currents.items())
        return MaxwellSolution(field, curl_field, terminal_voltages, currents, residual,
                               float(pot_joule), float(pot_in))

    def sample(self, electric_edge_v, points_m, cell_indices, *, curl_edge_v=None):
        values = np.asarray(electric_edge_v, dtype=complex)
        curls = values if curl_edge_v is None else np.asarray(curl_edge_v, dtype=complex)
        points = np.asarray(points_m, dtype=float)
        indices = _as_indices(cell_indices, (None,), len(self.tetrahedra), "sample cells")
        if (points.shape != (len(indices), 3) or values.shape != (len(self.edges),)
                or curls.shape != values.shape or not np.isfinite(curls).all()
                or not np.isfinite(points).all() or not np.isfinite(values).all()):
            raise ValueError("expected finite XYZ samples, containing cells and edge values")
        gradients = self.gradients[indices]
        relative = points - self.points_m[self.tetrahedra[indices, 0]]
        rest = np.einsum("ni,nji->nj", relative, gradients[:, 1:])
        barycentric = np.column_stack((1 - rest.sum(axis=1), rest))
        if np.any(barycentric < -1e-8) or np.any(barycentric > 1 + 1e-8):
            raise ValueError("sample point outside its specified cell")
        basis = _edge_basis(gradients, barycentric)
        local = values[self.cell_edges[indices]]
        electric = np.einsum("ne,nei->ni", local, basis)
        curl = np.einsum("ne,nei->ni", curls[self.cell_edges[indices]], self.cell_curls[indices])
        magnetic = -curl/(1j*self.omega*mu_0)
        return electric, magnetic


def assemble(points_m, tetrahedra, conductivity_spm, relative_permittivity, frequency_hz):
    """Assemble full-wave curl-curl and three separately inspectable mass terms."""
    points = np.asarray(points_m, dtype=float)
    if (points.ndim != 2 or points.shape[1] != 3 or len(points) < 4
            or not np.isfinite(points).all()):
        raise ValueError("points must be a finite (N, 3) array")
    tetrahedra = np.sort(_as_indices(tetrahedra, (None, 4), len(points), "tetrahedra"), axis=1)
    count = len(tetrahedra)
    if not count or len(np.unique(tetrahedra, axis=0)) != count:
        raise ValueError("expected a nonempty mesh without duplicate tetrahedra")
    if len(np.unique(tetrahedra)) != len(points):
        raise ValueError("mesh contains unused points")
    omega = 2*np.pi*float(frequency_hz)
    if omega <= 0 or not np.isfinite(omega*omega):
        raise ValueError("frequency must be finite, positive and representable")
    sigma = _material(conductivity_spm, count, 0, False, "conductivity")
    epsilon = epsilon_0*_material(relative_permittivity, count, 0, True, "relative permittivity")

    xyz = points[tetrahedra]
    axes = xyz[:, 1:] - xyz[:, :1]
    volumes = np.abs(np.linalg.det(axes))/6
    if np.any(volumes <= 0) or not np.isfinite(volumes).all():
        raise ValueError("degenerate tetrahedron")
    gradients = np.empty((count, 4, 3))
    gradients[:, 1:] = np.swapaxes(np.linalg.inv(axes), 1, 2)
    gradients[:, 0] = -gradients[:, 1:].sum(axis=1)
    curls = 2*np.cross(gradients[:, _EDGE_I], gradients[:, _EDGE_J])

    local_edges = np.stack((tetrahedra[:, _EDGE_I], tetrahedra[:, _EDGE_J]), axis=-1)
    edges, inverse = np.unique(local_edges.reshape(-1, 2), return_inverse=True, axis=0)
    cell_edges = inverse.reshape(-1, 6)
    all_faces, occurrences = np.unique(tetrahedra[:, _FACES].reshape(-1, 3),
                                       return_counts=True, axis=0)
    if np.any(occurrences > 2):
        raise ValueError("nonmanifold tetrahedron faces")
    boundary_faces = all_faces[occurrences == 1]
    boundary_edges = _boundary_edge_indices(edges, boundary_faces)

    local_mass = np.zeros((count, 6, 6))
    for barycentric in _GAUSS_BARYCENTRIC:
        basis = _edge_basis(gradients, barycentric)
        local_mass += (basis @ np.swapaxes(basis, 1, 2)) * (volumes[:, None, None]/4)
    local_curl = (curls @ np.swapaxes(curls, 1, 2)) * (volumes[:, None, None]/mu_0)
    row = np.repeat(cell_edges, 6, axis=1).ravel()
    col = np.tile(cell_edges, (1, 6)).ravel()

    def matrix(values):
        if not np.isfinite(values).all():
            raise ValueError("nonfinite element integrals")
        return sparse.coo_matrix((values.ravel(), (row, col)),
                                 shape=(len(edges), len(edges))).tocsr()

    return MaxwellSystem(points, tetrahedra, edges, boundary_faces, boundary_edges,
                         cell_edges, gradients, curls, matrix(local_curl),
                         matrix(local_mass*sigma[:, None, None]),
                         matrix(local_mass*epsilon[:, None, None]), matrix(local_mass), omega)
