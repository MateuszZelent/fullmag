"""Independent synthetic trajectory checks; no Fullmag engine execution."""
import math
import json
import tempfile
from pathlib import Path
import unittest
import numpy as np
from scipy.linalg import expm

from verify_sushruth_finite_k_control import analyze_trajectory, read_trajectory


class FiniteKAnalysisTests(unittest.TestCase):
    def make_trajectory(self, time_warp=None):
        mu0 = 4e-7*math.pi
        ms = .89/mu0
        nxx, nyy, nzz = .0475, .0002, .999
        effective = 1.14-.89*nzz
        a, b = effective+.89*nxx, effective+.89*nyy
        gamma, alpha = math.tau*30e9, .01
        matrix = gamma/(1+alpha*alpha)*np.array([[-alpha*a, -b], [a, -alpha*b]])
        times = np.arange(1501)*2e-12
        evolution_times = times if time_warp is None else time_warp(times)
        modal = np.array([expm(matrix*t)@np.array([1e-4, 0]) for t in evolution_times])
        x = (np.arange(128)+.5-64)/128
        basis = np.cos(math.tau*x)
        m = np.zeros((len(times),128,3))
        m[:,:,0] = modal[:,0,None]*basis
        m[:,:,1] = modal[:,1,None]*basis
        m[:,:,2] = np.sqrt(1-m[:,:,0]**2-m[:,:,1]**2)
        h = -ms*m*np.array([nxx,nyy,nzz])
        eigenvalues = np.linalg.eigvals(matrix)
        return times,m,h,eigenvalues[0],(nxx,nyy,nzz)

    def test_measures_frequency_damping_and_demag_from_independent_matrix_solution(self):
        t,m,h,eigen,coefficients = self.make_trajectory()
        result = analyze_trajectory(t,m,h)
        self.assertLess(abs(result["frequency_hz"]-abs(eigen.imag)/math.tau)/(abs(eigen.imag)/math.tau), 2e-6)
        self.assertLess(abs(result["decay_per_s"]+eigen.real)/abs(eigen.real), 2e-4)
        for key,expected in zip(["Nxx","Nyy","Nzz_static"],coefficients):
            self.assertAlmostEqual(result["demag"][key], expected, delta=2e-15)
        self.assertTrue(result["checks"]["frequency_matches_measured_operator"])
        self.assertTrue(result["checks"]["decay_matches_measured_operator"])
        self.assertTrue(result["checks"]["positive_precession"])
        self.assertTrue(result["checks"]["single_transverse_mode"])

    def test_uniform_means_cannot_replace_field_trajectory(self):
        t,m,h,_,_ = self.make_trajectory()
        with self.assertRaisesRegex(ValueError,"128"):
            analyze_trajectory(t,np.mean(m,axis=1,keepdims=True),np.mean(h,axis=1,keepdims=True))

    def test_missing_and_misaligned_samples_are_rejected(self):
        t,m,h,_,_ = self.make_trajectory()
        with self.assertRaises(ValueError):
            analyze_trajectory(t,m[:-1],h)
        t[2] = t[1]
        with self.assertRaises(ValueError):
            analyze_trajectory(t,m,h)

    def test_second_spatial_mode_is_detected(self):
        t,m,h,_,_ = self.make_trajectory()
        x = (np.arange(128)+.5-64)/128
        m[:,:,0] += 2e-6*np.cos(2*math.tau*x)
        m[:,:,2] = np.sqrt(1-m[:,:,0]**2-m[:,:,1]**2)
        result=analyze_trajectory(t,m,h)
        self.assertFalse(result["checks"]["single_transverse_mode"])

    def test_higher_spatial_harmonic_is_rejected(self):
        t,m,h,_,coefficients = self.make_trajectory()
        x = (np.arange(128)+.5-64)/128
        m[:,:,0] += 1e-4*np.cos(3*math.tau*x)
        m[:,:,2] = np.sqrt(1-m[:,:,0]**2-m[:,:,1]**2)
        h = -(.89/(4e-7*math.pi))*m*np.array(coefficients)
        result = analyze_trajectory(t,m,h)
        self.assertFalse(result["checks"]["single_transverse_mode"])
        self.assertFalse(result["control_passed"])

    def test_non_diagonal_field_refuses_diagonal_frequency_claim(self):
        t,m,h,_,_ = self.make_trajectory()
        x = (np.arange(128)+.5-64)/128
        h[:,:,0] += 100*np.sin(math.tau*x)
        result = analyze_trajectory(t,m,h)
        self.assertFalse(result["checks"]["diagonal_operator_applicable"])
        self.assertFalse(result["checks"]["frequency_matches_measured_operator"])
        self.assertFalse(result["control_passed"])

    def test_higher_spatial_harmonic_in_field_is_rejected(self):
        t,m,h,_,_ = self.make_trajectory()
        x = (np.arange(128)+.5-64)/128
        h[:,:,0] += 100*np.cos(3*math.tau*x)
        result = analyze_trajectory(t,m,h)
        self.assertFalse(result["checks"]["diagonal_operator_applicable"])
        self.assertFalse(result["control_passed"])

    def test_local_phase_modulation_cannot_hide_behind_correct_average_frequency(self):
        phase = 1.43153288986
        warp = lambda t: t+8e-12*(np.sin(math.tau*t/.4e-9+phase)-math.sin(phase))
        t,m,h,_,_ = self.make_trajectory(warp)
        result = analyze_trajectory(t,m,h)
        self.assertTrue(result["checks"]["frequency_matches_measured_operator"])
        self.assertTrue(result["checks"]["decay_matches_measured_operator"])
        self.assertFalse(result["control_passed"])

    def test_field_index_uses_per_quantity_row_and_missing_chunks_fail(self):
        root_dir = Path(__file__).resolve().parents[1] / "examples/sushruth_2020_closed_gsg/finite_k_control_20261111"
        with tempfile.TemporaryDirectory(dir=root_dir) as temporary:
            store = Path(temporary)
            (store/".zgroup").write_text(json.dumps({"zarr_format":2}))
            stage = store/"stages/stage_test"
            array_dir = stage/"fields/m"
            array_dir.mkdir(parents=True)
            (stage/"manifest.json").write_text(json.dumps({"complete":True,"field_quantities":["m","H_demag"]}))
            (array_dir/".zarray").write_text(json.dumps({"zarr_format":2,"shape":[2,384],
                "chunks":[1,384],"dtype":"<f8","compressor":None,"filters":None,
                "fill_value":0,"order":"C"}))
            index=[]
            for i in range(2):
                (array_dir/f"{i}.0").write_bytes(np.full(384,i+1,dtype="<f8").tobytes())
                index.append({"sample_kind":"field","stage_sample_index":100+i*3,
                    "payload_ref":f"stages/stage_test/fields/m/{i}",
                    "coordinate":{"kind":"physical_time","time_s":i*2e-12}})
            (store/"continuous").mkdir()
            (store/"continuous/index.jsonl").write_text("".join(json.dumps(r)+chr(10) for r in reversed(index)))
            times,values=read_trajectory(store,"m")
            np.testing.assert_array_equal(times,[0,2e-12])
            self.assertEqual(values.shape,(2,128,3))
            self.assertTrue(np.all(values[1]==2))
            (array_dir/"1.0").unlink()
            with self.assertRaisesRegex(ValueError,"missing or truncated"):
                read_trajectory(store,"m")



if __name__ == "__main__":
    unittest.main()
