"""Regression checks for a pre-PID1 OCI certificate bind refusal."""
import copy
import hashlib
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_volume_reconcile as reconcile
import docker_volume_resume_mount_refusal as refusal
from docker_build_control import BuildControlError, canonical


class ResumeMountRefusalTests(unittest.TestCase):
    def setUp(self):
        self.source = Path(__file__).resolve().parent.parent
        self.token, self.parent = "a" * 32, "b" * 32
        self.project, self.volume = "fullmag-test", "control-test"
        self.error = (
            "OCI runtime create failed: container init failed: error during container init: "
            "error mounting \"/run/desktop/mnt/host/wsl/old/linux-native-host.json\" to "
            "rootfs at \"/run/fullmag/linux-native-host.json\": not a directory"
        )
        self.actual = {}
        for name, char, code, finished in (
            ("backend", "c", 127, "2026-11-16T20:15:33.70371619Z"),
            ("frontend", "d", 255, "2026-11-16T20:15:33.703690115Z"),
            ("lease", "e", 0, "0001-01-01T00:00:00Z"),
        ):
            state = {"Status": "exited", "Running": False, "Pid": 0, "ExitCode": code,
                "OOMKilled": False, "Dead": False, "Restarting": False, "Paused": False,
                "Error": self.error if name == "backend" else "",
                "StartedAt": "2026-11-16T11:28:41.805481932Z" if name != "frontend"
                    else "2026-11-16T11:28:42.396691227Z", "FinishedAt": finished}
            self.actual[name] = {"Id": char * 64, "Image": "sha256:" + "f" * 64,
                "Config": {"Labels": {"com.docker.compose.project": self.project,
                    "com.docker.compose.service": "build-control" if name == "lease" else name}},
                "HostConfig": {}, "Mounts": [], "State": state}
        self.original = {"schema": "fullmag.docker-build-operation.v1", "phase": "resume",
            "state": "outcome-unknown-resources-retained", "attempt": self.token,
            "compose_project": self.project, "control_volume": self.volume,
            "error": self.error, "started_at": 1794881636.1281102,
            "inputs": {"attempt": self.parent, "config_sha256": "1" * 64,
                "source_root": str(self.source), "image_id": "sha256:" + "f" * 64},
            "helper_container": "fullmag-control-" + self.token}
        for name in ("backend", "frontend"):
            self.original[name + "_container"] = self.actual[name]["Id"]
            self.original[name + "_started_at"] = self.actual[name]["State"]["StartedAt"]
        self.parent_request = self.parent_request_value()
        self.parent_request_raw = canonical(self.parent_request) + b"\n"
        self.parent_request_sha = refusal.digest(self.parent_request_raw)
        self.parent_terminal = {"schema": "fullmag.docker-build-operation.v1", "phase": "development",
            "state": "failed-confirmed", "attempt": self.parent, "compose_project": self.project,
            "control_volume": self.volume, "error": "Development interrupted before package handoff; producer exit status unavailable",
            "backend_container": self.actual["backend"]["Id"], "frontend_container": self.actual["frontend"]["Id"],
            "reconciliation": {"schema": "fullmag.docker-development-interrupted.v1",
                "request_sha256": self.parent_request_sha,
                "original_receipt_sha256": self.parent_request["receipt_sha256"]}}
        self.parent_terminal_raw = canonical(self.parent_terminal) + b"\n"
        self.document = {"name": self.project, "services": {"backend": {"image": "sha256:" + "f" * 64,
                "environment": {"FULLMAG_SESSION_STORAGE_PROFILE": "linux-native-v1", "FULLMAG_STARTUP_ENABLED": "0"},
                "volumes": [{"type": "bind", "source": "/state/linux-native-host.json",
                    "target": "/run/fullmag/linux-native-host.json", "read_only": True}]},
            "frontend": {"image": "sha256:" + "f" * 64, "ports": [{"published": 3350, "host_ip": "127.0.0.1"}]}}}
        self.original["inputs"]["config_sha256"] = refusal.digest(canonical(self.document))
        self.original.update(state_root="/state", backend_volumes={"build": "build-test",
            "package": "package-test", "control": self.volume}, frontend_volume="frontend-test")
        self.parent_request["receipt_sha256"] = refusal.digest(b"parent unknown")
        self.parent_request["compose_sha256"] = refusal.digest(canonical(self.document))
        self.parent_request["backend_log_sha256"] = refusal.digest(b"backend log before package handoff\n")
        self.parent_request_raw = canonical(self.parent_request) + b"\n"
        self.parent_request_sha = refusal.digest(self.parent_request_raw)
        self.parent_terminal["config_sha256"] = refusal.digest(canonical(self.document))
        self.parent_terminal.update(state_root=self.original["state_root"],
            backend_volumes=self.original["backend_volumes"], frontend_volume=self.original["frontend_volume"])
        self.parent_terminal["reconciliation"].update(request_sha256=self.parent_request_sha,
            original_receipt_sha256=self.parent_request["receipt_sha256"])
        self.parent_terminal_raw = canonical(self.parent_terminal) + b"\n"
        self.failure = self.failure_value()
        self.request = self.request_value()

    def parent_request_value(self):
        return {"schema": "fullmag.docker-development-interrupted.v1", "attempt": self.parent,
            "source_root": str(self.source), "source_revision": "a" * 40,
            "compose_project": self.project, "engine_id": "engine", "observed_at": 1794800000.0,
            "receipt_sha256": "2" * 64, "compose_sha256": "3" * 64,
            "active_sha256": "4" * 64, "current_sha256": None, "verified_sha256": None,
            "helper_absence_sha256": "5" * 64, "backend_log_sha256": "6" * 64,
            "containers": {name: {"id": self.actual[name]["Id"], "image": self.actual[name]["Image"],
                "fingerprint": reconcile.fingerprint(self.actual[name]), "state_sha256": "7" * 64}
                for name in ("backend", "frontend")},
            "controller_inputs": {name: "8" * 64 for name in (
                "docker_build_control.py", "docker_volume_dev.py", "docker_volume_reconcile.py",
                "docker_volume_activation_reconcile.py", "docker_volume_toolchain_reconcile.py",
                "docker_volume_prestart_recovery.py")},
            "controller_sha256": "9" * 64,
            "attempt_documents": {name: "a" * 64 for name in ("backend-cache.json", "group-ledger.json",
                "frontend-seed.json", "cache-maintenance-compose.json")},
            "storage_certificate_sha256": "b" * 64}

    def failure_value(self):
        return {"error": self.error, "error_sha256": refusal.digest(self.error.encode()),
            "parent": {"attempt": self.parent, "request_path": refusal.parent_request_path(
                self.parent, self.parent_request_sha), "request_sha256": self.parent_request_sha,
                "receipt_sha256": self.parent_request["receipt_sha256"],
                "terminal_sha256": refusal.digest(self.parent_terminal_raw),
                "compose_sha256": self.parent_request["compose_sha256"],
                "config_sha256": refusal.digest(canonical(self.document)), "source_root": str(self.source),
                "compose_project": self.project, "control_volume": self.volume,
                "image_id": "sha256:" + "f" * 64,
                "controller_sha256": self.parent_request["controller_sha256"],
                "controller_inputs_sha256": refusal.digest(canonical(self.parent_request["controller_inputs"]))},
            "certificate": {"path": "/state/linux-native-host.json", "sha256": "c" * 64,
                "inode": 20, "device": 2144},
            "compose_sha256": "d" * 64, "private_owner_sha256": "e" * 64,
            "frontend_inputs_sha256": "1" * 64, "frontend_seed_sha256": "4" * 64,
            "helper_log_sha256": "2" * 64,
            "service_states": {name: refusal.digest(canonical(self.actual[name]["State"]))
                for name in ("backend", "frontend")}, "engine_id": "engine",
            "current_sha256": None, "verified_sha256": None,
            "active_sha256": refusal.digest((self.token + "\n").encode()),
            "absent_control_files": {path: None for path in refusal.ABSENT_CONTROL_FILES},
            "absent_attempt_files": {path: None for path in refusal.ABSENT_ATTEMPT_FILES},
            "state_files": {path: "3" * 64 for path in refusal.STATE_FILES},
            "controllers": {name: refusal.digest((self.source / "scripts" / name).read_bytes())
                for name in refusal.CONTROLLERS}}

    def request_value(self):
        raw = canonical(self.original) + b"\n"
        return {"schema": refusal.SCHEMA, "attempt": self.token,
            "compose_project": self.project, "source_root": str(self.source), "port": 3350,
            "config_sha256": refusal.digest(canonical(self.document)), "unknown_receipt_sha256": refusal.digest(raw),
            "controller_sha256": refusal.digest((self.source / "scripts/docker_volume_reconcile.py").read_bytes()),
            "containers": {name: {"id": value["Id"], "image": value["Image"],
                "started_at": value["State"]["StartedAt"], "fingerprint": reconcile.fingerprint(value)}
                for name, value in self.actual.items()}, "failure": self.failure}

    def test_exact_oci_certificate_mount_refusal_qualifies(self):
        refusal.validate_mount_error(self.error)
        refusal.validate_original(self.original, self.actual)
        refusal.validate_shape(self.request)
        reconcile.validate_request(self.request)

    def test_wrong_mount_target_and_other_oci_errors_refuse(self):
        for value in (self.error.replace("/run/fullmag/linux-native-host.json", "/run/fullmag/other.json"),
                      self.error.replace('rootfs at "/run/fullmag/linux-native-host.json"',
                          'rootfs at "/run/fullmag/other.json" (certificate /run/fullmag/linux-native-host.json)'),
                      self.error.replace("not a directory", "permission denied"),
                      "OCI runtime create failed: unrelated application failure"):
            with self.subTest(error=value), self.assertRaises(BuildControlError):
                refusal.validate_mount_error(value)

    def test_pid_state_incarnation_and_finish_time_drift_refuse(self):
        changes = (
            ("backend", "Running", True), ("backend", "Pid", 9), ("backend", "ExitCode", 0),
            ("backend", "StartedAt", "2026-11-17T01:00:00Z"),
            ("backend", "FinishedAt", "2026-11-17T21:00:00Z"),
            ("frontend", "FinishedAt", "2026-11-17T21:00:00Z"),
            ("frontend", "Error", "new OCI failure"),
        )
        for name, key, value in changes:
            with self.subTest(service=name, field=key):
                changed = copy.deepcopy(self.actual)
                changed[name]["State"][key] = value
                with self.assertRaises(BuildControlError):
                    refusal.validate_original(self.original, changed)

    def test_parent_must_be_exact_confirmed_pre_handoff_attempt(self):
        valid = refusal.parent_request_path(self.parent, self.parent_request_sha)
        files = {valid: self.parent_request_raw,
            "development/attempts/" + self.parent + "/terminal.json": self.parent_terminal_raw,
            "development/attempts/" + self.parent + "/unknown-receipt.json": b"parent unknown",
            "development/attempts/" + self.parent + "/compose.json": canonical(self.document)}
        control = SimpleNamespace(project=self.project, volume=self.volume,
            path=lambda name: "/control/" + name)
        with patch.object(refusal, "read_raw", side_effect=lambda _c, path, optional=False: files.get(path)):
            refusal.validate_parent(control, self.request, self.original, self.parent_terminal,
                self.document, self.source, self.parent_request_raw, self.parent_terminal_raw,
                canonical(self.document), b"parent unknown")
        for mutate in (
            lambda p: p.update(state="succeeded"),
            lambda p: p.update(error="unqualified failure"),
            lambda p: p.update(compose_project="foreign"),
            lambda p: p.update(backend_container="9" * 64),
        ):
            changed = copy.deepcopy(self.parent_terminal)
            mutate(changed)
            with self.assertRaises(BuildControlError):
                refusal.validate_parent_record(self.request, self.original, changed,
                    self.parent_request, b"parent unknown", canonical(self.document), self.document,
                    self.source, self.project, self.volume)
        for key, value in (("config_sha256", "f" * 64), ("controller_sha256", "f" * 64)):
            changed = copy.deepcopy(self.request)
            changed["failure"]["parent"][key] = value
            with self.assertRaises(BuildControlError):
                refusal.validate_parent_record(changed, self.original, self.parent_terminal,
                    self.parent_request, b"parent unknown", canonical(self.document), self.document,
                    self.source, self.project, self.volume)
        changed = copy.deepcopy(self.request)
        changed["failure"]["parent"]["terminal_sha256"] = "f" * 64
        control = SimpleNamespace(project=self.project, volume=self.volume)
        with self.assertRaises(BuildControlError):
            refusal.validate_parent(control, changed, self.original, self.parent_terminal,
                self.document, self.source, self.parent_request_raw, self.parent_terminal_raw,
                canonical(self.document), b"parent unknown")

    def test_handoff_api_runtime_provenance_and_owner_evidence_refuse(self):
        refusal.validate_parent_log(b"backend log before package handoff\n", self.parent_request)
        for logs in (b"phase=start state=handoff\n", b"phase=api state=exec\n"):
            changed = dict(self.parent_request, backend_log_sha256=refusal.digest(logs))
            with self.subTest(logs=logs), self.assertRaises(BuildControlError):
                refusal.validate_parent_log(logs, changed)
        with self.assertRaises(BuildControlError):
            refusal.validate_absence({**self.failure["absent_control_files"],
                "backend/runtime-provenance.json": "a" * 64})
        with self.assertRaises(BuildControlError):
            refusal.validate_certificate_owner(b'{"different":true}', canonical({"owner": True}))

    def test_original_helper_identity_and_state_hash_are_required(self):
        changed = copy.deepcopy(self.failure)
        changed["service_states"]["backend"] = "f" * 64
        request = {**self.request, "failure": changed}
        with self.assertRaises(BuildControlError):
            refusal.validate_service_state_pins(request, self.actual)
        with self.assertRaises(BuildControlError):
            refusal.validate_helper_identity({**self.actual["lease"], "State": {"Running": False}},
                self.actual["lease"]["Id"], self.request["containers"]["lease"])

    def test_operation_lock_must_still_be_owned_by_original_helper(self):
        control = SimpleNamespace(path=lambda name: "/control/" + name,
            helper_args=lambda command: ["docker", "exec", "helper", "bash", "-c", command])
        with patch.object(refusal, "bounded_capture", return_value=SimpleNamespace(returncode=0)) as probe:
            refusal.validate_operation_lock(control, self.token)
            self.assertIn("flock -n 8", probe.call_args.args[0][-1])
        with patch.object(refusal, "bounded_capture", return_value=SimpleNamespace(returncode=42)):
            with self.assertRaises(BuildControlError):
                refusal.validate_operation_lock(control, self.token)

    def test_live_failure_validation_checks_real_certificate_and_entire_state_whitelist(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            state.mkdir()
            store = state / "runs/docker-all/session-store/runtime-services"
            store.mkdir(parents=True)
            image_id = "sha256:" + "f" * 64
            token = "owner-token"
            sentinel = (token + ":" + image_id).encode("ascii")
            certificate = {"schema": "fullmag.linux-native-host.v1", "storage_profile": "linux-native-v1",
                "owner_token": token, "image_id": image_id,
                "restart_expected_sha256": hashlib.sha256(sentinel).hexdigest(),
                "host_inode": state.stat().st_ino, "engine_id": "engine", "host_device": state.stat().st_dev}
            cert_raw = canonical(certificate) + b"\n"
            owner_raw = cert_raw
            (state / "linux-native-host.json").write_bytes(cert_raw)
            (state / ".fullmag-linux-native-owner.json").write_bytes(owner_raw)
            (state / ".linux-native-sentinel").write_bytes(sentinel)
            self.original["state_root"] = str(state)
            self.original["inputs"].update(config_sha256=None)
            self.document["services"]["backend"]["volumes"][0]["source"] = str(state / "linux-native-host.json")
            compose_raw = canonical(self.document) + b"\n"
            self.original["inputs"]["config_sha256"] = refusal.digest(canonical(self.document))
            self.original.update(backend_volumes={"build": "build-test", "package": "package-test",
                "control": self.volume}, frontend_volume="frontend-test")
            parent_unknown = b"parent unknown"
            log_raw = b"backend log before package handoff\n"
            self.parent_request.update(receipt_sha256=refusal.digest(parent_unknown),
                compose_sha256=refusal.digest(compose_raw), backend_log_sha256=refusal.digest(log_raw),
                storage_certificate_sha256=refusal.digest(cert_raw))
            attempt_doc_bytes = {name: ("parent " + name + "\n").encode()
                for name in self.parent_request["attempt_documents"]}
            self.parent_request["attempt_documents"] = {name: refusal.digest(raw)
                for name, raw in attempt_doc_bytes.items()}
            for name in ("backend", "frontend"):
                self.parent_request["containers"][name].update(
                    fingerprint=reconcile.fingerprint(self.actual[name]),
                    state_sha256=refusal.digest(canonical(self.actual[name]["State"])))
            self.parent_request_raw = canonical(self.parent_request) + b"\n"
            self.parent_request_sha = refusal.digest(self.parent_request_raw)
            self.parent_terminal.update(state_root=str(state), backend_volumes=self.original["backend_volumes"],
                frontend_volume=self.original["frontend_volume"], config_sha256=refusal.digest(canonical(self.document)))
            self.parent_terminal["reconciliation"].update(request_sha256=self.parent_request_sha,
                original_receipt_sha256=self.parent_request["receipt_sha256"])
            self.parent_terminal_raw = canonical(self.parent_terminal) + b"\n"
            self.failure = self.failure_value()
            self.failure["parent"].update(request_path=refusal.parent_request_path(self.parent, self.parent_request_sha),
                request_sha256=self.parent_request_sha, receipt_sha256=self.parent_request["receipt_sha256"],
                terminal_sha256=refusal.digest(self.parent_terminal_raw), compose_sha256=refusal.digest(compose_raw),
                config_sha256=refusal.digest(canonical(self.document)),
                controller_sha256=self.parent_request["controller_sha256"],
                controller_inputs_sha256=refusal.digest(canonical(self.parent_request["controller_inputs"])))
            self.failure["certificate"] = {"path": str((state / "linux-native-host.json").resolve()),
                "sha256": refusal.digest(cert_raw), "inode": (state / "linux-native-host.json").stat().st_ino,
                "device": (state / "linux-native-host.json").stat().st_dev}
            self.failure["compose_sha256"] = refusal.digest(compose_raw)
            self.failure["state_files"] = refusal._state_file_pins(state)
            self.failure["service_states"] = {name: refusal.digest(canonical(self.actual[name]["State"]))
                for name in ("backend", "frontend")}
            self.failure["current_sha256"] = None
            self.failure["verified_sha256"] = None
            active = (self.token + "\n").encode()
            self.failure["active_sha256"] = refusal.digest(active)
            self.request = self.request_value()
            parent_root = "development/attempts/" + self.parent
            attempt_root = "resume/attempts/" + self.token
            owner = {"schema": "fullmag.docker-group-storage-owner.v1", "compose_project": self.project}
            group_owner_raw = canonical(owner) + b"\n"
            frontend_inputs = canonical({"source_root": str(self.source), "host_port": 3350,
                "files": [{"relative": "package.json"}]})
            frontend_seed = canonical({"state": "seeded", "files": 1})
            documents = {"active": active, parent_root + "/terminal.json": self.parent_terminal_raw,
                parent_root + "/compose.json": compose_raw,
                parent_root + "/unknown-receipt.json": parent_unknown,
                refusal.parent_request_path(self.parent, self.parent_request_sha): self.parent_request_raw,
                **{"development/attempts/" + self.parent + "/" + name: raw
                    for name, raw in attempt_doc_bytes.items()},
                "private/.owner.json": group_owner_raw, "frontend/development-inputs.json": frontend_inputs,
                attempt_root + "/frontend-seed.json": frontend_seed,
                "resume/current.json": None, "resume/verified.json": None}
            control = SimpleNamespace(project=self.project, volume=self.volume,
                path=lambda name: "/control/" + name,
                helper_args=lambda script: ["docker", "exec", "helper", "bash", "-c", script])
            actuals = copy.deepcopy(self.actual)
            actuals["lease"]["State"].update(Status="running", Running=True, Pid=1, StartedAt="2026-11-16T20:00:00Z")
            self.request["containers"]["lease"].update(started_at=actuals["lease"]["State"]["StartedAt"],
                fingerprint=reconcile.fingerprint(actuals["lease"]))
            self.request["failure"]["private_owner_sha256"] = refusal.digest(group_owner_raw)
            self.request["failure"]["frontend_inputs_sha256"] = refusal.digest(frontend_inputs)
            self.request["failure"]["frontend_seed_sha256"] = refusal.digest(frontend_seed)
            self.request["failure"]["helper_log_sha256"] = refusal.digest(b"READY\nLOGGED\n")
            self.request["failure"]["service_states"] = {name: refusal.digest(canonical(actuals[name]["State"]))
                for name in ("backend", "frontend")}
            self.request["failure"]["controllers"] = {name: refusal.digest((self.source / "scripts" / name).read_bytes())
                for name in refusal.CONTROLLERS}
            self.request["controller_sha256"] = self.request["failure"]["controllers"]["docker_volume_reconcile.py"]
            self.request["failure"]["parent"]["config_sha256"] = refusal.digest(canonical(self.document))
            self.request["failure"]["parent"]["image_id"] = image_id
            self.request["failure"]["parent"]["controller_inputs_sha256"] = refusal.digest(
                canonical(self.parent_request["controller_inputs"]))
            self.request["failure"]["parent"]["controller_sha256"] = self.parent_request["controller_sha256"]
            self.request["config_sha256"] = refusal.digest(canonical(self.document))
            self.request["unknown_receipt_sha256"] = refusal.digest(canonical(self.original) + b"\n")
            host = SimpleNamespace(HOST_CERT_PATH="/run/fullmag/linux-native-host.json",
                OWNER_NAME=".fullmag-linux-native-owner.json",
                read_owned_regular=lambda path: Path(path).read_bytes())

            def read(_control, path, optional=False):
                if path in documents:
                    return documents[path]
                if path.startswith(attempt_root + "/"):
                    return None
                if path in refusal.ABSENT_CONTROL_FILES:
                    return None
                if optional:
                    return None
                raise KeyError(path)

            def docker(*args, **kwargs):
                if args[:2] == ("info", "--format"):
                    return SimpleNamespace(stdout=b"engine\n", stderr=b"")
                if args[0] == "logs":
                    return SimpleNamespace(stdout=log_raw, stderr=b"")
                raise AssertionError(args)

            with patch.object(refusal, "read_raw", side_effect=read), \
                 patch.object(refusal, "docker_capture", side_effect=docker), \
                 patch.object(refusal, "bounded_capture", return_value=SimpleNamespace(returncode=0)), \
                 patch("docker_group_storage.owner_manifest", return_value=owner), \
                 patch("docker_volume_dev._session_host", return_value=host), \
                 patch("docker_volume_dev._retained_certificate", return_value=certificate), \
                 patch("docker_volume_dev._operator_probe_record_from_retained", return_value={"pinned": True}), \
                 patch("docker_volume_activation_reconcile._validate_helper",
                       return_value=(actuals["lease"], actuals["lease"]["Id"])), \
                 patch("docker_volume_activation_reconcile._validate_helper_logged", return_value="READY\nLOGGED\n"):
                result = refusal.validate_failure(control, attempt_root, self.request,
                    self.original, actuals, state)
                self.assertEqual(result, self.request["failure"])
                unexpected = state / "unexpected.json"
                unexpected.write_text("unexpected runtime evidence")
                with self.assertRaises(BuildControlError):
                    refusal.validate_failure(control, attempt_root, self.request,
                        self.original, actuals, state)

    def test_empty_session_store_validator_uses_existing_interruption_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "runs/docker-all/session-store/runtime-services").mkdir(parents=True)
            refusal.validate_empty_session_store(root)
            (root / "runs/docker-all/session-store/runtime-services/OWNER.json").write_text("{}")
            with self.assertRaises(BuildControlError):
                refusal.validate_empty_session_store(root)

    def test_frontend_metadata_seed_precedes_service_start_and_is_exactly_bound(self):
        inputs = {"source_root": str(self.source), "host_port": 3350,
            "files": [{"relative": "package.json"}]}
        raw = canonical({"state": "seeded", "files": 1})
        refusal.validate_frontend_seed(raw, canonical(inputs), self.request)
        for changed in ({"state": "seeded", "files": 2}, {"state": "starting", "files": 1}):
            with self.assertRaises(BuildControlError):
                refusal.validate_frontend_seed(canonical(changed), canonical(inputs), self.request)
        for key, value in (("source_root", "/foreign"), ("host_port", 3351)):
            with self.assertRaises(BuildControlError):
                refusal.validate_frontend_seed(raw, canonical({**inputs, key: value}), self.request)

    def test_partial_current_publication_replays_only_exact_prepared_terminal(self):
        request_sha = refusal.digest(canonical(self.request) + b"\n")
        result = {**self.original, "state": "failed-confirmed", "error": self.error,
            "certificate_mount_refusal_proof": self.failure,
            "reconciliation": {"request_sha256": request_sha,
                "unknown_receipt_sha256": self.request["unknown_receipt_sha256"]}}
        result_raw = canonical(result) + b"\n"
        result_sha = refusal.digest(result_raw)
        root = "resume/attempts/" + self.token
        journal = root + "/reconciliation/" + result_sha
        unknown_raw = canonical(self.original) + b"\n"
        documents = {"resume/current.json": result_raw, root + "/receipt.json": result_raw,
            root + "/terminal.json": None, root + "/unknown-receipt.json": unknown_raw,
            journal + "/prepared.json": canonical({"request_sha256": request_sha,
                "unknown_receipt_sha256": self.request["unknown_receipt_sha256"], "result_sha256": result_sha})}
        control = SimpleNamespace(read=lambda relative: json.loads(documents[relative]))
        with patch.object(refusal, "read_raw", side_effect=lambda _c, path, optional=False: documents.get(path)):
            self.assertEqual(refusal.validate_partial_current(control, root, self.request), result_raw)
        reconcile.validate_partial_journal(control, root + "/reconciliation", result_raw,
            self.request["unknown_receipt_sha256"], request_sha)
        documents[journal + "/prepared.json"] = canonical({"request_sha256": "f"*64,
            "unknown_receipt_sha256": self.request["unknown_receipt_sha256"], "result_sha256": result_sha})
        with self.assertRaises(BuildControlError):
            reconcile.validate_partial_journal(control, root + "/reconciliation", result_raw,
                self.request["unknown_receipt_sha256"], request_sha)

    def test_completed_retry_authenticates_exact_mount_refusal_proof(self):
        request_sha = refusal.digest(canonical(self.request) + b"\n")
        result = {**self.original, "state": "failed-confirmed", "error": self.error,
            "certificate_mount_refusal_proof": self.failure,
            "reconciliation": {"request_sha256": request_sha,
                "unknown_receipt_sha256": self.request["unknown_receipt_sha256"]}}
        result_raw = canonical(result) + b"\n"
        result_sha = refusal.digest(result_raw)
        root = "resume/attempts/" + self.token
        journal = root + "/reconciliation/" + result_sha
        unknown_raw = canonical(self.original) + b"\n"
        files = {root + "/terminal.json": result_raw, root + "/receipt.json": result_raw,
            root + "/unknown-receipt.json": unknown_raw, "resume/current.json": result_raw,
            "resume/verified.json": None, journal + "/result.json": result_raw,
            journal + "/prepared.json": canonical({"request_sha256": request_sha,
                "unknown_receipt_sha256": self.request["unknown_receipt_sha256"], "result_sha256": result_sha})}
        control = SimpleNamespace(project=self.project, volume=self.volume)
        with patch.object(refusal, "read_raw", side_effect=lambda _c, path, optional=False: files.get(path)), \
             patch.object(refusal, "wait_release") as release:
            self.assertTrue(refusal.completed(control, root, self.request, request_sha))
            release.assert_called_once()
            files[journal + "/result.json"] = b"changed"
            with self.assertRaises(BuildControlError):
                refusal.completed(control, root, self.request, request_sha)

    def test_builder_guard_failure_does_not_publish_and_builder_parser_is_closed(self):
        control = SimpleNamespace()
        with patch.object(refusal, "validate_failure", side_effect=BuildControlError("guard failed")), \
             patch.object(refusal, "write_immutable") as write:
            with self.assertRaisesRegex(BuildControlError, "guard failed"):
                refusal.publish_validated_request(control, self.request,
                    self.original, self.actual, Path("/state"))
            write.assert_not_called()
        with patch("sys.stderr"):
            with self.assertRaises(SystemExit):
                refusal.parser().parse_args(["--source-root", str(self.source), "--attempt", self.token,
                    "--port", "3350", "--request", "mixed-mode"])


if __name__ == "__main__":
    unittest.main()
