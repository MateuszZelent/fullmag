"""Independent checks of the uniform-metal Fourier attenuation, not a solver."""
import hashlib
import json
import math
from pathlib import Path
import unittest


class MetalThicknessDiagnosticTests(unittest.TestCase):
    def test_unit_argument_and_thin_limits(self):
        from antenna_metal_thickness_diagnostic import metal_thickness_factor as factor
        self.assertEqual(factor(0.,90e-9),1.)
        self.assertEqual(factor(5e6,0.),1.)
        self.assertAlmostEqual(factor(1/90e-9,90e-9),1-math.exp(-1),places=15)
        self.assertAlmostEqual(factor(1e-4,90e-9),1.,places=11)

    def test_matches_independent_layer_quadrature(self):
        from antenna_metal_thickness_diagnostic import metal_thickness_factor as factor
        count=4000
        for argument in (.001,.2,1.,4.,20.):
            # Simpson integration on z/t in [0,1], independent of expm1.
            values=[math.exp(-argument*i/count) for i in range(count+1)]
            integral=(values[0]+values[-1]+4*math.fsum(values[1:-1:2])
                      +2*math.fsum(values[2:-1:2]))/(3*count)
            self.assertAlmostEqual(factor(argument/90e-9,90e-9),integral,delta=2e-11)

    def test_even_positive_attenuation_preserves_phase_and_high_k_limit(self):
        from antenna_metal_thickness_diagnostic import metal_thickness_factor as factor
        values=[factor(k,90e-9) for k in (0.,1e6,3e6,5e6,10e6,20e6)]
        self.assertEqual(values,sorted(values,reverse=True))
        for k in (1e6,5e6,20e6):
            self.assertEqual(factor(k,90e-9),factor(-k,90e-9))
            self.assertTrue(0.<factor(k,90e-9)<1.)
        self.assertAlmostEqual(factor(1e12,90e-9)*1e12*90e-9,1.)

    def test_invalid_parameters_are_refused(self):
        from antenna_metal_thickness_diagnostic import metal_thickness_factor as factor
        for k,t in ((True,90e-9),(1.,True),(math.nan,1.),(1.,math.inf),(1.,-1.),(1e308,1e308)):
            with self.subTest(k=k,t=t),self.assertRaises(ValueError):
                factor(k,t)


    def test_midplane_comparison_separates_source_height_from_thickness_spread(self):
        from antenna_metal_thickness_diagnostic import geometry_filter_report
        value=geometry_filter_report(dict(conductor_width_m=200e-9,gap_m=250e-9,
                                         metal_thickness_m=90e-9,insulator_thickness_m=30e-9))
        self.assertAlmostEqual(value["sheet_comparison_planes_m"]["metal_midplane"],75e-9,delta=1e-22)
        row=next(r for r in value["rows"] if r["k_rad_per_m"]==10e6)
        self.assertAlmostEqual(row["center_sheet_amplitude_factor"],math.sinh(.45)/.45,places=14)
        self.assertGreater(row["center_sheet_amplitude_factor"],1.)
        self.assertLess(row["amplitude_factor"],1.)
        self.assertEqual(value["rows"][0]["center_sheet_amplitude_factor"],1.)

    def test_retained_geometry_diagnostic_has_no_native_solver_claim(self):
        from antenna_metal_thickness_diagnostic import geometry_filter_report
        path=Path(__file__).resolve().parents[1]/"examples/sushruth_2020_closed_gsg/edge_field_20261111/verification/edge-field-comparison.json"
        raw=path.read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(),"615f0e95379fe39cba2a93eacdd13f35acdd1256bb88c8708c16b4b665a325bf")
        geometry=json.loads(raw)["parameters_si"]
        result=geometry_filter_report(geometry)
        self.assertEqual(result["parameters_si"],{k:geometry[k] for k in (
            "conductor_width_m","gap_m","metal_thickness_m","insulator_thickness_m")})
        self.assertEqual(result["parameters_si"]["metal_thickness_m"],90e-9)
        self.assertFalse(result["fullmag_solver_executed"])
        self.assertFalse(result["publication_reproduced"])
        self.assertFalse(result["explains_previous_thin_model_figure3_discrepancy"])
        result["geometry_evidence_sha256"]=hashlib.sha256(raw).hexdigest()
        print("ANTENNA_METAL_GEOMETRY_DIAGNOSTIC:"+json.dumps(result,sort_keys=True),flush=True)


if __name__=="__main__":
    unittest.main()
