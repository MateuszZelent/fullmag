from __future__ import annotations

import hashlib
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import docker_volume_held_ui_start_retry as retry


def _plan():
    return {
        "schema": retry.PLAN_SCHEMA,
        "original": {
            "attempt": "b87b3885b29e4a10891bc416dcc53719",
            "config_sha256": "1" * 64,
            "request_id": "c2119b25-9cf7-4bfa-a87c-cecfdc706ede",
            "run_id": "run-live-6b6552a649f3cd4a87309ab4b48a1f0c83c0a884636a180dea580f83e0bf8cd0",
            "plan_sha256": "2" * 64,
            "request_sha256": "3" * 64,
            "recreate_terminal_sha256": "4" * 64,
        },
        "failed": {
            "attempt": "01b5993b4dd8465a8bfc8c3194d51570",
            "terminal_sha256": "5" * 64,
            "compose_sha256": "6" * 64,
            "config_sha256": "7" * 64,
            "verified_sha256": "8" * 64,
            "backend_container_id": "9" * 64,
            "frontend_container_id": "a" * 64,
            "backend_started_at": "2026-11-14T14:22:21.923691806Z",
            "frontend_started_at": "2026-11-14T14:22:23.195034111Z",
            "image_id": "sha256:" + "4" * 64,
        },
        "namespace": {
            "compose_project": "fullmag-worktree-test",
            "control_volume": "fullmag-control-test",
            "namespace": "",
            "namespace_registry_sha256": None,
            "source_root": "/work/fullmag",
            "state_root": "/state/docker-volume-dev/attempt",
            "accepted_store": "/state/runs/docker-all/session-store",
            "accepted_store_binding": "c" * 64,
        },
        "runtime": {
            "process_sha256": "d" * 64,
            "failure_fence_relative": "runtime-service/api-failure-test.json",
            "failure_fence_sha256": "e" * 64,
            "launch_sha256": "f" * 64,
            "launch_id": "a765d25d-da74-4903-b01b-8197fb6540c6",
            "input_sha256": "0" * 64,
            "native_config_sha256": "1" * 64,
            "api_pin": {"pid": 19356, "start_token": "12345"},
            "store_snapshot": {
                "active_count": 0, "reservations": [], "leases": [],
                "run_id": "run-live-6b6552a649f3cd4a87309ab4b48a1f0c83c0a884636a180dea580f83e0bf8cd0",
                "store_id": "sha256:" + "d" * 64,
            },
        },
        "released_snapshot_sha256": hashlib.sha256(
            retry.canonical({"active_count": 0, "reservations": [], "leases": [], "ledger": "released"})
        ).hexdigest(),
        "native_locks": {
            name: {"device": 2112, "inode": index + 1, "unlocked": True}
            for index, name in enumerate(retry.NATIVE_LOCK_NAMES)
        },
        "certificate": {
            "sha256": "3" * 64,
            "owner_sha256": "3" * 64,
            "owner_token": "d3f8728b871743d188e88cc937721ab9",
            "image_id": "sha256:" + "4" * 64,
            "host_inode": 101740,
            "storage_profile": "linux-native-v1",
            "restart_verified": True,
        },
        "new_source": {"commit": "b" * 40, "source_digest": "c" * 64,
                       "source_snapshot_sha256": "d" * 64},
        "frontend_handoff": {
            "schema": "fullmag.frontend-start-handoff.v1",
            "attempt": "01b5993b4dd8465a8bfc8c3194d51570",
            "terminal_sha256": "5" * 64,
            "current_sha256": "5" * 64,
            "compose_sha256": "6" * 64,
            "verified_sha256": "8" * 64,
            "source_root": "/work/fullmag",
            "state_root": "/state/docker-volume-dev/attempt",
            "frontend_generation_id": "33052febe7e54031a42865a76c067a68",
            "frontend_generation_subpath": "private/frontend/generations/33052febe7e54031a42865a76c067a68",
        },
        "authority_sha256": {name: "a" * 64 for name in retry.AUTHORITY_FILENAMES},
    }


class _Control:
    def __init__(self, archived):
        self.files = dict(archived)

    def read_bytes(self, relative, optional=False, maximum=None):
        if relative in self.files:
            return self.files[relative]
        if optional:
            return None
        raise FileNotFoundError(relative)

    def write_bytes(self, relative, payload):
        if relative in self.files:
            raise FileExistsError(relative)
        self.files[relative] = payload


class RetryPlanTests(unittest.TestCase):
    def test_plan_requires_distinct_new_source_commit_digest_and_snapshot_pins(self):
        plan = _plan()
        retry.validate_plan(plan)

        for field, invalid in (
            ("commit", "B" * 40),
            ("source_digest", "not-a-digest"),
            ("source_snapshot_sha256", "e" * 63),
        ):
            changed = dict(plan)
            changed["new_source"] = dict(plan["new_source"], **{field: invalid})
            with self.subTest(field=field), self.assertRaises(retry.RetryError):
                retry.validate_plan(changed)

        missing = dict(plan)
        del missing["new_source"]["source_snapshot_sha256"]
        with self.assertRaises(retry.RetryError):
            retry.validate_plan(missing)

    def test_plan_digest_is_canonical_and_closed(self):
        plan = _plan()
        digest = retry.plan_digest(plan)
        self.assertEqual(digest, hashlib.sha256(retry.canonical(plan)).hexdigest())
        self.assertEqual(retry.plan_digest(plan), digest)
        self.assertEqual(retry.retry_plan(plan), (plan, digest))

    def test_rejects_missing_or_extra_plan_fields(self):
        plan = _plan()
        del plan["runtime"]
        with self.assertRaises(retry.RetryError):
            retry.plan_digest(plan)
        plan = _plan()
        plan["new_authority"] = True
        with self.assertRaises(retry.RetryError):
            retry.plan_digest(plan)

    def test_rejects_partial_or_cross_attempt_plan(self):
        plan = _plan()
        plan["failed"]["attempt"] = plan["original"]["attempt"]
        with self.assertRaises(retry.RetryError):
            retry.plan_digest(plan)
        plan = _plan()
        plan["frontend_handoff"]["attempt"] = plan["original"]["attempt"]
        with self.assertRaises(retry.RetryError):
            retry.plan_digest(plan)

    def test_rejects_nonfinite_or_float_transport_values(self):
        plan = _plan()
        plan["runtime"]["store_snapshot"]["telemetry"] = 0.5
        with self.assertRaises(retry.RetryError):
            retry.plan_digest(plan)

    def test_rejects_lock_identity_boolean_and_pins_distinct_snapshots(self):
        plan = _plan()
        plan["native_locks"]["owner"]["inode"] = True
        with self.assertRaises(retry.RetryError):
            retry.plan_digest(plan)
        plan = _plan()
        plan["native_locks"]["owner"]["unlocked"] = False
        with self.assertRaises(retry.RetryError):
            retry.plan_digest(plan)
        plan = _plan()
        plan["runtime"]["store_snapshot"]["active_count"] = 1
        self.assertEqual(retry.plan_digest(plan), hashlib.sha256(retry.canonical(plan)).hexdigest())
        plan["released_snapshot_sha256"] = "not-a-digest"
        with self.assertRaises(retry.RetryError):
            retry.plan_digest(plan)

    def test_rejects_namespace_registry_on_unscoped_group_and_certificate_drift(self):
        plan = _plan()
        plan["namespace"]["namespace_registry_sha256"] = "a" * 64
        with self.assertRaises(retry.RetryError):
            retry.plan_digest(plan)
        plan = _plan()
        plan["certificate"]["owner_sha256"] = "b" * 64
        with self.assertRaises(retry.RetryError):
            retry.plan_digest(plan)

    def test_options_pin_original_and_failed_attempts_and_exact_mode(self):
        args = SimpleNamespace(
            attempt="b87b3885b29e4a10891bc416dcc53719", config_sha256="1" * 64,
            run_id=_plan()["original"]["run_id"], request_id="c2119b25-9cf7-4bfa-a87c-cecfdc706ede",
            source_root="/work/fullmag", port=3197, expected_plan_sha256="2" * 64,
            failed_held_start_attempt="01b5993b4dd8465a8bfc8c3194d51570",
            failed_held_start_sha256="5" * 64, preview=True, apply=False, retry_plan_sha256=None,
        )
        retry.validate_retry_options(args)
        args.retry_plan_sha256 = "c" * 64
        with self.assertRaises(retry.RetryError):
            retry.validate_retry_options(args)
        args.preview, args.apply, args.retry_plan_sha256 = False, True, "c" * 64
        retry.validate_retry_options(args)
        args.failed_held_start_attempt = args.attempt
        with self.assertRaises(retry.RetryError):
            retry.validate_retry_options(args)

    def test_apply_requires_exact_preview_digest(self):
        plan = _plan()
        digest = retry.plan_digest(plan)
        retry.validate_apply_digest(digest, digest)
        with self.assertRaises(retry.RetryError):
            retry.validate_apply_digest("f" * 64, digest)


class ArchivedAuthorityRestoreTests(unittest.TestCase):
    def test_restore_preserves_exact_eight_raw_records(self):
        request_id = "c2119b25-9cf7-4bfa-a87c-cecfdc706ede"
        archive_attempt = "1" * 32
        base = "held-ui-materialization/" + request_id + "/"
        archived = {"runtime-archives/" + archive_attempt + "/" + base + name: (name + "\n").encode()
                    for name in retry.AUTHORITY_FILENAMES}
        control = _Control(archived)
        expected = {name: (name + "\n").encode()
                    for name in retry.AUTHORITY_FILENAMES}
        def create_only(target, relative, payload, *, maximum):
            if relative in target.files:
                raise FileExistsError(relative)
            target.files[relative] = payload
        with patch("docker_volume_pre_ack_retry._publish_raw", create_only):
            restored = retry.restore_archived_authority(control, archive_attempt, request_id, expected)
        self.assertEqual(set(restored), set(retry.AUTHORITY_FILENAMES))
        for name in retry.AUTHORITY_FILENAMES:
            target = "runtime-control/" + base + name
            self.assertEqual(control.files[target], expected[name])
            self.assertEqual(restored[name], hashlib.sha256(expected[name]).hexdigest())
            self.assertNotIn(base + name, control.files)

    def test_restore_refuses_missing_archive_or_changed_hash(self):
        request_id = "c2119b25-9cf7-4bfa-a87c-cecfdc706ede"
        archive_attempt = "1" * 32
        base = "held-ui-materialization/" + request_id + "/"
        archived = {"runtime-archives/" + archive_attempt + "/" + base + name: name.encode()
                    for name in retry.AUTHORITY_FILENAMES}
        expected = {name: name.encode()
                    for name in retry.AUTHORITY_FILENAMES}
        control = _Control(archived)
        control.files["runtime-archives/" + archive_attempt + "/" + base + "request.json"] = b"changed"
        with self.assertRaises(retry.RetryError):
            retry.restore_archived_authority(control, archive_attempt, request_id, expected)
        control = _Control(archived)
        del control.files["runtime-archives/" + archive_attempt + "/" + base + "api-quiescence.json"]
        with self.assertRaises(retry.RetryError):
            retry.restore_archived_authority(control, archive_attempt, request_id, expected)

    def test_restore_refuses_existing_destination_and_extra_authority(self):
        request_id = "c2119b25-9cf7-4bfa-a87c-cecfdc706ede"
        archive_attempt = "1" * 32
        base = "held-ui-materialization/" + request_id + "/"
        archived = {"runtime-archives/" + archive_attempt + "/" + base + name: name.encode()
                    for name in retry.AUTHORITY_FILENAMES}
        expected = {name: name.encode()
                    for name in retry.AUTHORITY_FILENAMES}
        control = _Control(archived)
        control.files["runtime-control/" + base + "request.json"] = b"prior destination"
        with self.assertRaises(retry.RetryError):
            retry.restore_archived_authority(control, archive_attempt, request_id, expected)
        with self.assertRaises(retry.RetryError):
            retry.restore_archived_authority(control, archive_attempt, request_id,
                                             {**expected, "launch.json": b"extra authority"})

    def test_create_only_publication_preserves_a_racing_destination(self):
        request_id = "c2119b25-9cf7-4bfa-a87c-cecfdc706ede"
        archive_attempt = "1" * 32
        base = "held-ui-materialization/" + request_id + "/"
        archived = {"runtime-archives/" + archive_attempt + "/" + base + name: name.encode()
                    for name in retry.AUTHORITY_FILENAMES}
        expected = {name: name.encode()
                    for name in retry.AUTHORITY_FILENAMES}
        control = _Control(archived)
        race_path = "runtime-control/" + base + "preflight.json"
        foreign_bytes = b"racing writer bytes\n"
        calls = []

        def create_only(target, relative, payload, *, maximum):
            calls.append(relative)
            if relative == race_path:
                target.files[relative] = foreign_bytes
            if relative in target.files:
                raise FileExistsError(relative)
            target.files[relative] = payload

        with patch("docker_volume_pre_ack_retry._publish_raw", create_only):
            with self.assertRaises(retry.RetryError):
                retry.restore_archived_authority(control, archive_attempt, request_id, expected)
        self.assertEqual(control.files[race_path], foreign_bytes)
        self.assertEqual(calls, ["runtime-control/" + base + "request.json", race_path])


if __name__ == "__main__":
    unittest.main()
