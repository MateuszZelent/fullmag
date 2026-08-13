"""Unit contract for lane-specific CUDA multilayer precision provenance."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "scripts/fdm_multilayer_cuda_precision_contract.py"


def load_contract():
    assert CONTRACT.is_file(), "missing CUDA multilayer precision contract helper"
    spec = importlib.util.spec_from_file_location(
        "fdm_multilayer_cuda_precision_contract",
        CONTRACT,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cuda_provenance(precision: str) -> dict[str, object]:
    return {
        "precision": precision,
        "device_name": "NVIDIA test device",
        "compute_capability": "8.9",
        "cuda_driver_version": 12080,
        "cuda_runtime_version": 12060,
    }


def test_fp32_contract_requires_double_reference_and_single_candidate() -> None:
    contract = load_contract()

    report = contract.validate_precision_contract(
        cuda_provenance("double"),
        cuda_provenance("single"),
        "cuda-fp32",
    )

    assert report == {
        "lane": "cuda-fp32",
        "reference_precision": "double",
        "candidate_precision": "single",
        "cuda_identity_match": True,
    }


@pytest.mark.parametrize("candidate_precision", ["double", "", None])
def test_fp32_contract_rejects_candidate_without_single_precision(
    candidate_precision: object,
) -> None:
    contract = load_contract()
    candidate = cuda_provenance("single")
    candidate["precision"] = candidate_precision

    with pytest.raises(ValueError, match="cuda_fp32_candidate_precision_not_single"):
        contract.validate_precision_contract(
            cuda_provenance("double"),
            candidate,
            "cuda-fp32",
        )


def test_fp32_contract_rejects_reference_without_double_precision() -> None:
    contract = load_contract()

    with pytest.raises(ValueError, match="cuda_fp32_reference_precision_not_double"):
        contract.validate_precision_contract(
            cuda_provenance("single"),
            cuda_provenance("single"),
            "cuda-fp32",
        )


@pytest.mark.parametrize(
    "field,other_value",
    [
        ("device_name", "other device"),
        ("compute_capability", "9.0"),
        ("cuda_driver_version", 12090),
        ("cuda_runtime_version", 12070),
    ],
)
def test_fp32_contract_rejects_cuda_identity_drift(
    field: str,
    other_value: object,
) -> None:
    contract = load_contract()
    candidate = cuda_provenance("single")
    candidate[field] = other_value

    with pytest.raises(ValueError, match=f"cuda_fp32_identity_mismatch:{field}"):
        contract.validate_precision_contract(
            cuda_provenance("double"),
            candidate,
            "cuda-fp32",
        )


@pytest.mark.parametrize(
    "field",
    [
        "device_name",
        "compute_capability",
        "cuda_driver_version",
        "cuda_runtime_version",
    ],
)
def test_fp32_contract_fails_closed_when_cuda_identity_is_missing(field: str) -> None:
    contract = load_contract()
    candidate = cuda_provenance("single")
    candidate.pop(field)

    with pytest.raises(ValueError, match=f"cuda_identity_incomplete:{field}"):
        contract.validate_precision_contract(
            cuda_provenance("double"),
            candidate,
            "cuda-fp32",
        )


@pytest.mark.parametrize(
    "field,invalid_value",
    [
        ("device_name", False),
        ("device_name", "   "),
        ("compute_capability", 89),
        ("compute_capability", ""),
        ("cuda_driver_version", False),
        ("cuda_driver_version", 0),
        ("cuda_runtime_version", "12060"),
        ("cuda_runtime_version", -1),
    ],
)
def test_fp32_contract_rejects_invalid_cuda_identity_values(
    field: str,
    invalid_value: object,
) -> None:
    contract = load_contract()
    candidate = cuda_provenance("single")
    candidate[field] = invalid_value

    with pytest.raises(ValueError, match=f"cuda_identity_invalid:{field}"):
        contract.validate_precision_contract(
            cuda_provenance("double"),
            candidate,
            "cuda-fp32",
        )


def test_fp64_contract_requires_double_candidate_without_cpu_device_identity() -> None:
    contract = load_contract()

    report = contract.validate_precision_contract(
        {"precision": "double"},
        cuda_provenance("double"),
        "cuda-fp64",
    )

    assert report == {
        "lane": "cuda-fp64",
        "reference_precision": "double",
        "candidate_precision": "double",
        "cuda_identity_match": None,
    }


def test_precision_contract_rejects_unknown_lane() -> None:
    contract = load_contract()

    with pytest.raises(ValueError, match="unsupported_cuda_multilayer_lane"):
        contract.validate_precision_contract({}, {}, "cuda-auto")


def write_metadata(path: Path, provenance: dict[str, object]) -> None:
    path.write_text(
        json.dumps({"execution_provenance": provenance}),
        encoding="utf-8",
    )


def test_precision_contract_cli_writes_lane_specific_report(tmp_path: Path) -> None:
    reference = tmp_path / "reference.json"
    candidate = tmp_path / "candidate.json"
    output = tmp_path / "precision.json"
    write_metadata(reference, cuda_provenance("double"))
    write_metadata(candidate, cuda_provenance("single"))

    result = subprocess.run(
        [
            sys.executable,
            str(CONTRACT),
            "--reference-metadata",
            str(reference),
            "--candidate-metadata",
            str(candidate),
            "--lane",
            "cuda-fp32",
            "--output",
            str(output),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(output.read_text(encoding="utf-8")) == {
        "schema_version": "fdm_multilayer_cuda_precision_contract.v1",
        "status": "verified",
        "lane": "cuda-fp32",
        "reference_precision": "double",
        "candidate_precision": "single",
        "cuda_identity_match": True,
    }


def test_precision_contract_cli_records_fail_closed_reason(tmp_path: Path) -> None:
    reference = tmp_path / "reference.json"
    candidate = tmp_path / "candidate.json"
    output = tmp_path / "precision.json"
    write_metadata(reference, cuda_provenance("double"))
    write_metadata(candidate, cuda_provenance("double"))

    result = subprocess.run(
        [
            sys.executable,
            str(CONTRACT),
            "--reference-metadata",
            str(reference),
            "--candidate-metadata",
            str(candidate),
            "--lane",
            "cuda-fp32",
            "--output",
            str(output),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 3
    assert json.loads(output.read_text(encoding="utf-8")) == {
        "schema_version": "fdm_multilayer_cuda_precision_contract.v1",
        "status": "not_verified",
        "lane": "cuda-fp32",
        "reason_code": "cuda_fp32_candidate_precision_not_single",
    }
