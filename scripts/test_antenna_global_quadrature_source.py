"""Independent ledger model and source guards, not execution of native FEM."""
from dataclasses import dataclass
import math
from fractions import Fraction
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
OWNER = ROOT / "backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp"


@dataclass(frozen=True)
class Leaf:
    high: tuple
    error: float
    terms: float = 0.0
    depth: int = 0
    depth_limit: int = 1
    unresolved: bool = False


def global_model(roots, split, atol, rtol=0., leaf_limit=1000, step_limit=100):
    """Recompute all final leaves independently of production incremental sums."""
    leaves = list(roots)
    steps = 0
    while True:
        h = tuple(math.fsum(leaf.high[c] for leaf in leaves) for c in range(3))
        error = math.fsum(leaf.error for leaf in leaves)
        indicator = 2**-52 * math.fsum(leaf.terms + math.hypot(*leaf.high) for leaf in leaves)
        tolerance = atol + rtol * math.hypot(*h)
        if not any(leaf.unresolved for leaf in leaves) and error + indicator <= tolerance:
            return h, error, indicator, tolerance, leaves, steps
        candidates = [(i, leaf) for i, leaf in enumerate(leaves) if leaf.depth < leaf.depth_limit]
        if not candidates: raise ValueError("depth_exhausted")
        if not any(leaf.unresolved or leaf.error > 0 for _, leaf in candidates):
            raise ValueError("roundoff_indicator_exceeds_tolerance")
        if len(leaves) + 7 > leaf_limit: raise ValueError("leaf_budget_exceeded")
        if steps >= step_limit: raise ValueError("work_budget_exceeded")
        index, leaf = max(candidates, key=lambda item: (item[1].unresolved, item[1].error, -item[0]))
        children = list(split(leaf))
        assert len(children) == 8
        leaves[index:index + 1] = children
        steps += 1


def children(leaf, error, high=None):
    h = leaf.high if high is None else high
    return [Leaf(tuple(v / 8 for v in h), error, leaf.terms / 8,
                 leaf.depth + 1, leaf.depth_limit) for _ in range(8)]


def test_many_locally_small_errors_do_not_share_full_target_budget():
    roots = [Leaf((1., 0., 0.), 0.6), Leaf((1., 0., 0.), 0.6)]
    result = global_model(roots, lambda leaf: children(leaf, 0.01), 1.)
    assert result[1] == pytest.approx(0.68)
    assert len(result[4]) == 9 and result[5] == 1


def test_cancelling_sources_use_final_field_not_sum_of_source_norms():
    roots = [Leaf((10., 0., 0.), 1e-3), Leaf((-10. + 1e-9, 0., 0.), 1e-3)]
    result = global_model(roots, lambda leaf: children(leaf, 1e-10), 1e-8, 1e-6)
    assert result[5] == 2
    assert result[3] < 1.000001e-8


def test_eight_children_must_share_one_parent_budget():
    with pytest.raises(ValueError, match="depth_exhausted"):
        global_model([Leaf((1., 0., 0.), 0.9)], lambda leaf: children(leaf, 0.03), 0.1)


def test_depth_blocked_leaf_does_not_preempt_other_improvements():
    roots = [Leaf((1., 0., 0.), 0.03, depth_limit=0), Leaf((1., 0., 0.), 0.4)]
    result = global_model(roots, lambda leaf: children(leaf, 0.001), 0.05)
    assert result[1] == pytest.approx(0.038)
    assert result[5] == 1


def test_final_tolerance_is_recomputed_after_pilot_changes():
    with pytest.raises(ValueError, match="depth_exhausted"):
        global_model([Leaf((100., 0., 0.), 1.2)],
                     lambda leaf: children(leaf, 0.1, (1., 0., 0.)), 0., 0.01)


def test_unresolved_leaf_never_enters_infinite_arithmetic_or_acceptance():
    result = global_model([Leaf((0., 0., 0.), 0., unresolved=True)],
                          lambda leaf: children(leaf, 0.), 0.)
    assert result[5] == 1 and result[1] == 0. and all(not x.unresolved for x in result[4])


def test_roundoff_indicator_does_not_get_a_dimensional_floor():
    assert global_model([Leaf((0., 0., 0.), 0.)], None, 0.)[3] == 0.
    with pytest.raises(ValueError, match="roundoff_indicator"):
        global_model([Leaf((1., 0., 0.), 0.), Leaf((-1., 0., 0.), 0.)], None, 0., 1e-5)


@pytest.mark.parametrize("leaf_limit,step_limit,reason", [(7, 100, "leaf_budget"), (100, 0, "work_budget")])
def test_resource_exhaustion_is_not_partial_success(leaf_limit, step_limit, reason):
    with pytest.raises(ValueError, match=reason):
        global_model([Leaf((1., 0., 0.), 1.)], lambda leaf: children(leaf, 0.), 0.1,
                     leaf_limit=leaf_limit, step_limit=step_limit)


def test_source_uses_final_target_ledger_without_local_stop_tests():
    source = OWNER.read_text(encoding="utf-8")
    assert "integrate_adaptive(" not in source
    assert "std::max(norm(high), 1.0)" not in source
    for token in ("struct Leaf", "needs_refine", "std::push_heap", "std::pop_heap",
                  "recompute_ledger", "estimated_error_apm", "roundoff_indicator_apm",
                  "std::fma", "maximum_final_leaves_per_target"):
        assert token in source
    assert "catch (const SampledSingularity &)" in source
    assert "catch (const std::runtime_error &)" not in source


def test_source_budgets_attempted_samples_and_whole_projection():
    source = OWNER.read_text(encoding="utf-8")
    ordinary = source.split("RuleIntegral integrate_once(", 1)[1].split("child_indices()", 1)[0]
    duffy = source.split("RuleIntegral integrate_duffy_once(", 1)[1].split("class DirectScalarCoefficient", 1)[0]
    assert ordinary.index("work.sample()") < ordinary.index("evaluate_current(")
    assert duffy.index("work.sample()") < duffy.index("evaluate_current(")
    assert "work.visit()" in source
    projection = source.split("DirectTetraQuadrature::ProjectField(", 1)[1]
    assert projection.index("WorkBudget work;") < projection.index("for (int component = 0;")
    assert "elements, options, component, work" in projection
    assert "kernel_evaluations >= DirectTetraQuadrature::maximum_kernel_evaluations" in source


def test_source_version_and_policy_expose_no_relative_floor():
    header = OWNER.with_suffix(".hpp").read_text(encoding="utf-8")
    ir = (ROOT / "crates/fullmag-ir/src/antenna.rs").read_text(encoding="utf-8")
    planner = (ROOT / "crates/fullmag-plan/src/antenna_current_source.rs").read_text(encoding="utf-8")
    adapter = (ROOT / "crates/fullmag-runner/src/native_fem/accepted_external_lead/input.rs").read_text(encoding="utf-8")
    assert "fem_oersted_direct_tetra_quadrature.v3" in header and "fem_oersted_direct_tetra_quadrature.v3" in ir
    assert "relative_scale_floor_apm: 0." in planner
    assert "input.direct_field_policy.relative_scale_floor_apm == 0.0" in adapter


@pytest.mark.parametrize("error,roundoff,tolerance", [
    (1., 2.**-100, 1.), (1., 2.**-1074, 1.), (0.5, 0.5, 1.),
    (math.nextafter(1., 0.), 2.**-54, 1.), (math.nextafter(1., 0.), 2.**-52, 1.),
    (0., 0., 0.), (1e300, 1e-300, 1e300)])
def test_binary64_target_gate_keeps_sub_ulp_positive_residual(error, roundoff, tolerance):
    # Independent rational oracle for the retained binary64 values.
    larger, smaller = max(error, roundoff), min(error, roundoff)
    rounded = larger + smaller
    residual = smaller - (rounded - larger)
    accepted = rounded < tolerance or rounded == tolerance and residual <= 0.
    assert accepted == (Fraction(error) + Fraction(roundoff) <= Fraction(tolerance))
    source = OWNER.read_text(encoding="utf-8")
    rust = (ROOT / "crates/fullmag-runner/src/native_fem/accepted_external_lead/record.rs").read_text(encoding="utf-8")
    producer = (ROOT / "backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_external_lead_source.cpp").read_text(encoding="utf-8")
    for text in (source, rust, producer):
        assert "smaller - (sum - larger)" in text and "residual <= 0.0" in text


def test_kernel_range_guard_rejects_false_zero_from_overflow():
    distance = 1e105
    denominator = 4 * math.pi * distance * distance * distance
    assert not math.isfinite(denominator) and 1 / denominator == 0.
    # True scale is representable: the dangerous intermediate is not.
    assert Fraction.from_float(1e205) / (Fraction.from_float(distance)**3) > 0
    source = OWNER.read_text(encoding="utf-8")
    guard = source.split("double inverse_kernel_denominator(", 1)[1].split("bool target_error_fits", 1)[0]
    for token in ("std::isfinite(denominator)", "denominator > 0.0", "std::isfinite(inverse)", "inverse > 0.0"):
        assert token in guard
    assert source.count("inverse_kernel_denominator(distance)") == 1
    assert source.count("-inverse_kernel_denominator(ray_norm)") == 1
