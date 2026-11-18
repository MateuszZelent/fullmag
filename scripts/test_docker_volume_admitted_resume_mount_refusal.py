"""Contract tests for failure-only reconciliation of an admitted resume."""
import copy
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import docker_volume_admitted_resume_mount_refusal as recovery
from docker_build_control import BuildControlError, canonical
import docker_volume_reconcile as reconcile


class AdmittedResumeMountRefusalTests(unittest.TestCase):
    def setUp(self):
        self.source = str(Path(__file__).resolve().parent.parent)
        self.attempt = "a" * 32
        self.base_attempt = "b" * 32
        self.project = "fullmag-test"
        self.volume = "control-test"
        self.config_sha256 = "1" * 64
        self.error = (
            "OCI runtime create failed: container init failed: error during container init: "
            "error mounting \"/run/desktop/mnt/host/linux-native-host.json\" to "
            "rootfs at \"/run/fullmag/linux-native-host.json\": not a directory"
        )
        self.backend_name = "/" + self.project + "-backend-1"
        self.receipt_error = "\n".join((
            " Container " + self.backend_name.lstrip("/") + " Starting ",
            " Container " + self.backend_name.lstrip("/") + " Error response from daemon: " + self.error + " ",
            "Error response from daemon: " + self.error,
        ))
        self.backend_started = "2026-11-17T07:00:00.000000000Z"
        self.frontend_started = "2026-11-17T07:00:01.000000000Z"
        self.resume_started_at = 1794902400.0
        self.backend = self._service("c", "backend", self.backend_started)
        self.frontend = self._service("d", "frontend", self.frontend_started)
        self.frontend["State"].update(Status="running", Running=True, Pid=212, ExitCode=0,
                                      FinishedAt="0001-01-01T00:00:00Z")
        self.previous = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "development",
            "state": "succeeded", "attempt": self.base_attempt,
            "compose_project": self.project, "control_volume": self.volume,
            "config_sha256": self.config_sha256, "backend_container": self.backend["Id"],
            "frontend_container": self.frontend["Id"],
            "backend_started_at": self.backend_started,
            "frontend_started_at": self.frontend_started,
            "state_root": "/state/case", "backend_volumes": {"control": self.volume},
            "frontend_volume": "frontend-test",
            "inputs": {"source_root": self.source, "image_id": self.backend["Image"]},
        }
        self.document = {
            "name": self.project,
            "services": {
                "backend": {
                    "image": self.backend["Image"],
                    "environment": {
                        "FULLMAG_SESSION_STORAGE_PROFILE": "linux-native-v1",
                        "FULLMAG_STARTUP_ENABLED": "0",
                    },
                    "volumes": [{"type": "bind", "source": "/state/case/linux-native-host.json",
                        "target": "/run/fullmag/linux-native-host.json", "read_only": True}],
                },
                "frontend": {"image": self.frontend["Image"]},
            },
        }
        self.config_sha256 = reconcile.digest(canonical(self.document))
        self.previous["config_sha256"] = self.config_sha256
        self.original = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "resume",
            "state": "outcome-unknown-resources-retained", "attempt": self.attempt,
            "compose_project": self.project, "control_volume": self.volume,
            "helper_container": "fullmag-control-" + self.attempt,
            "started_at": self.resume_started_at, "error": self.receipt_error,
            "backend_container": self.backend["Id"], "frontend_container": self.frontend["Id"],
            "backend_started_at": self.backend_started,
            "frontend_started_at": self.frontend_started,
            "state_root": self.previous["state_root"],
            "backend_volumes": copy.deepcopy(self.previous["backend_volumes"]),
            "frontend_volume": self.previous["frontend_volume"],
            "inputs": {"attempt": self.base_attempt, "source_root": self.source,
                "config_sha256": self.config_sha256, "image_id": self.backend["Image"]},
        }

    def _service(self, char, name, started_at):
        return {
            "Id": char * 64, "Name": "/" + self.project + "-" + name + "-1",
            "Image": "sha256:" + "f" * 64,
            "Config": {"Labels": {"com.docker.compose.project": self.project,
                "com.docker.compose.service": name}},
            "HostConfig": {}, "Mounts": [],
            "State": {"Status": "exited", "Running": False, "Pid": 0,
                "ExitCode": 0, "OOMKilled": False, "Dead": False,
                "Restarting": False, "Paused": False, "Error": "",
                "StartedAt": started_at, "FinishedAt": "2026-11-17T08:05:00Z"},
        }

    def test_successful_admitted_parent_with_saved_session_is_eligible(self):
        # The admitted group may have durable session/run data; this refusal only
        # terminalizes the failed resume and must not require an empty store.
        baseline = recovery.validate_admitted_parent(
            self.original, self.previous, None, self.document, self.source, self.project,
            self.volume, self.attempt, self.base_attempt, self.config_sha256,
        )
        self.assertIs(baseline, self.previous)

    def test_prior_unrelated_failed_resume_is_opaque_not_parent_authority(self):
        prior = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "resume",
            "state": "failed-confirmed", "attempt": "e" * 32,
            "state_root": "/state/unrelated-case",
            "inputs": {"attempt": "f" * 32, "source_root": "/other/source"},
        }
        baseline = recovery.validate_admitted_parent(
            self.original, self.previous, prior, self.document, self.source, self.project,
            self.volume, self.attempt, self.base_attempt, self.config_sha256,
        )
        self.assertIs(baseline, self.previous)

    def test_current_service_pins_may_follow_a_verified_idle_iteration(self):
        self.original["backend_started_at"] = "2026-11-17T13:00:52.489749645Z"
        self.original["frontend_started_at"] = "2026-11-18T03:25:44.075059817Z"
        baseline = recovery.validate_admitted_parent(
            self.original, self.previous, None, self.document, self.source, self.project,
            self.volume, self.attempt, self.base_attempt, self.config_sha256,
        )
        self.assertIs(baseline, self.previous)
        self.original["started_at"] = 1794974400.0
        self.backend["State"].update(StartedAt=self.original["backend_started_at"],
            Status="exited", Running=False, Pid=0, ExitCode=127, Error=self.error,
            FinishedAt="2026-11-18T01:40:35.883086055Z")
        self.frontend["State"].update(StartedAt=self.original["frontend_started_at"],
            Status="running", Running=True, Pid=212, FinishedAt="0001-01-01T00:00:00Z")
        recovery.validate_admitted_services(self.original,
            {"backend": self.backend, "frontend": self.frontend},
            compose_backend_name=self.backend_name)

    def test_service_state_fingerprint_ignores_transient_health_but_binds_lifecycle(self):
        state = copy.deepcopy(self.backend["State"])
        before = recovery._stable_state_fingerprint(state)
        state["Health"] = {"Status": "starting", "FailingStreak": 3}
        self.assertEqual(recovery._stable_state_fingerprint(state), before)
        state["Pid"] += 1
        self.assertNotEqual(recovery._stable_state_fingerprint(state), before)

    def test_group_inventory_accepts_only_the_validated_apply_observer(self):
        original_helper = self._service("e", "build-control", self.backend_started)
        observer = self._service("f", "build-control", self.backend_started)
        observer.update(Name="/admitted-resume-observer")
        observer["State"]["Running"] = True
        pin = {
            "container_id": observer["Id"], "container_name": "admitted-resume-observer",
            "image_id": observer["Image"], "started_at": self.backend_started,
            "fingerprint": reconcile.fingerprint(observer),
        }
        containers = [self.backend, self.frontend, original_helper, observer]
        replies = [
            SimpleNamespace(stdout="\n".join(item["Id"] for item in containers).encode()),
            SimpleNamespace(stdout=json.dumps(containers).encode()),
        ]
        control = SimpleNamespace(project=self.project)
        with mock.patch("docker_volume_activation_reconcile._validate_helper",
                        return_value=(original_helper, original_helper["Id"])), \
                mock.patch("docker_volume_activation_reconcile._validate_helper_logged"), \
                mock.patch.object(recovery, "docker_capture", side_effect=replies * 2):
            self.assertEqual(set(recovery._exact_group_services(control, self.original, pin)),
                             {"lease", "backend", "frontend"})
            with self.assertRaisesRegex(BuildControlError, "observer changed"):
                recovery._exact_group_services(control, self.original, {**pin, "started_at": self.frontend_started})

    def test_backend_oci_refusal_requires_exact_prestart_incarnation(self):
        self.backend["State"].update(Status="exited", Running=False, Pid=0, ExitCode=127,
            Error=self.error, FinishedAt="2026-11-17T07:59:00Z")
        recovery.validate_admitted_services(self.original,
            {"backend": self.backend, "frontend": self.frontend},
            compose_backend_name=self.backend_name)

        changed = copy.deepcopy(self.backend)
        changed["State"]["StartedAt"] = "2026-11-17T09:00:00Z"
        with self.assertRaises(BuildControlError):
            recovery.validate_admitted_services(self.original,
                {"backend": changed, "frontend": self.frontend},
                compose_backend_name=self.backend_name)

    def test_compose_error_envelope_must_be_exact_and_name_pinned(self):
        self.backend["State"].update(Status="exited", Running=False, Pid=0, ExitCode=127,
            Error=self.error, FinishedAt="2026-11-17T07:59:00Z")
        recovery.validate_admitted_services(self.original,
            {"backend": self.backend, "frontend": self.frontend},
            compose_backend_name=self.backend_name)
        with self.assertRaises(BuildControlError):
            recovery.validate_admitted_services(self.original,
                {"backend": self.backend, "frontend": self.frontend},
                compose_backend_name="/other-backend-1")
        self.original["error"] += "\nError response from daemon: unrelated"
        with self.assertRaises(BuildControlError):
            recovery.validate_admitted_services(self.original,
                {"backend": self.backend, "frontend": self.frontend},
                compose_backend_name=self.backend_name)

    def test_backend_must_be_absent_and_have_exact_certificate_mount_error(self):
        self.backend["State"].update(Status="exited", Running=False, Pid=0, ExitCode=127,
            Error=self.error, FinishedAt="2026-11-17T07:59:00Z")
        self.frontend["State"].update(Status="exited", Running=False, Pid=0, ExitCode=0,
            FinishedAt="2026-11-17T07:59:00Z")
        recovery.validate_admitted_services(self.original,
            {"backend": self.backend, "frontend": self.frontend},
            compose_backend_name=self.backend_name)

        for mutate in (
            lambda state: state.update(Running=True, Status="running", Pid=1),
            lambda state: state.update(ExitCode=1),
            lambda state: state.update(Error="OCI error for a different target"),
            lambda state: state.update(FinishedAt="2026-11-17T08:01:00Z"),
        ):
            changed = copy.deepcopy(self.backend)
            mutate(changed["State"])
            with self.subTest(state=changed["State"]), self.assertRaises(BuildControlError):
                recovery.validate_admitted_services(self.original,
                    {"backend": changed, "frontend": self.frontend},
                    compose_backend_name=self.backend_name)

    def test_frontend_may_remain_only_in_its_prestart_incarnation(self):
        self.backend["State"].update(Status="exited", Running=False, Pid=0, ExitCode=127,
            Error=self.error, FinishedAt="2026-11-17T07:59:00Z")
        recovery.validate_admitted_services(self.original,
            {"backend": self.backend, "frontend": self.frontend},
            compose_backend_name=self.backend_name)

        restarted = copy.deepcopy(self.frontend)
        restarted["State"]["StartedAt"] = "2026-11-17T08:10:00Z"
        with self.assertRaises(BuildControlError):
            recovery.validate_admitted_services(self.original,
                {"backend": self.backend, "frontend": restarted},
                compose_backend_name=self.backend_name)

    def test_frontend_restart_before_resume_is_allowed_when_pinned_in_original_receipt(self):
        self.backend["State"].update(Status="exited", Running=False, Pid=0, ExitCode=127,
            Error=self.error, FinishedAt="2026-11-17T07:59:00Z")
        self.original["frontend_started_at"] = "2026-11-18T03:25:44.075059817Z"
        self.frontend["State"].update(StartedAt=self.original["frontend_started_at"],
            Status="running", Running=True, Pid=212, FinishedAt="0001-01-01T00:00:00Z")
        recovery.validate_admitted_services(self.original,
            {"backend": self.backend, "frontend": self.frontend},
            compose_backend_name=self.backend_name)

    def test_failure_terminal_is_scoped_to_resume_attempt(self):
        request = {"schema": recovery.SCHEMA, "attempt": self.attempt,
            "base_attempt": self.base_attempt, "compose_project": self.project,
            "source_root": self.source, "port": 3350,
            "config_sha256": self.config_sha256, "unknown_receipt_sha256": "2" * 64,
            "controller_sha256": "3" * 64,
            "containers": {
                "backend": {"id": self.backend["Id"]},
                "frontend": {"id": self.frontend["Id"]},
            },
            "failure": {"error": self.receipt_error, "current_sha256": None,
                "verified_sha256": None}}
        result = recovery.failure_terminal(
            self.original, request, request_path="verification/request.json",
            request_sha256="4" * 64, observer_record={
                "container_id": "e" * 64, "container_name": "observer",
            },
            finished_at=1794902410.0,
        )
        self.assertEqual(result["attempt"], self.attempt)
        self.assertEqual(result["phase"], "resume")
        self.assertEqual(result["state"], "failed-confirmed")
        self.assertEqual(result["inputs"]["attempt"], self.base_attempt)
        self.assertFalse(result.get("equilibrium_verified", False))
        self.assertEqual(self.original["state"], "outcome-unknown-resources-retained")

    def test_observer_protocol_keeps_original_helper_as_active_owner(self):
        request = {"schema": recovery.SCHEMA, "attempt": self.attempt,
            "unknown_receipt_sha256": "2" * 64, "failure": {
                "current_sha256": None, "verified_sha256": None}}
        compat = recovery._commit_protocol_request(request)
        self.assertEqual(compat["schema"], reconcile.MOUNT_REFUSAL_SCHEMA)
        self.assertEqual(request["schema"], recovery.SCHEMA)
        class Control:
            namespace = ""

            @staticmethod
            def path(relative):
                return "/control/" + relative

        script = recovery.observer_script(Control(), request, "5" * 64)
        self.assertIn(f"test \"$(cat /control/active)\" = '{self.attempt}'", script)
        self.assertIn("exec 8<>/control/operation.lock", script)
        self.assertIn("terminal.json", script)
        self.assertNotIn("rm /control/active", script)


if __name__ == "__main__":
    unittest.main()
