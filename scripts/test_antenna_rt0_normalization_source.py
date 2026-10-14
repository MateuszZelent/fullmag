"""Interpreted source/model regressions, not native MFEM or physics proof."""
from fractions import Fraction as F
from pathlib import Path
import re

import pytest


def projection_body():
    source = (Path(__file__).resolve().parents[1] /
        "backends/fem/cpu/mfem/transport/conservative_current_view.cpp").read_text(encoding="utf-8")
    return source.split("WeightedRt0Result solve_weighted_rt0_projection(", 1)[1].split(
        "class CombinedConductivity final", 1)[0]


def test_mass_and_load_use_unit_flux_coordinates_before_both_kkt_lanes():
    body = projection_body()
    assert "const double inverse_rt0_face_moment = 2.0;" in body
    for row in ("i", "j"):
        assignment = re.search(rf"shape_{row}\[component\]\s*=\s*(.*?);", body, re.S)
        assert assignment is not None
        assert " ".join(assignment[1].split()) == (
            f"vshape({row}, component) * sign_{row} * inverse_rt0_face_moment")
    assert body.index("inverse_rt0_face_moment = 2.0") < body.index("double raw_energy")
    assert "sparse_mass->Add(dof_i, dof_j, contribution);" in body
    assert "(shape_i * raw) * weight;" in body
    assert "(shape_i * shape_j) * weight;" in body


def test_owned_coefficients_convert_only_after_physical_coordinate_residuals():
    body = projection_body()
    assignment = re.search(r"\(\*field\)\[dof\]\s*=\s*(.*?);", body, re.S)
    assert assignment is not None
    assert " ".join(assignment[1].split()) == (
        "solution.at(static_cast<std::size_t>(dof)) * inverse_rt0_face_moment")
    assert body.index("weighted KKT residual exceeds") < assignment.start()
    assert body.index("weighted correction energy is invalid") < assignment.start()
    assert "constraint.rhs = terminal.measured_outward_current_a;" in body
    assert "static_cast<double>(sign));" in body
    assert "kkt_solution[static_cast<int>(index)]" in body
    assert "sparse_mass->Mult(full_solution, mass_full_solution);" in body


def scalar_projection(basis_inverse, owned_inverse, current=F(1)):
    """Independent exact two-coordinate model, not execution of the C++ KKT."""
    moment = F(1, 2)
    unit_mass = ((F(2), F(1)), (F(1), F(3)))
    unit_load = (F(11, 10), F(23, 10))
    raw_mass = tuple(tuple(moment**2 * entry for entry in row) for row in unit_mass)
    raw_load = tuple(moment * entry for entry in unit_load)
    mass = tuple(tuple(basis_inverse**2 * entry for entry in row) for row in raw_mass)
    load = tuple(basis_inverse * entry for entry in raw_load)
    coordinates = (current, (load[1] - mass[1][0] * current) / mass[1][1])
    physical = tuple(moment * owned_inverse * value for value in coordinates)
    derivative = unit_mass[1][0] * physical[0] + unit_mass[1][1] * physical[1] - unit_load[1]
    return physical, derivative


@pytest.mark.parametrize("current", [F(1), F(-1), F(1, 10000), F(0)])
def test_exact_model_preserves_current_and_constrained_objective(current):
    physical, derivative = scalar_projection(F(2), F(2), current)
    assert physical[0] == current
    assert physical[1] == (F(23, 10) - current) / 3
    assert derivative == 0


def test_exact_model_rejects_posthoc_field_doubling_and_partial_conversion():
    legacy, _ = scalar_projection(F(1), F(1))
    posthoc, derivative = scalar_projection(F(1), F(2))
    assembly_only, _ = scalar_projection(F(2), F(1))
    assert legacy[0] == F(1, 2)
    assert assembly_only[0] == F(1, 2)
    assert posthoc[0] == 1 and derivative != 0
    assert posthoc[1] == F(6, 5)
    assert scalar_projection(F(1), F(1), F(0)) == scalar_projection(F(2), F(2), F(0))
