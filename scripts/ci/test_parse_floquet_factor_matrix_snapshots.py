"""Synthetic parser contract tests; never native/scientific evidence."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import parse_floquet_factor_matrix_snapshots as parser


def snapshot(phase, object_id, *, origin=None, callback=3, state=2, changed=False):
    entries = []
    for row in range(4):
        for column in range(4):
            value = float(1 + 4 * row + column)
            if changed and row == 0 and column == 0:
                value += 0.25
            entries.append({
                "row": row, "column": column, "diagonal": row == column,
                "real": value, "imaginary": 0.0,
                "real_finite": True, "imaginary_finite": True,
                "real_raw_hex": struct.pack("=d", value).hex(),
                "imaginary_raw_hex": struct.pack("=d", 0.0).hex(),
            })
    setup = phase == parser.PHASES[0]
    record = {
        "schema": parser.SCHEMA, "phase": phase, "status": "measured", "applicable_n4": True,
        "truncated": False, "rows": 4, "columns": 4, "type": "seqaij",
        "missing_diagonal": False, "first_missing_diagonal": None,
        "nonzero_state": state, "nonzero_state_scope": "same_matrix_only",
        "real_byte_count": 8, "raw_encoding": "native_memory_order_hex", "entries": entries,
        "attempt_scope_id": 1, "attempt_scope_semantics": "process_local_eps_setup_sequence",
        "capture_scope": "before_eps_setup" if setup else "first_live_pc_capture",
        "callback_ordinal_available": not setup, "callback_ordinal": None if setup else callback,
        "object_id": object_id, "object_id_available": True, "object_id_error_available": True,
        "object_id_error": 0, "copy_origin_id": origin, "copy_origin_id_available": origin is not None,
        "copy_origin_error_available": origin is not None, "copy_origin_error": 0 if origin is not None else None,
    }
    for field in ("size_available", "type_available", "getters_attempted", "values_attempted",
                  "values_available", "missing_diagonal_available", "nonzero_state_available"):
        record[field] = True
    for getter in ("size", "type", "ownership", "values", "diagonal", "nonzero_state"):
        record[getter + "_error_available"] = True
        record[getter + "_error"] = 0
    return record


def observations(*, same_ab=False, changed_b=False, changed_c=False):
    a_id, b_id, c_id = 11, 11 if same_ab else 12, 13
    data = [snapshot(parser.PHASES[0], a_id),
            snapshot(parser.PHASES[1], b_id, changed=changed_b),
            snapshot(parser.PHASES[2], c_id, origin=b_id, changed=changed_c)]
    return [{"line": index + 10, "ctest_id": 45, "ctest_invocation": 1, "snapshot": value}
            for index, value in enumerate(data)]


def configured_observations():
    records = observations()
    pc_ids = {parser.PHASES[0]: 101, parser.PHASES[1]: 202, parser.PHASES[2]: 303}
    pivots = {parser.PHASES[0]: 0.75, parser.PHASES[1]: 1.25, parser.PHASES[2]: 1.25}
    for item in records:
        record = item["snapshot"]
        phase = record["phase"]
        count = 0 if phase == parser.PHASES[0] else 2
        offsets_available = count > 0
        record.update({
            "pc_object_id_available": True, "pc_object_id_error_available": True,
            "pc_object_id_error": 0, "pc_object_id": pc_ids[phase],
            "pc_type_error_available": True, "pc_type_error": 0,
            "pc_is_lu_available": True, "pc_is_lu": True,
            "zero_pivot_attempted": True, "zero_pivot_error_available": True,
            "zero_pivot_error": 0, "zero_pivot_available": True,
            "zero_pivot": pivots[phase],
            "inode_metadata_scope": parser.INODE_METADATA_SCOPE,
            "inode_query_attempted": True, "inode_error_available": True, "inode_error": 0,
            "inode_metadata_available": True, "inode_count": count, "inode_limit": 4,
            "inode_csr_offsets_available": offsets_available,
            "inode_csr_offsets": [0, 2, 4] if offsets_available else None,
        })
    return records


def action_probe(*, callback=3):
    probe = {
        "schema": parser.ACTION_SCHEMA, "status": "captured", "truncated": False,
        "attempt_scope_id": 1, "attempt_scope_semantics": "process_local_eps_setup_sequence",
        "capture_scope": parser.ACTION_CAPTURE_SCOPE, "callback_ordinal": callback,
        "live_shift_measurement_scope": "queried_live_PCLU_configuration_not_actual_factor_perturbation",
        "fresh_shift_measurement_scope": "fresh_copy_configuration_inputs_only",
        "same_private_rhs_source": "live_pc_rhs_snapshot",
    }
    for index, name in enumerate(parser.ACTION_VALUE_FIELDS, 1):
        probe[name + "_available"] = True
        probe[name] = float(index) / 10
    probe.update({
        "live_actual_shift_type_available": True,
        "live_actual_shift_type": "MAT_SHIFT_NONZERO",
        "live_actual_shift_type_enum_available": True,
        "live_actual_shift_type_enum": 1,
        "fresh_configured_shift_type_available": True,
        "fresh_configured_shift_type": "MAT_SHIFT_NONZERO",
        "entry_comparison_available": True,
        "values_equal_available": True,
        "values_equal": True,
    })
    return probe


def write_log(path, records, actions=()):
    path.write_text("Start 45: synthetic\n" + "".join(
        "45: " + parser.PREFIX + json.dumps(item["snapshot"]) + "\n" for item in records) + "".join(
        "45: " + parser.ACTION_PREFIX + json.dumps(item["probe"]) + "\n" for item in actions), encoding="utf-8")


class SnapshotPairingTests(unittest.TestCase):
    def test_different_ab_objects_and_actual_copy_origin_are_separate_relations(self):
        records = observations()
        self.assertTrue(all(parser.validate_snapshot(item["snapshot"]) == [] for item in records))
        pairs, issues = parser.pair_snapshots(records)
        self.assertEqual(issues, [])
        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0]["a_to_b_identity_relation"], "different_objects")
        self.assertIsNone(pairs[0]["a_to_b_nonzero_state_changed"])
        self.assertTrue(pairs[0]["b_to_c_copy_origin_verified"])
        self.assertTrue(pairs[0]["b_to_c_raw_values_equal"])
        self.assertIn("NOT VERIFIED", pairs[0]["last_true_probe_binding"])

    def test_same_nonzero_state_does_not_hide_raw_value_changes(self):
        pairs, issues = parser.pair_snapshots(observations(same_ab=True, changed_b=True))
        self.assertEqual(issues, [])
        self.assertEqual(pairs[0]["a_to_b_identity_relation"], "same_object")
        self.assertFalse(pairs[0]["a_to_b_nonzero_state_changed"])
        self.assertFalse(pairs[0]["a_to_b_raw_values_equal"])
        self.assertFalse(pairs[0]["b_to_c_raw_values_equal"])

    def test_source_callback_ambiguous_attempt_and_legacy_fail_closed(self):
        for mutation in ("source", "callback", "ambiguous", "legacy", "id_bool", "attempt_bool"):
            with self.subTest(mutation=mutation):
                records = observations()
                if mutation == "source":
                    records[2]["snapshot"]["copy_origin_id"] = 999
                elif mutation == "callback":
                    records[2]["snapshot"]["callback_ordinal"] = 4
                elif mutation == "ambiguous":
                    extra = copy.deepcopy(records[1])
                    extra["snapshot"]["object_id"] = 98
                    records.append(extra)
                elif mutation == "legacy":
                    for item in records:
                        item["snapshot"]["schema"] = parser.LEGACY_SCHEMA
                elif mutation == "id_bool":
                    records[1]["snapshot"]["object_id"] = True
                else:
                    records[0]["snapshot"]["attempt_scope_id"] = True
                pairs, issues = parser.pair_snapshots(records)
                self.assertEqual(pairs, [])
                self.assertTrue(issues)

    def test_invocation_separator_prevents_cross_process_pairing(self):
        records = observations()
        records[2]["ctest_invocation"] = 2
        pairs, issues = parser.pair_snapshots(records)
        self.assertEqual(pairs, [])
        self.assertTrue(issues)
        second = observations()
        for item in second:
            item["ctest_invocation"] = 2
            item["line"] += 100
        pairs, issues = parser.pair_snapshots(observations() + second)
        self.assertEqual(issues, [])
        self.assertEqual([pair["ctest_invocation"] for pair in pairs], [1, 2])

    def test_log_missing_or_invalid_markers_never_supply_coverage(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "synthetic.log"
            for content in ("Start 45: synthetic\n", "Start 45: synthetic\n45: " + parser.PREFIX + "{bad}\n"):
                log.write_text(content, encoding="utf-8")
                report = parser.parse_log(log, ("synthetic",))
                self.assertEqual(report["measurement_status"], "incomplete")
                self.assertEqual(report["pairing_status"], "NOT VERIFIED")
                self.assertEqual(report["scientific_qualification"], "NOT VERIFIED")
            data = observations()
            data[1]["snapshot"]["entries"].pop()
            content = "Start 45: synthetic\n" + "".join(
                "45: " + parser.PREFIX + json.dumps(item["snapshot"]) + "\n" for item in data)
            log.write_text(content, encoding="utf-8")
            report = parser.parse_log(log, ("synthetic",))
            self.assertEqual(report["measurement_status"], "incomplete")
            self.assertTrue(report["coverage"]["synthetic"]["rejected"])

    def test_valid_log_is_bound_but_never_scientifically_qualified(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "synthetic.log"
            log.write_text("Start 45: synthetic\n" + "".join(
                "45: " + parser.PREFIX + json.dumps(item["snapshot"]) + "\n" for item in observations()), encoding="utf-8")
            report = parser.parse_log(log, ("synthetic",))
        self.assertEqual(report["measurement_status"], "complete")
        self.assertEqual(report["pairing_status"], "VERIFIED")
        self.assertEqual(report["configuration_measurement_status"], "NOT VERIFIED")
        self.assertEqual(report["action_probe_binding_status"], "NOT VERIFIED")
        self.assertIsNone(report["pairing"]["synthetic"][0]["configuration"])
        self.assertIsNone(report["pairing"]["synthetic"][0]["action_probe"]["record"])
        self.assertEqual(report["scientific_qualification"], "NOT VERIFIED")
        self.assertEqual(report["solver_failure_cause"], "NOT VERIFIED")

    def test_action_probe_requires_exact_first_bc_callback_binding(self):
        records = observations()
        matching = [{"line": 13, "ctest_id": 45, "ctest_invocation": 1,
                     "probe": action_probe(callback=3)}]
        pairs, issues = parser.pair_snapshots(records, matching)
        self.assertEqual(issues, [])
        self.assertEqual(pairs[0]["action_probe"]["binding_status"], "VERIFIED")
        self.assertEqual(pairs[0]["action_probe"]["measurement_status"], "VERIFIED")
        self.assertEqual(pairs[0]["action_probe"]["record"]["callback_ordinal"], 3)

        different_callback = [{"line": 13, "ctest_id": 45, "ctest_invocation": 1,
                               "probe": action_probe(callback=4)}]
        pairs, issues = parser.pair_snapshots(records, different_callback)
        self.assertEqual(issues, [])
        self.assertEqual(pairs[0]["action_probe"]["binding_status"], "NOT VERIFIED")
        self.assertIsNone(pairs[0]["action_probe"]["record"])

        different_invocation = [{"line": 13, "ctest_id": 45, "ctest_invocation": 2,
                                 "probe": action_probe(callback=3)}]
        pairs, issues = parser.pair_snapshots(records, different_invocation)
        self.assertEqual(issues, [])
        self.assertEqual(pairs[0]["action_probe"]["binding_status"], "NOT VERIFIED")

        pairs, issues = parser.pair_snapshots(records)
        self.assertEqual(issues, [])
        self.assertEqual(pairs[0]["action_probe"]["binding_status"], "NOT VERIFIED")

    def test_action_probe_unavailable_and_contradictory_values_are_not_invented(self):
        records = observations()
        unavailable = action_probe()
        unavailable["live_pmat_residual_l2_norm_available"] = False
        unavailable["live_pmat_residual_l2_norm"] = None
        actions = [{"line": 13, "ctest_id": 45, "ctest_invocation": 1, "probe": unavailable}]
        pairs, issues = parser.pair_snapshots(records, actions)
        self.assertEqual(issues, [])
        action = pairs[0]["action_probe"]
        self.assertEqual(action["binding_status"], "VERIFIED")
        self.assertEqual(action["measurement_status"], "NOT VERIFIED")
        self.assertIsNone(action["record"]["live_pmat_residual_l2_norm"])

        contradictory = action_probe()
        contradictory["fresh_pmat_residual_l2_norm_available"] = False
        actions = [{"line": 13, "ctest_id": 45, "ctest_invocation": 1, "probe": contradictory}]
        pairs, issues = parser.pair_snapshots(records, actions)
        self.assertEqual(issues, [])
        action = pairs[0]["action_probe"]
        self.assertEqual(action["binding_status"], "NOT VERIFIED")
        self.assertIsNone(action["record"])
        self.assertTrue(action["rejected_markers"])

    def test_action_probe_log_scope_uses_ctest_invocation(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "synthetic.log"
            actions = [{"line": 13, "ctest_id": 45, "ctest_invocation": 1,
                        "probe": action_probe()}]
            write_log(log, observations(), actions)
            report = parser.parse_log(log, ("synthetic",))
        self.assertEqual(report["measurement_status"], "complete")
        self.assertEqual(report["pairing_status"], "VERIFIED")
        self.assertEqual(report["action_probe_binding_status"], "VERIFIED")
        self.assertEqual(report["action_probe_measurement_status"], "VERIFIED")
        self.assertEqual(report["solver_failure_cause"], "NOT VERIFIED")


class ConfigurationMeasurementTests(unittest.TestCase):
    def test_valid_configuration_is_reported_separately_from_matrix_pairing(self):
        records = configured_observations()
        pairs, issues = parser.pair_snapshots(records)
        self.assertEqual(issues, [])
        pair = pairs[0]
        self.assertEqual(pair["configuration_measurement_status"], "VERIFIED")
        configuration = pair["configuration"]
        self.assertEqual(configuration["measurement_status"], "VERIFIED")
        self.assertEqual(configuration["pc_configuration"]["a_to_b_object_identity_relation"], "different_objects")
        self.assertEqual(configuration["pc_configuration"]["b_to_c_object_identity_relation"], "different_objects")
        pivot = configuration["pc_configuration"]["b_to_c_zero_pivot_comparison"]
        self.assertEqual(pivot["measurement_status"], "VERIFIED")
        self.assertTrue(pivot["values_equal"])
        self.assertEqual(pivot["b_zero_pivot"], 1.25)
        self.assertIn("does not establish the same PC object, factor, or configuration", pivot["scope"])
        self.assertEqual(configuration["inode_metadata"]["a"]["measurement_status"], "VERIFIED")
        self.assertEqual(configuration["inode_metadata"]["a"]["count"], 0)
        self.assertIsNone(configuration["inode_metadata"]["a"]["csr_offsets"])
        self.assertEqual(configuration["inode_metadata"]["a"]["csr_offsets_measurement_status"], "NOT APPLICABLE")
        self.assertTrue(configuration["inode_metadata_comparisons"]["b_to_c"]["csr_offsets_equal"])

        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "synthetic.log"
            write_log(log, records)
            report = parser.parse_log(log, ("synthetic",))
        self.assertEqual(report["measurement_status"], "complete")
        self.assertEqual(report["pairing_status"], "VERIFIED")
        self.assertEqual(report["configuration_measurement_status"], "VERIFIED")
        self.assertEqual(report["scientific_qualification"], "NOT VERIFIED")

    def test_truthful_unavailable_configuration_does_not_remove_matrix_coverage(self):
        records = configured_observations()
        first = records[0]["snapshot"]
        first["pc_object_id_available"] = False
        first["pc_object_id_error"] = 17
        first["pc_object_id"] = None
        self.assertEqual(parser.validate_snapshot(first), [])
        records[1]["snapshot"].update(inode_csr_offsets_available=False, inode_csr_offsets=None)
        self.assertEqual(parser.validate_snapshot(records[1]["snapshot"]), [])

        pairs, issues = parser.pair_snapshots(records)
        self.assertEqual(issues, [])
        self.assertEqual(pairs[0]["configuration_measurement_status"], "NOT VERIFIED")
        self.assertEqual(pairs[0]["configuration"]["measurement_status"], "NOT VERIFIED")
        self.assertIsNone(pairs[0]["configuration"]["pc_configuration"]["a_to_b_object_identity_relation"])
        self.assertEqual(pairs[0]["configuration"]["pc_configuration"]["b_to_c_zero_pivot_comparison"]["measurement_status"], "VERIFIED")

        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "synthetic.log"
            write_log(log, records)
            report = parser.parse_log(log, ("synthetic",))
        self.assertEqual(report["measurement_status"], "complete")
        self.assertEqual(report["pairing_status"], "VERIFIED")
        self.assertEqual(report["configuration_measurement_status"], "NOT VERIFIED")

    def test_partial_and_contradictory_configuration_is_rejected(self):
        mutations = (
            lambda record: record.pop("pc_is_lu"),
            lambda record: record.update(pc_is_lu_available=False, pc_is_lu=False),
            lambda record: record.update(pc_object_id_error=17),
            lambda record: record.update(zero_pivot_error=17),
        )
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                record = configured_observations()[1]["snapshot"]
                mutate(record)
                self.assertTrue(parser.validate_snapshot(record))

    def test_pc_ids_must_be_positive_integers_and_not_booleans(self):
        for invalid_id in (True, 0, -1, 1.0):
            with self.subTest(invalid_id=invalid_id):
                record = configured_observations()[1]["snapshot"]
                record["pc_object_id"] = invalid_id
                self.assertTrue(parser.validate_snapshot(record))

    def test_inode_count_and_csr_offsets_are_strictly_bounded(self):
        mutations = (
            lambda record: record.update(inode_count=True),
            lambda record: record.update(inode_count=None),
            lambda record: record.update(inode_count=[]),
            lambda record: record.update(inode_count=5),
            lambda record: record.update(inode_limit=0),
            lambda record: record.update(inode_csr_offsets=[0, 0, 4]),
            lambda record: record.update(inode_csr_offsets=[0, True, 4]),
            lambda record: record.update(inode_csr_offsets=[1, 3, 4]),
            lambda record: record.update(inode_csr_offsets=[0, 4]),
        )
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                record = configured_observations()[1]["snapshot"]
                mutate(record)
                self.assertTrue(parser.validate_snapshot(record))


if __name__ == "__main__":
    unittest.main()
