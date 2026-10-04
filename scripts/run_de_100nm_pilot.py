#!/usr/bin/env python3
"""Execute a numerical DE pilot using a verified managed FEM build.

Execution receipts are deliberately unqualified: dispersion comparison and mesh/
airbox convergence are separate scientific gates. No analytic solver is invoked.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
import os
import re
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import zipfile

from control_room_port import is_bindable
import run_comsol_dispersion_benchmark as managed
from runtime_source_change_policy import is_non_runtime_path
from de_shifted_ksp_trial import validate_shifted_ksp_trial
from de_gamma_krylov_trial import validate_gamma_krylov_trial
from validate_de_smoke_rows import (
    PARALLEL_PROBE_FREQUENCY_WINDOW_HZ,
    PARALLEL_PROBE_VECTORS_RAD_PER_M,
    SAMPLING,
    validate_parallel_probe_metadata,
    validate_parallel_probe_solver_artifacts,
    validate_rows,
    validate_selected_only_diagnostics,
)
from validate_de_physical_potential import validate_physical_potential, _extract_mesh
from validate_parallel_execution_report import validate_parallel_execution_report, ValidationError as ParallelReportError
import de_smoke_model_input as model_input
from de_signed_state_closure import bind_signed_state_closure
from de_failed_modal_diagnostic import read_failed_schur_action
from run_de_ui_model import copy_web

MODEL = "examples/fem_de_film_100nm_numeric_pilot.py"
NEAREST_PILOT = "de-smoke-nearest-k2"
NEAREST_PILOTS = frozenset((NEAREST_PILOT,))
DEFAULT_NEAREST_TARGET_FREQUENCY_GHZ = 10.0
SIGNED_FIFTEEN_PILOT = "de-smoke-signed-fifteen"
PARALLEL_PROBE_PILOT = "de-smoke-parallel-probe"
PARALLEL_PROBE_SAMPLING = "parallel-probe"
PARALLEL_PROBE_MODEL_SOURCE_COMMIT = "6cf0b786dc688e6a6993f7273df96dcb50727b1b"
PARALLEL_PROBE_MODEL_SHA256 = "ea1a0afd90ae60b779db5264125756bd3073264717a4b09f1dcfdf59862b50a8"
PARALLEL_PROBE_MANIFEST_SHA256 = "ecc7e0defad7ff161400703f6ed51d26add34aae28fb476a937ef72b206093db"
PARALLEL_PROBE_EQUILIBRIUM_SHA256 = "ce9d630b90234933cce60304b5564f543304d587680d08e5793e114be1f655d1"
PARALLEL_PROBE_LINEARIZATION_SHA256 = "c0e5bb847a17b5da0f43b1c0a7ba3303028be44f3dcd926cd3e7e620f242864e"
PARALLEL_PROBE_INPUT_RELATIVE_ROOT = (
    "runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/"
    "scientific-batches/nonzero-k-validation/d30406a2ef6d42cb9120ce04d58d646a/"
    "serial-adaptive-probe-v1"
)
PARALLEL_PROBE_REQUIRED_CPU_CORES = 4
PARALLEL_PROBE_REQUIRED_MEMORY_BYTES = 8 * 1024**3
PARALLEL_PROBE_POLICY = {
    "max_cpu_percent": 90.0,
    "max_memory_percent": 80.0,
    "memory_reserve_bytes": 1024**3,
    "max_workers": 2,
    "threads_per_worker": 1,
}
SCHUR_ACTION_DIAGNOSTIC_STATUSES = frozenset(("measured", "failed", "unavailable"))
SCHUR_ACTION_DIAGNOSTIC_DEFECT_FIELDS = (
    "max_potential_relative_residual",
    "max_repeatability_relative_defect",
    "repeatability_first_relative_defect",
    "repeatability_second_relative_defect",
    "max_homogeneity_relative_defect",
    "homogeneity_half_relative_defect",
    "homogeneity_double_relative_defect",
    "homogeneity_tiny_relative_defect",
    "additivity_relative_defect",
    "mat_shell_reconstruction_relative_defect",
    "min_cancellation_ratio",
    "max_magnetic_l2_norm",
    "max_feedback_l2_norm",
    "max_combined_l2_norm",
    "min_rhs_l2_norm",
    "max_rhs_l2_norm",
)
PILOTS = {
    "de100": (MODEL, None),
    "de-smoke-two": ("examples/fem_de_smoke_numeric.py", "two"),
    "de-smoke-k0": ("examples/fem_de_smoke_numeric.py", "k0"),
    "de-smoke-k2": ("examples/fem_de_smoke_numeric.py", "k2"),
    "de-smoke-k25": ("examples/fem_de_smoke_numeric.py", "k25"),
    "de-smoke-bv-k25": ("examples/fem_de_smoke_numeric.py", "bv-k25"),
    "de-smoke-positive-six": ("examples/fem_de_smoke_numeric.py", "positive-six"),
    "de-smoke-bv-positive-six": ("examples/fem_de_smoke_numeric.py", "bv-positive-six"),
    "de-smoke-five": ("examples/fem_de_smoke_numeric.py", "five"),
    "de-smoke-positive-26": ("examples/fem_de_smoke_numeric.py", "positive-26"),
    "de-smoke-bv-positive-26": ("examples/fem_de_smoke_numeric.py", "bv-positive-26"),
    "de-smoke-signed-eleven": ("examples/fem_de_smoke_numeric.py", "signed-eleven"),
    SIGNED_FIFTEEN_PILOT: ("examples/fem_de_smoke_numeric.py", "signed-fifteen"),
    PARALLEL_PROBE_PILOT: ("examples/fem_de_smoke_numeric.py", PARALLEL_PROBE_SAMPLING),
    NEAREST_PILOT: ("examples/fem_de_smoke_numeric.py", "k2"),
}
for _geometry_prefix in ("", "bv-"):
    for _k_um in range(-25, 26):
        _sampling = f"{_geometry_prefix}k{_k_um}"
        PILOTS.setdefault(f"de-smoke-{_sampling}", ("examples/fem_de_smoke_numeric.py", _sampling))
SOLVER_RTOL_CHOICES = ("1e-8", "1e-7", "1e-6")
EPS_PREFILTER_CHOICES = ("1e-8", "1e-9", "1e-10", "1e-11")
SHIFTED_KSP_TYPE_CHOICES = ("gmres", "fgmres")
SHIFTED_KSP_RTOL_CHOICES = ("1e-8", "1e-9", "1e-10", "1e-11", "1e-12")
GMRES_RESTART_CHOICES = ("8", "10", "12", "16", "30")
MESH_LEVEL_CHOICES = ("L0", "L1", "L2", "L3")
THICKNESS_LAYERS_CHOICES = ("3", "6", "9")
AIR_GROWTH_RATE_CHOICES = ("1.3", "1.15", "1.075", "1.0375")
MESH_LEVEL_ELEMENT_SIZES_M = {"L0": 10e-9, "L1": 7.5e-9, "L2": 5e-9, "L3": 3.75e-9}
UI_API_PORT = 8081
UI_WORKSPACE_ROOT = "/workspace/fullmag-ui-workspace"
UI_STATE_ROOT = UI_WORKSPACE_ROOT + "/.fullmag"
UI_WEB_ROOT = "/workspace/fullmag-web"
OPENAPI_CONTRACT_PATHS = (
    "apps/control-room/src/kernel/api/generated/openapi-v2.json",
    "apps/control-room/src/kernel/api/generated/openapi-v2-types.ts",
    "apps/control-room/src/kernel/api/generated/openapi-v2-client.ts",
    "apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts",
)


def _validate_air_growth_rate_request(pilot, requested, *, external_model, parallel_mode=None):
    if requested is None:
        return
    if type(requested) is not str or requested not in AIR_GROWTH_RATE_CHOICES:
        allowed = ", ".join(repr(value) for value in AIR_GROWTH_RATE_CHOICES)
        raise managed.BenchmarkError(f"air growth rate must be exactly one of {allowed}")
    if pilot not in PILOTS or not pilot.startswith("de-smoke-"):
        raise managed.BenchmarkError("air growth rate requires a standalone DE-SMOKE pilot")
    if not external_model:
        raise managed.BenchmarkError("air growth rate requires a versioned standalone --model-ref")
    if pilot == SIGNED_FIFTEEN_PILOT or _is_parallel_probe(pilot) or parallel_mode is not None:
        raise managed.BenchmarkError(
            "air growth rate requires a non-parallel single-k DE-SMOKE pilot"
        )
    sampling = PILOTS[pilot][1]
    if not isinstance(sampling, str) or re.fullmatch(r"k-?\d+", sampling) is None:
        raise managed.BenchmarkError(
            "air growth rate is restricted to single-k Damon-Eshbach DE-SMOKE pilots"
        )


def _validate_air_growth_rate_model_input(data, requested=None):
    """Reject versioned inputs that cannot consume the explicit mesh control."""
    if requested is not None and (
        type(requested) is not str or requested not in AIR_GROWTH_RATE_CHOICES
    ):
        allowed = ", ".join(repr(value) for value in AIR_GROWTH_RATE_CHOICES)
        raise managed.BenchmarkError(f"air growth rate must be exactly one of {allowed}")
    try:
        tree = ast.parse(data.decode("utf-8"), filename="fem_de_smoke_numeric.py")
    except (AttributeError, UnicodeDecodeError, SyntaxError) as error:
        raise managed.BenchmarkError("air growth rate requires a valid UTF-8 standalone model") from error
    has_environment_key = any(
        isinstance(node, ast.Constant)
        and node.value == "FULLMAG_DE_SMOKE_AIR_GROWTH_RATE"
        for node in ast.walk(tree)
    )
    has_universe_mesh_control = False
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        function = node.func
        is_universe_mesh = (
            isinstance(function, ast.Attribute)
            and function.attr == "mesh"
            and isinstance(function.value, ast.Attribute)
            and function.value.attr == "universe"
            and isinstance(function.value.value, ast.Name)
            and function.value.value.id == "study"
        )
        if not is_universe_mesh:
            continue
        has_universe_mesh_control = any(
            keyword.arg == "maximum_element_growth_rate"
            and isinstance(keyword.value, ast.Name)
            and keyword.value.id == "AIR_GROWTH_RATE"
            for keyword in node.keywords
        )
        if has_universe_mesh_control:
            break
    if not has_environment_key or not has_universe_mesh_control:
        raise managed.BenchmarkError(
            "air growth rate requires a versioned standalone model that applies "
            "FULLMAG_DE_SMOKE_AIR_GROWTH_RATE to study.universe.mesh"
        )
    if requested is None:
        return

    mapping_values = []
    for statement in tree.body:
        if isinstance(statement, ast.Assign):
            targets = statement.targets
            value = statement.value
        elif isinstance(statement, ast.AnnAssign):
            targets = [statement.target]
            value = statement.value
        else:
            continue
        if any(
            isinstance(target, ast.Name) and target.id == "_AIR_GROWTH_RATE_VALUES"
            for target in targets
        ):
            mapping_values.append(value)
    if len(mapping_values) != 1 or not isinstance(mapping_values[0], ast.Dict):
        raise managed.BenchmarkError(
            "versioned standalone model must declare one literal "
            "_AIR_GROWTH_RATE_VALUES mapping"
        )

    literal_values = {}
    for key_node, value_node in zip(mapping_values[0].keys, mapping_values[0].values):
        if (
            not isinstance(key_node, ast.Constant)
            or type(key_node.value) is not str
            or key_node.value in literal_values
            or not isinstance(value_node, ast.Constant)
            or type(value_node.value) not in (int, float)
        ):
            raise managed.BenchmarkError(
                "versioned standalone model air growth values must be unique "
                "string keys and finite numeric literals"
            )
        try:
            numeric_value = float(value_node.value)
        except (OverflowError, ValueError) as error:
            raise managed.BenchmarkError(
                "versioned standalone model air growth values must be finite numeric literals"
            ) from error
        if not math.isfinite(numeric_value):
            raise managed.BenchmarkError(
                "versioned standalone model air growth values must be finite numeric literals"
            )
        literal_values[key_node.value] = numeric_value

    expected_value = float(requested)
    if literal_values.get(requested) != expected_value:
        raise managed.BenchmarkError(
            f"versioned standalone model does not declare air growth rate {requested!r} "
            "with its exact finite numeric value"
        )


def _unwrap_live_status(value, label="status"):
    """Return a LiveStatus object from direct or serialized-envelope JSON."""

    candidate = value
    for _ in range(4):
        if not isinstance(candidate, dict):
            break
        if isinstance(candidate.get("session"), dict):
            return candidate
        nested = None
        for key in ("data", "payload", "result", "status"):
            possible = candidate.get(key)
            if isinstance(possible, dict):
                nested = possible
                break
        if nested is None:
            break
        candidate = nested
    raise managed.BenchmarkError(f"{label} did not contain a LiveStatus session")


def _identity_string(value, label):
    if isinstance(value, str) and value:
        return value
    if isinstance(value, dict):
        for key in ("value", "id", "epoch", "token"):
            if key in value:
                return _identity_string(value[key], label)
    raise managed.BenchmarkError(f"{label} is missing a non-empty identity")


def _status_identity(value, label="status"):
    """Extract scope/session/run identity and realized resource proof."""

    status = _unwrap_live_status(value, label)
    session = status.get("session")
    session_id = _identity_string(session.get("session_id"), f"{label} session_id")
    if "request_scope_epoch" in session:
        scope_field = "request_scope_epoch"
        scope = _identity_string(session.get(scope_field), f"{label} {scope_field}")
    else:
        scope_field = "session_epoch"
        scope = _identity_string(session.get(scope_field), f"{label} {scope_field}")
    run = status.get("run")
    run_id = None
    if run is not None:
        if not isinstance(run, dict):
            raise managed.BenchmarkError(f"{label} run summary is malformed")
        run_id = _identity_string(run.get("run_id"), f"{label} run_id")
    domain = status.get("domain")
    cell_count = domain.get("cell_count") if isinstance(domain, dict) else None
    if type(cell_count) is not int or cell_count <= 0:
        raise managed.BenchmarkError(f"{label} has no realized domain cells")
    resources = status.get("resources")
    field_catalog_revision = (
        resources.get("field_catalog_revision") if isinstance(resources, dict) else None
    )
    if type(field_catalog_revision) is not int or field_catalog_revision <= 0:
        raise managed.BenchmarkError(
            f"{label} has no published field catalog revision"
        )
    return {
        "session_id": session_id,
        "scope_field": scope_field,
        "scope": scope,
        "run_id": run_id,
        "cell_count": cell_count,
        "field_catalog_revision": field_catalog_revision,
    }


def _validate_export_status_receipt(receipt, solver_exit_code, label="UI archive"):
    if not isinstance(receipt, dict):
        raise managed.BenchmarkError(f"{label} export status receipt is missing")
    if receipt.get("schema") != "fullmag.live-export-receipt.v1":
        raise managed.BenchmarkError(f"{label} export status receipt schema is invalid")
    if receipt.get("solver_exit_code") != 0 or solver_exit_code != 0:
        raise managed.BenchmarkError(
            f"{label} requires a zero solver exit code before export"
        )
    before = _status_identity(receipt.get("before_status"), f"{label} pre-export status")
    after = _status_identity(receipt.get("after_status"), f"{label} post-export status")
    for key in ("session_id", "scope_field", "scope"):
        if before[key] != after[key]:
            raise managed.BenchmarkError(
                f"{label} session scope identity changed across export ({key})"
            )
    before_run = before.get("run_id")
    after_run = after.get("run_id")
    if before_run is not None and after_run is not None and before_run != after_run:
        raise managed.BenchmarkError(
            f"{label} run identity changed across export"
        )
    return {"before": before, "after": after,
            "run_identity_partial": (before_run is None) != (after_run is None)}


def _zip_json(archive, name, label):
    try:
        value = json.loads(archive.read(name).decode("utf-8"))
    except (KeyError, UnicodeDecodeError, ValueError, TypeError) as error:
        raise managed.BenchmarkError(f"{label} is missing or invalid JSON") from error
    if not isinstance(value, dict):
        raise managed.BenchmarkError(f"{label} must be a JSON object")
    return value


def _local_artifact_hashes(case_dir, artifact_prefix):
    case_dir = Path(case_dir)
    if not case_dir.is_dir():
        raise managed.BenchmarkError("UI archive artifact source directory is missing")
    expected = {}
    for candidate in case_dir.rglob("*"):
        if candidate.is_symlink():
            raise managed.BenchmarkError(
                f"UI archive artifact source contains a symbolic link: {candidate}"
            )
        if not candidate.is_file():
            continue
        relative = candidate.relative_to(case_dir).as_posix()
        expected[artifact_prefix + relative] = hashlib.sha256(candidate.read_bytes()).hexdigest()
    if not expected:
        raise managed.BenchmarkError("UI archive artifact source is empty")
    for required in ("metadata.json", "eigen/dispersion.csv"):
        if artifact_prefix + required not in expected:
            raise managed.BenchmarkError(
                f"UI archive artifact source is missing {required}"
            )
    return expected


def validate_fms_archive(path, *, status_receipt=None, case_dir=None, solver_exit_code=0):
    """Validate an API-exported FMS archive and bind it to this pilot output."""

    path = Path(path)
    if not path.is_file() or path.stat().st_size == 0:
        raise managed.BenchmarkError("UI archive is missing or empty")
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                raise managed.BenchmarkError("UI archive contains duplicate members")
            if archive.testzip() is not None:
                raise managed.BenchmarkError("UI archive contains a corrupt member")
            required = {
                "manifest/session.json",
                "manifest/workspace.json",
                "manifest/export_profile.json",
                "project/main.py",
                "project/ui_state.json",
                "project/current_live_snapshot.json",
            }
            if not required.issubset(names):
                raise managed.BenchmarkError(
                    "UI archive is missing an API export manifest or live project document"
                )
            session_manifest = _zip_json(
                archive, "manifest/session.json", "manifest/session.json"
            )
            workspace_manifest = _zip_json(
                archive, "manifest/workspace.json", "manifest/workspace.json"
            )
            export_profile = _zip_json(
                archive, "manifest/export_profile.json", "manifest/export_profile.json"
            )
            snapshot = _zip_json(
                archive, "project/current_live_snapshot.json",
                "project/current_live_snapshot.json",
            )
            if session_manifest.get("format") != "fullmag.session.v1":
                raise managed.BenchmarkError("UI archive session manifest format is invalid")
            if session_manifest.get("profile") != "archive":
                raise managed.BenchmarkError("UI archive was not exported with archive profile")
            if session_manifest.get("workspace_ref") != "manifest/workspace.json":
                raise managed.BenchmarkError(
                    "UI archive session manifest has the wrong workspace reference"
                )
            if session_manifest.get("export_profile_ref") != "manifest/export_profile.json":
                raise managed.BenchmarkError(
                    "UI archive session manifest has the wrong export profile reference"
                )
            main_script = archive.read("project/main.py")
            if workspace_manifest.get("script_ref") != "project/main.py":
                raise managed.BenchmarkError(
                    "UI archive workspace manifest has the wrong script reference"
                )
            if workspace_manifest.get("script_sha256") != hashlib.sha256(main_script).hexdigest():
                raise managed.BenchmarkError(
                    "UI archive workspace manifest script hash does not match project/main.py"
                )
            if workspace_manifest.get("ui_state_ref") != "project/ui_state.json":
                raise managed.BenchmarkError(
                    "UI archive workspace manifest has the wrong UI state reference"
                )
            if export_profile.get("profile") != "archive":
                raise managed.BenchmarkError(
                    "UI archive export profile does not declare archive"
                )
            if export_profile.get("include_artifacts") != "all":
                raise managed.BenchmarkError(
                    "UI archive export profile does not include all artifacts"
                )
            session_id = _identity_string(
                session_manifest.get("session_id"), "archive session_id"
            )
            snapshot_session = snapshot.get("session")
            if not isinstance(snapshot_session, dict):
                raise managed.BenchmarkError("UI archive snapshot has no session manifest")
            snapshot_session_id = _identity_string(
                snapshot_session.get("session_id"), "snapshot session_id"
            )
            if snapshot_session_id != session_id:
                raise managed.BenchmarkError(
                    "UI archive snapshot session_id does not match manifest/session.json"
                )
            snapshot_run_id = _identity_string(
                snapshot_session.get("run_id"), "snapshot run_id"
            )
            snapshot_run = snapshot.get("run")
            if isinstance(snapshot_run, dict) and snapshot_run.get("run_id") != snapshot_run_id:
                raise managed.BenchmarkError(
                    "UI archive snapshot run_id does not match its run summary"
                )
            run_ref = f"runs/{snapshot_run_id}/run_manifest.json"
            run_refs = session_manifest.get("run_refs")
            if not isinstance(run_refs, list) or run_ref not in run_refs:
                raise managed.BenchmarkError(
                    "UI archive session manifest does not declare the live run"
                )
            if run_ref not in names:
                raise managed.BenchmarkError("UI archive is missing the live run manifest")
            run_manifest = _zip_json(archive, run_ref, run_ref)
            if run_manifest.get("run_id") != snapshot_run_id:
                raise managed.BenchmarkError(
                    "UI archive run manifest does not match the live run"
                )
            if run_manifest.get("status") != "completed":
                raise managed.BenchmarkError("UI archive run manifest is not completed")
            for snapshot_key, manifest_key in (
                ("requested_backend", "backend"), ("precision", "precision")
            ):
                expected = snapshot_session.get(snapshot_key)
                actual = run_manifest.get(manifest_key)
                if isinstance(expected, str) and expected and actual != expected:
                    raise managed.BenchmarkError(
                        f"UI archive run manifest {manifest_key} does not match the snapshot"
                    )
            artifact_prefix = f"runs/{snapshot_run_id}/artifacts/"
            artifact_infos = [
                info for info in infos
                if info.filename.startswith(artifact_prefix) and not info.is_dir()
            ]
            if not artifact_infos:
                raise managed.BenchmarkError("UI archive contains no captured run artifacts")
            other_artifacts = [
                info.filename for info in infos
                if info.filename.startswith("runs/")
                and "/artifacts/" in info.filename
                and not info.filename.startswith(artifact_prefix)
            ]
            if other_artifacts:
                raise managed.BenchmarkError(
                    "UI archive contains artifacts from an unrelated run"
                )
            local_hashes = (
                _local_artifact_hashes(case_dir, artifact_prefix)
                if case_dir is not None else None
            )
            archive_hashes = {
                info.filename: hashlib.sha256(archive.read(info)).hexdigest()
                for info in artifact_infos
            }
            if local_hashes is not None:
                if set(archive_hashes) != set(local_hashes):
                    missing = sorted(set(local_hashes) - set(archive_hashes))
                    extra = sorted(set(archive_hashes) - set(local_hashes))
                    detail = missing[0] if missing else extra[0]
                    raise managed.BenchmarkError(
                        f"UI archive artifacts do not exactly match local case: {detail}"
                    )
                for name, expected_hash in local_hashes.items():
                    if archive_hashes[name] != expected_hash:
                        raise managed.BenchmarkError(
                            f"UI archive artifact hash does not match local case: {name}"
                        )
            status_report = None
            if status_receipt is not None:
                status_report = _validate_export_status_receipt(
                    status_receipt, solver_exit_code
                )
                for identity in (status_report["before"], status_report["after"]):
                    if identity["session_id"] != session_id:
                        raise managed.BenchmarkError(
                            "UI archive session_id does not match the API status identity"
                        )
                    if identity.get("run_id") is not None and identity["run_id"] != snapshot_run_id:
                        raise managed.BenchmarkError(
                            "UI archive run_id does not match the API status identity"
                        )
            elif solver_exit_code != 0:
                raise managed.BenchmarkError(
                    "UI archive requires a zero solver exit code before export"
                )
    except managed.BenchmarkError:
        raise
    except (OSError, zipfile.BadZipFile) as error:
        raise managed.BenchmarkError("UI archive is not a valid .fms archive") from error
    return {
        "path": path.name,
        "size_bytes": path.stat().st_size,
        "entry_count": len(names),
        "artifact_entry_count": len(artifact_infos),
        "session_id": session_id,
        "run_id": snapshot_run_id,
        "artifact_sha256": archive_hashes,
        "status_scope_stable": bool(status_report is not None),
        "solver_exit_code": solver_exit_code,
    }


def pilot_model(pilot):
    if pilot not in PILOTS:
        raise managed.BenchmarkError("unknown DE pilot")
    return PILOTS[pilot][0]


def _validate_parallel_probe_build(context, expected_source_digest):
    """Bind both probe runs to one deliberately selected, verified CPU capsule."""
    if not isinstance(expected_source_digest, str) or not re.fullmatch(
        r"[0-9a-f]{64}", expected_source_digest
    ):
        raise managed.BenchmarkError("parallel probe requires a lowercase SHA256 source digest")
    if context.job.get("source_digest") != expected_source_digest:
        raise managed.BenchmarkError("parallel probe build source digest differs from the requested capsule")
    if context.job.get("profile") != managed.CPU_ABI_RUNTIME_PROFILE:
        raise managed.BenchmarkError("parallel probe requires the CPU-only runtime-v2 build profile")
    required_sources = {
        "crates/fullmag-ir/src/parallel_execution.rs",
        "crates/fullmag-runner/src/adaptive_resources.rs",
        "crates/fullmag-runner/src/adaptive_resources_linux.rs",
        "crates/fullmag-runner/src/eigen/k_process_pool.rs",
        "crates/fullmag-runner/src/fem/eigen_k_pool.rs",
        "crates/fullmag-runner/src/fem/eigen_k_worker.rs",
    }
    captured = {entry.get("path") for entry in context.manifest.get("files", [])
                if isinstance(entry, dict)}
    missing = sorted(required_sources - captured)
    if missing:
        raise managed.BenchmarkError("parallel probe capsule lacks adaptive sources: " + ", ".join(missing))


def signed_fifteen_campaign_identity(model_identity, parallel_mode):
    if (parallel_mode not in {"serial", "adaptive"} or not isinstance(model_identity, dict)
            or model_identity.get("kind") != "versioned_standalone_input"
            or not isinstance(model_identity.get("commit"), str)
            or not re.fullmatch(r"[0-9a-f]{40}", model_identity["commit"])
            or not isinstance(model_identity.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", model_identity["sha256"])):
        raise managed.BenchmarkError("signed-fifteen is missing its pinned execution policy")
    return {
        "mode": parallel_mode, "sampling": "signed-fifteen",
        "model_sha256": model_identity["sha256"],
        "model_source_commit": model_identity["commit"],
        "max_cpu_percent": 90, "max_memory_percent": 80,
        "memory_reserve_bytes": 1073741824,
        "max_workers": None, "threads_per_worker": 1,
    }


def bind_parallel_report(case_dir, artifacts, *, expected_policy, expected_indices):
    """Bind actual scheduler telemetry to the numerical campaign receipt."""
    relative = "eigen/parallel_execution.v1.json"
    path = Path(case_dir) / relative
    managed._regular_file(path, "adaptive process-pool report")
    raw = managed._json_file(path, "adaptive process-pool report", max_bytes=4 * 1024 * 1024)
    try:
        validation = validate_parallel_execution_report(
            raw, expected_mode="adaptive", expected_sample_count=len(expected_indices),
            require_concurrency=False)
    except ParallelReportError as error:
        raise managed.BenchmarkError("adaptive report validation failed: " + str(error)) from error
    if raw.get("policy") != expected_policy:
        raise managed.BenchmarkError("adaptive report policy differs from the campaign request")
    if [entry["sample_index"] for entry in raw.get("inputs", [])] != list(expected_indices):
        raise managed.BenchmarkError("adaptive report sample indices differ from the campaign")
    binding = {"size": path.stat().st_size, "sha256": managed._sha256_file(path)}
    artifacts["required_artifact_hashes"][relative] = binding
    artifacts["parallel_execution_report"] = validation
    return validation


def _is_parallel_probe(pilot):
    return pilot == PARALLEL_PROBE_PILOT


def _parallel_probe_root(layout, requested=None):
    storage_root = Path(layout["storage_root"])
    canonical = storage_root.joinpath(*PARALLEL_PROBE_INPUT_RELATIVE_ROOT.split("/"))
    candidate = canonical if requested is None else Path(requested).expanduser()
    if not candidate.is_absolute():
        candidate = storage_root / candidate
    if os.path.normcase(os.path.abspath(str(candidate))) != os.path.normcase(
            os.path.abspath(str(canonical))):
        raise managed.BenchmarkError(
            "parallel probe input root must be the pinned managed campaign directory")
    try:
        return managed.fullmag_storage.validate_path(
            canonical, storage_root, "parallel probe input root"
        )
    except managed.fullmag_storage.StorageError as error:
        raise managed.BenchmarkError("parallel probe input root escapes managed storage or traverses a link") from error


def _parallel_probe_sha256(path, label):
    try:
        return managed._sha256_file(managed._regular_file(Path(path), label))
    except (OSError, ValueError, managed.BenchmarkError) as error:
        raise managed.BenchmarkError(f"cannot hash parallel probe {label}") from error


def _validate_parallel_probe_inputs(layout, requested_root, mode):
    """Load only the immutable input bundle pinned for the parity probe."""

    if mode not in {"serial", "adaptive"}:
        raise managed.BenchmarkError("parallel probe mode must be serial or adaptive")
    root = _parallel_probe_root(layout, requested_root)
    managed._regular_dir(root, "parallel probe root")
    model_path = managed._regular_file(root / "model-input.py", "parallel probe model input")
    model_data = model_path.read_bytes()
    if not model_data or len(model_data) > 1024 * 1024:
        raise managed.BenchmarkError("parallel probe model input is empty or oversized")
    try:
        compile(model_data, "model-input.py", "exec")
    except (SyntaxError, ValueError) as error:
        raise managed.BenchmarkError("parallel probe model input is not valid Python") from error
    model_sha256 = _parallel_probe_sha256(model_path, "model input")
    if model_sha256 != PARALLEL_PROBE_MODEL_SHA256:
        raise managed.BenchmarkError("parallel probe model input hash is not the pinned SHA")

    input_dir = managed._regular_dir(root / "input", "parallel probe input directory")
    manifest_path = managed._regular_file(input_dir / "input-manifest.json", "parallel probe input manifest")
    manifest_sha256 = _parallel_probe_sha256(manifest_path, "input manifest")
    if manifest_sha256 != PARALLEL_PROBE_MANIFEST_SHA256:
        raise managed.BenchmarkError("parallel probe input manifest hash is not the pinned SHA")
    manifest = managed._json_file(manifest_path, "parallel probe input manifest", max_bytes=4 * 1024 * 1024)
    if manifest.get("schema") != "fullmag.serial-adaptive-probe-input-manifest.v1":
        raise managed.BenchmarkError("parallel probe input manifest schema is invalid")
    if manifest.get("copy_policy") != "byte-exact copies of already validated metadata; immutable inputs for both policy runs":
        raise managed.BenchmarkError("parallel probe input manifest copy policy is invalid")
    entries = manifest.get("files")
    if not isinstance(entries, list) or len(entries) != 2:
        raise managed.BenchmarkError("parallel probe input manifest must bind exactly two files")
    expected = {
        "equilibrium_artifact.v7.json": ("equilibrium_artifact.v7", PARALLEL_PROBE_EQUILIBRIUM_SHA256),
        "linearization_state.v6.json": ("LinearizationState.v6", PARALLEL_PROBE_LINEARIZATION_SHA256),
    }
    observed = {}
    allowed_input_names = set(expected) | {"input-manifest.json"}
    for child in input_dir.iterdir():
        if child.name not in allowed_input_names:
            raise managed.BenchmarkError(
                f"parallel probe input directory contains an unbound file: {child.name}")
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise managed.BenchmarkError("parallel probe manifest contains an invalid file entry")
        relative = entry["path"]
        if relative not in expected or relative in observed:
            raise managed.BenchmarkError("parallel probe manifest contains an unexpected or duplicate file")
        schema, expected_sha256 = expected[relative]
        if entry.get("schema_version") != schema or entry.get("sha256") != expected_sha256:
            raise managed.BenchmarkError(f"parallel probe manifest binding is invalid for {relative}")
        artifact_path = managed._regular_file(input_dir / relative, f"parallel probe input {relative}")
        actual_sha256 = _parallel_probe_sha256(artifact_path, relative)
        if actual_sha256 != expected_sha256:
            raise managed.BenchmarkError(f"parallel probe input hash mismatch for {relative}")
        artifact = managed._json_file(artifact_path, f"parallel probe input {relative}", max_bytes=32 * 1024 * 1024)
        if artifact.get("schema_version") != schema:
            raise managed.BenchmarkError(f"parallel probe input schema mismatch for {relative}")
        if not isinstance(entry.get("content_sha256"), str) \
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", entry["content_sha256"]) \
                or entry.get("content_sha256") != artifact.get("content_sha256"):
            raise managed.BenchmarkError(f"parallel probe content hash binding is invalid for {relative}")
        if relative == "equilibrium_artifact.v7.json":
            expected_id = f"equilibrium_artifact.v7:{artifact.get('content_sha256', '').removeprefix('sha256:')}"
            if entry.get("equilibrium_id") != expected_id:
                raise managed.BenchmarkError("parallel probe equilibrium identity binding is invalid")
        else:
            expected_id = f"LinearizationState.v6:{artifact.get('content_sha256', '').removeprefix('sha256:')}"
            if entry.get("linearization_state_id") != expected_id:
                raise managed.BenchmarkError("parallel probe linearization identity binding is invalid")
        observed[relative] = {
            "sha256": actual_sha256,
            "schema_version": schema,
            "content_sha256": artifact.get("content_sha256"),
        }
    if set(observed) != set(expected):
        raise managed.BenchmarkError("parallel probe input manifest does not cover the pinned files")
    equilibrium_content = observed["equilibrium_artifact.v7.json"]["content_sha256"]
    linearization = managed._json_file(
        input_dir / "linearization_state.v6.json",
        "parallel probe linearization state",
        max_bytes=32 * 1024 * 1024,
    )
    if linearization.get("source_equilibrium_artifact") != equilibrium_content:
        raise managed.BenchmarkError("parallel probe linearization state is not bound to the equilibrium artifact")
    return model_data, {
        "kind": "pinned_parallel_probe_input",
        "source_commit": PARALLEL_PROBE_MODEL_SOURCE_COMMIT,
        "path": "serial-adaptive-probe-v1/model-input.py",
        "sha256": model_sha256,
        "manifest_path": "serial-adaptive-probe-v1/input/input-manifest.json",
        "manifest_sha256": manifest_sha256,
        # Legacy *_sha256 receipt fields bind raw file bytes, not native content.
        "equilibrium_artifact_sha256": PARALLEL_PROBE_EQUILIBRIUM_SHA256,
        "equilibrium_artifact_content_sha256": equilibrium_content,
        "equilibrium_artifact_role": "solver_consumed",
        "linearization_state_sha256": PARALLEL_PROBE_LINEARIZATION_SHA256,
        "linearization_state_content_sha256": observed["linearization_state.v6.json"]["content_sha256"],
        "linearization_state_role": "reference_provenance_only_not_consumed_by_solver",
        "parallel_mode": mode,
        "policy": dict(PARALLEL_PROBE_POLICY),
        "required_cpu_cores": PARALLEL_PROBE_REQUIRED_CPU_CORES,
        "required_memory_bytes": PARALLEL_PROBE_REQUIRED_MEMORY_BYTES,
    }, input_dir


def _is_single_k_pilot(pilot):
    sampling = PILOTS.get(pilot, (None, None))[1]
    return (pilot.startswith("de-smoke-") and sampling in SAMPLING and
            len(SAMPLING[sampling]) == 1)


def _cleanup_extra_mounts(output, *, model_identity=None, ui_enabled=False,
                          capture_session=False, ui_web_root=None,
                          include_model=True, probe_input_dir=None):
    """Return the exact non-base mounts created by this pilot invocation."""

    mounts = []
    output = Path(output)
    if include_model and model_identity is not None:
        mounts.append({
            "type": "bind",
            "source": os.path.abspath(str(output / "model-input.py")),
            "destination": "/workspace/benchmark-model.py",
            "read_only": True,
        })
    if probe_input_dir is not None:
        mounts.append({
            "type": "bind",
            "source": os.path.abspath(str(Path(probe_input_dir).resolve())),
            "destination": "/workspace/benchmark-input",
            "read_only": True,
        })
    if ui_enabled or capture_session:
        mounts.append({
            "type": "tmpfs",
            "destination": UI_WORKSPACE_ROOT,
            "read_only": False,
            "mode": "rw,nosuid,nodev,size=1g",
        })
    if ui_web_root is not None:
        mounts.append({
            "type": "bind",
            "source": os.path.abspath(str(Path(ui_web_root).resolve())),
            "destination": UI_WEB_ROOT,
            "read_only": True,
        })
    return tuple(mounts)


def _modal_selection(pilot, target_frequency_ghz=None, spectral_target=None):
    """Return the explicit modal target and its SI target frequency.

    ``nearest`` is available for every existing single-k DE/BV/Γ pilot.  The
    historical ``de-smoke-nearest-k2`` name remains an alias; all other calls
    must opt in explicitly so a frequency-window request cannot silently become
    selected-only.
    """
    if spectral_target not in (None, "frequency_window", "nearest"):
        raise managed.BenchmarkError("unsupported spectral target")
    alias_nearest = pilot in NEAREST_PILOTS
    if alias_nearest and spectral_target == "frequency_window":
        raise managed.BenchmarkError("nearest pilot cannot request frequency_window")
    if target_frequency_ghz is not None and not (alias_nearest or spectral_target == "nearest"):
        raise managed.BenchmarkError(
            "nearest target requires --spectral-target nearest for a single-k DE-SMOKE pilot"
        )
    if spectral_target is None:
        spectral_target = "nearest" if alias_nearest else "frequency_window"
    if spectral_target == "frequency_window":
        return "frequency_window", None
    if not _is_single_k_pilot(pilot):
        raise managed.BenchmarkError(
            "nearest target requires an existing single-k DE/BV/Γ pilot"
        )
    if target_frequency_ghz is None:
        target_frequency_ghz = DEFAULT_NEAREST_TARGET_FREQUENCY_GHZ
    try:
        target_frequency_ghz = float(target_frequency_ghz)
    except (TypeError, ValueError) as error:
        raise managed.BenchmarkError(
            "nearest target frequency must be a finite positive number in GHz"
        ) from error
    if not math.isfinite(target_frequency_ghz) or target_frequency_ghz <= 0.0:
        raise managed.BenchmarkError(
            "nearest target frequency must be a finite positive number in GHz"
        )
    target_frequency_hz = target_frequency_ghz * 1.0e9
    if not math.isfinite(target_frequency_hz):
        raise managed.BenchmarkError(
            "nearest target frequency overflows the finite Hz range"
        )
    return "nearest", target_frequency_hz


def _frequency_window_bounds(
    pilot, modal_target, frequency_min_ghz=None, frequency_max_ghz=None
):
    """Validate an optional DE-SMOKE frequency-window override in GHz."""

    if frequency_min_ghz is None and frequency_max_ghz is None:
        return None
    if frequency_min_ghz is None or frequency_max_ghz is None:
        raise managed.BenchmarkError(
            "frequency-window override requires both --frequency-min-ghz and "
            "--frequency-max-ghz"
        )
    if modal_target != "frequency_window":
        raise managed.BenchmarkError(
            "frequency-window bounds require --spectral-target frequency_window"
        )
    if not pilot.startswith("de-smoke-"):
        raise managed.BenchmarkError(
            "frequency-window bounds are supported only for DE-SMOKE pilots"
        )
    if isinstance(frequency_min_ghz, bool) or isinstance(frequency_max_ghz, bool):
        raise managed.BenchmarkError(
            "frequency-window bounds must be finite positive GHz values"
        )
    try:
        minimum = float(frequency_min_ghz)
        maximum = float(frequency_max_ghz)
    except (TypeError, ValueError) as error:
        raise managed.BenchmarkError(
            "frequency-window bounds must be finite positive GHz values"
        ) from error
    if (
        not math.isfinite(minimum)
        or not math.isfinite(maximum)
        or minimum <= 0.0
        or maximum <= 0.0
        or minimum >= maximum
    ):
        raise managed.BenchmarkError(
            "frequency-window bounds must be finite positive values with min < max"
        )
    minimum_hz = minimum * 1.0e9
    maximum_hz = maximum * 1.0e9
    if not math.isfinite(minimum_hz) or not math.isfinite(maximum_hz):
        raise managed.BenchmarkError("frequency-window bounds overflow finite Hz range")
    return {
        "min_ghz": minimum,
        "max_ghz": maximum,
        "min_hz": minimum_hz,
        "max_hz": maximum_hz,
    }


def validate_model(context, pilot="de100"):
    model = pilot_model(pilot)
    entries = [entry for entry in context.manifest["files"] if entry["path"] == model]
    if len(entries) != 1:
        raise managed.BenchmarkError("DE pilot is absent from this build capsule; build the committed pilot first")
    path = managed._contained_path(context.source_tree, model, "DE pilot")
    managed._regular_file(path, "DE pilot")
    digest = managed._sha256_file(path)
    if digest != entries[0]["sha256"]:
        raise managed.BenchmarkError("DE pilot differs from the verified build capsule")
    return digest


def _replace_compose_env(command, key, value):
    prefix = key + "="
    for index in range(len(command) - 1):
        if command[index] == "-e" and command[index + 1].startswith(prefix):
            command[index + 1] = prefix + value
            return
    raise managed.BenchmarkError(f"managed Compose command is missing {key}")


def _enable_ui_compose(command, output, web_root=None, host_port=UI_API_PORT, *, capture_session=False):
    output = Path(output)
    if web_root is not None:
        web_root = Path(web_root)
        if not web_root.is_dir() or not (web_root / "index.html").is_file():
            raise managed.BenchmarkError(
                "--with-ui requires an attested web root containing index.html"
            )
        if isinstance(host_port, bool) or not isinstance(host_port, int) or not 1 <= host_port <= 65535:
            raise managed.BenchmarkError("UI host port must be an integer in the range 1-65535")
    elif not capture_session:
        raise managed.BenchmarkError("live API Compose mode requires --with-ui or --capture-session")
    if not output.is_dir():
        raise managed.BenchmarkError("live API Compose command requires an existing output directory")

    # UI mode uses a loopback-only bridge publish. API-only capture has no
    # network peer and keeps the API on the container loopback interface.
    network_mode = "bridge" if web_root is not None else "none"
    override_path = output / "compose.benchmark.override.yaml"
    override_path.write_text(
        "services:\n"
        "  fem-modal-cpu:\n"
        f"    network_mode: {network_mode}\n"
        "    tmpfs:\n"
        f"      - {UI_WORKSPACE_ROOT}:rw,nosuid,nodev,size=1g\n"
        "    volumes: !reset []\n",
        encoding="utf-8",
        newline="\n",
    )
    _replace_compose_env(command, "FULLMAG_API_PORT", str(UI_API_PORT))
    _replace_compose_env(command, "FULLMAG_REPO_ROOT", UI_WORKSPACE_ROOT)
    _replace_compose_env(command, "FULLMAG_STATE_ROOT", UI_STATE_ROOT)
    _replace_compose_env(command, "FULLMAG_DISABLE_PREVIEW_3D", "0")
    _replace_compose_env(command, "FULLMAG_DISABLE_CHARTS", "0")
    timeout_index = command.index("timeout")
    service_index = timeout_index - 1
    if command[service_index] != "fem-modal-cpu":
        raise managed.BenchmarkError("managed Compose command service boundary changed")
    extras = []
    if web_root is not None:
        extras.extend([
            "--publish", f"127.0.0.1:{host_port}:{UI_API_PORT}",
            "-v", f"{web_root.resolve()}:{UI_WEB_ROOT}:ro",
            "-e", f"FULLMAG_WEB_STATIC_DIR={UI_WEB_ROOT}",
        ])
    command[service_index:service_index] = extras


def _ui_archive_shell(pilot):
    target = f"/workspace/benchmark-output/{pilot}.fms"
    receipt_target = f"/workspace/benchmark-output/{pilot}.fms.status.json"
    return [
        "python3 - <<'PY'",
        "import base64",
        "import io",
        "import json",
        "import os",
        "import tempfile",
        "import time",
        "import urllib.error",
        "import urllib.request",
        "import zipfile",
        "status_url = 'http://127.0.0.1:8081/v2/sessions/current/status'",
        "export_url = 'http://127.0.0.1:8081/v2/sessions/current/persistence/exports'",
        "def get_json(url, headers=None):",
        "    request = urllib.request.Request(url, headers=headers or {})",
        "    with urllib.request.urlopen(request, timeout=60) as response:",
        "        return json.load(response)",
        "def unwrap_status(value, label):",
        "    candidate = value",
        "    for _ in range(4):",
        "        if not isinstance(candidate, dict):",
        "            break",
        "        if isinstance(candidate.get('session'), dict):",
        "            return candidate",
        "        nested = None",
        "        for key in ('data', 'payload', 'result', 'status'):",
        "            possible = candidate.get(key)",
        "            if isinstance(possible, dict):",
        "                nested = possible",
        "                break",
        "        if nested is None:",
        "            break",
        "        candidate = nested",
        "    raise RuntimeError(f'{label} did not contain a LiveStatus session')",
        "def identity(value, label):",
        "    if isinstance(value, str) and value:",
        "        return value",
        "    if isinstance(value, dict):",
        "        for key in ('value', 'id', 'epoch', 'token'):",
        "            if key in value:",
        "                return identity(value[key], label)",
        "    raise RuntimeError(f'{label} is missing a non-empty identity')",
        "def inspect_status(value, label):",
        "    status = unwrap_status(value, label)",
        "    session = status['session']",
        "    session_id = identity(session.get('session_id'), f'{label} session_id')",
        "    scope_field = ('request_scope_epoch' if 'request_scope_epoch' in session",
        "                   else 'session_epoch')",
        "    scope = identity(session.get(scope_field), f'{label} {scope_field}')",
        "    run = status.get('run')",
        "    run_id = None",
        "    if run is not None:",
        "        if not isinstance(run, dict):",
        "            raise RuntimeError(f'{label} run summary is malformed')",
        "        run_id = identity(run.get('run_id'), f'{label} run_id')",
        "    domain = status.get('domain')",
        "    cell_count = domain.get('cell_count') if isinstance(domain, dict) else None",
        "    if type(cell_count) is not int or cell_count <= 0:",
        "        raise RuntimeError(f'{label} has no realized domain cells')",
        "    resources = status.get('resources')",
        "    field_catalog_revision = (resources.get('field_catalog_revision')",
        "                             if isinstance(resources, dict) else None)",
        "    if type(field_catalog_revision) is not int or field_catalog_revision <= 0:",
        "        raise RuntimeError(f'{label} has no published field catalog revision')",
        "    return {'session_id': session_id, 'scope_field': scope_field,",
        "            'scope': scope, 'run_id': run_id,",
        "            'cell_count': cell_count,",
        "            'field_catalog_revision': field_catalog_revision}",
        "last_error = None",
        "status = None",
        "before_identity = None",
        "for _ in range(60):",
        "    try:",
        "        status = get_json(status_url)",
        "        before_identity = inspect_status(status, 'pre-export status')",
        "        break",
        "    except urllib.error.HTTPError as error:",
        "        detail = error.read().decode('utf-8', 'replace')[-1000:]",
        "        if error.code != 404:",
        "            raise RuntimeError(f'session status failed ({error.code}): {detail}')",
        "        last_error = detail",
        "        time.sleep(1)",
        "    except (ValueError, TypeError, RuntimeError) as error:",
        "        last_error = str(error)",
        "        time.sleep(1)",
        "else:",
        "    raise RuntimeError(f'session status did not publish a usable run: {last_error}')",
        "scope = before_identity['scope']",
        "body = json.dumps({'profile': 'archive'}).encode('utf-8')",
        "headers = {'Content-Type': 'application/json', 'x-fullmag-session-scope': scope}",
        "request = urllib.request.Request(export_url, data=body, method='POST', headers=headers)",
        "last_error = None",
        "for _ in range(60):",
        "    try:",
        "        with urllib.request.urlopen(request, timeout=60) as response:",
        "            payload = json.load(response)",
        "        break",
        "    except urllib.error.HTTPError as error:",
        "        detail = error.read().decode('utf-8', 'replace')[-1000:]",
        "        if error.code != 404:",
        "            raise RuntimeError(f'archive export failed ({error.code}): {detail}')",
        "        last_error = detail",
        "        time.sleep(1)",
        "else:",
        "    raise RuntimeError(f'archive export did not observe a live session: {last_error}')",
        "try:",
        "    after_status = get_json(status_url)",
        "    after_identity = inspect_status(after_status, 'post-export status')",
        "except urllib.error.HTTPError as error:",
        "    detail = error.read().decode('utf-8', 'replace')[-1000:]",
        "    raise RuntimeError(f'post-export session status failed ({error.code}): {detail}')",
        "for key in ('session_id', 'scope_field', 'scope'):",
        "    if before_identity[key] != after_identity[key]:",
        "        raise RuntimeError(f'session scope identity changed across export ({key})')",
        "if (before_identity.get('run_id') is not None and",
        "        after_identity.get('run_id') is not None and",
        "        before_identity['run_id'] != after_identity['run_id']):",
        "    raise RuntimeError('run identity changed across export')",
        "encoded = payload.get('fms_base64') if isinstance(payload, dict) else None",
        "if not isinstance(encoded, str) or not encoded:",
        "    raise RuntimeError('archive export did not return fms_base64')",
        "try:",
        "    raw = base64.b64decode(encoded, validate=True)",
        "    with zipfile.ZipFile(io.BytesIO(raw)) as archive:",
        "        if archive.testzip() is not None:",
        "            raise RuntimeError('archive export contains a corrupt member')",
        "        names = set(archive.namelist())",
        "except (ValueError, zipfile.BadZipFile) as error:",
        "    raise RuntimeError(f'archive export is not a valid .fms archive: {error}')",
        "required = {'manifest/session.json', 'manifest/workspace.json',",
        "            'manifest/export_profile.json', 'project/main.py',",
        "            'project/ui_state.json', 'project/current_live_snapshot.json'}",
        "if not required.issubset(names):",
        "    raise RuntimeError('archive export is missing an API export manifest or live project document')",
        "if not any(name.startswith('runs/') and '/artifacts/' in name for name in names):",
        "    raise RuntimeError('archive export contains no captured run artifacts')",
        f"target = {target!r}",
        "def atomic_write(path, data, prefix):",
        "    fd, temporary = tempfile.mkstemp(prefix=prefix, dir=os.path.dirname(path))",
        "    try:",
        "        with os.fdopen(fd, 'wb') as handle:",
        "            handle.write(data)",
        "            handle.flush()",
        "            os.fsync(handle.fileno())",
        "        os.replace(temporary, path)",
        "    except BaseException:",
        "        try:",
        "            os.unlink(temporary)",
        "        except FileNotFoundError:",
        "            pass",
        "        raise",
        "atomic_write(target, raw, '.fms-export-')",
        f"receipt_target = {receipt_target!r}",
        "receipt = json.dumps({'schema': 'fullmag.live-export-receipt.v1',",
        "                     'solver_exit_code': 0,",
        "                     'before_status': status,",
        "                     'after_status': after_status},",
        "                    separators=(',', ':')).encode('utf-8')",
        "atomic_write(receipt_target, receipt, '.fms-status-')",
        "print(json.dumps({'archive_path': target, 'size_bytes': len(raw), 'entry_count': len(names)}))",
        "PY",
    ]


def _validate_shifted_ksp_trial_request(pilot, requested_type, nearest_frequency, spectral_target, *, dense_oracle=False):
    if requested_type is None:
        return
    if requested_type not in SHIFTED_KSP_TYPE_CHOICES or not pilot.startswith("de-smoke-"):
        raise managed.BenchmarkError("shifted KSP type diagnostic requires DE-SMOKE and gmres/fgmres")
    modal_target, _ = _modal_selection(pilot, nearest_frequency, spectral_target)
    if dense_oracle:
        raise managed.BenchmarkError("shifted KSP type diagnostic requires a native pilot")
    if modal_target == "nearest":
        sampling = PILOTS.get(pilot, (None, None))[1]
        wavevectors = SAMPLING.get(sampling, ())
        if len(wavevectors) != 1 or wavevectors[0] == 0.0:
            raise managed.BenchmarkError(
                "nearest shifted KSP trial requires exactly one nonzero DE/BV sample")


def _validate_krylov_trials(case_dir, sampling, requested_type, requested_rtol,
                            eps_prefilter, gmres_restart, *,
                            spectral_target="frequency_window", target_frequency_hz=None):
    """Run the separate K0 query and nonzero Floquet residual receipt gates."""
    wavevectors = SAMPLING.get(sampling, ())
    if spectral_target not in ("frequency_window", "nearest"):
        raise managed.BenchmarkError("shifted KSP trial spectral target is unsupported")
    if spectral_target == "nearest" and (len(wavevectors) != 1 or wavevectors[0] == 0.0):
        raise managed.BenchmarkError("nearest shifted KSP trial requires one nonzero sample")
    if gmres_restart is not None and gmres_restart not in GMRES_RESTART_CHOICES:
        raise managed.BenchmarkError("shifted KSP trial restart request is unsupported")
    artifacts = {}
    if any(value == 0.0 for value in wavevectors):
        artifacts["gamma_krylov_trial"] = validate_gamma_krylov_trial(
            case_dir,
            sampling,
            requested_type,
            requested_rtol,
            eps_prefilter=eps_prefilter,
            gmres_restart=gmres_restart,
        )
    if any(value != 0.0 for value in wavevectors):
        selection = (
            {"spectral_target": "nearest", "target_frequency_hz": target_frequency_hz,
             "gmres_restart": int(gmres_restart) if gmres_restart is not None else None}
            if spectral_target == "nearest" else {}
        )
        artifacts["shifted_ksp_trial"] = validate_shifted_ksp_trial(
            case_dir, sampling, requested_type, requested_rtol, **selection
        )
    return artifacts


def compose_command(context, output, timeout_seconds=managed.DEFAULT_TIMEOUT_SECONDS, *, pilot="de100", external_model=False, dense_oracle=False, solver_rtol=None, eps_prefilter=None, shifted_ksp_rtol=None, gmres_restart=None, mesh_level=None, thickness_layers=None, nearest_target_frequency_ghz=None, spectral_target=None, frequency_min_ghz=None, frequency_max_ghz=None, ui_web_root=None, ui_host_port=UI_API_PORT, capture_session=False, probe_input_dir=None, probe_manifest_sha256=None, parallel_mode=None, schur_action_diagnostic=False, shifted_ksp_type=None, air_growth_rate=None):
    model = pilot_model(pilot)
    parallel_probe = _is_parallel_probe(pilot)
    signed_fifteen = pilot == SIGNED_FIFTEEN_PILOT
    _validate_air_growth_rate_request(
        pilot, air_growth_rate, external_model=external_model, parallel_mode=parallel_mode
    )
    if signed_fifteen:
        if not external_model or parallel_mode not in {"serial", "adaptive"}:
            raise managed.BenchmarkError("signed-fifteen requires a versioned model and explicit serial/adaptive policy")
        if probe_input_dir is not None or probe_manifest_sha256 is not None:
            raise managed.BenchmarkError("signed-fifteen cannot use probe input artifacts")
    _validate_shifted_ksp_trial_request(pilot, shifted_ksp_type,
                                      nearest_target_frequency_ghz, spectral_target,
                                      dense_oracle=dense_oracle)
    if schur_action_diagnostic and (pilot == "de100" or parallel_probe):
        raise managed.BenchmarkError(
            "Schur action diagnostic is restricted to non-parallel DE-SMOKE pilots")
    if parallel_probe:
        if not external_model or probe_input_dir is None or probe_manifest_sha256 is None:
            raise managed.BenchmarkError(
                "parallel probe requires the pinned standalone model and input manifest")
        if parallel_mode not in {"serial", "adaptive"}:
            raise managed.BenchmarkError("parallel probe mode must be serial or adaptive")
        try:
            canonical_probe_root = _parallel_probe_root(
                context.layout, Path(probe_input_dir).parent)
        except (AttributeError, KeyError, TypeError, ValueError, managed.BenchmarkError) as error:
            raise managed.BenchmarkError(
                "parallel probe input must come from the pinned managed campaign directory") from error
        if os.path.normcase(os.path.abspath(str(Path(probe_input_dir)))) != os.path.normcase(
                os.path.abspath(str(canonical_probe_root / "input"))):
            raise managed.BenchmarkError(
                "parallel probe input directory must be the pinned campaign input directory")
        if ui_web_root is not None or capture_session:
            raise managed.BenchmarkError("parallel probe is headless and cannot start the UI")
        spectral_target = spectral_target or "frequency_window"
        frequency_min_ghz = frequency_min_ghz or format(
            PARALLEL_PROBE_FREQUENCY_WINDOW_HZ[0] / 1e9, ".17g")
        frequency_max_ghz = frequency_max_ghz or format(
            PARALLEL_PROBE_FREQUENCY_WINDOW_HZ[1] / 1e9, ".17g")
        mesh_level = mesh_level or "L2"
        thickness_layers = thickness_layers or "3"
        eps_prefilter = eps_prefilter or "1e-9"
        shifted_ksp_rtol = shifted_ksp_rtol or "1e-9"
        gmres_restart = gmres_restart or "8"
        if mesh_level != "L2" or thickness_layers != "3":
            raise managed.BenchmarkError("parallel probe mesh is pinned to L2 with three thickness layers")
        if eps_prefilter != "1e-9" or shifted_ksp_rtol != "1e-9" or gmres_restart != "8":
            raise managed.BenchmarkError("parallel probe solver diagnostics are pinned to EPS=1e-9, KSP=1e-9, restart=8")
        if (not isinstance(probe_manifest_sha256, str) or len(probe_manifest_sha256) != 64
                or any(character not in "0123456789abcdef" for character in probe_manifest_sha256)):
            raise managed.BenchmarkError("parallel probe manifest hash is invalid")
    elif not signed_fifteen and any(value is not None for value in (probe_input_dir, probe_manifest_sha256, parallel_mode)):
        raise managed.BenchmarkError("parallel probe inputs are restricted to de-smoke-parallel-probe")
    modal_target, target_frequency_hz = _modal_selection(
        pilot, nearest_target_frequency_ghz, spectral_target)
    frequency_window = _frequency_window_bounds(
        pilot, modal_target, frequency_min_ghz, frequency_max_ghz
    )
    if thickness_layers is not None and (
            not pilot.startswith("de-smoke-") or thickness_layers not in THICKNESS_LAYERS_CHOICES):
        raise managed.BenchmarkError("thickness layers require a supported DE-SMOKE value")
    if mesh_level is not None and (not pilot.startswith("de-smoke-") or mesh_level not in MESH_LEVEL_CHOICES):
        raise managed.BenchmarkError("mesh level requires a supported DE-SMOKE level")
    if external_model and pilot == "de100":
        raise managed.BenchmarkError("standalone input is supported only for DE-SMOKE")
    if dense_oracle and pilot != "de-smoke-k2":
        raise managed.BenchmarkError("dense oracle diagnostic is restricted to DE-SMOKE k2")
    if solver_rtol is not None and pilot != "de-smoke-k2":
        raise managed.BenchmarkError("solver rtol sweep is restricted to DE-SMOKE k2")
    if solver_rtol is not None and solver_rtol not in SOLVER_RTOL_CHOICES:
        raise managed.BenchmarkError("solver rtol sweep value is unsupported")
    if (eps_prefilter is not None or shifted_ksp_rtol is not None) and not pilot.startswith("de-smoke-"):
        raise managed.BenchmarkError("diagnostic EPS/KSP options are restricted to DE-SMOKE pilots")
    if gmres_restart is not None and not pilot.startswith("de-smoke-"):
        raise managed.BenchmarkError("diagnostic GMRES restart is restricted to DE-SMOKE pilots")
    if eps_prefilter is not None and eps_prefilter not in EPS_PREFILTER_CHOICES:
        raise managed.BenchmarkError("EPS prefilter value is unsupported")
    if shifted_ksp_rtol is not None and shifted_ksp_rtol not in SHIFTED_KSP_RTOL_CHOICES:
        raise managed.BenchmarkError("shifted KSP rtol value is unsupported")
    if gmres_restart is not None and gmres_restart not in GMRES_RESTART_CHOICES:
        raise managed.BenchmarkError("GMRES restart value is unsupported")
    command = managed._compose_command(context, output, ("c1",), timeout_seconds=timeout_seconds)
    if parallel_probe or signed_fifteen:
        override_path = Path(output) / "compose.benchmark.override.yaml"
        try:
            override = override_path.read_text(encoding="utf-8")
        except OSError as error:
            raise managed.BenchmarkError("parallel probe Compose override is missing") from error
        expected_override = (
            "services:\n"
            "  fem-modal-cpu:\n"
            "    network_mode: none\n"
            "    volumes: !reset []\n"
        )
        if override != expected_override:
            raise managed.BenchmarkError("parallel probe Compose override was not generated by the managed route")
        override_path.write_text(
            expected_override
            + "    cpus: 4.0\n"
            + "    mem_limit: 8g\n",
            encoding="utf-8",
            newline="\n",
        )
    if external_model:
        command[command.index("run")+1:command.index("run")+1] = [
            "-v", f"{output / 'model-input.py'}:/workspace/benchmark-model.py:ro"]
    if parallel_probe:
        input_source = os.path.abspath(str(Path(probe_input_dir)))
        command[command.index("run")+1:command.index("run")+1] = [
            "-v", f"{input_source}:/workspace/benchmark-input:ro"]
    ui_enabled = ui_web_root is not None
    if ui_enabled and capture_session:
        raise managed.BenchmarkError("--with-ui and --capture-session are mutually exclusive")
    live_api_enabled = ui_enabled or capture_session
    if live_api_enabled:
        _enable_ui_compose(
            command, output, ui_web_root, ui_host_port,
            capture_session=capture_session,
        )
    shell = [
        "set -euo pipefail",
        "cd /workspace/capsule",
        "runtime_bin=/workspace/.fullmag/local/bin/fullmag-bin",
        ("source_script=/workspace/benchmark-model.py" if external_model
         else "source_script=/workspace/capsule/" + model),
        *(["export FULLMAG_GMSH_THREADS=1",
            "export FULLMAG_DE_SMOKE_SAMPLING=" + PILOTS[pilot][1]] if PILOTS[pilot][1] else []),
        *(["export FULLMAG_DE_SMOKE_MODAL_TARGET=" + modal_target]
          if PILOTS[pilot][1] else []),
        *(["export FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ="
           + format(target_frequency_hz / 1.0e9, ".17g")]
          if modal_target == "nearest" else []),
        *(["export FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ="
           + format(frequency_window["min_ghz"], ".17g"),
            "export FULLMAG_DE_SMOKE_FREQUENCY_MAX_GHZ="
           + format(frequency_window["max_ghz"], ".17g")]
          if frequency_window is not None else []),
        *(["export FULLMAG_FLOQUET_DENSE_ORACLE=1"] if dense_oracle else []),
        *(["export FULLMAG_DE_SMOKE_SOLVER_RTOL=" + solver_rtol] if solver_rtol else []),
        *(["export FULLMAG_MODAL_EPS_PREFILTER_ABS=" + eps_prefilter,
           "export FULLMAG_FLOQUET_EPS_PREFILTER_ABS=" + eps_prefilter] if eps_prefilter else []),
        *(["export FULLMAG_MODAL_SHIFTED_KSP_RTOL=" + shifted_ksp_rtol,
           "export FULLMAG_FLOQUET_SHIFTED_KSP_RTOL=" + shifted_ksp_rtol] if shifted_ksp_rtol else []),
        *(["export FULLMAG_MODAL_SHIFTED_KSP_TYPE=" + shifted_ksp_type,
           "export FULLMAG_FLOQUET_SHIFTED_KSP_TYPE=" + shifted_ksp_type] if shifted_ksp_type else []),
        *(["export FULLMAG_MODAL_GMRES_RESTART=" + gmres_restart,
           "export FULLMAG_FLOQUET_GMRES_RESTART=" + gmres_restart] if gmres_restart else []),
        *(["export FULLMAG_FLOQUET_SCHUR_ACTION_DIAGNOSTIC=1"]
           if schur_action_diagnostic else []),
        *(["export FULLMAG_DE_SMOKE_MESH_LEVEL=" + mesh_level] if mesh_level else []),
        *(["export FULLMAG_DE_SMOKE_AIR_GROWTH_RATE=" + air_growth_rate]
          if air_growth_rate is not None else []),
        *(["export FULLMAG_DE_SMOKE_THICKNESS_LAYERS=" + thickness_layers] if thickness_layers else []),
        *(["export FULLMAG_DE_SMOKE_PARALLEL_MODE=" + parallel_mode,
           "export FULLMAG_CPU_THREADS=1",
           "export OMP_NUM_THREADS=1",
           "export RAYON_NUM_THREADS=1"] if signed_fifteen else []),
        *(["export FULLMAG_PROBE_PARALLEL_MODE=" + parallel_mode,
           "export FULLMAG_PROBE_INPUT_MANIFEST_SHA256=" + probe_manifest_sha256,
           "export FULLMAG_PROBE_MAX_CPU_PERCENT=90",
           "export FULLMAG_PROBE_MAX_MEMORY_PERCENT=80",
           "export FULLMAG_PROBE_MEMORY_RESERVE_BYTES=1073741824",
           "export FULLMAG_PROBE_MAX_WORKERS=2",
           "export FULLMAG_PROBE_THREADS_PER_WORKER=1",
           "export FULLMAG_PROBE_REQUIRED_CPU_CORES=" + str(PARALLEL_PROBE_REQUIRED_CPU_CORES),
           "export FULLMAG_PROBE_REQUIRED_MEMORY_BYTES=" + str(PARALLEL_PROBE_REQUIRED_MEMORY_BYTES),
           "export FULLMAG_PROBE_REQUIRE_RESOURCE_ALLOCATION=1",
           "export FULLMAG_CPU_THREADS=1",
           "export OMP_NUM_THREADS=1",
           "export RAYON_NUM_THREADS=1",
           "probe_input_dir=/workspace/benchmark-input",
           'probe_manifest="$probe_input_dir/input-manifest.json"',
           'test -r "$probe_manifest"',
           'actual_manifest_sha="$(sha256sum "$probe_manifest")"',
           'test "${actual_manifest_sha%% *}" = "$FULLMAG_PROBE_INPUT_MANIFEST_SHA256"',
           'test -r "$probe_input_dir/equilibrium_artifact.v7.json"',
           'test -r "$probe_input_dir/linearization_state.v6.json"',
           "python3 - <<'PY'",
           "import os",
           "from pathlib import Path",
           "def read(path):",
           "    try: return Path(path).read_text(encoding='utf-8').strip()",
           "    except OSError: return ''",
           "cpu_max = read('/sys/fs/cgroup/cpu.max').split()",
           "if len(cpu_max) != 2: raise SystemExit('parallel probe requires cgroup v2 cpu.max')",
           "affinity_cpu = len(os.sched_getaffinity(0))",
           "if affinity_cpu < int(os.environ['FULLMAG_PROBE_REQUIRED_CPU_CORES']): raise SystemExit('parallel probe CPU affinity is below four cores')",
           "if cpu_max[0] == 'max': effective_cpu = affinity_cpu",
           "else:",
           "    try: effective_cpu = int(float(cpu_max[0]) / float(cpu_max[1]))",
           "    except (ValueError, ZeroDivisionError): raise SystemExit('invalid cgroup v2 cpu.max')",
           "if effective_cpu < int(os.environ['FULLMAG_PROBE_REQUIRED_CPU_CORES']): raise SystemExit('parallel probe CPU allocation is below four cores')",
           "memory_max = read('/sys/fs/cgroup/memory.max')",
           "if not memory_max or memory_max == 'max': raise SystemExit('parallel probe requires finite cgroup memory.max')",
           "try: memory_bytes = int(memory_max)",
           "except ValueError: raise SystemExit('invalid cgroup v2 memory.max')",
           "if memory_bytes < int(os.environ['FULLMAG_PROBE_REQUIRED_MEMORY_BYTES']): raise SystemExit('parallel probe memory allocation is below 8 GiB')",
           "PY"] if parallel_probe else []),
        'test -x "$runtime_bin"',
        'test -f "$source_script"',
        "case_dir=/workspace/benchmark-output/" + pilot,
        'mkdir "$case_dir"',
    ]
    if live_api_enabled:
        shell.extend([
            f"workspace_root={UI_WORKSPACE_ROOT}",
            'test ! -L "$workspace_root"',
            'mkdir -p "$workspace_root"',
            'for path in /workspace/capsule/* /workspace/capsule/.[!.]*; do',
            '  [ -e "$path" ] || continue',
            '  name="$(basename "$path")"',
            '  [ "$name" != ".fullmag" ] || exit 2',
            '  [ "$name" != ".git" ] || exit 2',
            '  ln -s "$path" "$workspace_root/$name"',
            'done',
            'mkdir -p "$workspace_root/.fullmag" "$workspace_root/.home"',
            'export FULLMAG_REPO_ROOT="$workspace_root"',
            'export FULLMAG_STATE_ROOT="$workspace_root/.fullmag"',
            'export HOME="$workspace_root/.home"',
            'export USERPROFILE="$HOME"',
            'unset FULLMAG_FEATURE_FLAGS_FILE || true',
            'export FULLMAG_SKIP_CONTROL_ROOM=1',
            f"export FULLMAG_API_PORT={UI_API_PORT}",
            *( [f"export FULLMAG_WEB_STATIC_DIR={UI_WEB_ROOT}"] if ui_enabled else [] ),
            "export FULLMAG_DISABLE_PREVIEW_3D=0",
            "export FULLMAG_DISABLE_CHARTS=0",
            "api_bin=/workspace/.fullmag/local/bin/fullmag-api",
            'test -x "$api_bin"',
            'mkdir -p "$FULLMAG_STATE_ROOT"',
            '"$api_bin" >"/workspace/benchmark-output/fullmag-api.log" 2>&1 &',
            "api_pid=$!",
            "cleanup_api() { kill \"$api_pid\" 2>/dev/null || true; wait \"$api_pid\" 2>/dev/null || true; }",
            "trap cleanup_api EXIT",
            'python3 - "$api_pid" <<\'PY\'',
            "import os",
            "import sys",
            "import time",
            "import urllib.request",
            "pid = int(sys.argv[1])",
            "last_error = None",
            "for _ in range(90):",
            "    try:",
            "        os.kill(pid, 0)",
            "        for endpoint in ('healthz', 'v2/platform/openapi.json'):",
            "            with urllib.request.urlopen(f'http://127.0.0.1:8081/{endpoint}', timeout=2) as response:",
            "                if response.status != 200:",
            "                    raise RuntimeError(f'{endpoint} returned {response.status}')",
            "        break",
            "    except Exception as error:",
            "        last_error = error",
            "        time.sleep(1)",
            "else:",
            "    raise SystemExit(f'fullmag-api did not become ready: {last_error}')",
            "PY",
        ])
    solver_command = (
        '"$runtime_bin" "$source_script" --backend fem --mode strict --precision double '
        + ("--headless " if not ui_enabled else "")
        + '--json --output-dir "$case_dir" >"$case_dir/runtime.log" 2>&1'
    )
    shell.append(solver_command)
    if live_api_enabled:
        shell.extend(_ui_archive_shell(pilot))
    command[-1] = "\n".join(shell)
    return command


def validate_smoke_potential_fields(case_dir, expected_sample_count):
    """Check every published mode's potential gradient, without qualifying T4."""
    vectors = sorted(case_dir.glob("eigen/mode_fields/sample_*/mode_*/vector.bin"))
    if not vectors:
        raise managed.BenchmarkError("DE-SMOKE has no published mode fields")
    if isinstance(expected_sample_count, bool) or not isinstance(expected_sample_count, int) or expected_sample_count <= 0:
        raise managed.BenchmarkError("DE-SMOKE has no expected samples")
    samples = set()
    for vector in vectors:
        match = re.fullmatch(r"sample_([0-9]{4})", vector.parent.parent.name)
        if match is None:
            raise managed.BenchmarkError("DE-SMOKE mode field has invalid sample directory")
        samples.add(int(match.group(1)))
    if samples != set(range(expected_sample_count)):
        raise managed.BenchmarkError(
            f"DE-SMOKE mode fields cover samples {sorted(samples)}, expected {expected_sample_count}")
    published_modes = set()
    for mode_metadata in case_dir.glob("eigen/modes/sample_*/mode_*.json"):
        if (re.fullmatch(r"sample_[0-9]{4}", mode_metadata.parent.name) is None
                or re.fullmatch(r"mode_[0-9]{4}\.json", mode_metadata.name) is None):
            raise managed.BenchmarkError("DE-SMOKE published mode has invalid identity path")
        managed._regular_file(mode_metadata, "DE-SMOKE published mode metadata")
        published_modes.add((mode_metadata.parent.name, mode_metadata.stem))
    field_modes = set()
    for vector in vectors:
        if re.fullmatch(r"mode_[0-9]{4}", vector.parent.name) is None:
            raise managed.BenchmarkError("DE-SMOKE mode field has invalid mode directory")
        field_modes.add((vector.parent.parent.name, vector.parent.name))
    if published_modes != field_modes:
        raise managed.BenchmarkError(
            "DE-SMOKE published mode identities do not match mode field identities: "
            f"missing fields {sorted(published_modes - field_modes)}, "
            f"unpublished fields {sorted(field_modes - published_modes)}")
    metadata = case_dir / "metadata.json"
    managed._regular_file(metadata, "DE-SMOKE mesh metadata")
    reports = []
    for vector in vectors:
        manifest = vector.parent / "physical_potential.v1.json"
        managed._regular_file(manifest, "DE-SMOKE mode potential manifest")
        mode_metadata = case_dir / "eigen/modes" / vector.parent.parent.name / (vector.parent.name + ".json")
        managed._regular_file(mode_metadata, "DE-SMOKE published mode metadata")
        report = validate_physical_potential(manifest, metadata, mode_metadata_path=mode_metadata, verify_source_mesh=True)
        if report.get("source_mesh_binding", {}).get("status") != "consistent":
            raise managed.BenchmarkError("DE-SMOKE potential has no recomputed source mesh binding")
        if report.get("identity_binding", {}).get("status") != "consistent":
            raise managed.BenchmarkError("DE-SMOKE potential has no verified declared mode binding")
        if report.get("status") != "consistent" or report.get("reconstruction_agreement") is not True:
            raise managed.BenchmarkError(
                f"DE-SMOKE potential gradient mismatch: {manifest.relative_to(case_dir)}")
        reports.append({"manifest": manifest.relative_to(case_dir).as_posix(), **report})
    return {"qualification": "NOT VERIFIED", "scope": "stored_field_reconstruction_and_mode_and_source_mesh_binding",
            "mode_count": len(reports), "modes": reports}


def validate_schur_action_diagnostic(case_dir):
    """Preserve and structurally validate the opt-in Schur action observation.

    The native probe is diagnostic evidence only.  Missing, unavailable, or
    failed observations are exported as such and never turn the pilot into a
    failed solve or a physical certificate.
    """

    relative_path = "eigen/diagnostics/solver.v1.json"
    report = {
        "schema": "fullmag.floquet-schur-action-diagnostic-report.v1",
        "qualification": "NOT VERIFIED",
        "physical_certificate": False,
        "source": relative_path,
        "native": None,
    }
    try:
        payload = json.loads(
            (Path(case_dir) / relative_path).read_text(encoding="utf-8")
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        try:
            payload, evidence = read_failed_schur_action(case_dir)
            report.update(evidence)
        except (OSError, ValueError, UnicodeError, RecursionError):
            return {
                **report,
                "status": "unavailable",
                "validation_status": "unavailable",
                "reason": "native_solver_diagnostics_missing_or_invalid",
            }
    if not isinstance(payload, dict):
        return {
            **report,
            "status": "failed",
            "validation_status": "failed",
            "reason": "native_solver_diagnostics_are_not_an_object",
        }
    if "floquet_schur_action_diagnostic" in payload:
        return _validate_schur_action_payload(payload, report)
    # Successful native exports retain observations in each indexed EPS window.
    # Do not collapse them into the last window or infer missing measurements.
    records = payload.get("sample_solver_diagnostics")
    if not isinstance(records, list) or not records:
        return _validate_schur_action_payload(payload, report)
    if payload.get("schema_version") not in (
        "solver.v1", "frequency_domain_modal_solver_diagnostics.v1"
    ):
        return {**report, "status": "failed", "validation_status": "failed",
                "reason": "unsupported_schur_solver_schema"}
    observations = []
    seen_samples = set()
    for record in records:
        if not isinstance(record, dict):
            return {**report, "status": "failed", "validation_status": "failed",
                    "reason": "invalid_schur_sample_record"}
        sample_index = record.get("sample_index")
        sample = record.get("diagnostics")
        if (type(sample_index) is not int or sample_index < 0
                or sample_index in seen_samples or not isinstance(sample, dict)):
            return {**report, "status": "failed", "validation_status": "failed",
                    "reason": "invalid_schur_sample_identity"}
        seen_samples.add(sample_index)
        vector = sample.get("k_vector_rad_m")
        try:
            valid_vector = (
                type(sample.get("k_vector_len")) is int and sample["k_vector_len"] == 3
                and isinstance(vector, list) and len(vector) == 3
                and all(type(value) in (int, float) and math.isfinite(value)
                        for value in vector)
            )
        except (OverflowError, ValueError):
            valid_vector = False
        if not valid_vector:
            return {**report, "status": "failed", "validation_status": "failed",
                    "reason": "invalid_schur_sample_wavevector"}
        # Gamma uses its own solver and does not execute this Floquet probe.
        if vector == [0.0, 0.0, 0.0]:
            continue
        windows = sample.get("subwindows")
        if not isinstance(windows, list) or not windows:
            return {**report, "status": "unavailable", "validation_status": "unavailable",
                    "reason": "schur_sample_windows_missing"}
        for position, window in enumerate(windows):
            if (not isinstance(window, dict) or type(window.get("index")) is not int
                    or window["index"] != position):
                return {**report, "status": "failed", "validation_status": "failed",
                        "reason": "invalid_schur_window_identity"}
            observation = _validate_schur_action_payload(window, report)
            observations.append({**observation, "sample_index": sample_index,
                                 "window_index": position})
    if not observations:
        return {**report, "status": "unavailable", "validation_status": "unavailable",
                "reason": "no_nonzero_k_schur_windows"}
    if any(item["validation_status"] == "failed" or item["status"] == "failed"
           for item in observations):
        status, validation_status = "failed", "failed"
    elif any(item["status"] == "unavailable" for item in observations):
        status, validation_status = "unavailable", "unavailable"
    elif all(item["status"] == "measured" and item["validation_status"] == "pass"
             for item in observations):
        status, validation_status = "measured", "pass"
    else:
        status, validation_status = "failed", "failed"
    return {**report, "status": status, "validation_status": validation_status,
            "reason": "indexed_native_subwindow_observations",
            "observation_count": len(observations), "observations": observations}


def _validate_schur_action_payload(payload, report):
    """Validate one preserved observation without promoting it to a certificate."""
    native = payload.get("floquet_schur_action_diagnostic")
    if native is None:
        return {
            **report,
            "status": "unavailable",
            "validation_status": "unavailable",
            "reason": "floquet_schur_action_diagnostic_was_not_exported",
        }
    if not isinstance(native, dict):
        return {
            **report,
            "status": "failed",
            "validation_status": "failed",
            "reason": "floquet_schur_action_diagnostic_is_not_an_object",
            "native": native,
        }

    native_status = native.get("status")
    status = native_status if native_status in SCHUR_ACTION_DIAGNOSTIC_STATUSES else "failed"
    errors = []
    if native.get("schema_version") != "floquet_schur_action_diagnostic.v1":
        errors.append("schema_version")
    if native_status not in SCHUR_ACTION_DIAGNOSTIC_STATUSES:
        errors.append("status")

    def require_bool(name, expected=None):
        value = native.get(name)
        if type(value) is not bool or (expected is not None and value is not expected):
            errors.append(name)

    if native_status == "measured":
        require_bool("available", True)
        require_bool("pre_eps_only", True)
        require_bool("dense_materialization", False)
        if native.get("measurement_phase") != "before_eps_solve":
            errors.append("measurement_phase")
        if native.get("workspace_scope") != "isolated_clone_of_production_context":
            errors.append("workspace_scope")
        for name in ("q_complex_dof_count", "real_split_dimension"):
            value = native.get(name)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                errors.append(name)
        phase_sign = native.get("context_phase_sign")
        if isinstance(phase_sign, bool) or phase_sign not in (-1, 1):
            errors.append("context_phase_sign")
        action_count = native.get("action_count")
        if (isinstance(action_count, bool) or not isinstance(action_count, int)
                or action_count != 9):
            errors.append("action_count")
        if native.get("expected_action_count") != 9:
            errors.append("expected_action_count")
        nonzero_count = native.get("nonzero_signal_count")
        action_limit = action_count if isinstance(action_count, int) and not isinstance(action_count, bool) else -1
        if (isinstance(nonzero_count, bool) or not isinstance(nonzero_count, int)
                or nonzero_count <= 0 or nonzero_count > action_limit):
            errors.append("nonzero_signal_count")
        for name in SCHUR_ACTION_DIAGNOSTIC_DEFECT_FIELDS:
            value = native.get(name)
            if (isinstance(value, bool) or not isinstance(value, (int, float))
                    or not math.isfinite(value) or value < 0.0):
                errors.append(name)
        for name in ("operator_normalization_scale", "preconditioner_normalization_scale"):
            value = native.get(name)
            if (isinstance(value, bool) or not isinstance(value, (int, float))
                    or not math.isfinite(value) or value <= 0.0):
                errors.append(name)
    elif native_status in {"failed", "unavailable"}:
        # Preserve the native failure state and reason.  Metrics are optional
        # on these paths because the native probe may stop before allocation.
        action_count = native.get("action_count")
        if (action_count is not None and
                (isinstance(action_count, bool) or not isinstance(action_count, int)
                 or not 0 <= action_count <= 9)):
            errors.append("action_count")

    if errors:
        validation_status = "failed"
    elif native_status == "measured":
        validation_status = "pass"
    else:
        validation_status = "preserved"
    return {
        **report,
        "status": status,
        "validation_status": validation_status,
        "reason": native.get("reason") if isinstance(native.get("reason"), str)
        else ("invalid_native_diagnostic_fields" if errors else ""),
        "validation_errors": errors,
        "native": native,
    }


def validate_selected_only_metadata(case_dir, expected_target_frequency_hz, expected_sampling=None):
    """Validate authoring and native scope of a one-point nearest-mode pilot.

    Metadata proves the request, while ``solver.v1.json`` proves that the
    native provider preserved the selected-only contract.  Neither promotes
    the artifact to a complete window or dispersion result.
    """
    try:
        metadata = json.loads((case_dir / "metadata.json").read_text(encoding="utf-8"))
        model = metadata["problem_meta"]["runtime_metadata"]["de_smoke"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise managed.BenchmarkError(
            "selected-only DE-SMOKE metadata is missing or malformed"
        ) from error
    if not isinstance(model, dict) or model.get("schema") != "fullmag.de-smoke.v1":
        raise managed.BenchmarkError("selected-only DE-SMOKE metadata has an unsupported schema")
    if model.get("modal_target") != "nearest":
        raise managed.BenchmarkError("selected-only DE-SMOKE metadata does not declare nearest target")
    if model.get("selection_scope") != "selected_only":
        raise managed.BenchmarkError("selected-only DE-SMOKE metadata has the wrong selection scope")
    if model.get("window_complete") is not False:
        raise managed.BenchmarkError("selected-only DE-SMOKE metadata must declare window_complete=false")
    target_frequency_hz = model.get("target_frequency_hz")
    if (isinstance(target_frequency_hz, bool) or
            not isinstance(target_frequency_hz, (int, float)) or
            not math.isfinite(target_frequency_hz) or target_frequency_hz <= 0.0 or
            not math.isclose(target_frequency_hz, expected_target_frequency_hz,
                             rel_tol=1e-12, abs_tol=0.0)):
        raise managed.BenchmarkError("selected-only DE-SMOKE target frequency disagrees with the request")
    sampling = model.get("sampling")
    if not isinstance(sampling, str) or sampling not in {
            f"{prefix}k{k}" for prefix in ("", "bv-") for k in range(-25, 26)}:
        raise managed.BenchmarkError("selected-only DE-SMOKE metadata does not identify one single-k sample")
    if expected_sampling is not None and sampling != expected_sampling:
        raise managed.BenchmarkError("selected-only DE-SMOKE sampling disagrees with the request")
    requested_mode_count = model.get("requested_mode_count")
    if isinstance(requested_mode_count, bool) or requested_mode_count != 1:
        raise managed.BenchmarkError("selected-only DE-SMOKE metadata requests more than one mode")
    vectors = model.get("k_vectors_rad_per_m")
    if not isinstance(vectors, list) or len(vectors) != 1:
        raise managed.BenchmarkError("selected-only DE-SMOKE metadata contains more than one k vector")
    try:
        native = validate_selected_only_diagnostics(
            case_dir / "eigen/diagnostics/solver.v1.json", expected_target_frequency_hz)
    except (OSError, ValueError) as error:
        raise managed.BenchmarkError(
            "selected-only DE-SMOKE native diagnostics are missing or inconsistent"
        ) from error
    return {
        "schema": "fullmag.de-smoke-selected-only-preflight.v1",
        "status": "pass",
        "qualification": "NOT VERIFIED",
        "selection_scope": "selected_only",
        "window_complete": False,
        "target_frequency_hz": float(target_frequency_hz),
        "sampling": sampling,
        "mode_count": 1,
        "native_diagnostics": native,
        "pending": ["full frequency-window coverage", "dispersion comparison and convergence"],
    }


def validate_mesh_level_metadata(case_dir, requested):
    """Verify authoring resolution; actual mesh convergence remains separate."""
    try:
        metadata = json.loads((case_dir / "metadata.json").read_text(encoding="utf-8"))
        runtime = metadata["problem_meta"]["runtime_metadata"]
        model = runtime["de_smoke"]
        requested_size = MESH_LEVEL_ELEMENT_SIZES_M[requested]
        meshes = runtime["mesh_workflow"]["per_geometry"]
        matches = (model.get("mesh_level") == requested and
                   model.get("magnetic_element_size_m") == requested_size and
                   isinstance(meshes, list) and len(meshes) == 1 and
                   meshes[0].get("hmax") == requested_size)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise managed.BenchmarkError("missing or malformed magnetic mesh metadata") from error
    if not matches:
        raise managed.BenchmarkError("model ignored or changed the requested magnetic mesh level")
    return {"requested_level": requested, "resolved_level": model["mesh_level"],
            "requested_element_size_m": requested_size,
            "scope": "requested_magnetic_interface_mesh_settings",
            "qualification": "NOT VERIFIED"}


def validate_air_growth_rate_metadata(case_dir, requested):
    """Bind the requested air growth rate to declared and resolved metadata."""
    if type(requested) is not str or requested not in AIR_GROWTH_RATE_CHOICES:
        raise managed.BenchmarkError("unsupported air growth rate")
    expected = float(requested)
    try:
        metadata = json.loads((case_dir / "metadata.json").read_text(encoding="utf-8"))
        runtime = metadata["problem_meta"]["runtime_metadata"]
        model_value = runtime["de_smoke"]["air_growth_rate"]
        study_value = runtime["study_universe"]["airbox_growth_rate"]
        domain_value = runtime["domain_frame"]["declared_universe"]["airbox_growth_rate"]
        resolved = metadata["mesh"]["mesh_build_report"]["effective_airbox_target"]["growth_rate"]
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise managed.BenchmarkError(
            "missing or malformed declared or resolved air growth metadata"
        ) from error
    values = (
        ("problem_meta.runtime_metadata.de_smoke.air_growth_rate", model_value),
        ("problem_meta.runtime_metadata.study_universe.airbox_growth_rate", study_value),
        ("problem_meta.runtime_metadata.domain_frame.declared_universe.airbox_growth_rate", domain_value),
        ("mesh.mesh_build_report.effective_airbox_target.growth_rate", resolved),
    )
    for label, value in values:
        if type(value) not in (int, float) or not math.isfinite(value) or value != expected:
            raise managed.BenchmarkError(
                f"model ignored or changed air growth rate at {label}: "
                f"requested {requested}, received {value!r}"
            )
    return {
        "requested": requested,
        "declared_model_input": model_value,
        "declared_study_universe": study_value,
        "declared_domain_frame": domain_value,
        "resolved": resolved,
        "resolved_metadata_path": "mesh.mesh_build_report.effective_airbox_target.growth_rate",
        "qualification": "NOT VERIFIED",
    }


def _dry_run_output_dir(layout, job_id, pilot, model_identity):
    """Keep versioned standalone-input previews in full-SHA namespaces."""
    preview_name = pilot + "-preview"
    if model_identity and model_identity.get("kind") == "versioned_standalone_input":
        digest = model_identity.get("sha256")
        if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            raise managed.BenchmarkError("standalone preview requires a lowercase model SHA256")
        preview_name = f"{pilot}-preview-{digest}"
    return Path(layout["storage_root"]) / "runs" / layout["worktree_id"] / job_id / preview_name



def validate_thickness_layers_metadata(case, requested):
    """Reject a model that ignored an explicit through-thickness request."""
    if requested not in THICKNESS_LAYERS_CHOICES:
        raise managed.BenchmarkError("unsupported thickness layers")
    try:
        metadata = json.loads((case / "metadata.json").read_text(encoding="utf-8"))
        runtime = metadata["problem_meta"]["runtime_metadata"]
        declared = runtime["de_smoke"]["through_thickness_elements"]
        geometries = runtime["mesh_workflow"]["per_geometry"]
        actual = geometries[0]["through_thickness_elements"] if len(geometries) == 1 else None
        matches = (type(declared) is int and type(actual) is int
                   and declared == actual == int(requested))
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise managed.BenchmarkError("missing or malformed thickness mesh metadata") from error
    if not matches:
        raise managed.BenchmarkError("model ignored or changed the requested thickness layers")
    thickness = runtime["de_smoke"].get("film_thickness_m")
    if type(thickness) not in (int, float) or not math.isfinite(thickness) or thickness <= 0:
        raise managed.BenchmarkError("missing physical film thickness")
    nodes, elements = _extract_mesh(metadata)
    tolerance = thickness * 1e-6
    slab = [tuple(nodes[i][2] for i in cell) for cell in elements
            if all(abs(nodes[i][2]) <= thickness / 2 + tolerance for i in cell)]
    if not slab:
        raise managed.BenchmarkError("no realized magnetic-film tetrahedra")
    low = min(min(z) for z in slab)
    high = max(max(z) for z in slab)
    maximum_span = max(max(z) - min(z) for z in slab)
    if (abs(high - low - thickness) > tolerance or maximum_span <= 0
            or maximum_span > thickness / int(requested) + tolerance):
        raise managed.BenchmarkError(
            "realized tetra mesh does not meet requested thickness resolution: "
            f"max vertical span {maximum_span:g} m, target {thickness / int(requested):g} m")
    return {"requested_layers": int(requested), "declared_layers": actual,
            "maximum_vertical_element_span_m": maximum_span,
            "maximum_requested_vertical_span_m": thickness / int(requested),
            "thickness_resolution_verified": True,
            "scope": "uniform-film tetra vertical-span bound; not an exact extrusion layer count",
            "qualification": "NOT VERIFIED"}


def _modal_krylov_environment(command):
    """Record requested exports; native queries independently prove resolution."""
    allowed = {
        "FULLMAG_MODAL_EPS_PREFILTER_ABS": EPS_PREFILTER_CHOICES,
        "FULLMAG_MODAL_SHIFTED_KSP_RTOL": SHIFTED_KSP_RTOL_CHOICES,
        "FULLMAG_MODAL_SHIFTED_KSP_TYPE": SHIFTED_KSP_TYPE_CHOICES,
        "FULLMAG_MODAL_GMRES_RESTART": GMRES_RESTART_CHOICES,
    }
    values = {}
    for line in command[-1].splitlines():
        if not line.startswith("export FULLMAG_MODAL_"):
            continue
        name, separator, value = line[len("export "):].partition("=")
        if (not separator or name not in allowed or value not in allowed[name]
                or (name in values and values[name] != value)):
            raise managed.BenchmarkError("invalid common modal tuning export")
        values[name] = value
    return values


def execute(context, output, command, model_sha, timeout_seconds=managed.DEFAULT_TIMEOUT_SECONDS, *, pilot="de100", model_identity=None, dense_oracle=False, solver_rtol=None, eps_prefilter=None, shifted_ksp_rtol=None, gmres_restart=None, mesh_level=None, thickness_layers=None, nearest_target_frequency_ghz=None, spectral_target=None, frequency_min_ghz=None, frequency_max_ghz=None, ui_enabled=False, capture_session=False, ui_frontend=None, ui_web_root=None, ui_host_port=UI_API_PORT, parallel_mode=None, probe_input_dir=None, schur_action_diagnostic=False, shifted_ksp_type=None, air_growth_rate=None):
    _validate_air_growth_rate_request(
        pilot, air_growth_rate, external_model=model_identity is not None,
        parallel_mode=parallel_mode,
    )
    if air_growth_rate is not None:
        try:
            growth_exports = [
                line for line in command[-1].splitlines()
                if line.startswith("export FULLMAG_DE_SMOKE_AIR_GROWTH_RATE=")
            ]
        except (IndexError, AttributeError, TypeError):
            growth_exports = []
        if growth_exports != [f"export FULLMAG_DE_SMOKE_AIR_GROWTH_RATE={air_growth_rate}"]:
            raise managed.BenchmarkError(
                "air growth rate request does not match the actual dispatch environment"
            )
    _validate_shifted_ksp_trial_request(pilot, shifted_ksp_type,
                                      nearest_target_frequency_ghz, spectral_target,
                                      dense_oracle=dense_oracle)
    if schur_action_diagnostic and (pilot == "de100" or _is_parallel_probe(pilot)):
        raise managed.BenchmarkError(
            "Schur action diagnostic is restricted to non-parallel DE-SMOKE pilots")
    model = pilot_model(pilot)
    modal_target, target_frequency_hz = _modal_selection(
        pilot, nearest_target_frequency_ghz, spectral_target)
    frequency_window = _frequency_window_bounds(
        pilot, modal_target, frequency_min_ghz, frequency_max_ghz
    )
    schema_name = "de100-pilot" if pilot == "de100" else "de-smoke"
    request = managed._run_request(context, output, (), command, timeout_seconds=timeout_seconds)
    request.update(schema=f"fullmag.{schema_name}.request.v1", operation=pilot + "-numerical-pilot",
                   public_model=model, cases=[pilot], sampling=PILOTS[pilot][1], model_sha256=model_sha,
                   orchestrator_sha256=managed._sha256_file(Path(__file__).resolve()))
    request["dense_oracle_diagnostic_requested"] = dense_oracle
    request["solver_rtol_sweep_requested"] = solver_rtol
    request["modal_krylov_tuning_environment_requested"] = _modal_krylov_environment(command)
    request["eps_prefilter_diagnostic_requested"] = eps_prefilter
    request["shifted_ksp_rtol_diagnostic_requested"] = shifted_ksp_rtol
    request["shifted_ksp_type_diagnostic_requested"] = shifted_ksp_type
    request["gmres_restart_diagnostic_requested"] = gmres_restart
    request["schur_action_diagnostic_requested"] = bool(schur_action_diagnostic)
    if air_growth_rate is not None:
        request["air_growth_rate_requested"] = air_growth_rate
    request["mesh_level_requested"] = mesh_level
    request["thickness_layers_requested"] = thickness_layers
    request["modal_target"] = modal_target
    request["spectral_target"] = modal_target
    request["target_frequency_hz"] = target_frequency_hz
    request["selection_scope"] = "selected_only" if modal_target == "nearest" else "frequency_window"
    request["window_complete"] = False if modal_target == "nearest" else None
    request["frequency_window_override_ghz"] = (
        {"min": frequency_window["min_ghz"], "max": frequency_window["max_ghz"]}
        if frequency_window is not None else None
    )
    if _is_parallel_probe(pilot):
        if parallel_mode not in {"serial", "adaptive"} or not isinstance(model_identity, dict):
            raise managed.BenchmarkError("parallel probe execution is missing its pinned policy identity")
        request["parallel_probe"] = {
            "schema": "fullmag.parallel-probe-request.v1",
            "mode": parallel_mode,
            "model_source_commit": model_identity.get("source_commit"),
            "model_sha256": model_identity.get("sha256"),
            "policy": dict(PARALLEL_PROBE_POLICY),
            "required_cpu_cores": PARALLEL_PROBE_REQUIRED_CPU_CORES,
            "required_memory_bytes": PARALLEL_PROBE_REQUIRED_MEMORY_BYTES,
            "input_manifest_sha256": model_identity.get("manifest_sha256"),
            "equilibrium_artifact_sha256": model_identity.get("equilibrium_artifact_sha256"),
            "equilibrium_artifact_content_sha256": model_identity.get("equilibrium_artifact_content_sha256"),
            "equilibrium_artifact_role": model_identity.get("equilibrium_artifact_role"),
            "linearization_state_sha256": model_identity.get("linearization_state_sha256"),
            "linearization_state_content_sha256": model_identity.get("linearization_state_content_sha256"),
            "linearization_state_role": model_identity.get("linearization_state_role"),
        }
    if pilot == SIGNED_FIFTEEN_PILOT:
        request["parallel_campaign"] = signed_fifteen_campaign_identity(model_identity, parallel_mode)
    request["source"]["public_model_files"] = [*managed.PUBLIC_MODEL_FILES] if model_identity else [model, *managed.PUBLIC_MODEL_FILES]
    if ui_enabled and capture_session:
        raise managed.BenchmarkError("--with-ui and --capture-session are mutually exclusive")
    live_api_enabled = bool(ui_enabled or capture_session)
    ui_metadata = {
        "enabled": bool(ui_enabled),
        "session_capture": bool(capture_session),
    }
    if live_api_enabled:
        ui_metadata.update({
            "archive_path": f"{pilot}.fms",
            "archive_profile": "archive",
        })
    if ui_enabled:
        ui_metadata.update({"host_port": ui_host_port, "frontend": ui_frontend})
    request["ui"] = ui_metadata
    if model_identity:
        request["model_source"] = model_identity
    request["scientific_gate"] = {"qualification": "NOT VERIFIED", "reason": "postsolve comparison and convergence required"}
    managed._write_new_json(output / "run-request.json", request)
    result = {"schema": f"fullmag.{schema_name}.result.v1", "pilot": pilot, "status": "failed",
              "qualification": "NOT VERIFIED", "started_at_unix": time.time(),
              "job": request["job"], "source": request["source"], "runtime": request["runtime"],
              "model_sha256": model_sha, "return_code": None, "artifacts": None,
              "container_cleanup": {"status": "not_requested"}, "ui": ui_metadata}
    result["shifted_ksp_type_diagnostic_requested"] = shifted_ksp_type
    result["schur_action_diagnostic_requested"] = bool(schur_action_diagnostic)
    if air_growth_rate is not None:
        result["air_growth_rate_requested"] = air_growth_rate
    if "parallel_probe" in request:
        result["parallel_probe"] = request["parallel_probe"]
    if "parallel_campaign" in request:
        result["parallel_campaign"] = request["parallel_campaign"]
    try:
        if model_identity:
            model_input.verify_model(output, model_identity)
        with (output / "compose.log").open("x", encoding="utf-8") as log:
            completed = subprocess.run(command, cwd=context.layout["repo_root"],
                                       env=managed._compose_environment(
                                           context.layout, context.image_digest
                                       ),
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                       check=False, timeout=math.ceil(timeout_seconds)
                                       + managed.CONTAINER_TIMEOUT_GRACE_SECONDS
                                       + managed.HOST_COMPOSE_GRACE_SECONDS)
        result["return_code"] = completed.returncode
        if completed.returncode == 0:
            # C1 artifact requirements include complex modes and full potential.
            # This reuses the artifact contract only, not C1 scientific parameters.
            artifacts = managed._validate_case_artifacts(output / pilot, "c1")
            artifacts["case"] = pilot
            if air_growth_rate is not None:
                growth_resolution = validate_air_growth_rate_metadata(
                    output / pilot, air_growth_rate
                )
                artifacts["air_growth_rate_resolution"] = growth_resolution
                result["air_growth_rate_resolution"] = growth_resolution
            if PILOTS[pilot][1] is not None:
                row_args = (
                    output / pilot / "eigen/dispersion.csv",
                    PILOTS[pilot][1],
                    output / pilot / "eigen/diagnostics/solver.v1.json",
                    output / pilot / "metadata.json",
                )
                artifacts["row_preflight"] = (
                    validate_rows(*row_args, selection_scope="selected_only")
                    if modal_target == "nearest" else validate_rows(*row_args)
                )
                if shifted_ksp_type is not None:
                    artifacts.update(_validate_krylov_trials(
                        output / pilot,
                        PILOTS[pilot][1],
                        shifted_ksp_type,
                        shifted_ksp_rtol,
                        eps_prefilter,
                        gmres_restart,
                        spectral_target=modal_target,
                        target_frequency_hz=target_frequency_hz,
                    ))
                artifacts["potential_reconstruction"] = validate_smoke_potential_fields(
                    output / pilot, artifacts["row_preflight"]["sample_count"])
                if _is_parallel_probe(pilot):
                    artifacts["parallel_probe_metadata"] = validate_parallel_probe_metadata(
                        output / pilot / "metadata.json",
                        model_sha256=model_sha,
                        parallel_mode=parallel_mode,
                    )
                    artifacts["parallel_probe_solver_artifacts"] = validate_parallel_probe_solver_artifacts(
                        output / pilot,
                        requested_eps_prefilter=eps_prefilter,
                        requested_shifted_ksp_rtol=shifted_ksp_rtol,
                        requested_gmres_restart=gmres_restart,
                        expected_sample_count=len(PARALLEL_PROBE_VECTORS_RAD_PER_M),
                    )
                if modal_target == "nearest":
                    artifacts["selected_only_preflight"] = validate_selected_only_metadata(
                        output / pilot, target_frequency_hz, PILOTS[pilot][1])
            if parallel_mode == "adaptive" and (_is_parallel_probe(pilot) or pilot == SIGNED_FIFTEEN_PILOT):
                policy = {"mode": "adaptive", **PARALLEL_PROBE_POLICY} if _is_parallel_probe(pilot) else {
                    key: request["parallel_campaign"][key] for key in (
                        "mode", "max_cpu_percent", "max_memory_percent", "memory_reserve_bytes",
                        "max_workers", "threads_per_worker")}
                indices = range(len(PARALLEL_PROBE_VECTORS_RAD_PER_M)) if _is_parallel_probe(pilot) else range(1, 15)
                bind_parallel_report(output / pilot, artifacts,
                                     expected_policy=policy, expected_indices=indices)
            if pilot == SIGNED_FIFTEEN_PILOT:
                bind_signed_state_closure(output / pilot, artifacts)
            if mesh_level is not None:
                artifacts["mesh_level_resolution"] = validate_mesh_level_metadata(output / pilot, mesh_level)
            if thickness_layers is not None:
                artifacts["thickness_layers_resolution"] = validate_thickness_layers_metadata(output / pilot, thickness_layers)
            if live_api_enabled:
                receipt_path = output / f"{pilot}.fms.status.json"
                try:
                    status_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                except (OSError, ValueError) as error:
                    raise managed.BenchmarkError(
                        "live API export status receipt is missing or invalid"
                    ) from error
                result["ui"]["archive"] = validate_fms_archive(
                    output / f"{pilot}.fms",
                    status_receipt=status_receipt,
                    case_dir=output / pilot,
                    solver_exit_code=completed.returncode,
                )
            result.update(status="completed_unqualified", artifacts=artifacts)
    except subprocess.TimeoutExpired:
        result["error"] = "host Compose watchdog expired after the container deadline and grace period"
    except KeyboardInterrupt:
        result["error"] = "pilot interrupted by operator"
    except (OSError, ValueError, managed.BenchmarkError) as error:
        result["error"] = str(error)
    finally:
        if model_identity:
            result["model_source"] = model_identity
            try:
                model_input.verify_model(output, model_identity)
            except (OSError, ValueError) as error:
                result.update(status="failed", error=str(error))
        if result["return_code"] != 0:
            try:
                cleanup_mounts = _cleanup_extra_mounts(
                    output,
                    model_identity=model_identity,
                    ui_enabled=ui_enabled,
                    capture_session=capture_session,
                    ui_web_root=ui_web_root,
                    probe_input_dir=probe_input_dir if _is_parallel_probe(pilot) else None,
                )
                if cleanup_mounts:
                    result["container_cleanup"] = managed._cleanup_benchmark_container(
                        context, output, extra_mounts=cleanup_mounts
                    )
                else:
                    result["container_cleanup"] = managed._cleanup_benchmark_container(context, output)
            except (managed.BenchmarkError, OSError, ValueError, TypeError, KeyboardInterrupt) as error:
                result["container_cleanup"] = {"status": "blocked", "reason": str(error)}
        if schur_action_diagnostic:
            artifacts = result.get("artifacts")
            if not isinstance(artifacts, dict):
                artifacts = {}
            artifacts["floquet_schur_action_diagnostic"] = validate_schur_action_diagnostic(
                output / pilot
            )
            result["artifacts"] = artifacts
        result["finished_at_unix"] = time.time()
        managed._write_new_json(output / "run-result.json", result)
    print(json.dumps({"output_dir": str(output), **result}, indent=2))
    return 0 if result["status"] == "completed_unqualified" else 1


def _read_frontend_build_job(layout, job_id):
    if not isinstance(job_id, str) or not managed.JOB_ID_RE.fullmatch(job_id):
        raise managed.BenchmarkError("frontend build job identity is invalid")
    storage = Path(layout["storage_root"])
    database = managed._contained_path(
        storage, "index/runner-jobs.sqlite", "frontend runner database"
    )
    managed._regular_file(database, "frontend runner database")
    try:
        connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            """
            SELECT job_id, owner, worktree_id, source_digest, profile,
                   operation, payload, state, exit_code
            FROM jobs WHERE job_id=?
            """,
            (job_id,),
        ).fetchone()
    except sqlite3.Error as error:
        raise managed.BenchmarkError("cannot read the frontend runner job") from error
    finally:
        try:
            connection.close()
        except UnboundLocalError:
            pass
    if row is None:
        raise managed.BenchmarkError("frontend runner job was not found")
    job = dict(row)
    try:
        job["payload"] = json.loads(job["payload"])
    except (TypeError, ValueError) as error:
        raise managed.BenchmarkError("frontend runner job payload is invalid") from error
    if not isinstance(job["payload"], dict):
        raise managed.BenchmarkError("frontend runner job payload is not an object")
    payload = job["payload"]
    if (
        job.get("profile") != "fem-cpu-release"
        or job.get("operation") != "build"
        or job.get("state") != "succeeded"
        or job.get("exit_code") != 0
        or job.get("worktree_id") != layout["worktree_id"]
        or payload.get("origin_repo") is None
        or not managed._same_path(payload["origin_repo"], layout["repo_root"])
    ):
        raise managed.BenchmarkError("frontend runner job does not satisfy the release preflight")
    capture_id = payload.get("capture_id")
    if not isinstance(capture_id, str) or not managed.CAPTURE_ID_RE.fullmatch(capture_id):
        raise managed.BenchmarkError("frontend source capsule identity is invalid")
    expected_capsule = f"runs/{layout['worktree_id']}/{capture_id}/source"
    if payload.get("capsule_relative") != expected_capsule:
        raise managed.BenchmarkError("frontend source capsule path is not canonical")
    if not isinstance(job.get("source_digest"), str) or not managed.SHA256_RE.fullmatch(
        job["source_digest"]
    ):
        raise managed.BenchmarkError("frontend source digest is invalid")
    return job


def _runtime_capsule_signature(manifest):
    files = manifest.get("files")
    if not isinstance(files, list):
        raise managed.BenchmarkError("source capsule manifest has no file list")
    signature = {}
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise managed.BenchmarkError("source capsule manifest has an invalid file entry")
        path = entry["path"]
        if is_non_runtime_path(path):
            continue
        signature[path] = tuple(
            entry.get(key) for key in ("type", "mode", "size", "sha256", "target")
        )
    return signature


def _exact_openapi_contract_signature(manifest, label):
    files = manifest.get("files")
    if not isinstance(files, list):
        raise managed.BenchmarkError(f"{label} source capsule manifest has no file list")
    entries = {
        entry.get("path"): entry
        for entry in files
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    }
    missing = [path for path in OPENAPI_CONTRACT_PATHS if path not in entries]
    if missing:
        raise managed.BenchmarkError(
            f"{label} source capsule is missing generated OpenAPI contract: {missing[0]}"
        )
    signature = {}
    for path in OPENAPI_CONTRACT_PATHS:
        entry = entries[path]
        if entry.get("type") != "file" or not isinstance(entry.get("sha256"), str):
            raise managed.BenchmarkError(
                f"{label} generated OpenAPI contract entry is invalid: {path}"
            )
        signature[path] = tuple(
            entry.get(key) for key in ("type", "mode", "size", "sha256")
        )
    return signature


def _require_runtime_capsule_compatibility(layout, context, build_root, frontend):
    frontend_identity = frontend.get("native_source_identity")
    if not isinstance(frontend_identity, dict):
        raise managed.BenchmarkError("frontend build has no native source identity")
    if (
        context.native_identity.get("ignored_non_runtime_dirty") is not True
        or frontend_identity.get("ignored_non_runtime_dirty") is not True
    ):
        raise managed.BenchmarkError(
            "frontend/runtime capsule comparison requires ignore_non_runtime_dirty provenance"
        )
    trusted_context = managed._json_file(
        Path(build_root) / "trusted/context.json", "frontend build context"
    )
    if trusted_context.get("native_source_identity") != frontend_identity:
        raise managed.BenchmarkError("frontend trusted context identity mismatch")
    frontend_job = _read_frontend_build_job(layout, frontend["job_id"])
    if frontend_job["source_digest"] != trusted_context.get("source_digest"):
        raise managed.BenchmarkError("frontend build context source digest mismatch")
    payload = frontend_job["payload"]
    storage = Path(layout["storage_root"])
    capsule = managed._contained_path(
        storage, payload["capsule_relative"], "frontend source capsule"
    )
    try:
        manifest = managed.verify_source(capsule, frontend_job["source_digest"])
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise managed.BenchmarkError("frontend source capsule verification failed") from error
    if not isinstance(manifest.get("repo_root"), str) or not managed._same_path(
        manifest["repo_root"], layout["repo_root"]
    ):
        raise managed.BenchmarkError("frontend source capsule origin differs from this worktree")
    if manifest.get("resolved_commit") != frontend_identity.get("head_commit_full"):
        raise managed.BenchmarkError("frontend source capsule commit differs from its build identity")
    runtime_signature = _runtime_capsule_signature(context.manifest)
    frontend_signature = _runtime_capsule_signature(manifest)
    if runtime_signature != frontend_signature:
        differing = sorted(
            set(runtime_signature) ^ set(frontend_signature)
            or {
                path
                for path in set(runtime_signature) & set(frontend_signature)
                if runtime_signature[path] != frontend_signature[path]
            }
        )
        first = differing[0] if differing else "<unknown>"
        raise managed.BenchmarkError(
            "frontend/runtime source capsules differ in runtime inputs: " + first
        )
    runtime_openapi_signature = _exact_openapi_contract_signature(
        context.manifest, "runtime"
    )
    frontend_openapi_signature = _exact_openapi_contract_signature(
        manifest, "frontend"
    )
    if runtime_openapi_signature != frontend_openapi_signature:
        differing = [
            path for path in OPENAPI_CONTRACT_PATHS
            if runtime_openapi_signature[path] != frontend_openapi_signature[path]
        ]
        raise managed.BenchmarkError(
            "frontend/runtime generated OpenAPI contracts differ: " + differing[0]
        )
    return {
        "status": "compatible",
        "comparison": "verified_capsule_runtime_entries",
        "runtime_source_digest": context.manifest.get("source_digest"),
        "frontend_source_digest": frontend_job["source_digest"],
        "ignored_non_runtime_paths": True,
        "openapi_contract_paths": list(OPENAPI_CONTRACT_PATHS),
    }


def _prepare_ui_web(layout, context, build_root, output):
    build_root = Path(build_root).expanduser()
    if not build_root.is_absolute():
        build_root = Path(layout["repo_root"]) / build_root
    destination = Path(output) / "ui-web"
    frontend = copy_web(layout, build_root, destination)
    frontend["capsule_compatibility"] = _require_runtime_capsule_compatibility(
        layout, context, build_root, frontend
    )
    return destination, frontend


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--output-dir")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--with-ui", action="store_true",
        help="start the matched API/web bundle and export a durable .fms archive",
    )
    parser.add_argument(
        "--capture-session", action="store_true",
        help="publish the live API in an isolated container and export .fms without a web bundle",
    )
    parser.add_argument(
        "--web-build-root",
        help="attested managed web build root required by --with-ui",
    )
    parser.add_argument(
        "--ui-port", type=int, default=UI_API_PORT,
        help="loopback host port forwarding to the UI API (default: 8081)",
    )
    parser.add_argument("--pilot", choices=tuple(PILOTS), default="de100")
    parser.add_argument("--mesh-level", choices=MESH_LEVEL_CHOICES,
                        help="explicit magnetic/interface mesh level for a standalone DE-SMOKE input")
    parser.add_argument("--thickness-layers", choices=THICKNESS_LAYERS_CHOICES,
                        help="explicit number of elements through the film thickness")
    parser.add_argument("--air-growth-rate", choices=AIR_GROWTH_RATE_CHOICES,
                        help="diagnostic air mesh growth rate for a versioned single-k DE-SMOKE input")
    parser.add_argument("--model-ref", help="full commit of standalone DE-SMOKE input; runtime remains build-bound")
    parser.add_argument(
        "--probe-root",
        help="pinned managed input root for de-smoke-parallel-probe; arbitrary paths are rejected",
    )
    parser.add_argument(
        "--probe-build-source-digest",
        help="exact verified source capsule SHA256; use the same build digest for serial and adaptive",
    )
    parser.add_argument(
        "--parallel-mode",
        choices=("serial", "adaptive"),
        help="explicit execution policy for parallel-probe or signed-fifteen",
    )
    parser.add_argument("--dense-oracle", action="store_true", help="run the bounded diagnostic dense Schur oracle for DE-SMOKE k2")
    parser.add_argument(
        "--schur-action-diagnostic", action="store_true",
        help="run the opt-in action-only Floquet Schur diagnostic for DE-SMOKE",
    )
    parser.add_argument("--solver-rtol", choices=SOLVER_RTOL_CHOICES,
                        help="request a diagnostic DE-SMOKE k2 tolerance; default model uses 1e-8")
    parser.add_argument("--eps-prefilter", choices=EPS_PREFILTER_CHOICES,
                        help="diagnostic EPS absolute true-residual cutoff for DE-SMOKE pilots")
    parser.add_argument("--shifted-ksp-rtol", choices=SHIFTED_KSP_RTOL_CHOICES,
                        help="diagnostic shift-invert KSP rtol for DE-SMOKE pilots")
    parser.add_argument("--shifted-ksp-type", choices=SHIFTED_KSP_TYPE_CHOICES,
                        help="opt-in shifted solver trial; native default remains GMRES")
    parser.add_argument("--gmres-restart", choices=GMRES_RESTART_CHOICES,
                        help="diagnostic shift-invert GMRES restart for DE-SMOKE pilots")
    parser.add_argument(
        "--spectral-target",
        choices=("frequency_window", "nearest"),
        help="explicit modal selection; nearest is limited to a single-k pilot",
    )
    parser.add_argument(
        "--nearest-target-frequency-ghz",
        help="finite positive nearest-mode target for --spectral-target nearest",
    )
    parser.add_argument(
        "--frequency-min-ghz",
        help="finite positive lower bound for a DE-SMOKE frequency-window override",
    )
    parser.add_argument(
        "--frequency-max-ghz",
        help="finite positive upper bound for a DE-SMOKE frequency-window override",
    )
    args = parser.parse_args(argv)
    try:
        _validate_shifted_ksp_trial_request(args.pilot, args.shifted_ksp_type,
                                          args.nearest_target_frequency_ghz, args.spectral_target,
                                          dense_oracle=args.dense_oracle)
        if args.with_ui and args.capture_session:
            raise ValueError("--with-ui and --capture-session are mutually exclusive")
        if args.with_ui and not args.web_build_root:
            raise ValueError("--with-ui requires --web-build-root")
        if args.web_build_root and not args.with_ui:
            raise ValueError("--web-build-root requires --with-ui")
        if (args.with_ui or args.capture_session) and args.dry_run:
            raise ValueError("live API capture cannot be combined with --dry-run")
        parallel_probe = _is_parallel_probe(args.pilot)
        signed_fifteen = args.pilot == SIGNED_FIFTEEN_PILOT
        _validate_air_growth_rate_request(
            args.pilot, args.air_growth_rate, external_model=bool(args.model_ref),
            parallel_mode=args.parallel_mode,
        )
        if signed_fifteen:
            if not args.model_ref or args.parallel_mode not in {"serial", "adaptive"}:
                raise ValueError("signed-fifteen requires --model-ref and --parallel-mode")
            if not args.probe_build_source_digest or not re.fullmatch(r"[0-9a-f]{64}", args.probe_build_source_digest):
                raise ValueError("signed-fifteen requires --probe-build-source-digest SHA256")
            if args.probe_root:
                raise ValueError("signed-fifteen cannot use --probe-root")
        if args.schur_action_diagnostic and (args.pilot == "de100" or parallel_probe):
            raise ValueError(
                "--schur-action-diagnostic is restricted to non-parallel DE-SMOKE pilots"
            )
        if parallel_probe:
            if not args.probe_build_source_digest or not re.fullmatch(
                r"[0-9a-f]{64}", args.probe_build_source_digest
            ):
                raise ValueError("de-smoke-parallel-probe requires --probe-build-source-digest SHA256")
            if args.parallel_mode not in {"serial", "adaptive"}:
                raise ValueError("de-smoke-parallel-probe requires --parallel-mode serial or adaptive")
            if args.model_ref:
                raise ValueError("de-smoke-parallel-probe uses its pinned standalone model input")
            if args.with_ui or args.capture_session:
                raise ValueError("de-smoke-parallel-probe is headless")
            args.spectral_target = args.spectral_target or "frequency_window"
            args.frequency_min_ghz = args.frequency_min_ghz or "10.5"
            args.frequency_max_ghz = args.frequency_max_ghz or "11.5"
            args.mesh_level = args.mesh_level or "L2"
            args.thickness_layers = args.thickness_layers or "3"
            args.eps_prefilter = args.eps_prefilter or "1e-9"
            args.shifted_ksp_rtol = args.shifted_ksp_rtol or "1e-9"
            args.gmres_restart = args.gmres_restart or "8"
        elif not signed_fifteen and (args.probe_root or args.parallel_mode or args.probe_build_source_digest):
            raise ValueError("probe-specific options require de-smoke-parallel-probe")
        if args.with_ui:
            if isinstance(args.ui_port, bool) or not 1 <= args.ui_port <= 65535:
                raise ValueError("--ui-port must be in the range 1-65535")
            if not is_bindable("127.0.0.1", args.ui_port):
                raise ValueError(f"UI host port is not bindable: 127.0.0.1:{args.ui_port}")
        layout = managed.fullmag_storage.resolve_layout(args.repo_root, "windows-native")
        input_data = None
        input_identity = None
        probe_input_dir = None
        if parallel_probe:
            input_data, input_identity, probe_input_dir = _validate_parallel_probe_inputs(
                layout, args.probe_root, args.parallel_mode
            )
        if (args.mesh_level or args.thickness_layers) and not args.model_ref:
            if not parallel_probe:
                raise ValueError("mesh controls require a versioned standalone --model-ref")
        if args.model_ref:
            if args.pilot == "de100":
                raise ValueError("--model-ref requires a DE-SMOKE pilot")
            input_data, input_identity = model_input.load_model(Path(layout["repo_root"]), args.model_ref)
        if args.air_growth_rate is not None:
            _validate_air_growth_rate_model_input(input_data, args.air_growth_rate)
        if not args.dry_run:
            managed.fullmag_storage.initialize(layout)
        if args.dry_run:
            context = managed._validate_build_context(layout, managed._read_job(layout, args.job_id))
            if parallel_probe or signed_fifteen:
                _validate_parallel_probe_build(context, args.probe_build_source_digest)
            model_sha = input_identity["sha256"] if input_identity else validate_model(context, args.pilot)
            modal_target, _ = _modal_selection(
                args.pilot, args.nearest_target_frequency_ghz, args.spectral_target
            )
            _frequency_window_bounds(
                args.pilot, modal_target, args.frequency_min_ghz, args.frequency_max_ghz
            )
            output = _dry_run_output_dir(layout, args.job_id, args.pilot, input_identity)
            output.mkdir(parents=True, exist_ok=True)
            if input_data is not None:
                model_path = output / "model-input.py"
                if not model_path.exists():
                    model_input.stage_model(output, input_data)
                model_input.verify_model(output, input_identity)
            print(json.dumps({"status": "dry_run", "qualification": "NOT VERIFIED",
                              "model_sha256": model_sha, "model_source": input_identity,
                              "air_growth_rate_requested": args.air_growth_rate,
                              "shifted_ksp_type_diagnostic_requested": args.shifted_ksp_type,
                              "schur_action_diagnostic_requested": args.schur_action_diagnostic,
                              "command": compose_command(
                                  context, output, pilot=args.pilot,
                                  external_model=input_identity is not None,
                                  dense_oracle=args.dense_oracle, solver_rtol=args.solver_rtol,
                                  schur_action_diagnostic=args.schur_action_diagnostic,
                                  eps_prefilter=args.eps_prefilter,
                                  shifted_ksp_rtol=args.shifted_ksp_rtol,
                                  shifted_ksp_type=args.shifted_ksp_type,
                                  gmres_restart=args.gmres_restart, mesh_level=args.mesh_level,
                                  thickness_layers=args.thickness_layers,
                                  nearest_target_frequency_ghz=args.nearest_target_frequency_ghz,
                                  spectral_target=args.spectral_target,
                                  frequency_min_ghz=args.frequency_min_ghz,
                                  frequency_max_ghz=args.frequency_max_ghz,
                                  probe_input_dir=probe_input_dir,
                                  probe_manifest_sha256=(input_identity or {}).get("manifest_sha256"),
                                  parallel_mode=args.parallel_mode,
                                  air_growth_rate=args.air_growth_rate,
                              )}, indent=2))
            return 0
        with managed.runtime_package_use(layout), managed.fullmag_storage.build_lock(layout):
            context = managed._validate_build_context(layout, managed._read_job(layout, args.job_id))
            if parallel_probe or signed_fifteen:
                _validate_parallel_probe_build(context, args.probe_build_source_digest)
            model_sha = input_identity["sha256"] if input_identity else validate_model(context, args.pilot)
            managed._inspect_image(context.image_digest)
            output = managed._new_output_dir(context, args.output_dir)
            output.mkdir(parents=True, exist_ok=False)
            if input_data is not None:
                model_input.stage_model(output, input_data)
            ui_web_root = None
            ui_frontend = None
            if args.with_ui:
                ui_web_root, ui_frontend = _prepare_ui_web(
                    layout, context, args.web_build_root, output
                )
            command = compose_command(
                context, output, pilot=args.pilot,
                external_model=input_identity is not None,
                dense_oracle=args.dense_oracle, solver_rtol=args.solver_rtol,
                schur_action_diagnostic=args.schur_action_diagnostic,
                eps_prefilter=args.eps_prefilter,
                shifted_ksp_rtol=args.shifted_ksp_rtol,
                shifted_ksp_type=args.shifted_ksp_type,
                gmres_restart=args.gmres_restart, mesh_level=args.mesh_level,
                thickness_layers=args.thickness_layers,
                nearest_target_frequency_ghz=args.nearest_target_frequency_ghz,
                spectral_target=args.spectral_target,
                frequency_min_ghz=args.frequency_min_ghz,
                frequency_max_ghz=args.frequency_max_ghz,
                probe_input_dir=probe_input_dir,
                probe_manifest_sha256=(input_identity or {}).get("manifest_sha256"),
                parallel_mode=args.parallel_mode,
                air_growth_rate=args.air_growth_rate,
                ui_web_root=ui_web_root, ui_host_port=args.ui_port,
                capture_session=args.capture_session,
            )
            execute_kwargs = dict(
                pilot=args.pilot, model_identity=input_identity,
                dense_oracle=args.dense_oracle, solver_rtol=args.solver_rtol,
                schur_action_diagnostic=args.schur_action_diagnostic,
                eps_prefilter=args.eps_prefilter, shifted_ksp_rtol=args.shifted_ksp_rtol,
                shifted_ksp_type=args.shifted_ksp_type,
                gmres_restart=args.gmres_restart, mesh_level=args.mesh_level,
                thickness_layers=args.thickness_layers,
                nearest_target_frequency_ghz=args.nearest_target_frequency_ghz,
                spectral_target=args.spectral_target,
                frequency_min_ghz=args.frequency_min_ghz,
                frequency_max_ghz=args.frequency_max_ghz,
                parallel_mode=args.parallel_mode,
                ui_enabled=args.with_ui, capture_session=args.capture_session,
                ui_frontend=ui_frontend, ui_web_root=ui_web_root,
                ui_host_port=args.ui_port,
                probe_input_dir=probe_input_dir,
                air_growth_rate=args.air_growth_rate,
            )
            return execute(context, output, command, model_sha, **execute_kwargs)
    except (managed.BenchmarkError, managed.fullmag_storage.StorageError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError, SyntaxError) as error:
        print(f"de100-pilot: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
