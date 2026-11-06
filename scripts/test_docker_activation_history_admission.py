"""Read-only admission, historical mount identity and native writer barriers."""
import copy
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

from docker_activation_history_admission import (
    ReadOnlyBuildControl, historical_mounts, ledger_evidence,
    validate_backend_control_mounts, validate_control_pins, writer_barriers,
)
from docker_activation_history_policy import HistoryError, canonical, digest
from docker_build_control import BuildControlError


class AdmissionTests(unittest.TestCase):
    def test_native_backend_mounts_cannot_fence_a_different_ledger_subpath(self):
        control = types.SimpleNamespace(volume="control", namespace="", subpath=lambda p: p)
        targets = {"/opt/fullmag/control": "", "/host-ledger": "private/ledger",
                   "/opt/fullmag/runtime-control": "runtime-control"}
        row = {"Mounts": [{"Type": "volume", "Name": "control", "RW": True, "Destination": target}
                          for target in targets],
               "HostConfig": {"Mounts": [{"Type": "volume", "Source": "control", "Target": target,
                                          "VolumeOptions": {"Subpath": subpath}}
                                         for target, subpath in targets.items()]}}
        validate_backend_control_mounts(control, row)
        for index in range(3):
            changed = copy.deepcopy(row)
            changed["HostConfig"]["Mounts"][index]["VolumeOptions"]["Subpath"] = "foreign"
            with self.subTest(index=index), self.assertRaisesRegex(HistoryError, "archival fence"):
                validate_backend_control_mounts(control, changed)
        row["Mounts"].append({"Destination": "/host-ledger/ledger"})
        with self.assertRaises(HistoryError):
            validate_backend_control_mounts(control, row)

    def test_ledger_pins_only_exclude_periodic_telemetry_sample_hash(self):
        ledger = {"schema_version": "host_resource_ledger.v4", "policy": {"revision": 1},
                  "reservations": [{"state": "released", "run_id": "run-a"}],
                  "runtime_state": {"schema_version": "host_runtime_state.v1",
                                    "readiness_sha256": "c" * 64, "snapshot_sha256": "a" * 64}}
        before = ledger_evidence(canonical(ledger))
        ledger["runtime_state"]["snapshot_sha256"] = "b" * 64
        self.assertEqual(before, ledger_evidence(canonical(ledger)))
        for mutation in ("readiness", "policy", "run", "future-field"):
            changed = copy.deepcopy(ledger)
            if mutation == "readiness": changed["runtime_state"]["readiness_sha256"] = "d" * 64
            elif mutation == "policy": changed["policy"]["revision"] = 2
            elif mutation == "run": changed["reservations"][0]["run_id"] = "run-b"
            else: changed["runtime_state"]["future-field"] = True
            with self.subTest(mutation=mutation):
                self.assertNotEqual(before, ledger_evidence(canonical(changed)))
        ledger["reservations"][0]["state"] = "running"
        with self.assertRaisesRegex(BuildControlError, "nonreleased"):
            ledger_evidence(canonical(ledger))

    def test_namespace_constructor_and_subsequent_reads_use_readonly_control(self):
        commands = []
        identity = {"project_name": "fullmag-test", "project_id": "project", "worktree_id": "worktree",
                    "checkout_kind": "worktree"}
        def resolve(control):
            commands.append(control.helper_args("namespace-read"))
        with mock.patch("docker_control_namespace.resolve_namespace", side_effect=resolve), \
                mock.patch("docker_build_control.docker_argv", return_value=["docker", "run"]):
            control = ReadOnlyBuildControl(identity, "sha256:" + "a" * 64)
            with mock.patch("docker_build_control.bounded_capture", return_value=types.SimpleNamespace(
                    returncode=0, stdout=b'{"state":"succeeded"}', stderr=b"")) as capture:
                control.read("development/current.json")
                commands.append(capture.call_args.args[0])
            with self.assertRaises(BuildControlError):
                control.helper_args("initialize", initialize=True)
        self.assertEqual(len(commands), 2)
        for args in commands:
            mounts = [args[i + 1] for i, item in enumerate(args[:-1]) if item == "--mount"]
            self.assertTrue(any(",dst=/control," in item and item.endswith(",readonly") for item in mounts))
        self.assertEqual(control.read_pins["development/current.json"], digest(b'{"state":"succeeded"}'))

    def fixture(self):
        source, state, user = Path("/selected"), Path("/storage/runtime"), Path("/storage/results")
        control = types.SimpleNamespace(project="fullmag-test", volume="control", namespace="",
            identity={"project_id": "project", "worktree_id": "worktree"}, subpath=lambda p: p)
        token, image = "a" * 32, "sha256:" + "b" * 64
        compose = {"name": control.project, "services": {"backend": {"image": image, "volumes": [
            {"type": "bind", "source": str(source), "target": "/opt/fullmag/source", "read_only": True},
            {"type": "bind", "source": str(state), "target": "/state"},
            {"type": "bind", "source": str(user), "target": "/user-data"},
            {"type": "volume", "source": "control", "target": "/opt/fullmag/control"},
            {"type": "volume", "source": "control", "target": "/host-ledger",
             "volume": {"subpath": "private/ledger"}},
        ]}}, "volumes": {"control": {"name": "control"}}}
        config = digest(canonical(compose))
        receipt = {"development_attempt": token, "config_sha256": config, "source_root": str(source), "image_id": image}
        receipt["inputs"] = dict(receipt)
        terminal = {"schema": "fullmag.docker-build-operation.v1", "phase": "development", "state": "succeeded",
            "attempt": token, "compose_project": control.project, "control_volume": control.volume,
            "config_sha256": config, "state_root": str(state),
            "inputs": {"source_root": str(source), "image_id": image, "source_project_id": "project",
                       "source_worktree_id": "worktree"}}
        return control, receipt, terminal, compose, source

    def test_historical_paths_require_exact_activation_config_and_terminal_identity(self):
        fixture = self.fixture()
        self.assertEqual(historical_mounts(*fixture), (Path("/storage/runtime"), Path("/storage/results")))
        for mutation in ("compose-copy", "state-copy", "wrong-source", "wrong-config", "wrong-phase",
                         "wrong-namespace", "wrong-image", "wrong-worktree", "wrong-ledger"):
            control, receipt, terminal, compose, source = copy.deepcopy(fixture)
            if mutation == "compose-copy":
                compose["services"]["backend"]["volumes"][2]["source"] = "/storage/copied-results"
            elif mutation == "state-copy": terminal["state_root"] = "/storage/copied-runtime"
            elif mutation == "wrong-source": terminal["inputs"]["source_root"] = "/other"
            elif mutation == "wrong-config": receipt["inputs"]["config_sha256"] = "f" * 64
            elif mutation == "wrong-phase": terminal["phase"] = "iteration"
            elif mutation == "wrong-namespace": terminal["control_namespace"] = "namespaces/other"
            elif mutation == "wrong-image": terminal["inputs"]["image_id"] = "sha256:" + "f" * 64
            elif mutation == "wrong-worktree": terminal["inputs"]["source_worktree_id"] = "other"
            else:
                compose["services"]["backend"]["volumes"][4]["volume"]["subpath"] = "foreign/ledger"
                config = digest(canonical(compose))
                terminal["config_sha256"] = receipt["config_sha256"] = receipt["inputs"]["config_sha256"] = config
            with self.subTest(mutation=mutation), self.assertRaises(HistoryError):
                historical_mounts(control, receipt, terminal, compose, source)

    def test_record_pins_refuse_changes_and_retain_archived_activation_reentry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            relative = "development/attempts/" + "a" * 32 + "/terminal.json"
            path = root / relative
            path.parent.mkdir(parents=True)
            path.write_bytes(b"{}")
            pins = {relative: digest(b"{}"), "resume/verified.json": None}
            validate_control_pins(root, pins)
            path.write_bytes(b'{"state":"changed"}')
            with self.assertRaisesRegex(HistoryError, "changed"):
                validate_control_pins(root, pins)
            archive = root / "activation/history-v1" / ("b" * 32) / "receipt.json"
            archive.parent.mkdir(parents=True)
            archive.write_bytes(b"{}")
            validate_control_pins(root, {"activation/attempts/" + "b" * 32 + "/receipt.json": digest(b"{}")})
            with self.assertRaises(HistoryError):
                validate_control_pins(root, {"../outside.json": None})


@unittest.skipUnless(os.name == "posix", "managed helper runs on Linux")
class WriterBarrierTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.store, self.ledger = self.root / "store", self.root / "ledger"
        self.store.mkdir(); self.ledger.mkdir()
        self.registry = self.root / "host-ledger-roots"
        self.registry.mkdir()
        self.locks = [self.store / "WRITER.lock", self.ledger / "WRITER.lock"]
        for path in self.locks:
            path.touch()
        self.registry_lock = self.registry / "WRITER.lock"
        self.registry_lock.touch()

    def test_existing_writer_refuses_without_creating_or_replacing_any_lock(self):
        import fcntl
        for path in self.locks:
            with path.open("rb") as writer:
                fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.subTest(path=path), self.assertRaisesRegex(HistoryError, "writer is active"):
                    with writer_barriers(self.store, self.ledger):
                        self.fail("must not admit writer")
        self.locks[0].unlink()
        with self.assertRaises(FileNotFoundError):
            with writer_barriers(self.store, self.ledger): pass
        self.assertFalse(self.locks[0].exists())

    def test_barriers_exclude_independent_writers_until_transaction_returns(self):
        import fcntl
        with writer_barriers(self.store, self.ledger) as check:
            check()
            for path in self.locks:
                with path.open("rb") as writer, self.assertRaises(BlockingIOError):
                    fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for path in self.locks:
            with path.open("rb") as writer:
                fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_writer_lock_replacement_refuses(self):
        with self.assertRaisesRegex(HistoryError, "inode changed"):
            with writer_barriers(self.store, self.ledger) as check:
                self.locks[0].rename(self.store / "old-lock")
                self.locks[0].touch()
                check()

    def test_registry_writer_is_first_barrier_and_blocks_before_ledger_or_store(self):
        import fcntl
        with self.registry_lock.open("rb") as registry_writer, \
                self.locks[1].open("rb") as ledger_writer:
            fcntl.flock(registry_writer, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(ledger_writer, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(HistoryError, "host-ledger-roots/WRITER.lock"):
                with writer_barriers(self.store, self.ledger, self.registry):
                    self.fail("registry writer must block before ledger/store barriers")

    def test_linked_registry_writer_lock_is_refused_before_open(self):
        self.registry_lock.unlink()
        self.registry_lock.symlink_to(self.locks[0])
        with self.assertRaisesRegex(HistoryError, "linked, nonregular or replaced"):
            with writer_barriers(self.store, self.ledger, self.registry):
                self.fail("linked registry lock must not be admitted")

    def test_registry_barrier_is_held_for_transaction_and_replacement_is_detected(self):
        import fcntl
        with self.assertRaisesRegex(HistoryError, "inode changed"):
            with writer_barriers(self.store, self.ledger, self.registry) as check:
                check()
                for path in [self.registry_lock, *self.locks]:
                    with path.open("rb") as writer, self.assertRaises(BlockingIOError):
                        fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)
                old_lock = self.registry / "WRITER.lock.old"
                self.registry_lock.rename(old_lock)
                self.registry_lock.touch()
                check()

    def test_healthy_inventory_owner_lifetime_fence_does_not_block_archival(self):
        import fcntl
        inventory = self.ledger / "HOST_INVENTORY_OWNER.lock"
        inventory.touch()
        with inventory.open("rb") as owner:
            fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with writer_barriers(self.store, self.ledger) as check:
                check()
                for path in self.locks:
                    with path.open("rb") as writer, self.assertRaises(BlockingIOError):
                        fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)


if __name__ == "__main__":
    unittest.main()
