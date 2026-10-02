"""Executable contract tests; synthetic fields/records are not solver evidence."""
import unittest

import validate_comsol_dispersion_scientific_gate as gate
from test_validate_comsol_dispersion_scientific_gate import _tracking_fixture_payload


class TrackingProvenanceGateTests(unittest.TestCase):
    def payload(self):
        return _tracking_fixture_payload([dict(branch_id=3, points=[
            dict(sample_index=0, raw_mode_index=9),
            dict(sample_index=1, raw_mode_index=2),
            dict(sample_index=2, raw_mode_index=7),
        ])])

    def check(self, payload):
        reasons = []
        result = gate._validate_branch_tracking_evidence(payload, payload["branches"], [0, 1, 2], reasons)
        return result, reasons

    def test_complete_recorded_pair_path_passes_structural_check_only(self):
        result, reasons = self.check(self.payload())
        self.assertEqual(result["status"], "pass", reasons)
        self.assertEqual(result["recorded_edge_count"], 2)
        self.assertEqual(result["field_metric_replay"], "NOT VERIFIED")

    def test_historical_frequency_table_does_not_qualify_tracking(self):
        payload = self.payload()
        for point in payload["branches"][0]["points"]:
            point.pop("tracking_edge")
        for key in ("tracking_policy_availability", "tracking_method", "overlap_floor", "frequency_window_hz"):
            payload.pop(key)
        result, reasons = self.check(payload)
        self.assertEqual(result["status"], "missing")
        self.assertTrue(reasons)

    def test_scientific_branch_gate_rejects_complete_table_without_provenance(self):
        from unittest.mock import patch
        branch = dict(branch_id=0, points=[dict(
            sample_index=index, raw_mode_index=raw,
            frequency_real_hz=1e9, frequency_imag_hz=0.0,
        ) for index, raw in enumerate((9, 2, 7))])
        modes = {(point["sample_index"], point["raw_mode_index"]): 1e9 for point in branch["points"]}
        reasons = []
        with patch.object(gate, "EXPECTED_PATH_SAMPLE_COUNT", 3), patch.object(gate, "EXPECTED_TARGET_BANDS", 1):
            selected, result = gate._validate_branches(dict(branches=[branch]), "c1", modes, reasons)
        self.assertEqual(len(selected), 1)
        self.assertEqual(result["status"], "fail")
        self.assertTrue(any("tracking provenance" in reason for reason in reasons))

    def test_coherent_frequency_fallback_and_diagonal_metric_are_rejected(self):
        for metric in ("unavailable", "diagonal_nodal_mass", "euclidean"):
            payload = self.payload()
            point = payload["branches"][0]["points"][1]
            source = {"unavailable": "frequency_score_fallback", "euclidean": "modal_overlap_unweighted_score"}.get(metric, "modal_overlap_weighted_score")
            point["tracking_score_source"] = source
            point["tracking_edge"].update(score_source=source, metric=metric)
            if metric == "unavailable": point["overlap_prev"] = None
            with self.subTest(metric=metric):
                result, reasons = self.check(payload)
                self.assertEqual(result["status"], "fail")
                self.assertTrue(any("consistent-mass" in reason for reason in reasons))

    def test_malformed_predecessor_and_unrecorded_restart_are_rejected(self):
        for defect in ("previous_raw_mode_index", "previous_sample_index", "skipped_sample_count"):
            payload = self.payload()
            payload["branches"][0]["points"][1]["tracking_edge"][defect] = 99
            with self.subTest(defect=defect):
                result, reasons = self.check(payload)
                self.assertEqual(result["status"], "fail")
                self.assertTrue(any("invalid" in reason for reason in reasons))

    def test_subspace_transport_uses_principal_angles_not_pair_overlap(self):
        payload = self.payload()
        point = payload["branches"][0]["points"][1]
        point["overlap_prev"] = None
        point["tracking_score_source"] = "modal_subspace_transport_score"
        point["tracking_edge"].update(
            score_source=point["tracking_score_source"], transition="split_to_degenerate",
            subspace=dict(rank=2, previous_cluster=0, current_cluster=1,
                          branch_ids=[3, 4], previous_raw_mode_indices=[9, 8],
                          current_raw_mode_indices=[2, 6], principal_cosines=[1.0, .8],
                          principal_minimum=.8),
        )
        result, reasons = self.check(payload)
        self.assertEqual(result["status"], "pass", reasons)
        point["overlap_prev"] = .8
        result, reasons = self.check(payload)
        self.assertEqual(result["status"], "fail")

    def test_aggregate_cannot_trust_legacy_qualified_without_scientific_status(self):
        results = {case: dict(status="qualified", reasons=[]) for case in gate.EXPECTED_CASES}
        self.assertEqual(gate.validate_requested_cases(results, gate.EXPECTED_CASES)["status"], "not_qualified")


if __name__ == "__main__":
    unittest.main()
