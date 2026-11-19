"""Pure contract checks for retaining preparation-abort archive evidence."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import docker_volume_fresh_runtime as fresh_runtime
import docker_volume_preparation_abort as preparation_abort
from docker_build_control import BuildControlError, canonical
import docker_volume_unclaimed_cancellation as unclaimed_cancellation


ARCHIVE_ATTEMPT = "4" * 32
SECOND_ARCHIVE_ATTEMPT = "5" * 32
DEVELOPMENT_ATTEMPT = "3" * 32
NEXT_DEVELOPMENT_ATTEMPT = "6" * 32
ACTIVATION_ATTEMPT = "2" * 32
CONFIG_SHA256 = "a" * 64
BACKEND_ID = "b" * 64
FRONTEND_ID = "c" * 64


class FakeControl:
    project = "fullmag-worktree-fixture"
    volume = "fullmag-control-fixture"
    namespace = "namespace-fixture"

    def __init__(self, files):
        self.files = deepcopy(files)
        self.reads = []

    def read(self, path, *, optional=False):
        self.reads.append(path)
        if path not in self.files:
            if optional:
                return None
            raise BuildControlError("missing fake control record: " + path)
        return deepcopy(self.files[path])


def _fixture(*, namespace="namespace-fixture"):
    archive_path = (
        "recreate-services/attempts/" + ARCHIVE_ATTEMPT
        + "/runtime-control-archive-terminal.json"
    )
    recreation_path = "recreate-services/attempts/" + ARCHIVE_ATTEMPT + "/terminal.json"
    record = {
        "schema": preparation_abort.SCHEMA,
        "state": "stopped-awaiting-fresh-archive",
        "activation_attempt": ACTIVATION_ATTEMPT,
        "development_attempt": DEVELOPMENT_ATTEMPT,
        "config_sha256": CONFIG_SHA256,
        "backend_container": BACKEND_ID,
        "image_id": "sha256:" + "d" * 64,
        "source_root": "/worktrees/fixture",
    }
    archive = {
        "schema": "fullmag.docker-fresh-runtime-archive-terminal.v1",
        "state": "succeeded",
        "operation_attempt": ARCHIVE_ATTEMPT,
        "compose_project": FakeControl.project,
        "control_volume": FakeControl.volume,
        "control_namespace": namespace,
        "removed_containers": {"backend": BACKEND_ID, "frontend": FRONTEND_ID},
        "preserved_group_ledger_volume": "fullmag-group-ledger-fixture",
    }
    recreation = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "recreate-services",
        "state": "succeeded",
        "attempt": ARCHIVE_ATTEMPT,
        "compose_project": FakeControl.project,
        "control_volume": FakeControl.volume,
        "fresh_state": True,
        "inputs": {
            "attempt": DEVELOPMENT_ATTEMPT,
            "config_sha256": CONFIG_SHA256,
        },
        "runtime_control_archive": deepcopy(archive),
    }
    if namespace:
        recreation["control_namespace"] = namespace
    generation = {
        "schema": "fullmag.docker-group-ledger-generation.v1",
        "compose_project": FakeControl.project,
        "generation": ARCHIVE_ATTEMPT,
        "archive_terminal_path": archive_path,
        "archive_terminal_sha256": hashlib.sha256(canonical(archive)).hexdigest(),
        "preserved_volume": archive["preserved_group_ledger_volume"],
    }
    files = {
        preparation_abort.RECORD: record,
        archive_path: archive,
        recreation_path: recreation,
        "group-ledger-generation.json": generation,
    }
    control = FakeControl(files)
    control.namespace = namespace
    return control, record, archive, recreation, generation


def _publish_immutable(control, path, raw):
    if path in control.files:
        raise BuildControlError("fake immutable record already exists")
    control.files[path] = json.loads(raw)


class PreparationAbortArchiveTests(unittest.TestCase):
    def test_older_abort_is_pinned_before_second_rotation_and_survives(self):
        control, record, _, _, old_generation = _fixture()
        abort_before = canonical(control.files[preparation_abort.RECORD])

        with patch.object(unclaimed_cancellation, "_publish_immutable", _publish_immutable):
            pinned = fresh_runtime._preserve_previous_preparation_abort_archive(
                control, {"receipt": {"inputs": {"attempt": NEXT_DEVELOPMENT_ATTEMPT}}}
            )

        self.assertTrue(pinned)
        anchor_path = (
            "preparation-abort/archives/" + ACTIVATION_ATTEMPT + ".json"
        )
        anchor = control.files[anchor_path]
        self.assertEqual(anchor["group_ledger_generation"], old_generation)
        self.assertEqual(
            canonical(control.files[preparation_abort.RECORD]), abort_before
        )

        control.files["group-ledger-generation.json"] = {
            **deepcopy(old_generation),
            "generation": SECOND_ARCHIVE_ATTEMPT,
            "archive_terminal_path": (
                "recreate-services/attempts/" + SECOND_ARCHIVE_ATTEMPT
                + "/runtime-control-archive-terminal.json"
            ),
        }
        self.assertTrue(preparation_abort.has_fresh_archive(control, record))

    def test_first_fresh_archive_does_not_pin_its_unfinished_parent(self):
        control, _, _, _, _ = _fixture()
        control.files.pop("group-ledger-generation.json")

        pinned = fresh_runtime._preserve_previous_preparation_abort_archive(
            control, {"receipt": {"inputs": {"attempt": DEVELOPMENT_ATTEMPT}}}
        )

        self.assertFalse(pinned)
        self.assertNotIn(
            "preparation-abort/archives/" + ACTIVATION_ATTEMPT + ".json",
            control.files,
        )

    def test_older_abort_without_completed_generation_blocks_rotation(self):
        control, _, _, _, _ = _fixture()
        control.files.pop("group-ledger-generation.json")
        abort_before = canonical(control.files[preparation_abort.RECORD])

        with self.assertRaises(BuildControlError):
            fresh_runtime._preserve_previous_preparation_abort_archive(
                control, {"receipt": {"inputs": {"attempt": NEXT_DEVELOPMENT_ATTEMPT}}}
            )

        self.assertEqual(
            canonical(control.files[preparation_abort.RECORD]), abort_before
        )
        self.assertNotIn(
            "preparation-abort/archives/" + ACTIVATION_ATTEMPT + ".json",
            control.files,
        )

    def test_explicit_archive_attempt_repairs_a_rotated_generation_pointer(self):
        control, record, _, _, _ = _fixture()
        control.files.pop("group-ledger-generation.json")
        abort_before = canonical(control.files[preparation_abort.RECORD])

        with patch.object(unclaimed_cancellation, "_publish_immutable", _publish_immutable):
            preparation_abort.pin_completed_fresh_archive(
                control, archive_attempt=ARCHIVE_ATTEMPT
            )

        anchor = control.files[
            "preparation-abort/archives/" + ACTIVATION_ATTEMPT + ".json"
        ]
        self.assertEqual(anchor["group_ledger_generation"]["generation"], ARCHIVE_ATTEMPT)
        self.assertTrue(preparation_abort.has_fresh_archive(control, record))
        self.assertEqual(
            canonical(control.files[preparation_abort.RECORD]), abort_before
        )
        self.assertNotIn("group-ledger-generation.json", control.reads)
        self.assertIn(
            "recreate-services/attempts/" + ARCHIVE_ATTEMPT + "/terminal.json",
            control.reads,
        )

    def test_explicit_archive_attempt_rejects_invalid_or_unrelated_evidence(self):
        cases = []

        wrong_attempt, *_ = _fixture()
        cases.append(("missing exact archive", wrong_attempt, "e" * 32))
        malformed_attempt, *_ = _fixture()
        cases.append(("malformed archive attempt", malformed_attempt, "../" + "e" * 29))

        foreign_namespace, _, archive, recreation, _ = _fixture()
        archive["control_namespace"] = "foreign-namespace"
        recreation["runtime_control_archive"] = deepcopy(archive)
        foreign_namespace.files[
            "recreate-services/attempts/" + ARCHIVE_ATTEMPT
            + "/runtime-control-archive-terminal.json"
        ] = archive
        foreign_namespace.files[
            "recreate-services/attempts/" + ARCHIVE_ATTEMPT + "/terminal.json"
        ] = recreation
        foreign_namespace.files.pop("group-ledger-generation.json")
        cases.append(("foreign namespace", foreign_namespace, ARCHIVE_ATTEMPT))

        mismatched_archive, _, _, recreation, _ = _fixture()
        recreation["runtime_control_archive"]["removed_containers"]["frontend"] = "f" * 64
        mismatched_archive.files[
            "recreate-services/attempts/" + ARCHIVE_ATTEMPT + "/terminal.json"
        ] = recreation
        mismatched_archive.files.pop("group-ledger-generation.json")
        cases.append(("archive hash/content mismatch", mismatched_archive, ARCHIVE_ATTEMPT))

        failed_recreation, _, _, recreation, _ = _fixture()
        recreation["state"] = "failed-confirmed"
        failed_recreation.files[
            "recreate-services/attempts/" + ARCHIVE_ATTEMPT + "/terminal.json"
        ] = recreation
        failed_recreation.files.pop("group-ledger-generation.json")
        cases.append(("failed recreation", failed_recreation, ARCHIVE_ATTEMPT))

        wrong_parent, _, _, recreation, _ = _fixture()
        recreation["inputs"]["attempt"] = NEXT_DEVELOPMENT_ATTEMPT
        wrong_parent.files[
            "recreate-services/attempts/" + ARCHIVE_ATTEMPT + "/terminal.json"
        ] = recreation
        wrong_parent.files.pop("group-ledger-generation.json")
        cases.append(("wrong development attempt", wrong_parent, ARCHIVE_ATTEMPT))

        wrong_config, _, _, recreation, _ = _fixture()
        recreation["inputs"]["config_sha256"] = "e" * 64
        wrong_config.files[
            "recreate-services/attempts/" + ARCHIVE_ATTEMPT + "/terminal.json"
        ] = recreation
        wrong_config.files.pop("group-ledger-generation.json")
        cases.append(("wrong config digest", wrong_config, ARCHIVE_ATTEMPT))

        wrong_project, _, archive, recreation, _ = _fixture()
        archive["compose_project"] = "fullmag-worktree-other"
        recreation["compose_project"] = "fullmag-worktree-other"
        recreation["runtime_control_archive"] = deepcopy(archive)
        wrong_project.files[
            "recreate-services/attempts/" + ARCHIVE_ATTEMPT
            + "/runtime-control-archive-terminal.json"
        ] = archive
        wrong_project.files[
            "recreate-services/attempts/" + ARCHIVE_ATTEMPT + "/terminal.json"
        ] = recreation
        wrong_project.files.pop("group-ledger-generation.json")
        cases.append(("wrong compose project", wrong_project, ARCHIVE_ATTEMPT))

        wrong_control, _, archive, recreation, _ = _fixture()
        archive["control_volume"] = "fullmag-control-other"
        recreation["control_volume"] = "fullmag-control-other"
        recreation["runtime_control_archive"] = deepcopy(archive)
        wrong_control.files[
            "recreate-services/attempts/" + ARCHIVE_ATTEMPT
            + "/runtime-control-archive-terminal.json"
        ] = archive
        wrong_control.files[
            "recreate-services/attempts/" + ARCHIVE_ATTEMPT + "/terminal.json"
        ] = recreation
        wrong_control.files.pop("group-ledger-generation.json")
        cases.append(("wrong control volume", wrong_control, ARCHIVE_ATTEMPT))

        wrong_backend, _, archive, recreation, _ = _fixture()
        archive["removed_containers"]["backend"] = "f" * 64
        recreation["runtime_control_archive"] = deepcopy(archive)
        wrong_backend.files[
            "recreate-services/attempts/" + ARCHIVE_ATTEMPT
            + "/runtime-control-archive-terminal.json"
        ] = archive
        wrong_backend.files[
            "recreate-services/attempts/" + ARCHIVE_ATTEMPT + "/terminal.json"
        ] = recreation
        wrong_backend.files.pop("group-ledger-generation.json")
        cases.append(("wrong removed backend", wrong_backend, ARCHIVE_ATTEMPT))

        for label, control, token in cases:
            with self.subTest(label=label), self.assertRaises(BuildControlError):
                preparation_abort.pin_completed_fresh_archive(
                    control, archive_attempt=token
                )

    def test_current_generation_hash_mismatch_is_rejected(self):
        control, record, _, _, _ = _fixture()
        control.files["group-ledger-generation.json"][
            "archive_terminal_sha256"
        ] = "e" * 64

        self.assertFalse(preparation_abort.has_fresh_archive(control, record))

    def test_explicit_recovery_rejects_a_conflicting_existing_anchor(self):
        control, _, _, _, generation = _fixture()
        record = control.files[preparation_abort.RECORD]
        control.files[
            "preparation-abort/archives/" + ACTIVATION_ATTEMPT + ".json"
        ] = {
            "schema": "fullmag.docker-preparation-abort-archive.v1",
            "abort_sha256": hashlib.sha256(canonical(record)).hexdigest(),
            "group_ledger_generation": generation,
        }

        with self.assertRaises(BuildControlError):
            preparation_abort.pin_completed_fresh_archive(
                control, archive_attempt=SECOND_ARCHIVE_ATTEMPT
            )

    def test_root_control_accepts_legacy_recreation_terminal_without_namespace_field(self):
        control, record, _, recreation, _ = _fixture(namespace="")
        recreation.pop("control_namespace", None)
        control.files[
            "recreate-services/attempts/" + ARCHIVE_ATTEMPT + "/terminal.json"
        ] = recreation

        self.assertTrue(preparation_abort.has_fresh_archive(control, record))


if __name__ == "__main__":
    unittest.main()
