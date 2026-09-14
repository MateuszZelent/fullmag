"""Regression checks for the immutable DE pilot execution route."""
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import json
import run_de_100nm_pilot as pilot


class PilotTests(unittest.TestCase):
    def test_requires_pilot_from_build_capsule(self):
        with TemporaryDirectory() as tmp:
            context = SimpleNamespace(source_tree=Path(tmp), manifest={"files": []})
            with self.assertRaises(pilot.managed.BenchmarkError):
                pilot.validate_model(context)

    def test_rejects_modified_pilot(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / pilot.MODEL
            path.parent.mkdir()
            path.write_bytes(b"changed")
            context = SimpleNamespace(source_tree=root, manifest={"files": [
                {"path": pilot.MODEL, "sha256": hashlib.sha256(b"original").hexdigest()}
            ]})
            with self.assertRaises(pilot.managed.BenchmarkError):
                pilot.validate_model(context)

    def test_successful_execution_remains_scientifically_unqualified(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = SimpleNamespace(layout={"repo_root": str(root)})
            request = {"source": {}, "job": {}, "runtime": {}}
            with patch.object(pilot.managed, "_run_request", return_value=request), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(pilot.managed, "_validate_case_artifacts", return_value={"case": "c1"}), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], "abc"), 0)
            result = json.loads((root / "run-result.json").read_text())
            self.assertEqual(result["status"], "completed_unqualified")
            self.assertEqual(result["qualification"], "NOT VERIFIED")
            self.assertEqual(result["artifacts"]["case"], "de100")

    def test_process_failure_records_terminal_result(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = SimpleNamespace(layout={"repo_root": str(root)})
            request = {"source": {}, "job": {}, "runtime": {}}
            with patch.object(pilot.managed, "_run_request", return_value=request), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=7)), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], "abc"), 1)
            result = json.loads((root / "run-result.json").read_text())
            self.assertEqual(result["return_code"], 7)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["qualification"], "NOT VERIFIED")

    def test_command_selects_numerical_pilot_without_case_override(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"))
        command = pilot.compose_command(context, Path("/outputs"))
        shell = command[-1]
        self.assertIn("/workspace/capsule/" + pilot.MODEL, shell)
        self.assertNotIn("FULLMAG_COMSOL_DISPERSION_CASE", shell)
        self.assertIn("--backend fem --mode strict --precision double", shell)
        self.assertIn(str(Path("/outputs")) + ":/workspace/benchmark-output:rw", command)
        self.assertIn(str(Path("/capsule")) + ":/workspace/capsule:ro", command)
        self.assertNotIn("build", command)


if __name__ == "__main__":
    unittest.main()
