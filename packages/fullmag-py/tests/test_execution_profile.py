from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
import json
from pathlib import Path

import fullmag as fm
import pytest


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
    assert len(profile.canonical_sha256()) == 64
    assert replace(profile, description="different").canonical_sha256() != profile.canonical_sha256()
    assert replace(profile, version="2").canonical_sha256() != profile.canonical_sha256()
    exported = profile.to_ir()
    exported["defaults"]["resources"]["cpu"]["threads"] = 64
    assert profile.to_ir() == expected
    with pytest.raises(FrozenInstanceError):
        profile.version = "2"


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
