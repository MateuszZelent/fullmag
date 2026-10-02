"""Tracking publication source contracts and independent signed-k algebra.

These checks do not execute the Rust tracker or qualify a FEM runtime.
"""
import cmath
import copy
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from verify_fem_frequency_domain_eigen_artifacts import validate_tracking_edge_provenance, validate_tracking_alias


def code(path):
    return re.sub(r"//[^\n]*|/\*.*?\*/", "", (ROOT / path).read_text(), flags=re.S)


def mass_inner(a, b):
    # Consistent Tet4 mass, V/20 omitted as a common positive scale.
    return sum(a[3*i+c].conjugate() * b[3*j+c] * (2 if i == j else 1)
               for i in range(4) for j in range(4) for c in range(3))


def normalized(a):
    norm = mass_inner(a, a).real ** .5
    return [value / norm for value in a]


class TrackingEdgeProvenanceTests(unittest.TestCase):
    def test_independent_artifact_validator_binds_policy_and_endpoints(self):
        policy = dict(method="overlap_hungarian", overlap_floor=.9, max_branch_gap=0)
        seed = dict(sample_index=10, raw_mode_index=19, tracking_score_source="seed",
                    tracking_edge=dict(policy=policy, score_source="seed", metric="unavailable",
                                       transition="seed", previous_sample_index=None,
                                       previous_raw_mode_index=None, skipped_sample_count=0, subspace=None))
        point = dict(sample_index=20, raw_mode_index=23,
                     tracking_score_source="modal_subspace_transport_score", overlap_prev=None,
                     tracking_edge=dict(policy=policy, score_source="modal_subspace_transport_score",
                                        metric="consistent_p1_tet4_cartesian_nodal_envelope",
                                        transition="split_to_degenerate", previous_sample_index=10,
                                        previous_raw_mode_index=19, skipped_sample_count=0,
                                        subspace=dict(rank=2, previous_cluster=0, current_cluster=0,
                                                      branch_ids=[0, 1], previous_raw_mode_indices=[19, 42],
                                                      current_raw_mode_indices=[17, 23],
                                                      principal_cosines=[1., 1.], principal_minimum=1.)))
        branches = dict(tracking_method="overlap_hungarian", overlap_floor=.9, frequency_window_hz=None,
                        tracking_policy_availability="complete", branches=[dict(branch_id=0, points=[seed, point])])
        validate_tracking_edge_provenance(branches, [10, 20])
        alias = copy.deepcopy(branches)
        alias["schema_version"] = "2"
        validate_tracking_alias(branches, alias)
        alias["branches"][0]["points"][1]["raw_mode_index"] = 99
        with self.assertRaises(SystemExit):
            validate_tracking_alias(branches, alias)
        unavailable_policy = copy.deepcopy(branches)
        unavailable_policy.pop("tracking_policy_availability")
        with self.assertRaises(SystemExit):
            validate_tracking_edge_provenance(unavailable_policy, [10, 20])
        stale = copy.deepcopy(branches)
        stale_point = copy.deepcopy(stale["branches"][0]["points"][1])
        stale_point["sample_index"] = 30
        stale_point["tracking_edge"]["skipped_sample_count"] = 1
        stale_point["tracking_edge"]["policy"]["max_branch_gap"] = 1
        stale["branches"][0]["points"].append(stale_point)
        with self.assertRaises(SystemExit):
            validate_tracking_edge_provenance(stale, [10, 20, 30])
        for key, invalid in (("previous_sample_index", 20), ("previous_raw_mode_index", 42),
                             ("skipped_sample_count", 1), ("score_source", "seed")):
            broken = copy.deepcopy(branches)
            broken["branches"][0]["points"][1]["tracking_edge"][key] = invalid
            with self.subTest(key=key), self.assertRaises(SystemExit):
                validate_tracking_edge_provenance(broken, [10, 20])
        for key, invalid in (("rank", 3), ("principal_minimum", .8),
                             ("principal_cosines", [1., float("nan")]),
                             ("current_raw_mode_indices", [17, 17])):
            broken = copy.deepcopy(branches)
            broken["branches"][0]["points"][1]["tracking_edge"]["subspace"][key] = invalid
            with self.subTest(key=key), self.assertRaises(SystemExit):
                validate_tracking_edge_provenance(broken, [10, 20])
        partial = copy.deepcopy(branches)
        partial["branches"][0]["points"][1]["tracking_edge"] = None
        partial.update(tracking_policy_availability="missing_or_mixed", tracking_method=None, overlap_floor=None)
        validate_tracking_edge_provenance(partial, [10, 20])
        partial["overlap_floor"] = .9
        with self.assertRaises(SystemExit):
            validate_tracking_edge_provenance(partial, [10, 20])

    def test_assignment_records_actual_subspace_and_policy(self):
        tracker = code("crates/fullmag-runner/src/eigen/tracking.rs")
        self.assertIn("principal_cosines: cluster.transport.principal_cosines.clone()", tracker)
        self.assertIn("principal_minimum: cluster.transport.principal_minimum", tracker)
        self.assertIn("tracking_edge.transition = cluster.transition", tracker)
        self.assertIn("tracking_edge: Some(tracking_edge)", tracker)
        self.assertIn("policy: cfg.clone()", tracker)
        self.assertIn("sample_position - previous_position - 1", tracker)
        for transition in ("DegenerateToDegenerate", "SplitToDegenerate", "DegenerateToSplit"):
            self.assertIn("transition: TrackingTransition::" + transition, tracker)

    def test_writers_publish_the_same_typed_record_before_legacy_inference(self):
        generic = code("crates/fullmag-runner/src/eigen/artifacts/modal_manifest.rs")
        fem = code("crates/fullmag-runner/src/fem/eigen_path.rs")
        adapter = code("crates/fullmag-runner/src/fem/eigen_path_artifacts.rs")
        self.assertIn("tracking_edge: point.tracking_edge.clone()", generic)
        self.assertIn('"tracking_edge": p.tracking_edge', fem)
        for source in (generic, adapter):
            start = source.index("fn " + ("branch_point_tracking_score_source" if source == generic
                                          else "eigen_path_branch_point_tracking_score_source"))
            body = source[start:]
            self.assertLess(body.index("edge.score_source.as_str()"),
                            body.index("tracking_score_source_for_modes("))
        self.assertIn("recorded_tracking_policy(result)", generic)
        self.assertIn("tracking_method: policy.map(|p| p.method)", generic)
        self.assertIn("overlap_floor: policy.map(|p| p.overlap_floor)", generic)

    def test_legacy_points_do_not_receive_fabricated_edge_evidence(self):
        loader = code("crates/fullmag-runner/src/eigen/artifacts/kittel.rs")
        self.assertIn('point.get("tracking_edge").filter(|v| !v.is_null())', loader)
        tracker = code("crates/fullmag-runner/src/eigen/tracking.rs")
        self.assertIn("point.tracking_edge.as_ref().is_some_and", tracker)
        self.assertIn("edge.policy == *policy", tracker)
        self.assertIn('invalid tracking_edge: {error}', loader)

    def test_restart_is_not_a_seed_or_a_production_overlap(self):
        tracker = code("crates/fullmag-runner/src/eigen/tracking.rs")
        self.assertIn("TrackingTransition::NewBranch => TrackingScoreSource::ModalOverlapUnavailable", tracker)
        summary = tracker[tracker.index("fn tracking_score_source_summary"):tracker.index("fn tracking_uses_frequency_fallback_views")]
        self.assertLess(summary.index('sources.contains(&"modal_overlap_unavailable")'),
                        summary.index('else if saw_weighted'))

    def test_signed_k_unwinding_reorder_and_phase_in_consistent_mass(self):
        a = normalized([1.+0j if i % 3 == 0 else 0j for i in range(12)])
        b = normalized([1.+0j if i % 3 == 1 else 0j for i in range(12)])
        positions = (0., .2e-6, .5e-6, .7e-6)
        for k, order, phases in ((-25e6, (0, 1), (.4, -.2)),
                                 (0., (1, 0), (-1.2, .9)),
                                 (25e6, (1, 0), (.7, -2.))):
            for raw_index, identity in enumerate(order):
                expected = (a, b)[identity]
                physical = [value * cmath.exp(1j*phases[raw_index] - 1j*k*positions[i//3])
                            for i, value in enumerate(expected)]
                envelope = [value * cmath.exp(1j*k*positions[i//3])
                            for i, value in enumerate(physical)]
                self.assertAlmostEqual(abs(mass_inner(expected, envelope)), 1., places=13)
                self.assertAlmostEqual(abs(mass_inner((a, b)[1-identity], envelope)), 0., places=13)
                if k:
                    self.assertLess(abs(mass_inner(expected, physical)), .99)

    def test_degenerate_rotation_has_unit_principal_cosines_without_pair_overlap(self):
        a = normalized([1.+0j if i % 3 == 0 else 0j for i in range(12)])
        b = normalized([1.+0j if i % 3 == 1 else 0j for i in range(12)])
        rotated = [[(x+y)*cmath.exp(.7j)/(2**.5) for x, y in zip(a, b)],
                   [(x-y)*cmath.exp(-1.1j)/(2**.5) for x, y in zip(a, b)]]
        gram = [[mass_inner(previous, current) for current in rotated] for previous in (a, b)]
        for i in range(2):
            for j in range(2):
                # G G^H = I proves both principal cosines equal one.
                value = sum(gram[i][c]*gram[j][c].conjugate() for c in range(2))
                self.assertAlmostEqual(abs(value - (1 if i == j else 0)), 0., places=13)
        self.assertLess(abs(gram[0][0]), .8)


if __name__ == "__main__":
    unittest.main()
