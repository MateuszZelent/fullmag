"""Interpreted safety checks for the retained managed FEM startup probe."""
from __future__ import annotations

import ast
from contextlib import redirect_stderr
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
DRIVER_PATH = ROOT / "scripts" / "diagnose_managed_fem_startup.py"
SCRIPTS = str(DRIVER_PATH.parent)
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)
_spec = importlib.util.spec_from_file_location("diagnose_managed_fem_startup", DRIVER_PATH)
assert _spec is not None and _spec.loader is not None
_driver = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _driver
_spec.loader.exec_module(_driver)


class _TimeoutProcess:
    def __init__(self) -> None:
        self.stdout = io.BytesIO(b"stdout")
        self.stderr = io.BytesIO(b"stderr")
        self.wait_calls = 0
        self.terminated = False
        self.killed = False

    def wait(self, timeout: float) -> int:
        self.wait_calls += 1
        if self.wait_calls < 3:
            raise subprocess.TimeoutExpired(["fixed-probe"], timeout)
        return 137

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True


class DiagnosticDriverTests(unittest.TestCase):
    def test_source_contract_and_probe_inventory(self) -> None:
        tree = ast.parse(DRIVER_PATH.read_text(encoding="utf-8"))
        self.assertIsInstance(tree, ast.Module)
        source = DRIVER_PATH.read_text(encoding="utf-8")
        self.assertNotIn('records["receipt"].get("native_source_identity")', source)
        self.assertIn('trusted_hashes["context.json"] != _sha256(paths["context"])', source)
        names = [name for name, _ in _driver.PROBES]
        self.assertEqual(
            names,
            ["fullmag-help", "fullmag-help-loader", "fem-availability", "loader-linkage"],
        )
        self.assertIn("LD_DEBUG=libs", _driver.PROBES[1][1])
        self.assertIn("libfullmag_fem.so.0.1.0", _driver.LINKAGE_SCRIPT)

    def test_create_command_is_fixed_and_confined(self) -> None:
        image = "sha256:" + "a" * 64
        expected_env = _driver._diagnostic_environment("/image/lib")
        command = _driver.build_create_command(
            image=image,
            name="fullmag-startup-diagnostic-test",
            execution=Path("C:/failed/execution"),
            driver=Path("C:/repo/scripts/diagnose_managed_fem_startup.py"),
            output=Path("C:/diagnostics/output"),
            image_library_path="/image/lib",
        )
        self.assertIn("--read-only", command)
        self.assertEqual(command[command.index("--network") + 1], "none")
        self.assertEqual(command[command.index("--cpus") + 1], "1")
        self.assertEqual(command[command.index("--memory") + 1], str(_driver.MEMORY_BYTES))
        self.assertEqual(command[command.index("--memory-swap") + 1], str(_driver.MEMORY_BYTES))
        self.assertEqual(command[command.index("--pids-limit") + 1], str(_driver.PIDS_LIMIT))
        self.assertEqual(command[command.index("--tmpfs") + 1], _driver.TMPFS)
        self.assertIn("--env", command)
        self.assertIn("LD_DEBUG=libs", command)
        self.assertIn("--mount", command)
        self.assertIn("target=/workspace,readonly", " ".join(command))
        self.assertIn("target=/diagnostic-driver.py,readonly", " ".join(command))
        self.assertIn("target=/diagnostic-output", " ".join(command))
        self.assertNotIn("--rm", command)
        self.assertNotIn("--gpus", command)
        self.assertNotIn("docker run", " ".join(command))
        self.assertEqual(command[-2:], ["-c", _driver.SUPERVISOR])
        self.assertIn("--entrypoint", command)
        self.assertEqual(command[command.index("--entrypoint") + 1], _driver.CONTAINER_PATH)
        for key, value in expected_env.items():
            self.assertIn(f"{key}={value}", command)

    def test_container_record_requires_owned_policy(self) -> None:
        image = "sha256:" + "b" * 64
        execution = Path("C:/failed/execution")
        driver = Path("C:/repo/scripts/diagnose_managed_fem_startup.py")
        output = Path("C:/diagnostics/output")
        expected_env = _driver._diagnostic_environment("/image/lib")
        record = {
            "Image": image,
            "Path": _driver.CONTAINER_PATH,
            "Args": list(_driver.CONTAINER_ARGS),
            "Config": {
                "User": "65532:65532",
                "Env": [
                    f"{key}={value}"
                    for key, value in expected_env.items()
                ],
                "Labels": {
                    "fullmag.diagnostic": "managed-fem-startup-v1",
                    "fullmag.diagnostic-source": "terminal-failed-job",
                },
            },
            "HostConfig": {
                "ReadonlyRootfs": True,
                "NetworkMode": "none",
                "NanoCpus": 1_000_000_000,
                "Memory": _driver.MEMORY_BYTES,
                "MemorySwap": _driver.MEMORY_BYTES,
                "PidsLimit": _driver.PIDS_LIMIT,
                "DeviceRequests": None,
                "Tmpfs": {"/tmp": _driver.TMPFS.split(":", 1)[1]},
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"],
            },
            "Mounts": [
                {"Type": "bind", "Source": str(execution), "Destination": "/workspace", "RW": False},
                {"Type": "bind", "Source": str(driver), "Destination": _driver.DRIVER_TARGET, "RW": False},
                {"Type": "bind", "Source": str(output), "Destination": _driver.OUTPUT_TARGET, "RW": True},
            ],
            "State": {"Running": True, "Status": "running"},
        }
        self.assertEqual(
            _driver.validate_container_record(
                record, image=image, execution=execution, driver=driver, output=output,
                expected_env=expected_env,
            ),
            record["State"],
        )
        record["HostConfig"]["Tmpfs"] = {"/tmp": "rw,size=64m"}
        with self.assertRaises(_driver.DiagnosticError):
            _driver.validate_container_record(
                record, image=image, execution=execution, driver=driver, output=output,
                expected_env=expected_env,
            )

        record["Path"] = "/bin/bash"
        with self.assertRaises(_driver.DiagnosticError):
            _driver.validate_container_record(
                record, image=image, execution=execution, driver=driver, output=output,
                expected_env=expected_env,
            )
        record["Path"] = _driver.CONTAINER_PATH
        record["Config"]["Env"][-1] = "LD_DEBUG=not-libs"
        with self.assertRaises(_driver.DiagnosticError):
            _driver.validate_container_record(
                record, image=image, execution=execution, driver=driver, output=output,
                expected_env=expected_env,
            )
        record["Config"]["Env"][-1] = "LD_DEBUG=libs"
        record["HostConfig"]["Tmpfs"] = {"/tmp": _driver.TMPFS.split(":", 1)[1]}
        record["Mounts"].append(dict(record["Mounts"][0]))
        with self.assertRaises(_driver.DiagnosticError):
            _driver.validate_container_record(
                record, image=image, execution=execution, driver=driver, output=output,
                expected_env=expected_env,
            )

    def test_container_record_identity_and_runtime_contract_are_attested(self) -> None:
        container_id = "c" * 64
        record = {
            "Id": container_id,
            "Config": {
                "Path": _driver.CONTAINER_PATH,
                "Args": list(_driver.CONTAINER_ARGS),
                "Env": ["HOME=/tmp", "LD_DEBUG=libs"],
            },
        }
        self.assertIs(
            _driver._container_record(record, container_id), record,
        )
        with self.assertRaises(_driver.DiagnosticError):
            _driver._container_record(record, "d" * 64)
        with self.assertRaises(_driver.DiagnosticError):
            _driver._container_record({"Id": "not-a-container"})

    def test_probe_reader_timeout_is_marked_truncated(self) -> None:
        class HangingThread:
            def start(self) -> None:
                return None

            def join(self, _timeout: float) -> None:
                return None

            def is_alive(self) -> bool:
                return True

        with patch.object(_driver.threading, "Thread", side_effect=[HangingThread(), HangingThread()]):
            with patch.object(_driver.subprocess, "Popen") as popen:
                process = popen.return_value
                process.stdout = io.BytesIO(b"")
                process.stderr = io.BytesIO(b"")
                process.wait.return_value = 0
                result = _driver.run_bounded_probe(
                    _driver.build_probe_command("docker.exe", "c" * 64, _driver.PROBES[0][1]),
                    popen=popen,
                )
        self.assertTrue(result["stdout_truncated"])
        self.assertTrue(result["stderr_truncated"])

    def test_hashes_skip_reparse_links_before_is_file(self) -> None:
        class FakeLink:
            name = "libfullmag_fem.so"

            def is_file(self) -> bool:
                raise AssertionError("reparse link must be skipped before is_file")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "local" / "bin" / "fullmag-bin"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"binary")
            context_file = root / "context.json"
            context_file.write_text("{}", encoding="utf-8")
            fake_link = FakeLink()
            real_is_link = _driver.is_link

            def is_link(value: object) -> bool:
                return value is fake_link or real_is_link(value)

            context = {"binary": binary, "paths": {"context": context_file}}
            with patch.object(Path, "glob", return_value=[fake_link]), patch.object(
                _driver, "is_link", side_effect=is_link,
            ):
                hashes = _driver._hashes(context, DRIVER_PATH)
        self.assertNotIn("runtime-lib/libfullmag_fem.so", hashes)
        self.assertIn("fullmag-bin", hashes)
    def test_probe_timeout_is_bounded_and_scrubs_docker_overrides(self) -> None:
        process = _TimeoutProcess()
        captured: dict[str, object] = {}

        def fake_popen(command: list[str], **kwargs: object) -> _TimeoutProcess:
            captured["command"] = command
            captured.update(kwargs)
            return process

        command = _driver.build_probe_command(
            "docker.exe", "c" * 64, _driver.PROBES[0][1],
        )
        with patch.dict(os.environ, {"DOCKER_CONTEXT": "untrusted", "DOCKER_HOST": "tcp://bad"}):
            result = _driver.run_bounded_probe(command, popen=fake_popen)
        self.assertEqual(command[5:9], ["/usr/bin/timeout", "--signal=TERM", "--kill-after=2s", "10s"])
        self.assertTrue(process.terminated)
        self.assertTrue(process.killed)
        self.assertEqual(result["termination"], "term_then_kill")
        self.assertTrue(result["timed_out"])
        self.assertEqual(result["stdout"], b"stdout")
        self.assertEqual(result["stderr"], b"stderr")
        environment = captured["env"]
        self.assertIsInstance(environment, dict)
        self.assertNotIn("DOCKER_CONTEXT", environment)
        self.assertNotIn("DOCKER_HOST", environment)
        self.assertNotIn("DOCKER_TLS_VERIFY", environment)
        self.assertNotIn("DOCKER_CERT_PATH", environment)

    def test_parser_rejects_user_commands_and_guards_identity(self) -> None:
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            _driver.parse_args(["--job-id", "d" * 32, "--command", "whoami"])
        with self.assertRaises(_driver.DiagnosticError):
            _driver.build_probe_command("docker.exe", "D" * 64, _driver.PROBES[0][1])
        self.assertTrue(
            _driver.is_availability_probe_error(
                "BuildEntryPointError: SLEPc runtime availability probe failed: timeout"
            )
        )
        self.assertFalse(_driver.is_availability_probe_error("runtime solver failed"))


if __name__ == "__main__":
    unittest.main()
