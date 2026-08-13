"""Fail-closed precision provenance checks for managed multilayer CUDA parity."""

from __future__ import annotations

import argparse
from collections.abc import Mapping
import json
from pathlib import Path
from typing import Any


CUDA_IDENTITY_FIELDS = (
    "device_name",
    "compute_capability",
    "cuda_driver_version",
    "cuda_runtime_version",
)


def _required_cuda_identity(provenance: Mapping[str, Any]) -> dict[str, Any]:
    identity: dict[str, Any] = {}
    for field in CUDA_IDENTITY_FIELDS:
        value = provenance.get(field)
        if value is None:
            raise ValueError(f"cuda_identity_incomplete:{field}")
        if field in {"device_name", "compute_capability"}:
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"cuda_identity_invalid:{field}")
        elif isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"cuda_identity_invalid:{field}")
        identity[field] = value
    return identity


def validate_cuda_identity(provenance: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and return the typed CUDA device identity."""

    return _required_cuda_identity(provenance)


def validate_precision_contract(
    reference_provenance: Mapping[str, Any],
    candidate_provenance: Mapping[str, Any],
    lane: str,
) -> dict[str, object]:
    """Validate lane precision and CUDA identity before numerical comparison."""

    if lane not in {"cuda-fp64", "cuda-fp32"}:
        raise ValueError(f"unsupported_cuda_multilayer_lane:{lane}")

    reference_precision = reference_provenance.get("precision")
    candidate_precision = candidate_provenance.get("precision")
    if reference_precision != "double":
        reason = (
            "cuda_fp32_reference_precision_not_double"
            if lane == "cuda-fp32"
            else "cuda_fp64_reference_precision_not_double"
        )
        raise ValueError(reason)

    expected_candidate = "single" if lane == "cuda-fp32" else "double"
    if candidate_precision != expected_candidate:
        reason = (
            "cuda_fp32_candidate_precision_not_single"
            if lane == "cuda-fp32"
            else "cuda_fp64_candidate_precision_not_double"
        )
        raise ValueError(reason)

    candidate_identity = _required_cuda_identity(candidate_provenance)
    identity_match: bool | None = None
    if lane == "cuda-fp32":
        reference_identity = _required_cuda_identity(reference_provenance)
        for field in CUDA_IDENTITY_FIELDS:
            if reference_identity[field] != candidate_identity[field]:
                raise ValueError(f"cuda_fp32_identity_mismatch:{field}")
        identity_match = True

    return {
        "lane": lane,
        "reference_precision": reference_precision,
        "candidate_precision": candidate_precision,
        "cuda_identity_match": identity_match,
    }


def _metadata_provenance(path: Path) -> Mapping[str, Any]:
    metadata = json.loads(path.read_text(encoding="utf-8"))
    provenance = metadata.get("execution_provenance")
    if not isinstance(provenance, dict):
        raise ValueError(f"execution_provenance_missing:{path}")
    return provenance


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-metadata", type=Path, required=True)
    parser.add_argument("--candidate-metadata", type=Path, required=True)
    parser.add_argument("--lane", choices=("cuda-fp64", "cuda-fp32"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    try:
        contract = validate_precision_contract(
            _metadata_provenance(args.reference_metadata),
            _metadata_provenance(args.candidate_metadata),
            args.lane,
        )
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        report = {
            "schema_version": "fdm_multilayer_cuda_precision_contract.v1",
            "status": "not_verified",
            "lane": args.lane,
            "reason_code": str(error),
        }
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        return 3

    report = {
        "schema_version": "fdm_multilayer_cuda_precision_contract.v1",
        "status": "verified",
        **contract,
    }
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
