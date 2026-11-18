"""Read-only recovery-history validator guards with immutable record fixtures."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import sys
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_recreated_network_history as history
from docker_build_control import BuildControlError, canonical
from docker_volume_prelaunch_failure_stop import (
    POSTDRAIN_SCHEMA, QUIESCE_INTENT_SCHEMA, QUIESCE_SCHEMA,
    SCHEMA as CAPTURE_SCHEMA, PREFLIGHT_SCHEMA, _identity,
)
from docker_compose_identity import source_labels


def raw(value):
    return canonical(value) + b"\n"


def sha(value):
    return hashlib.sha256(value).hexdigest()


def fixture():
    project, volume, namespace = "fullmag-history-test", "control-history-test", "namespace-test"
    old, failed, recreation, stop = "6" * 32, "8" * 32, "d" * 32, "b" * 32
    backend, frontend = "1" * 64, "2" * 64
    source_root = "/workspace/fullmag"
    commit, snapshot = "a" * 40, "c" * 64
    identity = {"source_root": source_root, "project_name": project, "project_id": "project-id",
                "worktree_id": "worktree-id", "checkout_kind": "worktree"}
    control = SimpleNamespace(project=project, volume=volume, namespace=namespace, identity=identity)
    owner = {key: value for key, value in {
        "owner_token": "owner-token", "process_start_token": "start-token", "host": "host",
        "target_id": "target", "protocol": "protocol", "build_commit": commit,
        "build_snapshot": snapshot, "control_address": "address",
        "compute_pool_generation": "compute-generation", "preparation_pool_generation": "prep-generation",
        "compute_pool_id": "compute", "preparation_pool_id": "preparation",
    }.items()}
    owner.update(pid=12, state="ready", children=[
        {"role": "compute", "pid": 13, "status": "running"},
        {"role": "preparation", "pid": 14, "status": "running"},
    ])
    api_instance = "11111111-1111-4111-8111-111111111111"
    api_pin = {"pid": 42, "start_token": "123", "ppid": 20,
               "argv": ["/opt/fullmag/package/bin/fullmag-api"],
               "exe": "/opt/fullmag/package/bin/fullmag-api"}
    source_binding = {"schema": "fullmag.prelaunch-failure-source-binding.v1", "files": [
        {"name": name, "path": source_root + "/scripts/" + name,
         "size_bytes": 12, "sha256": "e" * 64}
        for name in ("docker_dev.py", "docker_volume_dev.py", "docker_volume_prelaunch_failure_stop.py")
    ]}
    store_binding = {"schema": "fullmag.prelaunch-failure-store-binding.v1",
                     "run_id": "run-one", "store_id": "sha256:" + "f" * 64}
    preflight = {"schema": PREFLIGHT_SCHEMA, "api_instance_id": api_instance, "run_id": "run-one"}
    ready_owner_sha = sha(canonical(_identity(owner)))
    locked_sha = "9" * 64
    api_quiescence = {
        "schema": QUIESCE_SCHEMA, "api_instance_id": api_instance, "api_pin": api_pin,
        "api_closed": True, "signal": "SIGTERM", "api_exit_code": -15,
        "api_diagnostic_only": False, "error": "Fullmag API exited unexpectedly (-15)",
        "preflight_sha256": sha(canonical(preflight)),
        "store_binding_sha256": sha(canonical(store_binding)),
        "locked_evidence_sha256": locked_sha, "ready_owner_sha256": ready_owner_sha,
        "failure_process_sha256": "7" * 64,
    }
    captured = {"schema": CAPTURE_SCHEMA, "source_binding": source_binding,
                "preflight": preflight, "store_binding": store_binding,
                "ready_owner_sha256": ready_owner_sha, "locked_evidence_sha256": locked_sha,
                "native_config_sha256": "0" * 64, "process_sha256": "5" * 64,
                "api_pin": api_pin, "api_quiescence": api_quiescence}
    process = {"schema": "fullmag.docker-process-tree.v1", "state": "drained",
               "accepted_store": "/state/runs/docker-all/session-store", "api_pid": 42,
               "api_exit_code": -15, "api_diagnostic_only": False,
               "error": "Fullmag API exited unexpectedly (-15)", "service_owner": owner,
               "terminal_service_owner": {**deepcopy(owner), "state": "drained", "children": [
                   {"role": "compute", "pid": 13, "status": "exited_success"},
                   {"role": "preparation", "pid": 14, "status": "exited_success"},
               ]}}
    intent = {"schema": QUIESCE_INTENT_SCHEMA, "source_binding": source_binding,
              "services": {
                  "backend": {"Id": backend, "Config": {"Labels": source_labels(identity)}},
                  "frontend": {"Id": frontend, "Config": {"Labels": source_labels(identity)}},
              }}
    postdrain = {"schema": POSTDRAIN_SCHEMA, "run_id": "run-one", "store_id": store_binding["store_id"],
                 "store_binding_sha256": sha(canonical(store_binding)),
                 "locked_evidence_sha256": locked_sha}
    config_raw = b'{"native":"docker-all"}\n'
    captured["native_config_sha256"] = sha(config_raw)
    stop_root = "iteration/attempts/" + stop
    capture_raw, intent_raw = raw(captured), raw(intent)
    drain = {"schema": "fullmag.docker-idle-restart-drain.v1", "backend_container_id": backend,
             "process_receipt": process, "process_receipt_sha256": sha(raw(process))}
    drain_raw, postdrain_raw = raw(drain), raw(postdrain)
    stop_doc = {
        "schema": "fullmag.docker-build-operation.v1", "phase": "iteration", "state": "succeeded",
        "attempt": stop, "compose_project": project, "control_volume": volume,
        "control_namespace": namespace, "idle_backend_stopped": True,
        "started_at": 10, "finished_at": 15, "config_sha256": "4" * 64,
        "backend_container": backend, "frontend_container": frontend,
        "inputs": {"source_root": source_root, "attempt": old, "config_sha256": "4" * 64,
                    "capture_prelaunch_failure": True, "quiesce_api": True,
                    "prelaunch_failure_source_binding": source_binding},
        "api_quiescence_intent_sha256": sha(intent_raw),
        "prelaunch_failure_capture_sha256": sha(capture_raw),
        "prelaunch_failure_postdrain_sha256": sha(postdrain_raw),
    }
    stop_raw = raw(stop_doc)

    old_state, new_state = "/runtime/docker-volume-dev/" + old, "/runtime/docker-volume-dev/" + failed
    old_doc = {"schema": "fullmag.docker-build-operation.v1", "phase": "development",
               "state": "succeeded", "attempt": old, "compose_project": project,
               "control_volume": volume, "control_namespace": namespace,
               "started_at": 1, "finished_at": 8, "state_root": old_state,
               "backend_container": backend, "frontend_container": frontend,
               "backend_build_receipt_sha256": "3" * 64,
               "inputs": {"source_root": source_root, "source_project_id": identity["project_id"],
                          "source_worktree_id": identity["worktree_id"],
                          "source_checkout_kind": identity["checkout_kind"]}}
    old_raw = raw(old_doc)
    archive_mapping = history._archive_mapping(recreation, private_ledger=False)
    archive_intent = {"schema": "fullmag.docker-fresh-runtime-archive-intent.v1",
                      "operation_attempt": recreation, "compose_project": project,
                      "control_volume": volume, "control_namespace": namespace,
                      "source_root": source_root, "previous_state_root": old_state,
                      "removed_containers": {"backend": backend, "frontend": frontend},
                      "mapping": archive_mapping}
    archive_intent_raw = raw(archive_intent)
    archive = {"schema": history.RECREATION_TERMINAL_SCHEMA, "state": "succeeded",
               "operation_attempt": recreation, "intent_sha256": sha(archive_intent_raw),
               "compose_project": project, "control_volume": volume, "control_namespace": namespace,
               "removed_containers": {"backend": backend, "frontend": frontend},
               "mapping": archive_mapping}
    archive_raw = raw(archive)

    native_identity = {
        "schema": "fullmag.source-snapshot.v2", "head_commit_full": commit,
        "head_tree_sha256": "d" * 64, "dirty_content_sha256": "e" * 64,
        "source_snapshot_sha256": snapshot, "source_snapshot_dirty": True,
        "ignored_non_runtime_dirty": False, "git_status_porcelain_v1": [],
        "dirty_path_content": [],
    }
    provenance = {"schema": "fullmag.docker-all-image.v1", "state": "succeeded",
                  "package_root": "/opt/fullmag/package",
                  "backend_build_receipt": "/opt/fullmag/package/backend-build-receipt.json",
                  "backend_build_receipt_schema": "fullmag.direct-compose.backend-build-receipt.v1",
                  "build_receipt_sha256": "f" * 64,
                  "commit": commit, "source_snapshot_sha256": snapshot,
                  "source_digest": "9" * 64, "source_mode": "live-shadow-v1",
                  "direct_source_provenance": "fullmag.docker-backend-live-source.v1",
                  "native_source_identity": native_identity,
                  "native_source_identity_sha256": sha(raw(native_identity)),
                  "binary_hashes": {"fullmag-api": "2" * 64}}
    provenance_raw = raw(provenance)
    stop_witness = {"schema": history.PRELAUNCH_FRESH_SCHEMA, "stop_attempt": stop,
                    "stop_sha256": sha(stop_raw), "capture_sha256": sha(capture_raw),
                    "source_binding_sha256": sha(canonical(source_binding)),
                    "store_binding_sha256": sha(canonical(store_binding))}
    recreation_doc = {"schema": "fullmag.docker-build-operation.v1", "phase": "recreate-services",
                      "state": "succeeded", "fresh_state": True, "attempt": recreation,
                      "compose_project": project, "control_volume": volume,
                      "control_namespace": namespace, "started_at": 20, "finished_at": 30,
                      "previous_state_root": old_state, "removed_containers": [backend, frontend],
                      "runtime_control_archive": archive,
                      "prelaunch_failure_fresh_archive": stop_witness,
                      "inputs": {"attempt": old, "source_root": source_root,
                                 "source_project_id": identity["project_id"],
                                 "source_worktree_id": identity["worktree_id"],
                                 "source_checkout_kind": identity["checkout_kind"],
                                 "config_sha256": "4" * 64,
                                 "prelaunch_failure_stop": {"attempt": stop, "terminal_sha256": sha(stop_raw)}}}
    recreation_raw = raw(recreation_doc)
    failed_doc = {"schema": "fullmag.docker-build-operation.v1", "phase": "development",
                  "state": "outcome-unknown-resources-retained", "attempt": failed,
                  "compose_project": project, "control_volume": volume,
                  "control_namespace": namespace, "started_at": 40, "finished_at": 45,
                  "state_root": new_state,
                  "inputs": {"source_root": source_root, "source_project_id": identity["project_id"],
                             "source_worktree_id": identity["worktree_id"],
                             "source_checkout_kind": identity["checkout_kind"]},
                  "error": "all predefined address pools have been fully subnetted"}
    failed_raw = raw(failed_doc)
    rec_root = "recreate-services/attempts/" + recreation
    archived_root = "runtime-archives/" + recreation + "/runtime-service"
    records = {
        "development/attempts/" + old + "/terminal.json": old_raw,
        "development/attempts/" + failed + "/receipt.json": failed_raw,
        rec_root + "/terminal.json": recreation_raw,
        rec_root + "/receipt.json": recreation_raw,
        rec_root + "/runtime-control-archive-intent.json": archive_intent_raw,
        rec_root + "/runtime-control-archive-terminal.json": archive_raw,
        stop_root + "/terminal.json": stop_raw, stop_root + "/receipt.json": stop_raw,
        stop_root + "/prelaunch-failure-quiescence-intent.json": intent_raw,
        stop_root + "/prelaunch-failure-stop.json": capture_raw,
        stop_root + "/backend-drain.json": drain_raw,
        stop_root + "/prelaunch-failure-postdrain-lock.json": postdrain_raw,
        archived_root + "/docker-all.json": config_raw,
        archived_root + "/process-tree.json": raw(process),
    }
    publications = {"development/current.json": old_raw, "development/verified.json": old_raw,
                    "backend/runtime-provenance.json": provenance_raw,
                    "runtime-control/runtime-services/OWNER.json": None,
                    "runtime-control/runtime-service/process-tree.json": None,
                    "development/attempts/" + failed + "/terminal.json": None}
    return {"control": control, "recreation_attempt": recreation,
            "recreation_sha256": sha(recreation_raw), "failed_attempt": failed,
            "original": failed_doc, "publications": publications,
            "attempts": [(old, "d"), (failed, "d")], "records": records,
            "process": process, "old": old_doc, "recreation": recreation_doc}


def retirement_fixture(*, private_ledger=False):
    data = fixture()
    recreation = data["recreation"]
    rec_root = "recreate-services/attempts/" + data["recreation_attempt"]
    old = data["old"]
    old["config_sha256"] = recreation["inputs"]["config_sha256"]
    old_raw = raw(old)
    data["records"]["development/attempts/" + old["attempt"] + "/terminal.json"] = old_raw
    for pointer in ("current", "verified"):
        data["publications"][f"development/{pointer}.json"] = old_raw
    archived_root = "runtime-archives/" + data["recreation_attempt"] + "/runtime-service"
    process = data["process"]
    process["api_exit_code"] = 0
    del process["error"]
    process_raw = raw(process)
    data["records"][archived_root + "/process-tree.json"] = process_raw
    data["records"][rec_root + "/retirement-native-drain.json"] = process_raw
    recreation.pop("prelaunch_failure_fresh_archive")
    recreation["inputs"].pop("prelaunch_failure_stop")
    recreation.update(retire_only=True, retirement_native_drain_sha256=sha(process_raw))
    labels = source_labels(data["control"].identity)
    data["records"][rec_root + "/retained-containers.json"] = raw({
        service: {"Id": old[service + "_container"], "State": {
            "Running": False, "Status": "exited", "Pid": 0, "ExitCode": 0, "OOMKilled": False,
        }, "Config": {"Labels": {**labels, "com.docker.compose.service": service}}}
        for service in ("backend", "frontend")
    })
    previous_attempt = "3" * 32
    earlier = {**old, "attempt": previous_attempt, "started_at": 0.1, "finished_at": 0.9}
    data["records"]["development/attempts/" + previous_attempt + "/terminal.json"] = raw(earlier)
    data["attempts"].append((previous_attempt, "d"))
    archive_path = rec_root + "/runtime-control-archive-terminal.json"
    intent_path = rec_root + "/runtime-control-archive-intent.json"
    archive = recreation["runtime_control_archive"]
    intent = json.loads(data["records"][intent_path])
    control = data["control"]
    ledger_volume = control.volume if private_ledger else "ledger-history-test"
    intent["preserved_group_ledger_volume"] = ledger_volume
    ledger_fields = {}
    if private_ledger:
        subpath = control.namespace + "/private/ledger"
        archive["mapping"] = history._archive_mapping(data["recreation_attempt"], private_ledger=True)
        intent.update(preserved_group_ledger_subpath=subpath, mapping=archive["mapping"])
        archive["preserved_group_ledger_subpath"] = subpath
        ledger_fields = {"preserved_subpath": subpath, "archived_group_ledger_path": archive["mapping"]["archived_group_ledger"]}
    data["records"][intent_path] = raw(intent)
    archive.update(preserved_group_ledger_volume=ledger_volume,
                   intent_sha256=sha(raw(intent)))
    data["records"][archive_path] = raw(archive)
    data["records"]["group-ledger-generation.json"] = raw({
        "schema": "fullmag.docker-group-ledger-generation.v1", "compose_project": data["control"].project,
        "generation": data["recreation_attempt"], "archive_terminal_path": archive_path,
        "archive_terminal_sha256": sha(canonical(archive)), "preserved_volume": ledger_volume,
        **ledger_fields,
    })
    refresh_retirement(data)
    return data


def refresh_retirement(data):
    rec_root = "recreate-services/attempts/" + data["recreation_attempt"]
    recreation_raw = raw(data["recreation"])
    data["recreation_sha256"] = sha(recreation_raw)
    data["records"][rec_root + "/terminal.json"] = recreation_raw
    data["records"][rec_root + "/receipt.json"] = recreation_raw


class RecreatedHistoryTests(unittest.TestCase):
    def _validate(self, data):
        def read_raw(_control, path, optional=False):
            if path in data["records"]:
                return data["records"][path]
            if optional:
                return None
            raise BuildControlError("missing fixture record: " + path)

        with patch.object(history, "read_raw", side_effect=read_raw):
            return history.validate_recreated_history(
                data["control"], recreation_attempt=data["recreation_attempt"],
                recreation_sha256=data["recreation_sha256"], failed_attempt=data["failed_attempt"],
                original=data["original"], publications=data["publications"], attempts=data["attempts"],
            )

    def test_valid_recreated_failure_binds_archived_owner_and_preserves_old_pointers(self):
        data = fixture()
        before = deepcopy((data["publications"], data["records"]))
        proof = self._validate(data)
        self.assertEqual(data["publications"], before[0])
        self.assertEqual(data["records"], before[1])
        self.assertEqual(proof["previous_development_attempt"], "6" * 32)
        self.assertEqual(proof["failed_attempt"], "8" * 32)
        self.assertEqual(proof["native_build_commit"], "a" * 40)
        self.assertEqual(proof["source_mode"], "live-shadow-v1")
        self.assertEqual(proof["retained_records"]["development/current.json"],
                         sha(data["publications"]["development/current.json"]))
        self.assertEqual(proof["retained_records"]["development/verified.json"],
                         sha(data["publications"]["development/verified.json"]))
        self.assertNotIn("development/attempts/" + data["failed_attempt"] + "/terminal.json",
                         proof["retained_records"])
        self.assertIsNone(proof["retained_records"]["runtime-control/runtime-services/OWNER.json"])
        self.assertIsNone(proof["retained_records"]["runtime-control/runtime-service/process-tree.json"])
        self.assertLessEqual(len(proof["retained_records"]), history.MAX_RETAINED_RECORDS)

    def test_retired_group_admits_failure_only_with_drained_pair_and_older_terminal(self):
        data = retirement_fixture()
        proof = self._validate(data)
        self.assertEqual(proof["mode"], "retired-drained-runtime-archive")
        self.assertEqual(proof["retirement_native_drain_sha256"],
                         data["recreation"]["retirement_native_drain_sha256"])
        terminal_path = "development/attempts/" + "3" * 32 + "/terminal.json"
        self.assertEqual(proof["retained_records"][terminal_path], sha(data["records"][terminal_path]))

    def test_retirement_rejects_mutated_drain_or_live_pair(self):
        for change in ("drain", "pair"):
            with self.subTest(change=change):
                data = retirement_fixture()
                root = "recreate-services/attempts/" + data["recreation_attempt"]
                if change == "drain":
                    data["records"][root + "/retirement-native-drain.json"] = raw({})
                else:
                    path = root + "/retained-containers.json"
                    pair = json.loads(data["records"][path])
                    pair["backend"]["State"]["Running"] = True
                    data["records"][path] = raw(pair)
                with self.assertRaises(BuildControlError):
                    self._validate(data)

    def test_retirement_rejects_ambiguous_earlier_history(self):
        data = retirement_fixture()
        path = "development/attempts/" + "3" * 32 + "/terminal.json"
        earlier = json.loads(data["records"][path])
        earlier["finished_at"] = 25
        data["records"][path] = raw(earlier)
        with self.assertRaises(BuildControlError):
            self._validate(data)

    def test_retirement_accepts_same_physical_runtime_parent_and_private_ledger(self):
        data = retirement_fixture(private_ledger=True)
        failed = data["failed_attempt"]
        data["original"]["state_root"] = "/alternate/docker-volume-dev/" + failed
        data["records"]["development/attempts/" + failed + "/receipt.json"] = raw(data["original"])
        with patch.object(history, "_runtime_parent_identity", return_value=(860, 171)) as observe:
            proof = self._validate(data)
        self.assertEqual(proof["runtime_parent_device_inode"], [860, 171])
        self.assertEqual([call.args[0] for call in observe.call_args_list], [
            PurePosixPath("/runtime/docker-volume-dev"), PurePosixPath("/alternate/docker-volume-dev"),
        ])
        self.assertIn("group-ledger-generation.json", proof["retained_records"])
        with patch.object(history, "_runtime_parent_identity", side_effect=[(860, 171), (861, 171)]):
            with self.assertRaisesRegex(BuildControlError, "not an alias"):
                self._validate(data)

    def test_runtime_parent_identity_checks_real_directory_and_rejects_symlink(self):
        with TemporaryDirectory() as root:
            root = Path(root).resolve()
            parent = root / "runtime"
            parent.mkdir()
            info = parent.stat()
            self.assertEqual(history._runtime_parent_identity(parent), (info.st_dev, info.st_ino))
            alias = root / "alias"
            alias.symlink_to(parent, target_is_directory=True)
            with self.assertRaisesRegex(BuildControlError, "symbolic link"):
                history._runtime_parent_identity(alias)

    def test_changed_recreation_pin_and_old_verified_pointer_are_refused(self):
        data = fixture()
        data["recreation_sha256"] = "0" * 64
        with self.assertRaises(BuildControlError):
            self._validate(data)
        data = fixture()
        data["publications"]["development/verified.json"] = raw({"attempt": "foreign"})
        with self.assertRaises(BuildControlError):
            self._validate(data)

    def test_target_terminal_owner_or_archived_native_build_mismatch_is_refused(self):
        data = fixture()
        data["publications"]["development/attempts/" + data["failed_attempt"] + "/terminal.json"] = raw({})
        with self.assertRaises(BuildControlError):
            self._validate(data)
        data = fixture()
        archived_path = "runtime-archives/" + data["recreation_attempt"] + "/runtime-service/process-tree.json"
        changed = deepcopy(data["process"])
        changed["service_owner"]["build_snapshot"] = "0" * 64
        data["records"][archived_path] = raw(changed)
        with self.assertRaises(BuildControlError):
            self._validate(data)
        data = fixture()
        data["recreation"]["inputs"]["prelaunch_failure_stop"]["terminal_sha256"] = "0" * 64
        data["records"]["recreate-services/attempts/" + data["recreation_attempt"] + "/terminal.json"] = raw(data["recreation"])
        data["records"]["recreate-services/attempts/" + data["recreation_attempt"] + "/receipt.json"] = raw(data["recreation"])
        data["recreation_sha256"] = sha(raw(data["recreation"]))
        with self.assertRaises(BuildControlError):
            self._validate(data)

    def test_runtime_provenance_must_match_drained_native_identity(self):
        data = fixture()
        document = json.loads(data["publications"]["backend/runtime-provenance.json"])
        document["native_source_identity"]["head_commit_full"] = "0" * 40
        document["native_source_identity_sha256"] = sha(raw(document["native_source_identity"]))
        data["publications"]["backend/runtime-provenance.json"] = raw(document)
        with self.assertRaises(BuildControlError):
            self._validate(data)

    def test_prelaunch_source_root_and_service_labels_match_producer_contract(self):
        data = fixture()
        stop = data["records"]["iteration/attempts/" + "b" * 32 + "/terminal.json"]
        stop_document = json.loads(stop)
        # Prelaunch stop inputs intentionally contain source_root but no source ID fields.
        history._stop_source_root(stop_document["inputs"], data["control"].identity)
        foreign = deepcopy(stop_document["inputs"])
        foreign["source_root"] = "/foreign/checkout"
        with self.assertRaises(BuildControlError):
            history._stop_source_root(foreign, data["control"].identity)

        intent_raw = data["records"]["iteration/attempts/" + "b" * 32
                                      + "/prelaunch-failure-quiescence-intent.json"]
        intent = json.loads(intent_raw)
        history._validate_quiescence_services(
            intent, data["control"].identity, ["1" * 64, "2" * 64]
        )
        intent["services"]["frontend"]["Config"]["Labels"]["org.fullmag.source.worktree-id"] = "foreign"
        with self.assertRaises(BuildControlError):
            history._validate_quiescence_services(
                intent, data["control"].identity, ["1" * 64, "2" * 64]
            )


if __name__ == "__main__":
    unittest.main()
