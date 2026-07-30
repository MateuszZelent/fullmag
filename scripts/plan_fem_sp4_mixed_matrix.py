#!/usr/bin/env python3
"""Emit a deterministic execution plan for the staged FEM SP4 mixed matrix."""

from __future__ import annotations

import argparse
import csv
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Callable, Sequence


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
    Path("justfile"),
    Path("scripts/check_fem_sp4_relaxation.py"),
    Path("scripts/plan_fem_sp4_mixed_matrix.py"),
    Path("scripts/select_fem_sp4_relaxation_state.py"),
    Path("scripts/verify_fem_standard_problem_4.sh"),
    Path("scripts/write_fem_magnetic_initial_state_from_shared_domain.py"),
    Path("tests/standard_problems/mumag/sp4/common/contract.py"),
    Path("tests/standard_problems/mumag/sp4/common/metrics.py"),
    Path("tests/standard_problems/mumag/sp4/common/references.py"),
    Path("tests/standard_problems/mumag/sp4/common/reporting.py"),
    MATRIX_CONTRACT_PATH,
    Path("tests/standard_problems/mumag/sp4/fem/problem.py"),
    Path(
        "tests/standard_problems/mumag/sp4/fem/scenarios/"
        "relax_llg_rk23_adaptive.py"
    ),
    Path(
        "tests/standard_problems/mumag/sp4/fem/scenarios/"
        "relax_nonlinear_cg.py"
    ),
    Path(
        "tests/standard_problems/mumag/sp4/fem/scenarios/"
        "relax_projected_gradient_bb.py"
    ),
    Path("tests/standard_problems/mumag/sp4/fem/verify.py"),
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
        before = path.stat(follow_symlinks=False)
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        after = path.stat(follow_symlinks=False)
    except OSError as error:
        raise PlanError(f"cannot hash required source file {path}: {error}") from error
    identity_before = (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
        before.st_ctime_ns,
    )
    identity_after = (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    )
    if identity_before != identity_after:
        raise PlanError(f"required source file changed while hashing: {path}")
    return digest.hexdigest()


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


def _git_status_records(
    path_is_planner_owned: Callable[[str], bool] | None = None,
) -> list[dict[str, object]]:
    raw_status = _git_output(
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
    )
    parts = raw_status.split(b"\0")
    records: list[dict[str, object]] = []
    index = 0
    try:
        while index < len(parts) and parts[index]:
            entry = parts[index]
            index += 1
            if len(entry) < 4 or entry[2:3] != b" ":
                raise PlanError("cannot parse canonical git status entry")
            status = entry[:2].decode("ascii")
            paths = [entry[3:].decode("utf-8")]
            if status[0] in "RC" or status[1] in "RC":
                if index >= len(parts) or not parts[index]:
                    raise PlanError("cannot parse canonical git rename status")
                paths.append(parts[index].decode("utf-8"))
                index += 1
            if path_is_planner_owned is None or not all(
                path_is_planner_owned(path) for path in paths
            ):
                records.append({"status": status, "paths": paths})
    except UnicodeDecodeError as error:
        raise PlanError("cannot decode canonical git status") from error
    return records


def _planner_owned_status_filter(
    output_dir: Path | None,
) -> Callable[[str], bool] | None:
    if output_dir is None:
        return None
    try:
        relative_output = output_dir.resolve(strict=False).relative_to(
            REPO_ROOT.resolve()
        )
    except (OSError, ValueError):
        return None
    parent = relative_output.parent
    canonical_paths = {
        (relative_output / name).as_posix()
        for name in (PLAN_FILENAME, JSONL_FILENAME, TSV_FILENAME)
    }
    lock_path = (parent / f".{relative_output.name}.lock").as_posix()

    def is_owned(path: str) -> bool:
        return path in canonical_paths or path == lock_path

    return is_owned


def _git_index_entries(
    dirty_paths: set[str],
) -> dict[str, list[dict[str, object]]]:
    if not dirty_paths:
        return {}
    entries_by_path = {path: [] for path in dirty_paths}
    path_by_raw = {path.encode("utf-8"): path for path in dirty_paths}
    raw_entries = _git_output("ls-files", "--stage", "-z")
    try:
        for raw_entry in raw_entries.split(b"\0"):
            if not raw_entry:
                continue
            identity, separator, raw_path = raw_entry.partition(b"\t")
            relative_path = path_by_raw.get(raw_path)
            if relative_path is None:
                continue
            fields = identity.split(b" ")
            if not separator or len(fields) != 3:
                raise PlanError("cannot parse canonical git index entry")
            mode, object_id, stage = (field.decode("ascii") for field in fields)
            entries_by_path[relative_path].append(
                {
                    "mode": mode,
                    "object_id": object_id,
                    "stage": int(stage),
                }
            )
    except (UnicodeDecodeError, ValueError) as error:
        raise PlanError("cannot decode canonical git index") from error
    for entries in entries_by_path.values():
        entries.sort(
            key=lambda entry: (
                entry["stage"],
                entry["mode"],
                entry["object_id"],
            )
        )
    return entries_by_path


def _dirty_path_content(
    status_records: Sequence[dict[str, object]],
) -> list[dict[str, object]]:
    dirty_path_set = {
        path for record in status_records for path in record["paths"]
    }
    index_entries = _git_index_entries(dirty_path_set)
    identities: list[dict[str, object]] = []
    for relative_path in sorted(dirty_path_set):
        candidate = Path(relative_path)
        if candidate.is_absolute() or ".." in candidate.parts:
            raise PlanError(f"unsafe dirty path in git status: {relative_path}")
        path = REPO_ROOT / candidate
        try:
            metadata = path.lstat()
        except FileNotFoundError as error:
            raise PlanError(f"missing dirty path cannot be snapshotted: {relative_path}") from error
        except OSError as error:
            raise PlanError(f"cannot inspect dirty path {relative_path}: {error}") from error
        if stat.S_ISREG(metadata.st_mode):
            identities.append(
                {
                    "path": relative_path,
                    "kind": "regular_file",
                    "sha256": _sha256_file(path),
                    "git_index_entries": index_entries[relative_path],
                }
            )
            continue
        if stat.S_ISLNK(metadata.st_mode):
            try:
                target = os.readlink(path)
            except OSError as error:
                raise PlanError(
                    f"cannot read dirty symlink {relative_path}: {error}"
                ) from error
            identities.append(
                {
                    "path": relative_path,
                    "kind": "symlink_target",
                    "sha256": _sha256_bytes(os.fsencode(target)),
                    "git_index_entries": index_entries[relative_path],
                }
            )
            continue
        raise PlanError(f"unsupported dirty path type: {relative_path}")
    return identities


def _source_identity(output_dir: Path | None = None) -> dict[str, object]:
    source_hashes = {
        path.as_posix(): _sha256_file(REPO_ROOT / path)
        for path in RELEVANT_SOURCE_PATHS
    }
    try:
        head_commit = _git_output("rev-parse", "--verify", "HEAD").decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise PlanError("cannot decode git HEAD identity") from error
    head_tree_sha256 = _sha256_bytes(
        _git_output("ls-tree", "-r", "--full-tree", head_commit)
    )
    status_filter = _planner_owned_status_filter(output_dir)
    status_records = _git_status_records(status_filter)
    dirty_content = _dirty_path_content(status_records)
    dirty_content_after = _dirty_path_content(status_records)
    if _git_status_records(status_filter) != status_records:
        raise PlanError("git source status changed while capturing the snapshot")
    if dirty_content_after != dirty_content:
        raise PlanError("dirty source content changed while capturing the snapshot")
    try:
        head_after = _git_output("rev-parse", "--verify", "HEAD").decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise PlanError("cannot decode git HEAD identity") from error
    if head_after != head_commit:
        raise PlanError("git HEAD changed while capturing the source snapshot")
    snapshot_payload = {
        "head_commit_full": head_commit,
        "head_tree_sha256": head_tree_sha256,
        "git_status_porcelain_v1": status_records,
        "dirty_path_content": dirty_content,
        "relevant_source_files_sha256": source_hashes,
    }
    return {
        **snapshot_payload,
        "source_snapshot_dirty": bool(status_records),
        "dirty_paths": sorted(
            {path for record in status_records for path in record["paths"]}
        ),
        "git_status_sha256": _sha256_bytes(_canonical_json_bytes(status_records)),
        "source_snapshot_sha256": _sha256_bytes(
            _canonical_json_bytes(snapshot_payload)
        ),
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


def build_plan(
    requested_stage: str,
    *,
    output_dir: Path | None = None,
) -> dict[str, object]:
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
        **_source_identity(output_dir),
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


def _output_payloads(plan: dict[str, object]) -> dict[str, bytes]:
    run_specs = plan["run_specs"]
    if not isinstance(run_specs, list):
        raise PlanError("internal error: run_specs must be a list")
    return {
        PLAN_FILENAME: _canonical_json_bytes(plan),
        JSONL_FILENAME: _jsonl_bytes(run_specs),
        TSV_FILENAME: _tsv_bytes(run_specs),
    }


def _preflight_existing_output(
    output_dir: Path,
    payloads: dict[str, bytes],
) -> bool:
    if not os.path.lexists(output_dir):
        return False
    if output_dir.is_symlink() or not output_dir.is_dir():
        raise PlanError(f"plan output is not a directory: {output_dir}")
    try:
        entries = {path.name: path for path in output_dir.iterdir()}
    except OSError as error:
        raise PlanError(f"cannot inspect existing plan output {output_dir}: {error}") from error
    if set(entries) != set(payloads):
        raise PlanError(f"existing plan output is incomplete or conflicting: {output_dir}")
    try:
        matches = all(entries[name].read_bytes() == payload for name, payload in payloads.items())
    except OSError as error:
        raise PlanError(f"cannot read existing plan output {output_dir}: {error}") from error
    if not matches:
        raise PlanError(f"existing plan output is incomplete or conflicting: {output_dir}")
    return True


def _write_staged_output(path: Path, payload: bytes) -> None:
    try:
        with path.open("xb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as error:
        raise PlanError(f"cannot write plan output {path}: {error}") from error


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError as error:
        raise PlanError(f"cannot synchronize plan directory {path}: {error}") from error


def _acquire_output_lock(lock_path: Path) -> int:
    try:
        descriptor = os.open(
            lock_path,
            os.O_RDWR | os.O_CREAT | os.O_CLOEXEC,
            0o600,
        )
    except OSError as error:
        raise PlanError(f"cannot acquire plan output lock {lock_path}: {error}") from error
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        os.close(descriptor)
        raise PlanError(
            f"plan emission is already in progress for {lock_path}"
        ) from error
    except OSError as error:
        os.close(descriptor)
        raise PlanError(f"cannot lock plan output {lock_path}: {error}") from error
    try:
        os.ftruncate(descriptor, 0)
        os.lseek(descriptor, 0, os.SEEK_SET)
        os.write(descriptor, f"pid={os.getpid()}\n".encode("ascii"))
        os.fsync(descriptor)
    except OSError as error:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(descriptor)
        raise PlanError(f"cannot initialize plan output lock {lock_path}: {error}") from error
    return descriptor


def _release_output_lock(lock_path: Path, descriptor: int) -> None:
    errors: list[str] = []
    try:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
    except OSError as error:
        errors.append(f"unlock failed: {error}")
    try:
        os.close(descriptor)
    except OSError as error:
        errors.append(f"close failed: {error}")
    if errors:
        raise PlanError(
            f"cannot release plan output lock {lock_path}: {'; '.join(errors)}"
        )


def _finish_output_transaction(
    staging_dir: Path | None,
    lock_path: Path,
    lock_descriptor: int,
) -> tuple[PlanError | None, PlanError | None]:
    cleanup_error: PlanError | None = None
    release_error: PlanError | None = None
    try:
        if staging_dir is not None and staging_dir.exists():
            try:
                shutil.rmtree(staging_dir)
            except OSError as error:
                cleanup_error = PlanError(
                    f"cannot clean staged plan directory {staging_dir}: {error}"
                )
    finally:
        try:
            _release_output_lock(lock_path, lock_descriptor)
        except PlanError as error:
            release_error = error
    return cleanup_error, release_error


def _raise_transaction_errors(
    primary_error: BaseException | None,
    cleanup_error: PlanError | None,
    release_error: PlanError | None,
) -> None:
    if primary_error is None and cleanup_error is None and release_error is None:
        return
    if primary_error is not None and cleanup_error is None and release_error is None:
        raise primary_error
    if primary_error is None and cleanup_error is not None and release_error is None:
        raise cleanup_error
    if primary_error is None and cleanup_error is None and release_error is not None:
        raise release_error
    details: list[str] = []
    if primary_error is not None:
        details.append(f"primary failure: {primary_error}")
    if cleanup_error is not None:
        details.append(f"cleanup failure: {cleanup_error}")
    if release_error is not None:
        details.append(f"lock release failure: {release_error}")
    combined = PlanError("; ".join(details))
    if primary_error is not None:
        raise combined from primary_error
    raise combined


def emit_plan(requested_stage: str, output_dir: Path) -> dict[str, object]:
    plan = build_plan(requested_stage, output_dir=output_dir)
    payloads = _output_payloads(plan)
    output_parent = output_dir.parent
    try:
        output_parent.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise PlanError(
            f"cannot create plan output parent {output_parent}: {error}"
        ) from error
    if _preflight_existing_output(output_dir, payloads):
        return plan

    lock_path = output_parent / f".{output_dir.name}.lock"
    lock_descriptor = _acquire_output_lock(lock_path)
    staging_dir: Path | None = None
    primary_error: BaseException | None = None
    result: dict[str, object] | None = None
    try:
        if _preflight_existing_output(output_dir, payloads):
            result = plan
        else:
            try:
                staging_dir = Path(
                    tempfile.mkdtemp(
                        prefix=f".{output_dir.name}.tmp-",
                        dir=output_parent,
                    )
                )
            except OSError as error:
                raise PlanError(
                    f"cannot create staged plan directory beside {output_dir}: {error}"
                ) from error
            for name, payload in payloads.items():
                _write_staged_output(staging_dir / name, payload)
            _fsync_directory(staging_dir)
            try:
                os.rename(staging_dir, output_dir)
            except OSError as error:
                raise PlanError(
                    f"cannot atomically promote plan output {output_dir}: {error}"
                ) from error
            staging_dir = None
            _fsync_directory(output_parent)
            result = plan
    except BaseException as error:
        primary_error = error
    cleanup_error, release_error = _finish_output_transaction(
        staging_dir,
        lock_path,
        lock_descriptor,
    )
    _raise_transaction_errors(primary_error, cleanup_error, release_error)
    if result is None:
        raise PlanError("internal error: plan transaction produced no result")
    return result


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
