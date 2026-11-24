import unittest
import struct
import numpy as np

from audit_retained_rt0_current import current_moments, section_currents, boundary_ledger


class RetainedCurrentAuditTests(unittest.TestCase):
    def setUp(self):
        self.vertices = np.array([[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]]])
        self.constant = np.array([[1.,0.,-1.,0.]])
        self.branches = {'all':[-2.,2.]}

    def test_constant_vector_has_exact_volume_and_cross_section_flux(self):
        divergence,integral = current_moments(self.vertices,self.constant)
        np.testing.assert_allclose(divergence,[0.],atol=1e-15)
        np.testing.assert_allclose(integral,[0.,1/6,0.],atol=1e-15)
        for y in [0.,.25,.75]:
            section = section_currents(self.vertices,self.constant,y,self.branches)
            expected = (1-y)**2/2
            self.assertAlmostEqual(section['all']['current_a'],expected,places=14)
            self.assertAlmostEqual(section['all']['area_m2'],expected,places=14)

        cells = struct.pack('<5Q30d',0,0,1,2,3,*self.vertices.ravel(),*[0.]*18)
        faces = b''.join(struct.pack('<3Qd',*key,value) for key,value in [
            ((0,1,2),0.),((0,1,3),-.5),((0,2,3),0.),((1,2,3),.5)])
        ledger = boundary_ledger(cells,faces,{'source_cut_y_m':0.,
            'source_cut_x_m':[0.,1.],'source_cut_z_m':[0.,1.],
            'coordinate_matching_tolerance_m':1e-12})
        self.assertEqual(ledger['boundary_faces'],4)
        self.assertEqual(ledger['outside_cut_absolute_flux_a'],.5)
        self.assertEqual(ledger['cut_net_flux_a'],-.5)
        self.assertEqual(ledger['unpaired_source_cut_groups'],1)

    def test_linear_radial_vector_has_known_divergence_and_flux(self):
        coefficient = np.array([[1.,0.,0.,0.]])
        divergence,integral = current_moments(self.vertices,coefficient)
        np.testing.assert_allclose(divergence,[.5],atol=1e-15)
        np.testing.assert_allclose(integral,[1/24]*3,atol=1e-15)
        result = section_currents(self.vertices,coefficient,.25,self.branches)
        self.assertAlmostEqual(result['all']['current_a'],.25*.75**2/2,places=14)

    def test_translation_does_not_change_constant_flux(self):
        shift = np.array([2.,-3.,4.])
        moved = self.vertices+shift
        d,m = current_moments(moved,self.constant)
        np.testing.assert_allclose(m,[0.,1/6,0.],atol=1e-15)
        result = section_currents(moved,self.constant,-2.75,{'all':[1.,4.]})
        self.assertAlmostEqual(result['all']['current_a'],.75**2/2,places=14)

    def test_subdivision_preserves_plane_flux_without_double_counting(self):
        original = self.vertices[0]
        children = np.repeat(original[None],4,axis=0)
        center = original.mean(axis=0)
        coefficients = []
        winding = ((1,2,3),(0,3,2),(0,1,3),(0,2,1))
        for i,child in enumerate(children):
            child[i] = center
            coefficients.append([np.cross(child[b]-child[a],child[c]-child[a])[1]
                                 for a,b,c in winding])
        section = section_currents(children,np.array(coefficients),.25,self.branches)
        self.assertAlmostEqual(section['all']['current_a'],.75**2/2,places=14)
        section = section_currents(children,np.array(coefficients),.5,self.branches)
        self.assertAlmostEqual(section['all']['current_a'],.5**2/2,places=14)

    def test_outside_slice_is_zero_and_unassigned_geometry_is_rejected(self):
        result = section_currents(self.vertices,self.constant,2.,self.branches)
        self.assertEqual(result['all']['current_a'],0.)
        with self.assertRaises(ValueError):
            section_currents(self.vertices,self.constant,.25,{'missing':[2.,3.]})
        with self.assertRaises(ValueError):
            section_currents(self.vertices,self.constant,.25,{'partial':[-.1,.3]})

    def test_degenerate_negative_nonfinite_and_wrong_shape_are_rejected(self):
        for vertices,coefficients in [
                (self.vertices[:,:3],self.constant),
                (self.vertices,np.array([[np.nan,0.,0.,0.]])),
                (self.vertices[:,[0,2,1,3]],self.constant),
                (np.zeros_like(self.vertices),self.constant)]:
            with self.assertRaises(ValueError):
                current_moments(vertices,coefficients)


if __name__ == '__main__':
    unittest.main()
