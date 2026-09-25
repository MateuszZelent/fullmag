"""Exploratory full-boundary-condition DE reference by Chebyshev collocation.

This diagnostic solves the one-dimensional LL--Poisson pencil for a 100 nm
Py film with explicit exchange and magnetostatic boundary conditions.  It is
an independent cross-check of the coupled Galerkin diagnostic, not a FEM
solver or a release qualification path.

The variables use ``my = 1j*u``, ``mz = v`` and the phasor
``exp(1j*k*y - 1j*omega*time)``.  The generalized pencil is singular because
the Poisson equation has no frequency term and because endpoint rows are
replaced by boundary conditions.  Homogeneous eigenvalues are therefore
classified explicitly; only finite, real, positive roots are physical
candidates for this diagnostic.
"""

from dataclasses import dataclass
import json

import numpy as np
from scipy.linalg import eig


MU0 = 4.0 * np.pi * 1e-7
MS = 8e5
GAMMA0 = 2.211e5
THICKNESS = 100e-9
FIELD = 0.1 / (MU0 * MS)
LEX2 = 2.0 * 13e-12 / (MU0 * MS**2 * THICKNESS**2)
AIR_THICKNESS = 20.0
FREQUENCY_SCALE_GHZ = GAMMA0 * MS / (2.0 * np.pi) / 1e9

PHASOR_CONVENTION = "exp(+iky-iwt)"
_EIGENVALUE_TOLERANCE = 2e-10
_REAL_TOLERANCE = 2e-8
_POSITIVE_TOLERANCE = 1e-9


@dataclass(frozen=True)
class CollocationMode:
    """One finite positive collocation root and its nodal profiles."""

    omega: float
    nodes: np.ndarray
    u: np.ndarray
    v: np.ndarray
    psi: np.ndarray
    relative_residual: float

    @property
    def frequency_ghz(self):
        return self.omega * FREQUENCY_SCALE_GHZ

    @property
    def my(self):
        """Transverse magnetization profile in the stated phase convention."""

        return 1j * self.u

    @property
    def mz(self):
        """Transverse magnetization profile in the stated phase convention."""

        return self.v

    @property
    def magnetic_profile(self):
        return np.concatenate((self.my, self.mz))


@dataclass(frozen=True)
class PencilDiagnostics:
    """Accounting information for the singular generalized eigenproblem."""

    total_roots: int
    finite_roots: int
    infinite_roots: int
    algebraic_roots: int
    real_finite_roots: int
    nonreal_finite_roots: int
    positive_roots: int
    negative_roots: int
    zero_roots: int
    max_positive_residual: float
    eigenvalue_tolerance: float


@dataclass(frozen=True)
class CollocationResult:
    """Selected positive roots together with singular-pencil diagnostics."""

    k: float
    n: int
    modes: tuple
    diagnostics: PencilDiagnostics


def chebyshev_lobatto(n):
    """Return descending Lobatto nodes and d/dx on ``[-1/2, 1/2]``.

    The standard Chebyshev matrix is built on ``[-1, 1]`` and multiplied by
    two after mapping the nodes to the film coordinate ``x=z/t``.
    """

    if int(n) != n or n < 4:
        raise ValueError("n must be an integer >= 4")
    n = int(n)
    xi = np.cos(np.pi * np.arange(n + 1) / n)
    coefficients = np.ones(n + 1)
    coefficients[[0, -1]] = 2.0
    coefficients *= (-1.0) ** np.arange(n + 1)
    differences = xi[:, None] - xi[None, :]
    matrix = (coefficients[:, None] / coefficients[None, :]) / (
        differences + np.eye(n + 1)
    )
    matrix -= np.diag(np.sum(matrix, axis=1))
    return xi / 2.0, 2.0 * matrix.real


def _air_boundary_eta(q):
    """Dirichlet-airbox-to-film Robin factor for a 20-t-thick air layer."""

    if q == 0.0:
        return 1.0 / AIR_THICKNESS
    return q / np.tanh(q * AIR_THICKNESS)


def assemble_pencil(k, n):
    """Assemble ``L z = Omega B z`` with all six endpoint conditions."""

    q = abs(float(k)) * THICKNESS
    kappa = float(k) * THICKNESS
    a = FIELD + LEX2 * q**2
    nodes, derivative = chebyshev_lobatto(n)
    second_derivative = derivative @ derivative
    size = n + 1
    identity = np.eye(size)
    zero = np.zeros((size, size))

    # Bulk equations, ordered as [u, v, psi].
    operator = np.block(
        [
            [LEX2 * second_derivative - a * identity, zero, -kappa * identity],
            [zero, LEX2 * second_derivative - a * identity, -derivative],
            [kappa * identity, -derivative, second_derivative - q**2 * identity],
        ]
    )
    mass = np.block(
        [
            [zero, identity, zero],
            [identity, zero, zero],
            [zero, zero, zero],
        ]
    )

    # The descending nodes put the top surface at j=0 and the bottom at j=n.
    eta = _air_boundary_eta(q)
    for j, boundary_sign in ((0, 1.0), (n, -1.0)):
        # u'=0
        operator[j, :] = 0.0
        mass[j, :] = 0.0
        operator[j, :size] = derivative[j, :]

        # v'=0
        row = size + j
        operator[row, :] = 0.0
        mass[row, :] = 0.0
        operator[row, size : 2 * size] = derivative[j, :]

        # psi' +/- eta*psi - v = 0
        row = 2 * size + j
        operator[row, :] = 0.0
        mass[row, :] = 0.0
        operator[row, 2 * size : 3 * size] = derivative[j, :]
        operator[row, 2 * size + j] += boundary_sign * eta
        operator[row, size + j] -= 1.0

    return nodes, derivative, operator, mass


def _relative_pencil_residual(operator, mass, vector, omega):
    lhs = operator @ vector
    rhs = omega * (mass @ vector)
    denominator = max(
        float(np.linalg.norm(lhs)),
        float(np.linalg.norm(rhs)),
        np.finfo(float).tiny,
    )
    return float(np.linalg.norm(lhs - rhs) / denominator)


def solve(k, n=48, count=3):
    """Solve and return the first ``count`` finite positive roots.

    ``scipy.linalg.eig`` is requested in homogeneous-eigenvalue form so a
    zero denominator is retained as an explicit infinite root instead of
    becoming a misleading large floating-point frequency.
    """

    if count is not None and (int(count) != count or count <= 0):
        raise ValueError("count must be a positive integer or None")
    count = None if count is None else int(count)
    nodes, _, operator, mass = assemble_pencil(k, n)
    homogeneous, vectors = eig(
        operator,
        mass,
        right=True,
        homogeneous_eigvals=True,
        check_finite=True,
    )
    alpha = np.asarray(homogeneous[0])
    beta = np.asarray(homogeneous[1])
    total = int(alpha.size)
    scale = np.maximum(1.0, np.maximum(np.abs(alpha), np.abs(beta)))
    eigenvalue_tolerance = float(_EIGENVALUE_TOLERANCE * np.max(scale))
    pair_tolerance = _EIGENVALUE_TOLERANCE * scale
    algebraic = (np.abs(alpha) <= pair_tolerance) & (np.abs(beta) <= pair_tolerance)
    infinite = (np.abs(beta) <= pair_tolerance) & ~algebraic
    finite = ~infinite & ~algebraic

    finite_values = alpha[finite] / beta[finite]
    finite_indices = np.flatnonzero(finite)
    real_mask = np.abs(finite_values.imag) <= (
        _REAL_TOLERANCE * np.maximum(1.0, np.abs(finite_values.real))
    )
    real_values = finite_values[real_mask].real
    real_indices = finite_indices[real_mask]
    positive_mask = real_values > _POSITIVE_TOLERANCE
    negative_mask = real_values < -_POSITIVE_TOLERANCE
    zero_mask = ~(positive_mask | negative_mask)
    positive_indices = real_indices[positive_mask]
    positive_values = real_values[positive_mask]
    ordering = np.argsort(positive_values)
    positive_indices = positive_indices[ordering]
    positive_values = positive_values[ordering]

    modes = []
    positive_residuals = []
    size = int(n) + 1
    for index, omega in zip(positive_indices, positive_values):
        vector = np.asarray(vectors[:, index], dtype=complex)
        magnetic_norm = float(np.linalg.norm(vector[: 2 * size]))
        if not np.isfinite(magnetic_norm) or magnetic_norm == 0.0:
            raise ValueError("positive eigenvector has no magnetic component")
        vector = vector / magnetic_norm
        residual = _relative_pencil_residual(operator, mass, vector, omega)
        positive_residuals.append(residual)
        modes.append(
            CollocationMode(
                omega=float(omega),
                nodes=nodes.copy(),
                u=vector[:size].copy(),
                v=vector[size : 2 * size].copy(),
                psi=vector[2 * size :].copy(),
                relative_residual=residual,
            )
        )

    diagnostics = PencilDiagnostics(
        total_roots=total,
        finite_roots=int(np.count_nonzero(finite)),
        infinite_roots=int(np.count_nonzero(infinite)),
        algebraic_roots=int(np.count_nonzero(algebraic)),
        real_finite_roots=int(np.count_nonzero(real_mask)),
        nonreal_finite_roots=int(np.count_nonzero(~real_mask)),
        positive_roots=int(np.count_nonzero(positive_mask)),
        negative_roots=int(np.count_nonzero(negative_mask)),
        zero_roots=int(np.count_nonzero(zero_mask)),
        max_positive_residual=max(positive_residuals, default=0.0),
        eigenvalue_tolerance=eigenvalue_tolerance,
    )
    if count is not None:
        modes = modes[:count]
    return CollocationResult(k=float(k), n=int(n), modes=tuple(modes), diagnostics=diagnostics)


def spectrum(k, n=48, count=3):
    """Return finite positive frequencies in GHz for a selected collocation order."""

    return [mode.frequency_ghz for mode in solve(k, n=n, count=count).modes]


def main():
    for n in (32, 48, 64):
        for k in (0.0, 20e6, 40e6):
            result = solve(k, n=n, count=3)
            print(
                json.dumps(
                    {
                        "diagnostic_only": True,
                        "method": "chebyshev_full_bc",
                        "phasor": PHASOR_CONVENTION,
                        "n": n,
                        "k": k,
                        "GHz": [mode.frequency_ghz for mode in result.modes],
                        "pencil": result.diagnostics.__dict__,
                    }
                )
            )


if __name__ == "__main__":
    main()
