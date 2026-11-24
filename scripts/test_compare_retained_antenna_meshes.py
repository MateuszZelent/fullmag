"""Exact-volume regressions for retained-current source diagnostics."""
import importlib
import unittest
import numpy as np

try:
    analysis=importlib.import_module("compare_retained_antenna_meshes")
except ModuleNotFoundError:
    analysis=None

class RetainedMeshTests(unittest.TestCase):
    def implementation(self):
        self.assertIsNotNone(analysis,"Retained-source mesh comparison is not implemented")
        return analysis

    def test_constant_current_squared_uses_physical_tetra_volume(self):
        module=self.implementation()
        length=1e-6
        vertices=length*np.array([[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]]])
        coefficients=length**2*np.array([[9.,-2.,-3.,-4.]])
        actual=module.integrated_current_squared(vertices,coefficients)
        self.assertAlmostEqual(float(actual/(29e-18/6)),1.,places=13)

    def test_affine_current_requires_second_moment(self):
        module=self.implementation()
        vertices=np.array([[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]]])
        coefficients=np.array([[1.,0.,0.,0.]])
        # J=(x,y,z); integral of x^2+y^2+z^2 over the unit Tet is 3/60.
        self.assertAlmostEqual(float(module.integrated_current_squared(vertices,coefficients)),1/20,places=14)

    def test_current_reversal_translation_and_geometric_scaling(self):
        module=self.implementation()
        vertices=np.array([[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]]])
        coefficients=np.array([[9.,-2.,-3.,-4.]])
        original=module.integrated_current_squared(vertices,coefficients)
        shifted=module.integrated_current_squared(vertices+np.array([2.,-3.,4.]),-coefficients)
        enlarged=module.integrated_current_squared(2*vertices,coefficients)
        doubled=module.integrated_current_squared(vertices,2*coefficients)
        self.assertAlmostEqual(float(shifted/original),1.,places=14)
        self.assertAlmostEqual(float(enlarged/original),.5,places=14)
        self.assertAlmostEqual(float(doubled/original),4.,places=14)

    def test_degenerate_negative_and_nonfinite_sources_are_rejected(self):
        module=self.implementation()
        good=np.array([[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]]])
        negative=good.copy()
        negative[:,[1,2]]=negative[:,[2,1]]
        flat=good.copy()
        flat[:,:,2]=0
        bad=good.copy()
        bad[0,0,0]=float("nan")
        for vertices,coefficients in [(negative,np.ones((1,4))),(flat,np.ones((1,4))),
                                      (bad,np.ones((1,4))),(good,np.ones((1,3)))]:
            with self.assertRaises(ValueError):
                module.integrated_current_squared(vertices,coefficients)

if __name__=="__main__":
    unittest.main()
