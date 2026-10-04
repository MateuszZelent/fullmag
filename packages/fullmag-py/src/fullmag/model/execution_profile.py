"""Immutable execution profile authoring and sparse resource overrides.

Omitted fields inherit their value; explicit ``"auto"`` remains a request and
``None`` clears a nullable field. Resolution and admission belong to the shared
application resolver. Constructing a profile never changes an active runtime.
"""

from __future__ import annotations

from dataclasses import dataclass, field, fields
from enum import Enum
from hashlib import sha256
import json
from typing import Literal
import unicodedata

from .compute_resources import (
    ComputeTarget, DistributedResources, GpuResources, ThreadRequest,
    _checked_integer, _choice, _identity, _thread_request, _U32_MAX, _U64_MAX,
)


class _Unset(Enum):
    VALUE = "unset"


_UNSET = _Unset.VALUE


def _typed(value: object, expected: type, name: str) -> None:
    if not isinstance(value, expected):
        raise TypeError(f"{name} must be {expected.__name__}")


def _sparse(value: object) -> dict[str, object]:
    result: dict[str, object] = {}
    for item in fields(value):
        member = getattr(value, item.name)
        if member is _UNSET:
            continue
        if hasattr(member, "to_ir"):
            member = member.to_ir()
            if member == {}:
                continue
        result[item.name] = member
    return result


@dataclass(frozen=True, slots=True)
class CpuResourceOverrides:
    """Partial CPU request; coupled constraints are checked after inheritance."""

    threads: ThreadRequest | _Unset = _UNSET
    core_policy: Literal["physical_first", "logical"] | None | _Unset = _UNSET
    affinity: Literal["auto", "compact", "spread", "numa"] | _Unset = _UNSET
    numa_node: int | None | _Unset = _UNSET
    native_threads: ThreadRequest | _Unset = _UNSET
    blas_threads: ThreadRequest | _Unset = _UNSET

    def __post_init__(self) -> None:
        for name in ("threads", "native_threads", "blas_threads"):
            value = getattr(self, name)
            if value is not _UNSET:
                _thread_request(value, f"cpu.{name}")
        if self.core_policy is not _UNSET and self.core_policy is not None:
            _choice(self.core_policy, "cpu.core_policy", ("physical_first", "logical"))
        if self.affinity is not _UNSET:
            _choice(self.affinity, "cpu.affinity", ("auto", "compact", "spread", "numa"))
        if self.numa_node is not _UNSET and self.numa_node is not None:
            _checked_integer(self.numa_node, "cpu.numa_node", minimum=0, maximum=_U32_MAX)

    def to_ir(self) -> dict[str, object]:
        return _sparse(self)


@dataclass(frozen=True, slots=True)
class MemoryResourceOverrides:
    """Partial byte reservation; None explicitly clears an inherited value."""

    reservation_bytes: int | None | _Unset = _UNSET

    def __post_init__(self) -> None:
        if self.reservation_bytes is not _UNSET and self.reservation_bytes is not None:
            _checked_integer(self.reservation_bytes, "reservation_bytes", minimum=1, maximum=_U64_MAX)

    def to_ir(self) -> dict[str, object]:
        return _sparse(self)


@dataclass(frozen=True, slots=True)
class ComputeResourceOverrides:
    """Sparse compute fields, separate from a fully specified ComputeResources."""

    target: ComputeTarget | _Unset = _UNSET
    cpu: CpuResourceOverrides = field(default_factory=CpuResourceOverrides)
    gpu: GpuResources | None | _Unset = _UNSET
    ram: MemoryResourceOverrides = field(default_factory=MemoryResourceOverrides)
    scratch: MemoryResourceOverrides = field(default_factory=MemoryResourceOverrides)
    parallelism: DistributedResources | Literal["single_process"] | _Unset = _UNSET
    placement: Literal["balanced", "throughput", "pinned"] | _Unset = _UNSET

    def __post_init__(self) -> None:
        _typed(self.cpu, CpuResourceOverrides, "cpu")
        _typed(self.ram, MemoryResourceOverrides, "ram")
        _typed(self.scratch, MemoryResourceOverrides, "scratch")
        if self.target is not _UNSET:
            _typed(self.target, ComputeTarget, "target")
        if self.gpu is not _UNSET and self.gpu is not None:
            _typed(self.gpu, GpuResources, "gpu")
        if self.parallelism is not _UNSET and self.parallelism != "single_process":
            _typed(self.parallelism, DistributedResources, "parallelism")
        if self.placement is not _UNSET:
            _choice(self.placement, "placement", ("balanced", "throughput", "pinned"))

    def to_ir(self) -> dict[str, object]:
        result = _sparse(self)
        if self.parallelism == "single_process":
            result["parallelism"] = {"kind": "single_process"}
        return result


@dataclass(frozen=True, slots=True)
class ExecutionOverrides:
    """Typed partial execution input for a profile or an explicit authoring layer."""

    backend: Literal["auto", "fdm", "fem", "hybrid"] | _Unset = _UNSET
    device: Literal["auto", "cpu", "gpu"] | _Unset = _UNSET
    precision: Literal["single", "double"] | _Unset = _UNSET
    mode: Literal["strict", "extended", "hybrid"] | _Unset = _UNSET
    resources: ComputeResourceOverrides = field(default_factory=ComputeResourceOverrides)

    def __post_init__(self) -> None:
        for name, choices in (
            ("backend", ("auto", "fdm", "fem", "hybrid")),
            ("device", ("auto", "cpu", "gpu")),
            ("precision", ("single", "double")),
            ("mode", ("strict", "extended", "hybrid")),
        ):
            value = getattr(self, name)
            if value is not _UNSET:
                _choice(value, name, choices)
        _typed(self.resources, ComputeResourceOverrides, "resources")

    def to_ir(self) -> dict[str, object]:
        return _sparse(self)


@dataclass(frozen=True, slots=True)
class ExecutionProfile:
    """Portable immutable profile version, ready for application materialization.

    ``canonical_sha256`` identifies this exact version's content. It is not a
    runtime capability, allocation, or proof that the requested solver ran.
    """

    profile_id: str
    version: str
    defaults: ExecutionOverrides = field(default_factory=ExecutionOverrides)
    description: str = ""

    def __post_init__(self) -> None:
        for name in ("profile_id", "version"):
            value = _identity(getattr(self, name), name)
            if any(unicodedata.category(character) == "Cc" for character in value):
                raise ValueError(f"{name} must not contain control characters")
        if self.version.lower() == "latest":
            raise ValueError("profile version must be pinned, not latest")
        _typed(self.defaults, ExecutionOverrides, "defaults")
        if not isinstance(self.description, str):
            raise TypeError("description must be a string")
        if len(self.description.encode("utf-8")) > 4096:
            raise ValueError("description exceeds 4096 UTF-8 bytes")

    def to_ir(self) -> dict[str, object]:
        return {
            "schema_version": "execution_profile.v1",
            "profile_id": self.profile_id,
            "version": self.version,
            "description": self.description,
            "defaults": self.defaults.to_ir(),
        }

    def canonical_sha256(self) -> str:
        payload = json.dumps(self.to_ir(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return sha256(payload.encode("utf-8")).hexdigest()
