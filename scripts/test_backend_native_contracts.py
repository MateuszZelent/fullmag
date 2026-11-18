"""Mocked command-flow tests for the managed native contract gate."""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "docker" / "all-in-one"))

import backend_native_contracts as native_contracts
from backend_native_contracts import (
    FEM_DEMAG_POISSON,
    NativeContractError,
    PACKAGE_LIBRARY_ARTIFACT_PATH,
    normalize_contracts,
    receipt_satisfies,
    run_contracts,
)


SNAPSHOT = "a" * 64


class FakeProcess:
    def __init__(self, output: bytes, exit_code: int, on_wait=None) -> None:
        self.stdout = io.BytesIO(output)
        self.returncode = None
        self._exit_code = exit_code
        self._on_wait = on_wait
        self.killed = False

    def wait(self):
        if self._on_wait is not None:
            self._on_wait()
        self.returncode = -9 if self.killed else self._exit_code
        return self.returncode

    def kill(self):
        self.killed = True


class BackendNativeContractsTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.native_root = self.root / "native-build"
        self.build_fem = self.native_root / "backends" / "fem"
        self.build_fem.mkdir(parents=True)
        (self.native_root / "CMakeCache.txt").write_text(
            "FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256:STRING=" + SNAPSHOT + "\n")
        (self.build_fem / "libfullmag_fem.so").write_bytes(b"native library")
        (self.build_fem / "libfullmag_fem.so.0").symlink_to("libfullmag_fem.so")
        (self.build_fem / "fem_demag_poisson_contract").write_bytes(b"contract executable")
        self.package_root = self.root / "package"
        self.package_lib = self.package_root / "lib"
        self.package_lib.mkdir(parents=True)
        (self.package_lib / "libfullmag_fem.so").write_bytes(b"native library")
        (self.package_lib / "libfullmag_fem.so.0").write_bytes(b"native library")
        self.evidence_root = self.root / "private-control" / "native-contracts"
        self.environment = {"LD_LIBRARY_PATH": "/existing/dependencies", "PATH": "/usr/bin"}

    def _runner(self, outcomes=None, callbacks=None, output=b"mock output\n"):
        outcomes = list(outcomes or [0, 0])
        callbacks = list(callbacks or [None] * len(outcomes))
        calls = []

        def start(argv, **kwargs):
            index = len(calls)
            calls.append((list(argv), kwargs))
            return FakeProcess(output, outcomes[index], callbacks[index])

        return patch.object(native_contracts.subprocess, "Popen", side_effect=start), calls

    def _run(self, requested=None):
        return run_contracts(
            requested=requested or [FEM_DEMAG_POISSON],
            native_build_root=self.native_root,
            package_root=self.package_root,
            evidence_root=self.evidence_root,
            source_snapshot_sha256=SNAPSHOT,
            environment=self.environment,
            jobs=3,
        )

    def _prepare(self, requested=None):
        return native_contracts.prepare_contracts(
            requested=requested or [FEM_DEMAG_POISSON], native_build_root=self.native_root,
            evidence_root=self.root / "preparation", source_snapshot_sha256=SNAPSHOT,
            environment=self.environment, jobs=3,
        )

    def _run_prepared(self, requested=None):
        return run_contracts(
            requested=requested or [FEM_DEMAG_POISSON], native_build_root=self.native_root,
            package_root=self.package_root, evidence_root=self.evidence_root,
            source_snapshot_sha256=SNAPSHOT, environment=self.environment, jobs=3,
            preparation_root=self.root / "preparation",
        )

    def test_cuda_activity_contract_binds_its_own_target_and_preparation(self):
        name = "fem-cuda-activity-trace"
        binary = self.build_fem / "fem_cuda_activity_trace_contract"
        binary.write_bytes(b"CUDA trace executable")
        runner, calls = self._runner(outcomes=[0, 0])
        with runner:
            prepared = self._prepare([name])
            report = self._run_prepared([name])
        self.assertEqual(calls[0][0][4], binary.name)
        self.assertEqual(calls[1][0], [str(binary)])
        self.assertEqual(report["contracts"][name]["compile"], prepared["contracts"][name]["compile"])
        self.assertTrue(receipt_satisfies(report, requested=[name], source_snapshot_sha256=SNAPSHOT, package_root=self.package_root))
        self.assertFalse(receipt_satisfies(report, requested=[FEM_DEMAG_POISSON], source_snapshot_sha256=SNAPSHOT, package_root=self.package_root))
        for field in ("compile", "test", "test_binary", "preparation"):
            altered = json.loads(json.dumps(report))
            if field == "compile": altered["contracts"][name]["compile"]["argv"][4] = "fem_demag_poisson_contract"
            elif field == "test": altered["contracts"][name]["test"]["argv"][0] = str(self.build_fem / "fem_demag_poisson_contract")
            elif field == "test_binary": altered["contracts"][name]["test_binary"]["path"] = "backends/fem/fem_demag_poisson_contract"
            else: altered["preparation"]["requested"] = [FEM_DEMAG_POISSON]
            self.assertFalse(receipt_satisfies(altered, requested=[name], source_snapshot_sha256=SNAPSHOT, package_root=self.package_root), field)

    def test_cuda_activity_test_failure_is_preserved_and_cannot_qualify_package(self):
        name = "fem-cuda-activity-trace"
        (self.build_fem / "fem_cuda_activity_trace_contract").write_bytes(b"CUDA trace executable")
        # A CTest skip is not a successful managed GPU qualification.
        for code in (9, 77):
            runner, calls = self._runner(outcomes=[0, code])
            with runner, self.assertRaises(NativeContractError) as failed:
                self._run([name])
            self.assertEqual(len(calls), 2)
            report = failed.exception.report
            self.assertTrue(failed.exception.receipt_path.is_file())
            self.assertEqual(report["contracts"][name]["test"]["exit_code"], code)
            self.assertFalse(receipt_satisfies(report, requested=[name], source_snapshot_sha256=SNAPSHOT, package_root=self.package_root))

    def _assert_performance_contract_binding(self, name, target):
        binary = self.build_fem / target
        binary.write_bytes(b"performance contract executable")
        runner, calls = self._runner(outcomes=[0, 0])
        with runner:
            self._prepare([name])
            report = self._run_prepared([name])
        self.assertEqual(calls[0][0][4], target)
        self.assertEqual(calls[1][0], [str(binary)])
        self.assertTrue(receipt_satisfies(
            report, requested=[name], source_snapshot_sha256=SNAPSHOT,
            package_root=self.package_root))
        self.assertFalse(receipt_satisfies(
            report, requested=[FEM_DEMAG_POISSON], source_snapshot_sha256=SNAPSHOT,
            package_root=self.package_root))

    def test_pgbb_reuse_binds_its_own_executable_and_receipt(self):
        self._assert_performance_contract_binding(
            "fem-cuda-pgbb-reuse", "fem_cuda_pgbb_reuse_contract")

    def test_rk_guard_binds_its_own_executable_and_receipt(self):
        self._assert_performance_contract_binding(
            "fem-cuda-rk-guard", "fem_cuda_rk_guard_contract")

    def test_cpu_pgbb_binds_its_own_executable_and_receipt(self):
        self._assert_performance_contract_binding(
            "fem-cpu-pgbb-reuse", "fem_pgbb_accepted_cache_contract")

    def test_object_average_binds_its_own_executable_and_receipt(self):
        self._assert_performance_contract_binding(
            "fem-cuda-object-average", "fem_cuda_object_average_contract")

    def test_cpu_threads_binds_its_own_executable_and_receipt(self):
        self._assert_performance_contract_binding(
            "fem-cpu-threads", "fem_cpu_threads_contract")

    def test_combined_contract_request_is_refused_before_any_command(self):
        runner, calls = self._runner()
        with runner, self.assertRaises(ValueError):
            normalize_contracts([FEM_DEMAG_POISSON, "fem-cuda-activity-trace"])
        self.assertEqual(calls, [])

    def test_preparation_rebuild_precedes_copy_and_test_does_not_recompile(self) -> None:
        def rebuild_library():
            (self.build_fem / "libfullmag_fem.so").write_bytes(b"new library bytes")

        runner, calls = self._runner(callbacks=[rebuild_library, None])
        with runner:
            prepared = self._prepare()
            self.assertEqual(prepared["state"], "compiled")
            self.assertFalse(receipt_satisfies(
                prepared, requested=[FEM_DEMAG_POISSON],
                source_snapshot_sha256=SNAPSHOT, package_root=self.package_root))
            (self.package_lib / "libfullmag_fem.so").write_bytes(
                (self.build_fem / "libfullmag_fem.so").read_bytes())
            (self.package_lib / "libfullmag_fem.so.0").write_bytes(
                (self.build_fem / "libfullmag_fem.so").read_bytes())
            report = self._run_prepared()
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][0][0], "cmake")
        self.assertEqual(calls[1][0], [str(self.build_fem / "fem_demag_poisson_contract")])
        contract = report["contracts"][FEM_DEMAG_POISSON]
        self.assertEqual(contract["compile"], prepared["contracts"][FEM_DEMAG_POISSON]["compile"])
        self.assertTrue(receipt_satisfies(
            report, requested=[FEM_DEMAG_POISSON],
            source_snapshot_sha256=SNAPSHOT, package_root=self.package_root))
        altered = json.loads(json.dumps(report))
        altered["preparation"]["source_snapshot_sha256"] = "b" * 64
        self.assertFalse(receipt_satisfies(
            altered, requested=[FEM_DEMAG_POISSON],
            source_snapshot_sha256=SNAPSHOT, package_root=self.package_root))

    def test_preparation_compile_failure_cannot_reach_test(self) -> None:
        runner, calls = self._runner(outcomes=[7])
        with runner:
            with self.assertRaisesRegex(NativeContractError, "compile failed") as caught:
                self._prepare()
            self.assertTrue(caught.exception.receipt_path.is_file())
            with self.assertRaisesRegex(NativeContractError, "preparation"):
                self._run_prepared()
        self.assertEqual(len(calls), 1)

    def test_preparation_rejects_changed_binary_library_log_or_snapshot(self) -> None:
        for target in ("binary", "library", "log", "snapshot", "compile", "duplicate"):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temporary:
                self.root = Path(temporary)
                runner, calls = self._runner(outcomes=[0])
                with runner:
                    prepared = self._prepare()
                    attempt = self.root / "preparation" / ("attempt-" + prepared["attempt_id"])
                    if target == "binary":
                        path = self.build_fem / "fem_demag_poisson_contract"
                        original = path.read_bytes()
                        path.write_bytes(original + b"tamper")
                    elif target == "library":
                        path = self.build_fem / "libfullmag_fem.so"
                        original = path.read_bytes()
                        path.write_bytes(original + b"tamper")
                    elif target == "log":
                        (attempt / "native-contract.log").write_bytes(b"tampered log")
                    elif target in ("snapshot", "compile"):
                        if target == "snapshot":
                            prepared["source_snapshot_sha256"] = "b" * 64
                        else:
                            prepared["contracts"][FEM_DEMAG_POISSON]["compile"]["argv"][4] = "wrong-target"
                        (attempt / "report.json").write_text(json.dumps(prepared))
                    else:
                        (self.root / "preparation" / "unexpected").mkdir()
                    try:
                        with self.assertRaisesRegex(NativeContractError, "preparation"):
                            self._run_prepared()
                    finally:
                        if target in ("binary", "library"):
                            path.write_bytes(original)
                self.assertEqual(len(calls), 1)

    def test_preparation_rejects_wrong_cmake_snapshot_before_compile(self) -> None:
        (self.native_root / "CMakeCache.txt").write_text(
            "FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256:STRING=" + "b" * 64 + "\n")
        runner, calls = self._runner()
        with runner, self.assertRaisesRegex(NativeContractError, "CMake snapshot"):
            self._prepare()
        self.assertEqual(calls, [])

    def test_prepared_test_rechecks_binary_after_reading_preparation(self) -> None:
        runner, calls = self._runner(outcomes=[0])
        read = native_contracts._read_preparation

        def replace_after_read(*args):
            result = read(*args)
            (self.build_fem / "fem_demag_poisson_contract").write_bytes(b"replaced after proof")
            return result

        with runner:
            self._prepare()
            with patch.object(native_contracts, "_read_preparation", side_effect=replace_after_read):
                with self.assertRaisesRegex(NativeContractError, "prepared.*changed"):
                    self._run_prepared()
        self.assertEqual(len(calls), 1)

    def test_prepared_test_rejects_different_soname_library(self) -> None:
        for directory in (self.build_fem, self.package_lib):
            with self.subTest(directory=directory):
                runner, calls = self._runner(outcomes=[0])
                with runner:
                    prepared = self._prepare()
                    alias = directory / "libfullmag_fem.so.0"
                    alias.unlink()
                    alias.write_bytes(b"different dynamically loaded library")
                    with self.assertRaisesRegex(NativeContractError, "SONAME"):
                        self._run_prepared()
                    alias.write_bytes(b"native library")
                self.assertEqual(len(calls), 1)
                # Keep one distinct preparation root for each case.
                self.root = self.root / prepared["attempt_id"]

    def test_normalize_contracts_allows_empty_and_rejects_unknown_or_duplicate(self) -> None:
        self.assertEqual(normalize_contracts(None), ())
        self.assertEqual(normalize_contracts([]), ())
        self.assertEqual(normalize_contracts([FEM_DEMAG_POISSON]), (FEM_DEMAG_POISSON,))
        with self.assertRaisesRegex(ValueError, "unknown native contract"):
            normalize_contracts(["fem-other"])
        with self.assertRaisesRegex(ValueError, "duplicate native contract"):
            normalize_contracts([FEM_DEMAG_POISSON, FEM_DEMAG_POISSON])
        with self.assertRaisesRegex(ValueError, "sequence"):
            normalize_contracts(FEM_DEMAG_POISSON)

    def test_prepare_entrypoint_uses_only_managed_environment(self) -> None:
        environment = {
            "FULLMAG_DIRECT_COMPOSE": "1",
            "FULLMAG_INTERNAL_NATIVE_CONTRACTS": FEM_DEMAG_POISSON,
            "FULLMAG_FEM_NATIVE_BUILD_ROOT": str(self.native_root),
            "FULLMAG_INTERNAL_NATIVE_CONTRACT_PREPARATION_ROOT": str(self.root / "preparation"),
            "FULLMAG_SOURCE_SNAPSHOT_SHA256": SNAPSHOT,
            "CARGO_BUILD_JOBS": "3", "FULLMAG_CMAKE": "/usr/bin/cmake",
        }
        prepared = {"evidence": {"report_path": "attempt-fixture/report.json"}}
        with patch.dict(os.environ, environment, clear=True), patch.object(
            native_contracts, "prepare_contracts", return_value=prepared,
        ) as prepare, patch("sys.stdout", new=io.StringIO()), patch("sys.stderr", new=io.StringIO()):
            self.assertEqual(native_contracts._main(["prepare"]), 0)
            self.assertEqual(prepare.call_args.kwargs["jobs"], 3)
            self.assertEqual(prepare.call_args.kwargs["environment"]["FULLMAG_CMAKE"], "/usr/bin/cmake")
            self.assertEqual(native_contracts._main(["prepare", "--arbitrary-command"]), 2)
            del os.environ["FULLMAG_DIRECT_COMPOSE"]
            self.assertEqual(native_contracts._main(["prepare"]), 1)
            self.assertEqual(prepare.call_count, 1)

    def test_success_runs_fixed_compile_then_test_and_binds_installed_library(self) -> None:
        runner, calls = self._runner()
        with runner:
            report = self._run()

        self.assertEqual(report["schema"], "fullmag.backend-native-contracts.v1")
        self.assertEqual(report["state"], "succeeded")
        self.assertEqual(report["requested"], [FEM_DEMAG_POISSON])
        contract = report["contracts"][FEM_DEMAG_POISSON]
        self.assertEqual(contract["contract_revision"], 1)
        self.assertEqual(contract["state"], "passed")
        self.assertEqual(contract["compile"]["argv"][0:2], ["cmake", "--build"])
        self.assertEqual(contract["compile"]["argv"][3:6], ["--target", "fem_demag_poisson_contract", "--parallel"])
        self.assertEqual(contract["compile"]["argv"][6], "3")
        self.assertEqual(contract["test"]["argv"], [str(self.build_fem / "fem_demag_poisson_contract")])
        self.assertEqual(len(calls), 2)
        for _argv, kwargs in calls:
            self.assertIs(kwargs["shell"], False)
            self.assertEqual(
                kwargs["env"]["LD_LIBRARY_PATH"],
                str(self.build_fem) + os.pathsep + "/existing/dependencies",
            )
        libraries = contract["libraries"]
        self.assertEqual(libraries["build"]["sha256"], libraries["package"]["sha256"])
        self.assertTrue(receipt_satisfies(
            report,
            requested=[FEM_DEMAG_POISSON],
            source_snapshot_sha256=SNAPSHOT,
            package_root=self.package_root,
        ))
        artifact_hash = libraries["package"]["sha256"]
        self.assertTrue(receipt_satisfies(
            report,
            requested=[FEM_DEMAG_POISSON],
            source_snapshot_sha256=SNAPSHOT,
            package_library_sha256=artifact_hash,
        ))
        self.assertFalse(receipt_satisfies(
            report,
            requested=[FEM_DEMAG_POISSON],
            source_snapshot_sha256=SNAPSHOT,
        ))
        log_path = self.evidence_root / report["evidence"]["log_path"]
        receipt_path = self.evidence_root / report["evidence"]["report_path"]
        self.assertIn(b"mock output", log_path.read_bytes())
        self.assertEqual(json.loads(receipt_path.read_text(encoding="utf-8")), report)
        self.assertLessEqual(log_path.stat().st_size, native_contracts.MAX_LOG_BYTES)

    def test_compile_failure_persists_report_and_skips_test(self) -> None:
        runner, calls = self._runner(outcomes=[7, 0])
        with runner:
            with self.assertRaises(NativeContractError) as caught:
                self._run()

        self.assertEqual(len(calls), 1)
        report = caught.exception.report
        self.assertEqual(report["state"], "failed")
        contract = report["contracts"][FEM_DEMAG_POISSON]
        self.assertEqual(contract["compile"]["exit_code"], 7)
        self.assertEqual(contract["test"]["state"], "not_run")
        self.assertTrue(caught.exception.receipt_path.is_file())
        persisted = json.loads(caught.exception.receipt_path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["state"], "failed")
        self.assertFalse(receipt_satisfies(
            report,
            requested=[FEM_DEMAG_POISSON],
            source_snapshot_sha256=SNAPSHOT,
            package_root=self.package_root,
        ))

    def test_test_failure_is_durable_and_does_not_satisfy_receipt(self) -> None:
        runner, calls = self._runner(outcomes=[0, 9])
        with runner:
            with self.assertRaises(NativeContractError) as caught:
                self._run()

        self.assertEqual(len(calls), 2)
        report = caught.exception.report
        self.assertEqual(report["contracts"][FEM_DEMAG_POISSON]["test"]["exit_code"], 9)
        self.assertFalse(receipt_satisfies(
            report,
            requested=[FEM_DEMAG_POISSON],
            source_snapshot_sha256=SNAPSHOT,
            package_root=self.package_root,
        ))

    def test_binary_tampering_during_test_fails_gate(self) -> None:
        binary = self.build_fem / "fem_demag_poisson_contract"

        def tamper_binary():
            binary.write_bytes(b"replaced executable")

        runner, _calls = self._runner(callbacks=[None, tamper_binary])
        with runner:
            with self.assertRaisesRegex(NativeContractError, "binary changed") as caught:
                self._run()
        contract = caught.exception.report["contracts"][FEM_DEMAG_POISSON]
        self.assertNotEqual(contract["test_binary"]["sha256_before"], contract["test_binary"]["sha256_after"])

    def test_library_tampering_during_test_fails_gate(self) -> None:
        package_library = self.package_lib / "libfullmag_fem.so"

        def tamper_library():
            package_library.write_bytes(b"replaced package library")

        runner, _calls = self._runner(callbacks=[None, tamper_library])
        with runner:
            with self.assertRaisesRegex(NativeContractError, "packaged FEM library changed") as caught:
                self._run()
        report = caught.exception.report
        self.assertFalse(receipt_satisfies(
            report,
            requested=[FEM_DEMAG_POISSON],
            source_snapshot_sha256=SNAPSHOT,
            package_root=self.package_root,
        ))

    def test_receipt_rejects_snapshot_or_package_library_mismatch(self) -> None:
        runner, _calls = self._runner()
        with runner:
            report = self._run()
        self.assertFalse(receipt_satisfies(
            report,
            requested=[FEM_DEMAG_POISSON],
            source_snapshot_sha256="b" * 64,
            package_root=self.package_root,
        ))
        (self.package_lib / "libfullmag_fem.so").write_bytes(b"post-restore tamper")
        self.assertFalse(receipt_satisfies(
            report,
            requested=[FEM_DEMAG_POISSON],
            source_snapshot_sha256=SNAPSHOT,
            package_root=self.package_root,
        ))

    def test_receipt_rejects_replaced_package_soname_after_test(self) -> None:
        runner, _calls = self._runner()
        with runner:
            report = self._run()
        (self.package_lib / "libfullmag_fem.so.0").write_bytes(b"replaced runtime library")
        self.assertFalse(receipt_satisfies(
            report, requested=[FEM_DEMAG_POISSON],
            source_snapshot_sha256=SNAPSHOT, package_root=self.package_root))

    def test_receipt_rejects_missing_hash_wrong_revision_or_wrong_contract_id(self) -> None:
        runner, _calls = self._runner()
        with runner:
            report = self._run()
        cases = []
        missing_hash = json.loads(json.dumps(report))
        del missing_hash["contracts"][FEM_DEMAG_POISSON]["libraries"]["build"]["sha256"]
        cases.append((missing_hash, [FEM_DEMAG_POISSON]))
        wrong_revision = json.loads(json.dumps(report))
        wrong_revision["contracts"][FEM_DEMAG_POISSON]["contract_revision"] = 2
        cases.append((wrong_revision, [FEM_DEMAG_POISSON]))
        wrong_id = json.loads(json.dumps(report))
        wrong_id["requested"] = ["unknown-contract"]
        cases.append((wrong_id, [FEM_DEMAG_POISSON]))
        for candidate, requested in cases:
            with self.subTest(candidate=candidate):
                self.assertFalse(receipt_satisfies(
                    candidate,
                    requested=requested,
                    source_snapshot_sha256=SNAPSHOT,
                    package_root=self.package_root,
                ))

    def test_build_library_symlink_cannot_escape_native_root(self) -> None:
        outside = self.root / "outside-library.so"
        outside.write_bytes(b"outside")
        built_library = self.build_fem / "libfullmag_fem.so"
        built_library.unlink()
        built_library.symlink_to(outside)
        runner, calls = self._runner()
        with runner:
            with self.assertRaisesRegex(NativeContractError, "resolves outside") as caught:
                self._run()
        self.assertEqual(len(calls), 1)
        self.assertEqual(caught.exception.report["contracts"][FEM_DEMAG_POISSON]["test"]["state"], "not_run")

    def test_empty_request_preserves_legacy_receipt_without_touching_evidence(self) -> None:
        report = run_contracts(
            requested=[],
            native_build_root=self.native_root,
            package_root=self.package_root,
            evidence_root=self.evidence_root,
            source_snapshot_sha256="invalid-for-skipped-request",
            environment={},
            jobs=0,
        )
        self.assertEqual(report["state"], "skipped")
        self.assertFalse(self.evidence_root.exists())
        self.assertTrue(receipt_satisfies(
            None,
            requested=[],
            source_snapshot_sha256="legacy-source-had-no-native-contract-field",
        ))

    def test_evidence_root_symlink_is_rejected_without_writing_through_it(self) -> None:
        outside = self.root / "outside-evidence"
        outside.mkdir()
        self.evidence_root.parent.mkdir(parents=True)
        self.evidence_root.symlink_to(outside, target_is_directory=True)
        runner, calls = self._runner()
        with runner:
            with self.assertRaisesRegex(NativeContractError, "must not be a symlink"):
                self._run()
        self.assertEqual(calls, [])
        self.assertEqual(list(outside.iterdir()), [])

    def test_invalid_snapshot_writes_failed_receipt_without_running_commands(self) -> None:
        runner, calls = self._runner()
        with runner:
            with self.assertRaisesRegex(NativeContractError, "snapshot SHA-256 is invalid") as caught:
                run_contracts(
                    requested=[FEM_DEMAG_POISSON],
                    native_build_root=self.native_root,
                    package_root=self.package_root,
                    evidence_root=self.evidence_root,
                    source_snapshot_sha256="bad",
                    environment=self.environment,
                    jobs=2,
                )
        self.assertEqual(calls, [])
        self.assertEqual(caught.exception.report["state"], "failed")
        self.assertTrue(caught.exception.receipt_path.is_file())

    def test_log_limit_fails_gate_and_preserves_bounded_log(self) -> None:
        runner, calls = self._runner(output=b"x" * (native_contracts.MAX_LOG_BYTES + 1))
        with runner, patch.object(native_contracts, "_terminate_command_group", side_effect=lambda process: process.kill()):
            with self.assertRaisesRegex(NativeContractError, "log_limit_exceeded") as caught:
                self._run()
        self.assertEqual(len(calls), 1)
        report = caught.exception.report
        self.assertEqual(report["contracts"][FEM_DEMAG_POISSON]["compile"]["reason"], "log_limit_exceeded")
        log_path = self.evidence_root / report["evidence"]["log_path"]
        self.assertEqual(log_path.stat().st_size, native_contracts.MAX_LOG_BYTES)
        self.assertEqual(report["evidence"]["log_size_bytes"], native_contracts.MAX_LOG_BYTES)

    @unittest.skipUnless(sys.platform.startswith("linux"), "managed backend process-group contract")
    def test_log_limit_stops_descendant_before_returning_failure(self) -> None:
        marker = self.root / "descendant-wrote-after-failure"
        child = "import pathlib,time; time.sleep(0.35); pathlib.Path(" + repr(str(marker)) + ").write_text('unsafe')"
        parent = ("import subprocess,sys,time; subprocess.Popen([sys.executable,'-c'," + repr(child)
                  + "]); print('x'*262144,flush=True); time.sleep(3)")
        with (self.root / "real-process.log").open("wb") as log:
            with patch.object(native_contracts, "MAX_LOG_BYTES", 4096):
                result = native_contracts._run_command(
                    [sys.executable, "-c", parent], cwd=self.root,
                    environment=os.environ.copy(), log_file=log)
        self.assertEqual(result["reason"], "log_limit_exceeded")
        time.sleep(0.5)
        self.assertFalse(marker.exists(), "a descendant kept writing after terminal failure")


if __name__ == "__main__":
    unittest.main()
