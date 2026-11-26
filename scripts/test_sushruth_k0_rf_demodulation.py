"""Independent steady-state fixtures for the RF measurement check only."""
import math
import unittest
import numpy as np


def steady_fixture(conjugate=False,scale=1.):
    terms=[]
    for f in (6e9,7.5e9,9e9):
        matrix=np.array([[30e9*.25+1j*.01*f,-1j*f],[1j*f,30e9*.25+1j*.01*f]])
        chi=np.linalg.solve(matrix,np.array([30e9*.89,0.]))
        terms.append((f,chi.conjugate() if conjugate else chi))
    ms=.89/(4e-7*math.pi)
    return [{'time_s':t,'m':[scale*.1/ms*sum((chi[a]*np.exp(1j*math.tau*f*t)).real for f,chi in terms) for a in (0,1)]+[1.]}
            for t in (20e-9+n*2e-12 for n in range(2001))]


class SushruthK0RfDemodulationTests(unittest.TestCase):
    def test_independent_three_tone_fixture_recovers_both_complex_components(self):
        from verify_sushruth_k0_rf_response import verify_rf_response
        r=verify_rf_response(steady_fixture())
        self.assertTrue(r['passed'])
        self.assertEqual(r['window_sample_count'],2000)
        self.assertEqual(len(r['comparisons']),6)
        self.assertLess(max(x['absolute_error'] for x in r['comparisons']),1e-9)

    def test_wrong_phase_and_wrong_field_units_fail(self):
        from verify_sushruth_k0_rf_response import verify_rf_response
        self.assertFalse(verify_rf_response(steady_fixture(conjugate=True))['passed'])
        self.assertFalse(verify_rf_response(steady_fixture(scale=4e-7*math.pi))['passed'])

    def test_missing_sample_nonfinite_and_wrong_time_unit_refuse(self):
        from verify_sushruth_k0_rf_response import verify_rf_response
        data=steady_fixture()
        for bad in (data[:500]+data[501:],
                    [{'time_s':r['time_s']*1e9,'m':r['m']} for r in data],
                    data[:10]+[{'time_s':data[10]['time_s'],'m':[float('nan'),0.,1.]}]+data[11:]):
            with self.assertRaises(ValueError):verify_rf_response(bad)


if __name__=='__main__':unittest.main()
