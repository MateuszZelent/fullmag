"""Synthetic path/degeneracy replay fixtures; no FEM execution evidence."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from comsol_tracking_metric import Tet4TrackingMetric
from comsol_tracking_replay import replay_recorded_frames, replay_tracking_fields, _frequency_score, verify_global_prediction
from comsol_tracking_global import reconstruct_global_assignment
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
        self.branches = _tracking_fixture_payload([dict(branch_id=0, points=points)])

    def replay(self):
        return replay_recorded_frames(self.metric, self.modes, self.branches, self.samples)

    def test_noncanonical_seed_branch_id_cannot_certify_assignment(self):
        self.branches["branches"][0]["branch_id"] = 37
        result = self.replay()
        self.assertEqual(result["assignment_replay"], "NOT VERIFIED")
        self.assertEqual(result["initial_assignment_verification"]["status"], "fail")

    def test_swapped_seed_ids_cannot_certify_assignment(self):
        self.subspace_path()
        first, second = self.branches["branches"]
        first["branch_id"], second["branch_id"] = second["branch_id"], first["branch_id"]
        # Use only the initial sample: no subsequent edge can reveal this swap.
        self.samples = self.samples[:1]
        for branch in self.branches["branches"]:
            branch["points"] = branch["points"][:1]
        result = self.replay()
        self.assertEqual(result["initial_assignment_verification"]["status"], "fail")

    def test_seed_check_uses_solver_slots_not_raw_sort_or_branch_table_order(self):
        self.subspace_path()
        self.samples = self.samples[:2]
        for branch in self.branches["branches"]:
            branch["points"] = branch["points"][:2]
        self.branches["branches"].reverse()
        result = self.replay()
        self.assertEqual(result["initial_assignment_verification"]["status"], "pass")
        self.assertEqual(result["assignment_replay"], "pass")

    def test_pair_signed_path_and_variable_raw_ids(self):
        result = self.replay()
        self.assertEqual(result["status"], "pass")
        self.assertEqual(len(result["replayed_edges"]), 2)
        self.assertEqual(result["qualification"], "NOT VERIFIED")
        self.assertEqual(result["assignment_replay"], "pass")
        self.assertEqual([record["status"] for record in result["global_policy_predictions"]], ["pass", "pass"])
        self.assertEqual(result["global_policy_predictions"][0]["predicted_matches"][0]["raw_mode_index"], 2)

    def test_forged_overlap_score_frequency_and_signed_k(self):
        for defect in ("overlap", "score", "frequency", "k"):
            self.setUp()
            if defect == "overlap": self.branches["branches"][0]["points"][1]["overlap_prev"] = .8
            if defect == "score": self.branches["branches"][0]["points"][1]["tracking_confidence"] = .8
            if defect == "frequency": self.modes[(1, 2)]["frequency_real_hz"] += 1e6
            if defect == "k": self.modes[(2, 7)]["k_vector_rad_per_m"] = [-2., 0, 0]
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                self.replay()

    def test_locally_valid_but_globally_inferior_pair_assignment_is_rejected(self):
        branch = copy.deepcopy(self.branches["branches"][0])
        branch["branch_id"] = 1
        for index, point in enumerate(branch["points"]):
            raw = (8, 6, 5)[index]
            frequency = 2e10 + index * 1e6
            point.update(raw_mode_index=raw, frequency_real_hz=frequency)
            self.samples[index]["modes"].append(dict(raw_mode_index=raw,
                frequency_real_hz=frequency, frequency_imag_hz=0.))
            self.modes[(index, raw)] = {**self.modes[(index, (9, 2, 7)[index])],
                "frequency_real_hz": frequency, "envelope": self.y}
        self.modes[(1, 2)]["envelope"] = .6 * self.x + .8 * self.y
        self.modes[(1, 6)]["envelope"] = .8 * self.x + .6 * self.y
        self.branches = _tracking_fixture_payload([self.branches["branches"][0], branch])
        for record in self.branches["branches"]:
            for index in (1, 2):
                point = record["points"][index]
                previous = record["points"][index - 1]
                point["overlap_prev"] = .6
                point["tracking_confidence"] = .85 * .6 + .15 * _frequency_score(
                    previous["frequency_real_hz"], point["frequency_real_hz"], None)
        result = self.replay()
        self.assertEqual(result["status"], "pass")  # The chosen metrics are truthful.
        self.assertEqual(result["assignment_replay"], "NOT VERIFIED")
        self.assertEqual(result["global_assignment_verification"][0]["status"], "fail")
        self.assertIn("mean score", result["global_assignment_verification"][0]["reason"])

    def subspace_path(self, angle=None):
        branch = copy.deepcopy(self.branches["branches"][0])
        branch["branch_id"] = 1
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
        if angle is not None:
            self.modes[(1, 2)]["envelope"] = np.cos(angle) * self.x + np.sin(angle) * self.y
            self.modes[(1, 6)]["envelope"] = -np.sin(angle) * self.x + np.cos(angle) * self.y
        subspace = dict(rank=2, previous_cluster=0, current_cluster=0,
                        branch_ids=[0, 1], previous_raw_mode_indices=[9, 8],
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

    def test_complete_degenerate_edge_can_close_assignment_certificate(self):
        self.subspace_path()
        self.samples = self.samples[:2]
        for branch in self.branches["branches"]:
            branch["points"] = branch["points"][:2]
        result = self.replay()
        self.assertEqual(result["assignment_replay"], "pass", result["global_assignment_verification"])
        self.assertEqual(result["qualification"], "NOT VERIFIED")

    def test_degenerate_transport_after_common_gap(self):
        self.subspace_path()
        self.samples = self.samples[:2]
        self.samples.insert(1, dict(sample_index=17, k_vector=[0.,0.,0.], modes=[]))
        for branch in self.branches["branches"]:
            branch["points"] = branch["points"][:2]
            for point in branch["points"]:
                point["tracking_edge"]["policy"]["max_branch_gap"] = 1
            branch["points"][1]["tracking_edge"]["skipped_sample_count"] = 1
        result = self.replay()
        self.assertEqual(result["assignment_replay"], "pass", result)
        self.assertEqual(result["branch_lifecycle_replay"]["verified_sample_count"], 3)

    def test_equivalent_hungarian_pair_optimum_is_reported(self):
        policy = dict(method="overlap_hungarian", overlap_floor=.5, frequency_window_hz=1e8)
        current = [dict(raw_mode_index=2,frequency_real_hz=1e11,frequency_imag_hz=0.,envelope=(self.x+self.y)/np.sqrt(2)),
                   dict(raw_mode_index=6,frequency_real_hz=2e11,frequency_imag_hz=0.,envelope=(self.x-self.y)/np.sqrt(2))]
        prediction = reconstruct_global_assignment(self.metric,{3:self.x,4:self.y},
            [(3,1e10,0.),(4,2e10,0.)],current,policy,_frequency_score)
        expected = {identity:edge["raw_mode_index"] for identity,edge in prediction["matches"].items()}
        recorded = {3:expected[4],4:expected[3]}
        points = {identity:dict(raw_mode_index=raw,tracking_confidence=float(.85/np.sqrt(2)),
                              tracking_edge=dict(transition="pair")) for identity,raw in recorded.items()}
        check = verify_global_prediction(self.metric,prediction,points,current,
            {identity:next(mode["envelope"] for mode in current if mode["raw_mode_index"]==raw)
             for identity,raw in recorded.items()},"overlap_hungarian")
        self.assertEqual(check["status"],"pass")
        self.assertTrue(check["equivalent_optimum"])

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
        # The local raw tie is valid; the next recorded pair contradicts the
        # reconstructed group policy, so the entire path remains unverified.
        self.subspace_path()
        first, second = self.branches["branches"]
        first["points"][1]["raw_mode_index"], second["points"][1]["raw_mode_index"] = 6, 2
        for branch in (first, second):
            branch["points"][2]["tracking_edge"]["previous_raw_mode_index"] = branch["points"][1]["raw_mode_index"]
        result = self.replay()
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["assignment_replay"], "NOT VERIFIED")
        self.assertEqual(result["qualification"], "NOT VERIFIED")

    def test_unique_wrong_subspace_assignment_is_rejected(self):
        self.subspace_path(angle=.25)
        first, second = self.branches["branches"]
        first["points"][1]["raw_mode_index"], second["points"][1]["raw_mode_index"] = 6, 2
        for branch in (first, second):
            branch["points"][2]["tracking_edge"]["previous_raw_mode_index"] = branch["points"][1]["raw_mode_index"]
        with self.assertRaisesRegex(ValueError, "subspace raw assignment"):
            self.replay()

    def test_unique_correct_assignment_and_reported_raw_ids(self):
        self.subspace_path(angle=.25)
        result = self.replay()
        assignment = result["replayed_edges"][0]["subspace_raw_assignment"]
        self.assertEqual(assignment["recorded_raw_mode_indices"], [2, 6])
        self.assertEqual(assignment["optimal_raw_mode_indices"], [2, 6])
        self.assertAlmostEqual(assignment["optimal_mean_weight"], np.cos(.25))
        self.assertEqual(result["subspace_raw_assignment_replay"], "pass")
        self.assertEqual(result["assignment_replay"], "NOT VERIFIED")

    def test_forged_cluster_indices_are_rejected(self):
        self.subspace_path()
        for branch in self.branches["branches"]:
            branch["points"][1]["tracking_edge"]["subspace"]["current_cluster"] = 7
        with self.assertRaisesRegex(ValueError, "frequency group candidate"):
            self.replay()

    def test_degenerate_group_cannot_claim_split_transition(self):
        self.subspace_path()
        for branch in self.branches["branches"]:
            branch["points"][1]["tracking_edge"]["transition"] = "split_to_degenerate"
        with self.assertRaisesRegex(ValueError, "frequency group candidate"):
            self.replay()

    def test_split_candidate_tie_uses_branch_identity_not_raw_identity(self):
        self.subspace_path()
        center = self.samples[1]["modes"][0]["frequency_real_hz"]
        for slot, branch in enumerate(self.branches["branches"]):
            point = branch["points"][0]
            frequency = center + (-1 if slot == 0 else 1) * 1e7
            point["frequency_real_hz"] = frequency
            raw = point["raw_mode_index"]
            self.modes[(0, raw)]["frequency_real_hz"] = frequency
            self.samples[0]["modes"][slot]["frequency_real_hz"] = frequency
            branch["points"][1]["tracking_confidence"] = 1.
            branch["points"][1]["tracking_edge"]["transition"] = "split_to_degenerate"
        # Branch 0/raw9 wins the equal-distance tie over branch1/raw8,
        # so previous_cluster=0 is the producer anchor. Raw sorting gives1.
        result = self.replay()
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["assignment_replay"], "NOT VERIFIED")


class TrackingLifecycleReplayTests(unittest.TestCase):
    """Actual P1 metric with sparse histories; no native solver execution."""

    def setUp(self):
        self.metric = Tet4TrackingMetric([[0.,0,0],[1.,0,0],[0.,1.,0],[0.,0,1.]], [[0,1,2,3]], [0])
        self.x = np.tile([1.,0,0], (4,1)).astype(complex)
        self.y = np.tile([0.,1,0], (4,1)).astype(complex)

    def build(self, path, max_gap):
        # Entries explicitly prescribe branch ID, raw ID and field, while
        # policy replay independently decides whether that assignment is legal.
        samples, modes, histories, previous_fields = [], {}, {}, {}
        policy = dict(method="overlap_hungarian", overlap_floor=.5,
                      frequency_window_hz=None, max_branch_gap=max_gap)
        for position, entries in enumerate(path):
            sample_id = 10 + position * 7  # Gap is path distance, not ID delta.
            spectrum = []
            for identity, raw, field in entries:
                spectrum.append(dict(raw_mode_index=raw, frequency_real_hz=1e10, frequency_imag_hz=0.))
                modes[(sample_id, raw)] = dict(envelope=field, k_vector_rad_per_m=[position,0,0],
                    frequency_real_hz=1e10, frequency_imag_hz=0.)
                points = histories.setdefault(identity, [])
                previous = points[-1] if points else None
                seed = previous is None
                transition = ("seed" if position == 0 else "new_branch") if seed else "pair"
                source = ("seed" if position == 0 else "modal_overlap_unavailable") if seed else "modal_overlap_weighted_score"
                overlap = None if seed else self.metric.overlap(previous_fields[identity], field)
                confidence = (1. if position == 0 else 0.) if seed else .85 * overlap + .15
                points.append(dict(sample_index=sample_id, raw_mode_index=raw,
                    frequency_real_hz=1e10, frequency_imag_hz=0., tracking_confidence=confidence,
                    tracking_score_source=source, overlap_prev=overlap,
                    tracking_edge=dict(policy=policy.copy(), score_source=source,
                        metric="unavailable" if seed else "consistent_p1_tet4_cartesian_nodal_envelope",
                        transition=transition, previous_sample_index=None if seed else previous["sample_index"],
                        previous_raw_mode_index=None if seed else previous["raw_mode_index"],
                        skipped_sample_count=0 if seed else (sample_id-previous["sample_index"])//7-1,
                        subspace=None)))
                previous_fields[identity] = field
            samples.append(dict(sample_index=sample_id, k_vector=[position,0,0], modes=spectrum))
        branches = dict(tracking_policy_availability="complete", tracking_method=policy["method"],
            overlap_floor=policy["overlap_floor"], frequency_window_hz=None,
            branches=[dict(branch_id=identity, points=points) for identity,points in histories.items()])
        return modes, branches, samples

    def replay(self, path, max_gap):
        return replay_recorded_frames(self.metric, *self.build(path, max_gap))

    def test_gap_retains_last_frame_and_frequency(self):
        result = self.replay([[(0,9,self.x)], [], [(0,7,self.x)]], 1)
        self.assertEqual(result["assignment_replay"], "pass", result)
        self.assertEqual(result["branch_lifecycle_scope"], "complete_history")
        self.assertEqual(result["global_assignment_verification"][0]["branch_count"], 0)

    def test_gap_frequency_score_uses_retained_endpoint(self):
        modes, branches, samples = self.build([[(0,9,self.x)], [], [(0,7,self.x)]], 1)
        point = branches["branches"][0]["points"][-1]
        frequency = 1e10 + 1e6
        point.update(frequency_real_hz=frequency,
            tracking_confidence=.85 + .15 * _frequency_score(1e10, frequency, None))
        samples[-1]["modes"][0]["frequency_real_hz"] = frequency
        modes[(24,7)]["frequency_real_hz"] = frequency
        result = replay_recorded_frames(self.metric, modes, branches, samples)
        self.assertEqual(result["assignment_replay"], "pass", result)

    def test_expired_branch_restarts_with_new_id(self):
        result = self.replay([[(0,9,self.x)], [], [(1,7,self.x)]], 0)
        self.assertEqual(result["assignment_replay"], "pass", result)
        self.assertEqual(result["global_assignment_verification"][1]["birth_count"], 1)

    def test_birth_and_disappearance_with_changing_mode_count(self):
        result = self.replay([[(0,9,self.x)], [(0,2,self.x),(1,6,self.y)], [(0,7,self.x)]], 0)
        self.assertEqual(result["assignment_replay"], "pass", result)
        self.assertEqual(result["global_assignment_verification"][0]["birth_count"], 1)

    def test_empty_initial_sample_then_birth(self):
        result = self.replay([[], [(0,7,self.x)]], 0)
        self.assertEqual(result["assignment_replay"], "pass", result)

    def test_unnecessary_birth_cannot_replace_eligible_match(self):
        result = self.replay([[(0,9,self.x)], [(1,7,self.x)]], 0)
        self.assertEqual(result["assignment_replay"], "NOT VERIFIED")
        self.assertEqual(result["global_assignment_verification"][0]["status"], "fail")

    def test_noncanonical_birth_id_rejected(self):
        result = self.replay([[(0,9,self.x)], [(0,2,self.x),(8,6,self.y)]], 0)
        self.assertEqual(result["assignment_replay"], "NOT VERIFIED")
        self.assertIn("birth allocation", result["global_assignment_verification"][0]["reason"])

    def test_mixed_retained_samples_disable_subspaces(self):
        result = self.replay([[(0,9,self.x),(1,8,self.y)], [(0,2,self.x)],
            [(0,7,(self.x+self.y)/np.sqrt(2)), (1,6,(self.x-self.y)/np.sqrt(2))]], 1)
        self.assertEqual(result["assignment_replay"], "pass", result)
        self.assertEqual(result["global_policy_predictions"][1]["selected_groups"], [])


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
        branches = _tracking_fixture_payload([dict(branch_id=0, points=[point])])
        (self.root / "eigen/spectrum.v2.json").write_text(json.dumps(dict(samples=[sample])))
        (self.root / "eigen/branches.v2.json").write_text(json.dumps(branches))
        result = replay_tracking_fields(self.root, selected_branch_ids=[0])
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
        branches = _tracking_fixture_payload([dict(branch_id=0, points=points)])
        (self.root / "eigen/spectrum.v2.json").write_text(json.dumps(dict(samples=samples)))
        (self.root / "eigen/branches.v2.json").write_text(json.dumps(branches))
        return branches

    def test_disk_signed_path_replays_actual_edges(self):
        self.write_pair_path()
        result = replay_tracking_fields(self.root, selected_branch_ids=[0])
        self.assertEqual(result["status"], "pass", result)
        self.assertEqual(len(result["replayed_edges"]), 2)
        self.assertEqual(result["qualification"], "NOT VERIFIED")
        self.assertEqual(result["assignment_replay"], "pass")

    def test_unselected_candidate_without_field_blocks_replay(self):
        self.write_pair_path()
        path = self.root / "eigen/spectrum.v2.json"
        spectrum = json.loads(path.read_text())
        candidate = copy.deepcopy(spectrum["samples"][1]["modes"][0])
        candidate["raw_mode_index"] = 41
        spectrum["samples"][1]["modes"].append(candidate)
        path.write_text(json.dumps(spectrum))
        result = replay_tracking_fields(self.root, selected_branch_ids=[0])
        self.assertEqual(result["status"], "missing", result)
        self.assertTrue(any("mode_0041" in reason for reason in result["reasons"]))

    def add_unselected_candidate_field(self):
        self.write_pair_path()
        path = self.root / "eigen/spectrum.v2.json"
        spectrum = json.loads(path.read_text())
        candidate = copy.deepcopy(spectrum["samples"][1]["modes"][0])
        candidate["raw_mode_index"] = 41
        spectrum["samples"][1]["modes"].append(candidate)
        path.write_text(json.dumps(spectrum))
        original = self.root / "eigen/modes/sample_0001/mode_0002.json"
        mode = json.loads(original.read_text())
        mode["raw_mode_index"] = 41
        source = self.root / mode["compatibility_binary_payload_path"]
        relative = "eigen/mode_fields/sample_0001/mode_0041/vector.bin"
        target = self.root / relative
        target.parent.mkdir(parents=True)
        target.write_bytes(source.read_bytes())
        mode["compatibility_binary_payload_path"] = relative
        mode_path = self.root / "eigen/modes/sample_0001/mode_0041.json"
        mode_path.write_text(json.dumps(mode))
        return mode_path

    def test_unselected_candidate_is_loaded_and_hashed(self):
        self.add_unselected_candidate_field()
        result = replay_tracking_fields(self.root, selected_branch_ids=[0])
        self.assertEqual(result["status"], "pass", result)
        self.assertEqual(result["candidate_field_coverage"]["exported_candidate_count"], 4)
        self.assertTrue(any("mode_0041/vector.bin" in item["path"] for item in result["file_hashes"]))
        self.assertEqual(result["assignment_replay"], "NOT VERIFIED")

    def test_unselected_candidate_frequency_mismatch_is_rejected(self):
        path = self.add_unselected_candidate_field()
        mode = json.loads(path.read_text())
        mode["frequency_real_hz"] *= 1.01
        path.write_text(json.dumps(mode))
        result = replay_tracking_fields(self.root, selected_branch_ids=[0])
        self.assertEqual(result["status"], "fail", result)
        self.assertTrue(any("candidate field frequency" in reason for reason in result["reasons"]))

    def test_duplicate_unselected_candidate_id_is_rejected(self):
        self.add_unselected_candidate_field()
        path = self.root / "eigen/spectrum.v2.json"
        spectrum = json.loads(path.read_text())
        spectrum["samples"][1]["modes"].append(spectrum["samples"][1]["modes"][-1])
        path.write_text(json.dumps(spectrum))
        result = replay_tracking_fields(self.root, selected_branch_ids=[0])
        self.assertEqual(result["status"], "fail", result)
        self.assertTrue(any("duplicate candidate" in reason for reason in result["reasons"]))

    def test_coherent_nonpositive_unselected_candidate_is_rejected(self):
        path = self.add_unselected_candidate_field()
        for frequency in (0., -1e10):
            with self.subTest(frequency=frequency):
                mode = json.loads(path.read_text())
                mode["frequency_real_hz"] = frequency
                path.write_text(json.dumps(mode))
                spectrum_path = self.root / "eigen/spectrum.v2.json"
                spectrum = json.loads(spectrum_path.read_text())
                spectrum["samples"][1]["modes"][-1]["frequency_real_hz"] = frequency
                spectrum_path.write_text(json.dumps(spectrum))
                result = replay_tracking_fields(self.root, selected_branch_ids=[0])
                self.assertEqual(result["status"], "fail", result)
                self.assertTrue(any("positive" in reason for reason in result["reasons"]))

    def test_disk_forged_score_and_supplied_verdict_cannot_pass(self):
        branches = self.write_pair_path()
        branches["branches"][0]["points"][1]["tracking_confidence"] = .8
        (self.root / "eigen/branches.v2.json").write_text(json.dumps(branches))
        (self.root / "tracking_replay.json").write_text(json.dumps(dict(status="pass", qualification="QUALIFIED")))
        result = replay_tracking_fields(self.root, selected_branch_ids=[0])
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

    def test_replay_must_match_initial_gate_bound_header_bytes(self):
        self.write_pair_path()
        initial = replay_tracking_fields(self.root)
        self.assertEqual(initial["status"], "pass", initial)
        hashes = {item["path"]: item["sha256"] for item in initial["file_hashes"]}
        path = self.root / "eigen/modes/sample_0001/mode_0002.json"
        path.write_text(path.read_text() + " ")
        report = replay_tracking_fields(self.root, expected_hashes=hashes)
        self.assertEqual(report["status"], "fail", report)
        self.assertTrue(any("gate-bound" in reason for reason in report["reasons"]))

    def test_selected_branch_ids_do_not_filter_global_candidate_scope(self):
        branches = self.write_pair_path()
        spectrum_path = self.root / "eigen/spectrum.v2.json"
        spectrum = json.loads(spectrum_path.read_text())
        nodes = np.array(json.loads((self.root / "metadata.json").read_text())[
            "execution_plan"]["backend_plan"]["mesh"]["nodes"])
        points = []
        for sample in spectrum["samples"]:
            index = sample["sample_index"]
            raw = 64 + index
            source = sample["modes"][0]["raw_mode_index"]
            mode = json.loads((self.root / f"eigen/modes/sample_{index:04d}/mode_{source:04d}.json").read_text())
            field = self.envelope.conjugate() * np.exp(-1j * (nodes @ sample["k_vector"]))[:, None]
            data = np.stack([field.real, field.imag], axis=-1).astype("<f8").tobytes()
            relative = f"eigen/mode_fields/sample_{index:04d}/mode_{raw:04d}/vector.bin"
            vector = self.root / relative
            vector.parent.mkdir(parents=True)
            vector.write_bytes(data)
            mode.update(raw_mode_index=raw, frequency_real_hz=2e10,
                        compatibility_binary_payload_path=relative,
                        payload_sha256="sha256:" + hashlib.sha256(data).hexdigest())
            (self.root / f"eigen/modes/sample_{index:04d}/mode_{raw:04d}.json").write_text(json.dumps(mode))
            sample["modes"].append({key: mode[key] for key in
                ("raw_mode_index", "frequency_real_hz", "frequency_imag_hz")})
            points.append(dict(sample_index=index, raw_mode_index=raw, frequency_real_hz=2e10,
                               frequency_imag_hz=0., tracking_confidence=1.))
        extra = _tracking_fixture_payload([dict(branch_id=1, points=points)])["branches"][0]
        branches["branches"].append(extra)
        spectrum_path.write_text(json.dumps(spectrum))
        (self.root / "eigen/branches.v2.json").write_text(json.dumps(branches))
        result = replay_tracking_fields(self.root, selected_branch_ids=[0])
        self.assertEqual(result["status"], "pass", result)
        self.assertEqual(result["replayed_branch_scope"], "all_candidates")
        self.assertEqual(result["selected_branch_ids"], [0])
        self.assertEqual(result["branch_count"], 2)
        self.assertEqual(result["assignment_replay"], "pass")
        self.assertEqual(result["candidate_field_coverage"]["exported_candidate_count"], 6)

    def test_invalid_selected_branch_ids_fail_closed(self):
        self.write_pair_path()
        for ids in ([], [False], [-1], [3.0], [999]):
            with self.subTest(ids=ids):
                self.assertEqual(replay_tracking_fields(self.root, selected_branch_ids=ids)["status"], "fail")

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
