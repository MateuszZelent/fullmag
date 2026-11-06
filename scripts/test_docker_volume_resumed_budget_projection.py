"""Pure regression tests for a cold-resume quota-only inventory projection."""
import copy
import hashlib
import json
import unittest

from docker_build_control import BuildControlError
import docker_volume_resumed_budget_projection as projection

GIB = 1024 ** 3
OLD_DIGEST = "de9badfe0cc511ad93b86b5fa8942b365808f7b180947852ff6037f0242e85c5"
NEW_DIGEST = "a6914e86b8cdda0e5389cb737b89ddd53b5ecb9b72089eae3aa14bfad9e3db77"


def _reported(value):
    return {"status": "available", "value": value}


def _snapshot(quota=4000):
    return {
        "schema_version": "compute_node_snapshot.v2",
        "node_id": "node-synthetic",
        "boot_id": "boot-synthetic",
        "runtime_owner_id": "owner-synthetic",
        "owner_epoch": 7,
        "host_owner_id": "host-owner-synthetic",
        "host_owner_epoch": 3,
        "inventory_revision": 9,
        "inventory_sha256": OLD_DIGEST,
        "capabilities_revision": 2,
        "cpu": {
            "topology": _reported({"logical_cpus": [{
                "id": 0, "socket_id": None, "numa_node_id": None, "core_id": 0,
                "smt_sibling_ids": [0], "processor_group": None,
                "group_logical_cpu_id": None,
            }]}),
            "os_constraints": {
                "allowed_logical_cpu_ids": _reported([0]),
                "quota": _reported({"mode": "limited", "capacity_millis": quota}),
            },
            "effective_capacity_millis": _reported(quota),
            "load_percent": _reported(0),
        },
        "memory": {"total_bytes": {"status": "available", "value": GIB * 8},
                   "available_bytes": {"status": "available", "value": GIB * 4}},
        "gpus": _reported([{
            "uuid": "GPU-synthetic-0001",
            "pci_id": _reported("0000:00:00.0"),
            "name": _reported("synthetic GPU"),
            "local_ordinal": _reported(0),
            "vram_bytes": _reported(GIB),
            "utilization_percent": _reported(0),
            "temperature_millicelsius": _reported(30000),
            "partition": _reported({"kind": "full_device"}),
            "topology": _reported({"numa_node_id": 0, "pci_root_id": "root-0"}),
            "runtime_compatibility": _reported(["cuda.synthetic"]),
        }]),
        "capabilities": _reported(["fem.gpu"]),
        "sample": {"source": "host_os", "collected_at": "2026-11-06T00:00:00Z",
                   "freshness": {"status": "current"}},
        "enforcement": {},
    }


def _case(requested_memory=6 * GIB):
    stored = {
        "schema_version": "host_resource_ledger_policy.v2",
        "host_id": "a" * 64,
        "topology_sha256": OLD_DIGEST,
        "revision": 9,
        "owner_epoch": 7,
        "allowed_cpu_ids": [0],
        "gpu_vram_bytes_by_uuid": {"GPU-synthetic-0001": GIB},
        "total_budget": {"cpu_millis": 4000, "memory_bytes": 4 * GIB,
                         "storage_bytes": 7 * GIB, "gpu_memory_bytes": GIB},
    }
    requested = copy.deepcopy(stored)
    requested["topology_sha256"] = NEW_DIGEST
    requested["total_budget"].update(cpu_millis=2000, memory_bytes=requested_memory)
    observed = {"cpu_millis": 2000, "memory_bytes": requested_memory + GIB,
                "allowed_cpu_ids": [0]}
    document = {"services": {"backend": {
        "cpus": 2, "mem_limit": observed["memory_bytes"],
        "environment": {"FULLMAG_DOCKER_CPU_MILLIS": "2000",
                         "FULLMAG_DOCKER_MEMORY_BYTES": str(observed["memory_bytes"])},
    }}}
    snapshot = _snapshot()
    raw = json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return requested, stored, document, raw, hashlib.sha256(raw).hexdigest(), observed


class ResumedBudgetProjectionTests(unittest.TestCase):
    def test_projects_only_cpu_memory_and_quota_digest_with_lower_requested_ram(self):
        args = _case(requested_memory=3 * GIB)
        self.assertEqual(projection.validate_projection(*args),
                         {"cpus": 4, "memory_bytes": 5 * GIB})

    def test_projects_only_cpu_memory_and_quota_digest_with_higher_requested_ram(self):
        args = _case(requested_memory=6 * GIB)
        self.assertEqual(projection.validate_projection(*args),
                         {"cpus": 4, "memory_bytes": 5 * GIB})

    def test_rejects_snapshot_cas_or_unknown_schema(self):
        args = _case()
        with self.assertRaisesRegex(BuildControlError, "snapshot.*SHA|snapshot.*digest|CAS"):
            projection.validate_projection(*args[:4], "0" * 64, args[5])
        requested, stored, document, raw, _, observed = _case()
        snapshot = json.loads(raw)
        snapshot["schema_version"] = "compute_node_snapshot.v99"
        raw = json.dumps(snapshot, separators=(",", ":")).encode()
        with self.assertRaisesRegex(BuildControlError, "schema"):
            projection.validate_projection(requested, stored, document, raw,
                                           hashlib.sha256(raw).hexdigest(), observed)

    def test_rejects_changed_snapshot_inventory_or_affinity(self):
        requested, stored, document, raw, _, observed = _case()
        snapshot = json.loads(raw)
        snapshot["cpu"]["topology"]["value"]["logical_cpus"][0]["core_id"] = 1
        raw = json.dumps(snapshot, separators=(",", ":")).encode()
        with self.assertRaisesRegex(BuildControlError, "inventory|topology"):
            projection.validate_projection(requested, stored, document, raw,
                                           hashlib.sha256(raw).hexdigest(), observed)
        changed_observation = dict(observed, allowed_cpu_ids=[1])
        with self.assertRaisesRegex(BuildControlError, "affinity|CPU ids|allowed"):
            projection.validate_projection(*_case()[:5], changed_observation)

    def test_rejects_changed_gpu_epoch_or_non_cpu_memory_budget(self):
        for path, value in (("gpu", "changed"), ("epoch", 8),
                            ("storage", 8 * GIB), ("gpu_budget", 2 * GIB)):
            with self.subTest(path=path):
                requested, stored, document, raw, snapshot_sha, observed = _case()
                if path == "gpu":
                    requested["gpu_vram_bytes_by_uuid"]["GPU-synthetic-0001"] = 2 * GIB
                elif path == "epoch":
                    requested["owner_epoch"] = value
                elif path == "gpu_budget":
                    requested["total_budget"]["gpu_memory_bytes"] = value
                else:
                    requested["total_budget"]["storage_bytes"] = value
                with self.assertRaises(BuildControlError):
                    projection.validate_projection(requested, stored, document, raw, snapshot_sha, observed)
        requested, stored, document, raw, snapshot_sha, observed = _case()
        snapshot = json.loads(raw)
        snapshot["gpus"]["value"][0]["uuid"] = "GPU-synthetic-altered"
        raw = json.dumps(snapshot, separators=(",", ":")).encode()
        with self.assertRaisesRegex(BuildControlError, "inventory|topology"):
            projection.validate_projection(requested, stored, document, raw,
                                           hashlib.sha256(raw).hexdigest(), observed)

    def test_rejects_boolean_numeric_fields_and_policy_schema_drift(self):
        requested, stored, document, raw, snapshot_sha, observed = _case()
        stored["total_budget"]["cpu_millis"] = True
        with self.assertRaisesRegex(BuildControlError, "policy|budget|integer|numeric"):
            projection.validate_projection(requested, stored, document, raw, snapshot_sha, observed)
        requested, stored, document, raw, snapshot_sha, observed = _case()
        observed["cpu_millis"] = True
        with self.assertRaises(BuildControlError):
            projection.validate_projection(requested, stored, document, raw, snapshot_sha, observed)
        requested, stored, document, raw, snapshot_sha, observed = _case()
        document["services"]["backend"]["cpus"] = True
        with self.assertRaises(BuildControlError):
            projection.validate_projection(requested, stored, document, raw, snapshot_sha, observed)
        requested, stored, document, raw, snapshot_sha, observed = _case()
        stored["schema_version"] = "host_resource_ledger_policy.v99"
        with self.assertRaisesRegex(BuildControlError, "schema"):
            projection.validate_projection(requested, stored, document, raw, snapshot_sha, observed)

    def test_rejects_cpu_that_did_not_change_and_observed_compose_drift(self):
        requested, stored, document, raw, snapshot_sha, observed = _case()
        requested["total_budget"]["cpu_millis"] = 4000
        requested["topology_sha256"] = OLD_DIGEST
        observed["cpu_millis"] = 4000
        document["services"]["backend"].update(cpus=4)
        document["services"]["backend"]["environment"]["FULLMAG_DOCKER_CPU_MILLIS"] = "4000"
        with self.assertRaisesRegex(BuildControlError, "CPU.*change|CPU.*differ|quota"):
            projection.validate_projection(requested, stored, document, raw, snapshot_sha, observed)
        requested, stored, document, raw, snapshot_sha, observed = _case()
        document["services"]["backend"]["mem_limit"] += GIB
        with self.assertRaisesRegex(BuildControlError, "Compose|limit|observed"):
            projection.validate_projection(requested, stored, document, raw, snapshot_sha, observed)
        requested, stored, document, raw, snapshot_sha, observed = _case()
        observed["cpu_millis"] = 3000
        with self.assertRaisesRegex(BuildControlError, "observed cgroup limits"):
            projection.validate_projection(requested, stored, document, raw, snapshot_sha, observed)


if __name__ == "__main__":
    unittest.main()
