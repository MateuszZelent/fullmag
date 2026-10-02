"""Tracking publication source contracts and independent signed-k algebra.

These checks do not execute the Rust tracker or qualify a FEM runtime.
"""
import cmath
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


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
