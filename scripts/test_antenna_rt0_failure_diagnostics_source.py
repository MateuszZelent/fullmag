"""Source-only failure diagnostics checks; no native execution or physics proof."""
import re
from pathlib import Path


def local_gate():
    text = (Path(__file__).resolve().parents[1] /
        "backends/fem/cpu/mfem/transport/conservative_current_view.cpp").read_text(encoding="utf-8")
    body = text.split("TerminalConstrainedRt0Projection::Ptr project_terminal_constrained_rt0_owned(", 1)[1]
    body = body.split("ConservativeCurrentView::Ptr ConservativeCurrentView::Build(", 1)[0]
    return body.split("if (row.side_count == 2) {", 1)[1].split("} else {", 1)[0]


def test_diagnostic_is_failure_only_and_preserves_exact_continuity_predicate():
    body = local_gate()
    assert "const double tolerance = 1.0e-18 + 1.0e-10 * scale;" in body
    branch = re.search(r"if \(!\((.*?)\)\)\s*\{(.*)\}", body, re.S)
    assert branch is not None
    assert " ".join(branch[1].split()) == (
        "std::isfinite(row.canonical_jump_a) && std::isfinite(scale) && "
        "std::isfinite(tolerance) && std::abs(row.canonical_jump_a) <= tolerance")
    assert "std::ostringstream message;" in branch[2]
    assert "reject(message.str());" in branch[2]
    for forbidden in ("return;", "continue;", "std::cout", "roundoff_floor", "epsilon()"):
        assert forbidden not in body


def test_failure_identifies_face_and_physical_measurements_at_binary64_precision():
    body = local_gate()
    assert "std::setprecision(17)" in body
    for label in ("face_ids=[", "lex_first_outward_a=", "lex_second_outward_a=",
                  "canonical_jump_a=", "scale_a=", "tolerance_a="):
        assert label in body
    assert "canonical_jump_order=MFEM_Elem1_minus_Elem2" in body
    for field in ("row.key[0]", "row.key[1]", "row.key[2]", "row.side1_flux_a",
                  "row.side2_flux_a", "row.canonical_jump_a"):
        assert field in body
    assert "terminal RT0 projection failed its local interior continuity gate" in body
