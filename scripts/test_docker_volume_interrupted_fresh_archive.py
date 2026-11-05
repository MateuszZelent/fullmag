from __future__ import annotations

import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import docker_volume_interrupted_fresh_archive as recovery
from docker_build_control import BuildControlError, canonical, control_read_script


PRIOR = "d3434e2354454552a7f777daef505d82"
RECREATE = "bb7bfa3030c64aa1b102f4b93f3984fd"
ACTIVATION = "eddf316739494473ab70a0babeb1333c"
PROJECT = "fullmag-worktree-fullmag-a8342df1f0247d61"
BACKEND = "52aeca410cb31b3480d88807e47d99d62fdf985e00ce51ac897899f8674df3dc"
FRONTEND = "14a93e5701a946132a37144827b06795f9c11882eaa8b851ef7d8e8b8864ac6a"
IMAGE = "sha256:" + "1" * 64
CONFIG_SHA = hashlib.sha256(canonical({
    "name": PROJECT,
    "services": {"backend": {}, "frontend": {}},
})).hexdigest()
SOURCE = "/registered/fullmag/worktree"
STATE = "/retained/state/root"
UNKNOWN_SHA = "f" * 64
ENGINE = "test-engine-id"
HELPER_ID = "f0480a9b63fad31a58ea362dc268593e5bf26ef45c8164b40f57ef0777468ced"
CONTROL_VOLUME = "fullmag-build-control-test"


def fixtures():
    identity = {
        "project_name": PROJECT,
        "project_id": "fullmag-project-id",
        "worktree_id": "fullmag-a8342df1f0247d61",
        "checkout_kind": "worktree",
        "source_root": SOURCE,
    }
    compose = {"name": PROJECT, "services": {"backend": {}, "frontend": {}}}
    previous = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "development",
        "state": "succeeded",
        "attempt": PRIOR,
        "compose_project": PROJECT,
        "config_sha256": CONFIG_SHA,
        "state_root": STATE,
        "backend_container": BACKEND,
        "frontend_container": FRONTEND,
        "backend_volumes": {"cache": "retained"},
        "frontend_volume": "frontend-retained",
        "inputs": {
            "source_root": SOURCE,
            "image_id": IMAGE,
            "source_project_id": identity["project_id"],
            "source_worktree_id": identity["worktree_id"],
            "source_checkout_kind": identity["checkout_kind"],
        },
    }
    receipt = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "recreate-services",
        "state": "outcome-unknown-resources-retained",
        "attempt": RECREATE,
        "compose_project": PROJECT,
        "control_volume": CONTROL_VOLUME,
        "helper_container": "fullmag-control-" + RECREATE,
        "control_namespace": "",
        "fresh_state": True,
        "previous_state_root": STATE,
        "started_at": 1.0,
        "finished_at": 2.0,
        "error": "Archived group ledger still has a container consumer",
        "inputs": {"attempt": PRIOR, "config_sha256": CONFIG_SHA},
    }
    retained = {
        "backend": {
            "Id": BACKEND,
            "Config": {"Labels": {"com.docker.compose.project": PROJECT,
                                    "com.docker.compose.service": "backend"}},
            "State": {"Running": False, "ExitCode": 0,
                      "StartedAt": "2026-11-02T20:38:42.643427591Z"},
        },
        "frontend": {
            "Id": FRONTEND,
            "Config": {"Labels": {"com.docker.compose.project": PROJECT,
                                    "com.docker.compose.service": "frontend"}},
            # This is the pre-stop snapshot. The recovery proof does not claim
            # an exit code for this frontend generation.
            "State": {"Running": True,
                      "StartedAt": "2026-11-02T20:38:43.250562017Z"},
        },
    }
    recovery_record = {
        "schema": "fullmag.cancelled-activation-recovery.v1",
        "state": "stopped-awaiting-fresh-archive",
        "activation_attempt": ACTIVATION,
        "development_attempt": PRIOR,
        "config_sha256": CONFIG_SHA,
        "source_root": SOURCE,
        "image_id": IMAGE,
        "backend_container": BACKEND,
        "backend_started_at": "2026-11-02T20:38:42.643427591Z",
        "frontend_container": FRONTEND,
        "frontend_started_at": "2026-11-02T20:38:43.250562017Z",
        "state_root": STATE,
        "original_receipt_sha256": UNKNOWN_SHA,
        "restart_policy": "fresh-state-only",
        "execution_state": "not-started",
        "compose_project": PROJECT,
        "control_volume": CONTROL_VOLUME,
        "control_namespace": "",
        "source_sha256": "6" * 64,
        "journal_path": "verification/cancelled-activation-" + ACTIVATION + "/journal.json",
        "journal_sha256": "7" * 64,
        "request_id": "sp4_relax_fdm_gpu_observed_20261102_02",
    }
    pins = {
        "prior_attempt": PRIOR,
        "recreation_attempt": RECREATE,
        "config_sha256": CONFIG_SHA,
        "source_root": SOURCE,
        "unknown_receipt_sha256": UNKNOWN_SHA,
        "helper_container_id": HELPER_ID,
        "helper_image": "nvidia/cuda:12.6.3-devel-ubuntu22.04@sha256:" + "a" * 64,
        "engine_id": ENGINE,
    }
    return identity, compose, previous, receipt, retained, recovery_record, pins


class InterruptedFreshArchiveTests(unittest.TestCase):
    def test_record_budget_is_accepted_by_the_real_control_reader(self):
        control_read_script("/control/recreate-services/current.json", recovery.MAX_RECORD_BYTES)

    def test_activation_terminal_authenticates_exact_recovery_bytes_including_newline(self):
        from docker_volume_cancelled_activation_guard import RECORD
        _, _, _, _, _, record, pins = fixtures()
        journal_raw = b"journal\n"
        record["journal_sha256"] = hashlib.sha256(journal_raw).hexdigest()
        record_raw = canonical(record) + b"\n"
        terminal = {
            "state": "failed-confirmed",
            "activation_state": "operator-cancelled-after-confirmed-drain",
            "cancelled_recovery_sha256": hashlib.sha256(record_raw).hexdigest(),
        }
        values = {
            RECORD: record_raw,
            record["journal_path"]: journal_raw,
            "activation/attempts/" + ACTIVATION + "/terminal.json": canonical(terminal) + b"\n",
        }
        control = Mock()
        control.read_bytes.side_effect = lambda path, **kwargs: values[path]
        with patch("docker_volume_cancelled_activation_guard.read_record", return_value=record):
            observed, object_sha, journal_sha = recovery._read_recovery_evidence(control, pins)
            self.assertEqual(observed, record)
            self.assertEqual(object_sha, hashlib.sha256(canonical(record)).hexdigest())
            self.assertEqual(journal_sha, record["journal_sha256"])
            values[RECORD] = record_raw + b" "
            with self.assertRaises(BuildControlError):
                recovery._read_recovery_evidence(control, pins)

    def test_exact_fresh_unknown_and_cancelled_snapshot_qualifies(self):
        identity, compose, previous, receipt, retained, recovery_record, pins = fixtures()
        result = recovery.validate_snapshot(
            pins, receipt, previous, compose, retained, recovery_record,
            identity=identity, control_volume=CONTROL_VOLUME, namespace="",
        )
        self.assertEqual(result["removed_containers"], [BACKEND, FRONTEND])
        self.assertEqual(result["previous_state_root"], STATE)
        self.assertEqual(result["frontend_snapshot_state"], "pre-stop-running")

    def test_wrong_config_hash_and_operation_attempt_fail_closed(self):
        identity, compose, previous, receipt, retained, recovery_record, pins = fixtures()
        pins["config_sha256"] = "8" * 64
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       recovery_record, identity=identity,
                                       control_volume=CONTROL_VOLUME, namespace="")
        _, _, _, receipt, retained, recovery_record, pins = fixtures()
        receipt["attempt"] = "0" * 32
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       recovery_record, identity=identity,
                                       control_volume=CONTROL_VOLUME, namespace="")

    def test_wrong_lane_not_fresh_or_nonunknown_receipt_is_rejected(self):
        identity, compose, previous, receipt, retained, record, pins = fixtures()
        receipt["fresh_state"] = False
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       record, identity=identity, control_volume=CONTROL_VOLUME,
                                       namespace="")
        _, _, _, receipt, retained, record, pins = fixtures()
        receipt["state"] = "failed-confirmed"
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       record, identity=identity, control_volume=CONTROL_VOLUME,
                                       namespace="")

    def test_cancelled_record_must_bind_exact_stopped_backend_and_fresh_only_policy(self):
        identity, compose, previous, receipt, retained, record, pins = fixtures()
        record["backend_started_at"] = "changed-incarnation"
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       record, identity=identity, control_volume=CONTROL_VOLUME,
                                       namespace="")
        identity, compose, previous, receipt, retained, record, pins = fixtures()
        record["restart_policy"] = "resume-existing-state"
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       record, identity=identity, control_volume=CONTROL_VOLUME,
                                       namespace="")

    def test_wrong_source_control_volume_and_missing_cancellation_fence_are_rejected(self):
        identity, compose, previous, receipt, retained, record, pins = fixtures()
        record["control_volume"] = "foreign-control-volume"
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       record, identity=identity, control_volume=CONTROL_VOLUME,
                                       namespace="")
        identity, compose, previous, receipt, retained, record, pins = fixtures()
        record.pop("journal_sha256")
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       record, identity=identity, control_volume=CONTROL_VOLUME,
                                       namespace="")

    def test_original_unknown_receipt_is_bound_by_exact_raw_sha(self):
        _, _, _, receipt, _, _, pins = fixtures()
        raw = canonical(receipt) + b"\n"
        pins["unknown_receipt_sha256"] = hashlib.sha256(raw).hexdigest()
        self.assertEqual(recovery.validate_unknown_receipt(raw, pins), receipt)
        with self.assertRaises(BuildControlError):
            recovery.validate_unknown_receipt(raw + b" ", pins)

    def test_partial_receipt_cas_recovers_original_only_from_immutable_sidecar(self):
        _, _, _, receipt, _, _, pins = fixtures()
        original_raw = canonical(receipt) + b"\n"
        pins["unknown_receipt_sha256"] = hashlib.sha256(original_raw).hexdigest()
        final = {**receipt, "state": "succeeded"}
        final.pop("error")
        final_raw = canonical(final) + b"\n"
        current, original, source_raw = recovery.select_receipt_documents(
            final_raw, original_raw, pins, continuation_intent_exists=True,
        )
        self.assertEqual(current, final)
        self.assertEqual(original, receipt)
        self.assertEqual(source_raw, original_raw)
        with self.assertRaises(BuildControlError):
            recovery.select_receipt_documents(
                final_raw, original_raw, pins, continuation_intent_exists=False,
            )

    def test_backend_must_be_stopped_and_exit_zero_but_frontend_snapshot_may_be_running(self):
        identity, compose, previous, receipt, retained, record, pins = fixtures()
        retained["backend"]["State"]["ExitCode"] = 1
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       record, identity=identity, control_volume=CONTROL_VOLUME,
                                       namespace="")
        _, compose, previous, receipt, retained, record, pins = fixtures()
        retained["frontend"]["State"].pop("Running")
        recovery.validate_snapshot(pins, receipt, previous, compose, retained, record,
                                   identity=identity, control_volume=CONTROL_VOLUME,
                                   namespace="")

    def test_duplicate_json_keys_are_rejected(self):
        with self.assertRaises(BuildControlError):
            recovery.strict_object(b'{"attempt":"a","attempt":"b"}', "fixture")

    def test_plan_is_deterministic_and_binds_record_hashes_without_time(self):
        plan = recovery.make_plan({"operation": RECREATE, "current_sha256": "a" * 64,
                                   "inode_evidence": {"runtime_control_device_inode": "8:41"}})
        self.assertEqual(recovery.plan_sha256(plan), recovery.plan_sha256(dict(plan)))
        self.assertNotIn("created_at", plan)
        changed = dict(plan, operation=PRIOR)
        self.assertNotEqual(recovery.plan_sha256(plan), recovery.plan_sha256(changed))

    def test_published_or_baseline_record_state_is_allowed_but_conflict_is_not(self):
        original = b'{"state":"outcome-unknown-resources-retained"}\n'
        final = b'{"state":"succeeded"}\n'
        recovery.validate_publication_state(
            original, original, final, expected_sha256=hashlib.sha256(original).hexdigest()
        )
        recovery.validate_publication_state(final, original, final,
                                            expected_sha256=hashlib.sha256(original).hexdigest())
        with self.assertRaises(BuildControlError):
            recovery.validate_publication_state(b"foreign", original, final,
                                                expected_sha256=hashlib.sha256(original).hexdigest())

    def test_observer_uses_real_flock_and_releases_on_terminal_or_client_eof(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            attempt_root = root / "recreate-services/attempts" / RECREATE
            attempt_root.mkdir(parents=True)
            attempt_root.chmod(0o750)
            (root / "active").write_text(RECREATE, encoding="ascii")
            script = recovery.observer_script(RECREATE, str(root))
            process = subprocess.Popen(
                ["bash", "-euo", "pipefail", "-c", script], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            self.assertEqual(process.stdout.readline(), b"READY\n")
            process.stdin.write(b"LOGGED\n")
            process.stdin.flush()
            self.assertEqual(process.stdout.readline(), b"LOGGED\n")
            time.sleep(0.35)
            self.assertIsNone(process.poll(), "observer exited while its client stdin remained open")
            # Another real flock holder is excluded while the observer waits.
            contender = subprocess.run(
                ["bash", "-euo", "pipefail", "-c",
                 "exec 9>\"$1\"; flock -n 9" , "bash",
                 str(attempt_root / "interrupted-fresh-archive.lock")],
                check=False,
            )
            self.assertNotEqual(contender.returncode, 0)
            (attempt_root / "terminal.json").write_text("{}", encoding="ascii")
            self.assertEqual(process.wait(timeout=5), 0)
            process.stdin.close()
            process.stdout.close()

            (attempt_root / "terminal.json").unlink()
            process = subprocess.Popen(
                ["bash", "-euo", "pipefail", "-c", script], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            self.assertEqual(process.stdout.readline(), b"READY\n")
            process.stdin.write(b"LOGGED\n")
            process.stdin.flush()
            self.assertEqual(process.stdout.readline(), b"LOGGED\n")
            process.stdin.close()
            self.assertEqual(process.wait(timeout=5), 0)
            process.stdout.close()
            contender = subprocess.run(
                ["bash", "-euo", "pipefail", "-c",
                 "exec 9>\"$1\"; flock -n 9", "bash",
                 str(attempt_root / "interrupted-fresh-archive.lock")],
                check=False,
            )
            self.assertEqual(contender.returncode, 0)

    def test_observer_lock_refuses_symlink_and_hardlink_without_touching_target(self):
        for link_kind in ("symlink", "hardlink"):
            with self.subTest(link_kind=link_kind), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                attempt_root = root / "recreate-services/attempts" / RECREATE
                attempt_root.mkdir(parents=True)
                attempt_root.chmod(0o750)
                (root / "active").write_text(RECREATE, encoding="ascii")
                target = root / "target.bin"
                original = b"keep this unrelated receipt intact\x00\xff"
                target.write_bytes(original)
                target.chmod(0o640)
                lock = attempt_root / "interrupted-fresh-archive.lock"
                if link_kind == "symlink":
                    lock.symlink_to(target)
                else:
                    os.link(target, lock)
                process = subprocess.Popen(
                    ["bash", "-euo", "pipefail", "-c", recovery.observer_script(RECREATE, str(root))],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                )
                self.assertEqual(process.stdout.readline(), b"")
                self.assertNotEqual(process.wait(timeout=5), 0)
                process.stdin.close()
                process.stdout.close()
                self.assertEqual(target.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
