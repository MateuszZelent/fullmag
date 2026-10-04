"""Typed requested CPU, GPU, memory, and placement resources.

These values preserve author intent in ProblemIR. They do not assert that a
runtime can satisfy the request or that a scheduler has allocated resources.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

_U32_MAX = (1 << 32) - 1
_U64_MAX = (1 << 64) - 1
_SCHEMA_VERSION = "compute_resources.v1"

ThreadRequest = int | Literal["auto"]


def _checked_integer(
    value: object,
    field_name: str,
    *,
    minimum: int,
    maximum: int,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field_name} must be an integer")
    if value < minimum:
        qualifier = "positive" if minimum == 1 else f">= {minimum}"
        raise ValueError(f"{field_name} must be {qualifier}")
    if value > maximum:
        raise ValueError(f"{field_name} exceeds its maximum value {maximum}")
    return value


def _thread_request(value: object, field_name: str) -> ThreadRequest:
    if isinstance(value, str):
        if value == "auto":
            return value
        raise ValueError(f"{field_name} must be 'auto' or a positive u32")
    return _checked_integer(value, field_name, minimum=1, maximum=_U32_MAX)


def _choice(value: object, field_name: str, choices: tuple[str, ...]) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    if value not in choices:
        allowed = ", ".join(repr(choice) for choice in choices)
        raise ValueError(f"{field_name} must be one of {allowed}")
    return value


def _identity(value: object, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    if not value or len(value.encode("utf-8")) > 256 or any(c.isspace() for c in value):
        raise ValueError(
            f"{field_name} must be a nonempty identifier without whitespace "
            "(max 256 UTF-8 bytes)"
        )
    return value


@dataclass(frozen=True, slots=True)
class ComputeTarget:
    """Requested execution target; local is the portable default."""

    kind: Literal["local", "node", "pool"] = "local"
    id: str | None = None

    def __post_init__(self) -> None:
        _choice(self.kind, "compute_resources.target.kind", ("local", "node", "pool"))
        if self.kind == "local":
            if self.id is not None:
                raise ValueError("compute_resources.target.id is only valid for node or pool")
        else:
            _identity(self.id, "compute_resources.target.id")

    def to_ir(self) -> dict[str, object]:
        result: dict[str, object] = {"kind": self.kind}
        if self.id is not None:
            result["id"] = self.id
        return result


@dataclass(frozen=True, slots=True)
class CpuResources:
    """CPU thread budget and requested process placement policy."""

    threads: ThreadRequest = "auto"
    core_policy: Literal["physical_first", "logical"] | None = None
    affinity: Literal["auto", "compact", "spread", "numa"] = "auto"
    numa_node: int | None = None
    native_threads: ThreadRequest = "auto"
    blas_threads: ThreadRequest = "auto"

    def __post_init__(self) -> None:
        threads = _thread_request(self.threads, "compute_resources.cpu.threads")
        native_threads = _thread_request(
            self.native_threads, "compute_resources.cpu.native_threads"
        )
        blas_threads = _thread_request(
            self.blas_threads, "compute_resources.cpu.blas_threads"
        )
        if self.core_policy is not None:
            _choice(
                self.core_policy,
                "compute_resources.cpu.core_policy",
                ("physical_first", "logical"),
            )
        affinity = _choice(
            self.affinity,
            "compute_resources.cpu.affinity",
            ("auto", "compact", "spread", "numa"),
        )
        numa_node = self.numa_node
        if numa_node is not None:
            _checked_integer(
                numa_node,
                "compute_resources.cpu.numa_node",
                minimum=0,
                maximum=_U32_MAX,
            )
        if (affinity == "numa") != (numa_node is not None):
            raise ValueError(
                "compute_resources.cpu.numa_node is required exactly when affinity is 'numa'"
            )
        if isinstance(threads, int):
            for field_name, requested in (
                ("native_threads", native_threads),
                ("blas_threads", blas_threads),
            ):
                if isinstance(requested, int) and requested > threads:
                    raise ValueError(
                        f"compute_resources.cpu.{field_name} exceeds cpu.threads"
                    )

    def to_ir(self) -> dict[str, object]:
        result: dict[str, object] = {
            "threads": self.threads,
            "affinity": self.affinity,
            "native_threads": self.native_threads,
            "blas_threads": self.blas_threads,
        }
        if self.core_policy is not None:
            result["core_policy"] = self.core_policy
        if self.numa_node is not None:
            result["numa_node"] = self.numa_node
        return result


@dataclass(frozen=True, slots=True)
class GpuResources:
    """Requested GPU selector and per-task device/memory requirements."""

    selector: Literal["any_compatible", "allow_list", "required"] = "any_compatible"
    device_uuids: tuple[str, ...] = ()
    devices_per_task: int = 1
    vram_per_device_bytes: int | None = None

    def __post_init__(self) -> None:
        selector = _choice(
            self.selector,
            "compute_resources.gpu.selector",
            ("any_compatible", "allow_list", "required"),
        )
        _checked_integer(
            self.devices_per_task,
            "compute_resources.gpu.devices_per_task",
            minimum=1,
            maximum=_U32_MAX,
        )
        if self.vram_per_device_bytes is not None:
            _checked_integer(
                self.vram_per_device_bytes,
                "compute_resources.gpu.vram_per_device_bytes",
                minimum=1,
                maximum=_U64_MAX,
            )
        if not isinstance(self.device_uuids, (tuple, list)):
            raise TypeError("compute_resources.gpu.device_uuids must be a list or tuple of strings")
        normalized_uuids = tuple(
            _identity(value, "compute_resources.gpu.device_uuids entry")
            for value in self.device_uuids
        )
        if len(set(normalized_uuids)) != len(normalized_uuids):
            raise ValueError("compute_resources.gpu.device_uuids must not contain duplicates")
        object.__setattr__(self, "device_uuids", normalized_uuids)

        uuid_count = len(normalized_uuids)
        valid = (
            selector == "any_compatible" and uuid_count == 0
            or selector == "required" and uuid_count == 1 and self.devices_per_task == 1
            or selector == "allow_list" and uuid_count > 0 and uuid_count >= self.devices_per_task
        )
        if not valid:
            raise ValueError(
                "compute_resources.gpu.selector conflicts with device_uuids or devices_per_task"
            )

    def to_ir(self) -> dict[str, object]:
        result: dict[str, object] = {
            "selector": self.selector,
            "device_uuids": list(self.device_uuids),
            "devices_per_task": self.devices_per_task,
        }
        if self.vram_per_device_bytes is not None:
            result["vram_per_device_bytes"] = self.vram_per_device_bytes
        return result


@dataclass(frozen=True, slots=True)
class MemoryReservation:
    """Optional positive byte reservation for RAM or scratch storage."""

    reservation_bytes: int | None = None

    def __post_init__(self) -> None:
        if self.reservation_bytes is not None:
            _checked_integer(
                self.reservation_bytes,
                "reservation_bytes",
                minimum=1,
                maximum=_U64_MAX,
            )

    def to_ir(self) -> dict[str, object]:
        if self.reservation_bytes is None:
            return {}
        return {"reservation_bytes": self.reservation_bytes}


@dataclass(frozen=True, slots=True)
class DistributedResources:
    """Requested one-solve MPI-style rank topology (not a capability claim)."""

    ranks: int
    threads_per_rank: int
    ranks_per_node: int
    gpus_per_rank: int = 0

    def __post_init__(self) -> None:
        for field_name, value in (
            ("ranks", self.ranks),
            ("threads_per_rank", self.threads_per_rank),
            ("ranks_per_node", self.ranks_per_node),
        ):
            _checked_integer(
                value,
                f"compute_resources.parallelism.{field_name}",
                minimum=1,
                maximum=_U32_MAX,
            )
        _checked_integer(
            self.gpus_per_rank,
            "compute_resources.parallelism.gpus_per_rank",
            minimum=0,
            maximum=_U32_MAX,
        )
        if self.ranks_per_node > self.ranks:
            raise ValueError(
                "compute_resources.parallelism.ranks_per_node must not exceed ranks"
            )

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "distributed",
            "ranks": self.ranks,
            "threads_per_rank": self.threads_per_rank,
            "ranks_per_node": self.ranks_per_node,
            "gpus_per_rank": self.gpus_per_rank,
        }


@dataclass(frozen=True, slots=True)
class ComputeResources:
    """Canonical compute-resource request stored in ProblemIR metadata."""

    target: ComputeTarget = field(default_factory=ComputeTarget)
    cpu: CpuResources = field(default_factory=CpuResources)
    gpu: GpuResources | None = None
    ram: MemoryReservation = field(default_factory=MemoryReservation)
    scratch: MemoryReservation = field(default_factory=MemoryReservation)
    parallelism: DistributedResources | None = None
    placement: Literal["balanced", "throughput", "pinned"] = "balanced"

    def __post_init__(self) -> None:
        if not isinstance(self.target, ComputeTarget):
            raise TypeError("compute_resources.target must be a ComputeTarget")
        if not isinstance(self.cpu, CpuResources):
            raise TypeError("compute_resources.cpu must be a CpuResources")
        if self.gpu is not None and not isinstance(self.gpu, GpuResources):
            raise TypeError("compute_resources.gpu must be a GpuResources or None")
        if not isinstance(self.ram, MemoryReservation):
            raise TypeError("compute_resources.ram must be a MemoryReservation")
        if not isinstance(self.scratch, MemoryReservation):
            raise TypeError("compute_resources.scratch must be a MemoryReservation")
        if self.parallelism is not None and not isinstance(
            self.parallelism, DistributedResources
        ):
            raise TypeError(
                "compute_resources.parallelism must be DistributedResources or None"
            )
        _choice(
            self.placement,
            "compute_resources.placement",
            ("balanced", "throughput", "pinned"),
        )

        if self.parallelism is None:
            if self.gpu is not None and self.gpu.devices_per_task != 1:
                raise ValueError(
                    "compute_resources: multiple GPUs per task requires distributed parallelism"
                )
        else:
            if isinstance(self.cpu.threads, int) and (
                self.cpu.threads != self.parallelism.threads_per_rank
            ):
                raise ValueError(
                    "compute_resources.cpu.threads must equal distributed.threads_per_rank"
                )
            gpu_budget = self.parallelism.ranks * self.parallelism.gpus_per_rank
            if gpu_budget > _U32_MAX:
                raise ValueError(
                    "compute_resources.distributed GPU rank budget exceeds positive u32"
                )
            requested_gpus = 0 if self.gpu is None else self.gpu.devices_per_task
            if gpu_budget != requested_gpus:
                raise ValueError(
                    "compute_resources.distributed GPU rank budget conflicts with devices_per_task"
                )

    def to_ir(self) -> dict[str, object]:
        result: dict[str, object] = {
            "schema_version": _SCHEMA_VERSION,
            "target": self.target.to_ir(),
            "cpu": self.cpu.to_ir(),
            "ram": self.ram.to_ir(),
            "scratch": self.scratch.to_ir(),
            "parallelism": (
                {"kind": "single_process"}
                if self.parallelism is None
                else self.parallelism.to_ir()
            ),
            "placement": self.placement,
        }
        if self.gpu is not None:
            result["gpu"] = self.gpu.to_ir()
        return result
