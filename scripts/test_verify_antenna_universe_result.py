#!/usr/bin/env python3
"""Regression checks for frozen sampling completeness; these do not qualify physics."""
import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np

from verify_antenna_universe_result import compare_payloads, read_inputs, verify, main, fetch_bundle, SOURCE_UNITS
from smoke_antenna_external_lead_inspection import SmokeError

ROOT = Path(__file__).resolve().parents[1]
FULL = ROOT / "examples/antenna_universe/rt0_full_universe_frozen"
REFERENCE = ROOT / "examples/antenna_universe/rt0_geometry_180s"


class UniverseParityTests(unittest.TestCase):
    def setUp(self):
        self.nodes = np.asarray([[0, 0, 0], [1e-6, 0, 0], [0, 1e-6, 0], [0, 0, 1e-6], [1e-6, 1e-6, 1e-6]], dtype="<f8")
        self.ordinals = [0, 1, 2, 3]
        self.cells = np.asarray([[0, 1, 2, 3], [1, 2, 3, 4]], dtype="<u4")
        self.reference_cells = self.cells[:1]
        self.h = np.arange(15, dtype="<f8").reshape(5, 3)
        self.full = {name: b"same-accepted-source" for name in SOURCE_UNITS}
        self.full.update(sample_xyz=self.nodes.tobytes(), sample_cells=self.cells.tobytes(), h_raw=self.h.tobytes())
        self.reference = {
            **self.full, "sample_xyz": self.nodes[self.ordinals].tobytes(),
            "h_raw": self.h[self.ordinals].tobytes(), "sample_cells": self.reference_cells.tobytes(),
        }

    def test_complete_carrier_and_subset_are_compared_without_mutation(self):
        before = copy.deepcopy((self.full, self.reference))
        report = compare_payloads(self.full, self.reference, self.nodes, self.cells, self.ordinals, self.reference_cells)
        self.assertEqual(report["full_samples"], 5)
        self.assertEqual(report["reference_samples"], 4)
        self.assertTrue(report["shared_H_bitwise_equal"])
        self.assertEqual((self.full, self.reference), before)

    def test_missing_or_permuted_full_coordinates_are_rejected(self):
        for xyz in (self.full["sample_xyz"][:-24], self.nodes[::-1].tobytes()):
            with self.subTest(xyz=xyz), self.assertRaisesRegex(Exception, "all Global coordinates"):
                compare_payloads({**self.full, "sample_xyz": xyz}, self.reference, self.nodes, self.cells, self.ordinals, self.reference_cells)

    def test_changed_connectivity_is_rejected_even_with_identical_coordinates(self):
        with self.assertRaisesRegex(Exception, "connectivity differs"):
            compare_payloads({**self.full, "sample_cells": self.cells[::-1].tobytes()}, self.reference,
                             self.nodes, self.cells, self.ordinals, self.reference_cells)

    def test_partial_diagnostic_cannot_pass_as_full_universe(self):
        with self.assertRaisesRegex(Exception, "exceed the diagnostic subset"):
            compare_payloads(self.reference, self.reference, self.nodes[self.ordinals], self.reference_cells, [0, 1, 2, 3], self.reference_cells)

    def test_nonfinite_or_missing_field_samples_are_rejected(self):
        bad = self.h.copy()
        bad[0, 2] = np.nan
        for payload in (bad.tobytes(), self.h.tobytes()[:-24]):
            with self.subTest(payload=payload), self.assertRaises(Exception):
                compare_payloads({**self.full, "h_raw": payload}, self.reference, self.nodes, self.cells, self.ordinals, self.reference_cells)

    def test_every_source_array_must_belong_to_the_same_accepted_state(self):
        for name in SOURCE_UNITS:
            with self.subTest(name=name), self.assertRaisesRegex(Exception, "Accepted source changed"):
                compare_payloads({**self.full, name: b"different"}, self.reference, self.nodes, self.cells, self.ordinals, self.reference_cells)

    def test_shared_field_changes_and_wrong_subset_mapping_are_rejected(self):
        changed = self.h[self.ordinals].copy()
        changed[0, 0] = np.nextafter(changed[0, 0], np.inf)
        with self.assertRaisesRegex(Exception, "not bitwise reproducible"):
            compare_payloads(self.full, {**self.reference, "h_raw": changed.tobytes()}, self.nodes, self.cells, self.ordinals, self.reference_cells)
        with self.assertRaisesRegex(Exception, "Reference coordinates differ"):
            compare_payloads(self.full, self.reference, self.nodes, self.cells, list(reversed(self.ordinals)), self.reference_cells)

    def test_foreign_project_run_task_or_attempt_is_rejected_before_payload_reads(self):
        owner = {"run_id": "run", "task_id": "task", "attempt_id": "attempt", "ownership_epoch": 1,
                 "study_step_id": "step", "package_object_ref": "a" * 64}
        run = {"project_id": "project", "run_id": "run",
               "tasks": [{**owner, "lifecycle": "succeeded"}]}
        catalog = {"project_id": "project", "run_id": "run", "entries": [owner],
                   "schema_version": "accepted_antenna_inspection_catalog.v1"}
        metadata = {"project_id": "project", "owner": owner,
                    "schema_version": "accepted_antenna_inspection.closed_loop.v1"}
        for target, key, value in (
            (0, "project_id", "foreign"), (0, "run_id", "foreign"),
            (1, "project_id", "foreign"), (1, "run_id", "foreign"),
            (2, "project_id", "foreign"), (3, "task_id", "foreign"),
            (3, "attempt_id", "foreign"), (3, "ownership_epoch", 2),
        ):
            values = copy.deepcopy([run, catalog, metadata])
            if target == 3:
                values[1]["entries"][0][key] = value
            else:
                values[target][key] = value
            with self.subTest(target=target, key=key), \
                 patch("verify_antenna_universe_result.json_body", side_effect=values), \
                 patch("verify_antenna_universe_result.request") as get, self.assertRaises(SmokeError):
                fetch_bundle("http://127.0.0.1:8081", "project", "run")
            self.assertLessEqual(get.call_count, 3)

    def test_cli_replaces_a_wait_report_with_explicit_failure_on_invalid_result(self):
        args = ["verify", "--origin", "http://127.0.0.1:8081", "--project", "project",
                "--full-run", "run-full", "--full-input", str(FULL),
                "--reference-input", str(REFERENCE), "--report", "/opt/fullmag/control/parity-test.json"]
        with patch("sys.argv", args), patch("verify_antenna_universe_result.verify", side_effect=ValueError("changed field")), \
             patch("pathlib.Path.write_text") as write, patch("builtins.print"):
            self.assertEqual(main(), 1)
            report = json.loads(write.call_args.args[0])
            self.assertEqual(report["status"], "failed")
            self.assertFalse(report["full_universe_verified"])
            self.assertFalse(report["new_solve"])
            self.assertEqual(report["error"], "changed field")

    def test_actual_frozen_inputs_have_full_original_global_and_reference_mapping(self):
        manifest, _, nodes, cells, ordinals = read_inputs(FULL, REFERENCE)
        self.assertEqual(nodes.shape, (1145, 3))
        self.assertEqual(cells.shape, (6428, 4))
        self.assertEqual(manifest["global_nodes_cells"], [1145, 6428])
        self.assertEqual(len(ordinals), 20)
        with self.assertRaisesRegex(Exception, "Wrong frozen input family"):
            read_inputs(REFERENCE, FULL)

    def test_running_or_stopping_is_waiting_and_never_reads_a_bundle_or_executes(self):
        frozen = {"prerequisite_geometry_diagnostic_run_id": "run-reference"}
        for state in ("accepted", "queued", "preparing", "running", "stopping"):
            with self.subTest(state=state), \
                 patch("verify_antenna_universe_result.read_inputs", return_value=(frozen, {}, self.nodes, self.cells, self.ordinals)), \
                 patch("verify_antenna_universe_result.request") as get, \
                 patch("verify_antenna_universe_result.json_body", return_value={"project_id": "project", "run_id": "run-full", "tasks": [{"task_id": "task", "lifecycle": state}]}), \
                 patch("verify_antenna_universe_result.validate") as gate, \
                 patch("verify_antenna_universe_result.fetch_bundle") as bundle:
                result = verify("http://127.0.0.1:8081", "project", "run-full", FULL, REFERENCE)
                self.assertEqual(result["status"], "waiting")
                self.assertFalse(result["full_universe_verified"])
                self.assertFalse(result["new_solve"])
                self.assertEqual(get.call_count, 1)
                gate.assert_not_called()
                bundle.assert_not_called()


if __name__ == "__main__":
    unittest.main()
