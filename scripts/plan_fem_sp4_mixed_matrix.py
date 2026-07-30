#!/usr/bin/env python3
"""Emit a deterministic execution plan for the staged FEM SP4 mixed matrix."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
from typing import Sequence


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tests.standard_problems.mumag.sp4.fem.matrix_contract import (  # noqa: E402
    STAGE1_LAYERS,
    STAGE2_AIRBOX,
    STAGE3_DEVICE,
    SP4MatrixRunSpec,
    matrix_specs,
)


SCHEMA = "fullmag.fem.sp4.mixed-matrix-plan.v1"
QUALIFICATION_CLAIM = "implemented_evidence_only"
STAGES = (STAGE1_LAYERS, STAGE2_AIRBOX, STAGE3_DEVICE)
EXPECTED_STAGE_COUNTS = {
    STAGE1_LAYERS: 9,
    STAGE2_AIRBOX: 6,
    STAGE3_DEVICE: 6,
}
MATRIX_CONTRACT_PATH = Path(
    "tests/standard_problems/mumag/sp4/fem/matrix_contract.py"
)
RELEVANT_SOURCE_PATHS = (
    Path("scripts/plan_fem_sp4_mixed_matrix.py"),
    Path("tests/standard_problems/mumag/sp4/common/contract.py"),
    MATRIX_CONTRACT_PATH,
)
PLAN_FILENAME = "matrix-plan.v1.json"
JSONL_FILENAME = "run-specs.v1.jsonl"
TSV_FILENAME = "run-specs.v1.tsv"
RUN_SPEC_FIELDS = (
    "run_id",
    "artifact_path",
    "stage_id",
    "phase",
    "topology_variant",
    "layers",
    "layer_key",
    "mesh_level",
    "mesh_hmax_m",
    "airbox_id",
    "airbox_dimensions_m",
    "airbox_hmax_m",
    "device",
    "relaxation_algorithm",
    "case",
    "dynamics_policy",
    "dynamics_level",
    "disposition",
    "reuse_from_stage",
)


class PlanError(ValueError):
    """Raised when a canonical matrix plan cannot be emitted safely."""


def _canonical_json_bytes(value: object) -> bytes:
    return (
        json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    try:
        return _sha256_bytes(path.read_bytes())
    except OSError as error:
        raise PlanError(f"cannot hash required source file {path}: {error}") from error


def _git_output(*arguments: str) -> bytes:
    try:
        return subprocess.check_output(
            ("git", *arguments),
            cwd=REPO_ROOT,
            stderr=subprocess.PIPE,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise PlanError(
            f"cannot resolve git source identity with {' '.join(arguments)}"
        ) from error


def _source_identity() -> dict[str, object]:
    source_hashes = {
        path.as_posix(): _sha256_file(REPO_ROOT / path)
        for path in RELEVANT_SOURCE_PATHS
    }
    return {
        "source_commit_full": _git_output("rev-parse", "--verify", "HEAD")
        .decode("ascii")
        .strip(),
        "source_tree_sha256": _sha256_bytes(
            _git_output("ls-tree", "-r", "--full-tree", "HEAD")
        ),
        "relevant_source_files_sha256": source_hashes,
        "contract_sha256": source_hashes[MATRIX_CONTRACT_PATH.as_posix()],
    }


def _run_spec_payload(
    spec: SP4MatrixRunSpec,
    *,
    requested_stage: str,
) -> dict[str, object]:
    reused = spec.stage_id != requested_stage
    return {
        "run_id": spec.run_id,
        "artifact_path": spec.artifact_path.as_posix(),
        "stage_id": spec.stage_id,
        "phase": spec.phase,
        "topology_variant": spec.topology_variant,
        "layers": spec.layers,
        "layer_key": spec.layer_key,
        "mesh_level": spec.mesh.id,
        "mesh_hmax_m": spec.mesh.hmax_m,
        "airbox_id": spec.airbox.id,
        "airbox_dimensions_m": list(spec.airbox.dimensions_m),
        "airbox_hmax_m": spec.airbox.hmax_m,
        "device": spec.device,
        "relaxation_algorithm": spec.relaxation_algorithm,
        "case": None,
        "dynamics_policy": None,
        "dynamics_level": None,
        "disposition": "reuse" if reused else "execute",
        "reuse_from_stage": spec.stage_id if reused else None,
    }


def build_plan(requested_stage: str) -> dict[str, object]:
    if requested_stage not in STAGES:
        raise PlanError(f"unsupported SP4 mixed matrix stage: {requested_stage}")
    run_specs = [
        _run_spec_payload(spec, requested_stage=requested_stage)
        for spec in matrix_specs(requested_stage)
    ]
    expected_count = EXPECTED_STAGE_COUNTS[requested_stage]
    if len(run_specs) != expected_count:
        raise PlanError(
            f"{requested_stage} requires {expected_count} run specs; got {len(run_specs)}"
        )
    run_ids = [spec["run_id"] for spec in run_specs]
    artifact_paths = [spec["artifact_path"] for spec in run_specs]
    if len(set(run_ids)) != len(run_ids):
        raise PlanError(f"{requested_stage} produced duplicate run IDs")
    if len(set(artifact_paths)) != len(artifact_paths):
        raise PlanError(f"{requested_stage} produced duplicate artifact paths")

    payload: dict[str, object] = {
        "schema": SCHEMA,
        "requested_stage": requested_stage,
        "qualifying": False,
        "qualification_claim": QUALIFICATION_CLAIM,
        "run_spec_count": len(run_specs),
        "run_specs": run_specs,
        **_source_identity(),
    }
    payload["plan_sha256"] = _sha256_bytes(_canonical_json_bytes(payload))
    return payload


def _jsonl_bytes(run_specs: Sequence[dict[str, object]]) -> bytes:
    return b"".join(_canonical_json_bytes(spec) for spec in run_specs)


def _tsv_value(value: object) -> object:
    if value is None:
        return ""
    if isinstance(value, (list, dict)):
        return json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    return value


def _tsv_bytes(run_specs: Sequence[dict[str, object]]) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(
        output,
        fieldnames=RUN_SPEC_FIELDS,
        delimiter="\t",
        lineterminator="\n",
    )
    writer.writeheader()
    for spec in run_specs:
        writer.writerow({key: _tsv_value(spec[key]) for key in RUN_SPEC_FIELDS})
    return output.getvalue().encode("utf-8")


def _write_immutable(path: Path, payload: bytes) -> None:
    if path.exists():
        try:
            existing = path.read_bytes()
        except OSError as error:
            raise PlanError(f"cannot read existing plan output {path}: {error}") from error
        if existing != payload:
            raise PlanError(f"refusing to overwrite different plan output {path}")
        return
    try:
        path.write_bytes(payload)
    except OSError as error:
        raise PlanError(f"cannot write plan output {path}: {error}") from error


def emit_plan(requested_stage: str, output_dir: Path) -> dict[str, object]:
    plan = build_plan(requested_stage)
    run_specs = plan["run_specs"]
    if not isinstance(run_specs, list):
        raise PlanError("internal error: run_specs must be a list")
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise PlanError(f"cannot create plan output directory {output_dir}: {error}") from error
    _write_immutable(output_dir / PLAN_FILENAME, _canonical_json_bytes(plan))
    _write_immutable(output_dir / JSONL_FILENAME, _jsonl_bytes(run_specs))
    _write_immutable(output_dir / TSV_FILENAME, _tsv_bytes(run_specs))
    return plan


def _parse_arguments(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("requested_stage", choices=STAGES)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parse_arguments(argv)
    try:
        plan = emit_plan(arguments.requested_stage, arguments.output_dir)
    except PlanError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {
                "matrix_plan": str(arguments.output_dir / PLAN_FILENAME),
                "plan_sha256": plan["plan_sha256"],
                "run_spec_count": plan["run_spec_count"],
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
