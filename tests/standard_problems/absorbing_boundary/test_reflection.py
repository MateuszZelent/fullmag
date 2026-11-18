"""Input and analyzer regressions. Solver results are produced by the managed runtime."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import fullmag as fm
import numpy as np

from prepare import case_name, cases, prepare_case
from verify import PERIOD, compare, measure, provenance, snapshots


COMMIT = "d" * 40
SNAPSHOT = "e" * 64


class ReflectionQualificationTests(unittest.TestCase):
    def test_all_inputs_load_through_public_api(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            all_cases = list(cases())
            self.assertEqual(len(all_cases), 32)
            for engine, device, h, profile in all_cases:
                with self.subTest(engine=engine, device=device, h=h, profile=profile):
                    script = prepare_case(root, engine, device, h, profile)
                    loaded = fm.load_problem_from_script(script)
                    self.assertEqual(len(loaded.stages), 1)
                    stage = loaded.stages[0]
                    self.assertEqual(stage.stage_id, "propagate")
                    ir = stage.problem.to_ir()
                    self.assertEqual(ir["problem_meta"]["name"], case_name(engine, device, h, profile))
                    magnet = ir["magnets"][0]
                    absorber = magnet.get("absorbing_boundary")
                    if profile == "off":
                        self.assertIsNone(absorber)
                    else:
                        self.assertEqual(absorber["profile"], profile)
                        self.assertEqual(absorber["faces"], ["x+"])
                        if profile == "custom":
                            self.assertEqual(absorber["expression"], "u**3")
                    state = json.loads(script.with_name("packet.json").read_text())["values"]
                    n = 1280 // h if engine == "fdm" else 4 * (1280 // h + 1)
                    self.assertEqual(np.asarray(state).shape, (n, 3))
                    np.testing.assert_allclose(np.linalg.norm(state, axis=1), 1.)
                    intent = ir["problem_meta"]["runtime_metadata"]["runtime_selection"]
                    self.assertEqual((intent["backend"], intent["device"], intent["execution_mode"],
                                      intent["execution_precision"]), (engine, device, "strict", "double"))

    def test_separates_packets_by_physical_arrival_and_rejects_incomplete_traces(self):
        t = PERIOD * np.arange(513)
        def gaussian(center):
            return np.exp(-0.5 * ((t - center) / 5e-11)**2)
        a = 8e-4 * (gaussian(2.28e-10) + 0.60 * gaussian(1.37e-9))
        result = measure(t, a)
        self.assertAlmostEqual(result["amplitude_ratio"], 0.6, places=3)
        self.assertLess(abs(result["reflected_peak_s"]-1.37e-9), PERIOD)
        for times, values in ((t[:-16], a[:-16]), (np.delete(t, 155), np.delete(a, 155)),
                              (t, np.zeros_like(t))):
            with self.assertRaises(ValueError):
                measure(times, values)

    def test_requires_matched_control_refinement_hardware_and_commit(self):
        results = {case: {"amplitude_ratio": 0.6 if case[-1] == "off" else 0.06,
                          "incident": 8e-4, "reflected_peak_s": 1.37e-9,
                          "commit": COMMIT, "snapshot": SNAPSHOT} for case in cases()}
        compare(results, COMMIT)
        key = ("fdm", "gpu", 2, "custom")
        for bad_value, error in (({"amplitude_ratio": 0.30}, "reflection reduction"),
                                 ({"amplitude_ratio": 0.145}, "mesh sensitivity"),
                                 ({"amplitude_ratio": 0.09}, "CPU/GPU disagreement"),
                                 ({"incident": 7e-4}, "unmatched"), ({"commit": "0"*40}, "commit"),
                                 ({"snapshot": "0"*64}, "snapshot")):
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                compare({**results, key: {**results[key], **bad_value}}, COMMIT)
        results.pop(key)
        with self.assertRaisesRegex(ValueError, "incomplete"):
            compare(results, COMMIT)

    def test_requires_actual_device_operators_and_exact_execution(self):
        request = {"backend": "fdm", "device": "gpu", "precision": "double",
                   "mode": "strict", "fallback_policy": "forbidden"}
        gpu = {"executed": "cuda_fdm", "fallback_count": 0, "required_operator_mask": 7,
               "executed_device_operator_mask": 7, "executed_host_operator_mask": 0,
               "executed_unknown_operator_mask": 0, "validation_state": "validated"}
        execution = {"execution_engine": "cuda_fdm", "precision": "double",
                     "lossy_fallback_used": False, "execution_resolution": {"fallback_occurred": False},
                     "fdm_gpu_execution_receipt": gpu}
        metadata = {"requested_execution": request, "execution_provenance": execution, "status": "completed",
                    "build_identity": {"git_commit": COMMIT, "source_snapshot_sha256": SNAPSHOT},
                    "source_hash": "input"}
        self.assertEqual(provenance(metadata, "fdm", "gpu")["engine"], "cuda_fdm")
        for change in ({"executed_host_operator_mask": 2}, {"executed_device_operator_mask": 3},
                       {"fallback_count": 1}, {"validation_state": "pending"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                provenance({**metadata, "execution_provenance": {**execution,
                           "fdm_gpu_execution_receipt": {**gpu, **change}}}, "fdm", "gpu")

    def test_native_and_json_field_readers_use_the_same_vector_order(self):
        vectors = np.array([[1., 2., 3.], [4., 5., 6.]])
        with TemporaryDirectory() as directory:
            stage = Path(directory)
            fields = stage / "fields"
            cpu = fields / "m"
            cpu.mkdir(parents=True)
            record = {"observable": "m", "component_count": 3, "provenance": {"source_hash": "input"},
                      "time": 0.5, "values": vectors.ravel().tolist()}
            (cpu / "step_000001.json").write_text(json.dumps(record))
            metadata = {"source_hash": "input"}
            t, sampled = next(snapshots(stage, metadata, 2))
            np.testing.assert_array_equal(sampled, vectors)
            self.assertEqual(t, 0.5)
            native = fields / "m.zarr"
            native.mkdir()
            (native / ".zarray").write_text(json.dumps({"shape": [1, 3, 2], "chunks": [1, 3, 2],
                "dtype": "<f8", "compressor": None, "order": "C"}))
            (native / ".zattrs").write_text(json.dumps({"storage_layout": "soa_component_major",
                "observable": "m", "component_order": ["x", "y", "z"], "provenance": {"source_hash": "input"}}))
            (native / "samples.csv").write_text("sample,time,chunk_key\n0,0.5,0.0.0\n")
            vectors.T.astype("<f8").tofile(native / "0.0.0")
            t, sampled = next(snapshots(stage, metadata, 2))
            np.testing.assert_array_equal(sampled, vectors)
            self.assertEqual(t, 0.5)
            with self.assertRaisesRegex(ValueError, "foreign"):
                list(snapshots(stage, {"source_hash": "other"}, 2))
