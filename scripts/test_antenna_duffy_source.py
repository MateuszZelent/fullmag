"""Interpreted source/algebra regressions; never execute C++ or MFEM."""
import ast
from itertools import permutations, product
import math
from pathlib import Path
import re

import pytest

ROOT = Path(__file__).resolve().parents[1]
CPP = ROOT / "backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp"
VERSION = "fem_oersted_direct_tetra_quadrature.v3"


def source_body():
    text = CPP.read_text(encoding="utf-8")
    return text.split("RuleIntegral integrate_duffy_once(", 1)[1].split("class DirectScalarCoefficient", 1)[0]


def expression(name):
    match = re.search(r"const double " + name + r"\s*=\s*([^;]+);", source_body())
    assert match, f"Missing scalar {name} in Duffy source"
    return match[1]


def scalar(text, variables):
    """Read a tiny arithmetic expression, not executable C++ or arbitrary eval."""
    def walk(node):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            return node.value
        if isinstance(node, ast.Name):
            return variables[node.id]
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            return variables[node.value.id + "." + node.attr]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            return -walk(node.operand)
        if isinstance(node, ast.BinOp):
            a, b = walk(node.left), walk(node.right)
            if isinstance(node.op, ast.Add): return a + b
            if isinstance(node.op, ast.Sub): return a - b
            if isinstance(node.op, ast.Mult): return a * b
            if isinstance(node.op, ast.Div): return a / b
        raise AssertionError(f"Unsupported arithmetic syntax: {ast.dump(node)}")
    return walk(ast.parse(" ".join(text.split()), mode="eval").body)


def test_source_segment_coordinates_cover_unit_interval():
    # MFEM's natural segment is [0,1], not [-1,1].
    for axis in ("xi", "eta", "zeta"):
        for value in (0.0, 0.21132486540518713, 0.7886751345948129, 1.0):
            assert scalar(expression(axis), {axis + "_point.x": value}) == value


def test_source_kernel_matches_target_minus_source():
    match = re.search(r"scale\(cross\(current, ray\),\s*([^;]+)\);", source_body())
    assert match, "Duffy kernel must use the accepted physical current"
    assert match[1].strip() == "-inverse_kernel_denominator(ray_norm)"
    body = CPP.read_text(encoding="utf-8").split("double inverse_kernel_denominator(", 1)[1].split("bool target_error_fits", 1)[0]
    denominator = re.search(r"const double denominator\s*=\s*([^;]+);", body)
    assert denominator
    multiplier = -1.0 / scalar(denominator[1], {"kPi": math.pi, "distance": 2.0})
    assert multiplier == -1.0 / (4.0 * math.pi * 8.0)


def test_source_weight_has_no_radial_or_domain_rescaling():
    for xi in (0.0, 0.1, 0.9, 1.0):
        variables = {"jacobian": 7.0, "xi": xi, "eta": 0.25,
                     "xi_point.weight": 0.5, "eta_point.weight": 0.3,
                     "zeta_point.weight": 0.7}
        assert scalar(expression("weight"), variables) == pytest.approx(7 * 0.25 * 0.5 * 0.3 * 0.7)


def add(a, b): return tuple(x + y for x, y in zip(a, b))
def sub(a, b): return tuple(x - y for x, y in zip(a, b))
def mul(a, k): return tuple(x * k for x in a)
def dot(a, b): return math.fsum(x * y for x, y in zip(a, b))
def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])
def det(a, b, c): return dot(a, cross(b, c))


def ray(edges, eta, zeta):
    a, b, c = edges
    return add(mul(a, 1 - eta), add(mul(b, eta * (1 - zeta)), mul(c, eta * zeta)))


GAUSS3 = tuple(zip(((1 - math.sqrt(3 / 5)) / 2, 0.5, (1 + math.sqrt(3 / 5)) / 2),
                   (5 / 18, 4 / 9, 5 / 18)))


@pytest.mark.parametrize("edges", [((2., 0., 0.), (0., 3., 0.), (0., 0., 4.)),
    ((2., 1., -1.), (-1., 3., 0.), (0.5, -1., 4.))])
def test_analytic_jacobian_and_volume(edges):
    # Independent map derivatives and exact simplex zeroth/first moments.
    for ordered in permutations(edges):
        d = abs(det(*ordered))
        volume_terms, moment_terms = [], [[], [], []]
        a, b, c = ordered
        for (xi, wx), (eta, wy), (zeta, wz) in product(GAUSS3, repeat=3):
            q = ray(ordered, eta, zeta)
            q_eta = sub(add(mul(b, 1 - zeta), mul(c, zeta)), a)
            q_zeta = mul(sub(c, b), eta)
            derivative_det = abs(det(q, mul(q_eta, xi), mul(q_zeta, xi)))
            assert derivative_det == pytest.approx(d * xi * xi * eta, rel=2e-14)
            w = derivative_det * wx * wy * wz
            volume_terms.append(w)
            for component in range(3): moment_terms[component].append(xi * q[component] * w)
        assert math.fsum(volume_terms) == pytest.approx(d / 6, rel=2e-14)
        for component in range(3):
            centroid = (a[component] + b[component] + c[component]) / 4
            assert math.fsum(moment_terms[component]) == pytest.approx(d / 6 * centroid, rel=2e-14)


@pytest.mark.parametrize("xi", [1e-5, 0.25, 0.9])
def test_regular_integrand_matches_unsimplified_biot_savart(xi):
    edges = ((2., 1., -1.), (-1., 3., 0.), (0.5, -1., 4.))
    target, eta, zeta = (10., -3., 2.), 0.37, 0.61
    q = ray(edges, eta, zeta)
    # Evaluate displacement directly from map, without coordinate subtraction.
    displacement = mul(q, -xi)
    physical = add(target, mul(q, xi))
    current = add((0.3, -0.2, 0.7), mul(sub(physical, target), 0.17))
    d, distance = abs(det(*edges)), math.hypot(*displacement)
    original = mul(cross(current, displacement), d * xi * xi * eta / (4 * math.pi * distance**3))
    regular = mul(cross(current, q), -d * eta / (4 * math.pi * math.hypot(*q)**3))
    assert regular == pytest.approx(original, rel=2e-14, abs=1e-15)


def test_affine_radial_moment_zero_reversal_and_scaling():
    q, d, eta = (0.7, 1.3, 2.1), 5.0, 0.4
    current_at_target, gradient_on_ray = (1.0, -2.0, 0.7), (0.2, 0.1, -0.4)
    factor = -d * eta / (4 * math.pi * math.hypot(*q)**3)
    expected = mul(cross(add(current_at_target, mul(gradient_on_ray, 0.5)), q), factor)
    for amplitude in (0.0, -1.0, 1e-12, 2.0):
        terms = [mul(cross(mul(add(current_at_target, mul(gradient_on_ray, xi)), amplitude), q), factor * w)
                 for xi, w in GAUSS3]
        result = tuple(math.fsum(row[c] for row in terms) for c in range(3))
        assert result == pytest.approx(mul(expected, amplitude), rel=2e-14, abs=1e-28)


def test_corrected_operator_identity_is_shared_and_archives_not_relabelled():
    header = CPP.with_suffix(".hpp").read_text(encoding="utf-8")
    ir = (ROOT / "crates/fullmag-ir/src/antenna.rs").read_text(encoding="utf-8")
    abi = (ROOT / "backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp").read_text(encoding="utf-8")
    codec = (ROOT / "crates/fullmag-runner/src/native_fem/accepted_external_lead/record.rs").read_text(encoding="utf-8")
    assert VERSION in header and VERSION in ir
    assert 'schema_version\\\":\\\"%s' in abi
    assert "pub quadrature_operator_version: String" in codec
    assert '"fem_oersted_direct_tetra_quadrature.v1"' in codec
    assert '"fem_oersted_direct_tetra_quadrature.v2"' in codec
    assert "fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION" in codec
    binding = codec.split("fn bind_preflighted_request(", 1)[1]
    assert re.search(r"bundle\.field\.quadrature_operator_version\s*==\s*fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION", binding)


def test_materialized_input_pin_and_adapter_require_current_policy():
    module = (ROOT / "crates/fullmag-ir/src/antenna_current_source.rs").read_text(encoding="utf-8")
    planner = (ROOT / "crates/fullmag-plan/src/antenna_current_source.rs").read_text(encoding="utf-8")
    adapter = (ROOT / "crates/fullmag-runner/src/native_fem/accepted_external_lead/input.rs").read_text(encoding="utf-8")
    assert '"external_lead_direct_defaults.unqualified.v3"' in module
    assert "policy_version: fullmag_ir::antenna_current_source::ANTENNA_EXTERNAL_LEAD_DIRECT_POLICY_VERSION.into()" in planner
    assert "solver_sampling_sha256: pin(&(s, &policy, field_sampling))?" in planner
    assert "input.direct_field_policy.policy_version" in adapter
    assert "ANTENNA_EXTERNAL_LEAD_DIRECT_POLICY_VERSION" in adapter
    assert "input.direct_field_policy.relative_scale_floor_apm == 0.0" in adapter
