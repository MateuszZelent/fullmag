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
                 patch.object(pilot.managed, "_cleanup_benchmark_container", return_value={"status": "absent"}), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], "abc"), 1)
            result = json.loads((root / "run-result.json").read_text())
            self.assertEqual(result["return_code"], 7)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["qualification"], "NOT VERIFIED")

    def test_timeout_and_interrupt_cleanup_and_record_failure(self):
        for failure in (pilot.subprocess.TimeoutExpired("docker", 3), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__), TemporaryDirectory() as tmp:
                root = Path(tmp)
                context = SimpleNamespace(layout={"repo_root": str(root)})
                request = {"source": {}, "job": {}, "runtime": {}}
                with patch.object(pilot.managed, "_run_request", return_value=request), \
                     patch.object(pilot.managed, "_compose_environment", return_value={}), \
                     patch.object(pilot.subprocess, "run", side_effect=failure) as run, \
                     patch.object(pilot.managed, "_cleanup_benchmark_container", return_value={"status": "stopped"}) as cleanup, \
                     patch("builtins.print"):
                    self.assertEqual(pilot.execute(context, root, ["docker"], "abc", timeout_seconds=3), 1)
                cleanup.assert_called_once_with(context, root)
                self.assertEqual(run.call_args.kwargs["timeout"], 3 + pilot.managed.CONTAINER_TIMEOUT_GRACE_SECONDS + pilot.managed.HOST_COMPOSE_GRACE_SECONDS)
                result = json.loads((root / "run-result.json").read_text())
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["container_cleanup"]["status"], "stopped")
                self.assertIn("error", result)

    def test_smoke_sampling_is_explicit_and_capsule_bound(self):
        for name, sampling in (("de-smoke-two", "two"), ("de-smoke-five", "five")):
            with self.subTest(pilot=name), TemporaryDirectory() as tmp:
                root = Path(tmp)
                model = pilot.pilot_model(name)
                path = root / model
                path.parent.mkdir()
                path.write_bytes(b"frozen model")
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                context = SimpleNamespace(source_tree=root, runtime_root=Path("/runtime"),
                    job={"job_id": "b" * 32}, manifest={"files": [{"path": model, "sha256": digest}]})
                self.assertEqual(pilot.validate_model(context, name), digest)
                command = pilot.compose_command(context, Path("/outputs"), pilot=name)
                self.assertIn("export FULLMAG_DE_SMOKE_SAMPLING=" + sampling, command[-1])
                self.assertIn("case_dir=/workspace/benchmark-output/" + name, command[-1])
                self.assertIn("source_script=/workspace/capsule/" + model, command[-1])
                path.write_bytes(b"mutated")
                with self.assertRaises(pilot.managed.BenchmarkError):
                    pilot.validate_model(context, name)

    def test_unknown_pilot_cannot_inject_shell_or_path(self):
        with self.assertRaises(pilot.managed.BenchmarkError):
            pilot.compose_command(None, Path("/outputs"), pilot="../other; echo bad")

    def test_smoke_receipt_and_artifacts_remain_separate(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = SimpleNamespace(layout={"repo_root": str(root)})
            with patch.object(pilot.managed, "_run_request", return_value={"source": {}, "job": {}, "runtime": {}}), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(pilot.managed, "_validate_case_artifacts", return_value={}) as validate, \
                 patch.object(pilot, "validate_rows", return_value={"qualification": "NOT VERIFIED"}) as row_check, \
                 patch.object(pilot, "validate_smoke_potential_fields", return_value={"qualification": "NOT VERIFIED"}) as field_check, \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], "abc", pilot="de-smoke-two"), 0)
            validate.assert_called_once_with(root / "de-smoke-two", "c1")
            row_check.assert_called_once_with(root / "de-smoke-two/eigen/dispersion.csv", "two")
            field_check.assert_called_once_with(root / "de-smoke-two")
            request = json.loads((root / "run-request.json").read_text())
            result = json.loads((root / "run-result.json").read_text())
            self.assertEqual(request["schema"], "fullmag.de-smoke.request.v1")
            self.assertEqual(request["sampling"], "two")
            self.assertEqual(request["public_model"], pilot.pilot_model("de-smoke-two"))
            self.assertEqual(result["qualification"], "NOT VERIFIED")
            self.assertEqual(result["artifacts"]["case"], "de-smoke-two")

    def test_smoke_invalid_rows_cannot_be_completed(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = SimpleNamespace(layout={"repo_root": str(root)})
            with patch.object(pilot.managed, "_run_request", return_value={"source": {}, "job": {}, "runtime": {}}), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(pilot.managed, "_validate_case_artifacts", return_value={}), \
                 patch.object(pilot, "validate_rows", side_effect=ValueError("missing DE-SMOKE samples")), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], "abc", pilot="de-smoke-two"), 1)
            result = json.loads((root / "run-result.json").read_text())
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["return_code"], 0)
            self.assertIn("missing DE-SMOKE samples", result["error"])

    def test_potential_reconstruction_requires_every_published_mode(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "metadata.json").write_text("{}")
            for index in range(2):
                mode = root / f"eigen/mode_fields/sample_{index:04}/mode_0000"
                mode.mkdir(parents=True)
                (mode / "vector.bin").write_bytes(b"mode")
                (mode / "physical_potential.v1.json").write_text("{}")
            with patch.object(pilot, "validate_physical_potential", return_value={
                "status": "consistent", "reconstruction_agreement": True,
                "qualification": "NOT VERIFIED"}) as validate:
                result = pilot.validate_smoke_potential_fields(root)
            self.assertEqual(validate.call_count, 2)
            self.assertEqual(result["mode_count"], 2)
            self.assertEqual(result["qualification"], "NOT VERIFIED")
            (mode / "physical_potential.v1.json").unlink()
            with patch.object(pilot, "validate_physical_potential", return_value={
                "status": "consistent", "reconstruction_agreement": True}):
                with self.assertRaises(pilot.managed.BenchmarkError):
                    pilot.validate_smoke_potential_fields(root)

    def test_smoke_inconsistent_field_cannot_be_completed_after_exit_zero(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = SimpleNamespace(layout={"repo_root": str(root)})
            with patch.object(pilot.managed, "_run_request", return_value={"source": {}, "job": {}, "runtime": {}}), \
                 patch.object(pilot.managed, "_compose_environment", return_value={}), \
                 patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(pilot.managed, "_validate_case_artifacts", return_value={}), \
                 patch.object(pilot, "validate_rows", return_value={}), \
                 patch.object(pilot, "validate_smoke_potential_fields", side_effect=ValueError("gradient mismatch")), \
                 patch("builtins.print"):
                self.assertEqual(pilot.execute(context, root, ["docker"], "abc", pilot="de-smoke-two"), 1)
            result = json.loads((root / "run-result.json").read_text())
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["return_code"], 0)
            self.assertIn("gradient mismatch", result["error"])

    def test_command_selects_numerical_pilot_without_case_override(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"), job={"job_id": "a" * 32})
        command = pilot.compose_command(context, Path("/outputs"))
        shell = command[-1]
        self.assertIn("/workspace/capsule/" + pilot.MODEL, shell)
        self.assertNotIn("FULLMAG_COMSOL_DISPERSION_CASE", shell)
        self.assertIn("--backend fem --mode strict --precision double", shell)
        self.assertIn(str(Path("/outputs")) + ":/workspace/benchmark-output:rw", command)
        self.assertIn(str(Path("/capsule")) + ":/workspace/capsule:ro", command)
        self.assertNotIn("build", command)


    def test_nearest_smoke_pilot_is_explicitly_separate_from_window_pilot(self):
        context = SimpleNamespace(source_tree=Path("/capsule"), runtime_root=Path("/runtime"),
                                  job={"job_id": "a" * 32})
        nearest = pilot.compose_command(context, Path("/outputs"), pilot="de-smoke-nearest-two", external_model=True)[-1]
        window = pilot.compose_command(context, Path("/outputs"), pilot="de-smoke-two", external_model=True)[-1]
        self.assertIn("export FULLMAG_DE_SMOKE_SAMPLING=two", nearest)
        self.assertIn("export FULLMAG_DE_SMOKE_TARGET=nearest", nearest)
        self.assertNotIn("FULLMAG_DE_SMOKE_TARGET=nearest", window)


if __name__ == "__main__":
    unittest.main()
