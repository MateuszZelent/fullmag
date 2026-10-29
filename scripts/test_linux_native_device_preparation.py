"""Device-only preparation regressions; no Docker, namespace probe or runtime."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import linux_native_host as host


@unittest.skipUnless(os.name == "posix", "Linux readmission uses POSIX evidence inodes")
class LinuxNativeReadmissionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state = Path(self.directory.name)
        self.observed_device = self.state.stat().st_dev
        self.certificate = {
            "schema": host.HOST_SCHEMA, "storage_profile": host.PROFILE, "role": "session",
            "owner_scope": "docker-linux", "host_root": str(self.state),
            "host_filesystem": "ext4", "host_platform": "linux", "host_root_no_reparse": True,
            "host_device": self.observed_device + 1, "host_inode": self.state.stat().st_ino,
            "engine_id": "engine-retained", "owner_token": "f" * 32,
            "image_id": "sha256:" + "a" * 64, "source_commit": "b" * 40,
            "binary_hashes": {"fullmag": "d" * 64}, "artifact_receipt_sha256": "c" * 64,
            "development_build": {"schema": "retained-delegation", "source": "unchanged"},
            "restart_verified": True, "retained_extra": {"must": "survive"},
        }
        self.payload = (self.certificate["owner_token"] + ":" + self.certificate["image_id"]).encode()
        self.certificate["restart_expected_sha256"] = hashlib.sha256(self.payload).hexdigest()
        host.publish_evidence(self.state / host.CERTIFICATE_NAME, self.certificate)
        host.publish_evidence(self.state / host.OWNER_NAME, self.certificate)
        for name in (".linux-native-sentinel", ".linux-native-restart"):
            (self.state / name).write_bytes(self.payload)
        self.probe = {
            "schema": "fullmag.linux-native-probe.v1", "storage_profile": host.PROFILE,
            "owner_token": self.certificate["owner_token"], "image_id": self.certificate["image_id"],
            "host_attestation_sha256": self.digest(host.CERTIFICATE_NAME),
            "root_device": self.certificate["host_device"], "root_inode": self.state.stat().st_ino,
            "mount_namespace_inode": 12345, "checks": {name: True for name in host.CHECKS},
        }
        host.publish_evidence(self.state / ".linux-native-probe.json", self.probe)
        self.native = {key: self.certificate[key] for key in
                       ("host_root", "host_filesystem", "host_platform", "host_root_no_reparse")}
        self.native["host_device"] = self.observed_device
        self.volume_patch = patch.object(host, "local_volume", return_value=self.native)
        self.volume_patch.start()
        self.addCleanup(self.volume_patch.stop)
        self.pins = {
            "state_root": str(self.state), "engine_id": self.certificate["engine_id"],
            "owner_token": self.certificate["owner_token"], "image_id": self.certificate["image_id"],
            "source_binding_sha256": host.readmission_source_binding_sha256(self.certificate),
            "retained_device": self.certificate["host_device"], "observed_device": self.observed_device,
            "root_inode": self.state.stat().st_ino,
            "files": {name: self.digest(name) for name in host.READMISSION_FILES},
        }

    def digest(self, name):
        return hashlib.sha256((self.state / name).read_bytes()).hexdigest()

    def snapshot(self):
        return {path.relative_to(self.state).as_posix():
                (path.read_bytes(), path.stat().st_ino, path.stat().st_mode)
                for path in self.state.rglob("*") if path.is_file()}

    def prepare(self):
        return host.prepare_device_readmission(self.state, self.pins)

    def test_preparation_is_read_only_and_only_two_candidate_fields_change(self):
        before = self.snapshot()
        prepared = self.prepare()
        self.assertEqual(self.snapshot(), before)
        candidate = prepared["candidate"]
        self.assertEqual({key for key in self.certificate if candidate[key] != self.certificate[key]},
                         {"host_device", "restart_verified"})
        self.assertEqual(candidate["host_device"], self.observed_device)
        self.assertIs(candidate["restart_verified"], False)
        self.assertEqual(prepared["original"], {name: before[name][0] for name in host.READMISSION_FILES})
        self.assertEqual(prepared["candidate_sha256"], hashlib.sha256(prepared["candidate_raw"]).hexdigest())

    def test_apply_preserves_certificate_inode_science_and_three_protected_files(self):
        (self.state / "runs").mkdir()
        (self.state / "runs/result.bin").write_bytes(b"retained scientific payload")
        prepared = self.prepare()
        before = self.snapshot()
        result = host.apply_device_readmission(self.state, prepared)
        after = self.snapshot()
        self.assertEqual(result["state"], "prepared-not-admitted")
        self.assertIs(result["namespace_admitted"], False)
        self.assertEqual(after[host.CERTIFICATE_NAME][1:], before[host.CERTIFICATE_NAME][1:])
        for name in (".linux-native-probe.json", ".linux-native-sentinel", ".linux-native-restart", "runs/result.bin"):
            self.assertEqual(after[name], before[name])
        self.assertEqual(after[host.CERTIFICATE_NAME][0], prepared["candidate_raw"])
        self.assertEqual(after[host.OWNER_NAME][0], prepared["candidate_raw"])
        self.assertEqual(json.loads(after[host.CERTIFICATE_NAME][0])["restart_expected_sha256"],
                         self.certificate["restart_expected_sha256"])

    def test_prepared_pair_replay_is_read_only(self):
        prepared = self.prepare()
        host.apply_device_readmission(self.state, prepared)
        before = self.snapshot()
        with patch.object(host, "publish_bytes") as publish, patch.object(host, "write_bound_evidence") as write:
            result = host.apply_device_readmission(self.state, prepared)
        publish.assert_not_called()
        write.assert_not_called()
        self.assertEqual(result["previous_phase"], "prepared")
        self.assertEqual(self.snapshot(), before)

    def test_retry_resumes_marker_first_partial_publication(self):
        prepared = self.prepare()
        with patch.object(host, "write_bound_evidence", side_effect=OSError("interrupted before certificate write")):
            with self.assertRaisesRegex(OSError, "interrupted"):
                host.apply_device_readmission(self.state, prepared)
        self.assertEqual((self.state / host.CERTIFICATE_NAME).read_bytes(), prepared["original"][host.CERTIFICATE_NAME])
        self.assertEqual((self.state / host.OWNER_NAME).read_bytes(), prepared["candidate_raw"])
        with patch.object(host, "publish_bytes") as publish:
            result = host.apply_device_readmission(self.state, prepared)
        publish.assert_not_called()
        self.assertEqual(result["previous_phase"], "marker-published")

    def test_canonical_archive_dict_order_never_changes_published_bytes(self):
        prepared = self.prepare()
        from docker_build_control import canonical
        from docker_linux_native_readmission import archive_preparation, restore_preparation
        prepared = restore_preparation(json.loads(canonical(archive_preparation(prepared))))
        host.apply_device_readmission(self.state, prepared)
        self.assertEqual((self.state / host.CERTIFICATE_NAME).read_bytes(), prepared["candidate_raw"])
        self.assertEqual((self.state / host.OWNER_NAME).read_bytes(), prepared["candidate_raw"])

    def test_archive_order_marker_requires_exact_explicit_v2_pin(self):
        prepared = self.prepare()
        raw = (json.dumps(prepared["candidate"], indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode()
        (self.state / host.OWNER_NAME).write_bytes(raw)
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "foreign, torn or reversed"):
            host.apply_device_readmission(self.state, prepared)
        self.assertEqual(self.snapshot(), before)
        with self.assertRaisesRegex(ValueError, "archived marker pin"):
            host.apply_device_readmission(self.state, prepared, archived_marker_sha256="0" * 64)
        self.assertEqual(self.snapshot(), before)
        pin = hashlib.sha256(raw).hexdigest()
        result = host.apply_device_readmission(self.state, prepared, archived_marker_sha256=pin)
        self.assertEqual(result["previous_phase"], "marker-published-archive-order")
        self.assertEqual((self.state / host.CERTIFICATE_NAME).read_bytes(), prepared["candidate_raw"])
        self.assertEqual((self.state / host.OWNER_NAME).read_bytes(), prepared["candidate_raw"])
        for name in host.READMISSION_FILES[2:]: self.assertEqual(self.snapshot()[name], before[name])

    def test_v2_pin_does_not_accept_arbitrary_equivalent_json_or_reversed_pair(self):
        prepared = self.prepare()
        archive_raw = (json.dumps(prepared["candidate"], indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode()
        compact = json.dumps(prepared["candidate"], sort_keys=True).encode()
        (self.state / host.OWNER_NAME).write_bytes(compact)
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "foreign, torn or reversed"):
            host.apply_device_readmission(self.state, prepared, archived_marker_sha256=hashlib.sha256(archive_raw).hexdigest())
        self.assertEqual(self.snapshot(), before)
        (self.state / host.OWNER_NAME).write_bytes(prepared["original"][host.OWNER_NAME])
        (self.state / host.CERTIFICATE_NAME).write_bytes(archive_raw)
        with self.assertRaisesRegex(ValueError, "foreign, torn or reversed"):
            host.apply_device_readmission(self.state, prepared, archived_marker_sha256=hashlib.sha256(archive_raw).hexdigest())

    def test_reversed_pair_is_refused_without_overwriting_either_file(self):
        prepared = self.prepare()
        (self.state / host.CERTIFICATE_NAME).write_bytes(prepared["candidate_raw"])
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "foreign, torn or reversed"):
            host.apply_device_readmission(self.state, prepared)
        self.assertEqual(self.snapshot(), before)

    def test_torn_and_foreign_bytes_are_never_repaired_implicitly(self):
        prepared = self.prepare()
        for name in (host.CERTIFICATE_NAME, host.OWNER_NAME):
            for raw in (b"{", b'{"foreign":true}'):
                with self.subTest(name=name, raw=raw):
                    for restored in (host.CERTIFICATE_NAME, host.OWNER_NAME):
                        (self.state / restored).write_bytes(prepared["original"][restored])
                    (self.state / name).write_bytes(raw)
                    before = self.snapshot()
                    with self.assertRaisesRegex(ValueError, "foreign, torn or reversed"):
                        host.apply_device_readmission(self.state, prepared)
                    self.assertEqual(self.snapshot(), before)

    def test_changed_bind_inode_is_refused_even_with_identical_bytes(self):
        prepared = self.prepare()
        replacement = self.state / "replacement.json"
        replacement.write_bytes(prepared["original"][host.CERTIFICATE_NAME])
        replacement.replace(self.state / host.CERTIFICATE_NAME)
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "bind inode"):
            host.apply_device_readmission(self.state, prepared)
        self.assertEqual(self.snapshot(), before)

    def test_each_original_raw_digest_is_required(self):
        for name in host.READMISSION_FILES:
            with self.subTest(name=name):
                pins = copy.deepcopy(self.pins)
                pins["files"][name] = "0" * 64
                before = self.snapshot()
                with self.assertRaisesRegex(ValueError, "CAS differs"):
                    host.prepare_device_readmission(self.state, pins)
                self.assertEqual(self.snapshot(), before)

    def test_identity_and_binding_pin_mismatches_are_refused(self):
        changes = {"state_root": "/foreign", "engine_id": "another-engine", "owner_token": "e" * 32,
                   "image_id": "sha256:" + "e" * 64, "source_binding_sha256": "0" * 64,
                   "retained_device": self.observed_device + 2, "observed_device": self.observed_device + 3,
                   "root_inode": self.state.stat().st_ino + 1}
        for key, value in changes.items():
            with self.subTest(key=key):
                pins = copy.deepcopy(self.pins); pins[key] = value
                with self.assertRaises(ValueError):
                    host.prepare_device_readmission(self.state, pins)
        for key, value in (("host_filesystem", "cifs"), ("host_platform", "foreign"),
                           ("host_root", "/foreign"), ("host_root_no_reparse", False)):
            with self.subTest(native_key=key), patch.object(host, "local_volume", return_value={**self.native, key: value}):
                with self.assertRaisesRegex(ValueError, "observed host identity"):
                    self.prepare()

    def test_protected_files_cannot_drift_between_prepare_and_apply(self):
        prepared = self.prepare()
        for name in host.READMISSION_FILES[2:]:
            with self.subTest(name=name):
                (self.state / name).write_bytes(prepared["original"][name] + b"drift")
                before = self.snapshot()
                with self.assertRaisesRegex(ValueError, "protected evidence"):
                    host.apply_device_readmission(self.state, prepared)
                self.assertEqual(self.snapshot(), before)
                (self.state / name).write_bytes(prepared["original"][name])

    def test_tampered_candidate_cannot_change_source_owner_or_restart_grant(self):
        prepared = self.prepare()
        for key, value in (("source_commit", "e" * 40), ("owner_token", "e" * 32), ("restart_verified", True)):
            with self.subTest(key=key):
                tampered = copy.deepcopy(prepared)
                tampered["candidate"][key] = value
                tampered["candidate_raw"] = (json.dumps(tampered["candidate"], indent=2) + "\n").encode()
                tampered["candidate_sha256"] = hashlib.sha256(tampered["candidate_raw"]).hexdigest()
                before = self.snapshot()
                with self.assertRaisesRegex(ValueError, "candidate or certificate"):
                    host.apply_device_readmission(self.state, tampered)
                self.assertEqual(self.snapshot(), before)

    def test_ordinary_guest_admission_refuses_prepared_state_until_real_probe(self):
        prepared = self.prepare()
        host.apply_device_readmission(self.state, prepared)
        spec = importlib.util.spec_from_file_location("readmission_guest_probe",
            Path(__file__).resolve().parents[1] / "docker/all-in-one/linux_native_probe.py")
        guest = importlib.util.module_from_spec(spec); spec.loader.exec_module(guest)
        environment = {"FULLMAG_RUNTIME_IMAGE_ID": self.certificate["image_id"],
                       "FULLMAG_DOCKER_HOST_ID": hashlib.sha256(self.certificate["engine_id"].encode()).hexdigest()}
        with patch.dict(os.environ, environment), patch.object(guest, "run") as probe:
            with self.assertRaisesRegex(RuntimeError, "restart readback is not verified"):
                guest.validate_host(self.state, self.state / host.CERTIFICATE_NAME)
        probe.assert_not_called()
        self.assertEqual((self.state / ".linux-native-probe.json").read_bytes(),
                         prepared["original"][".linux-native-probe.json"])

    def test_legacy_reuse_gate_still_refuses_device_drift(self):
        before = self.snapshot()
        reuse = {"state": self.state, "host_certificate": self.state / host.CERTIFICATE_NAME,
                 "receipt": {"image_id": self.certificate["image_id"]}}
        assembly = {"image_id": self.certificate["image_id"], "commit": "a" * 40,
                    "binary_hashes": {}, "build_receipt_sha256": "b" * 64}
        with self.assertRaisesRegex(ValueError, "volume identity differs"):
            host.reuse_certificate(reuse, assembly, self.certificate["engine_id"])
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
