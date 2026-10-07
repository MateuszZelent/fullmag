#!/usr/bin/env python3
"""Interpreted tests for the standalone equilibrium v7 payload validator."""

from __future__ import annotations

import copy
import importlib.util
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR_PATH = REPO_ROOT / "scripts" / "verify_fem_frequency_domain_eigen_artifacts.py"
FIXTURE_PATH = REPO_ROOT / "scripts" / "test_verify_fem_frequency_domain_eigen_artifacts.py"


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validator = _load_module(VALIDATOR_PATH, "verify_fem_frequency_domain_eigen_artifacts")
fixture_source = _load_module(FIXTURE_PATH, "equilibrium_v7_fixture_source")


def _fresh_artifact(tmp_path: Path) -> dict[str, object]:
    fixture_source.write_eigen_fixture(tmp_path)
    return copy.deepcopy(fixture_source.attach_certified_equilibrium_v7(tmp_path))


def _refresh_digest(artifact: dict[str, object]) -> str:
    artifact.pop("content_sha256", None)
    artifact.pop("equilibrium_id", None)
    digest = validator.equilibrium_artifact_v7_digest(artifact)
    artifact["content_sha256"] = digest
    artifact["equilibrium_id"] = "equilibrium_artifact.v7:" + digest.removeprefix(
        "sha256:"
    )
    return digest


def test_payload_helper_accepts_existing_certified_fixture(tmp_path: Path) -> None:
    artifact = _fresh_artifact(tmp_path)
    digest = str(artifact["content_sha256"])

    assert validator.validate_equilibrium_artifact_v7_payload(artifact, digest) is None


def test_payload_helper_requires_strict_boolean_acceptance(tmp_path: Path) -> None:
    artifact = _fresh_artifact(tmp_path)
    artifact["accepted_for_linearization"] = 1
    digest = _refresh_digest(artifact)

    with pytest.raises(SystemExit, match="accepted_for_linearization.*must be boolean"):
        validator.validate_equilibrium_artifact_v7_payload(artifact, digest)


def test_payload_helper_requires_strict_boolean_convergence(tmp_path: Path) -> None:
    artifact = _fresh_artifact(tmp_path)
    certificate = artifact["acceptance_certificate"]
    assert isinstance(certificate, dict)
    certificate["converged"] = 1
    digest = _refresh_digest(artifact)

    with pytest.raises(SystemExit, match="acceptance_certificate.converged.*must be boolean"):
        validator.validate_equilibrium_artifact_v7_payload(artifact, digest)


def test_payload_helper_rejects_negative_metric_value(tmp_path: Path) -> None:
    artifact = _fresh_artifact(tmp_path)
    certificate = artifact["acceptance_certificate"]
    assert isinstance(certificate, dict)
    certificate["metric_value"] = -1.0
    digest = _refresh_digest(artifact)

    with pytest.raises(SystemExit, match="acceptance_certificate.metric_value must be non-negative"):
        validator.validate_equilibrium_artifact_v7_payload(artifact, digest)


def test_payload_helper_does_not_treat_boolean_metric_as_number(tmp_path: Path) -> None:
    artifact = _fresh_artifact(tmp_path)
    certificate = artifact["acceptance_certificate"]
    assert isinstance(certificate, dict)
    certificate["metric_value"] = True
    digest = _refresh_digest(artifact)

    with pytest.raises(SystemExit, match="acceptance_certificate.metric_value.*finite number"):
        validator.validate_equilibrium_artifact_v7_payload(artifact, digest)


def test_payload_helper_rejects_negative_observable(tmp_path: Path) -> None:
    artifact = _fresh_artifact(tmp_path)
    observables = artifact["observables"]
    assert isinstance(observables, dict)
    observables["max_torque_T"] = -1.0
    digest = _refresh_digest(artifact)

    with pytest.raises(SystemExit, match="observables.max_torque_T must be non-negative"):
        validator.validate_equilibrium_artifact_v7_payload(artifact, digest)


def test_payload_helper_rejects_negative_norm_tolerance(tmp_path: Path) -> None:
    artifact = _fresh_artifact(tmp_path)
    integrity = artifact["representation_integrity"]
    assert isinstance(integrity, dict)
    integrity["m0_norm_tolerance"] = -1.0
    digest = _refresh_digest(artifact)

    with pytest.raises(SystemExit, match="m0_norm_tolerance must be non-negative"):
        validator.validate_equilibrium_artifact_v7_payload(artifact, digest)


def test_payload_helper_rejects_unexpected_content_digest(tmp_path: Path) -> None:
    artifact = _fresh_artifact(tmp_path)
    digest = str(artifact["content_sha256"])
    wrong_digest = "sha256:" + "f" * 64

    with pytest.raises(SystemExit, match="expected_content_sha256"):
        validator.validate_equilibrium_artifact_v7_payload(artifact, wrong_digest)


def test_payload_helper_rejects_changed_content_without_rehash(tmp_path: Path) -> None:
    artifact = _fresh_artifact(tmp_path)
    digest = str(artifact["content_sha256"])
    artifact["producer_run_id"] = "run:changed"

    with pytest.raises(SystemExit, match="content_sha256"):
        validator.validate_equilibrium_artifact_v7_payload(artifact, digest)
