"""Post-reboot resume failure reconciliation; no services or native builds."""
import copy
import fcntl
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_development_interrupted as recovery
from docker_build_control import BuildControlError, canonical
from docker_volume_reconcile import digest, fingerprint
import test_docker_volume_development_interrupted as development_tests


class InterruptedResumeTests(unittest.TestCase):
    def setUp(self):
        fixture = development_tests.InterruptedDevelopmentTests()
        fixture.setUp()
        self.r = copy.deepcopy(fixture.request)
        self.control = fixture.control
        self.source = fixture.source
        self.actual = copy.deepcopy(fixture.actual)
        self.actual["frontend"]["State"]["ExitCode"] = 1
        self.r.update(schema=recovery.RESUME_SCHEMA, base_attempt="a" * 32,
            host_boot_id="b21e4070-0fc2-4df9-b55d-5308c61c115c",
            storage_identity={"root_inode": 1, "retained_device": 2096, "observed_device": 2128},
            failure={key: "f" * 64 for key in ("inputs_sha256", "previous_receipt_sha256", "receipt_sha256", "provenance_sha256")})
        self.r["controller_inputs"].update({name: "e" * 64 for name in (
            "docker_volume_development_interrupted.py", "docker_volume_frontend_frozen_recovery.py", "docker_development_inputs.py")})
        for service, actual in self.actual.items():
            self.r["containers"][service]["state_sha256"] = digest(canonical(actual["State"]))
        self.original = copy.deepcopy(fixture.original)
        self.original.update(phase="resume", state="outcome-unknown-resources-retained",
            backend_started_at=self.actual["backend"]["State"]["StartedAt"],
            error="DEV service exited before readiness: frontend", frontend_volume="seeded-volume",
            inputs={"attempt": self.r["base_attempt"]},
            worker_cgroup={"state": "ready", "container_id": self.actual["backend"]["Id"],
                "image_id": self.actual["backend"]["Image"], "compose_project": "own",
                "boot_id": "d5db38b4-5ed2-4ad5-891d-cc70b0201ac6"})
        self.document = fixture.document
        self.document["volumes"] = {"frontend-build": {"name": "retained-volume"}}

    def test_explicit_resume_contract_and_previous_boot(self):
        recovery.validate_request(self.r)
        recovery.validate_original(self.original, self.document, self.r, self.control, self.source)
        for service, actual in self.actual.items():
            recovery.validate_container(actual, self.r["containers"][service], service, "own", interrupted_resume=True)
        with self.assertRaises(BuildControlError):
            recovery.validate_container(self.actual["frontend"], self.r["containers"]["frontend"], "frontend", "own")

    def test_missing_extra_and_malformed_request_pins_are_rejected(self):
        for key in self.r:
            changed = copy.deepcopy(self.r); changed.pop(key)
            with self.subTest(missing=key), self.assertRaises(BuildControlError): recovery.validate_request(changed)
        for key, value in (("extra", True), ("base_attempt", self.r["attempt"]), ("host_boot_id", "0" * 36), ("source_revision", "invalid")):
            changed = copy.deepcopy(self.r); changed[key] = value
            with self.subTest(key=key), self.assertRaises(BuildControlError): recovery.validate_request(changed)
        for key in self.r["failure"]:
            changed = copy.deepcopy(self.r); changed["failure"][key] = "invalid"
            with self.subTest(failure=key), self.assertRaises(BuildControlError): recovery.validate_request(changed)
        changed = copy.deepcopy(self.r); changed["schema"] = recovery.SCHEMA
        with self.assertRaises(BuildControlError): recovery.validate_request(changed)

    def test_original_namespace_ownership_and_startup_solve_are_fenced(self):
        for key, value in (("state", "succeeded"), ("phase", "development"), ("compose_project", "foreign"),
                ("control_volume", "foreign"), ("helper_container", "foreign"), ("backend_started_at", None),
                ("error", "different failure")):
            changed = copy.deepcopy(self.original); changed[key] = value
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                recovery.validate_original(changed, self.document, self.r, self.control, self.source)
        for key, value in (("boot_id", self.r["host_boot_id"]), ("container_id", "0" * 64), ("image_id", "other"), ("state", "unknown")):
            changed = copy.deepcopy(self.original); changed["worker_cgroup"][key] = value
            with self.subTest(worker=key), self.assertRaises(BuildControlError):
                recovery.validate_original(changed, self.document, self.r, self.control, self.source)
        changed = copy.deepcopy(self.document)
        changed["services"]["backend"]["environment"]["FULLMAG_STARTUP_ENABLED"] = "1"
        with self.assertRaises(BuildControlError): recovery.validate_original(self.original, changed, self.r, self.control, self.source)

    def test_live_oom_restarted_and_changed_service_states_are_rejected(self):
        for service in ("backend", "frontend"):
            for key, value in (("Running", True), ("Paused", True), ("Restarting", True), ("Dead", True),
                    ("OOMKilled", True), ("Pid", 99), ("Status", "running"), ("ExitCode", 0), ("Error", "unknown")):
                actual = copy.deepcopy(self.actual[service]); actual["State"][key] = value
                pin = copy.deepcopy(self.r["containers"][service]); pin["state_sha256"] = digest(canonical(actual["State"]))
                with self.subTest(service=service, key=key), self.assertRaises(BuildControlError):
                    recovery.validate_container(actual, pin, service, "own", interrupted_resume=True)
            actual = copy.deepcopy(self.actual[service]); actual["State"]["StartedAt"] = "new namespace"
            with self.assertRaises(BuildControlError):
                recovery.validate_container(actual, self.r["containers"][service], service, "own", interrupted_resume=True)

    def test_failed_operation_never_claims_native_recovery_or_build_completion(self):
        raw = canonical(self.original)
        result = recovery.failure_result(raw, self.document, self.r, "a" * 64)
        self.assertEqual(result, recovery.failure_result(raw, self.document, self.r, "a" * 64))
        value = json.loads(result)
        self.assertEqual(value["state"], "failed-confirmed")
        self.assertEqual(value["phase"], "resume")
        self.assertEqual(value["build_data_qualification"], "NOT VERIFIED")
        evidence = value["reconciliation"]
        self.assertFalse(evidence["native_state_changed"])
        self.assertFalse(evidence["solve_replayed"])
        self.assertTrue(evidence["native_runtime_recovery_required"])
        self.assertIsNone(evidence["service_exit_codes"])
        self.assertIsNone(evidence["producer_exit_code"])
        self.assertNotIn("exit_code", value)
        self.assertEqual(evidence["retained_publication"], self.r["failure"])
        self.assertEqual(value["frontend_volume"], "retained-volume")
        self.assertEqual(evidence["seeded_frontend_volume"], "seeded-volume")

    def test_prior_boot_storage_observation_never_rotates_or_admits_certificate(self):
        import docker_volume_dev as dev
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            certificate_path = state/"certificate.json"
            owner_path = state/"owner.json"
            inode = state.stat().st_ino
            certificate = {"schema": "host.v1", "storage_profile": "linux-native-v1", "host_inode": inode,
                "host_device": 2096, "engine_id": "pinned-engine", "host_root": str(state), "host_filesystem": "ext4"}
            raw = canonical(certificate)
            certificate_path.write_bytes(raw); owner_path.write_bytes(raw)
            request = copy.deepcopy(self.r)
            request["storage_certificate_sha256"] = digest(raw)
            request["storage_identity"]["root_inode"] = inode
            document = copy.deepcopy(self.document)
            document["services"]["backend"]["environment"]["FULLMAG_SESSION_STORAGE_PROFILE"] = "linux-native-v1"
            host = types.SimpleNamespace(HOST_SCHEMA="host.v1", OWNER_NAME="owner.json", read_owned_regular=lambda path: Path(path).read_bytes())
            current = {"host_root": str(state), "host_filesystem": "ext4", "host_device": 2128}
            with patch.object(dev, "_session_host", return_value=host), patch.object(dev, "_certificate_path", return_value=certificate_path), \
                    patch.object(dev, "local_volume", return_value=current), patch.object(dev, "docker_text", return_value="pinned-engine"):
                observed = recovery._interrupted_resume_certificate(state, document, request)
                self.assertEqual(observed, certificate)
                self.assertEqual(certificate_path.read_bytes(), raw)
                self.assertEqual(owner_path.read_bytes(), raw)
                # The ordinary admission gate must continue to refuse the stale device.
                with self.assertRaises(BuildControlError): dev._retained_certificate(state, document)
                for key, value in (("host_filesystem", "cifs"), ("host_root", "/foreign"), ("host_device", 999)):
                    changed = {**current, key: value}
                    with self.subTest(key=key), patch.object(dev, "local_volume", return_value=changed):
                        with self.assertRaises(BuildControlError): recovery._interrupted_resume_certificate(state, document, request)
                changed = copy.deepcopy(request); changed["storage_identity"]["root_inode"] += 1
                with self.assertRaises(BuildControlError): recovery._interrupted_resume_certificate(state, document, changed)
                owner_path.write_bytes(canonical({**certificate, "host_device": 999}))
                with self.assertRaises(BuildControlError): recovery._interrupted_resume_certificate(state, document, request)

    def package_tar(self, value, *, symbolic=False):
        raw = canonical(value)
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as archive:
            member = tarfile.TarInfo("document.json")
            if symbolic:
                member.type = tarfile.SYMTYPE; member.linkname = "outside"
            else: member.size = len(raw)
            archive.addfile(member, None if symbolic else io.BytesIO(raw))
        return stream.getvalue(), raw

    def test_stopped_package_documents_bind_actual_image_and_receipt(self):
        receipt = {"state": "succeeded"}
        receipt_tar, raw = self.package_tar(receipt)
        provenance = {"state": "succeeded", "build_receipt_sha256": digest(raw), "image_id": self.actual["backend"]["Image"]}
        provenance_tar, provenance_raw = self.package_tar(provenance)
        with patch.object(recovery, "docker_capture", side_effect=[types.SimpleNamespace(stdout=receipt_tar), types.SimpleNamespace(stdout=provenance_tar)]) as capture:
            observed = recovery._stopped_package_documents(self.actual["backend"])
        self.assertEqual(observed, {"receipt_sha256": digest(raw), "provenance_sha256": digest(provenance_raw)})
        self.assertTrue(all(call.args[0] == "cp" and call.args[-1] == "-" for call in capture.call_args_list))
        for changed in ({**provenance, "build_receipt_sha256": "0" * 64}, {**provenance, "image_id": "foreign"}):
            changed_tar, _ = self.package_tar(changed)
            with patch.object(recovery, "docker_capture", side_effect=[types.SimpleNamespace(stdout=receipt_tar), types.SimpleNamespace(stdout=changed_tar)]):
                with self.assertRaises(BuildControlError): recovery._stopped_package_documents(self.actual["backend"])
        bad_tar, _ = self.package_tar(receipt, symbolic=True)
        with patch.object(recovery, "docker_capture", return_value=types.SimpleNamespace(stdout=bad_tar)):
            with self.assertRaises(BuildControlError): recovery._stopped_package_documents(self.actual["backend"])

    def transaction_fixture(self, directory):
        root = Path(directory)
        documents = {"active": (self.r["attempt"] + "\n").encode(), "request.json": b"request", "result.json": b"result",
            recovery._compose_relative(self.r): canonical(self.document),
            "resume/attempts/" + self.r["attempt"] + "/receipt.json": b"original",
            "resume/attempts/" + self.r["attempt"] + "/unknown-receipt.json": b"original",
            "resume/current.json": b"current", "resume/verified.json": b"verified",
            "frontend/development-inputs.json": b"inputs", "backend/runtime-provenance.json": b"provenance",
            "development/attempts/" + self.r["base_attempt"] + "/terminal.json": b"previous"}
        for name in self.r["attempt_documents"]:
            documents["development/attempts/" + self.r["base_attempt"] + "/" + name] = name.encode()
        for name, data in documents.items():
            path = root/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        (root/"operation.lock").touch()
        r = copy.deepcopy(self.r)
        r.update(active_sha256=digest(documents["active"]), receipt_sha256=digest(b"original"),
            compose_sha256=digest(canonical(self.document)), current_sha256=digest(b"current"), verified_sha256=digest(b"verified"))
        r["failure"].update(inputs_sha256=digest(b"inputs"), previous_receipt_sha256=digest(b"previous"), provenance_sha256=digest(b"provenance"))
        r["attempt_documents"] = {name: digest(name.encode()) for name in r["attempt_documents"]}
        control = types.SimpleNamespace(path=lambda relative: "/control/" + relative)
        script = recovery.transaction_script(control, r, "request.json", digest(b"request"), "result.json", digest(b"result"))
        # The generated production script is executed only against this disposable fixture.
        script = script.replace("/control", str(root))
        self.assertNotEqual(str(root), "/control")
        return root, script

    def run_transaction(self, script, decision):
        return subprocess.run(["bash", "-euo", "pipefail", "-c", script], input=decision, capture_output=True, timeout=10)

    def test_transaction_preview_retains_active_and_all_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            root, script = self.transaction_fixture(directory)
            before = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            result = self.run_transaction(script, b"")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b"READY\n")
            self.assertEqual(before, {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()})

    def test_transaction_publishes_only_resume_failure_and_preserves_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            root, script = self.transaction_fixture(directory)
            result = self.run_transaction(script, b"APPLY\n")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b"READY\nCOMMITTED\n")
            self.assertFalse((root/"active").exists())
            self.assertEqual((root/"resume/verified.json").read_bytes(), b"verified")
            self.assertEqual((root/"resume/current.json").read_bytes(), b"result")
            self.assertEqual((root/"resume/attempts"/self.r["attempt"]/"unknown-receipt.json").read_bytes(), b"original")
            self.assertEqual((root/"development/attempts"/self.r["base_attempt"]/"terminal.json").read_bytes(), b"previous")

    def test_transaction_partial_publication_is_replayable(self):
        with tempfile.TemporaryDirectory() as directory:
            root, script = self.transaction_fixture(directory)
            (root/"resume/attempts"/self.r["attempt"]/"receipt.json").write_bytes(b"result")
            result = self.run_transaction(script, b"APPLY\n")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((root/"active").exists())

    def test_transaction_changed_inputs_and_busy_lock_fail_closed(self):
        for target in ("active", "frontend/development-inputs.json", "backend/runtime-provenance.json", "resume/verified.json", "request.json"):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                root, script = self.transaction_fixture(directory)
                (root/target).write_bytes(b"changed")
                result = self.run_transaction(script, b"APPLY\n")
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue((root/"active").exists())
                self.assertFalse((root/"resume/attempts"/self.r["attempt"]/"terminal.json").exists())
        with tempfile.TemporaryDirectory() as directory:
            root, script = self.transaction_fixture(directory)
            with (root/"operation.lock").open("rb") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = self.run_transaction(script, b"APPLY\n")
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue((root/"active").exists())


if __name__ == "__main__":
    unittest.main()
