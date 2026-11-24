"""Public model and round-trip checks; not finite-k runtime qualification."""
import math
from pathlib import Path
import unittest

import numpy as np
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.script_builder import export_builder_draft, render_loaded_problem_as_script

ROOT = Path(__file__).resolve().parents[3]


class SushruthFiniteKControlTests(unittest.TestCase):
    def load(self, images):
        path = ROOT / "examples" / f"fdm_sushruth_2020_finite_k_images{images}.py"
        return path, load_problem_from_script(path, lightweight_assets=True)

    def test_explicit_cpu_periodic_demag_and_synthetic_effective_field(self):
        for images in (4, 8):
            _, loaded = self.load(images)
            self.assertEqual(len(loaded.stages), 1)
            stage = loaded.stages[0]
            self.assertEqual(stage.entrypoint_kind, "flat_run")
            self.assertEqual(stage.default_until_seconds, 3e-9)
            ir = stage.problem.to_ir(include_geometry_assets=False)
            self.assertEqual(ir["pbc"], {"axes": ["periodic", "periodic", "open"],
                                        "demag": "truncated_images", "image_counts": [images, images, 0]})
            self.assertEqual(ir["energy_terms"], [{"kind": "demag", "realization": "auto"},
                                                   {"kind": "zeeman", "B": [0., 0., 1.14]}])
            self.assertEqual(ir["backend_policy"]["discretization_hints"]["fdm"]["cell"],
                             [1e-8, 1.28e-6, 2e-8])
            dynamics = ir["study"]["dynamics"]
            self.assertEqual(dynamics["integrator"], "rk4")
            self.assertEqual(dynamics["fixed_timestep"], .5e-12)
            self.assertAlmostEqual(dynamics["gyromagnetic_ratio"], 4e-7*math.pi*math.tau*30e9, delta=1e-9)
            material = stage.problem.magnets[0].material
            self.assertEqual(material.alpha, .01)
            self.assertAlmostEqual(material.Ms*4e-7*math.pi, .89, delta=1e-14)
            draft = export_builder_draft(loaded)
            self.assertEqual((draft["requested_backend"], draft["requested_device"], draft["requested_precision"]),
                             ("fdm", "cpu", "double"))
            self.assertEqual(draft["antenna_field_solve_stages"], [])

    def test_loaded_initial_state_has_one_normalized_spatial_mode(self):
        for images in (4, 8):
            _, loaded = self.load(images)
            initial = loaded.stages[0].problem.to_ir(include_geometry_assets=False)["magnets"][0]["initial_magnetization"]
            self.assertEqual(initial["kind"], "sampled_field")
            values = np.asarray(initial["values"])
            self.assertEqual(values.shape, (128, 3))
            np.testing.assert_allclose(np.linalg.norm(values, axis=1), 1, atol=2e-16, rtol=0)
            self.assertTrue(np.all(values[:, 1] == 0))
            spectrum = np.fft.rfft(values[:, 0])
            self.assertAlmostEqual(2*abs(spectrum[1])/128, 1e-4, delta=1e-18)
            self.assertLess(np.sum(np.abs(np.delete(spectrum, 1))), 1e-16)
            self.assertGreater(np.min(values[:, 2]), .99999999)

    def test_round_trip_preserves_full_ir_and_continuous_field_storage(self):
        def compare(a, b, path=""):
            if isinstance(a, float):
                self.assertTrue(math.isclose(a, b, rel_tol=5e-12, abs_tol=0), path)
            elif isinstance(a, dict):
                self.assertEqual(a.keys(), b.keys(), path)
                for key in a:
                    if key != "problem_meta":
                        compare(a[key], b[key], path+"/"+key)
            elif isinstance(a, list):
                self.assertEqual(len(a), len(b), path)
                for i, (left, right) in enumerate(zip(a, b)):
                    compare(left, right, path+"/"+str(i))
            else:
                self.assertEqual(a, b, path)
        for images in (4, 8):
            path, loaded = self.load(images)
            rendered = render_loaded_problem_as_script(loaded)
            restored = load_problem_from_script(path, source_bytes=rendered.encode(), lightweight_assets=True)
            compare(loaded.stages[0].problem.to_ir(include_geometry_assets=False),
                    restored.stages[0].problem.to_ir(include_geometry_assets=False))
            before, after = loaded.stages[0].autosave, restored.stages[0].autosave
            self.assertEqual(before, after)
            self.assertEqual((after.target, after.layout, after.format), ("state", "continuous", "zarr"))
            self.assertEqual([(s.quantity, s.every) for s in after.fields], [("m", 2e-12), ("H_demag", 2e-12)])


if __name__ == "__main__":
    unittest.main()
