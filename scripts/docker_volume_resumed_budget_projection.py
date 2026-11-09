"""Pure quota-only projection for a pinned cold-resume budget recovery."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re

from docker_build_control import BuildControlError

GIB = 1024 ** 3
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
POLICY_SCHEMAS = {"host_resource_ledger_policy.v2", "host_resource_ledger_policy.v3"}
SNAPSHOT_SCHEMAS = {"compute_node_snapshot.v1", "compute_node_snapshot.v2"}
POLICY_KEYS = {
    "schema_version", "host_id", "topology_sha256", "revision", "owner_epoch",
    "allowed_cpu_ids", "gpu_vram_bytes_by_uuid", "total_budget",
}
BUDGET_KEYS = {"cpu_millis", "memory_bytes", "storage_bytes", "gpu_memory_bytes"}


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise BuildControlError("Resumed budget projection: " + message)


def _exact_int(value, *, minimum: int = 0) -> bool:
    return type(value) is int and value >= minimum


def _validate_policy(value, label: str) -> None:
    _require(isinstance(value, dict) and set(value) == POLICY_KEYS,
             label + " policy shape is incomplete or unknown")
    _require(isinstance(value.get("schema_version"), str)
             and value["schema_version"] in POLICY_SCHEMAS, label + " policy schema is unsupported")
    _require(isinstance(value.get("host_id"), str) and SHA256.fullmatch(value["host_id"]) is not None
             and isinstance(value.get("topology_sha256"), str)
             and SHA256.fullmatch(value["topology_sha256"]) is not None,
             label + " policy identity digest is malformed")
    _require(_exact_int(value.get("revision"), minimum=1)
             and _exact_int(value.get("owner_epoch"), minimum=1),
             label + " policy revision or epoch is malformed")
    cpu_ids = value.get("allowed_cpu_ids")
    _require(isinstance(cpu_ids, list) and cpu_ids
             and all(_exact_int(cpu_id) for cpu_id in cpu_ids)
             and cpu_ids == sorted(set(cpu_ids)),
             label + " policy CPU affinity is malformed")
    gpu_memory = value.get("gpu_vram_bytes_by_uuid")
    _require(isinstance(gpu_memory, dict)
             and all(isinstance(uuid, str) and uuid and _exact_int(size)
                     for uuid, size in gpu_memory.items()),
             label + " policy GPU inventory is malformed")
    budget = value.get("total_budget")
    _require(isinstance(budget, dict) and set(budget) == BUDGET_KEYS
             and all(_exact_int(amount) for amount in budget.values()),
             label + " policy budget is malformed")
    _require(budget["cpu_millis"] >= 2000 and budget["cpu_millis"] % 1000 == 0
             and budget["memory_bytes"] >= 3 * GIB and budget["memory_bytes"] % GIB == 0,
             label + " CPU or native RAM budget is not integral or below the minimum")


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field: " + key)
        result[key] = value
    return result


def _object(value, keys, label):
    _require(isinstance(value, dict) and set(value) == set(keys),
             label + " object fields do not match the supported schema")
    return value


def _known_reported(value, label):
    _require(isinstance(value, dict), label + " reported value is malformed")
    status = value.get("status")
    if status == "available":
        _object(value, ("status", "value"), label)
        _require(value["value"] is not None, label + " available value is null")
        return value["value"]
    if status == "unavailable":
        _require(set(value) in ({"status", "reason"}, {"status", "reason", "last_known"}),
                 label + " unavailable value has unknown fields")
        _require(isinstance(value.get("reason"), str) and value["reason"] in {
            "not_reported", "permission_denied", "unsupported", "probe_failed",
            "source_unavailable", "future_timestamp",
        }, label + " unavailable reason is unknown")
        last_known = value.get("last_known")
        _require("last_known" not in value or last_known is not None,
                 label + " unavailable last-known value is malformed")
        return last_known
    raise BuildControlError("Resumed budget projection: " + label + " status is unknown")


def _canonical_cpu_topology(value):
    if value is None:
        return None
    _object(value, ("logical_cpus",), "CPU topology")
    processors = value["logical_cpus"]
    _require(isinstance(processors, list), "CPU logical processor list is malformed")
    result = []
    previous = -1
    fields = ("id", "socket_id", "numa_node_id", "core_id", "smt_sibling_ids",
              "processor_group", "group_logical_cpu_id")
    for processor in processors:
        _object(processor, fields, "CPU logical processor")
        cpu_id = processor["id"]
        siblings = processor["smt_sibling_ids"]
        _require(_exact_int(cpu_id) and cpu_id > previous,
                 "CPU logical processor ids are not sorted and unique")
        previous = cpu_id
        _require(isinstance(siblings, list) and siblings
                 and all(_exact_int(item) for item in siblings)
                 and siblings == sorted(set(siblings)) and cpu_id in siblings,
                 "CPU SMT sibling ids are malformed")
        for field in ("socket_id", "numa_node_id", "core_id", "processor_group", "group_logical_cpu_id"):
            _require(processor[field] is None or _exact_int(processor[field]),
                     "CPU logical processor numeric identity is malformed")
        _require((processor["processor_group"] is None) == (processor["group_logical_cpu_id"] is None),
                 "CPU Windows processor group identity is incomplete")
        result.append({field: processor[field] for field in fields})
    _require(result, "CPU topology is empty")
    return {"logical_cpus": result}


def _canonical_quota(value):
    if value is None:
        return None
    _require(isinstance(value, dict) and isinstance(value.get("mode"), str),
             "CPU quota is malformed")
    if value["mode"] == "unlimited":
        _object(value, ("mode",), "unlimited CPU quota")
        return {"mode": "unlimited"}
    if value["mode"] == "limited":
        _object(value, ("mode", "capacity_millis"), "limited CPU quota")
        _require(_exact_int(value["capacity_millis"], minimum=1),
                 "limited CPU quota capacity is malformed")
        return {"mode": "limited", "capacity_millis": value["capacity_millis"]}
    raise BuildControlError("Resumed budget projection: CPU quota mode is unknown")


def _canonical_partition(value):
    if value is None:
        return None
    _require(isinstance(value, dict) and isinstance(value.get("kind"), str),
             "GPU partition identity is malformed")
    if value["kind"] in {"full_device", "unknown"}:
        _object(value, ("kind",), "GPU partition identity")
        return {"kind": value["kind"]}
    if value["kind"] == "mig":
        _object(value, ("kind", "parent_gpu_uuid", "partition_id"), "GPU MIG partition")
        _require(isinstance(value["parent_gpu_uuid"], str) and value["parent_gpu_uuid"]
                 and isinstance(value["partition_id"], str) and value["partition_id"],
                 "GPU MIG partition identity is malformed")
        return {"kind": "mig", "parent_gpu_uuid": value["parent_gpu_uuid"],
                "partition_id": value["partition_id"]}
    raise BuildControlError("Resumed budget projection: GPU partition kind is unknown")


def _canonical_gpu_topology(value):
    if value is None:
        return None
    _object(value, ("numa_node_id", "pci_root_id"), "GPU topology")
    _require(value["numa_node_id"] is None or _exact_int(value["numa_node_id"]),
             "GPU NUMA identity is malformed")
    _require(value["pci_root_id"] is None or isinstance(value["pci_root_id"], str),
             "GPU PCI-root identity is malformed")
    return {"numa_node_id": value["numa_node_id"], "pci_root_id": value["pci_root_id"]}


def _canonical_gpus(value):
    devices = _known_reported(value, "GPU inventory")
    if devices is None:
        return None
    _require(isinstance(devices, list), "GPU inventory is not a list")
    result = []
    previous = ""
    fields = ("uuid", "pci_id", "name", "local_ordinal", "vram_bytes", "utilization_percent",
              "temperature_millicelsius", "partition", "topology", "runtime_compatibility")
    for device in devices:
        _object(device, fields, "GPU device")
        uuid = device["uuid"]
        _require(isinstance(uuid, str) and uuid > previous,
                 "GPU UUID inventory is not sorted and unique")
        previous = uuid
        pci_id = _known_reported(device["pci_id"], "GPU PCI identity")
        partition = _canonical_partition(_known_reported(device["partition"], "GPU partition"))
        topology = _canonical_gpu_topology(_known_reported(device["topology"], "GPU topology"))
        _require(pci_id is None or isinstance(pci_id, str), "GPU PCI identity is malformed")
        result.append({"uuid": uuid, "pci_id": pci_id, "partition": partition, "topology": topology})
    return result


def _snapshot_projection(snapshot_raw: bytes, snapshot_sha256: str, stored):
    _require(type(snapshot_raw) is bytes and 0 < len(snapshot_raw) <= MAX_SNAPSHOT_BYTES,
             "snapshot bytes are absent or exceed the limit")
    _require(isinstance(snapshot_sha256, str) and SHA256.fullmatch(snapshot_sha256) is not None
             and hashlib.sha256(snapshot_raw).hexdigest() == snapshot_sha256,
             "snapshot SHA-256 CAS authentication failed")
    try:
        snapshot = json.loads(snapshot_raw.decode("utf-8"), object_pairs_hook=_unique_json_object,
                              parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise BuildControlError("Resumed budget projection: snapshot JSON is malformed") from error
    _require(isinstance(snapshot, dict), "snapshot root is not an object")
    schema = snapshot.get("schema_version")
    _require(isinstance(schema, str) and schema in SNAPSHOT_SCHEMAS, "snapshot schema is unsupported")
    fields = {"schema_version", "node_id", "boot_id", "runtime_owner_id", "owner_epoch",
              "inventory_revision", "inventory_sha256", "capabilities_revision", "cpu", "memory",
              "gpus", "capabilities", "sample", "enforcement"}
    if schema == "compute_node_snapshot.v1":
        _object(snapshot, fields, "v1 compute-node snapshot")
    else:
        fields |= {"host_owner_id", "host_owner_epoch"}
        _object(snapshot, fields, "v2 compute-node snapshot")
        _require(isinstance(snapshot["host_owner_id"], str) and snapshot["host_owner_id"]
                 and _exact_int(snapshot["host_owner_epoch"], minimum=1),
                 "v2 snapshot owner fence is malformed")
    for key in ("node_id", "boot_id", "runtime_owner_id"):
        _require(isinstance(snapshot.get(key), str) and snapshot[key], "snapshot " + key + " is malformed")
    _require(_exact_int(snapshot.get("owner_epoch"), minimum=1)
             and snapshot["owner_epoch"] == stored["owner_epoch"]
             and _exact_int(snapshot.get("inventory_revision"), minimum=1)
             and _exact_int(snapshot.get("capabilities_revision"), minimum=1),
             "snapshot epoch or revision is malformed or differs from stored policy")
    inventory_sha = snapshot.get("inventory_sha256")
    _require(isinstance(inventory_sha, str) and SHA256.fullmatch(inventory_sha) is not None,
             "snapshot inventory digest is malformed")

    cpu = _object(snapshot.get("cpu"), ("topology", "os_constraints", "effective_capacity_millis", "load_percent"),
                  "CPU snapshot")
    cpu_topology = _canonical_cpu_topology(_known_reported(cpu["topology"], "CPU topology"))
    constraints = _object(cpu["os_constraints"], ("allowed_logical_cpu_ids", "quota"), "CPU constraints")
    allowed = _known_reported(constraints["allowed_logical_cpu_ids"], "CPU affinity")
    _require(isinstance(allowed, list) and allowed
             and all(_exact_int(cpu_id) for cpu_id in allowed)
             and allowed == sorted(set(allowed)), "snapshot CPU affinity is unavailable or malformed")
    quota = _canonical_quota(_known_reported(constraints["quota"], "CPU quota"))
    _require(isinstance(quota, dict) and quota.get("mode") == "limited",
             "snapshot old CPU quota must be a known limited quota")
    _require(quota["capacity_millis"] == stored["total_budget"]["cpu_millis"],
             "snapshot old quota differs from stored CPU budget")
    gpus = _canonical_gpus(snapshot["gpus"])
    canonical = {
        "schema_version": "compute_node_inventory.v1",
        "cpu_topology": cpu_topology,
        "allowed_logical_cpu_ids": allowed,
        "cpu_quota": quota,
        "gpus": gpus,
    }
    return canonical, inventory_sha


def _inventory_sha256(canonical_inventory) -> str:
    raw = json.dumps(canonical_inventory, separators=(",", ":"), ensure_ascii=False,
                     allow_nan=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def validate_projection(requested, stored, document, snapshot_raw: bytes,
                        snapshot_sha256: str, observed_limits: dict) -> dict[str, int]:
    """Authenticate a quota-only resume delta and return the stored DEV budget.

    The caller is responsible for fresh cgroup ancestor/affinity observations,
    the Compose document's resume proof, and locked ledger admission. This
    predicate independently verifies the supplied snapshot and exact policy
    transformation but performs no I/O or recovery action.
    """
    _validate_policy(stored, "stored")
    _validate_policy(requested, "requested")
    _require(type(observed_limits) is dict
             and set(observed_limits) == {"cpu_millis", "memory_bytes", "allowed_cpu_ids"},
             "observed cgroup limits have unknown or missing fields")
    cpu_millis = observed_limits["cpu_millis"]
    memory_bytes = observed_limits["memory_bytes"]
    allowed_cpu_ids = observed_limits["allowed_cpu_ids"]
    _require(_exact_int(cpu_millis, minimum=2000) and cpu_millis % 1000 == 0
             and _exact_int(memory_bytes, minimum=4 * GIB)
             and isinstance(allowed_cpu_ids, list) and allowed_cpu_ids
             and all(_exact_int(cpu_id) for cpu_id in allowed_cpu_ids)
             and allowed_cpu_ids == sorted(set(allowed_cpu_ids)),
             "observed cgroup CPU, RAM or affinity is malformed")
    _require(cpu_millis == requested["total_budget"]["cpu_millis"]
             and memory_bytes == requested["total_budget"]["memory_bytes"] + GIB,
             "observed cgroup limits differ from requested policy")

    services = document.get("services") if isinstance(document, dict) else None
    _require(isinstance(services, dict) and isinstance(services.get("backend"), dict),
             "Compose backend service is missing")
    service = services["backend"]
    environment = service.get("environment")
    cpus = service.get("cpus")
    cpu_number_is_valid = type(cpus) is int or type(cpus) is float and math.isfinite(cpus)
    _require(cpu_number_is_valid
             and cpus == cpu_millis / 1000
             and _exact_int(service.get("mem_limit")) and service["mem_limit"] == memory_bytes
             and isinstance(environment, dict)
             and environment.get("FULLMAG_DOCKER_CPU_MILLIS") == str(cpu_millis)
             and environment.get("FULLMAG_DOCKER_MEMORY_BYTES") == str(memory_bytes),
             "Compose backend CPU/RAM/environment differs from observed limits")

    canonical, inventory_sha = _snapshot_projection(snapshot_raw, snapshot_sha256, stored)
    old_digest = _inventory_sha256(canonical)
    _require(stored["topology_sha256"] == inventory_sha == old_digest,
             "stored topology and snapshot inventory digest do not authenticate")
    _require(canonical["allowed_logical_cpu_ids"] == stored["allowed_cpu_ids"] == allowed_cpu_ids,
             "observed affinity differs from authenticated stored CPU ids")
    _require(cpu_millis != stored["total_budget"]["cpu_millis"],
             "resume CPU quota did not change")

    projected_inventory = copy.deepcopy(canonical)
    projected_inventory["cpu_quota"] = {"mode": "limited", "capacity_millis": cpu_millis}
    projected_digest = _inventory_sha256(projected_inventory)
    expected = copy.deepcopy(stored)
    expected["topology_sha256"] = projected_digest
    expected["total_budget"]["cpu_millis"] = cpu_millis
    expected["total_budget"]["memory_bytes"] = requested["total_budget"]["memory_bytes"]
    _require(requested == expected,
             "requested policy changes identity, epoch, GPU, storage or another budget")
    _require(requested["topology_sha256"] == projected_digest,
             "requested topology digest is not the recomputed quota projection")

    old_cpu_millis = stored["total_budget"]["cpu_millis"]
    old_memory_bytes = stored["total_budget"]["memory_bytes"] + GIB
    _require(old_cpu_millis >= 2000 and old_cpu_millis % 1000 == 0
             and old_memory_bytes >= 4 * GIB and old_memory_bytes % GIB == 0,
             "stored budget cannot map to integral DEV CPU/GiB limits")
    return {"cpus": old_cpu_millis // 1000, "memory_bytes": old_memory_bytes}
