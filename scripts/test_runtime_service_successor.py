from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


RUNTIME_PATH = Path(__file__).resolve().parents[1] / "docker" / "all-in-one" / "runtime_service.py"
SPEC = importlib.util.spec_from_file_location("runtime_service_successor", RUNTIME_PATH)
assert SPEC is not None and SPEC.loader is not None
runtime_service = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runtime_service
SPEC.loader.exec_module(runtime_service)


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


class ContainerRecoverySuccessorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.store = root / "store"
        self.runtime = self.store / "runtime-services"
        self.config_path = root / "runtime-control" / "runtime-service" / "docker-all.json"
        self.runtime.mkdir(parents=True)
        self.config_path.parent.mkdir(parents=True)
        self.paths = runtime_service.RuntimePaths(
            state=root,
            storage=root,
            runs=root / "runs",
            store=self.store,
            state_root=root / "runtime-control",
            runtime_services=self.runtime,
            config=self.config_path,
        )

        self.old_owner = self._owner(
            token="00000000-0000-4000-8000-000000000001",
            start="00000000-0000-4000-8000-000000000002",
            pid=100,
            generation=1,
            state="ready",
            child_status="running",
            child_pids=(101, 102),
        )
        self.successor = self._owner(
            token="00000000-0000-4000-8000-000000000003",
            start="00000000-0000-4000-8000-000000000004",
            pid=200,
            generation=2,
            state="ready",
            child_status="running",
            child_pids=(201, 202),
        )
        self.drained = {**self.successor, "state": "drained", "control_address": None,
                        "children": [
                            {**child, "status": "exited_success"}
                            for child in self.successor["children"]
                        ]}
        self.resources = {
            "compute_resources": [
                {
                    "resource_id": "docker-all.compute.cpu",
                    "kind": "cpu",
                    "budget": {
                        "cpu_millis": 1000,
                        "memory_bytes": 1024,
                        "gpu_memory_bytes": 0,
                        "storage_bytes": 1024,
                    },
                }
            ],
            "preparation_resources": [
                {
                    "resource_id": "docker-all.preparation.cpu",
                    "budget": {
                        "cpu_millis": 1000,
                        "memory_bytes": 1024,
                        "gpu_memory_bytes": 0,
                        "storage_bytes": 1024,
                    },
                }
            ],
        }
        self.config = {
            "schema_version": "runtime_service_config.v2",
            "store_root": str(self.store),
            "target_id": "docker-all",
            "compute_pool_id": "docker-all.compute",
            "preparation_pool_id": "docker-all.preparation",
            **self.resources,
            "host_execution": None,
        }
        self.config_raw = json_bytes(self.config)
        self.config_path.write_bytes(self.config_raw)
        for relative in (
            "runs",
            "manifests",
            "live_command_journals",
            "recovery",
            "temp",
            "objects/pins",
            "scheduler_pools",
        ):
            (self.store / relative).mkdir(parents=True, exist_ok=True)

        # The successor is a normal drained service after the initial
        # recovery.  Keep one cancelled run in the accepted store to prove
        # that history is retained and does not trigger the initial empty
        # namespace rule a second time.
        self.cancelled_run_id = "run-cancelled"
        cancelled_run = self.store / "runs" / self.cancelled_run_id
        cancelled_run.mkdir()
        specification = {"run_id": self.cancelled_run_id}
        payload = json.dumps(specification, sort_keys=True, separators=(",", ":")).encode()
        (cancelled_run / "run_intent.json").write_bytes(json_bytes({
            "schema_version": "run_intent.v1",
            "run_id": self.cancelled_run_id,
            "idempotency_key": "cancelled-submit",
            "payload_sha256": sha(payload),
            "accepted_at": "2026-10-19T00:00:00Z",
            "specification": specification,
        }))
        (cancelled_run / "run_catalog.json").write_bytes(json_bytes({
            "schema_version": "run_catalog.v1",
            "run_id": self.cancelled_run_id,
            "revision": 2,
            "updated_at": "2026-10-19T00:00:02Z",
            "tasks": [{
                "task_id": "task-cancelled",
                "input_fingerprint": "0" * 64,
                "lifecycle": "cancelled",
                "readiness": {"state": "ready"},
                "artifact_ids": [],
            }],
        }))

        self.request_sha = "a" * 64
        request = {
            "config_sha256": sha(self.config_raw),
            "owner_sha256": sha(json_bytes(self.old_owner)),
            "launch_sha256": "b" * 64,
            "ledger_snapshot_sha256": "c" * 64,
            "prior_ready_owner_proof_sha256": "d" * 64,
            "application": {"mode": "external_only", "raw_sha256": "e" * 64},
        }
        self.context = {
            "request": request,
            "authorization": {
                "owner_sha256": request["owner_sha256"],
                "config_sha256": request["config_sha256"],
            },
            "request_sha256": self.request_sha,
            "attestation_sha256": "f" * 64,
            "expected_owner": self.old_owner,
        }

        for source in runtime_service._container_recovery_expected_sources(self.old_owner):
            if source == "configuration.json":
                continue
            path = runtime_service._store_relative_path(self.paths, runtime_service.PurePosixPath(source))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((source + " old\n").encode())
        old_launch = {
            "schema_version": "runtime_service_launch.v1",
            "launch_id": "00000000-0000-4000-8000-000000000005",
            "state": "ready",
            "pid": self.old_owner["pid"],
        }
        self._write_store("runtime-services/LAUNCH.json", json_bytes(old_launch))
        archive_root = self.store / "runtime-services" / "container-recovery" / self.request_sha / "archive"
        archive_root.mkdir(parents=True)
        archived_launch = json_bytes(old_launch)
        (archive_root / "LAUNCH.json").write_bytes(archived_launch)
        self.archived = {"runtime-services/LAUNCH.json": sha(archived_launch)}
        self._write_store("runtime-services/OWNER.json", json_bytes(self.drained))
        old_owner_path = self.runtime / self.old_owner["owner_token"]
        old_owner_path.mkdir(exist_ok=True)
        for name in ("compute.stdout.jsonl", "preparation.stdout.jsonl"):
            source = f"runtime-services/{self.old_owner['owner_token']}/{name}"
            (old_owner_path / name).write_bytes((source + " old\n").encode())

        successor_path = self.runtime / self.successor["owner_token"]
        successor_path.mkdir()
        for name in ("compute.stdout.jsonl", "preparation.stdout.jsonl"):
            (successor_path / name).write_bytes((name + " successor\n").encode())
        new_launch = {
            "schema_version": "runtime_service_launch.v1",
            "launch_id": "00000000-0000-4000-8000-000000000006",
            "state": "ready",
            "pid": self.successor["pid"],
        }
        self._write_store("runtime-services/LAUNCH.json", json_bytes(new_launch))
        self._write_pool("docker-all.compute", "scheduler_resource_pool.v1", 2, self.resources["compute_resources"])
        self._write_pool("docker-all.preparation", "preparation_resource_pool.v1", 2, self.resources["preparation_resources"], preparation=True)
        self._write_checkpoint(
            "docker-all.compute.json", "docker-all.compute", [self.cancelled_run_id]
        )
        self._write_checkpoint(
            "docker-all.preparation.preparation.json",
            "docker-all.preparation",
            [self.cancelled_run_id],
        )

        self.absent = {}
        for source in runtime_service._container_recovery_expected_sources(self.old_owner):
            if source == "configuration.json":
                raw = self.config_raw
            elif source == "runtime-services/LAUNCH.json":
                continue
            elif source.endswith(".json") and source.startswith("scheduler_pools/") and source not in {
                "scheduler_pools/docker-all.compute.json",
                "scheduler_pools/docker-all.preparation.preparation.json",
            }:
                raw = (source + " old\n").encode()
            elif source == "runtime-services/OWNER.json":
                raw = json_bytes(self.old_owner)
            elif source in {
                "scheduler_pools/docker-all.compute.json",
                "scheduler_pools/docker-all.preparation.preparation.json",
            }:
                self.absent[source] = "scheduler_checkpoint_not_published"
                continue
            else:
                raw = (source + " old\n").encode()
            (archive_root / Path(source).name).write_bytes(raw)
            self.archived[source] = sha(raw)
        manifest = {
            "schema_version": runtime_service.CONTAINER_RECOVERY_ARCHIVE_SCHEMA,
            "request_sha256": self.request_sha,
            "config_sha256": self.config["schema_version"] and self.context["request"]["config_sha256"],
            "attestation_sha256": self.context["attestation_sha256"],
            "ledger_snapshot_sha256": self.context["request"]["ledger_snapshot_sha256"],
            "prior_ready_owner_proof_sha256": self.context["request"]["prior_ready_owner_proof_sha256"],
            "application": self.context["request"]["application"],
            "files": self.archived,
            "absent_sources": self.absent,
        }
        manifest_raw = json_bytes(manifest)
        (archive_root / "manifest.json").write_bytes(manifest_raw)
        self.result = {
            "schema_version": runtime_service.CONTAINER_RECOVERY_RECEIPT_SCHEMA,
            "status": "recovered",
            "outcome": "empty_namespace_recovered",
            "request_id": "unused-in-focused-test",
            "request_sha256": self.request_sha,
            "config_sha256": self.context["request"]["config_sha256"],
            "target_id": "docker-all",
            "owner_sha256_before": self.context["request"]["owner_sha256"],
            "owner_state_before": "ready",
            "owner_state_after": "failed",
            "owner_sha256_after": "1" * 64,
            "store_root_sha256": "2" * 64,
            "application": self.context["request"]["application"],
            "ledger_root_sha256": "3" * 64,
            "ledger_snapshot_sha256": self.context["request"]["ledger_snapshot_sha256"],
            "attestation_sha256": self.context["attestation_sha256"],
            "docker_manifest_sha256": "4" * 64,
            "prior_ready_owner_proof_sha256": self.context["request"]["prior_ready_owner_proof_sha256"],
            "device_release_mapping_sha256": "5" * 64,
            "historical_build_commit": "6" * 40,
            "executor_build_commit": "7" * 40,
            "historical_build_snapshot": "8" * 64,
            "executor_build_snapshot": "9" * 64,
            "archived_evidence_path": str(archive_root / "manifest.json"),
            "archived_evidence_sha256": sha(manifest_raw),
            "archived_files": self.archived,
            "archived_absent_sources": self.absent,
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def _owner(*, token: str, start: str, pid: int, generation: int, state: str,
               child_status: str, child_pids: tuple[int, int]) -> dict[str, object]:
        return {
            "schema_version": "runtime_service_owner.v1",
            "owner_token": token,
            "process_start_token": start,
            "state": state,
            "pid": pid,
            "host": "fullmag-test",
            "target_id": "docker-all",
            "protocol": "stdin-v1",
            "control_address": "127.0.0.1:8081" if state == "ready" else None,
            "build_commit": "a" * 40,
            "build_snapshot": "b" * 64,
            "compute_pool_id": "docker-all.compute",
            "preparation_pool_id": "docker-all.preparation",
            "compute_pool_generation": generation,
            "preparation_pool_generation": generation,
            "acquired_at": "2026-10-19T00:00:00Z",
            "heartbeat_at": "2026-10-19T00:00:01Z",
            "children": [
                {"role": "compute", "pid": child_pids[0], "status": child_status},
                {"role": "preparation", "pid": child_pids[1], "status": child_status},
            ],
        }

    def _write_store(self, source: str, raw: bytes) -> None:
        path = runtime_service._store_relative_path(self.paths, runtime_service.PurePosixPath(source))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)

    def _write_pool(self, pool_id: str, schema: str, generation: int, resources: object, preparation: bool = False) -> None:
        suffix = ".preparation-resources.json" if preparation else ".resources.json"
        self._write_store(
            f"scheduler_pools/{pool_id}{suffix}",
            json_bytes({"schema_version": schema, "pool_id": pool_id, "generation": generation, "resources": resources}),
        )

    def _write_checkpoint(
        self, filename: str, pool_id: str, run_ids: list[str] | None = None
    ) -> None:
        self._write_store(
            f"scheduler_pools/{filename}",
            json_bytes({
                "schema_version": "scheduler_pool_checkpoint.v1",
                "pool_id": pool_id,
                "sequence": 1,
                "run_source": "store",
                "run_ids": run_ids or [],
                "next_run_id": None,
            }),
        )

    def _refresh_archive_metadata(self) -> None:
        archive = self.store / "runtime-services" / "container-recovery" / self.request_sha / "archive"
        manifest_path = archive / "manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["files"] = self.archived
        manifest["absent_sources"] = self.absent
        manifest_raw = json_bytes(manifest)
        manifest_path.write_bytes(manifest_raw)
        self.result["archived_files"] = dict(self.archived)
        self.result["archived_absent_sources"] = dict(self.absent)
        self.result["archived_evidence_sha256"] = sha(manifest_raw)

    def validate(self) -> None:
        archive = self.store / "runtime-services" / "container-recovery" / self.request_sha / "archive"
        runtime_service._validate_container_recovery_archive(
            self.paths,
            self.context,
            self.result,
            authenticated_drained_owner_sha256=sha(json_bytes(self.drained)),
            authenticated_successor_owner=self.successor,
        )

    def test_legal_ready_to_drained_successor_is_accepted(self) -> None:
        self.validate()

    def test_immutable_old_journal_change_is_rejected(self) -> None:
        old = self.runtime / self.old_owner["owner_token"] / "compute.stdout.jsonl"
        old.write_bytes(b"tampered\n")
        with self.assertRaises(runtime_service.RuntimeServiceError):
            self.validate()

    def test_successor_generation_or_malformed_checkpoint_is_rejected(self) -> None:
        pool = self.store / "scheduler_pools" / "docker-all.compute.resources.json"
        value = json.loads(pool.read_text())
        value["generation"] = 3
        pool.write_bytes(json_bytes(value))
        with self.assertRaises(runtime_service.RuntimeServiceError):
            self.validate()

    def test_archived_checkpoint_may_be_absent_after_clean_successor(self) -> None:
        source = "scheduler_pools/docker-all.compute.json"
        checkpoint = {
            "schema_version": "scheduler_pool_checkpoint.v1",
            "pool_id": "docker-all.compute",
            "sequence": 1,
            "run_source": "store",
            "run_ids": [],
            "next_run_id": None,
        }
        archive = self.store / "runtime-services" / "container-recovery" / self.request_sha / "archive"
        raw = json_bytes(checkpoint)
        (archive / Path(source).name).write_bytes(raw)
        self.archived[source] = sha(raw)
        self.absent.pop(source)
        current = self.store / source
        current.unlink()
        self._refresh_archive_metadata()
        self.validate()

        self.tearDown()
        self.setUp()
        checkpoint = self.store / "scheduler_pools" / "docker-all.compute.json"
        value = json.loads(checkpoint.read_text())
        value["run_ids"] = ["run-cancelled", "run-cancelled"]
        checkpoint.write_bytes(json_bytes(value))
        with self.assertRaises(runtime_service.RuntimeServiceError):
            self.validate()


if __name__ == "__main__":
    unittest.main()
