"""Partial synthetic observable binding checks, not native bundle qualification."""
import hashlib
import math
from pathlib import Path

import pytest

from scripts import antenna_rt0_fixture_check as check
from scripts.compare_managed_antenna_ram import reconstruct_inputs
from scripts.test_antenna_rt0_fixture_check import synthetic_bundle, encode, change


@pytest.fixture(scope="module")
def inputs():
    repo = Path(__file__).resolve().parents[1]
    return reconstruct_inputs(repo, repo / "examples/fem_antenna_current_source_inspection.py")


def observable_export(inputs, mutation=None, *, version="fem_oersted_direct_tetra_quadrature.v1"):
    def charge_mutation(charge, source):
        if mutation == "embedded_V":
            change(charge, "potential_v", 123.0)
    outer = check.fields(synthetic_bundle(inputs, charge_mutation))
    values = {"device_ids": list(range(1, 17)), "potential_v": [0.0] * 16,
              "positions_m": inputs["probe_mesh"]["nodes"],
              "field_apm": [[float(i), float(i + 1), float(i + 2)] for i in range(4)]}
    global_target = version == "fem_oersted_direct_tetra_quadrature.v3"
    field = [("schema", 1, "accepted_external_lead_field.ordered.v2" if global_target else
              "accepted_external_lead_field.ordered.v1"),
             ("operator_version", 1, "fem_accepted_external_lead_field.v2" if global_target else
              "fem_accepted_external_lead_field.v1"),
             ("quadrature_operator_version", 1, version),
             ("field_scope", 1, "external_electrode_truncation"),
             ("accepted_external_source_digest", 1, check.one(outer, "source_content_sha256", 1)),
             ("charge_content_digest", 1, check.one(outer, "charge_content_sha256", 1)),
             ("base_quadrature_order", 2, 4), ("maximum_subdivision_depth", 2, 6),
             ("absolute_tolerance_apm", 4, 1e-9), ("relative_tolerance", 4, 1e-5),
             ("relative_scale_floor_apm", 4, 0.0 if global_target else 1.0),
             ("maximum_source_target_pairs", 2, 1000000)]
    if global_target:
        field += [("quadrature_scope", 1, "global_target"),
                  ("estimated_error_policy", 1, "sum_final_leaf_l2_difference.v1"),
                  ("roundoff_indicator_policy", 1, "weighted_terms_binary64_epsilon.v1"),
                  ("maximum_final_leaves_per_target", 2, 1000000),
                  ("maximum_kernel_evaluations", 2, 100000000),
                  ("maximum_ledger_leaf_visits", 2, 100000000)]
    field += [("target_count", 2, 4)]
    for point, vector in zip(values["positions_m"], values["field_apm"]):
        field += [("target_coordinate_m", 4, v) for v in point]
        field += [("h_component_apm", 4, v) for v in vector]
        if global_target:
            # Zero relative tolerance makes the synthetic retained budget exact
            # without treating Python's norm implementation as native evidence.
            field += [("target_estimated_error_apm", 4, 1e-10),
                      ("target_tolerance_apm", 4, 1e-9),
                      ("target_roundoff_indicator_apm", 4, 1e-12),
                      ("target_final_leaf_count", 2, 36),
                      ("target_kernel_evaluations", 2, 72),
                      ("target_ledger_leaf_visits", 2, 36)]
    field += [("source_target_pairs", 2, 144), ("refined_pairs", 2, 0),
              ("unconverged_pair_count", 2, 0), ("maximum_pair_error_apm", 4, 0.0)]
    if global_target:
        change(field, "relative_tolerance", 0.0)
        field += [("kernel_evaluations", 2, 288), ("ledger_leaf_visits", 2, 144)]
    if mutation == "embedded_H": change(field, "h_component_apm", 123.0)
    elif mutation == "embedded_xyz": change(field, "target_coordinate_m", 123.0)
    elif mutation == "field_source": change(field, "accepted_external_source_digest", "0" * 64)
    elif mutation == "field_charge": change(field, "charge_content_digest", "0" * 64)
    elif mutation == "field_count": change(field, "target_count", 3)
    elif mutation == "extra_field": field.append(("unexpected", 4, 0.0))
    elif mutation == "field_quadrature_v2": change(field, "quadrature_operator_version", "fem_oersted_direct_tetra_quadrature.v2")
    elif mutation == "field_quadrature_unknown": change(field, "quadrature_operator_version", "fem_oersted_direct_tetra_quadrature.v99")
    data = encode(field)
    change(outer, "field_record", data)
    change(outer, "field_content_sha256", hashlib.sha256(data).hexdigest())
    values["bundle_bytes"] = encode(outer)
    values["nested_content_sha256"] = {name: check.one(outer, name + "_content_sha256", 1)
                                       for name in ("charge", "source", "field")}
    if mutation == "manifest_pin": values["nested_content_sha256"]["charge"] = "0" * 64
    elif mutation == "export_ids": values["device_ids"][0] = 101
    elif mutation == "export_V_count": values["potential_v"].pop()
    elif mutation == "export_negative_zero": values["potential_v"][0] = -0.0
    return values


def rehash_field(values, mutations):
    outer = check.fields(values["bundle_bytes"])
    field = check.fields(check.one(outer, "field_record", 3))
    for name, value in mutations:
        change(field, name, value)
    data = encode(field)
    change(outer, "field_record", data)
    digest = hashlib.sha256(data).hexdigest()
    change(outer, "field_content_sha256", digest)
    values["nested_content_sha256"]["field"] = digest
    values["bundle_bytes"] = encode(outer)
    return values


@pytest.mark.parametrize("mutation,version", [(None, "fem_oersted_direct_tetra_quadrature.v1"),
    ("field_quadrature_v2", "fem_oersted_direct_tetra_quadrature.v2")])
def test_exact_bundle_observable_association_without_promoting_scope(inputs, mutation, version):
    function = getattr(check, "compare_bundle_observables", None)
    assert callable(function), "Independent bundle-observable association is missing"
    result = function(inputs, observable_export(inputs, mutation))
    assert result["comparison"] == "PASS"
    assert result["device_count"] == 16 and result["target_count"] == 4
    assert result["native_canonical_bundle_redecoded"] is False
    assert result["physics_qualified"] is False
    assert result["quadrature_operator_version"] == version
    assert result["retained_global_target_diagnostics"] is None


@pytest.mark.parametrize("mutation", ["embedded_V", "embedded_H", "embedded_xyz",
    "field_source", "field_charge", "field_count", "extra_field", "manifest_pin",
    "export_ids", "export_V_count", "export_negative_zero", "field_quadrature_unknown"])
def test_rehashed_mismatch_is_not_observable_association(inputs, mutation):
    function = getattr(check, "compare_bundle_observables", None)
    assert callable(function), "Independent bundle-observable association is missing"
    with pytest.raises(ValueError, match="observable association"):
        function(inputs, observable_export(inputs, mutation))


def test_v3_exact_h_bytes_exclude_retained_target_diagnostics(inputs):
    values = observable_export(inputs, version="fem_oersted_direct_tetra_quadrature.v3")
    result = check.compare_bundle_observables(inputs, values)
    assert result["comparison"] == "PASS"
    assert result["quadrature_operator_version"] == "fem_oersted_direct_tetra_quadrature.v3"
    assert result["native_canonical_bundle_redecoded"] is False
    assert result["physics_qualified"] is False
    assert result["qualification"] == "NOT VERIFIED"
    diagnostics = result["retained_global_target_diagnostics"]
    assert diagnostics["kernel_evaluations"] == 288
    assert diagnostics["ledger_leaf_visits"] == 144
    assert diagnostics["quadrature_scope"] == "global_target"
    assert diagnostics["estimated_error_policy"] == "sum_final_leaf_l2_difference.v1"
    assert diagnostics["roundoff_indicator_policy"] == "weighted_terms_binary64_epsilon.v1"
    assert diagnostics["maximum_final_leaves_per_target"] == 1000000
    assert diagnostics["maximum_kernel_evaluations"] == 100000000
    assert diagnostics["maximum_ledger_leaf_visits"] == 100000000
    assert len(diagnostics["targets"]) == 4
    assert diagnostics["targets"][0] == {"estimated_error_apm": 1e-10,
        "tolerance_apm": 1e-9, "roundoff_indicator_apm": 1e-12,
        "final_leaf_count": 36, "kernel_evaluations": 72, "ledger_leaf_visits": 36}
    assert diagnostics["exact_native_tolerance_recomputed"] is False
    assert diagnostics["adaptation_history_verified"] is False


@pytest.mark.parametrize("version,name,value", [
    ("v1", "schema", "accepted_external_lead_field.ordered.v2"),
    ("v2", "operator_version", "fem_accepted_external_lead_field.v2"),
    ("v1", "quadrature_operator_version", "fem_oersted_direct_tetra_quadrature.v3"),
    ("v3", "schema", "accepted_external_lead_field.ordered.v1"),
    ("v3", "operator_version", "fem_accepted_external_lead_field.v1"),
    ("v3", "quadrature_operator_version", "fem_oersted_direct_tetra_quadrature.v2"),
    ("v3", "quadrature_operator_version", "fem_oersted_direct_tetra_quadrature.v4"),
    ("v1", "relative_scale_floor_apm", 0.0),
    ("v2", "relative_scale_floor_apm", 0.0),
    ("v3", "relative_scale_floor_apm", 1.0),
], ids=[f"m{i}" for i in range(10)])
def test_rehashed_version_pairing_and_floor_refusal(inputs, version, name, value):
    values = observable_export(inputs, version="fem_oersted_direct_tetra_quadrature." + version)
    with pytest.raises(ValueError, match="observable association"):
        check.compare_bundle_observables(inputs, rehash_field(values, [(name, value)]))


@pytest.mark.parametrize("name,value", [
    ("quadrature_scope", "local_source"),
    ("estimated_error_policy", "sum_final_leaf_l2_difference.v2"),
    ("roundoff_indicator_policy", "weighted_terms_binary64_epsilon.v2"),
    ("maximum_final_leaves_per_target", 1000001),
    ("maximum_kernel_evaluations", 100000001),
    ("maximum_ledger_leaf_visits", 100000001),
    ("target_estimated_error_apm", 2e-9),
    ("target_roundoff_indicator_apm", 2e-9),
    ("target_tolerance_apm", -1e-9),
    ("target_estimated_error_apm", math.nan),
    ("target_roundoff_indicator_apm", math.inf),
    ("target_final_leaf_count", 35),
    ("target_final_leaf_count", 1000001),
    ("target_kernel_evaluations", 71),
    ("target_ledger_leaf_visits", 35),
    ("source_target_pairs", 145),
    ("refined_pairs", 1),
    ("unconverged_pair_count", 1),
    ("kernel_evaluations", 287),
    ("ledger_leaf_visits", 143),
], ids=[f"g{i}" for i in range(20)])
def test_rehashed_v3_retained_diagnostic_contract_refusal(inputs, name, value):
    values = observable_export(inputs, version="fem_oersted_direct_tetra_quadrature.v3")
    with pytest.raises(ValueError):
        check.compare_bundle_observables(inputs, rehash_field(values, [(name, value)]))


def test_v3_positive_roundoff_at_exact_error_budget_is_refused(inputs):
    values = observable_export(inputs, version="fem_oersted_direct_tetra_quadrature.v3")
    error, roundoff = 1e-9, 1e-9 * 2 ** -54
    assert error + roundoff == error
    changed = rehash_field(values, [("target_estimated_error_apm", error),
                                    ("target_roundoff_indicator_apm", roundoff)])
    with pytest.raises(ValueError, match="retained budget"):
        check.compare_bundle_observables(inputs, changed)


@pytest.mark.parametrize("mutation", ["embedded_V", "embedded_H", "embedded_xyz",
    "field_source", "field_charge", "field_count", "extra_field", "manifest_pin",
    "export_ids", "export_V_count", "export_negative_zero"], ids=[f"b{i}" for i in range(11)])
def test_rehashed_v3_preserves_exact_observable_association(inputs, mutation):
    with pytest.raises(ValueError, match="observable association"):
        check.compare_bundle_observables(inputs,
            observable_export(inputs, mutation, version="fem_oersted_direct_tetra_quadrature.v3"))


@pytest.mark.parametrize("target_name,total_name", [("target_kernel_evaluations", "kernel_evaluations"),
    ("target_ledger_leaf_visits", "ledger_leaf_visits")], ids=["kernel", "ledger"])
def test_v3_global_work_budget_is_not_reset_per_target(inputs, target_name, total_name):
    values = observable_export(inputs, version="fem_oersted_direct_tetra_quadrature.v3")
    outer = check.fields(values["bundle_bytes"])
    field = check.fields(check.one(outer, "field_record", 3))
    field = [(name, tag, 30000000 if name == target_name else value) for name, tag, value in field]
    change(field, total_name, 120000000)
    data = encode(field)
    change(outer, "field_record", data)
    digest = hashlib.sha256(data).hexdigest()
    change(outer, "field_content_sha256", digest)
    values["nested_content_sha256"]["field"] = digest
    values["bundle_bytes"] = encode(outer)
    with pytest.raises(ValueError, match="work/leaf totals"):
        check.compare_bundle_observables(inputs, values)
