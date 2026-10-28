"""Unit coverage for managed offline control-lease repair."""
from __future__ import annotations

import base64
import hashlib
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
module = importlib.import_module("docker_volume_offline_reconcile")
from docker_build_control import BuildControlError, canonical

TOKEN = "a" * 32
OPERATION = "b" * 32
CONTAINER = "c" * 64
IMAGE = "sha256:" + "d" * 64
CONFIG = "e" * 64


def owner(state: str = "drained", *, children: tuple[str, str] = ("exited_success", "exited_success")) -> dict:
    return {
        "schema_version": "runtime_service_owner.v1", "state": state,
        "owner_token": "owner-token", "process_start_token": "start-token",
        "pid": 100, "host": "backend", "target_id": "docker-all", "protocol": "stdin-v1",
        "children": [
            {"pid": 101, "role": "compute", "status": children[0]},
            {"pid": 102, "role": "preparation", "status": children[1]},
        ],
    }


def process(state: str = "drained", *, service_owner: dict | None = None) -> dict:
    old = service_owner or {**owner("ready"), "children": [
        {"pid": 101, "role": "compute", "status": "running"},
        {"pid": 102, "role": "preparation", "status": "running"},
    ]}
    return {"schema": "fullmag.docker-process-tree.v1", "state": state,
            "runtime_pid": None, "service_owner": old}


def stopped(service: str, *, identifier: str = CONTAINER, running: bool = False) -> dict:
    return {
        "Id": identifier, "Image": IMAGE, "RestartCount": 2,
        "Config": {"Labels": {"com.docker.compose.project": "fullmag-demo",
                               "com.docker.compose.service": service}},
        "HostConfig": {"PidMode": "", "IpcMode": "private", "Privileged": False,
                       "NetworkMode": "fullmag-demo_fullmag", "Binds": []},
        "State": {"Status": "running" if running else "exited", "Running": running,
                  "Paused": False, "Restarting": False, "Dead": False,
                  "OOMKilled": False, "Pid": 123 if running else 0,
                  "StartedAt": "2026-10-27T00:00:00Z",
                  "FinishedAt": "2026-10-27T00:01:00Z", "ExitCode": 255},
        "NetworkSettings": {"Networks": {"fullmag-demo_fullmag": {"NetworkID": "e" * 64}}},
        "Mounts": [],
    }


class MemoryControl:
    project = "fullmag-demo"
    volume = "fullmag-demo-control"
    namespace = ""
    identity = {}

    def __init__(self, records: dict[str, bytes]):
        self.records = records

    def read_raw(self, relative: str, *, optional: bool = False):
        if relative in self.records:
            return self.records[relative]
        if optional:
            return None
        raise FileNotFoundError(relative)


def offline_fixture(*, phase: str = "iteration", active: bytes | None = None,
                    plan_extra: dict | None = None,
                    extra_pins: dict[str, bytes] | None = None):
    original = {
        "schema": module.OPERATION_SCHEMA, "phase": phase,
        "state": "outcome-unknown-resources-retained" if phase == "activation" else "starting",
        "attempt": TOKEN,
    }
    original_path = f"{phase}/attempts/{TOKEN}/receipt.json"
    terminal_path = f"{phase}/attempts/{TOKEN}/terminal.json"
    original_raw = canonical(original) + b"\n"
    old_active = (TOKEN + "\n").encode()
    records: dict[str, bytes] = {original_path: original_raw}
    control_pins = {"active": hashlib.sha256(old_active).hexdigest(),
                    original_path: hashlib.sha256(original_raw).hexdigest(),
                    terminal_path: None}
    for path, raw in (extra_pins or {}).items():
        records[path] = raw
        control_pins[path] = hashlib.sha256(raw).hexdigest()
    plan = {
        "schema": module.SCHEMA, "state": "planned", "phase": phase,
        "operation_attempt": OPERATION, "original_operation_attempt": TOKEN,
        "original_operation_receipt_path": original_path,
        "original_operation_receipt_sha256": hashlib.sha256(original_raw).hexdigest(),
        "original_operation_terminal_path": terminal_path,
        "original_operation_terminal_absent": True,
        "activation_outcome": "unknown-retained" if phase == "activation" else None,
        "iteration_outcome": "interrupted-retained" if phase == "iteration" else None,
        "compose_project": "fullmag-demo", "control_volume": "fullmag-demo-control",
        "control_pins": control_pins,
    }
    plan.update(plan_extra or {})
    plan["plan_sha256"] = hashlib.sha256(canonical(plan)).hexdigest()
    intent, receipt = module._operation_records(plan)
    records["offline-reconciliation/" + OPERATION + "/intent.json"] = canonical(intent) + b"\n"
    records["offline-reconciliation/" + OPERATION + "/receipt.json"] = canonical(receipt) + b"\n"
    records[module.CURRENT] = canonical(receipt) + b"\n"
    if active is not None:
        records["active"] = active
    return MemoryControl(records), plan, receipt


class RuntimeOwnerValidationTests(unittest.TestCase):
    def test_accepts_drained_owner_and_binds_its_historical_identity(self) -> None:
        evidence = module._validate_owner_process(owner(), process())
        self.assertEqual(evidence["owner_state"], "drained")
        self.assertEqual(evidence["process_state"], "drained")

    def test_accepts_failed_owner_only_with_terminal_children(self) -> None:
        evidence = module._validate_owner_process(
            owner("failed", children=("exited_success", "exited_failure")),
            process("failed_outcome_retained"),
        )
        self.assertEqual(evidence["owner_state"], "failed")
        with self.assertRaises(BuildControlError):
            module._validate_owner_process(owner("failed", children=("running", "exited_success")),
                                           process("failed_outcome_retained"))

    def test_rejects_ready_owner_and_mismatched_process_identity(self) -> None:
        with self.assertRaises(BuildControlError):
            module._validate_owner_process(owner("ready"), process())
        mismatched = process(service_owner={**process()["service_owner"], "owner_token": "other"})
        with self.assertRaises(BuildControlError):
            module._validate_owner_process(owner(), mismatched)


class StoppedPairTests(unittest.TestCase):
    def test_accepts_actual_stopped_incarnation_even_after_restart(self) -> None:
        pair = {"backend": stopped("backend"), "frontend": stopped("frontend", identifier="f" * 64)}
        evidence = module._validate_stopped_pair(pair, expected_ids={"backend": CONTAINER,
                                                                     "frontend": "f" * 64},
                                                  project="fullmag-demo", image_id=IMAGE)
        self.assertEqual(evidence["backend"]["restart_count"], 2)
        self.assertEqual(evidence["backend"]["pid"], 0)

    def test_rejects_active_consumer_and_mismatched_incarnation(self) -> None:
        with self.assertRaises(BuildControlError):
            module._validate_stopped_pair(
                {"backend": stopped("backend", running=True),
                 "frontend": stopped("frontend", identifier="f" * 64)},
                expected_ids={"backend": CONTAINER, "frontend": "f" * 64},
                project="fullmag-demo", image_id=IMAGE)
        with self.assertRaises(BuildControlError):
            module._validate_stopped_pair(
                {"backend": stopped("backend", identifier="1" * 64),
                 "frontend": stopped("frontend", identifier="f" * 64)},
                expected_ids={"backend": CONTAINER, "frontend": "f" * 64},
                project="fullmag-demo", image_id=IMAGE)

    def test_rejects_host_pid_or_socket_mount(self) -> None:
        row = stopped("backend")
        row["HostConfig"]["PidMode"] = "host"
        with self.assertRaises(BuildControlError):
            module._validate_container(row, container_id=CONTAINER, service="backend",
                                       project="fullmag-demo", image_id=IMAGE)
        row = stopped("backend")
        row["Mounts"] = [{"Source": "/var/run/docker.sock", "Destination": "/run/docker.sock"}]
        with self.assertRaises(BuildControlError):
            module._validate_container(row, container_id=CONTAINER, service="backend",
                                       project="fullmag-demo", image_id=IMAGE)

    def test_rejects_foreign_private_network_consumer(self) -> None:
        row = {"Name": "fullmag-demo_fullmag", "Id": "f" * 64, "Driver": "bridge",
               "Labels": {"com.docker.compose.project": "fullmag-demo",
                          "com.docker.compose.network": "fullmag"},
               "Containers": {CONTAINER: {}, "1" * 64: {}}}
        with self.assertRaisesRegex(BuildControlError, "foreign consumer"):
            module._validate_private_network(
                row, project="fullmag-demo", network_name="fullmag-demo_fullmag",
                expected_network_label="fullmag", allowed_ids={CONTAINER, "2" * 64})

    def test_malformed_private_network_is_rejected_as_build_control_error(self) -> None:
        with self.assertRaises(BuildControlError):
            module._validate_private_network(
                {"Name": "fullmag-demo_fullmag", "Id": "f" * 64, "Driver": "bridge",
                 "Labels": [], "Containers": {}},
                project="fullmag-demo", network_name="fullmag-demo_fullmag",
                expected_network_label="fullmag", allowed_ids={CONTAINER})


class StoreAndPhaseTests(unittest.TestCase):
    def test_control_record_reader_forces_readonly_mounts(self) -> None:
        class FakeControl:
            volume = "fullmag-demo-control"
            def helper_args(self, script: str) -> list[str]:
                return ["docker", "--mount", "type=volume,src=fullmag-demo-control,dst=/control,volume-nocopy",
                        "--mount", "type=volume,src=fullmag-demo-control,dst=/registry,readonly,volume-nocopy",
                        script]
        command = module._read_only_control_args(FakeControl(), "cat /control/current.json")
        self.assertIn("readonly", command[command.index("--mount") + 1].split(","))

    def test_terminal_catalogs_record_tasks_and_artifact_references(self) -> None:
        catalogs = [{"path": "runs/run-1/run_catalog.json", "document": {
            "schema_version": "run_catalog.v1", "run_id": "run-1", "revision": 4,
            "tasks": [{"task_id": "task-1", "lifecycle": "failed", "artifact_ids": ["art-1"]}],
        }}]
        result = module._validate_catalogs(catalogs)
        self.assertEqual(result[0]["tasks"][0]["artifact_ids"], ["art-1"])
        for lifecycle in ("accepted", "queued", "running"):
            bad = [{"path": "runs/run-1/run_catalog.json", "document": {
                "schema_version": "run_catalog.v1", "run_id": "run-1", "revision": 4,
                "tasks": [{"task_id": "task-1", "lifecycle": lifecycle}],
            }}]
            with self.subTest(lifecycle=lifecycle), self.assertRaises(BuildControlError):
                module._validate_catalogs(bad)

    def test_resource_lease_paths_require_released_state(self) -> None:
        active_solver = {"schema_version": "resource_lease.v1", "run_id": "run-1",
                         "resource_id": "gpu", "lease_token": "token-1", "state": "active"}
        with self.assertRaisesRegex(BuildControlError, "nonreleased resource lease"):
            module._validate_store_leases(
                "runs/run-1/resource_leases/gpu/token-1.json", active_solver)
        module._validate_store_leases(
            "runs/run-1/resource_leases/gpu/token-1.json", {**active_solver, "state": "released"})
        active_preparation = {"schema_version": "preparation_resource_lease.v1", "run_id": "run-1",
                              "resource_id": "meshing", "lease_token": "token-2", "state": "active"}
        with self.assertRaisesRegex(BuildControlError, "nonreleased resource lease"):
            module._validate_store_leases(
                "runs/run-1/preparation_resource_leases/meshing/token-2.json", active_preparation)
        module._validate_store_leases(
            "runs/run-1/preparation_resource_leases/meshing/token-2.json",
            {**active_preparation, "state": "released"})

    def test_start_release_metadata_and_released_native_leases_inventory_together(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "WRITER.owner.json").write_bytes(canonical(
                {"schema": "fullmag.writer.v1", "released": True}) + b"\n")
            (root / "WRITER.lock").write_bytes(b"")
            run = root / "runs" / "run-1"
            run.mkdir(parents=True)

            def write(relative: str, document: dict) -> None:
                path = run / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(canonical(document) + b"\n")

            write("run_catalog.json", {"schema_version": "run_catalog.v1", "run_id": "run-1",
                                        "revision": 4, "tasks": [{"task_id": "task-1",
                                        "lifecycle": "failed", "artifact_ids": []}]})
            write("start_release.json", {"schema_version": "accepted_run_start_release.v1",
                                          "run_id": "run-1", "task_id": "task-1"})
            write("resource_leases/gpu/token-1.json", {
                "schema_version": "resource_lease.v1", "run_id": "run-1",
                "resource_id": "gpu", "lease_token": "token-1", "state": "released"})
            write("preparation_resource_leases/meshing/token-2.json", {
                "schema_version": "preparation_resource_lease.v1", "run_id": "run-1",
                "resource_id": "meshing", "lease_token": "token-2", "state": "released"})
            inventory = module._inventory_store(root)
            self.assertEqual([run_summary["run_id"] for run_summary in inventory["runs"]], ["run-1"])
            self.assertEqual(inventory["file_count"], 6)
            self.assertEqual(inventory["metadata_file_count"], 5)
            lease_path = run / "resource_leases" / "gpu" / "token-1.json"
            active_lease = json.loads(lease_path.read_bytes())
            active_lease["state"] = "active"
            lease_path.write_bytes(canonical(active_lease) + b"\n")
            with self.assertRaisesRegex(BuildControlError, "nonreleased resource lease"):
                module._inventory_store(root)

    def test_resource_lease_paths_require_family_schema_and_canonical_shape(self) -> None:
        with self.assertRaisesRegex(BuildControlError, "schema"):
            module._validate_store_leases(
                "runs/run-1/resource_leases/gpu/token-1.json",
                {"schema_version": "preparation_resource_lease.v1", "run_id": "run-1",
                 "resource_id": "gpu", "lease_token": "token-1", "state": "released"})
        with self.assertRaisesRegex(BuildControlError, "identity"):
            module._validate_store_leases(
                "runs/run-1/resource_leases/gpu/token-1.json",
                {"schema_version": "resource_lease.v1", "run_id": "run-1",
                 "resource_id": "other", "lease_token": "token-1", "state": "released"})


class ProjectInventoryScopeTests(unittest.TestCase):
    def test_selected_inventory_is_stable_as_unrelated_container_ids_change(self) -> None:
        pair = [CONTAINER, "f" * 64]
        helper_id = "3" * 64
        first = module._scope_container_inventory(
            [*pair, helper_id, "1" * 64], pair, helper_id=helper_id)
        second = module._scope_container_inventory(
            [*pair, helper_id, "2" * 64, "4" * 64], pair, helper_id=helper_id)
        self.assertEqual(first, sorted([*pair, helper_id]))
        self.assertEqual(second, first)

    def test_selected_inventory_requires_pair_and_authenticated_helper_ids(self) -> None:
        pair = [CONTAINER, "f" * 64]
        helper_id = "3" * 64
        with self.assertRaisesRegex(BuildControlError, "Selected pair/helper"):
            module._scope_container_inventory([pair[0], helper_id], pair, helper_id=helper_id)
        with self.assertRaisesRegex(BuildControlError, "Selected pair/helper"):
            module._scope_container_inventory(pair, pair, helper_id=helper_id)

    def test_global_inventory_still_rejects_foreign_protected_volume_consumers(self) -> None:
        from unittest.mock import patch
        from docker_volume_empty_quarantine import _project_inventory
        backend, frontend, foreign = CONTAINER, "f" * 64, "1" * 64
        control = SimpleNamespace(project="fullmag-demo")
        rows = [
            {"Id": backend, "Name": "/fullmag-demo-backend",
             "Config": {"Labels": {"com.docker.compose.project": control.project}},
             "Mounts": [], "HostConfig": {"Mounts": []}},
            {"Id": frontend, "Name": "/fullmag-demo-frontend",
             "Config": {"Labels": {"com.docker.compose.project": control.project}},
             "Mounts": [], "HostConfig": {"Mounts": []}},
            {"Id": foreign, "Name": "/another-group-backend",
             "Config": {"Labels": {"com.docker.compose.project": "another-group"}},
             "Mounts": [{"Name": "protected-control"}], "HostConfig": {"Mounts": []}},
        ]
        outputs = [
            SimpleNamespace(returncode=0, stdout=("\n".join([backend, frontend, foreign])).encode(), stderr=b""),
            SimpleNamespace(returncode=0, stdout=json.dumps(rows).encode(), stderr=b""),
        ]
        with patch("docker_volume_empty_quarantine.docker_capture", side_effect=outputs):
            with self.assertRaisesRegex(BuildControlError, "another consumer"):
                _project_inventory(
                    control, {"backend": {"id": backend}, "frontend": {"id": frontend}},
                    protected_volumes={"protected-control"}, state_root=Path("/workspace/state"),
                    ledger_volume="protected-ledger")

    def _invoke_compose_pair(self, project: str, *, bridge_state: str,
                             frontend_port: int = 3198, backend_ipc: str | None = "private",
                             include_ipc: bool = True):
        from unittest.mock import patch
        import docker_dev_up
        from docker_compose_identity import compose_network_name

        project = "fullmag-worktree-" + "a" * 80
        network_name = compose_network_name(project)
        frontend_id = "f" * 64
        frontend_image = "sha256:" + "9" * 64
        control = SimpleNamespace(project=project, volume=project + "-control")
        identity = {"project_name": project, "network_name": network_name,
                    "project_id": "project-id", "worktree_id": "worktree-id",
                    "checkout_kind": "worktree", "source_root": "/source"}
        backend = stopped("backend")
        frontend = stopped("frontend", identifier=frontend_id)
        for service, row in (("backend", backend), ("frontend", frontend)):
            row["Config"]["Labels"]["com.docker.compose.project"] = project
            row["HostConfig"]["NetworkMode"] = network_name
            if include_ipc:
                row["HostConfig"]["IpcMode"] = backend_ipc if service == "backend" else "private"
            else:
                row["HostConfig"].pop("IpcMode", None)
            row["NetworkSettings"]["Networks"] = {network_name: {"NetworkID": "8" * 64}}
        frontend["Image"] = frontend_image
        frontend["HostConfig"]["PortBindings"] = {
            "8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(frontend_port)}],
        }
        network = {"Name": network_name, "Id": "8" * 64, "Driver": "bridge",
                   "Labels": {"com.docker.compose.project": project,
                              "com.docker.compose.network": "fullmag"},
                   "Containers": {}}
        document = {"services": {"backend": {"image": "backend-ref"},
                                  "frontend": {"image": "frontend-ref"}},
                    "volumes": {}}
        development = {"backend_container": CONTAINER, "frontend_container": frontend_id,
                       "inputs": {"image_id": IMAGE}}

        def docker_result(value):
            return SimpleNamespace(returncode=0, stdout=json.dumps(value).encode(), stderr=b"")

        def inspect(*arguments, **_kwargs):
            if arguments[0] == "inspect":
                return docker_result([backend, frontend])
            if arguments[:2] == ("image", "inspect"):
                image_id = IMAGE if arguments[-1] == "backend-ref" else frontend_image
                return docker_result([{"Id": image_id, "Config": {}}])
            if arguments[:2] == ("network", "ls"):
                rows = [{"ID": "8" * 64, "Name": network_name}] if bridge_state == "owned-bridge" else []
                return SimpleNamespace(returncode=0,
                                       stdout=("\n".join(json.dumps(row) for row in rows) + "\n").encode(),
                                       stderr=b"")
            if arguments[:2] == ("network", "inspect"):
                if bridge_state == "absent":
                    return SimpleNamespace(
                        returncode=1, stdout=b"",
                        stderr=f"Error response from daemon: network {arguments[-1]} not found".encode(),
                    )
                return docker_result([network])
            raise AssertionError(arguments)

        def compose(_document, *_arguments):
            service = _arguments[-1]
            return (CONTAINER if service == "backend" else frontend_id).encode()

        with patch.object(module, "docker_capture", side_effect=inspect), \
                patch.object(module, "compose_capture", side_effect=compose), \
                patch("docker_compose_identity.validate_source_labels"), \
                patch("docker_volume_dev._validate_retained_service"), \
                patch("docker_volume_empty_quarantine._project_inventory",
                      return_value=[CONTAINER, frontend_id]), \
                patch("docker_dev_defaults._document_port", return_value=3198), \
                patch.object(docker_dev_up, "docker_capture", side_effect=inspect), \
                patch.object(docker_dev_up, "_validate_retained_network",
                             wraps=docker_dev_up._validate_retained_network) as validate_network:
            evidence, _pair, inventory = module._compose_pair(
                document, identity, control, development, state_root=Path("/workspace/state"),
                ledger_volume="group-ledger")
        return evidence, inventory, validate_network, network_name

    def test_transaction_helper_authenticates_windows_bind_alias_and_access(self) -> None:
        from copy import deepcopy
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = str(root)
            if os.name == "nt":
                source = "/run/desktop/mnt/host/" + root.drive[0].lower() + root.as_posix()[2:]
            control = SimpleNamespace(project="fullmag-demo", volume="control-volume",
                                      image=IMAGE, labels={}, identity={},
                                      _namespace_guard=lambda value: value)
            host_mounts = [
                {"Type": "volume", "Source": "control-volume", "Target": "/control",
                 "ReadOnly": False, "VolumeOptions": {"NoCopy": True}},
                {"Type": "bind", "Source": source, "Target": "/store", "ReadOnly": True},
                {"Type": "volume", "Source": "ledger-volume", "Target": "/ledger",
                 "ReadOnly": True, "VolumeOptions": {"NoCopy": True}},
            ]
            row = {"Id": CONTAINER, "Name": "/helper", "Config": {
                "Image": IMAGE, "Entrypoint": ["/bin/bash"],
                "Cmd": ["-euo", "pipefail", "-c", "script"],
                "Labels": {"com.docker.compose.project": "fullmag-demo",
                           "com.docker.compose.service": "build-control"}},
                "State": {"Running": True, "Pid": 10},
                "HostConfig": {"NetworkMode": "none", "Privileged": False,
                               "ReadonlyRootfs": True, "CapDrop": ["ALL"],
                               "Binds": [], "Mounts": host_mounts},
                "Mounts": [
                    {"Destination": "/control", "Name": "control-volume", "RW": True},
                    {"Destination": "/store", "Source": source, "RW": False},
                    {"Destination": "/ledger", "Name": "ledger-volume", "RW": False},
                ]}
            def check(value):
                with patch.object(module, "docker_capture", return_value=SimpleNamespace(
                        stdout=json.dumps([value]).encode())), \
                        patch("docker_compose_identity.source_labels", return_value={}):
                    return module._inspect_transaction_helper(
                        control, "helper", "script", root, "ledger-volume")
            self.assertEqual(check(row), CONTAINER)
            for location, key in (("host", "Source"), ("runtime", "Source"),
                                  ("host", "ReadOnly"), ("runtime", "RW")):
                changed = deepcopy(row)
                mount = changed["HostConfig"]["Mounts"][1] if location == "host" else changed["Mounts"][1]
                mount[key] = str(root / "foreign") if key == "Source" else not mount[key]
                with self.subTest(location=location, key=key), self.assertRaises(BuildControlError):
                    check(changed)
            for bad_source in (None, "", "relative-store"):
                for location in ("host", "runtime"):
                    changed = deepcopy(row)
                    mount = changed["HostConfig"]["Mounts"][1] if location == "host" else changed["Mounts"][1]
                    mount["Source"] = bad_source
                    with self.subTest(location=location, source=bad_source), self.assertRaises(BuildControlError):
                        check(changed)

    def test_compose_pair_uses_canonical_hashed_network_for_long_project_name(self) -> None:
        project = "fullmag-worktree-" + "a" * 80
        evidence, inventory, validate_network, network_name = self._invoke_compose_pair(
            project, bridge_state="owned-bridge")
        self.assertEqual(validate_network.call_args.args[5], network_name)
        self.assertEqual(evidence["containers"]["backend"]["network_names"], [network_name])
        self.assertEqual(evidence["network"]["state"], "owned-bridge")
        self.assertEqual(evidence["network"]["network_id"], "8" * 64)
        self.assertEqual(inventory, sorted([CONTAINER, "f" * 64]))

    def test_compose_pair_records_shared_authoritative_absent_bridge_proof(self) -> None:
        evidence, inventory, validate_network, network_name = self._invoke_compose_pair(
            "fullmag-demo", bridge_state="absent")
        self.assertEqual(evidence["network"], {
            "name": network_name, "network_id": "8" * 64, "state": "absent",
        })
        validate_network.assert_not_called()
        self.assertEqual(inventory, sorted([CONTAINER, "f" * 64]))

    def test_bad_port_or_missing_ipc_evidence_rejects_absent_bridge_before_observation(self) -> None:
        from unittest.mock import patch
        import docker_stopped_network
        observer = docker_stopped_network.observe_stopped_bridge
        with patch.object(docker_stopped_network, "observe_stopped_bridge", wraps=observer) as observe:
            with self.assertRaisesRegex(BuildControlError, "exact loopback port"):
                self._invoke_compose_pair("fullmag-demo", bridge_state="absent", frontend_port=3197)
            observe.assert_not_called()
        with patch.object(docker_stopped_network, "observe_stopped_bridge", wraps=observer) as observe:
            with self.assertRaisesRegex(BuildControlError, "private-PID/private-IPC"):
                self._invoke_compose_pair("fullmag-demo", bridge_state="absent", include_ipc=False)
            observe.assert_not_called()

    def test_shared_observer_accepts_absence_only_after_authoritative_inspect_and_two_lists(self) -> None:
        from docker_stopped_network import observe_stopped_bridge
        project = "fullmag-demo"
        network_name = "fullmag-demo_fullmag"
        network_id = "8" * 64
        backend, frontend = stopped("backend"), stopped("frontend", identifier="f" * 64)
        for row in (backend, frontend):
            row["HostConfig"]["NetworkMode"] = network_name
            row["NetworkSettings"]["Networks"] = {network_name: {"NetworkID": network_id}}
        calls = []

        def capture(*arguments, **kwargs):
            calls.append((arguments, kwargs))
            if arguments[:2] == ("network", "ls"):
                return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
            if arguments[:2] == ("network", "inspect"):
                self.assertTrue(kwargs.get("allow_failure"))
                return SimpleNamespace(
                    returncode=1, stdout=b"",
                    stderr=f"Error response from daemon: network {network_id} not found".encode(),
                )
            raise AssertionError(arguments)

        result = observe_stopped_bridge(
            backend, frontend, project, capture=capture,
            validate_owned_bridge=lambda *_: self.fail("absent bridge must not run owned validation"),
        )
        self.assertEqual(result, {"name": network_name, "network_id": network_id, "state": "absent"})
        self.assertEqual(sum(call[0][:2] == ("network", "ls") for call in calls), 2)

    def test_live_plan_rejects_bridge_proof_change_before_offline_commit(self) -> None:
        from unittest.mock import patch
        pair_ids = sorted([CONTAINER, "f" * 64])
        helper_id = "3" * 64
        old_pair = {"containers": {}, "network": {
            "name": "fullmag-demo_fullmag", "network_id": "8" * 64, "state": "absent"}}
        changed_pair = {"containers": {}, "network": {
            "name": "fullmag-demo_fullmag", "network_id": "9" * 64, "state": "owned-bridge"}}
        context = {
            "plan": {"container_inventory_ids": pair_ids, "stopped_pair": old_pair,
                     "docker_engine_id": "engine"},
            "development": {}, "document": {}, "identity": {},
            "control": SimpleNamespace(project="fullmag-demo"),
            "state_root": Path("/workspace/state"), "ledger_volume": "group-ledger",
        }
        with patch.object(module, "_compose_pair",
                          return_value=(changed_pair, {}, sorted([*pair_ids, helper_id]))) as inspect_pair, \
                patch.object(module, "docker_capture",
                             return_value=SimpleNamespace(stdout=b"engine")):
            with self.assertRaisesRegex(BuildControlError, "Stopped service incarnation/network changed"):
                module._current_live_plan(context, "fullmag-control-offline-test", helper_id)
        self.assertEqual(inspect_pair.call_args.kwargs["helper_id"], helper_id)

    def test_stopped_services_keep_port_and_private_ipc_checks_without_a_bridge(self) -> None:
        backend, frontend = stopped("backend"), stopped("frontend", identifier="f" * 64)
        frontend["HostConfig"]["PortBindings"] = {
            "8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3198"}],
        }
        pair = {"backend": backend, "frontend": frontend}
        module._validate_stopped_service_exposure(
            pair, network_name="fullmag-demo_fullmag", port=3198)
        frontend["HostConfig"]["PortBindings"] = {
            "8080/tcp": [{"HostIp": "0.0.0.0", "HostPort": "3198"}],
        }
        with self.assertRaisesRegex(BuildControlError, "exact loopback port"):
            module._validate_stopped_service_exposure(
                pair, network_name="fullmag-demo_fullmag", port=3198)
        frontend["HostConfig"]["PortBindings"] = {
            "8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3198"}],
        }
        backend["HostConfig"]["IpcMode"] = "host"
        with self.assertRaisesRegex(BuildControlError, "private-PID/private-IPC"):
            module._validate_stopped_pair(
                pair, expected_ids={"backend": CONTAINER, "frontend": "f" * 64},
                project="fullmag-demo", image_id=IMAGE)
        for ipc_mode in (None, "missing"):
            with self.subTest(ipc_mode=ipc_mode):
                invalid_backend = stopped("backend")
                if ipc_mode == "missing":
                    invalid_backend["HostConfig"].pop("IpcMode")
                else:
                    invalid_backend["HostConfig"]["IpcMode"] = None
                with self.assertRaisesRegex(BuildControlError, "private-PID/private-IPC"):
                    module._validate_stopped_pair(
                        {"backend": invalid_backend, "frontend": frontend},
                        expected_ids={"backend": CONTAINER, "frontend": "f" * 64},
                        project="fullmag-demo", image_id=IMAGE)

    def test_rejects_unknown_or_terminal_marker_phase(self) -> None:
        with self.assertRaises(BuildControlError):
            module._validate_operation_phase({"phase": "development", "state": "starting"})
        with self.assertRaises(BuildControlError):
            module._validate_operation_phase({"phase": "activation", "state": "succeeded"})
        self.assertEqual(module._validate_operation_phase(
            {"phase": "activation", "state": "outcome-unknown-resources-retained"}), "activation")
        self.assertEqual(module._validate_operation_phase(
            {"phase": "iteration", "state": "starting"}), "iteration")

    def test_plan_digest_must_match_expected_sha(self) -> None:
        with self.assertRaises(BuildControlError):
            module._require_plan_sha("0" * 64, "1" * 64)
        module._require_plan_sha("1" * 64, "1" * 64)


class ActivationMarkerAbsenceTests(unittest.TestCase):
    def test_absent_activation_marker_is_pinned_as_absent_without_fabrication(self) -> None:
        from unittest.mock import patch
        control = MemoryControl({})
        record = {
            "phase": "activation", "request_id": "request-1",
            "inputs": {"activation_receipt_path": "/opt/fullmag/control/runtime-control/activation/marker.json"},
        }
        with patch.object(module, "_confirm_control_file_absent") as confirm:
            relative, raw = module._activation_marker(control, record)
        self.assertEqual(relative, "runtime-control/activation/marker.json")
        self.assertIsNone(raw)
        confirm.assert_called_once_with(control, relative)

    def test_control_reader_errors_include_helper_return_code(self) -> None:
        from unittest.mock import patch
        class ReaderControl:
            volume = "fullmag-demo-control"
            def path(self, relative: str) -> str:
                return "/control/" + relative
            def helper_args(self, script: str) -> list[str]:
                return ["docker", "--mount", "type=volume,src=fullmag-demo-control,dst=/control,volume-nocopy", script]
        with patch.object(module, "bounded_capture", return_value=SimpleNamespace(
                returncode=45, stderr=b"permission denied", stdout=b"")):
            with self.assertRaisesRegex(BuildControlError, "returncode 45"):
                module._control_raw(ReaderControl(), "active")

    def test_missing_marker_uses_canonical_44_then_stat_absence_probe(self) -> None:
        from unittest.mock import patch
        class ReaderControl:
            volume = "fullmag-demo-control"
            def path(self, relative: str) -> str:
                return "/control/" + relative
            def helper_args(self, script: str) -> list[str]:
                return ["docker", "--mount", "type=volume,src=fullmag-demo-control,dst=/control,volume-nocopy", script]
        control = ReaderControl()
        with patch.object(module, "bounded_capture", return_value=SimpleNamespace(
                returncode=44, stderr=b"", stdout=b"")):
            self.assertIsNone(module._control_raw(control, "runtime-control/marker.json", optional=True))
        with patch.object(module, "bounded_capture", return_value=SimpleNamespace(
                returncode=0, stderr=b"", stdout=b"")) as capture:
            module._confirm_control_file_absent(control, "runtime-control/marker.json")
        command = capture.call_args.args[0]
        self.assertIn("check_component /control/runtime-control 0", command[-1])
        self.assertIn("stat -c %F -- \"$path\"", command[-1])
        self.assertIn('test -r "$path"', command[-1])

    def test_absence_probe_accepts_missing_intermediate_component(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "control"
            root.mkdir()
            script = module._control_absence_probe_script(
                "runtime-control/activation/marker.json", root=str(root))
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                    capture_output=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_absence_probe_accepts_missing_leaf_beneath_accessible_parents(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "control"
            (root / "runtime-control" / "activation").mkdir(parents=True)
            script = module._control_absence_probe_script(
                "runtime-control/activation/marker.json", root=str(root))
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                    capture_output=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_absence_probe_rejects_present_leaf_and_symlink_ancestor(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "control"
            parent = root / "runtime-control" / "activation"
            parent.mkdir(parents=True)
            target = parent / "marker.json"
            target.write_bytes(b"present")
            script = module._control_absence_probe_script(
                "runtime-control/activation/marker.json", root=str(root))
            present = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                     capture_output=True, check=False)
            self.assertNotEqual(present.returncode, 0)
            target.unlink()
            outside = Path(temp) / "outside"
            outside.mkdir()
            (root / "runtime-control").rename(root / "runtime-control-real")
            (root / "runtime-control").symlink_to(outside, target_is_directory=True)
            symlinked = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                       capture_output=True, check=False)
            self.assertNotEqual(symlinked.returncode, 0)

    def test_absence_probe_rejects_inaccessible_and_non_directory_ancestors(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "control"
            (root / "runtime-control").mkdir(parents=True)
            parent = root / "runtime-control"
            script = module._control_absence_probe_script(
                "runtime-control/activation/marker.json", root=str(root))
            parent.chmod(0)
            try:
                inaccessible = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                               capture_output=True, check=False)
                self.assertNotEqual(inaccessible.returncode, 0)
            finally:
                parent.chmod(0o700)
            parent.rmdir()
            parent.write_bytes(b"not-a-directory")
            non_directory = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                           capture_output=True, check=False)
            self.assertNotEqual(non_directory.returncode, 0)


class DurableTransactionTests(unittest.TestCase):
    def test_locked_transaction_resumes_after_intent_and_after_marker_release(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "control"
            root.mkdir()
            (root / "operation.lock").write_bytes(b"")
            active = root / "active"
            active_raw = (TOKEN + "\n").encode()
            active.write_bytes(active_raw)
            pinned = root / "development" / "current.json"
            pinned.parent.mkdir()
            pinned.write_bytes(b'{"attempt":"old"}\n')
            intent = {"schema": module.SCHEMA, "kind": "intent", "operation_attempt": OPERATION}
            receipt = {"schema": module.SCHEMA, "kind": "receipt", "state": "completed",
                       "operation_attempt": OPERATION, "plan_sha256": "2" * 64}
            script, preamble = module._transaction_script(
                control_root=root,
                active_token=TOKEN,
                active_sha256=hashlib.sha256(active_raw).hexdigest(),
                pins={"active": hashlib.sha256(active_raw).hexdigest(),
                      "development/current.json": hashlib.sha256(pinned.read_bytes()).hexdigest()},
                intent=intent, receipt=receipt,
            )
            # This is the durable state left by a crash after publishing intent.
            intent_path = root / "offline-reconciliation" / OPERATION / "intent.json"
            intent_path.parent.mkdir(parents=True)
            intent_path.write_bytes(canonical(intent) + b"\n")
            first = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                   input=preamble + b"COMMIT\n", env=os.environ.copy(),
                                   capture_output=True, check=False)
            self.assertEqual(first.returncode, 0, first.stderr.decode())
            self.assertFalse(active.exists())
            receipt_raw = (canonical(receipt) + b"\n")
            self.assertEqual((intent_path.parent / "receipt.json").read_bytes(), receipt_raw)
            # A lost host acknowledgement after unlink is an exact no-op replay.
            second = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                    input=preamble + b"COMMIT\n", env=os.environ.copy(),
                                    capture_output=True, check=False)
            self.assertEqual(second.returncode, 0, second.stderr.decode())
            self.assertIn(b"ALREADY-COMPLETE", second.stdout)

    def test_transaction_rejects_changed_pinned_record(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "control"
            root.mkdir()
            (root / "operation.lock").write_bytes(b"")
            active_raw = (TOKEN + "\n").encode()
            (root / "active").write_bytes(active_raw)
            pinned = root / "pinned.json"
            pinned.write_bytes(b"old")
            script, preamble = module._transaction_script(
                control_root=root, active_token=TOKEN,
                active_sha256=hashlib.sha256(active_raw).hexdigest(),
                pins={"active": hashlib.sha256(active_raw).hexdigest(),
                      "pinned.json": hashlib.sha256(b"different").hexdigest()},
                intent={"schema": module.SCHEMA, "kind": "intent", "operation_attempt": OPERATION},
                receipt={"schema": module.SCHEMA, "kind": "receipt", "state": "completed",
                         "operation_attempt": OPERATION, "plan_sha256": "2" * 64},
            )
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                    input=preamble + b"COMMIT\n", env=os.environ.copy(),
                                    capture_output=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue((root / "active").exists())
            self.assertFalse((root / "offline-reconciliation").exists())

    def test_transaction_rejects_symlinked_reconciliation_parent_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "control"
            root.mkdir()
            (root / "operation.lock").write_bytes(b"")
            active_raw = (TOKEN + "\n").encode()
            (root / "active").write_bytes(active_raw)
            external = base / "external"
            external.mkdir()
            (root / "offline-reconciliation").symlink_to(external, target_is_directory=True)
            script, preamble = module._transaction_script(
                control_root=root, active_token=TOKEN,
                active_sha256=hashlib.sha256(active_raw).hexdigest(),
                pins={"active": hashlib.sha256(active_raw).hexdigest()},
                intent={"schema": module.SCHEMA, "kind": "intent", "operation_attempt": OPERATION},
                receipt={"schema": module.SCHEMA, "kind": "receipt", "state": "completed",
                         "operation_attempt": OPERATION, "plan_sha256": "2" * 64},
            )
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                    input=preamble + b"COMMIT\n", env=os.environ.copy(),
                                    capture_output=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(list(external.iterdir()), [])
            self.assertTrue((root / "active").exists())

    def test_large_proof_uses_bounded_argv_and_stdin_not_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "control"
            root.mkdir()
            (root / "operation.lock").write_bytes(b"")
            active_raw = (TOKEN + "\n").encode()
            (root / "active").write_bytes(active_raw)
            pins = {"active": hashlib.sha256(active_raw).hexdigest()}
            for index in range(10):
                relative = f"pinned/record-{index}.json"
                path = root / relative
                path.parent.mkdir(exist_ok=True)
                path.write_bytes(f"record-{index}".encode())
                pins[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
            proof = {"container_inventory": [
                {"id": f"{index + 1:064x}", "service": "backend" if index % 2 == 0 else "frontend",
                 "image": IMAGE, "started_at": "2026-10-27T00:00:00Z",
                 "finished_at": "2026-10-27T00:01:00Z", "exit_code": 255,
                 "compose_project": "fullmag-demo", "evidence": "x" * 390}
                for index in range(68)],
                "control_pins": [{"path": path, "sha256": digest}
                                 for path, digest in sorted(pins.items())]}
            intent = {"schema": module.SCHEMA, "kind": "intent",
                      "operation_attempt": OPERATION, "proof": proof}
            receipt = {"schema": module.SCHEMA, "kind": "receipt", "state": "completed",
                       "operation_attempt": OPERATION, "plan_sha256": "2" * 64, "proof": proof}
            script, preamble = module._transaction_script(
                control_root=root, active_token=TOKEN,
                active_sha256=hashlib.sha256(active_raw).hexdigest(), pins=pins,
                intent=intent, receipt=receipt)
            argv = ["bash", "-euo", "pipefail", "-c", script]
            argv_bytes = sum(len(argument.encode()) + 1 for argument in argv)
            self.assertGreater(len(preamble), 32767)
            self.assertLess(argv_bytes, 32767)
            self.assertNotIn(base64.b64encode(canonical(proof)), script.encode())
            child_env = os.environ.copy()
            payload_variables = {"FULLMAG_OFFLINE_INTENT_B64", "FULLMAG_OFFLINE_RECEIPT_B64",
                                 "FULLMAG_OFFLINE_CURRENT_B64"}
            self.assertFalse(payload_variables.intersection(child_env))
            argv_and_env = [argument.encode() for argument in argv]
            argv_and_env.extend(f"{name}={value}".encode() for name, value in child_env.items())
            for line in preamble.splitlines():
                self.assertFalse(any(line in value for value in argv_and_env))
            result = subprocess.run(argv, input=preamble + b"COMMIT\n", env=child_env,
                                    capture_output=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertFalse((root / "active").exists())
            self.assertEqual((root / "offline-reconciliation" / OPERATION / "receipt.json").read_bytes(),
                             canonical(receipt) + b"\n")

    def test_malformed_transaction_preamble_retains_active_marker(self) -> None:
        for malformed in (b"!malformed\n" + base64.b64encode(b"receipt") + b"\nCOMMIT\n",
                          b"A" * (module.MAX_OPERATION_RECORD_BYTES * 4 // 3 + 8) + b"\n"):
            with self.subTest(payload_length=len(malformed)), tempfile.TemporaryDirectory() as temp:
                root = Path(temp) / "control"
                root.mkdir()
                (root / "operation.lock").write_bytes(b"")
                active_raw = (TOKEN + "\n").encode()
                active = root / "active"
                active.write_bytes(active_raw)
                script, _preamble = module._transaction_script(
                    control_root=root, active_token=TOKEN,
                    active_sha256=hashlib.sha256(active_raw).hexdigest(),
                    pins={"active": hashlib.sha256(active_raw).hexdigest()},
                    intent={"schema": module.SCHEMA, "kind": "intent", "operation_attempt": OPERATION},
                    receipt={"schema": module.SCHEMA, "kind": "receipt", "state": "completed",
                             "operation_attempt": OPERATION, "plan_sha256": "2" * 64})
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                        input=malformed, capture_output=True, check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(b"LOCKED", result.stdout)
                self.assertTrue(active.exists())
                self.assertFalse((root / "offline-reconciliation").exists())


class PreparedRetryTests(unittest.TestCase):
    def test_published_pending_chain_is_verified_but_not_reported_complete(self) -> None:
        active = (TOKEN + "\n").encode()
        control, plan, _receipt = offline_fixture(active=active)
        self.assertIsNone(module._read_completed_or_prepared_retry(
            control, OPERATION, plan["plan_sha256"]))
        self.assertEqual(control.records["active"], active)

    def test_pending_retry_rejects_changed_original_active_cas(self) -> None:
        control, plan, _receipt = offline_fixture(active=("0" * 32 + "\n").encode())
        with self.assertRaisesRegex(BuildControlError, "active marker"):
            module._read_completed_or_prepared_retry(control, OPERATION, plan["plan_sha256"])

    def test_completed_receipt_is_returned_only_after_active_is_absent(self) -> None:
        control, plan, receipt = offline_fixture(active=None)
        result = module._read_completed_or_prepared_retry(control, OPERATION, plan["plan_sha256"])
        self.assertEqual(result, receipt)

    def test_public_apply_replays_transaction_after_publish_before_unlink_crash(self) -> None:
        from unittest.mock import patch
        active = (TOKEN + "\n").encode()
        control, plan, receipt = offline_fixture(active=active)
        args = SimpleNamespace(operation_attempt=OPERATION,
                               expected_plan_sha256=plan["plan_sha256"])
        context = {"control": control, "plan": plan}
        calls = []

        def replay(_context, _args):
            calls.append("transaction")
            self.assertEqual(control.records["active"], active)
            del control.records["active"]
            return receipt

        with patch.object(module, "_select_context",
                          return_value=(Path("/repo"), Path("/source"), {}, {}, control)), \
                patch.object(module, "_collect_context", return_value=context), \
                patch.object(module, "_run_transaction", side_effect=replay):
            result = module.apply(args)
        self.assertEqual(calls, ["transaction"])
        self.assertEqual(result, receipt)


def current_operation_fixture(control: MemoryControl, *, lease_attempt: str = "2" * 32) -> dict:
    inputs = {"attempt": "1" * 32, "config_sha256": CONFIG,
              "offline_reconciliation": OPERATION}
    receipt = {
        "schema": module.OPERATION_SCHEMA, "phase": "recreate-services",
        "state": "starting", "attempt": lease_attempt,
        "compose_project": control.project, "control_volume": control.volume,
        "helper_container": "fullmag-control-" + lease_attempt, "inputs": inputs,
        "offline_reconciliation": OPERATION,
    }
    persisted = dict(receipt)
    persisted.pop("offline_reconciliation")
    root = "recreate-services/attempts/" + lease_attempt
    control.records[root + "/receipt.json"] = canonical(persisted) + b"\n"
    control.records["active"] = (lease_attempt + "\n").encode()
    helper_id = "3" * 64
    operation = {"receipt": receipt, "root": root, "lease_ready": True,
                 "daemon_pending": False, "helper_container_id": helper_id}
    control._inspect_operation_helper = lambda candidate, *, expected_id=None: expected_id
    return operation


def recreation_resume_fixture():
    development_attempt = "1" * 32
    recreation_attempt = "2" * 32
    backend = stopped("backend")
    frontend = stopped("frontend", identifier="f" * 64)
    evidence = module._validate_stopped_pair(
        {"backend": backend, "frontend": frontend},
        expected_ids={"backend": CONTAINER, "frontend": "f" * 64},
        project="fullmag-demo", image_id=IMAGE,
    )
    state_root = "/runtime/fullmag/state"
    backend_volumes = {"fullmag-demo-backend-cache": "cache-volume"}
    development = {
        "schema": module.OPERATION_SCHEMA, "phase": "development", "state": "succeeded",
        "attempt": development_attempt, "backend_volumes": backend_volumes,
        "frontend_volume": "frontend-volume", "state_root": state_root,
    }
    development_raw = canonical(development) + b"\n"
    original_owner = canonical(owner()) + b"\n"
    original_process = canonical(process()) + b"\n"
    extra_pins = {
        "development/current.json": development_raw,
        f"development/attempts/{development_attempt}/terminal.json": development_raw,
        "runtime-control/runtime-services/OWNER.json": original_owner,
        "runtime-control/runtime-service/process-tree.json": original_process,
    }
    control, _plan, _offline_receipt = offline_fixture(
        phase="iteration", active=None,
        plan_extra={
            "development_attempt": development_attempt,
            "config_sha256": CONFIG,
            "state_root": state_root,
            "image_id": IMAGE,
            "stopped_pair": {"containers": evidence, "network": {"name": "fullmag-demo_fullmag"}},
        },
        extra_pins=extra_pins,
    )
    # Recreation may legitimately replace these two runtime-owner records.
    control.records["runtime-control/runtime-services/OWNER.json"] = canonical(owner("failed")) + b"\n"
    control.records["runtime-control/runtime-service/process-tree.json"] = canonical(
        process("failed_outcome_retained")
    ) + b"\n"
    operation = {
        "schema": module.OPERATION_SCHEMA, "phase": "recreate-services", "state": "succeeded",
        "attempt": recreation_attempt, "helper_container": "fullmag-control-" + recreation_attempt,
        "compose_project": control.project, "control_volume": control.volume,
        "fresh_state": False, "offline_reconciliation": OPERATION,
        "inputs": {"attempt": development_attempt, "config_sha256": CONFIG,
                   "offline_reconciliation": OPERATION},
        "previous_state_root": state_root, "removed_containers": [CONTAINER, "f" * 64],
        "retained_volumes": backend_volumes, "retained_frontend_volume": "frontend-volume",
    }
    terminal_raw = canonical(operation) + b"\n"
    root = "recreate-services/attempts/" + recreation_attempt
    control.records[root + "/terminal.json"] = terminal_raw
    control.records[root + "/receipt.json"] = terminal_raw
    control.records["recreate-services/current.json"] = terminal_raw
    control.records[root + "/retained-containers.json"] = canonical(
        {"backend": backend, "frontend": frontend}
    ) + b"\n"
    return control, operation


class RecreationResumeTests(unittest.TestCase):
    def test_resume_accepts_only_authorized_mutable_owner_and_process_updates(self) -> None:
        control, operation = recreation_resume_fixture()
        self.assertTrue(module.validate_recreate_resume(control, operation, OPERATION))

    def test_resume_still_rejects_changed_immutable_development_pin(self) -> None:
        control, operation = recreation_resume_fixture()
        control.records["development/current.json"] = canonical({"attempt": "9" * 32}) + b"\n"
        with self.assertRaisesRegex(BuildControlError, "Pinned original control record changed"):
            module.validate_recreate_resume(control, operation, OPERATION)

    def test_resume_requires_exact_retained_pair_and_offline_operation_input(self) -> None:
        control, operation = recreation_resume_fixture()
        bad_operation = dict(operation)
        bad_operation["inputs"] = {**operation["inputs"], "offline_reconciliation": "8" * 32}
        with self.assertRaises(BuildControlError):
            module.validate_recreate_resume(control, bad_operation, OPERATION)
        control, operation = recreation_resume_fixture()
        retained_path = "recreate-services/attempts/" + operation["attempt"] + "/retained-containers.json"
        retained = json.loads(control.records[retained_path])
        retained["backend"]["Id"] = "9" * 64
        control.records[retained_path] = canonical(retained) + b"\n"
        with self.assertRaises(BuildControlError):
            module.validate_recreate_resume(control, operation, OPERATION)


class LeasedRecreationValidationTests(unittest.TestCase):
    def test_current_operation_binds_receipt_active_helper_and_input_tokens(self) -> None:
        control = MemoryControl({})
        operation = current_operation_fixture(control)
        observed = module._validate_current_operation(
            control, operation, expected_operation_attempt=OPERATION,
            previous={"attempt": "1" * 32}, config_sha256=CONFIG,
        )
        self.assertEqual(observed["helper_id"], "3" * 64)
        for mutation in ("active", "root", "phase", "attempt", "offline-input"):
            altered = json.loads(json.dumps(operation))
            if mutation == "active":
                control.records["active"] = ("4" * 32 + "\n").encode()
            elif mutation == "root":
                altered["root"] = "recreate-services/attempts/" + "5" * 32
            elif mutation == "phase":
                altered["receipt"]["phase"] = "activation"
            elif mutation == "attempt":
                altered["receipt"]["attempt"] = "6" * 32
            else:
                altered["receipt"]["inputs"]["offline_reconciliation"] = "7" * 32
            with self.subTest(mutation=mutation), self.assertRaises(BuildControlError):
                module._validate_current_operation(
                    control, altered, expected_operation_attempt=OPERATION,
                    previous={"attempt": "1" * 32}, config_sha256=CONFIG,
                )
            control.records["active"] = (operation["receipt"]["attempt"] + "\n").encode()

    def test_recreate_validator_allows_only_passed_leased_operation(self) -> None:
        from unittest.mock import patch
        control, plan, _ = offline_fixture(active=(TOKEN + "\n").encode())
        operation = current_operation_fixture(control)
        with patch.object(module, "_revalidate_for_recreate", return_value=True) as revalidate:
            self.assertTrue(module.validate_for_recreate(
                control, {"attempt": "1" * 32}, {}, {}, "/source", CONFIG,
                expected_operation_attempt=OPERATION, current_operation=operation,
            ))
        self.assertEqual(revalidate.call_args.kwargs["current_operation"]["helper_id"], "3" * 64)

    def test_live_inventory_allows_unrelated_groups_but_requires_exact_helper(self) -> None:
        proof = {"container_inventory_ids": ["1" * 64, CONTAINER]}
        authorized = {"helper_id": "3" * 64}
        module._validate_container_inventory(sorted(["1" * 64, CONTAINER, "3" * 64, "4" * 64]),
                                             proof, authorized)
        with self.assertRaises(BuildControlError):
            module._validate_container_inventory(sorted(["1" * 64, CONTAINER]), proof, authorized)
        with self.assertRaises(BuildControlError):
            module._validate_container_inventory(sorted(["1" * 64, CONTAINER, "3" * 64]),
                                                 proof, None)


class ActivationFenceTests(unittest.TestCase):
    def test_activation_unknown_repair_remains_fenced_but_iteration_does_not(self) -> None:
        class FakeControl:
            project = "fullmag-demo"
            volume = "fullmag-demo-control"
            namespace = ""
            def __init__(self, phase: str):
                self.record = {"schema": module.SCHEMA, "state": "completed", "phase": phase,
                               "operation_attempt": OPERATION, "original_operation_attempt": TOKEN,
                               "original_operation_receipt_sha256": "3" * 64}
            def read_raw(self, relative: str, *, optional: bool = False):
                if relative == "offline-reconciliation/current.json":
                    return canonical(self.record) + b"\n"
                if relative == f"offline-reconciliation/{OPERATION}/receipt.json":
                    return canonical(self.record) + b"\n"
                if relative == f"{self.record['phase']}/attempts/{TOKEN}/receipt.json":
                    return b"original"
                if optional:
                    return None
                raise AssertionError(relative)
        from unittest.mock import patch
        with patch.object(module, "_read_any_completed", return_value={"phase": "activation"}), \
                self.assertRaisesRegex(BuildControlError, "unknown-retained"):
            module.assert_activation_allowed(FakeControl("activation"))
        with patch.object(module, "_read_any_completed", return_value={"phase": "iteration"}):
            self.assertIsNone(module.assert_activation_allowed(FakeControl("iteration")))


if __name__ == "__main__":
    unittest.main()
