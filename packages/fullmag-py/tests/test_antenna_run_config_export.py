"""Runtime wire contracts only; this fixture is not a native current solve."""
from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import fullmag as fm
from fullmag.runtime.helper import main


SCRIPT = '''import fullmag as fm
study = fm.study("antenna_run_config_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
probe = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="probe")
probe.Ms = 800e3
probe.Aex = 13e-12
probe.alpha = 0.02
probe.m = fm.texture.uniform(1, 0, 0)
study.stages.add_run(1e-12, stage_id="earlier")
for identifier in ("first", "second"):
    study.stages.add_antenna_field_solve(id=identifier, definition=fm.AntennaFieldSolveStage(
        id=identifier, source_object_id="antenna", current_transport_id="transport",
        port_mode_ids=("port",), conservative_current_view_ref="transport:rt0",
        field_sampling_domain=fm.FieldTarget.object("probe"),
        target_refs=(fm.FieldTarget.object("probe"),),
        outputs=(fm.AntennaNamedOutput("basis", "H_ant_basis"),),
    ))
'''


class AntennaRunConfigExportTests(unittest.TestCase):
    def tearDown(self):
        fm.reset()

    def test_runtime_export_materializes_only_the_current_definition(self):
        with TemporaryDirectory() as directory:
            script = Path(directory) / "contract.py"
            script.write_text(SCRIPT, encoding="utf-8")
            output = StringIO()
            with redirect_stdout(output):
                self.assertEqual(main([
                    "export-run-config", "--script", str(script), "--skip-geometry-assets",
                ]), 0)
            config = json.loads(output.getvalue())
        self.assertEqual(len(config["stages"]), 3)
        for stage, identifiers in zip(config["stages"], ([], ["first"], ["first", "second"]), strict=True):
            self.assertEqual([item["id"] for item in stage["ir"]["antenna_field_solve_stages"]], identifiers)
        self.assertIsNone(config["stages"][0]["action"])
        for stage, identifier in zip(config["stages"][1:], ("first", "second"), strict=True):
            self.assertEqual(stage["action"], {
                "kind": "antenna_field_solve", "stage_id": identifier, "port_mode_ids": ["port"],
            })
        self.assertEqual([item["id"] for item in config["ir"]["antenna_field_solve_stages"]], ["first", "second"])


if __name__ == "__main__":
    unittest.main()
