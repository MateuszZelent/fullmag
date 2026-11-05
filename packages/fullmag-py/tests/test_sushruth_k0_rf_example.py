"""Public RF control authoring; not a qualified antenna or native-run proof."""
import math
from pathlib import Path
import unittest

from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.script_builder import export_builder_draft, render_loaded_problem_as_script

EXAMPLE=Path(__file__).resolve().parents[3]/"examples"/"fdm_sushruth_2020_k0_rf_response.py"


class SushruthK0RfExampleTests(unittest.TestCase):
    def test_three_known_cosine_drives_and_no_solved_antenna(self):
        loaded=load_problem_from_script(EXAMPLE,lightweight_assets=True)
        draft=export_builder_draft(loaded)
        drives=draft["field_drives"]
        self.assertEqual(len(drives),3)
        self.assertEqual({d["waveform"]["frequency_hz"] for d in drives},{6e9,7.5e9,9e9})
        for d in drives:
            self.assertAlmostEqual(d["amplitude_B_T"],4e-7*math.pi*.1,delta=1e-20)
            self.assertEqual(d["direction"],[1.,0.,0.])
            self.assertEqual(d["spatial_profile"],{"kind":"uniform"})
            self.assertEqual(d["waveform"]["kind"],"sinusoidal")
            self.assertAlmostEqual(d["waveform"]["phase_rad"],math.pi/2,delta=1e-14)
            self.assertEqual(d["time_origin"],"stage_local")
            self.assertEqual(d["activation"],{"kind":"stage_ids","stage_ids":["k0_rf_response"]})
        self.assertEqual(draft["solved_antenna_drives"],[])
        self.assertEqual(draft["current_modules"],[])

    def test_explicit_stage_time_sampler_and_gamma(self):
        loaded=load_problem_from_script(EXAMPLE,lightweight_assets=True)
        self.assertEqual(len(loaded.stages),1)
        stage=loaded.stages[0]
        self.assertEqual(stage.entrypoint_kind,"flat_run")
        self.assertEqual(stage.default_until_seconds,24e-9)
        ir=stage.problem.to_ir(include_geometry_assets=False)
        dynamics=ir["study"]["dynamics"]
        self.assertEqual(dynamics["fixed_timestep"],1e-12)
        self.assertEqual(dynamics["integrator"],"rk4")
        self.assertAlmostEqual(dynamics["gyromagnetic_ratio"],4e-7*math.pi*math.tau*30e9,delta=1e-9)
        table=ir["study"]["sampling"]["table_autosave"]
        self.assertEqual(table["sample_period_s"],2e-12)
        self.assertTrue({"t","mx","my","mz"}<=set(table["quantities"]))

    def test_round_trip_preserves_drive_identity_units_phase_and_activation(self):
        loaded=load_problem_from_script(EXAMPLE,lightweight_assets=True)
        restored=load_problem_from_script(EXAMPLE,source_bytes=render_loaded_problem_as_script(loaded).encode(),lightweight_assets=True)
        original=export_builder_draft(loaded);result=export_builder_draft(restored)
        self.assertEqual(len(original["field_drives"]),len(result["field_drives"]))
        for a,b in zip(original["field_drives"],result["field_drives"]):
            for key in ("id","target","direction","spatial_profile","time_origin","activation","enabled"):
                self.assertEqual(a[key],b[key],key)
            self.assertTrue(math.isclose(a["amplitude_B_T"],b["amplitude_B_T"],rel_tol=5e-12))
            self.assertEqual(a["waveform"]["frequency_hz"],b["waveform"]["frequency_hz"])
            self.assertTrue(math.isclose(a["waveform"]["phase_rad"],b["waveform"]["phase_rad"],rel_tol=5e-12))


if __name__=="__main__":unittest.main()
