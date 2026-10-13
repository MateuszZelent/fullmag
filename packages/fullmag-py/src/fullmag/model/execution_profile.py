"""Immutable execution profile authoring and sparse resource overrides.

Omitted fields inherit their value; explicit ``"auto"`` remains a request and
``None`` clears a nullable field. Resolution and admission belong to the shared
application resolver. Constructing a profile never changes an active runtime.
"""

from __future__ import annotations

from collections.abc import Mapping
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


def _object(
    value: object,
    name: str,
    allowed: tuple[str, ...],
) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{name} must be an object")
    if any(not isinstance(key, str) for key in value):
        raise TypeError(f"{name} object keys must be strings")
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        raise ValueError(f"{name} contains unknown field(s): {', '.join(unknown)}")
    return value


def _required(value: Mapping[str, object], key: str, name: str) -> object:
    if key not in value:
        raise ValueError(f"{name}.{key} is required")
    return value[key]


def _compute_target_from_ir(value: object, name: str) -> ComputeTarget:
    target = _object(value, name, ("kind", "id"))
    kind = _required(target, "kind", name)
    if kind == "local":
        if "id" in target:
            raise ValueError(f"{name}.id is not valid for a local target")
        return ComputeTarget()
    if kind in ("node", "pool"):
        return ComputeTarget(
            kind=kind,
            id=_required(target, "id", name),
        )
    return ComputeTarget(kind=kind)


def _gpu_resources_from_ir(value: object, name: str) -> GpuResources:
    gpu = _object(
        value,
        name,
        ("selector", "device_uuids", "devices_per_task", "vram_per_device_bytes"),
    )
    kwargs: dict[str, object] = {
        "selector": _required(gpu, "selector", name),
        "device_uuids": _required(gpu, "device_uuids", name),
        "devices_per_task": _required(gpu, "devices_per_task", name),
    }
    if "vram_per_device_bytes" in gpu:
        if gpu["vram_per_device_bytes"] is None:
            raise TypeError(
                f"{name}.vram_per_device_bytes must be a positive integer when present"
            )
        kwargs["vram_per_device_bytes"] = gpu["vram_per_device_bytes"]
    return GpuResources(**kwargs)


def _parallelism_from_ir(
    value: object,
    name: str,
) -> DistributedResources | Literal["single_process"]:
    parallelism = _object(
        value,
        name,
        ("kind", "ranks", "threads_per_rank", "ranks_per_node", "gpus_per_rank"),
    )
    kind = _required(parallelism, "kind", name)
    if kind == "single_process":
        if set(parallelism) != {"kind"}:
            raise ValueError(f"{name} single_process must contain only kind")
        return "single_process"
    if kind == "distributed":
        return DistributedResources(
            ranks=_required(parallelism, "ranks", name),
            threads_per_rank=_required(parallelism, "threads_per_rank", name),
            ranks_per_node=_required(parallelism, "ranks_per_node", name),
            gpus_per_rank=_required(parallelism, "gpus_per_rank", name),
        )
    raise ValueError(f"{name}.kind must be 'single_process' or 'distributed'")


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

    @classmethod
    def from_ir(cls, value: object) -> CpuResourceOverrides:
        cpu = _object(
            value,
            "cpu",
            (
                "threads",
                "core_policy",
                "affinity",
                "numa_node",
                "native_threads",
                "blas_threads",
            ),
        )
        return cls(**cpu)


@dataclass(frozen=True, slots=True)
class MemoryResourceOverrides:
    """Partial byte reservation; None explicitly clears an inherited value."""

    reservation_bytes: int | None | _Unset = _UNSET

    def __post_init__(self) -> None:
        if self.reservation_bytes is not _UNSET and self.reservation_bytes is not None:
            _checked_integer(self.reservation_bytes, "reservation_bytes", minimum=1, maximum=_U64_MAX)

    def to_ir(self) -> dict[str, object]:
        return _sparse(self)

    @classmethod
    def from_ir(cls, value: object) -> MemoryResourceOverrides:
        memory = _object(value, "memory resource", ("reservation_bytes",))
        return cls(**memory)


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

    @classmethod
    def from_ir(cls, value: object) -> ComputeResourceOverrides:
        """Decode sparse resources, normalizing empty nested patches away."""
        resources = _object(
            value,
            "resources",
            ("target", "cpu", "gpu", "ram", "scratch", "parallelism", "placement"),
        )
        kwargs: dict[str, object] = {}
        if "target" in resources:
            kwargs["target"] = _compute_target_from_ir(
                resources["target"], "resources.target"
            )
        if "cpu" in resources:
            kwargs["cpu"] = CpuResourceOverrides.from_ir(resources["cpu"])
        if "gpu" in resources:
            gpu = resources["gpu"]
            kwargs["gpu"] = (
                None if gpu is None else _gpu_resources_from_ir(gpu, "resources.gpu")
            )
        if "ram" in resources:
            kwargs["ram"] = MemoryResourceOverrides.from_ir(resources["ram"])
        if "scratch" in resources:
            kwargs["scratch"] = MemoryResourceOverrides.from_ir(resources["scratch"])
        if "parallelism" in resources:
            kwargs["parallelism"] = _parallelism_from_ir(
                resources["parallelism"],
                "resources.parallelism",
            )
        if "placement" in resources:
            kwargs["placement"] = resources["placement"]
        return cls(**kwargs)


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

    @classmethod
    def from_ir(cls, value: object) -> ExecutionOverrides:
        """Decode sparse defaults without resolving or filling inherited fields."""
        overrides = _object(
            value,
            "defaults",
            ("backend", "device", "precision", "mode", "resources"),
        )
        kwargs = {
            key: overrides[key]
            for key in ("backend", "device", "precision", "mode")
            if key in overrides
        }
        if "resources" in overrides:
            kwargs["resources"] = ComputeResourceOverrides.from_ir(overrides["resources"])
        return cls(**kwargs)


@dataclass(frozen=True, slots=True)
class ExecutionRequestLayer:
    """One explicitly located sparse execution layer for shared materialization."""

    kind: Literal["script", "study", "step", "submit", "cli", "legacy_env"]
    location: str
    request: ExecutionOverrides = field(default_factory=ExecutionOverrides)

    def __post_init__(self) -> None:
        _choice(
            self.kind,
            "execution_request_layer.origin.kind",
            ("script", "study", "step", "submit", "cli", "legacy_env"),
        )
        if not isinstance(self.location, str):
            raise TypeError("execution_request_layer.origin.location must be a string")
        if not self.location.strip():
            raise ValueError("execution_request_layer.origin.location must be nonempty")
        try:
            location_bytes = len(self.location.encode("utf-8"))
        except UnicodeEncodeError as error:
            raise ValueError(
                "execution_request_layer.origin.location must be valid UTF-8"
            ) from error
        if location_bytes > 4096:
            raise ValueError(
                "execution_request_layer.origin.location exceeds 4096 UTF-8 bytes"
            )
        if any(unicodedata.category(character) == "Cc" for character in self.location):
            raise ValueError(
                "execution_request_layer.origin.location must not contain control characters"
            )
        _typed(self.request, ExecutionOverrides, "request")

    def to_ir(self) -> dict[str, object]:
        return {
            "origin": {"kind": self.kind, "location": self.location},
            "request": self.request.to_ir(),
        }

    @classmethod
    def from_ir(cls, value: object) -> ExecutionRequestLayer:
        layer = _object(value, "execution_request_layer", ("origin", "request"))
        origin = _object(
            _required(layer, "origin", "execution_request_layer"),
            "execution_request_layer.origin",
            ("kind", "location"),
        )
        return cls(
            kind=_required(origin, "kind", "execution_request_layer.origin"),
            location=_required(origin, "location", "execution_request_layer.origin"),
            request=ExecutionOverrides.from_ir(
                layer.get("request", {})
            ),
        )


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

    @classmethod
    def from_ir(cls, value: object) -> ExecutionProfile:
        """Decode a published v1 profile without materializing sparse defaults.

        The API's canonical form emits all fields of a full GPU resource but
        omits empty sparse patches and an absent optional VRAM reservation.
        """
        profile = _object(
            value,
            "execution_profile",
            ("schema_version", "profile_id", "version", "description", "defaults"),
        )
        schema_version = _required(profile, "schema_version", "execution_profile")
        if not isinstance(schema_version, str):
            raise TypeError("execution_profile.schema_version must be a string")
        if schema_version != "execution_profile.v1":
            raise ValueError(f"unsupported execution profile schema {schema_version!r}")
        return cls(
            profile_id=_required(profile, "profile_id", "execution_profile"),
            version=_required(profile, "version", "execution_profile"),
            description=_required(profile, "description", "execution_profile"),
            defaults=ExecutionOverrides.from_ir(
                _required(profile, "defaults", "execution_profile")
            ),
        )


def _parallel_execution_lane(source: Mapping[str, object], backend: object, device: object) -> tuple[object, object]:
    """Project authored selectors for policy validation, never resource admission.

    Profile declarations make legacy selectors inactive. Replay only backend
    and device with the shared application resolver's layer order/conflict
    rules. The original profile/layers remain intact for full Rust binding.
    """
    if "execution_profile" not in source:
        return backend, device
    profile = ExecutionProfile.from_ir(source["execution_profile"])
    raw_layers = source.get("execution_layers", [])
    if not isinstance(raw_layers, list):
        raise TypeError("execution_layers must be a list")
    layers = [ExecutionRequestLayer.from_ir(item) for item in raw_layers]
    values = {"backend": "auto", "device": "auto"}
    origins = {key: "product_default" for key in values}
    defaults = profile.defaults.to_ir()
    for key in values:
        if key in defaults:
            values[key], origins[key] = defaults[key], "profile"
    ranks = {"script": 0, "study": 1, "step": 2, "submit": 3, "cli": 3}
    previous_rank = -1
    submitted = False
    for layer in layers:
        if layer.kind == "legacy_env":
            continue
        rank = ranks[layer.kind]
        if rank < previous_rank:
            raise ValueError("execution_request_layers must be ordered script, study, step, then submit or cli")
        protected = layer.kind in {"submit", "cli"}
        if protected and submitted:
            raise ValueError("execution_request_layers may contain only one submit or cli layer")
        submitted = submitted or protected
        previous_rank = rank
        patch = layer.request.to_ir()
        for key in values:
            if key not in patch:
                continue
            if protected and origins[key] != "product_default" and values[key] != "auto" and values[key] != patch[key]:
                raise ValueError(f"execution_intent_conflict: {key} from {origins[key]} conflicts with {layer.kind}")
            values[key], origins[key] = patch[key], layer.kind
    for layer in layers:
        if layer.kind != "legacy_env":
            continue
        patch = layer.request.to_ir()
        for key in values:
            if key not in patch:
                continue
            if origins[key] != "product_default" and values[key] != patch[key]:
                raise ValueError(f"execution_intent_conflict: {key} conflicts with legacy_env")
            if origins[key] == "product_default":
                values[key], origins[key] = patch[key], "legacy_env"
    return values["backend"], values["device"]
