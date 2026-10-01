#!/usr/bin/env python3
"""Independent affine-prism proof for the FEM exchange quadrature policy.

This is intentionally independent of MFEM and of the native assembler.  It
uses the analytic P1 wedge gradients and the six-point order-two tensor rule
to show that a centroid rule creates extra null modes.  It is a mathematical
regression, not a native-runtime or deformed-prism qualification.
"""

from __future__ import annotations

import json
import math
from typing import Iterable, Sequence


Vector = Sequence[float]
Matrix = list[list[float]]


def prism_gradients(xi: float, eta: float, zeta: float) -> tuple[Vector, ...]:
    """Return analytic reference gradients for the six-node unit prism."""

    return (
        (zeta - 1.0, zeta - 1.0, xi + eta - 1.0),
        (1.0 - zeta, 0.0, -xi),
        (0.0, 1.0 - zeta, -eta),
        (-zeta, -zeta, 1.0 - xi - eta),
        (zeta, 0.0, xi),
        (0.0, zeta, eta),
    )


def dot(left: Vector, right: Vector) -> float:
    return sum(a * b for a, b in zip(left, right))


def assemble(rule: Iterable[tuple[float, float, float, float]]) -> Matrix:
    matrix = [[0.0 for _ in range(6)] for _ in range(6)]
    for xi, eta, zeta, weight in rule:
        gradients = prism_gradients(xi, eta, zeta)
        for row in range(6):
            for column in range(6):
                matrix[row][column] += weight * dot(gradients[row], gradients[column])
    return matrix


def rank(matrix: Matrix, tolerance: float = 1.0e-10) -> int:
    work = [row[:] for row in matrix]
    scale = max(abs(value) for row in work for value in row)
    threshold = tolerance * max(1.0, scale)
    dimension = len(work)
    result = 0
    for column in range(dimension):
        pivot = max(range(result, dimension), key=lambda row: abs(work[row][column]))
        if abs(work[pivot][column]) <= threshold:
            continue
        work[result], work[pivot] = work[pivot], work[result]
        pivot_value = work[result][column]
        for row in range(result + 1, dimension):
            factor = work[row][column] / pivot_value
            for entry in range(column, dimension):
                work[row][entry] -= factor * work[result][entry]
        result += 1
    return result


def matvec(matrix: Matrix, vector: Vector) -> list[float]:
    return [sum(value * vector[column] for column, value in enumerate(row)) for row in matrix]


def quadratic_form(matrix: Matrix, vector: Vector) -> float:
    return dot(vector, matvec(matrix, vector))


def order_two_prism_rule() -> list[tuple[float, float, float, float]]:
    triangle_points = (
        (1.0 / 6.0, 1.0 / 6.0),
        (2.0 / 3.0, 1.0 / 6.0),
        (1.0 / 6.0, 2.0 / 3.0),
    )
    segment_points = (
        0.5 - 1.0 / (2.0 * math.sqrt(3.0)),
        0.5 + 1.0 / (2.0 * math.sqrt(3.0)),
    )
    return [
        (xi, eta, zeta, 1.0 / 12.0)
        for xi, eta in triangle_points
        for zeta in segment_points
    ]


def order_one_prism_rule() -> list[tuple[float, float, float, float]]:
    return [(1.0 / 3.0, 1.0 / 3.0, 0.5, 0.5)]


def main() -> None:
    exact = assemble(order_two_prism_rule())
    centroid = assemble(order_one_prism_rule())
    constant = [1.0] * 6
    hourglass = [0.0, 1.0, -1.0, 0.0, -1.0, 1.0]
    exact_diagonal = exact[0][0]
    centroid_diagonal = centroid[0][0]
    exact_hourglass_energy = quadratic_form(exact, hourglass)
    centroid_hourglass_energy = quadratic_form(centroid, hourglass)
    exact_constant_residual = max(abs(value) for value in matvec(exact, constant))
    centroid_constant_residual = max(abs(value) for value in matvec(centroid, constant))

    assert rank(exact) == 5, "the exact affine prism stiffness must have rank five"
    assert rank(centroid) == 3, "the centroid prism stiffness has rank three"
    assert exact_constant_residual <= 1.0e-14
    assert centroid_constant_residual <= 1.0e-14
    assert abs(exact_diagonal - 5.0 / 12.0) <= 1.0e-14
    assert abs(centroid_diagonal - 11.0 / 36.0) <= 1.0e-14
    assert abs(exact_hourglass_energy - 2.0 / 3.0) <= 1.0e-14
    assert abs(centroid_hourglass_energy) <= 1.0e-14

    print(
        json.dumps(
            {
                "rule_exact": "triangle_order2 x segment_order2 (6 points)",
                "rule_rejected": "triangle_centroid x segment_midpoint (1 point)",
                "exact_rank": rank(exact),
                "centroid_rank": rank(centroid),
                "exact_diagonal_N1": exact_diagonal,
                "centroid_diagonal_N1": centroid_diagonal,
                "exact_constant_residual": exact_constant_residual,
                "centroid_constant_residual": centroid_constant_residual,
                "exact_hourglass_energy": exact_hourglass_energy,
                "centroid_hourglass_energy": centroid_hourglass_energy,
                "status": "PASS",
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
