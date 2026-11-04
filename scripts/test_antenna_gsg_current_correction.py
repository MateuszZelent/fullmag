"""Exact small Tet4 checks for the preregistered current correction, not a solve."""
import math
import unittest


def sample(index=0, scale=1., sigma=2., correction=(0., 0., 0.), slope=0., shift=(0., 0., 0.), gauge=0.):
    base=((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.))
    vertices=[tuple(scale*v[k]+shift[k] for k in range(3)) for v in base]
    ids=tuple(range(4*index,4*index+4))
    currents=[(sigma+correction[0]+slope*(v[0]-shift[0]),
               correction[1]+slope*(v[1]-shift[1]),
               correction[2]+slope*(v[2]-shift[2])) for v in vertices]
    center=[sum(v[k] for v in vertices)/4 for k in range(3)]
    mean=[sum(j[k] for j in currents)/4 for k in range(3)]
    row=(index,*ids,*(x for v in vertices for x in v),*(x for j in currents for x in j),*center,*mean)
    return row,{i:gauge-v[0] for i,v in zip(ids,vertices)}


def evaluate(rows, potential, sigmas, count=None):
    from antenna_gsg_current_correction import weighted_rt0_h1_correction
    return weighted_rt0_h1_correction(iter(rows),potential,iter(sigmas),len(rows) if count is None else count)


class GsgCurrentCorrectionTests(unittest.TestCase):
    def test_identical_h1_and_rt0_give_zero_correction(self):
        row,v=sample();result=evaluate([row],v,[2.])
        self.assertEqual(result['eta'],0.)
        self.assertAlmostEqual(float(result['h1_energy_W']),1/3)
        self.assertFalse(result['qualified_basis'])
        self.assertEqual(result['qualification'],'NOT VERIFIED')

    def test_constant_offset_has_exact_relative_norm(self):
        row,v=sample(correction=(.1,0.,0.));result=evaluate([row],v,[2.])
        self.assertAlmostEqual(result['eta'],.05)

    def test_affine_rt0_uses_degree_two_integral_not_centroid_rule(self):
        row,v=sample(slope=1.);result=evaluate([row],v,[2.])
        self.assertAlmostEqual(result['eta'],math.sqrt(.075))
        self.assertNotAlmostEqual(result['eta'],math.sqrt(3/64))

    def test_volume_and_inverse_conductivity_weighting(self):
        a,va=sample();b,vb=sample(1,scale=2.,sigma=4.,correction=(.4,0.,0.))
        result=evaluate([a,b],va|vb,[2.,4.])
        self.assertAlmostEqual(result['eta'],math.sqrt((8*.16/4)/(4/2+8*16/4)))
        self.assertEqual(result['cells_completed'],2)

    def test_current_sign_voltage_gauge_and_translation_do_not_change_eta(self):
        a,va=sample(correction=(.1,0.,0.))
        b,vb=sample(correction=(.1,0.,0.),shift=(4.,-3.,7.),gauge=16.)
        expected=evaluate([a],va,[2.])['eta']
        self.assertAlmostEqual(evaluate([b],vb,[2.])['eta'],expected)
        negative=list(a)
        for i in range(17,29):negative[i]*=-1
        for i in range(32,35):negative[i]*=-1
        self.assertAlmostEqual(evaluate([negative],{i:-x for i,x in va.items()},[2.])['eta'],expected)

    def test_tilted_tetrahedron_recovers_all_gradient_components(self):
        vertices=((1.,2.,3.),(3.,2.,4.),(2.,5.,3.),(1.,3.,7.))
        current=(2.,4.,6.);center=tuple(sum(v[k] for v in vertices)/4 for k in range(3))
        row=(0,0,1,2,3,*(x for v in vertices for x in v),*(x for _ in vertices for x in current),*center,*current)
        potential={i:9.-sum((k+1)*v[k] for k in range(3)) for i,v in enumerate(vertices)}
        self.assertLess(evaluate([row],potential,[2.])['eta'],1e-110)

    def test_missing_or_unused_potential_identity_is_refused(self):
        row,v=sample()
        for altered in [{k:x for k,x in v.items() if k!=2},v|{99:0.}]:
            with self.assertRaises(ValueError):evaluate([row],altered,[2.])

    def test_coincident_source_cut_ids_keep_independent_potential_values(self):
        a,va=sample();b,vb=sample(1,gauge=5.)
        result=evaluate([a,b],va|vb,[2.,2.])
        self.assertEqual(result['eta'],0.)
        self.assertAlmostEqual(float(result['h1_energy_W']),2/3)

    def test_zero_h1_denominator_is_refused_not_reported_as_zero_eta(self):
        row,v=sample()
        with self.assertRaisesRegex(ValueError,'zero H1'):evaluate([row],{i:0. for i in v},[2.])

    def test_partial_extra_or_reordered_carrier_is_refused(self):
        row,v=sample()
        for rows,sigmas,count in [([],[],1),([row],[2.],2),([row,row],[2.,2.],1),([row],[],1),([row],[2.,2.],1)]:
            with self.subTest(count=count),self.assertRaises(ValueError):evaluate(rows,v,sigmas,count)
        bad=list(row);bad[0]=1
        with self.assertRaises(ValueError):evaluate([bad],v,[2.])

    def test_nonfinite_data_nonpositive_sigma_and_boolean_are_refused(self):
        row,v=sample()
        for sigma in [0.,-1.,math.nan,math.inf,True]:
            with self.subTest(sigma=sigma),self.assertRaises(ValueError):evaluate([row],v,[sigma])
        for invalid in [math.nan,math.inf,True]:
            with self.assertRaises(ValueError):evaluate([row],v|{0:invalid},[2.])

    def test_reversed_degenerate_and_non_rt0_data_are_refused(self):
        row,v=sample()
        for vertex in [(0.,-1.,0.),(0.,0.,0.)]:
            bad=list(row);bad[11:14]=vertex
            with self.assertRaises(ValueError):evaluate([bad],v,[2.])
        bad=list(row);bad[17]+=.1
        with self.assertRaisesRegex(ValueError,'RT0'):evaluate([bad],v,[2.])


class PartitionedCurrentCorrectionTests(unittest.TestCase):
    def evaluate_parts(self, rows, potentials, sigmas, parts):
        from antenna_gsg_current_correction import partitioned_weighted_rt0_h1_correction
        return partitioned_weighted_rt0_h1_correction(iter(rows), potentials, iter(sigmas), len(rows), parts)

    def test_partition_sums_energies_instead_of_averaging_eta(self):
        a,va=sample(correction=(.2,0.,0.))
        b,vb=sample(1,scale=2.,sigma=4.,correction=(.8,0.,0.))
        result=self.evaluate_parts([a,b],va|vb,[2.,4.],{'inlet':[0],'signal':[1]})
        direct=evaluate([a,b],va|vb,[2.,4.])
        self.assertAlmostEqual(result['eta'],direct['eta'])
        self.assertNotAlmostEqual(result['eta'],.15)
        self.assertAlmostEqual(sum(p['correction_energy_fraction'] for p in result['parts']),1.)
        self.assertAlmostEqual(sum(p['h1_energy_fraction'] for p in result['parts']),1.)
        self.assertFalse(result['qualified_basis'])
        self.assertFalse(result['continuum_error_bound'])
        self.assertFalse(result['field_error_bound'])

    def test_noncontiguous_parts_keep_source_cut_ids_and_all_local_traces(self):
        rows=[];potentials={}
        for i in range(3):
            row,v=sample(i,gauge=5.*i,correction=(.1*i,0.,0.));rows.append(row);potentials.update(v)
        result=self.evaluate_parts(rows,potentials,[2.]*3,{'connectors':[2,0],'signal':[1]})
        self.assertEqual([p['source_cells'] for p in result['parts']],[2,1])
        self.assertAlmostEqual(result['eta'],evaluate(rows,potentials,[2.]*3)['eta'])

    def test_neighboring_parts_share_vertex_ids_without_unused_potential_entries(self):
        a,va=sample(correction=(.1,0.,0.))
        vertices=((1.,0.,0.),(0.,1.,0.),(0.,0.,1.),(1.,1.,1.))
        ids=(1,2,3,4);current=(2.2,0.,0.)
        center=tuple(sum(v[k] for v in vertices)/4 for k in range(3))
        b=(1,*ids,*(x for v in vertices for x in v),*(x for _ in vertices for x in current),*center,*current)
        potential=va|{4:-1.}
        result=self.evaluate_parts([a,b],potential,[2.,2.],{'signal':[0],'inlet':[1]})
        self.assertAlmostEqual(result['eta'],evaluate([a,b],potential,[2.,2.])['eta'])
        self.assertAlmostEqual(result['parts'][0]['eta'],.05)
        self.assertAlmostEqual(result['parts'][1]['eta'],.1)

    def test_zero_global_correction_has_undefined_fraction_not_zero_error_claim(self):
        row,v=sample();result=self.evaluate_parts([row],v,[2.],{'signal':[0]})
        self.assertEqual(result['eta'],0.)
        self.assertIsNone(result['parts'][0]['correction_energy_fraction'])
        self.assertEqual(result['parts'][0]['h1_energy_fraction'],1.)

    def test_missing_duplicate_overlapping_and_invalid_ordinals_are_refused(self):
        a,va=sample();b,vb=sample(1)
        for parts in [{}, {'a':[],'b':[0,1]}, {'a':[0]}, {'a':[0,0,1]},
                      {'a':[0],'b':[0,1]}, {'a':[0,2]}, {'a':[0,-1]},
                      {'a':[False,1]}, {'a':[0,1.]}, {'':[0,1]}]:
            with self.subTest(parts=parts),self.assertRaises(ValueError):
                self.evaluate_parts([a,b],va|vb,[2.,2.],parts)

    def test_global_carrier_order_and_unused_or_boolean_potential_ids_are_refused(self):
        a,va=sample();b,vb=sample(1)
        for rows,potentials,sigmas in [([b,a],va|vb,[2.,2.]),([a,b],va|vb|{99:0.},[2.,2.]),
                                       ([a,b],{False:va[0],**{k:v for k,v in (va|vb).items() if k!=0}},[2.,2.]),
                                       ([a,b],va|vb,[2.]),([a,b],va|vb,[2.,2.,2.])]:
            with self.assertRaises(ValueError):self.evaluate_parts(rows,potentials,sigmas,{'a':[0],'b':[1]})

    def test_zero_h1_part_is_refused_even_when_global_h1_is_nonzero(self):
        a,va=sample();b,vb=sample(1)
        with self.assertRaisesRegex(ValueError,'zero H1'):
            self.evaluate_parts([a,b],va|{i:0. for i in vb},[2.,2.],{'signal':[0],'inlet':[1]})

    def test_iterables_are_bounded_before_materialization(self):
        from itertools import repeat
        from antenna_gsg_current_correction import partitioned_weighted_rt0_h1_correction
        row,v=sample()
        for cells,sigma,parts in [(repeat(row),[2.],{'a':[0]}),([row],repeat(2.),{'a':[0]}),
                                  ([row],[2.],{'a':repeat(0)})]:
            with self.assertRaises(ValueError):
                partitioned_weighted_rt0_h1_correction(cells,v,sigma,1,parts)


if __name__=='__main__':unittest.main()
