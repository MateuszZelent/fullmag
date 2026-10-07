"""Source and exact-model checks; not execution of MFEM or the C++ helper."""
from fractions import Fraction as F
from itertools import permutations
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
OWNER = ROOT / "backends/fem/cpu/mfem/transport/affine_rt0_element.cpp"


def owner_source():
    assert OWNER.is_file(), "Shared affine RT0 owner is missing"
    return OWNER.read_text(encoding="utf-8")


def test_objective_certificate_and_h_share_the_mathematical_basis():
    owner_source()
    transport = (OWNER.parent / "conservative_current_view.cpp").read_text(encoding="utf-8")
    oersted = (OWNER.parent.parent / "interactions/oersted/direct_tetra_quadrature.cpp").read_text(encoding="utf-8")
    assert "basis.basis_value_at(physical_point, i)" in transport
    assert "elements.at(element1).face_moment(face_points)" in transport
    assert "elements.at(element2).face_moment(face_points)" in transport
    assert "element.current_at(physical_point)" in oersted
    assert "GetVectorValue" not in transport and "GetVectorValue" not in oersted
    assert "CalcVShape(*transformation, vshape)" not in transport
    assert "InverseElementTransformation" not in oersted


def test_preflight_is_typed_and_exact_moment_keeps_all_four_terms():
    text = owner_source()
    for token in ("RT_TetrahedronElement", "GetOrder() == 1", "GetDof() == 4",
                  "GetMapType()", "GetRangeType()", "Nonconforming()", "GetNodes()",
                  "GetVDim() == 1", "GetElementDofs", "dof_transform == nullptr",
                  "face_vertices", "opposite", "cpp_rational", "signed_coefficients_",
                  "local < 4", "vertex < 3", "exact_sum", "convert_to<double>()"):
        assert token in text
    assert "epsilon" not in text.split("double AffineRt0Element::face_moment", 1)[1]
    assert "GetFaceDofs" not in text.split("double AffineRt0Element::face_moment", 1)[1]


def test_h_prepares_geometry_and_coefficients_before_inner_quadrature():
    text = owner_source()
    body = text.split("AffineRt0Element::Point AffineRt0Element::current_at", 1)[1].split(
        "double AffineRt0Element::face_moment", 1)[0]
    for forbidden in ("cpp_rational", "GetElementDofs", "new ", "GetVectorValue"):
        assert forbidden not in body
    oersted = (OWNER.parent.parent / "interactions/oersted/direct_tetra_quadrature.cpp").read_text(encoding="utf-8")
    assert "elements.push_back({CurrentElement(rt0_field, element), element_vertices(mesh, element)})" in oersted
    coefficient = oersted.split("class DirectScalarCoefficient", 1)[1].split("struct Leaf", 1)[0]
    assert "evaluate_prepared(source_, targets, options_, work_)" in coefficient
    assert "EvaluateField(" not in coefficient and "prepare_source(" not in coefficient
    projection = oersted.split("DirectTetraQuadrature::ProjectField", 1)[1]
    assert projection.index("const auto elements = prepare_source") < projection.index("for (int component = 0;")
    assert "elements, options, component" in projection
    public_field = oersted.split("DirectTetraQuadrature::EvaluateField", 1)[1].split(
        "DirectTetraQuadrature::ProjectField", 1)[0]
    assert public_field.index("validate_pair_budget(") < public_field.index("prepare_source(")
    cmake = (ROOT / "backends/fem/CMakeLists.txt").read_text(encoding="utf-8")
    assert cmake.count("cpu/mfem/transport/affine_rt0_element.cpp") == 2


def test_field_snapshot_cannot_dereference_null_space_or_silently_use_zero_coefficients():
    text = owner_source()
    assert ": AffineRt0Element(checked_space(field), element)" in text
    assert text.index("field.FESpace() != nullptr") < text.index("return *field.FESpace()")
    assert "coefficients_frozen_ = true" in text
    for method in ("current_at", "face_moment"):
        body = text.split(f"AffineRt0Element::{method}", 1)[1].split("\n}", 1)[0]
        assert "require(coefficients_frozen_" in body
    assert text.count("value == 0.0L || result[component] != 0.0") == 2


def sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def exact_weights(vertices, face):
    vertices = tuple(tuple(F(x) for x in v) for v in vertices)
    face = tuple(tuple(F(x) for x in v) for v in face)
    det = abs(dot(sub(vertices[1], vertices[0]), cross(
        sub(vertices[2], vertices[0]), sub(vertices[3], vertices[0]))))
    if det == 0:
        raise ValueError("degenerate")
    area = tuple(x / 2 for x in cross(sub(face[1], face[0]), sub(face[2], face[0])))
    return tuple(sum(dot(sub(p, v), area) for p in face) / (3 * det) for v in vertices)


UNIT = ((0., 0., 0.), (1., 0., 0.), (0., 1., 0.), (0., 0., 1.))


@pytest.mark.parametrize("orientation", [1, -1])
def test_point_basis_matches_piola_and_unit_flux_mass_load_scaling(orientation):
    # Independent affine Piola construction, including a reflected map.
    columns = ((F(2), F(1, 4), F(0)), (F(0), F(3), F(1, 8)),
               (F(1, 2), F(0), F(orientation)))
    offset = (F(13), F(-7), F(3))
    transform = lambda point: tuple(offset[d] + sum(columns[k][d] * F(point[k])
                                                   for k in range(3)) for d in range(3))
    vertices = tuple(transform(vertex) for vertex in UNIT)
    determinant = abs(dot(columns[0], cross(columns[1], columns[2])))
    reference_point = (F(1, 8), F(1, 4), F(1, 2))
    point = transform(reference_point)
    raw = (F(3), F(-2), F(1))
    coefficients = (F(2), F(-4), F(7), F(1, 10**20))
    current = [F(0)] * 3
    for i in range(4):
        reference_shape = sub(reference_point, tuple(F(c) for c in UNIT[i]))
        piola = tuple(sum(columns[k][d] * reference_shape[k] for k in range(3)) /
                      determinant for d in range(3))
        geometric = tuple(component / determinant for component in sub(point, vertices[i]))
        assert geometric == piola
        assert dot(tuple(2 * c for c in geometric), raw) == 2 * dot(piola, raw)
        for j in range(4):
            other = tuple(component / determinant for component in sub(point, vertices[j]))
            assert dot(tuple(2 * c for c in geometric), tuple(2 * c for c in other)) == 4 * dot(geometric, other)
        for d in range(3):
            current[d] += coefficients[i] * geometric[d]
    assert tuple(current) == tuple(sum(coefficients[i] * (point[d] - vertices[i][d])
                                      for i in range(4)) / determinant for d in range(3))


@pytest.mark.parametrize("scale,offset", [(1., 0.), (2.**-30, 2.**-15), (2.**30, -2.**40)])
def test_exact_all_basis_moments_under_skew_scale_translation_and_permutation(scale, offset):
    # Dyadic skew map, not axis-aligned and not tied to the native fixed fixture.
    vertices = tuple((offset + scale * (x + y / 4),
                      offset + scale * (y + z / 8), offset + scale * z)
                     for x, y, z in UNIT)
    for order in permutations(range(4)):
        local = tuple(vertices[i] for i in order)
        for opposite in range(4):
            face = tuple(local[i] for i in range(4) if i != opposite)
            weights = exact_weights(local, face)
            assert abs(weights[opposite]) == F(1, 2)
            assert all(value == 0 for i, value in enumerate(weights) if i != opposite)
            assert abs(2 * weights[opposite]) == 1


@pytest.mark.parametrize("current", [F(1), F(-1), F(1, 10**4), F(-1, 10**4), F(0), F(1, 10**20)])
def test_adjacent_full_basis_reconstruction_preserves_signed_and_tiny_flux(current):
    face = UNIT[1:]
    second = ((1., 1., 1.),) + face
    w1, w2 = exact_weights(UNIT, face), exact_weights(second, face)
    # Both sides reconstruct every row; arbitrary tangential contributions remain.
    c1 = (current / w1[0], F(.1), F(.2), F(-.3))
    c2 = (current / w2[0], F(-.7), F(.9), F(.4))
    moment1 = sum(c * w for c, w in zip(c1, w1))
    moment2 = sum(c * w for c, w in zip(c2, w2))
    assert moment1 == moment2 == current
    assert sum(c * w for c, w in zip(c2, tuple(-w for w in w2))) == -current
    if current:
        assert moment1 != 0


def test_exact_geometry_rejects_degenerate_tetrahedron():
    with pytest.raises(ValueError, match="degenerate"):
        exact_weights(UNIT[:3] + (UNIT[0],), UNIT[1:])
