"""Source contract for the strict FEM GPU MFEM/HYPRE stream adapter."""

from __future__ import annotations

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = REPO_ROOT / "docker/fem-gpu/Dockerfile"
SOURCE = REPO_ROOT / "backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.cpp"

_ENV_RE = re.compile(r"^ENV\s+(MFEM_REF|HYPRE_REF)=(\S+)\s*$", re.MULTILINE)
_VERSION_RE = re.compile(
    r"v(?P<major>\d+)\.(?P<minor>\d+)(?:\.(?P<patch>\d+))?"
)
_MFEM_TERM_RE = re.compile(r"MFEM_VERSION\s*!=\s*(\d+)")
_HYPRE_PIN_RE = re.compile(r"HYPRE_RELEASE_NUMBER\s*==\s*(\d+)")


def _pinned_refs() -> dict[str, str]:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    refs = dict(_ENV_RE.findall(dockerfile))
    assert set(refs) == {"MFEM_REF", "HYPRE_REF"}
    return refs


def _release_code(ref: str) -> int:
    match = _VERSION_RE.fullmatch(ref)
    assert match is not None, f"unsupported dependency release ref: {ref!r}"
    major = int(match.group("major"))
    minor = int(match.group("minor"))
    patch = int(match.group("patch") or 0)
    return major * 10000 + minor * 100 + patch


def _mfem_guard_values(source: str) -> tuple[int, ...]:
    guard = re.search(r"^#if\s+([^\n]+)\n#error\b", source, re.MULTILINE)
    assert guard is not None, "MFEM compatibility guard is missing"

    # The adapter intentionally has the simple conjunction of != terms. Parse
    # that small grammar directly instead of evaluating preprocessor text.
    terms = tuple(term.strip().strip("() ") for term in guard.group(1).split("&&"))
    values = tuple(
        int(match.group(1))
        for term in terms
        for match in [_MFEM_TERM_RE.fullmatch(term)]
        if match is not None
    )
    assert len(values) == len(terms), "unexpected MFEM compatibility guard"
    assert values, "MFEM compatibility guard has no allowed versions"
    return values


def _mfem_guard_allows(version: int, rejected_values: tuple[int, ...]) -> bool:
    """Return the version values for which the #if rejection is false."""

    return any(version == rejected_value for rejected_value in rejected_values)


def test_stream_adapter_binds_mfem_guard_to_docker_pin() -> None:
    refs = _pinned_refs()
    mfem_version = _release_code(refs["MFEM_REF"])
    source = SOURCE.read_text(encoding="utf-8")
    allowed_versions = _mfem_guard_values(source)

    # Keep the legacy 4.9 ABI and the pinned image explicitly allowed.
    assert 40900 in allowed_versions
    assert _mfem_guard_allows(mfem_version, allowed_versions)
    assert _mfem_guard_allows(40900, allowed_versions)

    # A future patch/release must fail closed until its ABI compatibility is
    # deliberately reviewed and added to the guard.
    future_patch = mfem_version + 1
    current_major = mfem_version // 10000
    current_minor = (mfem_version % 10000) // 100
    future_release = current_major * 10000 + (current_minor + 1) * 100
    assert not _mfem_guard_allows(future_patch, allowed_versions)
    assert not _mfem_guard_allows(future_release, allowed_versions)


def test_stream_adapter_binds_hypre_assertion_to_docker_pin() -> None:
    refs = _pinned_refs()
    hypre_version = _release_code(refs["HYPRE_REF"])
    source = SOURCE.read_text(encoding="utf-8")

    hypre_pin = _HYPRE_PIN_RE.search(source)
    assert hypre_pin is not None, "HYPRE release assertion is missing"
    assert int(hypre_pin.group(1)) == hypre_version
    assert "#include <HYPRE_config.h>" in source
    assert "#include <_hypre_utilities.h>" in source
    assert re.search(r"\bcudaStream_t\s+hypre_DeviceDataComputeStream\s*\(", source)


if __name__ == "__main__":
    test_stream_adapter_binds_mfem_guard_to_docker_pin()
    test_stream_adapter_binds_hypre_assertion_to_docker_pin()
    print("FEM MFEM/HYPRE stream compatibility source contract passed")
