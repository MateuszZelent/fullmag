from __future__ import annotations

import copy
import hashlib
import json
import unittest
from unittest import mock

import docker_build_control
import docker_control_namespace
import docker_isolated_snapshot_namespace as snapshot


PROJECT = "fullmag-master"
CONTROL_VOLUME = "fullmag-control-fullmag-master"
PROJECT_ID = "source-project-new"
WORKTREE_ID = "source-worktree-new"
RECOVERY_ID = "a" * 32
OLD_ATTEMPT = "b" * 32
PREVIOUS_ID = "c" * 32


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def make_receipt(previous_namespace="namespaces/" + PREVIOUS_ID):
    recovery_id = RECOVERY_ID
    previous_registry_path = (
        "namespace-recovery/" + recovery_id + "/previous-registry.json"
    )
    prefix = previous_namespace + "/" if previous_namespace else ""
    attempt = prefix + "development/attempts/" + OLD_ATTEMPT
    runtime = prefix + "runtime-control/"
    required_paths = {
        previous_registry_path,
        attempt + "/terminal.json",
        attempt + "/compose.json",
        runtime + "runtime-services/OWNER.json",
        runtime + "runtime-services/LAUNCH.json",
        runtime + "runtime-service/docker-all.json",
        runtime + "runtime-service/process-tree.json",
    }
    raw_files = {
        "snapshot/source-manifest.json": b"opaque copied source manifest",
        "snapshot/original-request.json": b"opaque request bytes; no run schema assumed",
        "snapshot/original-compose.json": b"original config bytes",
    }
    for path in required_paths:
        raw_files[path] = ("pinned control record: " + path).encode()
    receipt = {
        "schema": snapshot.SNAPSHOT_SCHEMA,
        "state": snapshot.SNAPSHOT_STATE,
        "recovery_id": recovery_id,
        "namespace": "namespaces/" + recovery_id,
        "previous_namespace": previous_namespace,
        "compose_project": PROJECT,
        "control_volume": CONTROL_VOLUME,
        "source_project_id": PROJECT_ID,
        "source_worktree_id": WORKTREE_ID,
        "source_root": "/home/source/fullmag",
        "source_state_root": "/mnt/e/state/source",
        "destination_state_root": "/mnt/e/state/snapshot",
        "source_user_data_root": "/mnt/e/user-data/source",
        "destination_user_data_root": "/mnt/e/user-data/snapshot",
        "source_manifest_path": "snapshot/source-manifest.json",
        "source_manifest_sha256": digest(raw_files["snapshot/source-manifest.json"]),
        "request_path": "snapshot/original-request.json",
        "request_sha256": digest(raw_files["snapshot/original-request.json"]),
        "original_config_path": "snapshot/original-compose.json",
        "original_config_sha256": digest(raw_files["snapshot/original-compose.json"]),
        "old_container_ids": {"backend": "d" * 64, "frontend": "e" * 64},
        "old_image_id": "sha256:" + "f" * 64,
        "allow_old_request_replay": False,
        "allow_new_requests": False,
        "terminal_run_count": 5,
        "held_manual_run_count": 1,
        "old_development_attempt": OLD_ATTEMPT,
        "old_request_id": "request-previous-session-1",
        "previous_registry_path": previous_registry_path,
        "previous_registry_sha256": "0" * 64,
        "control_pins": {},
    }
    previous_registry_raw = b"previous namespace registry bytes"
    receipt["previous_registry_sha256"] = digest(previous_registry_raw)
    receipt["control_pins"] = {
        path: digest(previous_registry_raw if path == previous_registry_path else raw_files[path])
        for path in sorted(required_paths)
    }
    raw_files[previous_registry_path] = previous_registry_raw
    startup_prefix = receipt["namespace"] + "/isolated-snapshot/"
    for name, archive in (
        ("source-manifest.json", receipt["source_manifest_path"]),
        ("request.json", receipt["request_path"]),
        ("original-config.json", receipt["original_config_path"]),
    ):
        raw_files[startup_prefix + name] = raw_files[archive]
    raw_files[startup_prefix + "copied-content.json"] = encode({"state": {}, "user_data": {}})
    raw_files[startup_prefix + "start.json"] = encode({
        "schema": "fullmag.isolated-snapshot-start.v1", "allow_script_replay": False,
        "request_sha256": receipt["request_sha256"],
        "config_sha256": receipt["original_config_sha256"],
        "source_manifest_sha256": receipt["source_manifest_sha256"],
        "copied_content_sha256": digest(raw_files[startup_prefix + "copied-content.json"]),
        "restore_run_id": "run-held",
    })
    receipt["control_pins"].update({
        startup_prefix + name: digest(raw_files[startup_prefix + name])
        for name in ("start.json", "copied-content.json", "source-manifest.json", "request.json", "original-config.json")
    })
    return receipt, raw_files


def make_registry(receipt):
    receipt_raw = encode(receipt)
    registry = {
        "schema": docker_control_namespace.REGISTRY_SCHEMA,
        "recovery_id": receipt["recovery_id"],
        "namespace": receipt["namespace"],
        "receipt_path": "namespace-recovery/" + receipt["recovery_id"] + "/terminal.json",
        "receipt_sha256": digest(receipt_raw),
        "compose_project": PROJECT,
        "control_volume": CONTROL_VOLUME,
        "source_project_id": PROJECT_ID,
        "source_worktree_id": WORKTREE_ID,
    }
    return registry, encode(registry), receipt_raw


class FakeControl:
    path = staticmethod(docker_build_control.BuildControl.path)

    def __init__(self, namespace="namespaces/" + PREVIOUS_ID):
        self.project = PROJECT
        self.volume = CONTROL_VOLUME
        self.identity = {"project_id": PROJECT_ID, "worktree_id": WORKTREE_ID}
        self.namespace = namespace
        self.namespace_registry = {"old": "state"}
        self.namespace_registry_sha256 = "old-digest"


class SnapshotReceiptValidationTests(unittest.TestCase):
    def validate(self, receipt, **overrides):
        expected = {
            "project": PROJECT,
            "control_volume": CONTROL_VOLUME,
            "project_id": PROJECT_ID,
            "worktree_id": WORKTREE_ID,
        }
        expected.update(overrides)
        return snapshot.validate_snapshot_namespace_receipt(receipt, **expected)

    def test_accepts_empty_and_distinct_previous_namespace(self):
        for previous in ("", "namespaces/" + PREVIOUS_ID):
            with self.subTest(previous_namespace=previous):
                receipt, _ = make_receipt(previous)
                self.assertIs(self.validate(receipt), receipt)

    def test_rejects_wrong_group_paths_and_digests(self):
        receipt, _ = make_receipt()
        with self.assertRaises(docker_build_control.BuildControlError):
            self.validate(receipt, project="other-project")

        mutations = []
        bad_path = copy.deepcopy(receipt)
        bad_path["request_path"] = "snapshot/../request.json"
        mutations.append(("noncanonical request path", bad_path))

        bad_digest = copy.deepcopy(receipt)
        bad_digest["source_manifest_sha256"] = "A" * 64
        mutations.append(("uppercase digest", bad_digest))

        bad_namespace = copy.deepcopy(receipt)
        bad_namespace["namespace"] = "namespaces/" + "9" * 32
        mutations.append(("namespace mismatch", bad_namespace))

        for label, candidate in mutations:
            with self.subTest(label=label), self.assertRaises(
                docker_build_control.BuildControlError
            ):
                self.validate(candidate)

    def test_rejects_alias_roots_and_equal_source_destination(self):
        receipt, _ = make_receipt()
        for field, value in (
            ("source_root", "/home/source/../fullmag"),
            ("source_state_root", "/mnt/e/state/source/"),
            ("source_user_data_root", "/mnt//e/user-data/source"),
            ("destination_state_root", receipt["source_state_root"]),
            ("destination_user_data_root", receipt["source_user_data_root"]),
        ):
            candidate = copy.deepcopy(receipt)
            candidate[field] = value
            with self.subTest(field=field), self.assertRaises(
                docker_build_control.BuildControlError
            ):
                self.validate(candidate)

    def test_rejects_wrong_types_counts_and_request_flags(self):
        receipt, _ = make_receipt()
        mutations = []
        wrong_count_type = copy.deepcopy(receipt)
        wrong_count_type["terminal_run_count"] = True
        mutations.append(("bool count", wrong_count_type))

        too_many = copy.deepcopy(receipt)
        too_many["terminal_run_count"] = 128
        mutations.append(("sum exceeds bound", too_many))

        no_held_run = copy.deepcopy(receipt)
        no_held_run["held_manual_run_count"] = 0
        mutations.append(("missing held manual run", no_held_run))

        replay = copy.deepcopy(receipt)
        replay["allow_old_request_replay"] = True
        mutations.append(("replay enabled", replay))

        new_requests = copy.deepcopy(receipt)
        new_requests["allow_new_requests"] = True
        mutations.append(("new requests enabled", new_requests))

        for label, candidate in mutations:
            with self.subTest(label=label), self.assertRaises(
                docker_build_control.BuildControlError
            ):
                self.validate(candidate)

    def test_requires_minimal_pins_and_rejects_conflicting_or_self_pins(self):
        receipt, _ = make_receipt()
        missing = copy.deepcopy(receipt)
        del missing["control_pins"][receipt["previous_registry_path"]]

        conflicting_registry = copy.deepcopy(receipt)
        conflicting_registry["control_pins"][receipt["previous_registry_path"]] = "1" * 64

        conflicting_source = copy.deepcopy(receipt)
        conflicting_source["control_pins"][receipt["request_path"]] = "2" * 64

        self_pin = copy.deepcopy(receipt)
        self_pin["control_pins"]["namespaces/current.json"] = "3" * 64

        alias_pin = copy.deepcopy(receipt)
        alias_pin["control_pins"]["development//attempts/" + OLD_ATTEMPT + "/terminal.json"] = "4" * 64

        for label, candidate in (
            ("missing required pin", missing),
            ("previous registry conflict", conflicting_registry),
            ("source reference conflict", conflicting_source),
            ("self pin", self_pin),
            ("path alias", alias_pin),
        ):
            with self.subTest(label=label), self.assertRaises(
                docker_build_control.BuildControlError
            ):
                self.validate(candidate)

    def test_requires_all_five_exact_immutable_startup_pins(self):
        receipt, _ = make_receipt()
        prefix = receipt["namespace"] + "/isolated-snapshot/"
        for name in ("start.json", "copied-content.json", "source-manifest.json", "request.json", "original-config.json"):
            candidate = copy.deepcopy(receipt)
            del candidate["control_pins"][prefix + name]
            with self.subTest(missing=name), self.assertRaises(docker_build_control.BuildControlError):
                self.validate(candidate)
        for suffix in ("isolated-snapshot/native-validation.json", "isolated-snapshot/other.json", "runtime-control/OWNER.json", "isolated-snapshot/start.json/extra"):
            candidate = copy.deepcopy(receipt)
            candidate["control_pins"][receipt["namespace"] + "/" + suffix] = "1" * 64
            with self.subTest(forbidden=suffix), self.assertRaises(docker_build_control.BuildControlError):
                self.validate(candidate)
        candidate = copy.deepcopy(receipt)
        candidate["control_pins"]["namespace-recovery/" + RECOVERY_ID + "/terminal.json"] = "2" * 64
        with self.assertRaises(docker_build_control.BuildControlError):
            self.validate(candidate)

    def test_startup_source_pins_must_match_existing_archived_receipt_fields(self):
        receipt, _ = make_receipt()
        for name in ("source-manifest.json", "request.json", "original-config.json"):
            candidate = copy.deepcopy(receipt)
            candidate["control_pins"][receipt["namespace"] + "/isolated-snapshot/" + name] = "1" * 64
            with self.subTest(name=name), self.assertRaises(docker_build_control.BuildControlError):
                self.validate(candidate)

    def test_source_references_cannot_self_pin_registry_or_snapshot_receipt(self):
        receipt, _ = make_receipt()
        forbidden = (
            docker_control_namespace.REGISTRY_PATH,
            "namespace-recovery/" + RECOVERY_ID + "/terminal.json",
        )
        for field in ("source_manifest_path", "request_path", "original_config_path"):
            for path in forbidden:
                candidate = copy.deepcopy(receipt)
                candidate[field] = path
                with self.subTest(field=field, path=path), self.assertRaises(
                    docker_build_control.BuildControlError
                ):
                    self.validate(candidate)

    def test_rejects_noncanonical_ids_and_incomplete_shapes(self):
        receipt, _ = make_receipt()
        bad_container = copy.deepcopy(receipt)
        bad_container["old_container_ids"]["backend"] = "d" * 63
        bad_ids = copy.deepcopy(receipt)
        bad_ids["old_container_ids"]["frontend"] = bad_ids["old_container_ids"]["backend"]
        bad_keys = copy.deepcopy(receipt)
        bad_keys["unexpected"] = "extra"

        for label, candidate in (
            ("short container id", bad_container),
            ("duplicate container ids", bad_ids),
            ("unexpected field", bad_keys),
        ):
            with self.subTest(label=label), self.assertRaises(
                docker_build_control.BuildControlError
            ):
                self.validate(candidate)


class SnapshotNamespaceResolutionTests(unittest.TestCase):
    def setUp(self):
        self.receipt, self.files = make_receipt()
        self.registry, self.registry_raw, self.receipt_raw = make_registry(self.receipt)
        self.files[
            "namespace-recovery/" + RECOVERY_ID + "/terminal.json"
        ] = self.receipt_raw
        self.control = FakeControl(namespace="namespaces/" + "9" * 32)

    def original_state(self):
        return (
            self.control.namespace,
            copy.deepcopy(self.control.namespace_registry),
            self.control.namespace_registry_sha256,
        )

    def patch_reader(self, *, changed_registry=False, receipt_raw=None):
        reads = []
        original = self.control
        state_before = self.original_state()

        def read(root_control, relative, optional=False):
            self.assertIsNot(root_control, original)
            self.assertEqual(root_control.namespace, "")
            self.assertEqual(root_control.namespace_registry_sha256, None)
            self.assertEqual(self.original_state(), state_before)
            reads.append(relative)
            if relative == docker_control_namespace.REGISTRY_PATH:
                if changed_registry:
                    return self.registry_raw + b" "
                return self.registry_raw
            if relative == "namespace-recovery/" + RECOVERY_ID + "/terminal.json":
                return self.receipt_raw if receipt_raw is None else receipt_raw
            return self.files[relative]

        patcher = mock.patch.object(snapshot, "_raw", side_effect=read)
        return patcher, reads

    def test_resolves_using_raw_root_with_original_namespace_nonempty(self):
        for previous_namespace in ("", "namespaces/" + PREVIOUS_ID):
            with self.subTest(previous_namespace=previous_namespace):
                self.receipt, self.files = make_receipt(previous_namespace)
                self.registry, self.registry_raw, self.receipt_raw = make_registry(self.receipt)
                self.files[
                    "namespace-recovery/" + RECOVERY_ID + "/terminal.json"
                ] = self.receipt_raw
                self.control = FakeControl(namespace="namespaces/" + "9" * 32)
                patcher, reads = self.patch_reader()
                with patcher:
                    snapshot.resolve_snapshot_namespace(
                        self.control, self.registry, self.registry_raw
                    )

                expected_reads = {
                    *self.receipt["control_pins"],
                    self.receipt["source_manifest_path"],
                    self.receipt["request_path"],
                    self.receipt["original_config_path"],
                    "namespace-recovery/" + RECOVERY_ID + "/terminal.json",
                    docker_control_namespace.REGISTRY_PATH,
                }
                self.assertEqual(set(reads), expected_reads)
                self.assertEqual(self.control.namespace, self.receipt["namespace"])
                self.assertEqual(
                    self.control.namespace_registry,
                    {**self.registry, "retirement": self.receipt},
                )
                self.assertEqual(
                    self.control.namespace_registry_sha256, digest(self.registry_raw)
                )

    def test_rejects_registry_change_without_mutating_control(self):
        original_state = self.original_state()
        patcher, _ = self.patch_reader(changed_registry=True)
        with patcher, self.assertRaises(docker_build_control.BuildControlError):
            snapshot.resolve_snapshot_namespace(self.control, self.registry, self.registry_raw)
        self.assertEqual(self.original_state(), original_state)

    def test_rejects_passed_registry_mismatch_before_reading_or_mutating(self):
        original_state = self.original_state()
        wrong_registry = copy.deepcopy(self.registry)
        wrong_registry["receipt_sha256"] = "0" * 64
        with self.assertRaises(docker_build_control.BuildControlError):
            snapshot.resolve_snapshot_namespace(self.control, wrong_registry, self.registry_raw)
        self.assertEqual(self.original_state(), original_state)

    def test_rejects_malformed_registry_and_receipt_json_without_mutation(self):
        original_state = self.original_state()
        with self.assertRaises(docker_build_control.BuildControlError):
            snapshot.resolve_snapshot_namespace(self.control, self.registry, b"{")
        self.assertEqual(self.original_state(), original_state)

        malformed_receipt_raw = b"{\"schema\":\"duplicate\",\"schema\":\"duplicate\"}"
        malformed_registry = copy.deepcopy(self.registry)
        malformed_registry["receipt_sha256"] = digest(malformed_receipt_raw)
        malformed_registry_raw = encode(malformed_registry)
        patcher, _ = self.patch_reader(receipt_raw=malformed_receipt_raw)
        with patcher, self.assertRaises(docker_build_control.BuildControlError):
            snapshot.resolve_snapshot_namespace(
                self.control, malformed_registry, malformed_registry_raw
            )
        self.assertEqual(self.original_state(), original_state)

    def test_rejects_coherent_staged_startup_drift_before_resolution_mutation(self):
        prefix = self.receipt["namespace"] + "/isolated-snapshot/"
        archived = {field: self.files[self.receipt[field]] for field in (
            "source_manifest_path", "request_path", "original_config_path"
        )}
        initial_files = copy.deepcopy(self.files)
        original_state = self.original_state()
        for name, meta_field in (
            ("source-manifest.json", "source_manifest_sha256"),
            ("request.json", "request_sha256"),
            ("original-config.json", "config_sha256"),
            ("copied-content.json", "copied_content_sha256"),
        ):
            self.files = copy.deepcopy(initial_files)
            self.files[prefix + name] += b" changed coherently with staged metadata"
            meta = json.loads(self.files[prefix + "start.json"])
            meta[meta_field] = digest(self.files[prefix + name])
            self.files[prefix + "start.json"] = encode(meta)
            patcher, _ = self.patch_reader()
            with self.subTest(name=name), patcher, self.assertRaises(docker_build_control.BuildControlError):
                snapshot.resolve_snapshot_namespace(self.control, self.registry, self.registry_raw)
            self.assertEqual(self.original_state(), original_state)
            for field, raw in archived.items():
                self.assertEqual(self.files[self.receipt[field]], raw)

    def test_rejects_pinned_file_drift_without_mutating_control(self):
        original_state = self.original_state()
        self.files[self.receipt["request_path"]] = b"changed request"
        patcher, _ = self.patch_reader()
        with patcher, self.assertRaises(docker_build_control.BuildControlError):
            snapshot.resolve_snapshot_namespace(self.control, self.registry, self.registry_raw)
        self.assertEqual(self.original_state(), original_state)


if __name__ == "__main__":
    unittest.main()
