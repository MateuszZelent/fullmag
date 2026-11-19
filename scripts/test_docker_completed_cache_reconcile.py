from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager
from pathlib import Path
import re
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import copy
import io
from contextlib import redirect_stdout

sys.path.insert(0, str(Path(__file__).resolve().parent))

import docker_backend_volume_cache as backend_cache
import docker_completed_cache_reconcile as reconcile
from bootstrap_docker_toolchain import control_volume_name


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


class FakeControl:
    def __init__(self, identity, project, volume, labels, old_documents):
        self.identity = dict(identity)
        self.project = project
        self.volume = volume
        self.labels = dict(labels)
        self.image = "fullmag/helper@sha256:" + "3" * 64
        self.namespace = ""
        self.old_documents = dict(old_documents)
        self.documents = dict(old_documents)
        self.writes = {}
        self.active = False
        self.attempt = "a" * 32
        self.helper_id = "f" * 64

    def read_bytes(self, path, *, optional=False, maximum=None, timeout=None):
        if path == "active":
            if self.active:
                return (self.attempt + "\n").encode()
            return None if optional else b""
        value = self.documents.get(path)
        if value is None and optional:
            return None
        if value is None:
            raise AssertionError(f"unexpected control read: {path}")
        return value

    def write_bytes(self, path, data):
        self.writes[path] = data
        self.documents[path] = data

    def write(self, path, value):
        self.write_bytes(path, canonical(value) + b"\n")

    @contextmanager
    def operation(self, phase, inputs, *, minimum_free_bytes=None):
        if self.active:
            raise RuntimeError("unexpected concurrent operation")
        self.active = True
        operation = {
            "receipt": {"attempt": self.attempt},
            "helper_container_id": self.helper_id,
            "daemon_pending": False,
        }
        try:
            yield operation
        finally:
            self.active = False


class FakeProbe:
    def __init__(self, root: Path):
        self.project_root = root / "project"
        self.executor = self.project_root / "fullmag"
        self.storage_root = self.project_root / "storage"
        (self.storage_root / "index").mkdir(parents=True)
        self.executor.mkdir(parents=True)
        self.task_id = "viz-parity-fixes-20261027"
        self.owner = "codex:01a17c4c-9f0c-7d91-a8d4-a93507d9135c"
        self.source_root = self.project_root / "worktrees" / self.task_id
        self.worktree_id = reconcile._storage_identifier(self.source_root)
        self.project_id = "fullmag-902a54b7b1f633a7"
        self.cache_project_id = backend_cache._safe_project_id({"project_root": self.project_root})
        segment = re.sub(r"[^a-z0-9_-]+", "-", self.worktree_id).strip("-")
        self.project = f"fullmag-worktree-{segment}"
        self.control_volume = control_volume_name(self.project)
        self.merge_commit = "7f5efd18370b8e8824fa714bc4f01a31691ab889"
        self.registry_path = self.storage_root / "index" / f"{self.worktree_id}.json"
        self.registry = {
            "schema": "fullmag_storage_v1",
            "worktree_id": self.worktree_id,
            "task_id": self.task_id,
            "owner": self.owner,
            "repo_root": str(self.source_root),
            "branch": f"codex/{self.task_id}",
            "head": "b90a6056c6bc3bcee6b0bc77b356aeb0a4bfdddc",
            "state": "completed",
            "pr_state": "merged",
            "pr_url": "https://github.com/MateuszZelent/fullmag/pull/264",
            "merge_commit": self.merge_commit,
            "worktree_cleanup": "removed without force",
            "main_checkout": str(self.executor),
            "preserved_volumes": [self.control_volume, "fullmag-dev-group-ledger-v1-aaaaaaaaaaaaaaaaaaaaaaaa"],
            "docker_cache_retirement": {
                "state": "succeeded",
                "compose_project": self.project,
                "receipt": f"docker-volume://{self.control_volume}/cache-retirement/result.json",
            },
        }
        self.retirement_identity = {
            "worktree_id": self.worktree_id,
            "source_root": str(self.source_root),
            "project_id": self.project_id,
            "compose_project": self.project,
        }
        self.target_labels = self._target_labels()
        self.target_name = self._target_name()
        old_volume = {
            "kind": "frontend-v1",
            "name": "fullmag-dev-frontend-v1-" + "1" * 24,
            "labels": {"example": "historical"},
            "mountpoint": "/var/lib/docker/volumes/old-frontend/_data",
        }
        old_plan = {
            "schema": "fullmag.docker-cache-retirement-plan.v1",
            "task_id": self.task_id,
            "owner": self.owner,
            **self.retirement_identity,
            "volumes": [old_volume],
            "shared_package_volume": None,
            "namespaces_pending": [],
        }
        plan_sha = hashlib.sha256(canonical(old_plan)).hexdigest()
        self.old_result = {
            "schema": "fullmag.docker-cache-retirement.v1",
            "state": "succeeded",
            "task_id": self.task_id,
            "owner": self.owner,
            **self.retirement_identity,
            "plan_sha256": plan_sha,
            "deleted_volumes": [old_volume["name"]],
            "already_absent_volumes": [],
            "namespaces_pending": [],
            "namespace_retirement": None,
        }
        self.registry["docker_cache_retirement_result"] = dict(self.old_result)
        self.old_documents = {
            "cache-retirement/plan.json": canonical(old_plan) + b"\n",
            "cache-retirement/closing.json": canonical({
                "schema": "fullmag.docker-cache-retirement-closing.v1",
                "state": "closing",
                "plan_sha256": plan_sha,
                "task_id": self.task_id,
                "owner": self.owner,
                **self.retirement_identity,
            }) + b"\n",
            "cache-retirement/result.json": canonical(self.old_result) + b"\n",
        }
        self.registry_raw = json.dumps(self.registry, sort_keys=True, indent=2).encode() + b"\n"
        self.registry_path.write_bytes(self.registry_raw)
        self.engine = "81a2002d-4c88-48aa-b4da-fed771788cfa"
        self.control_identity = {
            **self.retirement_identity,
            "checkout_kind": "worktree",
        }
        self.control_labels = {
            "org.fullmag.build-control.schema": "fullmag.build-control.v1",
            "org.fullmag.compose.project": self.project,
            "org.fullmag.source.worktree-id": self.worktree_id,
            "org.fullmag.build.role": "control",
            "com.fullmag.compose.project": self.project,
            "com.fullmag.toolchain.control.schema": "fullmag.docker-toolchain-control.v1",
            "com.fullmag.toolchain.control.project": self.project,
            "com.fullmag.toolchain.control.mount": "/opt/fullmag/control",
        }
        self.control = FakeControl(
            self.control_identity, self.project, self.control_volume,
            self.control_labels, self.old_documents,
        )
        self.target = self._target_document()
        self.control_document = {
            "Name": self.control_volume,
            "Driver": "local",
            "Options": {},
            "Scope": "local",
            "Mountpoint": f"/var/lib/docker/volumes/{self.control_volume}/_data",
            "CreatedAt": "2026-10-27T08:00:00Z",
            "Labels": dict(self.control_labels),
        }
        self.target_reads = 0
        self.target_drift_at = None
        self.container_refs = []
        self.pins = []
        self.ancestor = True
        self.remove_calls = 0
        self.remove_mode = "success"

    @staticmethod
    def _sha(value):
        return hashlib.sha256(value).hexdigest()

    def _target_labels(self):
        labels = {
            backend_cache.LABEL_SCHEMA: backend_cache.SCHEMA,
            backend_cache.LABEL_PROFILE: backend_cache.PROFILE,
            backend_cache.LABEL_PROJECT: self.cache_project_id,
            backend_cache.LABEL_WORKTREE: self.worktree_id,
            backend_cache.LABEL_TOOLCHAIN: "sha256:" + "2" * 64,
            backend_cache.LABEL_CARGO_PROFILE: "backend-dev",
            backend_cache.LABEL_CACHE_KEY: "0" * 64,
            backend_cache.LABEL_UNIT: "1" * 64,
            backend_cache.LABEL_OWNER: "1" * 64,
            backend_cache.LABEL_ROLE: backend_cache.PACKAGE_VOLUME_ROLE,
        }
        cache_key = backend_cache._sha256({
            "schema": backend_cache.KEY_SCHEMA,
            "source_root": str(self.source_root),
            "worktree_id": self.worktree_id,
            "toolchain_image_id": labels[backend_cache.LABEL_TOOLCHAIN],
            "cargo_profile": "backend-dev",
        })
        unit_key = backend_cache._sha256({
            "schema": backend_cache.SCHEMA,
            "project_id": self.cache_project_id,
            "cache_key": cache_key,
            "worktree_id": self.worktree_id,
            "toolchain_image_id": labels[backend_cache.LABEL_TOOLCHAIN],
            "cargo_profile": "backend-dev",
        })
        labels[backend_cache.LABEL_CACHE_KEY] = cache_key
        labels[backend_cache.LABEL_UNIT] = unit_key
        labels[backend_cache.LABEL_OWNER] = unit_key
        return labels

    def _target_name(self):
        volume_id = hashlib.sha256(
            f"{self.cache_project_id}:{self.target_labels[backend_cache.LABEL_UNIT]}".encode()
        ).hexdigest()[:24]
        return f"fullmag-backend-v2-{volume_id}-package"

    def _target_document(self):
        return {
            "Name": self.target_name,
            "Driver": "local",
            "Options": {},
            "Scope": "local",
            "Mountpoint": f"/var/lib/docker/volumes/{self.target_name}/_data",
            "CreatedAt": "2026-10-27T08:35:56Z",
            "Labels": dict(self.target_labels),
        }

    def resolve_layout(self, repo_root):
        if str(Path(repo_root).resolve()) != str(self.executor.resolve()):
            raise AssertionError("executor checkout changed")
        return {
            "repo_root": str(self.executor),
            "project_root": str(self.project_root),
            "storage_root": str(self.storage_root),
            "worktree_id": "fullmag-902a54b7b1f633a7",
            "project_id": self.project_id,
            "env": {"FULLMAG_PROJECT_ID": self.project_id},
        }

    def read_registry(self, path, layout):
        if str(path) != str(self.registry_path):
            raise AssertionError("noncanonical registry path")
        return self.registry_raw, json.loads(self.registry_raw)

    def main_checkout(self, layout):
        return self.executor

    def merge_is_ancestor(self, main_checkout, merge_sha):
        return self.ancestor and merge_sha == self.merge_commit

    def engine_id(self):
        return self.engine

    def helper_image(self, repo_root, identity):
        return "fullmag/helper@sha256:" + "3" * 64

    def make_control(self, identity, helper_image):
        self.control.image = helper_image
        return self.control

    def inspect_volume(self, name):
        if name == self.control_volume:
            return dict(self.control_document)
        if name != self.target_name or self.target is None:
            return None
        self.target_reads += 1
        if self.target_drift_at is not None and self.target_reads >= self.target_drift_at:
            drifted = dict(self.target)
            drifted["CreatedAt"] = "2026-11-04T00:00:00Z"
            return drifted
        return dict(self.target)

    def container_inventory(self):
        docs = list(self.container_refs)
        if self.control.active:
            docs.append({
                "Id": self.control.helper_id,
                "State": {"Running": True},
                "Config": {"Labels": {
                    "com.docker.compose.project": self.project,
                    "org.fullmag.compose.project": self.project,
                    "org.fullmag.source.project-id": self.project_id,
                    "org.fullmag.source.worktree-id": self.worktree_id,
                    "org.fullmag.source.checkout-kind": "worktree",
                }},
                "Mounts": [{"Type": "volume", "Name": self.control_volume,
                            "Source": self.control_document["Mountpoint"],
                            "Destination": "/control"}],
            })
        return docs

    def active_pins(self, context):
        return list(self.pins)

    def retention_guard(self, layout):
        from local_runner.runtime_use import retention_mutation_guard
        return retention_mutation_guard(layout)

    def remove_volume(self, name):
        self.remove_calls += 1
        if name != self.target_name:
            raise AssertionError("attempted wrong volume removal")
        if self.remove_mode == "unknown":
            raise RuntimeError("daemon outcome unknown")
        self.target = None

    def args(self):
        return SimpleNamespace(
            repo_root=str(self.executor),
            registry=str(self.registry_path),
            volume=self.target_name,
            recovery_id="a" * 32,
            expected_plan_sha256=None,
            apply=False,
            probe=self,
        )


class CompletedCacheReconcileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.probe = FakeProbe(Path(self.temp.name))
        self.args = self.probe.args()

    def test_collect_proves_exact_omitted_private_package_volume(self):
        plan = reconcile.collect(self.args)
        self.assertEqual(plan["target"]["volume"], self.probe.target_name)
        self.assertEqual(plan["target"]["role"], "backend-package")
        self.assertEqual(plan["target"]["inspect"]["CreatedAt"], "2026-10-27T08:35:56Z")
        self.assertEqual(plan["retirement"]["legacy_cache_project_id"], self.probe.cache_project_id)
        self.assertEqual(plan["registry"]["sha256"], hashlib.sha256(self.probe.registry_raw).hexdigest())
        self.assertEqual(plan["retirement"]["result_raw_sha256"], hashlib.sha256(
            self.probe.old_documents["cache-retirement/result.json"]
        ).hexdigest())

    def test_plan_ignores_health_telemetry_but_pins_consumer_identity(self):
        container = {"Id": "e" * 64, "Name": "/other", "Image": "sha256:" + "6" * 64,
                     "State": {"Running": True, "Status": "running", "StartedAt": "start",
                               "Health": {"Log": ["old"]}},
                     "Config": {"Labels": {"owner": "other"}}, "Mounts": []}
        self.probe.container_refs = [container]
        first = reconcile.collect(self.args)["plan_sha256"]
        container["State"]["Health"] = {"Log": ["new"], "FailingStreak": 3}
        self.assertEqual(first, reconcile.collect(self.args)["plan_sha256"])
        for field in ("Id", "State", "Config", "Mounts", "Running"):
            changed = copy.deepcopy(container)
            if field == "Id":
                changed[field] = "d" * 64
            elif field == "State":
                changed[field]["StartedAt"] = "restart"
            elif field == "Running":
                changed["State"]["Running"] = False
            elif field == "Config":
                changed[field]["Labels"]["owner"] = "changed"
            else:
                changed[field] = [{"Type": "volume", "Name": "unrelated", "Source": "/unrelated"}]
            self.probe.container_refs = [changed]
            self.assertNotEqual(first, reconcile.collect(self.args)["plan_sha256"])
        self.probe.container_refs = [container]

    def test_rejects_registry_without_completed_merged_ancestry(self):
        original = dict(self.probe.registry)
        for field, value in (("state", "review"), ("pr_state", "open")):
            with self.subTest(field=field):
                self.probe.registry = dict(original)
                self.probe.registry[field] = value
                self.probe.registry_raw = json.dumps(self.probe.registry, sort_keys=True).encode()
                self.probe.registry_path.write_bytes(self.probe.registry_raw)
                with self.assertRaises(reconcile.CompletedCacheReconcileError):
                    reconcile.collect(self.args)
        self.probe.registry = dict(original)
        self.probe.registry_raw = json.dumps(self.probe.registry, sort_keys=True).encode()
        self.probe.registry_path.write_bytes(self.probe.registry_raw)
        self.probe.ancestor = False
        with self.assertRaisesRegex(reconcile.CompletedCacheReconcileError, "ancestor"):
            reconcile.collect(self.args)

    def test_rejects_wrong_volume_identity_and_already_retired_target(self):
        self.args.volume = "fullmag-backend-v2-foreign-package"
        with self.assertRaises(reconcile.CompletedCacheReconcileError):
            reconcile.collect(self.args)
        self.args.volume = self.probe.target_name
        saved_labels = self.probe.target["Labels"]
        self.probe.target["Labels"] = dict(saved_labels)
        self.probe.target["Labels"][backend_cache.LABEL_WORKTREE] = "another-worktree"
        with self.assertRaisesRegex(reconcile.CompletedCacheReconcileError, "another worktree"):
            reconcile.collect(self.args)
        self.probe.target["Labels"] = saved_labels
        result = json.loads(self.probe.old_documents["cache-retirement/result.json"])
        result["already_absent_volumes"] = [self.probe.target_name]
        self.probe.old_documents["cache-retirement/result.json"] = canonical(result)
        self.probe.registry["docker_cache_retirement_result"] = result
        self.probe.registry_raw = json.dumps(self.probe.registry, sort_keys=True).encode()
        self.probe.registry_path.write_bytes(self.probe.registry_raw)
        self.probe.control.documents["cache-retirement/result.json"] = canonical(result)
        with self.assertRaises(reconcile.CompletedCacheReconcileError):
            reconcile.collect(self.args)

    def test_blocks_container_references_and_active_pins(self):
        self.probe.container_refs = [{
            "Id": "e" * 64,
            "State": {"Running": False},
            "Config": {"Labels": {}},
            "Mounts": [{"Type": "volume", "Name": self.probe.target_name,
                        "Source": self.probe.target["Mountpoint"], "Destination": "/cache"}],
        }]
        with self.assertRaisesRegex(reconcile.CompletedCacheReconcileError, "container|mount|reference"):
            reconcile.collect(self.args)
        self.probe.container_refs = []
        self.probe.pins = ["active backend cache pin"]
        with self.assertRaisesRegex(reconcile.CompletedCacheReconcileError, "pin"):
            reconcile.collect(self.args)

    def test_apply_blocks_existing_runtime_ticket_before_deletion(self):
        from local_runner.runtime_use import runtime_package_use
        plan = reconcile.collect(self.args)
        self.args.expected_plan_sha256 = plan["plan_sha256"]
        with runtime_package_use({"storage_root": self.probe.storage_root}):
            with self.assertRaisesRegex(reconcile.CompletedCacheReconcileError, "runtime users"):
                reconcile.apply(self.args)
        self.assertEqual(self.probe.remove_calls, 0)
        self.assertEqual(self.probe.control.writes, {})

    def test_apply_holds_runtime_admission_guard_through_removal(self):
        plan = reconcile.collect(self.args)
        self.args.expected_plan_sha256 = plan["plan_sha256"]
        original = self.probe.remove_volume
        def guarded_remove(name):
            self.assertTrue((self.probe.storage_root / "locks/retention-admission/owner.json").is_file())
            original(name)
        self.probe.remove_volume = guarded_remove
        receipt = reconcile.apply(self.args)
        self.assertEqual(receipt["state"], "succeeded")
        self.assertFalse((self.probe.storage_root / "locks/retention-admission").exists())

    def test_apply_rechecks_docker_inspect_drift_before_volume_rm(self):
        plan = reconcile.collect(self.args)
        self.args.expected_plan_sha256 = plan["plan_sha256"]
        self.probe.target_reads = 0
        self.probe.target_drift_at = 3
        with self.assertRaises(reconcile.CompletedCacheReconcileError):
            reconcile.apply(self.args)
        self.assertEqual(self.probe.remove_calls, 0)

    def test_apply_removes_only_exact_target_and_adds_receipt_without_rewriting_old_proof(self):
        old = dict(self.probe.old_documents)
        plan = reconcile.collect(self.args)
        self.args.expected_plan_sha256 = plan["plan_sha256"]
        receipt = reconcile.apply(self.args)
        self.assertEqual(receipt["state"], "succeeded")
        self.assertEqual(receipt["deleted_volumes"], [self.probe.target_name])
        self.assertIsNone(self.probe.target)
        self.assertEqual(self.probe.remove_calls, 1)
        self.assertTrue(any(path.startswith("completed-cache-reconciliation/")
                            for path in self.probe.control.writes))
        for path, value in old.items():
            self.assertEqual(self.probe.control.documents[path], value)
        resumed = reconcile.collect(self.args)
        self.args.expected_plan_sha256 = resumed["plan_sha256"]
        again = reconcile.apply(self.args)
        self.assertEqual(again["state"], "succeeded")
        self.assertEqual(self.probe.remove_calls, 1)

    def test_unknown_delete_outcome_is_not_replayed_and_old_receipts_stay_immutable(self):
        old = dict(self.probe.old_documents)
        plan = reconcile.collect(self.args)
        self.args.expected_plan_sha256 = plan["plan_sha256"]
        self.probe.remove_mode = "unknown"
        first = reconcile.apply(self.args)
        self.assertEqual(first["state"], "outcome-unknown-resources-retained")
        self.assertEqual(self.probe.remove_calls, 1)
        resumed_plan = reconcile.collect(self.args)
        self.args.expected_plan_sha256 = resumed_plan["plan_sha256"]
        self.args.recovery_id = "b" * 32
        with self.assertRaisesRegex(reconcile.CompletedCacheReconcileError, "another recovery proof"):
            reconcile.collect(self.args)
        self.args.recovery_id = "a" * 32
        second = reconcile.apply(self.args)
        self.assertEqual(second["state"], "outcome-unknown-resources-retained")
        self.assertEqual(self.probe.remove_calls, 1)
        for path, value in old.items():
            self.assertEqual(self.probe.control.documents[path], value)


class ProductionPinTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.storage = Path(self.temp.name)
        (self.storage / "index").mkdir()
        self.root = self.storage / "custom-consumers"
        self.root.mkdir()
        self.config = self.storage / "index/runtime-reference-roots.json"
        self.config.write_bytes(canonical({"schema": "fullmag.runtime-reference-roots.v1",
            "relative_roots": ["custom-consumers"], "legacy_inventory_complete": True}))
        self.context = {"volume": "fullmag-backend-v2-target-package", "control": object(),
                        "layout": {"storage_root": self.storage}}
        self.control_mock = patch.object(reconcile, "_read_control", return_value=None)
        self.control_mock.start()
        self.addCleanup(self.control_mock.stop)

    def pins(self):
        return reconcile._DockerProbe().active_pins(self.context)

    def test_dereferences_registered_receipts_and_attestations_outside_index(self):
        for name in ("receipt.json", "proof.json", "run-request.json", "run-result.json"):
            for key in ("backend_cache", "backend_cache_attestation"):
                with self.subTest(name=name, key=key):
                    receipt = self.root / name
                    receipt.write_bytes(canonical({"backend_start": {key: {
                        "volume_names": {"package": self.context["volume"]}}}}))
                    self.assertIn(str(receipt.relative_to(self.storage)), self.pins()["references"])
                    receipt.unlink()
        self.assertEqual(self.pins()["references"], [])

    def test_json_escaped_volume_reference_is_retained(self):
        receipt = self.root / "receipt.json"
        raw = canonical({"active_pins": [self.context["volume"]]})
        receipt.write_bytes(raw.replace(b"fullmag", b"\\u0066ullmag"))
        self.assertIn(str(receipt.relative_to(self.storage)), self.pins()["references"])

    def test_missing_or_incomplete_coverage_blocks(self):
        self.config.unlink()
        with self.assertRaisesRegex(reconcile.CompletedCacheReconcileError, "coverage"):
            self.pins()
        self.config.write_bytes(canonical({"schema": "fullmag.runtime-reference-roots.v1",
            "relative_roots": ["missing-root"], "legacy_inventory_complete": True}))
        with self.assertRaisesRegex(reconcile.CompletedCacheReconcileError, "coverage|missing"):
            self.pins()

    def test_explicit_incomplete_coverage_and_symlink_root_block(self):
        self.config.write_bytes(canonical({"schema": "fullmag.runtime-reference-roots.v1",
            "relative_roots": ["custom-consumers"], "legacy_inventory_complete": False}))
        with self.assertRaisesRegex(reconcile.CompletedCacheReconcileError, "coverage"):
            self.pins()
        alias = self.storage / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        self.config.write_bytes(canonical({"schema": "fullmag.runtime-reference-roots.v1",
            "relative_roots": ["alias"], "legacy_inventory_complete": True}))
        with self.assertRaisesRegex(reconcile.CompletedCacheReconcileError, "coverage"):
            self.pins()

    def test_canonical_results_and_runs_protect_packages(self):
        for root in ("results", "runs"):
            receipt = self.storage / root / "job" / "proof.json"
            receipt.parent.mkdir(parents=True)
            receipt.write_bytes(canonical({"protected_packages": [self.context["volume"]]}))
            self.assertIn(str(receipt.relative_to(self.storage)), self.pins()["references"])

    def test_metadata_drift_changes_safety_snapshot(self):
        receipt = self.root / "run-result.json"
        receipt.write_bytes(canonical({"state": "done"}))
        first = self.pins()["metadata_sha256"]
        receipt.write_bytes(canonical({"state": "retained"}))
        self.assertNotEqual(first, self.pins()["metadata_sha256"])

    def test_reference_depth_limit_blocks(self):
        path = self.root
        for _ in range(34):
            path = path / "nested"
        path.mkdir(parents=True)
        with self.assertRaisesRegex(reconcile.CompletedCacheReconcileError, "depth limit"):
            self.pins()

    def test_unsafe_receipt_blocks(self):
        receipt = self.root / "receipt.json"
        for mode in ("symlink", "oversize", "invalid"):
            with self.subTest(mode=mode):
                if mode == "symlink":
                    receipt.symlink_to(self.config)
                elif mode == "oversize":
                    with receipt.open("wb") as stream:
                        stream.truncate(reconcile.MAX_INDEX_RECORD_BYTES + 1)
                else:
                    receipt.write_bytes(b"not json")
                with self.assertRaises(reconcile.CompletedCacheReconcileError):
                    self.pins()
                receipt.unlink()


class CompletedCacheCliTests(unittest.TestCase):
    def test_cli_adapts_parser_paths_to_reconciler_strings(self):
        import docker_dev
        with patch.object(reconcile, "run", return_value={"state": "preview"}) as run:
            with redirect_stdout(io.StringIO()):
                result = docker_dev.main([
                    "--repo-root", "/tmp/fullmag", "reconcile-completed-cache",
                    "--registry", "/tmp/storage/index/task.json",
                    "--volume", "fullmag-backend-v2-" + "a" * 24 + "-package",
                    "--recovery-id", "b" * 32,
                ])
        self.assertEqual(result, 0)
        args = run.call_args.args[0]
        self.assertEqual(args.repo_root, "/tmp/fullmag")
        self.assertEqual(args.registry, "/tmp/storage/index/task.json")


if __name__ == "__main__":
    unittest.main()
