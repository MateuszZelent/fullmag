#!/usr/bin/env python3
"""Interpreted wiring checks for shared-domain quadrature provenance.

This check validates source wiring only.  It does not claim MFEM runtime
values; the native regression in
``backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp``
is the gate that compares emitted JSON with ``GetOrder()`` and
``GetNPoints()`` after a native build is available.
"""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ASSEMBLY = ROOT / "backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp"
ASSEMBLY_HEADER = ROOT / "backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"
MODAL_SOLVER = ROOT / "backends/fem/src/frequency_domain/modal_eigen_solver.cpp"
NATIVE_REGRESSION = ROOT / "backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp"
MODAL_CONTRACT_REGRESSION = ROOT / "backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _require(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise AssertionError(f"missing {label}: {needle}")


def _require_after(text: str, earlier: str, later: str, label: str) -> None:
    earlier_index = text.find(earlier)
    later_index = text.find(later)
    if earlier_index < 0 or later_index < 0 or later_index <= earlier_index:
        raise AssertionError(f"missing ordered {label}: {earlier} -> {later}")


def _append_json_field_contract(json_text: str, field: str) -> str:
    """Model the bounded append contract for the interpreted regression."""
    end = len(json_text)
    while end and json_text[end - 1] in " \t\n\r":
        end -= 1
    if not field or not json_text or end == 0 or json_text[end - 1] != "}":
        return json_text
    begin = 0
    while begin < end and json_text[begin] in " \t\n\r":
        begin += 1
    if begin == end or json_text[begin] != "{":
        return json_text
    content_end = end - 1
    while content_end > begin + 1 and json_text[content_end - 1] in " \t\n\r":
        content_end -= 1
    prefix = json_text[: end - 1]
    separator = "," if content_end > begin + 1 else ""
    return prefix + separator + field + "}" + json_text[end:]


def _run_append_json_contract_regression() -> None:
    nested = (
        '{"operator_diagnostics":{"shared_domain_operator_provenance":'
        '{"scope":"nested"}}}'
    )
    top_level = '{"shared_domain_operator_provenance":{"scope":"top"}}'
    if "shared_domain_operator_provenance" not in nested:
        raise AssertionError("nested regression fixture is malformed")
    if "shared_domain_operator_provenance" in json.loads(nested):
        raise AssertionError("nested provenance key must not count as top-level")
    if "shared_domain_operator_provenance" not in json.loads(top_level):
        raise AssertionError("top-level provenance key fixture is malformed")

    appended = _append_json_field_contract(
        '{"status":"ok"} \n\t',
        '"shared_domain_operator_provenance":{"scope":"top"}',
    )
    if not appended.endswith("} \n\t"):
        raise AssertionError("trailing JSON whitespace must be preserved")
    parsed = json.loads(appended)
    if parsed["shared_domain_operator_provenance"]["scope"] != "top":
        raise AssertionError("trailing-whitespace append must create a top-level field")

    empty_object = _append_json_field_contract(
        "{ \n } \t",
        '"shared_domain_operator_provenance":{"scope":"empty"}',
    )
    empty_parsed = json.loads(empty_object)
    if empty_parsed["shared_domain_operator_provenance"]["scope"] != "empty":
        raise AssertionError("whitespace-only JSON object must accept a first field")


def main() -> None:
    assembly = _read(ASSEMBLY)
    header = _read(ASSEMBLY_HEADER)
    modal_solver = _read(MODAL_SOLVER)
    native_regression = _read(NATIVE_REGRESSION)
    modal_contract_regression = _read(MODAL_CONTRACT_REGRESSION)

    _require(header, "std::string quadrature_provenance_json{}", "assembly sidecar")
    _require(assembly, "struct QuadratureProvenanceKey", "deterministic provenance key")
    _require(assembly, "std::map<QuadratureProvenanceKey, std::uint64_t>", "aggregated entries")
    _require(assembly, "frequency_domain_p1_quadrature(*finite_element)", "shared rule selection")
    _require(assembly, "const int resolved_quadrature_order = rule.GetOrder();", "resolved order")
    _require(assembly, "const int rule_npoints = rule.GetNPoints();", "runtime point count")
    _require(assembly, "quadrature_entries[QuadratureProvenanceKey{", "same-loop aggregation")
    _require(assembly, "out_result->quadrature_provenance_json = quadrature_provenance_json(", "assembly export")
    _require(assembly, '"schema_version\\\":\\\"poisson_airbox_shared_domain_quadrature.v1', "provenance schema")
    _require(modal_solver, "shared_domain_operator_provenance_json", "diagnostic producer")
    _require(modal_solver, "bool json_has_top_level_field(", "top-level JSON guard")
    _require(modal_solver, "const std::string trailing_whitespace = json.substr(json_end);", "trailing-whitespace preservation")
    _require(modal_solver, "std::size_t object_content_end = json_end - 1u;", "empty-object detection")
    _require(modal_solver, "const bool object_has_members = object_content_end > object_begin + 1u;", "empty-object separator guard")
    _require(modal_solver, '"publisher_lane\\\":\\\"fem_cpu\\\"', "CPU publisher scope")
    _require(modal_solver, "append_shared_domain_operator_provenance", "diagnostic consumer")
    _require(modal_solver, "json_has_top_level_field(result.diagnostics_json, kFieldName)", "diagnostic top-level guard")
    _require(modal_solver, "json_has_top_level_field(result.result_json, kFieldName)", "result top-level guard")
    _require(modal_solver, '"operator_digest\\\":\\\"', "digest beside quadrature")
    _require(modal_solver, "std::string k0_shared_domain_provenance", "caller-scoped K0 sidecar")
    _require(modal_solver, "std::string assembled_operator_provenance", "Floquet sidecar")
    _require(modal_solver, "native_floquet_sparse_assembly", "native Floquet assembly result")
    _require(modal_solver, '"floquet_sparse_shared_domain_assembly"', "native Floquet scope")
    _require(modal_solver, '"floquet_legacy_dynamic_demag_k_assembly"', "legacy Floquet scope")
    _require(modal_solver, '"k0_shared_domain_assembly"', "K0 scope")
    _require(modal_solver, "result, assembled_operator_provenance);", "nonzero-k result binding")
    _require_after(
        modal_solver,
        "native_floquet_sparse_assembly.floquet_sparse_operator_ready",
        '"floquet_sparse_shared_domain_assembly"',
        "sparse provider provenance after successful assembly",
    )
    _require_after(
        modal_solver,
        "provider_result.real_split_row_major.empty()",
        '"floquet_legacy_dynamic_demag_k_assembly"',
        "legacy provider provenance after successful assembly",
    )
    _require(native_regression, "result.quadrature_provenance_json", "tetra native regression")
    _require(native_regression, "mixed_shared_result.quadrature_provenance_json", "prism native regression")
    _require(native_regression, "floquet_reciprocity_result.operator_digest", "Floquet digest fixture")
    _require(native_regression, "floquet_reciprocity_result.quadrature_provenance_json", "Floquet provenance fixture")
    _require(native_regression, "tetra_order5.GetNPoints()", "tetra runtime oracle")
    _require(native_regression, "prism_order4.GetNPoints()", "prism runtime oracle")
    _require(
        modal_contract_regression,
        "kNestedOperatorDiagnostics",
        "nested operator-diagnostics native fixture",
    )
    _require(
        modal_contract_regression,
        "modal solver must append assembled provenance at the diagnostics top level",
        "native top-level provenance assertion",
    )

    # The runtime point count must come from MFEM, never from a diagnostic
    # literal that can become stale when MFEM changes its rule catalogue.
    if '"rule_npoints\\\":14' in assembly or '"rule_npoints\\\":18' in assembly:
        raise AssertionError("production provenance must not hardcode MFEM point counts")

    _run_append_json_contract_regression()
    print("shared-domain quadrature provenance wiring: PASS (source-only)")


if __name__ == "__main__":
    main()
