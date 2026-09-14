"""Regression tests for fail-closed benchmark gate aggregation."""
from pathlib import Path
import sys
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_comsol_dispersion_scientific_gate import validate_requested_cases

CASES = ("c0", "c1", "a1")


@pytest.mark.parametrize("status", ["not_qualified", "failed", "unknown", None])
@pytest.mark.parametrize("reasons", [[], None, "missing evidence"])
def test_nonqualified_child_never_qualifies_even_without_reason_list(status, reasons):
    children = {case: {"status": "qualified", "reasons": []} for case in CASES}
    children["c1"] = {"status": status, "reasons": reasons}
    result = validate_requested_cases(children, CASES)
    assert result["status"] == "not_qualified"
    assert result["qualification"] == "NOT VERIFIED"
    assert result["reasons"]


def test_missing_child_never_qualifies():
    children = {case: {"status": "qualified", "reasons": []} for case in ("c0", "c1")}
    assert validate_requested_cases(children, CASES)["status"] == "not_qualified"


@pytest.mark.parametrize("reasons", [["missing phase"], "missing phase", None, {}])
def test_qualified_child_with_invalid_reason_list_is_rejected(reasons):
    children = {case: {"status": "qualified", "reasons": []} for case in CASES}
    children["a1"]["reasons"] = reasons
    assert validate_requested_cases(children, CASES)["status"] == "not_qualified"
