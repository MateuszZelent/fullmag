"""Contracts for exact retained terminal-history pins (interpreted tests)."""
import copy
import hashlib
import json
from pathlib import Path
import unittest

from docker_saved_authoring_history import observe_retained_catalogs, validate_retained_catalogs


class RetainedHistoryTests(unittest.TestCase):
    def setUp(self):
        self.catalog = {"schema_version": "run_catalog.v1", "run_id": "run-a", "revision": 3,
                        "tasks": [{"task_id": "task-a", "lifecycle": "succeeded"}]}
        self.raw = json.dumps(self.catalog).encode()
        self.pin = {"run_id": "run-a", "sha256": hashlib.sha256(self.raw).hexdigest(),
                    "bytes": len(self.raw), "tasks": copy.deepcopy(self.catalog["tasks"])}
        self.request = {"retained_run_catalogs": [self.pin]}

    def read(self, path):
        self.assertEqual(path, Path("/store/runs/run-a/run_catalog.json"))
        return self.raw

    def test_legacy_checkpoint_has_no_history_authority(self):
        self.assertIsNone(validate_retained_catalogs({}))
        self.assertIsNone(observe_retained_catalogs(Path("/store"), {}, lambda _: self.fail()))

    def test_exact_terminal_catalog_is_returned_unchanged(self):
        before = copy.deepcopy(self.request)
        self.assertEqual(observe_retained_catalogs(Path("/store"), self.request, self.read), [self.pin])
        self.assertEqual(self.request, before)

    def test_nonterminal_states_fail(self):
        for lifecycle in ("accepted", "queued", "preparing", "running", "stopping", "interrupted", "unknown"):
            with self.subTest(lifecycle=lifecycle):
                request = copy.deepcopy(self.request)
                request["retained_run_catalogs"][0]["tasks"][0]["lifecycle"] = lifecycle
                with self.assertRaises(ValueError):
                    validate_retained_catalogs(request)

    def test_changed_bytes_are_rejected(self):
        self.raw += b" "
        with self.assertRaisesRegex(ValueError, "bytes changed"):
            observe_retained_catalogs(Path("/store"), self.request, self.read)

    def test_pins_cannot_override_actual_task_lifecycle(self):
        self.pin["tasks"][0]["lifecycle"] = "cancelled"
        with self.assertRaisesRegex(ValueError, "task pins"):
            observe_retained_catalogs(Path("/store"), self.request, self.read)

    def test_duplicate_runs_tasks_and_preclaim_mix_are_rejected(self):
        for request in (
            {"retained_run_catalogs": [self.pin, self.pin]},
            {"retained_run_catalogs": [dict(self.pin, tasks=self.pin["tasks"] * 2)]},
            dict(self.request, historical_preclaim={}),
            dict(self.request, cancelled_preclaim={}),
        ):
            with self.assertRaises(ValueError):
                validate_retained_catalogs(request)

    def test_malformed_and_unbounded_pins_are_rejected(self):
        for change in ({"run_id": "../escape"}, {"bytes": True}, {"bytes": 8388609},
                       {"sha256": "x" * 64}, {"tasks": []}):
            with self.subTest(change=change):
                with self.assertRaises(ValueError):
                    validate_retained_catalogs({"retained_run_catalogs": [dict(self.pin, **change)]})

    def test_wrong_schema_run_or_revision_rejected_even_when_digest_matches(self):
        for change in ({"schema_version": "other"}, {"run_id": "other"}, {"revision": 0}, {"revision": True}):
            with self.subTest(change=change):
                self.raw = json.dumps(dict(self.catalog, **change)).encode()
                self.pin.update(bytes=len(self.raw), sha256=hashlib.sha256(self.raw).hexdigest())
                with self.assertRaises(ValueError):
                    observe_retained_catalogs(Path("/store"), self.request, self.read)


class ProposedGateTests(unittest.TestCase):
    def fixture(self):
        import docker_volume_dev as dev
        if not hasattr(dev, "retained_history"):
            self.skipTest("requires inert proposed launcher")
        from test_docker_volume_receipts import SavedAuthoringRestartTests
        return SavedAuthoringRestartTests().fixture()

    def test_legacy_checkpoint_cannot_authorize_nonempty_history(self):
        dev, pin, scene, _, _, _, _, proof = self.fixture()
        proof["run_directories"] = ["run-a"]
        with self.assertRaises(Exception):
            dev._saved_authoring_validate_probe(proof, pin, scene)

    def test_exact_history_does_not_relax_live_queue_or_host_leases(self):
        dev, pin, scene, _, _, _, _, proof = self.fixture()
        row = {"run_id": "run-a", "sha256": "a" * 64, "bytes": 100,
               "tasks": [{"task_id": "task-a", "lifecycle": "succeeded"}]}
        pin["retained_run_catalogs"] = [row]
        proof["retained_run_catalogs"] = [row]
        proof["run_directories"] = ["run-a"]
        dev._saved_authoring_validate_probe(proof, pin, scene)
        for change in ("lease", "queue", "missing"):
            bad = copy.deepcopy(proof)
            if change == "lease": bad["reservation_states"] = ["active"]
            elif change == "queue": bad["resources"]["queue"]["body"]["items"] = [{}]
            else: bad["retained_run_catalogs"] = []
            with self.assertRaises(Exception):
                dev._saved_authoring_validate_probe(bad, pin, scene)


class RetainedHistoryAdditionalTests(unittest.TestCase):
    setUp = RetainedHistoryTests.setUp
    read = RetainedHistoryTests.read
    def test_active_catalog_and_recomputed_pins_still_refuse(self):
        self.catalog["tasks"][0]["lifecycle"] = "running"
        self.raw = json.dumps(self.catalog).encode()
        self.pin.update(bytes=len(self.raw), sha256=hashlib.sha256(self.raw).hexdigest(),
                        tasks=copy.deepcopy(self.catalog["tasks"]))
        with self.assertRaisesRegex(ValueError, "not terminal"):
            observe_retained_catalogs(Path("/store"), self.request, self.read)

    def test_regular_reader_refusal_is_not_swallowed(self):
        def reject(path):
            raise ValueError("symlink rejected by bounded no-follow reader")
        with self.assertRaisesRegex(ValueError, "symlink"):
            observe_retained_catalogs(Path("/store"), self.request, reject)

class ProposedLinuxAndDrainTests(unittest.TestCase):
    def module(self):
        import docker_volume_dev as dev
        if not hasattr(dev, "retained_history"):
            self.skipTest("requires inert proposed launcher")
        return dev

    def test_linux_probe_uses_image_validator_and_rejects_changed_admission(self):
        import os, tempfile, types, sys
        from unittest import mock
        dev = self.module()
        script = dev._SAVED_AUTHORING_PROBE_SCRIPT
        fragment = script[script.index("profile=host.get('storage_profile')"):script.index("ledger=pathlib.Path")]
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary); store = state / "runs/session-store"; store.mkdir(parents=True)
            host = {"storage_profile":"linux-native-v1","owner_token":"a"*32,"engine_id":"engine"}
            raw = json.dumps(host).encode(); payload=b"sentinel"
            (state / ".linux-native-restart").write_bytes(payload)
            checks = {key: True for key in ("file_sync","directory_sync","atomic_replace","process_lock","no_follow_symlink","sqlite_transactions","restart_readback")}
            probe = {"schema":"fullmag.linux-native-probe.v1","storage_profile":"linux-native-v1",
                     "owner_token":host["owner_token"],"host_attestation_sha256":hashlib.sha256(raw).hexdigest(),
                     "root_device":state.stat().st_dev,"root_inode":state.stat().st_ino,
                     "mount_namespace_inode":Path("/proc/self/ns/mnt").stat().st_ino,"checks":checks}
            validator=mock.Mock(return_value=(host,raw,payload))
            def execute():
                (state / ".linux-native-probe.json").write_text(json.dumps(probe))
                scope={"host":host,"host_raw":raw,"request":{"host_certificate":host},
                       "paths":types.SimpleNamespace(state=state,host_certificate=state/"host.json"),
                       "store":store,"os":os,"json":json,"pathlib":__import__("pathlib"),"hashlib":hashlib,
                       "regular":lambda path:Path(path).read_bytes(),
                       "canon":lambda value:json.dumps(value,sort_keys=True,separators=(",",":")).encode()}
                with mock.patch.dict(os.environ,{"FULLMAG_SESSION_STORAGE_PROFILE":"linux-native-v1"}), mock.patch.dict(sys.modules,{"linux_native_probe":types.SimpleNamespace(validate_host=validator)}):
                    exec(fragment,scope)
                return scope
            result=execute()
            validator.assert_called_with(state,state/"host.json",require_restart=True)
            expected={"schema":"fullmag.linux-native-store-identity.v1","engine_id":"engine",
                      "owner_token":"a"*32,"relative_state_path":"runs/session-store"}
            self.assertEqual(result["stable_identity"],expected)
            probe["mount_namespace_inode"]+=1
            with self.assertRaisesRegex(RuntimeError,"mount/namespace"):
                execute()
            probe["mount_namespace_inode"]-=1
            probe["checks"]["restart_readback"]=False
            with self.assertRaisesRegex(RuntimeError,"mount/namespace"):
                execute()

    def test_post_drain_history_is_checked_before_restart_and_success(self):
        import tempfile,types
        from unittest import mock
        dev=self.module()
        with tempfile.TemporaryDirectory() as temporary:
            state=Path(temporary);run=state/"runs/docker-all/session-store/runs/run-a";run.mkdir(parents=True)
            raw=json.dumps({"schema_version":"run_catalog.v1","run_id":"run-a","revision":1,
                            "tasks":[{"task_id":"task-a","lifecycle":"succeeded"}]}).encode()
            catalog=run/"run_catalog.json";catalog.write_bytes(raw)
            pin={"run_id":"run-a","sha256":hashlib.sha256(raw).hexdigest(),"bytes":len(raw),
                 "tasks":[{"task_id":"task-a","lifecycle":"succeeded"}]}
            request={"retained_run_catalogs":[pin]}
            reader=types.SimpleNamespace(read_owned_regular=lambda path,maximum:Path(path).read_bytes())
            with mock.patch.object(dev,"_session_host",return_value=reader), mock.patch.object(dev.storage,"validate_path",side_effect=lambda path,*args:path):
                dev._saved_authoring_verify_retained_history(request,state)
                catalog.write_bytes(raw+b" ")
                with self.assertRaisesRegex(ValueError,"bytes changed"):
                    dev._saved_authoring_verify_retained_history(request,state)
            source=Path(dev.__file__).read_text()
            self.assertIn("_saved_authoring_validate_drain(authoring_probe, drained)\n                _saved_authoring_verify_retained_history(saved_authoring, state)",source)
            self.assertIn("_saved_authoring_verify_retained_history(request, state)",source)

if __name__ == "__main__":
    unittest.main()
