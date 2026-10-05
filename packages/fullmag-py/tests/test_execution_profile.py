from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
from hashlib import sha256
import json
from pathlib import Path

import fullmag as fm
import pytest


def _published_profile_wire() -> dict[str, object]:
    return {
        "schema_version": "execution_profile.v1",
        "profile_id": "exec:gpu-pool",
        "version": "3",
        "description": "Pinned GPU profile",
        "defaults": {
            "backend": "fem",
            "device": "gpu",
            "precision": "double",
            "mode": "extended",
            "resources": {
                "target": {"kind": "pool", "id": "gpu-pool"},
                "cpu": {
                    "threads": "auto",
                    "core_policy": None,
                    "affinity": "numa",
                    "numa_node": 0,
                    "native_threads": 4,
                    "blas_threads": 2,
                },
                "gpu": {
                    "selector": "allow_list",
                    "device_uuids": ["GPU-1", "GPU-2"],
                    "devices_per_task": 2,
                    "vram_per_device_bytes": 2_147_483_648,
                },
                "ram": {"reservation_bytes": 8_589_934_592},
                "scratch": {"reservation_bytes": 4_294_967_296},
                "parallelism": {
                    "kind": "distributed",
                    "ranks": 2,
                    "threads_per_rank": 8,
                    "ranks_per_node": 2,
                    "gpus_per_rank": 1,
                },
                "placement": "throughput",
            },
        },
    }


def test_omission_auto_and_nullable_reset_are_distinct() -> None:
    assert fm.ExecutionOverrides().to_ir() == {}
    assert fm.CpuResourceOverrides().to_ir() == {}
    assert fm.CpuResourceOverrides(threads="auto", numa_node=None).to_ir() == {
        "threads": "auto", "numa_node": None,
    }
    assert fm.ComputeResourceOverrides(gpu=None).to_ir() == {"gpu": None}
    assert fm.MemoryResourceOverrides(reservation_bytes=None).to_ir() == {"reservation_bytes": None}


def test_only_authored_fields_are_exported_in_nested_patch() -> None:
    patch = fm.ExecutionOverrides(resources=fm.ComputeResourceOverrides(
        cpu=fm.CpuResourceOverrides(threads=4),
    ))
    assert patch.to_ir() == {"resources": {"cpu": {"threads": 4}}}
    assert fm.ComputeResourceOverrides(parallelism="single_process").to_ir() == {
        "parallelism": {"kind": "single_process"},
    }


@pytest.mark.parametrize("value", [None, True, 0, -1, 1.5, 2**32, "4"])
def test_sparse_threads_reject_invalid_values(value: object) -> None:
    with pytest.raises((ValueError, TypeError)):
        fm.CpuResourceOverrides(threads=value)


@pytest.mark.parametrize("version", ["", "latest", "LATEST", "v 1", "v\x00", "v\x80", "a" * 257])
def test_profile_requires_a_pinned_portable_version(version: str) -> None:
    with pytest.raises(ValueError):
        fm.ExecutionProfile("exec:local", version)


def test_profile_exports_shared_wire_fixture_and_stable_content_identity() -> None:
    expected = json.loads((Path(__file__).parent / "fixtures/execution_profile.v1.json").read_text(encoding="utf-8"))
    profile = fm.ExecutionProfile(
        "exec:interactive", "1", description="Profil żółć / CPU",
        defaults=fm.ExecutionOverrides(backend="fdm", device="cpu", resources=fm.ComputeResourceOverrides(
            cpu=fm.CpuResourceOverrides(threads=4, affinity="compact"),
            ram=fm.MemoryResourceOverrides(reservation_bytes=1073741824),
        )),
    )
    assert profile.to_ir() == expected
    imported = fm.ExecutionProfile.from_ir(expected)
    assert imported.to_ir() == expected
    assert imported.canonical_sha256() == profile.canonical_sha256()
    assert len(profile.canonical_sha256()) == 64
    assert replace(profile, description="different").canonical_sha256() != profile.canonical_sha256()
    assert replace(profile, version="2").canonical_sha256() != profile.canonical_sha256()
    exported = profile.to_ir()
    exported["defaults"]["resources"]["cpu"]["threads"] = 64
    assert profile.to_ir() == expected
    with pytest.raises(FrozenInstanceError):
        profile.version = "2"


def test_published_profile_import_roundtrips_full_resources_and_hash() -> None:
    wire = _published_profile_wire()
    expected = json.loads(json.dumps(wire))
    profile = fm.ExecutionProfile.from_ir(wire)

    assert profile.to_ir() == expected
    canonical = json.dumps(
        expected,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    expected_hash = sha256(canonical).hexdigest()
    assert profile.canonical_sha256() == expected_hash

    wire["defaults"]["resources"]["gpu"]["device_uuids"].append("GPU-3")
    exported = profile.to_ir()
    assert exported == expected
    exported["defaults"]["resources"]["gpu"]["device_uuids"].append("GPU-4")
    assert profile.to_ir() == expected
    assert profile.canonical_sha256() == expected_hash


def test_import_preserves_omitted_auto_and_explicit_null_resets() -> None:
    wire = {
        "schema_version": "execution_profile.v1",
        "profile_id": "exec:sparse",
        "version": "1",
        "description": "Sparse patch",
        "defaults": {
            "device": "auto",
            "resources": {
                "cpu": {"threads": "auto", "core_policy": None, "numa_node": None},
                "gpu": None,
                "ram": {"reservation_bytes": None},
                "scratch": {"reservation_bytes": None},
            },
        },
    }

    profile = fm.ExecutionProfile.from_ir(wire)

    assert profile.to_ir() == wire
    assert "backend" not in profile.defaults.to_ir()
    assert "affinity" not in profile.defaults.resources.cpu.to_ir()
    assert profile.defaults.resources.cpu.to_ir()["threads"] == "auto"
    assert profile.defaults.resources.gpu is None


def test_import_parses_target_and_parallelism_variants() -> None:
    for target in (
        {"kind": "local"},
        {"kind": "node", "id": "node-a"},
    ):
        wire = _published_profile_wire()
        wire["defaults"]["resources"]["target"] = target
        assert fm.ExecutionProfile.from_ir(wire).to_ir() == wire

    wire = _published_profile_wire()
    wire["defaults"]["resources"]["parallelism"] = {"kind": "single_process"}
    assert fm.ExecutionProfile.from_ir(wire).to_ir() == wire


def test_import_accepts_absent_optional_gpu_vram_and_normalizes_empty_patches() -> None:
    wire = _published_profile_wire()
    wire["defaults"]["resources"]["gpu"].pop("vram_per_device_bytes")
    assert fm.ExecutionProfile.from_ir(wire).to_ir() == wire

    wire = {
        "schema_version": "execution_profile.v1",
        "profile_id": "exec:empty-patches",
        "version": "1",
        "description": "Empty sparse containers normalize to omission",
        "defaults": {"resources": {"cpu": {}, "ram": {}, "scratch": {}}},
    }
    profile = fm.ExecutionProfile.from_ir(wire)

    assert profile.to_ir() == {**wire, "defaults": {}}


@pytest.mark.parametrize(
    "edit",
    [
        lambda wire: wire.update(extra=True),
        lambda wire: wire.update(schema_version="execution_profile.v2"),
        lambda wire: wire.update(version="latest"),
        lambda wire: wire.pop("description"),
        lambda wire: wire.update(defaults=[]),
        lambda wire: wire["defaults"].update(extra="value"),
        lambda wire: wire["defaults"].update(device=None),
        lambda wire: wire["defaults"]["resources"].update(cpu={"unknown": 1}),
        lambda wire: wire["defaults"]["resources"].update(cpu={"threads": True}),
        lambda wire: wire["defaults"]["resources"].update(
            ram={"reservation_bytes": True}
        ),
        lambda wire: wire["defaults"]["resources"].update(
            target={"kind": "local", "id": None}
        ),
        lambda wire: wire["defaults"]["resources"].update(
            gpu={
                "selector": "required",
                "device_uuids": ["GPU-1"],
                "devices_per_task": True,
            }
        ),
        lambda wire: wire["defaults"]["resources"]["gpu"].pop("devices_per_task"),
        lambda wire: wire["defaults"]["resources"].update(
            parallelism={"kind": "single_process", "ranks": 1}
        ),
        lambda wire: wire["defaults"]["resources"].update(
            parallelism={
                "kind": "distributed",
                "ranks": True,
                "threads_per_rank": 8,
                "ranks_per_node": 2,
                "gpus_per_rank": 1,
            }
        ),
    ],
    ids=[
        "unknown-profile-field",
        "unsupported-schema",
        "mutable-version",
        "missing-published-field",
        "wrong-defaults-shape",
        "unknown-default-field",
        "null-nonnullable-device",
        "unknown-cpu-field",
        "boolean-thread-count",
        "boolean-memory-reservation",
        "local-target-with-id",
        "boolean-gpu-count",
        "missing-full-gpu-device-count",
        "single-process-extra-field",
        "boolean-distributed-rank-count",
    ],
)
def test_profile_import_rejects_invalid_published_shapes(edit) -> None:
    wire = _published_profile_wire()
    edit(wire)
    with pytest.raises((TypeError, ValueError)):
        fm.ExecutionProfile.from_ir(wire)


@pytest.mark.parametrize("factory,kwargs", [
    (fm.ExecutionOverrides, {"device": None}),
    (fm.ExecutionOverrides, {"precision": "mixed"}),
    (fm.ExecutionOverrides, {"resources": {}}),
    (fm.ComputeResourceOverrides, {"cpu": None}),
    (fm.ComputeResourceOverrides, {"target": None}),
    (fm.ComputeResourceOverrides, {"parallelism": None}),
    (fm.MemoryResourceOverrides, {"reservation_bytes": True}),
    (fm.MemoryResourceOverrides, {"reservation_bytes": 2**64}),
])
def test_patch_types_do_not_accept_untyped_or_invalid_values(factory, kwargs) -> None:
    with pytest.raises((TypeError, ValueError)):
        factory(**kwargs)
