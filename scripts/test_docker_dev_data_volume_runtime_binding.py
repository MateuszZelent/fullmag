from contextlib import contextmanager, nullcontext
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts import docker_dev_data_volume_runtime_binding as publisher
from scripts.test_fullmag_data_volume_runtime_binding import binding_fixture, plan_fixture


class Control:
    namespace = ""

    def __init__(self):
        self.calls = 0
        self.records = []
        self.operation_record = None

    @contextmanager
    def operation(self, phase, inputs):
        self.calls += 1
        operation = {"root": "data-volume-migration/attempts/" + "a" * 32,
                     "receipt": {"attempt": "a" * 32, "state": "started"}}
        self.operation_record = operation
        yield operation

    def write(self, path, value):
        self.records.append((path, deepcopy(value)))


class BindingPublisherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.op = self.root / "migration"
        self.op.mkdir()
        self.body = binding_fixture(plan_fixture(), "1" * 64)
        self.snapshot = {"operation_root": self.op, "binding": self.body}
        self.control = Control()
        self.layout = {"storage_root": str(self.root)}
        self.arguments = dict(volume_id=self.body["volume_id"], plan_sha256="1" * 64,
                              witnesses=self.body["witnesses"], backend=self.body["runtime_pins"]["backend"],
                              image_id=self.body["runtime_pins"]["image_id"])
        self.patchers = [
            patch.object(publisher, "select_checkout", return_value=self.source),
            patch.object(publisher.storage, "resolve_layout", return_value=self.layout),
            patch.object(publisher.storage, "build_lock", return_value=nullcontext()),
            patch.object(publisher, "compose_project_identity", return_value={"project_name": "group"}),
            patch.object(publisher, "BuildControl", return_value=self.control),
            patch.object(publisher, "_require_existing_control"),
            patch.object(publisher, "_source_pins", return_value={"producer": "2" * 64}),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def call(self, snapshots, *, publish):
        with patch.object(publisher, "_collect", side_effect=snapshots):
            return publisher.qualify_runtime_successor(self.source, publish=publish, **self.arguments)

    def test_check_does_not_publish_or_acquire_a_control_operation(self):
        result = self.call([self.snapshot], publish=False)
        self.assertEqual(result["state"], "qualified-read-only")
        self.assertFalse((self.op / "runtime-bindings").exists())
        self.assertEqual(self.control.calls, 0)

    def test_publication_preserves_historical_binding_and_emits_no_migration_authority(self):
        parent = self.op / "runtime-bindings"
        parent.mkdir()
        historical = parent / ("b" * 64 + ".json")
        historical.write_bytes(b"historical binding bytes\n")
        result = self.call([self.snapshot] * 3, publish=True)
        path = Path(result["path"])
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), result["binding_sha256"])
        self.assertEqual(json.loads(path.read_bytes()), self.body)
        self.assertEqual(historical.read_bytes(), b"historical binding bytes\n")
        self.assertEqual(self.control.calls, 1)
        self.assertEqual(self.control.operation_record["receipt"]["state"], "succeeded")
        self.assertFalse(result["data_migrated"])
        self.assertFalse(result["namespace_admitted"])

    def test_drift_under_the_control_lease_refuses_publication(self):
        changed = deepcopy(self.snapshot)
        changed["binding"]["admission"]["probe_sha256"] = "3" * 64
        with self.assertRaises(ValueError):
            self.call([self.snapshot, changed], publish=True)
        self.assertFalse((self.op / "runtime-bindings").exists())
        self.assertEqual(self.control.records, [])

    def test_late_drift_keeps_the_new_binding_but_never_records_success(self):
        changed = deepcopy(self.snapshot)
        changed["binding"]["services"]["backend"]["pid"] += 1
        with self.assertRaises(ValueError):
            self.call([self.snapshot, self.snapshot, changed], publish=True)
        self.assertEqual(len(list((self.op / "runtime-bindings").glob("*.json"))), 1)
        self.assertEqual(self.control.records, [])
        self.assertEqual(self.control.operation_record["receipt"]["state"], "started")

    def test_existing_exact_binding_is_not_overwritten_or_published_again(self):
        parent = self.op / "runtime-bindings"
        parent.mkdir()
        raw = publisher._encoded(self.body)
        path = parent / (hashlib.sha256(raw).hexdigest() + ".json")
        path.write_bytes(raw)
        with self.assertRaises(ValueError):
            self.call([self.snapshot], publish=True)
        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(self.control.calls, 0)

    def test_foreign_writable_publication_directory_is_rejected(self):
        parent = self.op / "runtime-bindings"
        parent.mkdir(mode=0o777)
        parent.chmod(0o777)
        with self.assertRaises(ValueError):
            self.call([self.snapshot] * 3, publish=True)
        self.assertEqual(list(parent.iterdir()), [])

    def test_unbounded_control_reference_is_rejected_before_observation(self):
        self.arguments["witnesses"]["stop"]["path"] = "../private.json"
        with patch.object(publisher, "_collect") as collect, self.assertRaises(ValueError):
            publisher.qualify_runtime_successor(self.source, publish=True, **self.arguments)
        collect.assert_not_called()
        self.assertEqual(self.control.calls, 0)

    def test_absent_existing_control_refuses_before_constructor_can_bootstrap(self):
        with patch.object(publisher, "_require_existing_control", side_effect=ValueError("missing volume")):
            with patch.object(publisher, "BuildControl") as constructor, self.assertRaises(ValueError):
                publisher.qualify_runtime_successor(self.source, publish=False, **self.arguments)
        constructor.assert_not_called()


class AdmissionTests(unittest.TestCase):
    def observe(self, *, role="session", token="e" * 32, engine="test-engine"):
        state = "/srv/fullmag/storage/runtimes/state"
        image = "sha256:" + "f" * 64
        certificate = {"schema": publisher.native.HOST_SCHEMA, "storage_profile": publisher.native.PROFILE,
                       "owner_scope": "docker-linux", "restart_verified": True, "image_id": image,
                       "host_root": state, "host_device": 12, "host_inode": 34, "engine_id": engine,
                       "owner_token": token, "restart_expected_sha256": publisher._sha((token + ":" + image).encode())}
        if role is not None:
            certificate["role"] = role
        cert_raw = publisher._encoded(certificate)
        probe = {"schema": "fullmag.linux-native-probe.v1", "storage_profile": publisher.native.PROFILE,
                 "owner_token": token, "image_id": image, "host_attestation_sha256": publisher._sha(cert_raw),
                 "root_inode": 34, "root_device": 56, "mount_namespace_inode": 78,
                 "checks": {key: True for key in publisher.native.CHECKS}}
        probe_raw = publisher._encoded(probe)
        guest = {"certificate_sha256": publisher._sha(cert_raw), "runtime_certificate_sha256": publisher._sha(cert_raw),
                 "owner_marker_sha256": publisher._sha(cert_raw), "probe_sha256": publisher._sha(probe_raw),
                 "engine_digest": publisher._sha(engine.encode()), "image_id": image,
                 "sentinel_matches": True, "restart_matches": True, "root_inode": 34,
                 "root_device": 56, "mount_namespace_inode": 78}
        plan = {"observation": {"engine_id": engine, "datasets": {"state": {"device": 12, "inode": 34}}}}
        pins = {"state_root": state, "image_id": image, "backend": "a" * 64}
        with patch.object(publisher.native, "read_owned_regular", side_effect=[cert_raw, cert_raw, probe_raw]):
            with patch.object(publisher, "docker_capture", side_effect=[
                SimpleNamespace(stdout=(engine + "\n").encode()), SimpleNamespace(stdout=publisher._encoded(guest))]):
                return publisher._admission(plan, pins)

    def test_valid_admission_exposes_only_token_hash(self):
        result = self.observe()
        self.assertEqual(result["owner_token_sha256"], publisher._sha(("e" * 32).encode()))
        self.assertNotIn("e" * 32, json.dumps(result))

    def test_consistent_but_invalid_role_token_or_engine_is_refused(self):
        for fields in ({"role": "workspace"}, {"role": None}, {"token": "not-a-token"}, {"engine": ""}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                self.observe(**fields)


if __name__ == "__main__":
    unittest.main()
