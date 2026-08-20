from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify_relaxation_production_matrix.py"
SPEC = importlib.util.spec_from_file_location("relaxation_production_matrix", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
matrix = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(matrix)


ALGORITHMS = (
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
)
LANE_PRECISIONS = (
    ("fdm_cpu_reference", "fp64", "fdm", "cpu", "fdm_cpu_reference"),
    ("fdm_gpu_production", "fp32", "fdm", "cuda", "fdm_cuda_runtime"),
    ("fdm_gpu_production", "fp64", "fdm", "cuda", "fdm_cuda_runtime"),
    ("fem_cpu_public", "fp64", "fem", "cpu", "fem_cpu_runtime"),
    ("fem_gpu_public", "fp64", "fem", "gpu", "fem_gpu_host"),
)
ORACLES = {
    "llg_overdamped": {"kind": "independent_reference", "id": "fem_llg_reference.v1"},
    "projected_gradient_bb": {
        "kind": "independent_reference",
        "id": "fem_relaxation_endpoint_equivalence.v1",
    },
    "nonlinear_cg": {
        "kind": "independent_reference",
        "id": "fem_relaxation_endpoint_equivalence.v1",
    },
    "tangent_plane_implicit": {
        "kind": "independent_reference",
        "id": "fem_tpi_reference.v1",
    },
}
SOURCE_COMMIT = "a" * 40
SOURCE_TREE = "b" * 64
RECIPE_HASHES = {
    lane: hashlib.sha256(lane.encode("utf-8")).hexdigest()
    for lane, _, _, _, _ in LANE_PRECISIONS
}
EXPECTED_IDENTITY = {
    "source_commit": SOURCE_COMMIT,
    "source_tree_sha256": SOURCE_TREE,
    "recipe_sha256_by_lane": RECIPE_HASHES,
}


def _write_json(path: Path, payload: object) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _cell_stem(algorithm: str, lane: str, precision: str) -> str:
    return f"{algorithm}--{lane}--{precision}"


def _workloads(algorithm: str, lane: str) -> list[str]:
    return [
        f"{lane}.{algorithm}.macrospin",
        f"{lane}.{algorithm}.exchange_demag",
    ]


def _write_receipt(
    root: Path,
    *,
    algorithm: str,
    lane: str,
    precision: str,
    source_commit: str = SOURCE_COMMIT,
    source_tree_sha256: str = SOURCE_TREE,
    recipe_sha256: str | None = None,
    source_clean: bool = True,
    scope_overrides: dict[str, object] | None = None,
    execution_overrides: dict[str, object] | None = None,
    receipt_status: str = "passed",
    output_name: str | None = None,
) -> Path:
    lane_row = next(
        row for row in LANE_PRECISIONS if row[0] == lane and row[1] == precision
    )
    _, _, backend, device, runtime_id = lane_row
    stem = _cell_stem(algorithm, lane, precision)
    evidence: dict[str, dict[str, object]] = {}
    for level in ("D4", "D5", "D6"):
        relative = Path("artifacts") / stem / f"{level.lower()}.json"
        digest = _write_json(
            root / relative,
            {"cell": stem, "level": level, "status": "passed"},
        )
        evidence[level] = {
            "status": "passed",
            "artifact_manifest": [{"path": relative.as_posix(), "sha256": digest}],
        }
    artifact_relative = Path("artifacts") / stem / "result.json"
    artifact_digest = _write_json(
        root / artifact_relative,
        {"cell": stem, "result": "converged"},
    )
    evidence["D6"]["artifact_manifest"].append(
        {"path": artifact_relative.as_posix(), "sha256": artifact_digest}
    )
    scope: dict[str, object] = {
        "feature_id": f"relaxation_{algorithm}",
        "algorithm": algorithm,
        "lane": lane,
        "backend": backend,
        "device": device,
        "precision": precision,
        "runtime_identity": {
            "kind": "reference_process" if lane == "fdm_cpu_reference" else "managed_container",
            "id": runtime_id,
        },
        "validated_workloads": _workloads(algorithm, lane),
        "oracle": copy.deepcopy(ORACLES[algorithm]),
        "mesh_refinement": {
            "levels": ["coarse", "medium", "fine"],
            "strategy": "same_physical_problem",
        },
        "repeatability": {"warmup_runs": 1, "measured_runs": 5},
        "evidence": evidence,
    }
    if scope_overrides:
        scope.update(copy.deepcopy(scope_overrides))
    execution: dict[str, object] = {
        "status": "passed",
        "converged": True,
        "termination_reason": "converged",
        "timeout": False,
        "max_steps_reached": False,
        "non_converged": False,
        "fallback_occurred": False,
    }
    if execution_overrides:
        execution.update(copy.deepcopy(execution_overrides))
    receipt: dict[str, object] = {
        "schema_version": "fullmag.relaxation_qualification_receipt.v1",
        "status": receipt_status,
        "feature_id": f"relaxation_{algorithm}",
        "algorithm": algorithm,
        "lane": lane,
        "backend": backend,
        "device": device,
        "precision": precision,
        "source_commit": source_commit,
        "source_tree_sha256": source_tree_sha256,
        "source_clean": source_clean,
        "recipe_sha256": recipe_sha256 or RECIPE_HASHES[lane],
        "managed_command": f"just verify-{lane}-relaxation",
        "artifact_path": artifact_relative.as_posix(),
        "artifact_sha256": artifact_digest,
        "validated_scope": scope,
        "execution": execution,
        "solver_audit_gate": "passed",
    }
    name = output_name or f"{stem}.json"
    path = root / "receipts" / name
    _write_json(path, receipt)
    return path


def write_complete_bundle(root: Path) -> tuple[list[Path], dict[str, object]]:
    paths: list[Path] = []
    for algorithm in ALGORITHMS:
        for lane, precision, *_ in LANE_PRECISIONS:
            paths.append(
                _write_receipt(
                    root,
                    algorithm=algorithm,
                    lane=lane,
                    precision=precision,
                )
            )
    return paths, copy.deepcopy(EXPECTED_IDENTITY)


def run(paths: list[Path], root: Path, expected: dict[str, object]) -> dict[str, object]:
    return matrix.orchestrate(
        paths,
        expected_identity=expected,
        artifact_root=root,
    )


def test_complete_matrix_is_qualified_and_manifest_is_deterministic(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    first = run(paths, tmp_path, expected)
    second = run(list(reversed(paths)), tmp_path, expected)

    assert first["status"] == "qualified"
    assert first["checksum_sha256"] == second["checksum_sha256"]
    assert first["manifest"] == second["manifest"]
    assert first["manifest"]["status"] == "qualified"
    assert len(first["manifest"]["cells"]) == 20


def test_cli_discovers_receipts_and_writes_deterministic_manifest(tmp_path: Path) -> None:
    _, expected = write_complete_bundle(tmp_path)
    expected_path = tmp_path / "expected-identity.json"
    _write_json(expected_path, expected)
    output = tmp_path / "matrix.json"

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--receipt-root",
            str(tmp_path),
            "--artifact-root",
            str(tmp_path),
            "--expected-identity",
            str(expected_path),
            "--output",
            str(output),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0
    assert "FM-RELAX-017 QUALIFIED" in result.stdout
    manifest = json.loads(output.read_text(encoding="utf-8"))
    assert manifest["status"] == "qualified"
    assert manifest["checksum_sha256"] == matrix._sha256_bytes(
        matrix._canonical_bytes(
            {key: value for key, value in manifest.items() if key != "checksum_sha256"}
        )
    )


@pytest.mark.parametrize(
    "missing_lane",
    ["fdm_cpu_reference", "fdm_gpu_production", "fem_cpu_public", "fem_gpu_public"],
)
def test_every_missing_lane_blocks(tmp_path: Path, missing_lane: str) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    paths = [path for path in paths if f"--{missing_lane}--" not in path.name]

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any(
        f"lane={missing_lane}" in item and "missing=receipt" in item
        for item in result["missing_evidence"]
    )


@pytest.mark.parametrize("missing_algorithm", ALGORITHMS)
def test_every_missing_algorithm_blocks(tmp_path: Path, missing_algorithm: str) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    paths = [path for path in paths if not path.name.startswith(f"{missing_algorithm}--")]

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any(
        f"algorithm={missing_algorithm}" in item and "missing=receipt" in item
        for item in result["missing_evidence"]
    )


def test_every_missing_precision_blocks(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    paths = [
        path
        for path in paths
        if not path.name.endswith("--fdm_gpu_production--fp32.json")
    ]

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any(
        "lane=fdm_gpu_production" in item
        and "precision=fp32" in item
        and "missing=receipt" in item
        for item in result["missing_evidence"]
    )


@pytest.mark.parametrize("scope_field", ["oracle", "mesh_refinement", "repeatability"])
def test_missing_canonical_scope_evidence_blocks(
    tmp_path: Path, scope_field: str
) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    target = next(path for path in paths if "llg_overdamped--fdm_cpu_reference--fp64" in path.name)
    receipt = json.loads(target.read_text(encoding="utf-8"))
    receipt["validated_scope"].pop(scope_field)
    target.write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any(
        "algorithm=llg_overdamped" in item and f"missing=scope.{scope_field}" in item
        for item in result["missing_evidence"]
    )


@pytest.mark.parametrize(
    ("field", "value", "needle"),
    [
        ("source_commit", "c" * 40, "source_commit"),
        ("source_tree_sha256", "d" * 64, "source_tree_sha256"),
        ("recipe_sha256", "e" * 64, "recipe_sha256"),
    ],
)
def test_identity_mismatch_blocks(
    tmp_path: Path, field: str, value: str, needle: str
) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    receipt = json.loads(paths[0].read_text(encoding="utf-8"))
    receipt[field] = value
    paths[0].write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any(needle in item and "mismatch" in item for item in result["missing_evidence"])


def test_dirty_source_blocks(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    receipt = json.loads(paths[0].read_text(encoding="utf-8"))
    receipt["source_clean"] = False
    paths[0].write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("source_clean" in item for item in result["missing_evidence"])


@pytest.mark.parametrize(
    ("field", "value", "needle"),
    [("source_dirty", True, "source_dirty"), ("worktree_dirty", True, "source_dirty")],
)
def test_dirty_source_indicators_cannot_be_hidden(
    tmp_path: Path, field: str, value: object, needle: str
) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    receipt = json.loads(paths[0].read_text(encoding="utf-8"))
    receipt[field] = value
    paths[0].write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any(needle in item for item in result["missing_evidence"])


def test_tampered_artifact_blocks(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    receipt = json.loads(paths[0].read_text(encoding="utf-8"))
    artifact = tmp_path / receipt["artifact_path"]
    artifact.write_text("tampered\n", encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("artifact" in item and "sha256" in item for item in result["missing_evidence"])


def test_receipt_outside_artifact_root_blocks_deterministically(tmp_path: Path) -> None:
    bundle_root = tmp_path / "bundle"
    outside_root = tmp_path / "outside"
    paths, expected = write_complete_bundle(bundle_root)

    result = run(paths[:1], outside_root, expected)

    assert result["status"] == "blocked"
    assert any("outside_artifact_root" in item for item in result["missing_evidence"])
    assert all(str(tmp_path) not in item for item in result["missing_evidence"])


def test_fallback_reason_blocks_even_when_fallback_flag_is_false(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    receipt = json.loads(paths[0].read_text(encoding="utf-8"))
    receipt["execution"]["fallback_reason"] = "cpu fallback"
    paths[0].write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("fallback" in item for item in result["missing_evidence"])


def test_mixed_source_blocks(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    receipt = json.loads(paths[1].read_text(encoding="utf-8"))
    receipt["source_commit"] = "f" * 40
    paths[1].write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("mixed_source" in item or "source_commit" in item for item in result["missing_evidence"])


def test_duplicate_receipt_blocks(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    duplicate = tmp_path / "receipts" / "duplicate.json"
    shutil.copyfile(paths[0], duplicate)
    paths.append(duplicate)

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("duplicate_receipt" in item for item in result["missing_evidence"])


@pytest.mark.parametrize(
    ("execution_field", "value", "needle"),
    [
        ("status", "failed", "failed"),
        ("timeout", True, "timeout"),
        ("max_steps_reached", True, "max_steps"),
        ("non_converged", True, "non_converged"),
        ("fallback_occurred", True, "fallback"),
    ],
)
def test_failed_timeout_max_steps_nonconverged_and_fallback_block(
    tmp_path: Path, execution_field: str, value: object, needle: str
) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    target = paths[0]
    receipt = json.loads(target.read_text(encoding="utf-8"))
    receipt["execution"][execution_field] = value
    if execution_field == "status":
        receipt["status"] = "failed"
    target.write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any(needle in item for item in result["missing_evidence"])


def test_missing_expected_identity_blocks_closed(tmp_path: Path) -> None:
    paths, _ = write_complete_bundle(tmp_path)

    result = matrix.orchestrate(paths, expected_identity=None, artifact_root=tmp_path)

    assert result["status"] == "blocked"
    assert "missing=expected_identity" in result["missing_evidence"]


def test_no_receipts_blocks_every_expected_cell(tmp_path: Path) -> None:
    result = run([], tmp_path, copy.deepcopy(EXPECTED_IDENTITY))

    assert result["status"] == "blocked"
    assert len(result["missing_evidence"]) == 20
    assert all("missing=receipt" in item for item in result["missing_evidence"])
