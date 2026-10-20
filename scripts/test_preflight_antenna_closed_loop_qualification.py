"""Interpreted regressions for exact geometric admission, not solver qualification."""
import copy
import math
import unittest

import numpy as np

from preflight_antenna_closed_loop_qualification import (
    check_planes, classify_probes, cut_pairs, in_tetrahedron, on_segment,
    on_triangle, point_record, semantic_owner_admission, topology, work_admission,
)


class GeometryPreflightTests(unittest.TestCase):
    def setUp(self):
        self.nodes=np.asarray(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)))
        self.cells=np.asarray(((0,1,2,3),))

    def test_exact_triangle_edge_and_ulp_off_plane(self):
        triangle=self.nodes[[0,1,2]]
        self.assertTrue(on_triangle((.5,.5,0.),triangle))
        self.assertFalse(on_triangle((.5,.5,math.nextafter(0.,1.)),triangle))
        self.assertTrue(on_segment((.5,.5,0.),triangle[[1,2]]))
        self.assertTrue(on_segment((1.,0.,0.),triangle[[1,2]]))
        self.assertFalse(on_segment((.5,math.nextafter(.5,1.),0.),triangle[[1,2]]))

    def test_exact_tet_boundary_inside_and_outside(self):
        self.assertEqual(in_tetrahedron((.125,.125,.125),self.nodes),(True,False))
        self.assertEqual(in_tetrahedron((0.,.5,.5),self.nodes),(True,True))
        self.assertEqual(in_tetrahedron((0.,.5,math.nextafter(.5,1.)),self.nodes)[0],False)

    def test_semantic_edge_classification_does_not_snap(self):
        _,physical=topology(self.nodes,self.cells)
        constants={"inlet_x":0.,"inlet_y":0.}
        probe=point_record("E3","edge",(0.,0.,.5))
        classify_probes(self.nodes,self.cells,physical,[],constants,[probe])
        self.assertTrue(probe["semantic_edge_segments"])
        shifted=point_record("E3","edge",(math.nextafter(0.,1.),0.,.5))
        with self.assertRaisesRegex(ValueError,"exact semantic edge"):
            classify_probes(self.nodes,self.cells,physical,[],constants,[shifted])

    def test_semantic_plane_drift_is_refused(self):
        source={"material_parts":[{"part_id":p,"element_ordinals":[0]} for p in ("signal","return","inlet")]}
        constants={"signal_top":1.,"return_side":1.,"return_top":1.,"inlet_x":0.,"inlet_y":1.}
        check_planes(self.nodes,self.cells,source,constants)
        changed=self.nodes.copy();changed[3,2]=math.nextafter(1.,0.)
        with self.assertRaisesRegex(ValueError,"signal_top"):
            check_planes(changed,self.cells,source,constants)

    def test_coincident_physical_face_reuse_preserves_distinct_dofs(self):
        nodes=np.asarray((*self.nodes,(0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,-1.)))
        cells=np.asarray(((0,1,2,3),(4,6,5,7)))
        topological,physical=topology(nodes,cells)
        self.assertEqual(len(topological),8)
        self.assertEqual(len(physical),7)
        source={"stable_vertex_ids":list(range(1,9)),"closure":{"source_cuts":[{
            "translation_m":[0.,0.,0.],"face_pairs":[{
                "minus_face_vertex_ids":[1,2,3],"plus_face_vertex_ids":[5,6,7]}]}]}}
        pairs,_=cut_pairs(nodes,cells,source,topological)
        self.assertEqual(pairs,{1:5,2:6,3:7})
        drift=nodes.copy();drift[4,2]=math.nextafter(0.,1.)
        with self.assertRaisesRegex(ValueError,"xyz drift"):
            cut_pairs(drift,cells,source,topological)

    def test_same_side_cut_owners_are_refused(self):
        nodes=np.asarray((*self.nodes,(0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(.2,.2,1.)))
        cells=np.asarray(((0,1,2,3),(4,5,6,7)))
        topological,_=topology(nodes,cells)
        source={"stable_vertex_ids":list(range(1,9)),"closure":{"source_cuts":[{
            "translation_m":[0.,0.,0.],"face_pairs":[{
                "minus_face_vertex_ids":[1,2,3],"plus_face_vertex_ids":[5,6,7]}]}]}}
        with self.assertRaisesRegex(ValueError,"opposite physical sides"):
            cut_pairs(nodes,cells,source,topological)

    def test_missing_ledger_refuses_even_when_partial_skew_evades_diagnostic(self):
        # All extrema match, but one top vertex drifts inward; extrema alone cannot certify coverage.
        nodes=self.nodes.copy();nodes[1]=(.1,0.,.5)
        source={"material_parts":[{"part_id":p,"element_ordinals":[0]} for p in ("signal","return","inlet")]}
        constants={"signal_top":1.,"return_side":1.,"return_top":1.,"inlet_x":0.,"inlet_y":1.}
        measurements=[]
        check_planes(nodes,self.cells,source,constants,measurements)
        self.assertTrue(all(row["exact_match"] for row in measurements))
        self.assertTrue(all(row["evidence_role"]=="DIAGNOSTIC_ONLY" for row in measurements))
        admission=semantic_owner_admission()
        self.assertFalse(admission["admitted"])
        self.assertEqual(admission["status"],"INCONCLUSIVE")
        self.assertIn("missing canonical CAD",admission["reason"])

    def test_separate_target_and_case_work_limits(self):
        admitted=work_admission(12000,30000,18,3000,31000)
        self.assertTrue(admitted["admitted"])
        self.assertEqual(admitted["fixed_pass_lower_bound"]["oracle_evaluations_per_target"],64800000)
        self.assertEqual(admitted["fixed_pass_lower_bound"]["oracle_evaluations_per_case"],1166400000)
        case=work_admission(12000,30000,32,3000,31000)
        self.assertFalse(case["admitted"])
        self.assertTrue(any("per_case" in reason for reason in case["refusals"]))
        self.assertFalse(any("per_target" in reason for reason in case["refusals"]))
        target=work_admission(12000,50000,1,3000,31000)
        self.assertTrue(any("per_target" in reason for reason in target["refusals"]))

    def test_native_pair_and_dof_limits_are_not_oracle_gates(self):
        result=work_admission(100001,10,10,100001,400001)
        self.assertEqual(len(result["refusals"]),3)
        self.assertTrue(any("native_source_target_pairs" in reason for reason in result["refusals"]))


if __name__=="__main__":
    unittest.main()