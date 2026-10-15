"""An exit-zero child must not publish stale, incomplete or changed FEM output."""
from contextlib import nullcontext
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fullmag_storage as storage
from _native_fem_test_fixtures import native_fem_manifest

# Allows demonstrating the same regression against a preserved pre-fix source.
if os.environ.get("FEM_STORAGE_REGRESSION_SOURCE"):
    spec = importlib.util.spec_from_file_location("prefixed_storage", os.environ["FEM_STORAGE_REGRESSION_SOURCE"])
    storage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(storage)


class NativeFemTerminalTests(unittest.TestCase):
    def test_exit_zero_rejects_stale_incomplete_wrong_device_or_changed_output(self):
        cases = ("stale_attempt", "not_completed", "missing_backend", "wrong_schema", "wrong_target",
                 "wrong_device", "wrong_requested", "cpu_fallback", "missing_cuda", "changed_binary",
                 "missing_api", "changed_dll", "changed_audit", "changed_config", "missing_provider_receipt", "non_object")
        for damage in cases:
            with self.subTest(damage=damage), tempfile.TemporaryDirectory() as temporary:
                repo = Path(temporary).resolve() / "fullmag"
                repo.mkdir()
                subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
                layout = storage.resolve_layout(repo, profile="windows-native-fem-gpu", environ={})
                result_record = {}
                def fake_build(command, _repo, env, _log, **_kwargs):
                    # Pre-fix storage did not export a correlation token.
                    manifest = native_fem_manifest(layout, env.get("FULLMAG_NATIVE_FEM_ATTEMPT_ID", "a" * 32))
                    if damage == "stale_attempt": manifest["native_fem_attempt_id"] = "b" * 32
                    elif damage == "not_completed": manifest["state"] = "running"
                    elif damage == "missing_backend": manifest.pop("backend")
                    elif damage == "wrong_schema": manifest["schema_version"] = 0
                    elif damage == "wrong_target": manifest["target_triple"] = "x86_64-unknown-linux-gnu"
                    elif damage == "wrong_device": manifest["native_fem"]["device"] = "cpu"
                    elif damage == "wrong_requested": manifest["native_fem"]["requested_device"] = "auto"
                    elif damage == "cpu_fallback": manifest["native_fem"]["strict_gpu"] = False
                    elif damage == "missing_cuda": manifest.pop("cuda")
                    elif damage == "changed_binary": Path(manifest["binary"]).write_bytes(b"replaced executable")
                    elif damage == "missing_api": Path(manifest["api_binary"]).unlink()
                    elif damage == "changed_dll": Path(manifest["native_fem"]["runtime_dll"]).write_bytes(b"replaced DLL")
                    elif damage == "changed_audit": Path(manifest["native_fem"]["dependency_audit_path"]).write_bytes(b"replaced audit")
                    elif damage == "changed_config": Path(manifest["native_fem"]["provider_config"]).write_bytes(b"changed provider config")
                    elif damage == "missing_provider_receipt": Path(manifest["native_fem"]["provider_receipt_path"]).unlink()
                    elif damage == "non_object": manifest = []
                    target = Path(layout["build_root"]) / "windows-fem-runtime/build-manifest.json"
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(json.dumps(manifest), encoding="utf-8")
                    return subprocess.CompletedProcess(command, 0)
                with patch.object(storage, "_is_native_windows", return_value=True), \
                     patch.object(storage, "managed_heavy_lock", return_value=nullcontext()), \
                     patch.object(storage, "build_lock", return_value=nullcontext()), \
                     patch.object(storage, "git", return_value="0" * 40), \
                     patch.object(storage, "_run_logged_command", side_effect=fake_build):
                    code = storage._run_managed_command(
                        layout, ["powershell.exe", "fixture"], native_user_build=True,
                        native_fem_paths=True, fem_device="gpu", fem_requested_device="gpu",
                        execution_mode="windows-fem-build", result_record=result_record,
                        native_manifest_relative="windows-fem-runtime/build-manifest.json", attempt_id="a" * 32,
                    )
                self.assertEqual(code, 1)
                self.assertEqual(result_record["state"], "failed")
                self.assertNotIn("build_manifest_sha256", result_record)


if __name__ == "__main__":
    unittest.main()
