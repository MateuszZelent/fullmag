"""Pure retained-authority checks for failed frontend seed completion."""
import copy
import hashlib
from pathlib import Path
import sys
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_frontend_seed_completion as completion
from docker_build_control import BuildControlError, canonical
import docker_group_storage as group_storage
import docker_volume_frontend_seed_recovery as seed_recovery


class FrontendSeedCompletionTests(unittest.TestCase):
    def setUp(self):
        self.attempt = "a" * 32
        self.base_attempt = "b" * 32
        self.base_config = "c" * 64
        self.control = types.SimpleNamespace(
            project="own-group", volume="fullmag-worktree-own-control", namespace="",
            subpath=lambda relative="": relative,
        )
        self.old_generation = "d" * 32
        self.old_generation_path = group_storage.frontend_generation_subpath(
            self.control, self.old_generation)
        self.generation_path = group_storage.frontend_generation_subpath(
            self.control, self.attempt)
        self.backend_commit = "1" * 40
        self.input_commit = "2" * 40
        self.controller_commit = "3" * 40
        self.source_pins = {
            "backend_app_commit": self.backend_commit,
            "input_manifest_commit": self.input_commit,
            "controller_commit": self.controller_commit,
            "seed_files_sha256": "4" * 64,
            "next_env_sha256": "5" * 64,
            "backend_receipt_sha256": "6" * 64,
            "backend_provenance_sha256": "7" * 64,
            "backend_binary_sha256": "8" * 64,
            "backend_container_id": "9" * 64,
            "backend_started_at": "2026-11-13T00:48:26.626490875Z",
        }
        self.failed_generation_probe = {
            "mode": "created", "generation_id": self.attempt,
            "old_generation_id": self.old_generation,
            "old_seed_sha256": hashlib.sha256(b"").hexdigest(),
            "inputs_freeze_absent": True, "frozen_root_absent": True,
        }
        self.previous = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "development",
            "state": "failed-confirmed", "attempt": self.base_attempt,
            "compose_project": self.control.project, "control_volume": self.control.volume,
            "config_sha256": self.base_config,
            "error": "DEV service exited before readiness: frontend",
            "frontend_container": "f" * 64,
            "private_group_storage": "group-volume-v1", "frontend_volume": self.control.volume,
            "frontend_generation_id": self.old_generation,
            "frontend_generation_subpath": self.old_generation_path,
        }
        self.backend_service = {"image": "sha256:" + "a" * 64,
            "environment": {"FULLMAG_SOURCE_COMMIT": self.backend_commit},
            "volumes": [{"type": "bind", "source": "/selected", "target": "/opt/fullmag/source",
                         "read_only": True}]}
        self.rollback = self.compose(self.old_generation_path, self.input_commit)
        self.document = self.compose(self.generation_path, self.controller_commit)
        self.original = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "development",
            "state": "outcome-unknown-resources-retained", "attempt": self.attempt,
            "compose_project": self.control.project, "control_volume": self.control.volume,
            "error": "Recreated frontend source bind identity could not be proven",
            "private_group_storage": "group-volume-v1", "frontend_volume": self.control.volume,
            "frontend_generation_id": self.attempt,
            "frontend_generation_subpath": self.generation_path,
            "frontend_generation_probe": copy.deepcopy(self.failed_generation_probe),
            "inputs": {
                "native_build_requested": False,
                "frontend_refresh_from_attempt": self.base_attempt,
                "frontend_refresh_from_config_sha256": self.base_config,
                "failed_seed_new_generation": self.mode(),
            },
        }

    def compose(self, generation_path, frontend_commit):
        backend = copy.deepcopy(self.backend_service)
        return {
            "name": self.control.project,
            "services": {
                "backend": backend,
                "frontend": {
                    "environment": {"FULLMAG_SOURCE_COMMIT": frontend_commit},
                    "volumes": [{"type": "volume", "source": "frontend-build",
                        "target": "/state/development", "volume": {"nocopy": True,
                            "subpath": generation_path}}],
                },
            },
            "volumes": {"frontend-build": {"name": self.control.volume, "external": True}},
        }

    def mode(self):
        return {
            "schema": seed_recovery.SCHEMA,
            "failed_attempt": self.base_attempt,
            "failed_config_sha256": self.base_config,
            "source_pins": copy.deepcopy(self.source_pins),
            "prior_terminal_sha256": hashlib.sha256(canonical(self.previous) + b"\n").hexdigest(),
            "prior_input_manifest_sha256": "e" * 64,
        }

    def baseline(self):
        return {
            "id": "1d3311194d380f36fc8875ec3195ee8fcddb9e385bcd906c4d0c4ef4c4365ad7",
            "image": "sha256:" + "b" * 64,
            "pid": 95710,
            "started_at": "2026-11-13T00:48:26.626490875Z",
            "restart_count": 0,
            "state": "running",
            "health": "healthy",
            "api_observation": {
                "active_session": False,
                "api_instance_id": "232a9161-f138-4dbe-b95c-f5deff875ef8",
                "processes": [
                    {"executable": "/opt/fullmag/package/bin/fullmag-api",
                     "pid": 19080, "start_ticks": "19517880"},
                    {"executable": "/opt/fullmag/package/bin/fullmag-runtime-service",
                     "pid": 19092, "start_ticks": "19517944"},
                    {"executable": "/opt/fullmag/package/bin/fullmag-api-accepted-scheduler",
                     "pid": 19101, "start_ticks": "19518015"},
                    {"executable": "/opt/fullmag/package/bin/fullmag-api-accepted-fem-preparation-scheduler",
                     "pid": 19102, "start_ticks": "19518015"},
                ],
                "run_id": None, "scene_revision": None, "session": None,
            },
        }

    def actual_backend(self):
        baseline = self.baseline()
        return {
            "Id": baseline["id"], "Image": baseline["image"],
            "RestartCount": baseline["restart_count"],
            "State": {"Pid": baseline["pid"], "StartedAt": baseline["started_at"],
                "Status": baseline["state"], "Running": True,
                "Health": {"Status": baseline["health"]}},
        }

    def test_seed_mode_is_explicit_and_malformed_present_marker_is_rejected(self):
        self.assertFalse(completion.is_seed_completion({"inputs": {}}))
        self.assertTrue(completion.is_seed_completion(self.original))
        for mode in (None, "bad", {"schema": "foreign"},
                     {**self.mode(), "unexpected": True},
                     {key: value for key, value in self.mode().items() if key != "source_pins"}):
            changed = copy.deepcopy(self.original)
            changed["inputs"]["failed_seed_new_generation"] = mode
            with self.subTest(mode=mode), self.assertRaises(BuildControlError):
                completion.is_seed_completion(changed)

    def test_baseline_relative_is_exactly_scoped_to_one_attempt(self):
        self.assertEqual(completion.baseline_relative(self.attempt),
            "verification/frontend-seed-completion/" + self.attempt + "/operator-backend-baseline.json")
        with self.assertRaises(BuildControlError):
            completion.baseline_relative("../" + self.attempt)

    def test_capture_and_record_match_operator_backend_baseline_shape(self):
        baseline = completion.capture_baseline(self.actual_backend(), self.baseline()["api_observation"])
        self.assertEqual(baseline, self.baseline())
        record = completion.baseline_record(
            self.attempt, self.base_attempt, baseline, "operator-pinned-prior-observation")
        self.assertEqual(set(record), {"schema", "attempt", "base_attempt", "kind", "baseline", "baseline_sha256"})
        self.assertEqual(record["schema"], completion.SCHEMA)
        self.assertEqual(record["baseline_sha256"], hashlib.sha256(canonical(baseline)).hexdigest())
        self.assertEqual(completion.validate_baseline(
            record, self.attempt, self.base_attempt, self.actual_backend(), baseline["api_observation"]), baseline)

    def test_baseline_requires_exact_healthy_backend_and_stable_idle_api_processes(self):
        actual = self.actual_backend()
        observation = self.baseline()["api_observation"]
        invalid_actuals = []
        wrong_pid = copy.deepcopy(actual); wrong_pid["State"]["Pid"] = 0
        invalid_actuals.append(wrong_pid)
        wrong_state = copy.deepcopy(actual); wrong_state["State"]["Running"] = False
        invalid_actuals.append(wrong_state)
        wrong_health = copy.deepcopy(actual); wrong_health["State"]["Health"]["Status"] = "starting"
        invalid_actuals.append(wrong_health)
        wrong_restart = copy.deepcopy(actual); wrong_restart["RestartCount"] = 1
        invalid_actuals.append(wrong_restart)
        for changed in invalid_actuals:
            with self.subTest(actual=changed), self.assertRaises(BuildControlError):
                completion.capture_baseline(changed, observation)
        for field, value in (("active_session", True), ("session", {"id": "active"}),
                             ("run_id", "run-1"), ("scene_revision", 1)):
            changed = copy.deepcopy(observation); changed[field] = value
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                completion.capture_baseline(actual, changed)
        duplicate_api = copy.deepcopy(observation)
        duplicate_api["processes"].append(copy.deepcopy(duplicate_api["processes"][0]))
        with self.assertRaises(BuildControlError):
            completion.capture_baseline(actual, duplicate_api)

    def test_baseline_validation_rejects_missing_drift_foreign_pid_and_bad_hash(self):
        baseline = self.baseline()
        record = completion.baseline_record(
            self.attempt, self.base_attempt, baseline, "captured-under-lease")
        with self.assertRaises(BuildControlError):
            completion.validate_baseline(None, self.attempt, self.base_attempt,
                self.actual_backend(), baseline["api_observation"])
        changed_actual = self.actual_backend(); changed_actual["Id"] = "f" * 64
        with self.assertRaises(BuildControlError):
            completion.validate_baseline(record, self.attempt, self.base_attempt,
                changed_actual, baseline["api_observation"])
        foreign_pid = copy.deepcopy(record)
        foreign_pid["baseline"]["pid"] += 1
        foreign_pid["baseline_sha256"] = hashlib.sha256(canonical(foreign_pid["baseline"])).hexdigest()
        with self.assertRaises(BuildControlError):
            completion.validate_baseline(foreign_pid, self.attempt, self.base_attempt,
                self.actual_backend(), baseline["api_observation"])
        bad_hash = copy.deepcopy(record); bad_hash["baseline_sha256"] = "0" * 64
        with self.assertRaises(BuildControlError):
            completion.validate_baseline(bad_hash, self.attempt, self.base_attempt,
                self.actual_backend(), baseline["api_observation"])
        for kind in ("operator-pinned-prior-observation", "captured-under-lease"):
            self.assertEqual(completion.baseline_record(
                self.attempt, self.base_attempt, baseline, kind)["kind"], kind)
        for kind in ("untrusted-fallback", None, []):
            with self.subTest(kind=kind), self.assertRaises(BuildControlError):
                completion.baseline_record(self.attempt, self.base_attempt, baseline, kind)

    def test_authority_accepts_exact_seed_refusal_and_preserves_commit_roles(self):
        pins = completion.validate_seed_authority(
            self.original, self.previous, self.rollback, self.document, self.control,
            self.attempt, self.base_attempt)
        self.assertEqual(pins, self.source_pins)
        self.assertNotEqual(pins["backend_app_commit"], pins["input_manifest_commit"])
        self.assertNotEqual(pins["input_manifest_commit"], pins["controller_commit"])

    def test_authority_rejects_unknown_flags_terminal_drift_and_failed_lineage_drift(self):
        cases = []
        changed = copy.deepcopy(self.original); changed["error"] = "some other error"; cases.append((changed, self.previous, self.rollback, self.document))
        changed = copy.deepcopy(self.original); changed["inputs"]["native_build_requested"] = True; cases.append((changed, self.previous, self.rollback, self.document))
        changed = copy.deepcopy(self.original); changed["inputs"]["frontend_refresh_from_attempt"] = "f" * 32; cases.append((changed, self.previous, self.rollback, self.document))
        changed = copy.deepcopy(self.original); changed["inputs"]["failed_seed_new_generation"]["prior_terminal_sha256"] = "0" * 64; cases.append((changed, self.previous, self.rollback, self.document))
        changed = copy.deepcopy(self.previous); changed["state"] = "succeeded"; cases.append((self.original, changed, self.rollback, self.document))
        changed = copy.deepcopy(self.previous); changed["error"] = "DEV service exited before readiness: backend"; cases.append((self.original, changed, self.rollback, self.document))
        for original, previous, rollback, document in cases:
            with self.subTest(original=original, previous=previous), self.assertRaises(BuildControlError):
                completion.validate_seed_authority(
                    original, previous, rollback, document, self.control,
                    self.attempt, self.base_attempt)

    def test_authority_rejects_generation_path_probe_backend_or_package_pin_drift(self):
        cases = []
        changed = copy.deepcopy(self.original); changed["frontend_generation_id"] = self.base_attempt; cases.append((changed, self.previous, self.rollback, self.document))
        changed = copy.deepcopy(self.original); changed["frontend_generation_subpath"] = "private/frontend/other"; cases.append((changed, self.previous, self.rollback, self.document))
        changed = copy.deepcopy(self.original); changed["frontend_generation_probe"]["old_seed_sha256"] = "0" * 64; cases.append((changed, self.previous, self.rollback, self.document))
        changed = copy.deepcopy(self.original); changed["inputs"]["failed_seed_new_generation"]["source_pins"]["backend_receipt_sha256"] = "invalid"; cases.append((changed, self.previous, self.rollback, self.document))
        changed = copy.deepcopy(self.original); del changed["inputs"]["failed_seed_new_generation"]["source_pins"]["backend_provenance_sha256"]; cases.append((changed, self.previous, self.rollback, self.document))
        changed = copy.deepcopy(self.original); changed["inputs"]["failed_seed_new_generation"]["source_pins"]["unexpected"] = "pin"; cases.append((changed, self.previous, self.rollback, self.document))
        changed = copy.deepcopy(self.document); changed["services"]["backend"]["image"] = "sha256:" + "0" * 64; cases.append((self.original, self.previous, self.rollback, changed))
        changed_rollback = copy.deepcopy(self.rollback); changed_rollback["services"]["backend"]["image"] = "sha256:" + "0" * 64
        cases.append((self.original, self.previous, changed_rollback, self.document))
        for original, previous, rollback, document in cases:
            with self.subTest(original=original, document=document), self.assertRaises(BuildControlError):
                completion.validate_seed_authority(
                    original, previous, rollback, document, self.control,
                    self.attempt, self.base_attempt)


if __name__ == "__main__":
    unittest.main()
