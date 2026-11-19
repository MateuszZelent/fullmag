"""Source-level regressions for explicit Linux store readmission planning."""
import base64
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import linux_native_host as host
import linux_native_readmission as readmission


class LinuxNativeReadmissionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name) / "state"
        self.state.mkdir()
        self.engine = "linux-engine-123"
        self.owner_token = "a" * 32
        self.image_id = "sha256:" + "b" * 64
        self.payload = (self.owner_token + ":" + self.image_id).encode("ascii")
        self.old_device = self.state.stat().st_dev - 1
        if self.old_device < 0:
            self.old_device = self.state.stat().st_dev + 1
        self.new_device = self.state.stat().st_dev
        self.inode = self.state.stat().st_ino
        self.filesystem_uuid = "01234567-89ab-4def-8123-456789abcdef"
        self.certificate = {
            "schema": host.HOST_SCHEMA,
            "storage_profile": host.PROFILE,
            "role": "session",
            "owner_scope": "docker-linux",
            "host_root": str(self.state),
            "host_filesystem": "ext4",
            "host_device": self.old_device,
            "host_platform": "linux",
            "host_root_no_reparse": True,
            "host_inode": self.inode,
            "owner_token": self.owner_token,
            "engine_id": self.engine,
            "image_id": self.image_id,
            "source_commit": "c" * 40,
            "binary_hashes": {"fullmag": "d" * 64},
            "artifact_receipt_sha256": "e" * 64,
            "restart_expected_sha256": hashlib.sha256(self.payload).hexdigest(),
            "restart_verified": True,
            "development_build": {"profile": "backend-dev", "generation": 1, "receipt": "f" * 64},
        }
        self.certificate_path = self.state / host.CERTIFICATE_NAME
        self.owner_path = self.state / host.OWNER_NAME
        self.sentinel_path = self.state / ".linux-native-sentinel"
        self.restart_path = self.state / ".linux-native-restart"
        self.probe_path = self.state / ".linux-native-probe.json"
        self._write_json(self.certificate_path, self.certificate, indent=2)
        # Separate raw bytes, same JSON value: both hashes are independent pins.
        self._write_json(self.owner_path, self.certificate, indent=None)
        self.sentinel_path.write_bytes(self.payload)
        self.restart_path.write_bytes(self.payload)
        self._write_json(self.probe_path, {
            "schema": "fullmag.linux-native-probe.v1",
            "storage_profile": host.PROFILE,
            "owner_token": self.owner_token,
            "image_id": self.image_id,
            "host_attestation_sha256": self._sha(self.certificate_path.read_bytes()),
            "root_device": self.old_device,
            "root_inode": self.inode,
            "mount_namespace_inode": 123,
            "checks": {key: True for key in host.CHECKS},
        }, indent=None)
        self.volume = {
            "host_root": str(self.state),
            "host_filesystem": "ext4",
            "host_device": self.new_device,
            "host_platform": "linux",
            "host_root_no_reparse": True,
        }

    @staticmethod
    def _sha(raw):
        return hashlib.sha256(raw).hexdigest()

    @staticmethod
    def _write_json(path, value, *, indent):
        path.write_text(json.dumps(value, indent=indent, sort_keys=indent is None) + ("\n" if indent else ""),
                        encoding="utf-8")

    def _prepare(self, **changes):
        state = changes.pop("state", self.state)
        arguments = {
            "engine_id": self.engine,
            "expected_certificate_sha256": self._sha(self.certificate_path.read_bytes()),
            "expected_owner_sha256": self._sha(self.owner_path.read_bytes()),
            "old_host_device": self.old_device,
            "new_host_device": self.new_device,
            "expected_inode": self.inode,
            "filesystem_uuid": self.filesystem_uuid,
        }
        arguments.update(changes)
        with patch.object(readmission, "local_volume", return_value=self.volume):
            return readmission.prepare_readmission(state, **arguments)

    def _revalidate(self, plan, *, volume=None):
        with patch.object(readmission, "local_volume", return_value=volume or self.volume):
            return readmission.revalidate_readmission(plan)

    def test_prepare_returns_serializable_plan_with_only_host_device_changed(self):
        plan = self._prepare()
        self.assertEqual(plan["old_certificate"], self.certificate)
        expected = dict(self.certificate)
        expected["host_device"] = self.new_device
        self.assertEqual(plan["new_certificate"], expected)
        self.assertEqual(plan["old_certificate"]["host_inode"], plan["new_certificate"]["host_inode"])
        self.assertEqual(plan["old_certificate"]["engine_id"], plan["new_certificate"]["engine_id"])
        self.assertEqual(plan["old_certificate"]["binary_hashes"], plan["new_certificate"]["binary_hashes"])
        self.assertEqual(plan["filesystem_uuid_observation"], self.filesystem_uuid)
        self.assertNotIn("filesystem_uuid", plan["old_certificate"])
        json.dumps(plan, allow_nan=False)
        evidence = plan["archived_evidence"]
        self.assertEqual(evidence["certificate"]["sha256"], self._sha(self.certificate_path.read_bytes()))
        self.assertEqual(evidence["owner_marker"]["sha256"], self._sha(self.owner_path.read_bytes()))
        self.assertEqual(base64.b64decode(evidence["probe"]["base64"], validate=True),
                         self.probe_path.read_bytes())
        self.assertTrue(plan["probe_is_historical_evidence"])
        self.assertTrue(plan["probe_stale_after_readmission"])
        self.assertEqual(
            base64.b64decode(plan["planned_new_evidence"]["certificate"]["base64"], validate=True),
            base64.b64decode(plan["planned_new_evidence"]["owner_marker"]["base64"], validate=True),
        )

    def test_classify_pair_accepts_only_the_four_exact_old_new_byte_pairs(self):
        plan = self._prepare()
        new_raw = base64.b64decode(plan["planned_new_evidence"]["certificate"]["base64"], validate=True)
        old_certificate_raw = self.certificate_path.read_bytes()
        old_owner_raw = self.owner_path.read_bytes()
        pairs = (
            (old_certificate_raw, old_owner_raw, "old/old"),
            (new_raw, old_owner_raw, "new/old"),
            (old_certificate_raw, new_raw, "old/new"),
            (new_raw, new_raw, "new/new"),
        )
        for certificate_raw, owner_raw, expected in pairs:
            with self.subTest(pair=expected):
                self.certificate_path.write_bytes(certificate_raw)
                self.owner_path.write_bytes(owner_raw)
                with patch.object(readmission, "local_volume", return_value=self.volume):
                    self.assertEqual(readmission.classify_pair(plan), expected)
        self.certificate_path.write_bytes(old_certificate_raw)
        self.owner_path.write_bytes(old_owner_raw)

    def test_classify_pair_rejects_changed_noncertificate_evidence_in_partial_states(self):
        plan = self._prepare()
        new_raw = base64.b64decode(plan["planned_new_evidence"]["certificate"]["base64"], validate=True)
        old_certificate_raw = self.certificate_path.read_bytes()
        old_owner_raw = self.owner_path.read_bytes()
        partial_pairs = ((new_raw, old_owner_raw), (old_certificate_raw, new_raw))
        for certificate_raw, owner_raw in partial_pairs:
            self.certificate_path.write_bytes(certificate_raw)
            self.owner_path.write_bytes(owner_raw)
            for path in (self.sentinel_path, self.restart_path, self.probe_path):
                with self.subTest(pair=(certificate_raw == new_raw, owner_raw == new_raw), evidence=path.name):
                    original = path.read_bytes()
                    path.write_bytes(original + b" ")
                    try:
                        with patch.object(readmission, "local_volume", return_value=self.volume):
                            with self.assertRaisesRegex(ValueError, "evidence|archive|changed"):
                                readmission.classify_pair(plan)
                    finally:
                        path.write_bytes(original)

    def test_classify_pair_rechecks_all_archived_bytes_at_end(self):
        plan = self._prepare()
        new_raw = base64.b64decode(plan["planned_new_evidence"]["certificate"]["base64"], validate=True)
        self.certificate_path.write_bytes(new_raw)
        original_read = readmission._read_documents
        reads = 0

        def change_probe_before_final_read(state):
            nonlocal reads
            reads += 1
            if reads == 2:
                self.probe_path.write_bytes(self.probe_path.read_bytes() + b" ")
            return original_read(state)

        with patch.object(readmission, "local_volume", return_value=self.volume), \
                patch.object(readmission, "_read_documents", side_effect=change_probe_before_final_read):
            with self.assertRaisesRegex(ValueError, "changed while classifying"):
                readmission.classify_pair(plan)

    def test_classify_pair_rejects_semantically_old_but_byte_different_json(self):
        plan = self._prepare()
        self._write_json(self.certificate_path, self.certificate, indent=4)
        with patch.object(readmission, "local_volume", return_value=self.volume):
            with self.assertRaisesRegex(ValueError, "neither|exact"):
                readmission.classify_pair(plan)

    def test_revalidate_reads_back_exact_documents_and_pins(self):
        plan = self._prepare()
        result = self._revalidate(plan)
        self.assertEqual(result["plan_sha256"], plan["plan_sha256"])
        self.assertEqual(result["certificate_sha256"], plan["expected_certificate_sha256"])
        self.assertEqual(result["owner_sha256"], plan["expected_owner_sha256"])
        self.assertEqual(result["probe_sha256"], plan["archived_evidence"]["probe"]["sha256"])
        self.assertEqual(result["state_inode"], self.inode)
        self.assertEqual(result["host_device"], self.new_device)

    def test_rejects_a_certificate_with_an_additional_identity_change(self):
        self.certificate["host_root"] = str(self.state.parent)
        self._write_json(self.certificate_path, self.certificate, indent=2)
        self._write_json(self.owner_path, self.certificate, indent=None)
        with self.assertRaises(ValueError):
            self._prepare()

    def test_prepare_rejects_duplicate_json_keys(self):
        self.certificate_path.write_text(
            '{"schema":"' + host.HOST_SCHEMA + '","schema":"' + host.HOST_SCHEMA + '"}',
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
            self._prepare()

    def test_rejects_certificate_owner_json_value_mismatch(self):
        owner = dict(self.certificate)
        owner["owner_token"] = "9" * 32
        self._write_json(self.owner_path, owner, indent=None)
        with self.assertRaisesRegex(ValueError, "owner|certificate|ownership"):
            self._prepare()
        owner = dict(self.certificate)
        owner["development_build"] = dict(self.certificate["development_build"], generation=True)
        self._write_json(self.owner_path, owner, indent=None)
        with self.assertRaisesRegex(ValueError, "owner|certificate|ownership"):
            self._prepare()

    def test_rejects_stale_certificate_or_owner_hashes(self):
        with self.assertRaisesRegex(ValueError, "hash|SHA|digest"):
            self._prepare(expected_certificate_sha256="0" * 64)
        with self.assertRaisesRegex(ValueError, "hash|SHA|digest"):
            self._prepare(expected_owner_sha256="0" * 64)

    def test_rejects_old_or_new_device_mismatch_and_noop(self):
        with self.assertRaises(ValueError):
            self._prepare(old_host_device=self.old_device + 1)
        with self.assertRaises(ValueError):
            self._prepare(new_host_device=self.new_device + 1)
        with self.assertRaisesRegex(ValueError, "change|different|drift|same"):
            self._prepare(old_host_device=self.new_device, new_host_device=self.new_device)

    def test_rejects_inode_mismatch_and_stale_inode_on_revalidation(self):
        with self.assertRaisesRegex(ValueError, "inode"):
            self._prepare(expected_inode=self.inode + 1)
        plan = self._prepare()
        old = self.state.with_name("state-old")
        self.state.rename(old)
        self.state.mkdir()
        for child in old.iterdir():
            shutil.copy2(child, self.state / child.name)
        with self.assertRaisesRegex(ValueError, "inode"):
            self._revalidate(plan)

    def test_rejects_volume_device_drift_on_revalidation(self):
        plan = self._prepare()
        changed = dict(self.volume, host_device=self.new_device + 123)
        with self.assertRaisesRegex(ValueError, "device|volume|identity"):
            self._revalidate(plan, volume=changed)

    def test_rejects_unverified_restart_or_bad_sentinel_and_restart_bytes(self):
        unverified = dict(self.certificate, restart_verified=False)
        self._write_json(self.certificate_path, unverified, indent=2)
        self._write_json(self.owner_path, unverified, indent=None)
        with self.assertRaisesRegex(ValueError, "restart|verified"):
            self._prepare()
        self._write_json(self.certificate_path, self.certificate, indent=2)
        self._write_json(self.owner_path, self.certificate, indent=None)
        self.sentinel_path.write_bytes(b"foreign-owner")
        with self.assertRaisesRegex(ValueError, "sentinel|restart|readback"):
            self._prepare()
        self.sentinel_path.write_bytes(self.payload)
        self.restart_path.write_bytes(b"foreign-owner")
        with self.assertRaisesRegex(ValueError, "restart|readback"):
            self._prepare()

    def test_rejects_missing_restart_and_symlinked_evidence(self):
        self.restart_path.unlink()
        with self.assertRaises((OSError, ValueError, RuntimeError)):
            self._prepare()
        self.restart_path.write_bytes(self.payload)
        self.sentinel_path.unlink()
        self.sentinel_path.symlink_to(self.restart_path)
        with self.assertRaises((OSError, ValueError, RuntimeError)):
            self._prepare()

    def test_revalidation_rejects_any_archived_document_edit(self):
        plan = self._prepare()
        self.probe_path.write_bytes(self.probe_path.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "probe|changed|hash|evidence"):
            self._revalidate(plan)

    def test_rejects_boolean_device_inode_and_invalid_uuid(self):
        for kwargs in (
            {"old_host_device": True},
            {"new_host_device": False},
            {"expected_inode": True},
            {"filesystem_uuid": "not-a-uuid"},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self._prepare(**kwargs)

    def test_rejects_symlinked_state_root(self):
        alias = self.state.with_name("state-link")
        alias.symlink_to(self.state, target_is_directory=True)
        with self.assertRaises((OSError, ValueError)):
            self._prepare(state=alias)


if __name__ == "__main__":
    unittest.main()
