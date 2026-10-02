"""Synthetic path/degeneracy replay fixtures; no FEM execution evidence."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from comsol_tracking_metric import Tet4TrackingMetric
from comsol_tracking_replay import replay_recorded_frames, replay_tracking_fields, _frequency_score
from test_validate_comsol_dispersion_scientific_gate import _tracking_fixture_payload
from test_comsol_tracking_fields import write_tracking_fixture


class TrackingReplayTests(unittest.TestCase):
    def setUp(self):
        nodes = [[0., 0, 0], [1., 0, 0], [0., 1., 0], [0., 0, 1.]]
        self.metric = Tet4TrackingMetric(nodes, [[0, 1, 2, 3]], [0])
        self.x = np.tile([1., 0, 0], (4, 1)).astype(complex)
        self.y = np.tile([0., 1, 0], (4, 1)).astype(complex)
        self.samples = []
        self.modes = {}
        points = []
        for index, raw in enumerate((9, 2, 7)):
            frequency = 1e10 + index * 1e6
            k = [(-2 + index * 2.), 0, 0]
            mode = dict(raw_mode_index=raw, frequency_real_hz=frequency, frequency_imag_hz=0.)
            self.samples.append(dict(sample_index=index, k_vector=k, modes=[mode]))
            self.modes[(index, raw)] = dict(envelope=self.x, k_vector_rad_per_m=k,
                                          frequency_real_hz=frequency, frequency_imag_hz=0.)
            confidence = 1. if index == 0 else .85 + .15 * _frequency_score(frequency - 1e6, frequency, None)
            points.append(dict(sample_index=index, raw_mode_index=raw, frequency_real_hz=frequency,
                               frequency_imag_hz=0., tracking_confidence=confidence))
        self.branches = _tracking_fixture_payload([dict(branch_id=3, points=points)])

    def replay(self):
        return replay_recorded_frames(self.metric, self.modes, self.branches, self.samples)

    def test_pair_signed_path_and_variable_raw_ids(self):
        result = self.replay()
        self.assertEqual(result["status"], "pass")
        self.assertEqual(len(result["replayed_edges"]), 2)
        self.assertEqual(result["qualification"], "NOT VERIFIED")
        self.assertEqual(result["assignment_replay"], "NOT VERIFIED")

    def test_forged_overlap_score_frequency_and_signed_k(self):
        for defect in ("overlap", "score", "frequency", "k"):
            self.setUp()
            if defect == "overlap": self.branches["branches"][0]["points"][1]["overlap_prev"] = .8
            if defect == "score": self.branches["branches"][0]["points"][1]["tracking_confidence"] = .8
            if defect == "frequency": self.modes[(1, 2)]["frequency_real_hz"] += 1e6
            if defect == "k": self.modes[(2, 7)]["k_vector_rad_per_m"] = [-2., 0, 0]
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                self.replay()

    def subspace_path(self):
        branch = copy.deepcopy(self.branches["branches"][0])
        branch["branch_id"] = 4
        for index, point in enumerate(branch["points"]):
            raw = (8, 6, 5)[index]
            point["raw_mode_index"] = raw
            self.samples[index]["modes"].append(dict(raw_mode_index=raw,
                frequency_real_hz=point["frequency_real_hz"], frequency_imag_hz=0.))
            self.modes[(index, raw)] = {**self.modes[(index, (9, 2, 7)[index])], "envelope": self.y}
        self.branches = _tracking_fixture_payload([self.branches["branches"][0], branch])
        # At the middle sample the solver rotates the raw degenerate basis.
        self.modes[(1, 2)]["envelope"] = (self.x + 1j * self.y) / np.sqrt(2)
        self.modes[(1, 6)]["envelope"] = (1j * self.x + self.y) / np.sqrt(2)
        subspace = dict(rank=2, previous_cluster=0, current_cluster=0,
                        branch_ids=[3, 4], previous_raw_mode_indices=[9, 8],
                        current_raw_mode_indices=[2, 6], principal_cosines=[1., 1.], principal_minimum=1.)
        for branch in self.branches["branches"]:
            point = branch["points"][1]
            point["overlap_prev"] = None
            point["tracking_score_source"] = "modal_subspace_transport_score"
            point["tracking_edge"].update(score_source="modal_subspace_transport_score",
                transition="degenerate_to_degenerate", subspace=copy.deepcopy(subspace))

    def test_next_pair_uses_transported_frame(self):
        self.subspace_path()
        result = self.replay()
        self.assertEqual(len(result["replayed_edges"]), 3)
        self.assertAlmostEqual(result["replayed_edges"][1]["overlap"], 1.)
        self.assertAlmostEqual(self.metric.overlap(self.modes[(1, 2)]["envelope"], self.x), 2 ** -.5)

    def test_forged_principal_cosines_rejected(self):
        self.subspace_path()
        for branch in self.branches["branches"]:
            branch["points"][1]["tracking_edge"]["subspace"].update(principal_cosines=[.8, .8], principal_minimum=.8)
        with self.assertRaisesRegex(ValueError, "principal cosine"):
            self.replay()

    def test_missing_dependent_cluster_branch_rejected(self):
        self.subspace_path()
        self.branches["branches"].pop()
        with self.assertRaisesRegex(ValueError, "dependency"):
            self.replay()

    def test_boolean_raw_id_and_nonpositive_frequency_rejected(self):
        for defect in ("raw", "frequency"):
            self.setUp()
            mode = self.samples[0]["modes"][0]
            if defect == "raw": mode["raw_mode_index"] = True
            else: mode["frequency_real_hz"] = 0.
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                self.replay()

    def test_swapped_raw_assignment_remains_explicitly_unverified(self):
        # The metric is subspace-invariant; Hungarian raw assignment is a
        # separate, still missing gate. Never promote this to QUALIFIED.
        self.subspace_path()
        first, second = self.branches["branches"]
        first["points"][1]["raw_mode_index"], second["points"][1]["raw_mode_index"] = 6, 2
        for branch in (first, second):
            branch["points"][2]["tracking_edge"]["previous_raw_mode_index"] = branch["points"][1]["raw_mode_index"]
        result = self.replay()
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["assignment_replay"], "NOT VERIFIED")
        self.assertEqual(result["qualification"], "NOT VERIFIED")


class TrackingReplayDiskTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.mode_path, self.envelope = write_tracking_fixture(self.root)

    def test_disk_wrapper_executes_actual_field_read(self):
        mode = json.loads(self.mode_path.read_text())
        sample = dict(sample_index=0, k_vector=mode["k_vector"], modes=[{
            key: mode[key] for key in ("raw_mode_index", "frequency_real_hz", "frequency_imag_hz")}])
        point = dict(sample_index=0, raw_mode_index=7, frequency_real_hz=1e10,
                     frequency_imag_hz=0., tracking_confidence=1.)
        branches = _tracking_fixture_payload([dict(branch_id=3, points=[point])])
        (self.root / "eigen/spectrum.v2.json").write_text(json.dumps(dict(samples=[sample])))
        (self.root / "eigen/branches.v2.json").write_text(json.dumps(branches))
        result = replay_tracking_fields(self.root, selected_branch_ids=[3])
        self.assertEqual(result["status"], "pass", result)
        self.assertEqual(result["qualification"], "NOT VERIFIED")
        self.assertTrue(any(item["path"] == "eigen/branches.v2.json" for item in result["file_hashes"]))

    def write_pair_path(self):
        original = json.loads(self.mode_path.read_text())
        nodes = np.array(json.loads((self.root / "metadata.json").read_text())[
            "execution_plan"]["backend_plan"]["mesh"]["nodes"])
        samples, points = [], []
        for index, raw in enumerate((9, 2, 7)):
            mode = copy.deepcopy(original)
            k = [-2. + 2 * index, 0., 0.]
            mode.update(sample_index=index, raw_mode_index=raw, k_vector=k)
            relative = f"eigen/mode_fields/sample_{index:04}/mode_{raw:04}/vector.bin"
            field = self.envelope * np.exp(-1j * (nodes @ k))[:, None]
            data = np.stack([field.real, field.imag], axis=-1).astype("<f8").tobytes()
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            mode.update(compatibility_binary_payload_path=relative,
                        payload_sha256="sha256:" + hashlib.sha256(data).hexdigest())
            mode_path = self.root / f"eigen/modes/sample_{index:04}/mode_{raw:04}.json"
            mode_path.parent.mkdir(parents=True, exist_ok=True)
            mode_path.write_text(json.dumps(mode))
            samples.append(dict(sample_index=index, k_vector=k, modes=[{
                key: mode[key] for key in ("raw_mode_index", "frequency_real_hz", "frequency_imag_hz")}]))
            points.append(dict(sample_index=index, raw_mode_index=raw,
                frequency_real_hz=mode["frequency_real_hz"], frequency_imag_hz=0., tracking_confidence=1.))
        branches = _tracking_fixture_payload([dict(branch_id=3, points=points)])
        (self.root / "eigen/spectrum.v2.json").write_text(json.dumps(dict(samples=samples)))
        (self.root / "eigen/branches.v2.json").write_text(json.dumps(branches))
        return branches

    def test_disk_signed_path_replays_actual_edges(self):
        self.write_pair_path()
        result = replay_tracking_fields(self.root, selected_branch_ids=[3])
        self.assertEqual(result["status"], "pass", result)
        self.assertEqual(len(result["replayed_edges"]), 2)
        self.assertEqual(result["qualification"], "NOT VERIFIED")

    def test_disk_forged_score_and_supplied_verdict_cannot_pass(self):
        branches = self.write_pair_path()
        branches["branches"][0]["points"][1]["tracking_confidence"] = .8
        (self.root / "eigen/branches.v2.json").write_text(json.dumps(branches))
        (self.root / "tracking_replay.json").write_text(json.dumps(dict(status="pass", qualification="QUALIFIED")))
        result = replay_tracking_fields(self.root, selected_branch_ids=[3])
        self.assertEqual(result["status"], "fail")
        self.assertTrue(any("confidence" in reason for reason in result["reasons"]))

    def test_replay_must_match_gate_bound_control_bytes(self):
        self.write_pair_path()
        initial = replay_tracking_fields(self.root)
        self.assertEqual(initial["status"], "pass", initial)
        hashes = {item["path"]: item["sha256"] for item in initial["file_hashes"]}
        path = self.root / "eigen/branches.v2.json"
        path.write_text(path.read_text() + " ")
        # The changed JSON still has identical semantics; source bytes differ.
        report = replay_tracking_fields(self.root, expected_hashes=hashes)
        self.assertEqual(report["status"], "fail")
        self.assertTrue(any("gate-bound" in reason for reason in report["reasons"]))

    def test_missing_payload_reports_missing_and_corrupt_phase_reports_fail(self):
        self.write_pair_path()
        path = self.root / "eigen/mode_fields/sample_0001/mode_0002/vector.bin"
        data = path.read_bytes()
        path.unlink()
        self.assertEqual(replay_tracking_fields(self.root)["status"], "missing")
        changed = bytearray(data)
        changed[8] ^= 1
        path.write_bytes(changed)
        result = replay_tracking_fields(self.root)
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["qualification"], "NOT VERIFIED")


if __name__ == "__main__":
    unittest.main()
