import copy
import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts import fullmag_data_volume_linux_request as linux_request
from scripts import fullmag_data_volume_runtime_binding as runtime_binding
from scripts.test_fullmag_data_volume_linux_request import valid_request


def digest(character):
    return character * 64


def retained_pins(attempt, backend, frontend, image, witness_sha):
    return {
        "attempt": attempt,
        "config_sha256": digest("a"),
        "state_root": "/srv/fullmag/storage/runtimes/fixture/attempt",
        "backend": backend,
        "frontend": frontend,
        "image_id": "sha256:" + image * 64,
        "runtime_witness_path": f"development/attempts/{attempt}/terminal.json",
        "runtime_witness_sha256": witness_sha,
    }


def plan_fixture():
    old_attempt = "1" * 32
    old_pins = retained_pins(old_attempt, digest("2"), digest("3"), "4", digest("5"))
    datasets = {
        "user_data": {
            "canonical_root": "/srv/fullmag/storage/user-data/fixture",
            "device": 259,
            "inode": 101,
        },
        "state": {
            "canonical_root": "/srv/fullmag/storage/runtimes/fixture/attempt",
            "device": 259,
            "inode": 202,
        },
    }
    plan = {
        "schema": "fullmag.data-volume-plan.v1",
        "volume_id": "a" * 32,
        "project_id": "fullmag-fixture",
        "worktree_id": "worktree-fixture",
        "compose_project": "fullmag-worktree-fixture",
        "source_root": "/srv/fullmag/source",
        "storage_root": "/srv/fullmag/storage",
        "mount_root": "/mnt/fullmag-data-volume",
        "runtime_root": "/srv/fullmag/storage/runtimes/fixture",
        "runtime_pins": old_pins,
        "observation": {
            "datasets": datasets,
            "engine_id": "engine-fixture",
            "services": {
                "backend": {"nano_cpus": 1_000_000_000, "memory_bytes": 2_147_483_648},
                "frontend": {"nano_cpus": 500_000_000, "memory_bytes": 1_073_741_824},
            },
        },
    }
    return plan


def binding_fixture(plan, plan_sha256, *, loader_sha256=None):
    new_attempt = "7" * 32
    dev_witness_sha = digest("c")
    new_pins = retained_pins(
        new_attempt, digest("8"), digest("9"), "b", dev_witness_sha
    )
    if loader_sha256 is None:
        loader_sha256 = digest("f")
    return {
        "schema": runtime_binding.SCHEMA,
        "state": "qualified-runtime-successor-only",
        "volume_id": plan["volume_id"],
        "plan_sha256": plan_sha256,
        "project_id": plan["project_id"],
        "worktree_id": plan["worktree_id"],
        "compose_project": plan["compose_project"],
        "source_root": plan["source_root"],
        "storage_root": plan["storage_root"],
        "runtime_root": plan["runtime_root"],
        "previous_runtime_pins": copy.deepcopy(plan["runtime_pins"]),
        "runtime_pins": new_pins,
        "source_roots": copy.deepcopy(plan["observation"]["datasets"]),
        "services": {
            "backend": {
                "id": new_pins["backend"],
                "fingerprint": digest("d"),
                "pid": 1101,
                "started_at": "2026-11-12T12:00:00Z",
                "nano_cpus": 1_000_000_000,
                "memory_bytes": 2_147_483_648,
            },
            "frontend": {
                "id": new_pins["frontend"],
                "fingerprint": digest("e"),
                "pid": 1102,
                "started_at": "2026-11-12T12:01:00.123Z",
                "nano_cpus": 500_000_000,
                "memory_bytes": 1_073_741_824,
            },
        },
        "witnesses": {
            "stop": {
                "path": "iteration/attempts/" + "a" * 32 + "/terminal.json",
                "sha256": digest("1"),
            },
            "recreation": {
                "path": "recreate-services/attempts/" + "b" * 32 + "/terminal.json",
                "sha256": digest("2"),
            },
            "development": {
                "path": f"development/attempts/{new_attempt}/terminal.json",
                "sha256": dev_witness_sha,
            },
        },
        "admission": {
            "certificate_sha256": digest("3"),
            "owner_marker_sha256": digest("4"),
            "probe_sha256": digest("5"),
            "owner_token_sha256": digest("6"),
            "engine_id": plan["observation"]["engine_id"],
        },
        "runtime_source": {
            "source_commit": "7" * 40,
            "source_snapshot_sha256": digest("8"),
            "backend_build_receipt_sha256": digest("9"),
        },
        "loader_sha256": loader_sha256,
        "relationship": "diamond-by-common-stop",
        "historical_owner_continuity": "not-proven",
        "namespace_admitted": False,
        "data_migrated": False,
    }


def linux_request_fixture(binding_sha256=None):
    value = valid_request()
    if binding_sha256 is not None:
        value["schema"] = linux_request.SCHEMA_WITH_RUNTIME_BINDING
        value["runtime_binding_sha256"] = binding_sha256
    return value


class RuntimeBindingValidationTests(unittest.TestCase):
    def setUp(self):
        self.plan = plan_fixture()
        self.plan_sha256 = hashlib.sha256(b"immutable plan bytes").hexdigest()

    def test_valid_binding_is_closed_and_returns_an_independent_copy(self):
        body = binding_fixture(self.plan, self.plan_sha256)
        before = copy.deepcopy(body)

        result = runtime_binding.validate_binding(body, self.plan, self.plan_sha256)

        self.assertEqual(result, before)
        self.assertEqual(body, before)
        self.assertIsNot(result, body)
        self.assertIsNot(result["runtime_pins"], body["runtime_pins"])

    def test_rejects_unknown_key_scope_drift_and_changed_source_root_identity(self):
        mutations = []

        unknown = binding_fixture(self.plan, self.plan_sha256)
        unknown["latest"] = True
        mutations.append(("unknown key", unknown, self.plan, self.plan_sha256))

        changed_volume = binding_fixture(self.plan, self.plan_sha256)
        changed_volume["volume_id"] = "0" * 32
        mutations.append(("volume scope", changed_volume, self.plan, self.plan_sha256))

        changed_source = binding_fixture(self.plan, self.plan_sha256)
        changed_source["source_roots"]["state"]["inode"] += 1
        mutations.append(("source identity", changed_source, self.plan, self.plan_sha256))

        changed_plan_digest = binding_fixture(self.plan, self.plan_sha256)
        mutations.append(("plan digest", changed_plan_digest, self.plan, digest("9")))

        for label, body, plan, plan_sha256 in mutations:
            with self.subTest(label=label), self.assertRaises(ValueError):
                runtime_binding.validate_binding(body, plan, plan_sha256)

    def test_rejects_reused_runtime_attempt_and_changed_service_budget(self):
        reused_attempt = binding_fixture(self.plan, self.plan_sha256)
        reused_attempt["runtime_pins"]["attempt"] = self.plan["runtime_pins"]["attempt"]

        changed_budget = binding_fixture(self.plan, self.plan_sha256)
        changed_budget["services"]["backend"]["nano_cpus"] += 1

        for label, body in (("reused attempt", reused_attempt), ("changed budget", changed_budget)):
            with self.subTest(label=label), self.assertRaises(ValueError):
                runtime_binding.validate_binding(body, self.plan, self.plan_sha256)

    def test_rejects_authority_flags_and_unpersisted_witness(self):
        mutations = []
        admitted = binding_fixture(self.plan, self.plan_sha256)
        admitted["namespace_admitted"] = True
        mutations.append(("namespace admitted", admitted))

        migrated = binding_fixture(self.plan, self.plan_sha256)
        migrated["data_migrated"] = True
        mutations.append(("data migrated", migrated))

        false_continuity = binding_fixture(self.plan, self.plan_sha256)
        false_continuity["historical_owner_continuity"] = "proven"
        mutations.append(("owner continuity", false_continuity))

        malformed_witness = binding_fixture(self.plan, self.plan_sha256)
        malformed_witness["witnesses"]["development"]["sha256"] = digest("e")
        mutations.append(("development witness mismatch", malformed_witness))

        raw_token = binding_fixture(self.plan, self.plan_sha256)
        raw_token["admission"]["owner_token"] = "0" * 32
        mutations.append(("raw owner token", raw_token))

        for label, body in mutations:
            with self.subTest(label=label), self.assertRaises(ValueError):
                runtime_binding.validate_binding(body, self.plan, self.plan_sha256)

    def test_rejects_invalid_runtime_source_and_loader_identity(self):
        bad_source = binding_fixture(self.plan, self.plan_sha256)
        bad_source["runtime_source"]["source_commit"] = "not-a-commit"

        bad_loader = binding_fixture(self.plan, self.plan_sha256)
        bad_loader["loader_sha256"] = "loader-drift"

        for label, body in (("source commit", bad_source), ("loader digest", bad_loader)):
            with self.subTest(label=label), self.assertRaises(ValueError):
                runtime_binding.validate_binding(body, self.plan, self.plan_sha256)


class RuntimeBindingLoadPlanTests(unittest.TestCase):
    def _encoded_binding(self, plan, plan_bytes):
        loader_sha = hashlib.sha256(Path(runtime_binding.__file__).read_bytes()).hexdigest()
        body = binding_fixture(plan, hashlib.sha256(plan_bytes).hexdigest(), loader_sha256=loader_sha)
        raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return body, raw, hashlib.sha256(raw).hexdigest()

    def test_explicit_binding_sha_selects_one_path_and_preserves_original_plan(self):
        plan = plan_fixture()
        plan_bytes = json.dumps(plan, sort_keys=True, separators=(",", ":")).encode("utf-8")
        body, binding_bytes, binding_sha = self._encoded_binding(plan, plan_bytes)
        original = copy.deepcopy(plan)
        op = Path(plan["storage_root"]) / "migrations" / "data-volumes" / plan["volume_id"]
        binding_path = op / "runtime-bindings" / (binding_sha + ".json")
        reads = []

        def read(path, expected=None):
            path = Path(path)
            reads.append((path, expected))
            if path == op / "plan.json":
                return plan_bytes, copy.deepcopy(plan)
            if path == binding_path and expected == binding_sha:
                return binding_bytes, json.loads(binding_bytes)
            raise AssertionError(f"Unexpected runtime evidence path: {path}")

        fake_qualification = SimpleNamespace(_read=read)
        with patch.dict(sys.modules, {"linux_data_volume_provision": fake_qualification}):
            original_bytes, view, loaded_binding = runtime_binding.load_plan(
                op, linux_request_fixture(binding_sha)
            )

        self.assertEqual(reads, [(op / "plan.json", None), (binding_path, binding_sha)])
        self.assertEqual(original_bytes, plan_bytes)
        self.assertEqual(hashlib.sha256(original_bytes).hexdigest(), hashlib.sha256(plan_bytes).hexdigest())
        self.assertEqual(plan, original)
        self.assertEqual(view["runtime_pins"], body["runtime_pins"])
        self.assertEqual(view["observation"]["services"], body["services"])
        self.assertEqual(loaded_binding, body)
        self.assertEqual(view["volume_id"], plan["volume_id"])

    def test_v1_without_binding_sha_stays_legacy_and_does_not_select_latest(self):
        plan = plan_fixture()
        plan_bytes = json.dumps(plan, sort_keys=True, separators=(",", ":")).encode("utf-8")
        op = Path(plan["storage_root"]) / "migrations" / "data-volumes" / plan["volume_id"]
        reads = []

        def read(path, expected=None):
            reads.append((Path(path), expected))
            if Path(path) != op / "plan.json" or expected is not None:
                raise AssertionError(f"Unexpected implicit runtime binding read: {path}")
            return plan_bytes, copy.deepcopy(plan)

        with patch.dict(
            sys.modules,
            {"linux_data_volume_provision": SimpleNamespace(_read=read)},
        ):
            original_bytes, view, loaded_binding = runtime_binding.load_plan(
                op, linux_request_fixture()
            )

        self.assertEqual(reads, [(op / "plan.json", None)])
        self.assertEqual(original_bytes, plan_bytes)
        self.assertEqual(view, plan)
        self.assertIsNone(loaded_binding)

    def test_rejects_invalid_selected_digest_and_loader_source_drift(self):
        plan = plan_fixture()
        plan_bytes = json.dumps(plan, sort_keys=True, separators=(",", ":")).encode("utf-8")
        op = Path(plan["storage_root"]) / "migrations" / "data-volumes" / plan["volume_id"]

        with patch.dict(
            sys.modules,
            {"linux_data_volume_provision": SimpleNamespace(_read=lambda path, expected=None: (plan_bytes, copy.deepcopy(plan)))},
        ):
            with self.assertRaises(ValueError):
                runtime_binding.load_plan(op, linux_request_fixture("invalid"))

        binding = binding_fixture(plan, hashlib.sha256(plan_bytes).hexdigest(), loader_sha256=digest("f"))
        binding_bytes = json.dumps(binding, sort_keys=True, separators=(",", ":")).encode("utf-8")
        binding_sha = hashlib.sha256(binding_bytes).hexdigest()

        def read_with_drift(path, expected=None):
            path = Path(path)
            if path == op / "plan.json":
                return plan_bytes, copy.deepcopy(plan)
            if path == op / "runtime-bindings" / (binding_sha + ".json") and expected == binding_sha:
                return binding_bytes, json.loads(binding_bytes)
            raise AssertionError(f"Unexpected runtime evidence path: {path}")

        with patch.dict(
            sys.modules,
            {"linux_data_volume_provision": SimpleNamespace(_read=read_with_drift)},
        ):
            with self.assertRaises(ValueError):
                runtime_binding.load_plan(op, linux_request_fixture(binding_sha))


if __name__ == "__main__":
    unittest.main()
