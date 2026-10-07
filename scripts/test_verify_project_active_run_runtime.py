"""Interpreted regressions for the frozen native active-run route."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

import verify_project_active_run_runtime as probe


def _source_identity(*, source_sha: str = "b" * 64) -> dict[str, object]:
    return {
        "schema": "fullmag.source-snapshot.v2",
        "head_commit_full": "a" * 40,
        "source_snapshot_dirty": False,
        "source_snapshot_sha256": source_sha,
        "git_status_porcelain_v1": "",
    }


class FrozenPackagePreflightTests(unittest.TestCase):
    def make_native_layout(self, root: Path) -> tuple[dict[str, str], Path, Path, Path]:
        storage_root = root / "storage"
        build_root = storage_root / "native-build"
        runtime_root = storage_root / "native-runtime"
        manifest_path = build_root / "windows-runtime" / "build-manifest.json"
        manifest_path.parent.mkdir(parents=True)
        runtime_root.mkdir(parents=True)
        return (
            {
                "storage_root": str(storage_root),
                "build_root": str(build_root),
                "runtime_root": str(runtime_root),
            },
            storage_root,
            build_root,
            manifest_path,
        )

    def test_mismatched_manifest_is_rejected_before_python_or_storage_side_effects(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            layout, _storage_root, _build_root, manifest_path = self.make_native_layout(root)
            manifest_path.write_text("{}\n", encoding="utf-8")
            before = sorted(path.relative_to(root).as_posix() for path in root.rglob("*"))
            with (
                mock.patch.object(probe.storage, "resolve_layout", return_value=layout),
                mock.patch.object(probe.subprocess, "Popen", side_effect=AssertionError("must not start Python")) as popen,
                mock.patch.object(probe.storage, "initialize", side_effect=AssertionError("must not initialize storage")) as initialize,
            ):
                with self.assertRaisesRegex(probe.ActiveRunRuntimeError, "does not match"):
                    probe.verify_frozen_native_package(root, "0" * 64)
            popen.assert_not_called()
            initialize.assert_not_called()
            after = sorted(path.relative_to(root).as_posix() for path in root.rglob("*"))
            self.assertEqual(before, after)

    def test_frozen_python_import_uses_the_snapshot_and_records_waited_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            layout, _storage_root, build_root, manifest_path = self.make_native_layout(root)
            runtime_root = Path(layout["runtime_root"])
            source_root = build_root / "source-snapshots" / ("c" * 64) / "source"
            python_source = source_root / "packages" / "fullmag-py" / "src"
            package_dir = python_source / "fullmag"
            package_dir.mkdir(parents=True)
            (package_dir / "__init__.py").write_text("\"\"\"frozen fixture\"\"\"\n", encoding="utf-8")
            python_executable = build_root / "python" / "fullmag" / "Scripts" / "python.exe"
            python_executable.parent.mkdir(parents=True)
            python_executable.write_bytes(b"managed python fixture")
            source_identity = _source_identity()
            build_id = "d" * 64
            backend_source = "e" * 64
            package_version = "0.1.0.dev-test"
            dependency_source = "f" * 64
            workspace_namespace = "test-worktree"
            snapshot_record = {
                "record_path": str(build_root / "source-snapshots" / ("c" * 64) / "record.json"),
                "inventory_sha256": "c" * 64,
                "source_root": str(source_root),
            }
            manifest = {
                "git_commit": source_identity["head_commit_full"],
                "worktree_state": "clean",
                "source_snapshot_sha256": source_identity["source_snapshot_sha256"],
                "backend_source_sha256": backend_source,
                "dependency_source_sha256": dependency_source,
                "workspace_namespace": workspace_namespace,
                "target_triple": "x86_64-pc-windows-msvc",
                "build_source_snapshot": snapshot_record,
                "installed_python_version": package_version,
                "python_sync_required": False,
                "build_version": {"pep440_version": package_version},
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            build_id = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
            verified_identity = {"ready_build_id": build_id, "ready_source_sha256": backend_source}
            snapshot = {
                "source_root": str(source_root),
                "inventory_sha256": snapshot_record["inventory_sha256"],
                "origin_worktree_id": workspace_namespace,
                "source_identity": source_identity,
                "backend_source_sha256": backend_source,
                "dependency_source_sha256": dependency_source,
            }
            expected_binding = {
                "executable": str(python_executable.resolve()),
                "implementation": "cpython",
                "version": [3, 12],
                "cache_tag": "cpython-312",
                "soabi": "cp312-win_amd64",
                "ext_suffix": ".cp312-win_amd64.pyd",
                "extension_suffixes": [".cp312-win_amd64.pyd", ".pyd"],
                "platform": "win-amd64",
                "machine": "AMD64",
                "fullmag_file": str((package_dir / "__init__.py").resolve()),
                "fullmag_version": package_version,
            }
            launched = []

            class CompletedProbe:
                pid = 5321
                returncode = 0

                def communicate(self, timeout=None):
                    return json.dumps(expected_binding), ""

                def poll(self):
                    return self.returncode

            def start_process(args, **kwargs):
                launched.append((args, kwargs))
                return CompletedProbe()

            def verify_snapshot(record_path, actual_build_root, *, force_verify=False):
                if isinstance(record_path, dict):
                    raise TypeError("verify_snapshot expects the record path, not the compact manifest binding")
                self.assertEqual(record_path, snapshot_record["record_path"])
                self.assertEqual(actual_build_root, build_root)
                self.assertIs(force_verify, True)
                return snapshot

            with (
                mock.patch.object(probe.storage, "resolve_layout", return_value=layout),
                mock.patch.object(probe, "verified_build_identity", return_value=verified_identity) as verify_identity,
                mock.patch.object(probe.build_snapshot, "verify_snapshot", side_effect=verify_snapshot) as verify_snapshot_mock,
                mock.patch.object(probe.subprocess, "Popen", side_effect=start_process),
            ):
                package = probe.verify_frozen_native_package(root, build_id)
                self.assertIsNone(package["python_binding"])
                self.assertEqual(launched, [])
                receipt: dict[str, object] = {"processes": [], "frozen_python_binding": {}}
                binding = probe.measure_frozen_python_binding(package, receipt)

            verify_identity.assert_called_once_with(
                build_root,
                runtime_root,
                manifest_path,
                expected_source_sha256=None,
                expected_manifest_sha256=build_id,
            )
            verify_snapshot_mock.assert_called_once_with(
                snapshot_record["record_path"], build_root, force_verify=True
            )
            self.assertEqual(binding, expected_binding)
            self.assertEqual(launched[0][0][0], str(python_executable))
            self.assertEqual(launched[0][1]["env"]["PYTHONPATH"], str(python_source))
            self.assertNotIn(str(root / "packages" / "fullmag-py" / "src"), launched[0][1]["env"]["PYTHONPATH"])
            self.assertEqual(receipt["processes"][0]["pid"], 5321)
            self.assertIs(receipt["processes"][0]["waited"], True)
            self.assertEqual(receipt["processes"][0]["exit_code"], 0)

    def test_missing_soabi_requires_the_exact_windows_suffix_and_loader(self):
        cases = {
            "matching_suffix_and_loader": (None, True, None),
            "wrong_ext_suffix": (".cp311-win_amd64.pyd", True, "ext_suffix"),
            "missing_loader_suffix": (None, False, "extension_suffixes"),
        }
        for index, (case, (ext_suffix, include_loader, expected_error)) in enumerate(cases.items()):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                python_executable = root / "python.exe"
                python_executable.write_bytes(b"managed python")
                package_source = root / "snapshot" / "packages" / "fullmag-py" / "src"
                package_dir = package_source / "fullmag"
                package_dir.mkdir(parents=True)
                suffixes = [".cp312-win_amd64.pyd", ".pyd"]
                if not include_loader:
                    suffixes.remove(".cp312-win_amd64.pyd")
                observed = {
                    "executable": str(python_executable.resolve()),
                    "implementation": "cpython",
                    "version": [3, 12],
                    "cache_tag": "cpython-312",
                    "soabi": None,
                    "ext_suffix": ext_suffix or ".cp312-win_amd64.pyd",
                    "extension_suffixes": suffixes,
                    "platform": "win-amd64",
                    "machine": "AMD64",
                    "fullmag_file": str((package_dir / "__init__.py").resolve()),
                    "fullmag_version": "0.1.0.dev-test",
                }

                class CompletedProbe:
                    pid = 7800 + index
                    returncode = 0

                    def communicate(self, timeout=None):
                        return json.dumps(observed), ""

                    def poll(self):
                        return self.returncode

                package = {
                    "python_executable": python_executable,
                    "python_sha256": hashlib.sha256(python_executable.read_bytes()).hexdigest(),
                    "frozen_python_source": package_source,
                    "source_root": root / "snapshot",
                    "expected_python_abi": ("cp312-win_amd64", "win-amd64", "AMD64"),
                    "expected_python_version": "0.1.0.dev-test",
                    "build_python_package_version": "0.1.0.dev-test",
                    "python_sync_required": False,
                }
                receipt: dict[str, object] = {"processes": [], "frozen_python_binding": {}}
                with mock.patch.object(probe.subprocess, "Popen", return_value=CompletedProbe()):
                    if expected_error is None:
                        binding = probe.measure_frozen_python_binding(package, receipt)
                        self.assertIsNone(binding["soabi"])
                        self.assertEqual(receipt["frozen_python_binding"]["binding_mismatch_fields"], [])
                    else:
                        with self.assertRaisesRegex(probe.ActiveRunRuntimeError, expected_error):
                            probe.measure_frozen_python_binding(package, receipt)
                        self.assertEqual(receipt["frozen_python_binding"]["binding_probe"], observed)
                        self.assertEqual(
                            receipt["frozen_python_binding"]["binding_mismatch_fields"],
                            [expected_error],
                        )

    def test_timeout_cleans_and_records_the_exact_python_probe_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package, receipt, process, start = self.make_probe_cleanup_fixture(root, "timeout")
            with mock.patch.object(probe.subprocess, "Popen", side_effect=start):
                with self.assertRaisesRegex(probe.ActiveRunRuntimeError, "timed out"):
                    probe.measure_frozen_python_binding(package, receipt)
            self.assert_recorded_probe(receipt, process, 7)

    def test_keyboard_interrupt_cleans_child_records_it_and_reraises(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package, receipt, process, start = self.make_probe_cleanup_fixture(root, "interrupt")
            with mock.patch.object(probe.subprocess, "Popen", side_effect=start):
                with self.assertRaises(KeyboardInterrupt):
                    probe.measure_frozen_python_binding(package, receipt)
            self.assert_recorded_probe(receipt, process, 0)

    def make_probe_cleanup_fixture(self, root: Path, failure: str):
        python_executable = root / "python.exe"
        python_executable.write_bytes(b"managed python")
        source_root = root / "snapshot"
        package_source = source_root / "packages" / "fullmag-py" / "src"
        package_source.mkdir(parents=True)
        process = None

        class InterruptedProbe:
            pid = 7441 if failure == "timeout" else 7552
            returncode = None

            def poll(self):
                return self.returncode

            def terminate(self):
                self.returncode = 7 if failure == "timeout" else 0

            def kill(self):
                self.returncode = -9

            def wait(self, timeout=None):
                return self.returncode

            def communicate(self, timeout=None):
                if timeout == 20:
                    if failure == "timeout":
                        raise probe.subprocess.TimeoutExpired("python", 20)
                    raise KeyboardInterrupt()
                return "", ""

        def start(*_args, **_kwargs):
            nonlocal process
            process = InterruptedProbe()
            return process

        package = {
            "python_executable": python_executable,
            "python_sha256": hashlib.sha256(python_executable.read_bytes()).hexdigest(),
            "frozen_python_source": package_source,
            "source_root": source_root,
            "expected_python_abi": ("cp312-win_amd64", "win-amd64", "AMD64"),
            "expected_python_version": "0.1.0.dev-test",
            "build_python_package_version": "0.1.0.dev-test",
            "python_sync_required": False,
        }
        receipt: dict[str, object] = {"processes": [], "frozen_python_binding": {}}
        return package, receipt, lambda: process, start

    def assert_recorded_probe(self, receipt, get_process, exit_code):
        process = get_process()
        self.assertIsNotNone(process)
        self.assertEqual(receipt["processes"][0]["pid"], process.pid)
        self.assertIs(receipt["processes"][0]["waited"], True)
        self.assertEqual(receipt["processes"][0]["exit_code"], exit_code)
        self.assertIs(receipt["processes"][0]["output_drained"], True)
        self.assertEqual(receipt["frozen_python_binding"]["binding_probe_process"]["pid"], process.pid)

    def test_python_binding_mismatch_receipt_keeps_observed_fields(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            python_executable = root / "python.exe"
            python_executable.write_bytes(b"managed python")
            package_source = root / "snapshot" / "packages" / "fullmag-py" / "src"
            package_dir = package_source / "fullmag"
            package_dir.mkdir(parents=True)
            observed = {
                "executable": str(python_executable.resolve()),
                "implementation": "cpython",
                "version": [3, 12],
                "cache_tag": "cpython-312",
                "soabi": "cp311-win_amd64",
                "ext_suffix": ".cp312-win_amd64.pyd",
                "extension_suffixes": [".cp312-win_amd64.pyd", ".pyd"],
                "platform": "win-amd64",
                "machine": "AMD64",
                "fullmag_file": str((package_dir / "__init__.py").resolve()),
                "fullmag_version": "0.1.0.dev-test",
            }

            class CompletedProbe:
                pid = 7663
                returncode = 0

                def communicate(self, timeout=None):
                    return json.dumps(observed), ""

                def poll(self):
                    return self.returncode

            package = {
                "python_executable": python_executable,
                "python_sha256": hashlib.sha256(python_executable.read_bytes()).hexdigest(),
                "frozen_python_source": package_source,
                "source_root": root / "snapshot",
                "expected_python_abi": ("cp312-win_amd64", "win-amd64", "AMD64"),
                "expected_python_version": "0.1.0.dev-test",
                "build_python_package_version": "0.1.0.dev-test",
                "python_sync_required": False,
            }
            receipt: dict[str, object] = {"processes": [], "frozen_python_binding": {}}
            with mock.patch.object(probe.subprocess, "Popen", return_value=CompletedProbe()):
                with self.assertRaisesRegex(probe.ActiveRunRuntimeError, "soabi"):
                    probe.measure_frozen_python_binding(package, receipt)
            self.assertEqual(receipt["frozen_python_binding"]["binding_probe"], observed)
            self.assertEqual(receipt["frozen_python_binding"]["binding_mismatch_fields"], ["soabi"])
            self.assertEqual(receipt["processes"][0]["pid"], 7663)
            self.assertIs(receipt["processes"][0]["waited"], True)
            self.assertEqual(receipt["processes"][0]["exit_code"], 0)


@unittest.skipUnless(os.name == "nt", "active-run managed route is Windows-only")
class FrozenRunnerRoutingTests(unittest.TestCase):
    def test_frozen_route_skips_cargo_and_keeps_checkout_identity_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_root = root / "managed-run"
            paths = {
                "run_root": run_root,
                "temp_root": root / "temp",
                "state_root": run_root / "state",
                "target_dir": run_root / "cargo-target",
                "cargo_home": root / "cargo-home",
                "rustup_home": root / "rustup-home",
                "receipt": run_root / "receipt.json",
                "cargo_log": run_root / "cargo.log",
                "api_log": run_root / "api.log",
                "cli_log": run_root / "cli.log",
                "probe_log": run_root / "probe.log",
                "fixture": run_root / "active-run.py",
                "source_snapshot": run_root / "source-before.json",
                "source_snapshot_after": run_root / "source-after.json",
            }
            for key in ("api_log", "cli_log", "probe_log", "fixture"):
                paths[key].parent.mkdir(parents=True, exist_ok=True)
            python_executable = root / "managed-python.exe"
            python_executable.write_bytes(b"python")
            api_binary = root / "bundle-api.exe"
            cli_binary = root / "bundle-cli.exe"
            api_binary.write_bytes(b"api")
            cli_binary.write_bytes(b"cli")
            bundle_root = root / "bundle"
            bundle_root.mkdir()
            bundle_manifest = bundle_root / "manifest.json"
            bundle_manifest.write_text("{}", encoding="utf-8")
            package_source = root / "frozen-source" / "packages" / "fullmag-py" / "src"
            package_source.mkdir(parents=True)
            source_before = _source_identity(source_sha="1" * 64)
            source_after = _source_identity(source_sha="2" * 64)
            frozen_identity = _source_identity(source_sha="3" * 64)
            package_manifest = {
                "git_commit": frozen_identity["head_commit_full"],
                "worktree_state": "clean",
                "source_snapshot_sha256": frozen_identity["source_snapshot_sha256"],
            }
            python_evidence = {
                "name": "frozen-python-binding-probe",
                "pid": 911,
                "waited": True,
                "exit_code": 0,
                "output_drained": True,
            }
            frozen_package = {
                "manifest": package_manifest,
                "manifest_sha256": "4" * 64,
                "manifest_path": root / "native-manifest.json",
                "source_root": package_source.parent.parent,
                "source_identity": frozen_identity,
                "python_executable": python_executable,
                "python_sha256": hashlib.sha256(python_executable.read_bytes()).hexdigest(),
                "python_binding": {"fullmag_file": str(package_source / "fullmag" / "__init__.py")},
                "expected_python_abi": ("cp312-win_amd64", "win-amd64", "AMD64"),
                "expected_python_version": "0.1.0.dev-test",
                "build_python_package_version": "0.1.0.dev-test",
                "python_sync_required": False,
                "python_process": python_evidence,
                "historical_python_hash_binding": "not recorded in native manifest",
                "frozen_python_source": package_source,
                "runtime_root": root / "native-runtime",
                "build_root": root / "native-build",
                "native_layout": {"build_root": str(root / "native-build")},
                "manifest_path": root / "native-manifest.json",
            }
            runtime_identity = {
                "git_commit": package_manifest["git_commit"],
                "source_snapshot_sha256": package_manifest["source_snapshot_sha256"],
                "worktree_state": "clean",
            }
            bundle_record = {
                "bundle_root": bundle_root,
                "bundle_manifest": bundle_manifest,
                "bundle_manifest_sha256": hashlib.sha256(bundle_manifest.read_bytes()).hexdigest(),
                "api_binary": api_binary,
                "api_binary_sha256": hashlib.sha256(api_binary.read_bytes()).hexdigest(),
                "cli_binary": cli_binary,
                "cli_binary_sha256": hashlib.sha256(cli_binary.read_bytes()).hexdigest(),
                "bundle_id": "5" * 32,
                "qualification": "not_assessed",
                "api_size_bytes": 3,
                "cli_size_bytes": 3,
            }
            layout = {"build_root": str(run_root), "build_storage_root": str(root), "worktree_id": "test", "env": {}}
            process_counter = iter((4001, 4002))

            class FakeProcess:
                def __init__(self):
                    self.pid = next(process_counter)
                    self.returncode = None

                def poll(self):
                    return self.returncode

                def terminate(self):
                    self.returncode = 0

                def wait(self, timeout=None):
                    self.returncode = 0
                    return 0

                def kill(self):
                    self.returncode = -9

            def fake_request(url, **kwargs):
                if url.endswith("openapi.json"):
                    return 200, {"x-fullmag-build-identity": runtime_identity}
                return 200, {"run": {"run_id": "run-active", "solver_steps": 1},
                             "solver": {"state": "running"}}

            def fake_measure(package, receipt):
                package["python_process"] = python_evidence
                receipt["frozen_python_binding"]["binding_probe"] = package["python_binding"]
                receipt["frozen_python_binding"]["binding_probe_process"] = python_evidence
                receipt["processes"].append(python_evidence)
                return package["python_binding"]

            node_result = SimpleNamespace(returncode=0, stdout='{"state":"passed"}', stderr="")
            changed_checkout = [source_before, source_after]
            output = io.StringIO()
            with (
                mock.patch.object(probe.storage, "resolve_layout", return_value=layout),
                mock.patch.object(probe.storage, "initialize"),
                mock.patch.object(probe.storage, "build_lock", side_effect=lambda _layout: contextlib.nullcontext()),
                mock.patch.object(probe, "contained_paths", return_value=paths),
                mock.patch.object(probe, "verify_frozen_native_package", return_value=frozen_package),
                mock.patch.object(probe, "measure_frozen_python_binding", side_effect=fake_measure),
                mock.patch.object(probe, "seal_frozen_native_package", return_value=bundle_record),
                mock.patch.object(probe, "write_atomic_json"),
                mock.patch.object(probe.source_identity, "capture", side_effect=changed_checkout),
                mock.patch.object(probe, "free_port", return_value=4397),
                mock.patch.object(probe, "wait_for_health", return_value={"status": 200}),
                mock.patch.object(probe, "json_request", side_effect=fake_request),
                mock.patch.object(probe.shutil, "which", return_value="node.exe"),
                mock.patch.object(probe.subprocess, "Popen", side_effect=lambda *args, **kwargs: FakeProcess()),
                mock.patch.object(probe.subprocess, "run", return_value=node_result) as subprocess_run,
                mock.patch.object(probe, "toolchain_identity") as toolchain_identity,
                mock.patch.object(probe.runtime_bundle, "validate_bundle", return_value=({"bundle_id": "5" * 32}, {
                    "bin/fullmag-api.exe": bundle_record["api_binary_sha256"],
                    "bin/fullmag.exe": bundle_record["cli_binary_sha256"],
                })),
                mock.patch.object(probe, "verified_build_identity", return_value={"ready_build_id": "4" * 64, "ready_source_sha256": "6" * 64}),
                contextlib.redirect_stdout(output),
            ):
                code, receipt = probe.run(root, frozen_native_build_id="4" * 64)

            console_summary = json.loads(output.getvalue())
            self.assertEqual(code, 0)
            self.assertTrue(receipt["build_skipped"])
            self.assertEqual(receipt["build_command"], [])
            self.assertFalse(receipt["source_changed_during_run"])
            self.assertTrue(receipt["current_checkout_source_changed_during_run"])
            self.assertEqual(receipt["source_identity"], frozen_identity)
            self.assertEqual(receipt["current_checkout_identity_before"], source_before)
            self.assertEqual(receipt["current_checkout_identity_after"], source_after)
            self.assertEqual({item["name"] for item in receipt["processes"]}, {
                "frozen-python-binding-probe", "fullmag-api", "fullmag-cli",
            })
            self.assertEqual([item["exit_code"] for item in receipt["processes"]], [0, 0, 0])
            self.assertEqual(set(console_summary), {"receipt", "state", "exit_code", "run_id", "process_count", "error"})
            self.assertEqual(console_summary["process_count"], 3)
            self.assertLess(len(output.getvalue()), 800)
            self.assertNotIn("source_identity", console_summary)
            observer_binding = receipt["observer_script_binding"]
            self.assertEqual(Path(observer_binding["source_path"]), probe.SCRIPT_DIR / "probe_active_run_ws.mjs")
            self.assertEqual(Path(observer_binding["executed_snapshot_path"]), paths["probe_snapshot"])
            self.assertEqual(
                observer_binding["sha256"],
                hashlib.sha256(paths["probe_snapshot"].read_bytes()).hexdigest(),
            )
            self.assertEqual(Path(subprocess_run.call_args.args[0][1]), paths["probe_snapshot"])
            toolchain_identity.assert_not_called()
            self.assertFalse(any("cargo" in str(call.args[0]) for call in subprocess_run.call_args_list))
            self.assertFalse(paths["cargo_log"].exists())


if __name__ == "__main__":
    unittest.main()
