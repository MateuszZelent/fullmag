"""Global-policy algebra fixtures; no native FEM runtime qualification."""
import unittest

import numpy as np

from comsol_tracking_global import reconstruct_global_assignment, _select_edges
from comsol_tracking_metric import Tet4TrackingMetric
from comsol_tracking_replay import _frequency_score


class GlobalAssignmentTests(unittest.TestCase):
    def setUp(self):
        self.metric = Tet4TrackingMetric([[0.,0,0],[1.,0,0],[0.,1.,0],[0.,0,1.]], [[0,1,2,3]], [0])
        self.x = np.tile([1.,0,0], (4,1)).astype(complex)
        self.y = np.tile([0.,1.,0], (4,1)).astype(complex)
        self.policy = dict(method="overlap_hungarian", overlap_floor=.5, frequency_window_hz=None)

    def mode(self, raw, frequency, field):
        return dict(raw_mode_index=raw, frequency_real_hz=frequency, frequency_imag_hz=0., envelope=field)

    def test_pair_assignment_uses_all_candidates_and_modal_frames(self):
        modes = [self.mode(41, 1e10, self.y), self.mode(7, 2e10, self.x)]
        result = reconstruct_global_assignment(self.metric, {3:self.x,4:self.y},
            [(3,1e10,0.),(4,2e10,0.)], modes, self.policy, _frequency_score)
        self.assertEqual({identity: edge["raw_mode_index"] for identity, edge in result["matches"].items()}, {3:7,4:41})
        self.assertEqual(result["selected_groups"], [])
        self.assertEqual(result["qualification"], "NOT VERIFIED")

    def test_degenerate_transport_retains_previous_frame_order(self):
        modes = [self.mode(41,1e10,(self.x+1j*self.y)/np.sqrt(2)),
                 self.mode(7,1e10,(1j*self.x+self.y)/np.sqrt(2))]
        result = reconstruct_global_assignment(self.metric, {3:self.x,4:self.y},
            [(3,1e10,0.),(4,1e10,0.)], modes, self.policy, _frequency_score)
        self.assertEqual(len(result["selected_groups"]), 1)
        self.assertEqual(result["selected_groups"][0]["transition"], "degenerate_to_degenerate")
        self.assertEqual({edge["raw_mode_index"] for edge in result["matches"].values()}, {7,41})
        self.assertAlmostEqual(self.metric.overlap(result["next_frames"][3], self.x), 1.)
        self.assertAlmostEqual(self.metric.overlap(result["next_frames"][4], self.y), 1.)

    def test_group_floor_uses_principal_angle_not_blended_score(self):
        # Different two-dimensional subspaces intersect in one direction.
        z = np.tile([0.,0,1.],(4,1)).astype(complex)
        result = reconstruct_global_assignment(self.metric, {3:self.x,4:self.y},
            [(3,1e10,0.),(4,1e10,0.)], [self.mode(41,1e10,self.x),self.mode(7,1e10,z)], self.policy, _frequency_score)
        self.assertEqual(result["selected_groups"], [])
        self.assertEqual(set(result["matches"]), {3})

    def test_hungarian_and_greedy_policies_differ_on_counterexample(self):
        edges = [dict(branch_id=row,mode_slot=column,score=score)
                 for row,column,score in ((3,0,.9),(3,1,.8),(4,0,.85),(4,1,.1))]
        self.assertEqual({edge["branch_id"]:edge["mode_slot"] for edge in _select_edges(edges,2,"overlap_hungarian")}, {3:1,4:0})
        self.assertEqual({edge["branch_id"]:edge["mode_slot"] for edge in _select_edges(edges,2,"overlap_greedy")}, {3:0,4:1})

    def test_dummy_does_not_force_ineligible_real_pair(self):
        edges = [dict(branch_id=3,mode_slot=0,score=.9),dict(branch_id=4,mode_slot=0,score=.8)]
        result = _select_edges(edges,2,"overlap_hungarian")
        self.assertEqual([(edge["branch_id"],edge["mode_slot"]) for edge in result], [(3,0)])

    def test_missing_frame_and_duplicate_raw_ids_rejected(self):
        for frames, modes in (({},[self.mode(7,1e10,self.x)]),
                              ({3:self.x},[self.mode(7,1e10,self.x),self.mode(7,2e10,self.y)])):
            with self.assertRaises(ValueError):
                reconstruct_global_assignment(self.metric,frames,[(3,1e10,0.)],modes,self.policy,_frequency_score)


if __name__ == "__main__":
    unittest.main()
