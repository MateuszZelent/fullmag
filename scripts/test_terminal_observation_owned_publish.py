"""Owned observation publication; Docker transport is always mocked."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import docker_volume_terminal_observation as observation

try:
    import fcntl
except ImportError:
    fcntl = None


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux owned-helper publication contract")
class OwnedPublishTests(unittest.TestCase):
    def setUp(self):
        self.token = "a" * 32
        self.operation = {
            "lease_ready": True, "daemon_pending": True,
            "root": "data-volume-migration/attempts/" + self.token,
            "receipt": {"phase": "data-volume-migration", "attempt": self.token,
                        "compose_project": "fullmag-fixture", "control_volume": "fixture-volume"},
        }
        self.control = SimpleNamespace(
            _active_operation=self.operation, namespace="", project="fullmag-fixture",
            volume="fixture-volume", _assert_live_operation_helper=Mock(return_value="b" * 64),
        )
        self.proof = observation.canonical({"schema": observation.PROOF_SCHEMA}) + b"\n"
        self.proof_sha = hashlib.sha256(self.proof).hexdigest()
        self.prefix = "terminal-observation/" + self.proof_sha
        self.request = observation.canonical({
            "schema": "fullmag.terminal-observation-request.v1",
            "proof_path": self.prefix + "/proof.json", "proof_sha256": self.proof_sha,
        }) + b"\n"
        self.records = [(self.prefix + "/proof.json", self.proof),
                        (self.prefix + "/request.json", self.request)]

    def publish(self, records=None):
        return observation._publish_private_records(
            self.control, self.records if records is None else records,
            owned_operation=self.operation,
        )

    def test_owned_uses_the_existing_helper_without_relocking(self):
        with patch("docker_build_control.bounded_capture", return_value=SimpleNamespace(
            returncode=0, stdout=b"PUBLISHED\n")) as capture:
            self.publish()
        argv = capture.call_args.args[0]
        self.assertEqual(argv[1:7], ["exec", "--interactive", "--user", "65532:65532", "b" * 64,
                                    "/usr/local/bin/python3"])
        self.assertEqual(argv[7:10], ["-I", "-B", "-c"])
        self.assertNotIn("flock", argv[10])
        self.assertEqual(self.control._assert_live_operation_helper.call_count, 2)
        self.assertNotIn(self.proof.decode(), repr(argv))

    def test_wrong_operation_or_namespace_refuses_before_transport(self):
        for variant in ("clone", "lease", "guard", "phase", "token", "root", "project", "volume", "namespace", "receipt-namespace"):
            with self.subTest(variant=variant):
                self.setUp()
                if variant == "clone": self.control._active_operation = copy.deepcopy(self.operation)
                elif variant == "lease": self.operation["lease_ready"] = False
                elif variant == "guard": self.operation["daemon_pending"] = False
                elif variant == "phase": self.operation["receipt"]["phase"] = "development"
                elif variant == "token": self.operation["receipt"]["attempt"] = True
                elif variant == "root": self.operation["root"] = "foreign"
                elif variant == "project": self.operation["receipt"]["compose_project"] = "foreign"
                elif variant == "volume": self.operation["receipt"]["control_volume"] = "foreign"
                elif variant == "namespace": self.control.namespace = "namespaces/" + "c" * 32
                else: self.operation["receipt"]["control_namespace"] = ""
                with patch("docker_build_control.bounded_capture") as capture, self.assertRaises(ValueError):
                    self.publish()
                capture.assert_not_called()

    def test_open_or_inconsistent_payload_refuses_before_transport(self):
        cases = (self.records + [("foreign", b"data")],
                 [("foreign/proof.json", self.proof), self.records[1]],
                 [(self.prefix + "/proofXjson", self.proof), self.records[1]],
                 [self.records[0], (self.records[1][0], b"{}")],
                 [(self.records[0][0], self.proof + b" "), self.records[1]])
        for records in cases:
            with self.subTest(records=records), patch("docker_build_control.bounded_capture") as capture:
                with self.assertRaises(ValueError): self.publish(records)
                capture.assert_not_called()

    def test_real_tiny_files_published_exclusively_and_existing_must_match(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "active").write_text(self.token + "\n")
            def transport(argv, *, data, **_kwargs):
                program = argv[-1].replace("CONTROL_ROOT = '/control'", "CONTROL_ROOT = " + repr(str(root)))
                return subprocess.run([sys.executable, "-I", "-B", "-c", program], input=data,
                                      capture_output=True, timeout=5)
            with (root / "operation.lock").open("w") as held, \
                 patch("docker_build_control.bounded_capture", side_effect=transport):
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.publish()
                target = root / "runtime-control" / self.prefix
                self.assertEqual((target / "proof.json").read_bytes(), self.proof)
                self.assertEqual((target / "request.json").read_bytes(), self.request)
                self.publish()
                (target / "request.json").write_bytes(b"foreign")
                with self.assertRaises(ValueError): self.publish()
                self.assertEqual((target / "request.json").read_bytes(), b"foreign")
                self.assertEqual((root / "active").read_text(), self.token + "\n")

    def test_ordinary_publication_keeps_its_exclusive_lock_and_active_guard(self):
        self.control.helper_args = Mock(return_value=["fixture", "--entrypoint", "bash"])
        self.control.path = lambda path: "/control/" + path
        with patch("docker_build_control.bounded_capture", return_value=SimpleNamespace(
                returncode=73, stdout=b"")), self.assertRaises(ValueError):
            observation._publish_private_records(self.control, self.records)
        program = self.control.helper_args.call_args.args[0]
        self.assertIn("flock -n 9", program)
        self.assertIn("test ! -e /control/active", program)
        self.control._assert_live_operation_helper.assert_not_called()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "active").write_text(self.token + "\n")
            with (root / "operation.lock").open("w") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                actual = subprocess.run(["/bin/bash", "-euo", "pipefail", "-c",
                    program.replace("/control", str(root))], capture_output=True, timeout=5,
                    env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
                self.assertEqual(actual.returncode, 73)
            # Without the flock, the existing active token still refuses.
            actual = subprocess.run(["/bin/bash", "-euo", "pipefail", "-c",
                program.replace("/control", str(root))], capture_output=True, timeout=5,
                env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
            self.assertNotEqual(actual.returncode, 0)
            self.assertFalse((root / "runtime-control").exists())

    def test_post_exec_lease_drift_or_ambiguous_ack_never_confirms(self):
        for variant in ("helper", "token", "ack", "timeout"):
            with self.subTest(variant=variant):
                self.setUp()
                if variant == "helper":
                    self.control._assert_live_operation_helper.side_effect = ["b" * 64, "c" * 64]
                def transport(*_args, **_kwargs):
                    if variant == "token": self.operation["receipt"]["attempt"] = "d" * 32
                    if variant == "timeout": raise subprocess.TimeoutExpired("owned-publisher", 180)
                    return SimpleNamespace(returncode=0, stdout=b"" if variant == "ack" else b"PUBLISHED\n")
                with patch("docker_build_control.bounded_capture", side_effect=transport) as capture:
                    with self.assertRaises((ValueError, subprocess.TimeoutExpired)): self.publish()
                self.assertEqual(capture.call_count, 1)
                self.assertTrue(self.operation["daemon_pending"])
                self.assertEqual(self.control._assert_live_operation_helper.call_count, 2)

    def test_real_symlink_or_wrong_active_token_refuses_without_foreign_writes(self):
        for variant in ("parent-link", "file-link", "token"):
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / "control"
                foreign = Path(directory) / "foreign"
                root.mkdir();foreign.mkdir()
                (root / "active").write_text(("e" * 32 if variant == "token" else self.token) + "\n")
                if variant == "parent-link":
                    (root / "runtime-control").symlink_to(foreign, target_is_directory=True)
                if variant == "file-link":
                    target = root / "runtime-control" / self.prefix
                    target.mkdir(parents=True)
                    (foreign / "data").write_bytes(b"untouched")
                    (target / "request.json").symlink_to(foreign / "data")
                def transport(argv, *, data, **_kwargs):
                    program = argv[-1].replace("CONTROL_ROOT = '/control'", "CONTROL_ROOT = " + repr(str(root)))
                    return subprocess.run([sys.executable, "-I", "-B", "-c", program], input=data,
                                          capture_output=True, timeout=5)
                with patch("docker_build_control.bounded_capture", side_effect=transport):
                    with self.assertRaises(ValueError): self.publish()
                self.assertEqual(list(foreign.iterdir()), [foreign / "data"] if variant == "file-link" else [])
                if variant == "file-link": self.assertEqual((foreign / "data").read_bytes(), b"untouched")

    def test_real_active_or_control_path_drift_after_first_write_retains_partial_records(self):
        for variant in ("active", "root", "parent"):
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / "control";root.mkdir()
                backup = Path(directory) / "retained"
                (root / "active").write_text(self.token + "\n")
                def transport(argv, *, data, **_kwargs):
                    mutation = (
                        f"pathlib.Path({str(root / 'active')!r}).write_text('foreign\\n')" if variant == "active" else
                        f"os.rename({str(root)!r},{str(backup)!r});os.mkdir({str(root)!r})" if variant == "root" else
                        f"os.rename({str(root / 'runtime-control')!r},{str(backup)!r});os.mkdir({str(root / 'runtime-control')!r})"
                    )
                    prefix = ("import os,pathlib\noriginal_write=os.write\nchanged=False\n"
                              "def injected(fd,data):\n global changed\n result=original_write(fd,data)\n"
                              " if not changed:\n  changed=True\n  " + mutation + "\n return result\nos.write=injected\n")
                    program = argv[-1].replace("CONTROL_ROOT = '/control'", "CONTROL_ROOT = " + repr(str(root)))
                    return subprocess.run([sys.executable, "-I", "-B", "-c", prefix + program], input=data,
                                          capture_output=True, timeout=5)
                with patch("docker_build_control.bounded_capture", side_effect=transport):
                    with self.assertRaises(ValueError): self.publish()
                if variant == "root": self.assertEqual(list(root.iterdir()), [])
                if variant == "parent": self.assertEqual(list((root / "runtime-control").iterdir()), [])
                self.assertTrue(any(Path(directory).rglob("proof.json")))

    def test_owned_captured_producer_forwards_the_exact_operation(self):
        proof = {"operation_sha256": "f" * 64}
        with patch.object(observation, "build_captured_proof", return_value=proof), \
             patch.object(observation, "_prepare_proof_context", return_value="context") as prepare:
            result = observation.prepare_captured_context(
                self.control, stop_attempt="e" * 32, store_root=Path("/old-backup/store"),
                source_root="/source", attempt="d" * 32, config_sha256="a" * 64,
                actual={"backend": {"Image": "sha256:" + "c" * 64}}, owned_operation=self.operation)
        self.assertEqual(result, "context")
        self.assertIs(prepare.call_args.kwargs["owned_operation"], self.operation)

    def test_owned_mode_refuses_special_stop_before_any_native_helper_dispatch(self):
        for variant in ("diagnostic", "preowner", "cold", "failed-parent", "ordinary"):
            with self.subTest(variant=variant):
                stop = {"diagnostic_terminal_stop_sha256": "b" * 64} if variant == "diagnostic" else {}
                parent = {"state": "failed-confirmed" if variant == "failed-parent" else "succeeded"}
                def control_read(_control, path, **_kwargs):
                    if variant == "preowner" and "preowner-drained" in path: return b"present"
                    if variant == "cold" and "cold-stored-budget" in path: return b"present"
                    return None
                with patch.object(observation, "managed", side_effect=[(b"", stop), (b"", parent)]), \
                     patch("docker_volume_accepted_reattach._control_bytes", side_effect=control_read), \
                     patch.object(observation, "_observation_stop") as special, \
                     patch.object(observation, "validate_empty_stop", return_value=("e" * 32, "f" * 64)) as ordinary, \
                     patch.object(observation, "_publish_private_records") as publish:
                    kwargs = dict(source_root="/source", attempt="d" * 32, config_sha256="a" * 64,
                                  actual={"backend": {"Id": "c" * 64}}, stop_pin=("e" * 32, "f" * 64),
                                  owned_operation=self.operation)
                    if variant == "ordinary":
                        observation._prepare_proof_context(self.control, Mock(), {}, self.proof, **kwargs)
                        ordinary.assert_called_once()
                        self.assertIs(publish.call_args.kwargs["owned_operation"], self.operation)
                    else:
                        with self.assertRaises(ValueError):
                            observation._prepare_proof_context(self.control, Mock(), {}, self.proof, **kwargs)
                        ordinary.assert_not_called();publish.assert_not_called()
                    special.assert_not_called()


if __name__ == "__main__":
    unittest.main()
