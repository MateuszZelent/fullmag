#!/usr/bin/env python3
"""Stage an explicit CPU/GPU FEM open-airbox k=0 comparison campaign.

This script only prepares inputs, immutable per-case scripts, descriptors, and a
run matrix. It does not invoke the managed runtime, compile code, or start a
simulation. Execute the generated run-managed-dev.sh with the exact Compose
project and optional case ID to run its published headless FEM CLI.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any


SCHEMA = "fullmag.fem.open_airbox_k0_convergence.v1"
CASE_SCHEMA = "fullmag.fem.open_airbox_k0.case.v1"
CONTAINER_OUTPUT_ROOT = PurePosixPath("/opt/fullmag/script-output")
MESH_NAME = "py_sphere_200nm_5mt_solver_input_mesh.json"
EQUILIBRIUM_NAME = "py_sphere_200nm_5mt_fem_gpu_equilibrium.zarr"
EQUILIBRIUM_ARTIFACT_NAME = "equilibrium_artifact.v7.json"
EQUILIBRIUM_ARTIFACT_FILE_SHA256 = "ecc2cafcf6425c66421080e39471d43e359562805384d5e57590b0fe871ca943"
EQUILIBRIUM_ARTIFACT_CONTENT_SHA256 = "sha256:6d20bae54da4a245806354fa835b2fd9239aee0035a99cd4df123e5122038139"
CPU_REFERENCE_NAME = "py_sphere_200nm_5mt_fem_cpu_eigenmodes_reciprocal.zarr"
MESH_SHA256 = "d181307812e2eea1781680136727d63f1923743345188aa9901672efd5295dfa"
MAGNETIZATION_SHA256 = "231c0626f51a370dca3e975a335bc5107460ed6d8bf7593fa11a0caeb82bb638"
TOPOLOGY_SHA256 = "sha256:c0524978b1a1a84b63a7959b1b08e69d43c94a2a1be5c6036c1f2596629d7de0"
MU0_T_M_PER_A = 4.0e-7 * math.pi
GYROMAGNETIC_RATIO_M_PER_A_S = 221_100.0
EQUILIBRIUM_STEP = 8006
REFERENCE_VERIFICATION_NAME = "verification.json"
REFERENCE_SCRIPT_NAME = "py_sphere_200nm_5mt_fem_cpu_eigenmodes_reciprocal.py"

KITTEL_TEMPLATE = Path("examples/fem_eigen_k0_open_airbox_sphere_matrix_case.py")
CHECKPOINT_TEMPLATE = Path("examples/fem_eigen_k0_open_airbox_checkpoint_repeat_case.py")


class PreparationError(ValueError):
    pass


def fail(message: str) -> None:
    raise PreparationError(message)


def canonical_json(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def canonical_sha256(value: object) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tree_identity(root: Path) -> dict[str, Any]:
    if not root.is_dir():
        fail(f"required directory does not exist: {root}")
    digest = hashlib.sha256()
    file_count = 0
    total_bytes = 0
    paths = sorted(root.rglob("*"), key=lambda path: path.relative_to(root).as_posix())
    for path in paths:
        if path.is_symlink():
            fail(f"input tree contains a symlink: {path}")
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        content_sha = sha256_file(path)
        size = path.stat().st_size
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(content_sha.encode("ascii"))
        digest.update(b"\0")
        file_count += 1
        total_bytes += size
    if file_count == 0:
        fail(f"input tree is empty: {root}")
    return {
        "tree_sha256": digest.hexdigest(),
        "file_count": file_count,
        "total_bytes": total_bytes,
    }


def reference_mesh_mass_metric(reference_zarr: Path) -> dict[str, Any]:
    generation = load_object(
        reference_zarr / "artifacts" / "frequency_domain" / "generation.v2.json",
        "historical CPU generation pointer",
    )
    generation_id = generation.get("generation_id")
    if not isinstance(generation_id, str) or not re.fullmatch(
        r"sha256:[0-9a-f]{64}", generation_id
    ):
        fail("historical CPU generation pointer has an invalid identity")
    generation_root = (
        reference_zarr
        / "artifacts"
        / "frequency_domain"
        / "generations"
        / generation_id.removeprefix("sha256:")
    )
    summary_path = generation_root / "eigen" / "metadata" / "eigen_summary.json"
    summary = load_object(summary_path, "historical CPU eigen summary")
    diagnostics = summary.get("solver_diagnostics")
    if not isinstance(diagnostics, dict):
        fail("historical CPU eigen summary has no solver diagnostics")
    topology = diagnostics.get("source_mesh_topology_sha256")
    if topology != TOPOLOGY_SHA256:
        fail("historical CPU mass weights are not bound to the exact checkpoint topology")
    raw_weights = summary.get("node_mass_weights")
    if not isinstance(raw_weights, list) or not raw_weights:
        fail("historical CPU eigen summary has no node mass weights")
    weights: list[float] = []
    for index, value in enumerate(raw_weights):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            fail(f"historical CPU node mass weight {index} is not numeric")
        weight = float(value)
        if not math.isfinite(weight) or weight <= 0.0:
            fail(f"historical CPU node mass weight {index} is not positive and finite")
        weights.append(weight)
    q_dof_count = diagnostics.get("q_dof_count")
    if isinstance(q_dof_count, bool) or not isinstance(q_dof_count, int):
        fail("historical CPU solver diagnostics lack q_dof_count")
    if q_dof_count != 2 * len(weights):
        fail("historical CPU node mass weights do not match its two-block q dimension")
    return {
        "schema": "fullmag.fem.open_airbox_k0.mesh_mass_weights.v1",
        "source_zarr_path": str(reference_zarr),
        "generation_id": generation_id,
        "summary_sha256": sha256_file(summary_path),
        "input_mesh_sha256": MESH_SHA256,
        "mesh_topology_sha256": topology,
        "active_magnetic_node_count": len(weights),
        "q_dof_count": q_dof_count,
        "node_mass_weights_sha256": canonical_sha256(weights),
        "node_mass_weights": weights,
    }


def load_object(path: Path, description: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"missing {description}: {path}")
    except json.JSONDecodeError as error:
        fail(f"invalid JSON in {description} {path}: {error}")
    if not isinstance(value, dict):
        fail(f"{description} must be a JSON object: {path}")
    return value


def within(path: Path, root: Path, description: str) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        fail(f"{description} must be inside {root}: {path}")
    return resolved


def validate_checkpoint_source(source_root: Path) -> dict[str, Any]:
    mesh_path = source_root / MESH_NAME
    equilibrium_path = source_root / EQUILIBRIUM_NAME
    verification_path = source_root / REFERENCE_VERIFICATION_NAME
    reference_script_path = source_root / REFERENCE_SCRIPT_NAME
    reference_zarr_path = source_root / CPU_REFERENCE_NAME

    if not mesh_path.is_file():
        fail(f"missing exact input mesh: {mesh_path}")
    mesh_sha = sha256_file(mesh_path)
    if mesh_sha != MESH_SHA256:
        fail(f"input mesh SHA-256 differs: got {mesh_sha}, expected {MESH_SHA256}")
    if not reference_script_path.is_file():
        fail(f"missing historical CPU reference script: {reference_script_path}")
    if not reference_zarr_path.is_dir():
        fail(f"missing historical CPU reference Zarr: {reference_zarr_path}")

    verification = load_object(verification_path, "historical CPU verification")
    if verification.get("equilibrium_step") != EQUILIBRIUM_STEP:
        fail("historical CPU reference is not the step-8006 repeat")
    if verification.get("device") != "cpu":
        fail("historical CPU reference does not identify CPU execution")
    if verification.get("input_mesh_sha256") != MESH_SHA256:
        fail("historical CPU reference has a different input mesh")
    if verification.get("equilibrium_sha256") != MAGNETIZATION_SHA256:
        fail("historical CPU reference has a different equilibrium field")
    if verification.get("native_mesh_topology_sha256") != TOPOLOGY_SHA256:
        fail("historical CPU reference has a different mesh topology")
    if verification.get("certification", {}).get("full_residual_certified") is not True:
        fail("historical CPU reference lacks a full residual certificate")
    if verification.get("spectrum_completeness") != "selected_only":
        fail("historical CPU reference scope is not explicitly selected_only")
    if sha256_file(reference_script_path) != verification.get("source_script_sha256"):
        fail("historical CPU reference script hash differs from its verification")

    try:
        attrs = json.loads((equilibrium_path / ".zattrs").read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"missing step-8006 Zarr attributes: {equilibrium_path / '.zattrs'}")
    except json.JSONDecodeError as error:
        fail(f"invalid step-8006 Zarr attributes: {error}")
    if not isinstance(attrs, dict):
        fail("step-8006 Zarr attributes must be a JSON object")
    if attrs.get("sequence_step") != EQUILIBRIUM_STEP:
        fail("input equilibrium is not from sequence step 8006")
    if attrs.get("input_mesh_sha256") != MESH_SHA256:
        fail("input equilibrium references a different input mesh")
    if attrs.get("magnetization_f64le_sha256") != MAGNETIZATION_SHA256:
        fail("input equilibrium magnetization hash differs")
    if attrs.get("equilibrium_certified") is not True:
        fail("input equilibrium is not certified")
    if attrs.get("completion", {}).get("converged") is not True:
        fail("input equilibrium is not converged")
    if attrs.get("linearization_certificate", {}).get("status") != "matched":
        fail("input equilibrium linearization certificate is not matched")
    if attrs.get("linearization_certificate", {}).get(
        "mesh_topology_sha256"
    ) != TOPOLOGY_SHA256:
        fail("input equilibrium topology differs")

    reference_metric = reference_mesh_mass_metric(reference_zarr_path)
    equilibrium_artifact_path = (
        reference_zarr_path / "artifacts" / "frequency_domain" / "generations"
        / reference_metric["generation_id"].removeprefix("sha256:")
        / "eigen" / "metadata" / EQUILIBRIUM_ARTIFACT_NAME
    )
    if not equilibrium_artifact_path.is_file() or sha256_file(equilibrium_artifact_path) != EQUILIBRIUM_ARTIFACT_FILE_SHA256:
        fail("certified checkpoint artifact differs from the archived step-8006 identity")
    return {
        "mesh_path": mesh_path,
        "equilibrium_path": equilibrium_path,
        "equilibrium_artifact_path": equilibrium_artifact_path,
        "reference_cpu_zarr_path": reference_zarr_path,
        "reference_mesh_mass_metric": reference_metric,
        "reference_verification_path": verification_path,
        "reference_script_path": reference_script_path,
        "verification": verification,
        "equilibrium_attrs": attrs,
        "equilibrium_tree": tree_identity(equilibrium_path),
    }


def _kittel_input_identity(magnetic_hmax_nm: float, box_factor: float) -> dict[str, Any]:
    gamma_hz_per_t = GYROMAGNETIC_RATIO_M_PER_A_S / (
        2.0 * math.pi * MU0_T_M_PER_A
    )
    bias_t = 0.1
    expected_frequency_hz = gamma_hz_per_t * bias_t
    return {
        "case_kind": "open_airbox_k0_kittel_sphere",
        "geometry": {
            "kind": "sphere",
            "radius_m": 20e-9,
            "box_factor_of_diameter": box_factor,
            "magnetic_hmax_m": magnetic_hmax_nm * 1e-9,
            "air_hmax_m": 25e-9,
            "mesh_order": 1,
            "growth_rate": 1.5,
        },
        "material": {
            "saturation_magnetisation_A_per_m": 800e3,
            "exchange_stiffness_J_per_m": 13e-12,
            "alpha": 0.0,
        },
        "gyromagnetic_ratio_m_per_a_s": GYROMAGNETIC_RATIO_M_PER_A_S,
        "initial_magnetisation": [1.0, 0.0, 0.0],
        "applied_induction_T": [bias_t, 0.0, 0.0],
        "physics": {
            "exchange": True,
            "demag_realization": "poisson_robin",
            "magnetostatic_bc": "open_airbox_k0",
            "wavevector_rad_per_m": [0.0, 0.0, 0.0],
            "operator": "full_2x2",
            "normalization": "unit_l2",
            "precision": "double",
            "mode": "strict",
            "eigenmode_target": {
                "kind": "nearest",
                "target_frequency_hz": expected_frequency_hz,
                "requested_mode_count": 1,
                "damping_policy": "ignore",
            },
            "relaxation": {
                "algorithm": "projected_gradient_bb",
                "max_steps": 20_000,
                "tolT_A_per_m": 1e-6,
            },
        },
        "analytic_reference": {
            "kind": "uniform_sphere_kittel",
            "gyromagnetic_ratio_m_per_a_s": GYROMAGNETIC_RATIO_M_PER_A_S,
            "mu0_T_m_per_A": MU0_T_M_PER_A,
            "conversion": "gamma0 / (2*pi*mu0) in Hz/T",
            "gamma_hz_per_t": gamma_hz_per_t,
            "bias_T": bias_t,
            "expected_frequency_hz": expected_frequency_hz,
        },
    }


def _case_id_for_kittel(h_nm: float, box_factor: float, device: str) -> str:
    h = f"{h_nm:g}".replace(".", "p")
    return f"kittel_h{h}_box{box_factor:g}_{device}"


def build_run_definitions(checkpoint: dict[str, Any]) -> list[dict[str, Any]]:
    kittel_geometry = [
        (4.0, 8.0),
        (3.0, 8.0),
        (2.5, 8.0),
        (4.0, 6.0),
        (4.0, 10.0),
    ]
    definitions: list[dict[str, Any]] = []
    for h_nm, box_factor in kittel_geometry:
        pair_id = f"kittel_h{h_nm:g}_box{box_factor:g}".replace(".", "p")
        for device in ("cpu", "gpu"):
            case_id = _case_id_for_kittel(h_nm, box_factor, device)
            if h_nm == 4.0 and box_factor == 8.0 and device == "gpu":
                case_id += "_smoke"
            definitions.append(
                {
                    "case_id": case_id,
                    "pair_id": pair_id,
                    "family": "kittel_sphere",
                    "template_kind": "kittel_sphere",
                    "execution_device": device,
                    "is_smoke": h_nm == 4.0 and box_factor == 8.0 and device == "gpu",
                    "analysis_group": (
                        "mesh_refinement"
                        if box_factor == 8.0
                        else "airbox_refinement"
                    ),
                    "magnetic_hmax_nm": h_nm,
                    "box_factor": box_factor,
                    "input_identity": _kittel_input_identity(h_nm, box_factor),
                }
            )

    checkpoint_identity = {
        "case_kind": "open_airbox_k0_step_8006_spectrum",
        "equilibrium_source": "zero_step_native_recertification",
        "equilibrium_recertification_tolerance_t": 1.0e-6,
        "equilibrium_required_accepted_steps": 0,
        "equilibrium_artifact_file_sha256": EQUILIBRIUM_ARTIFACT_FILE_SHA256,
        "equilibrium_artifact_content_sha256": EQUILIBRIUM_ARTIFACT_CONTENT_SHA256,
        "equilibrium_step": EQUILIBRIUM_STEP,
        "input_mesh_sha256": MESH_SHA256,
        "equilibrium_tree_sha256": checkpoint["equilibrium_tree"]["tree_sha256"],
        "magnetization_f64le_sha256": MAGNETIZATION_SHA256,
        "native_mesh_topology_sha256": TOPOLOGY_SHA256,
        "node_count": 33408,
        "reference_mesh_mass_metric": {
            "node_mass_weights_sha256": checkpoint[
                "reference_mesh_mass_metric"
            ]["node_mass_weights_sha256"],
            "active_magnetic_node_count": checkpoint[
                "reference_mesh_mass_metric"
            ]["active_magnetic_node_count"],
            "q_dof_count": checkpoint["reference_mesh_mass_metric"]["q_dof_count"],
        },
        "material": {
            "saturation_magnetisation_A_per_m": 800e3,
            "exchange_stiffness_J_per_m": 13e-12,
            "alpha": 1.0,
        },
        "gyromagnetic_ratio_m_per_a_s": GYROMAGNETIC_RATIO_M_PER_A_S,
        "field_T": [5.0e-3, 0.0, 0.0],
        "physics": {
            "magnetostatic_bc": "open_airbox_k0",
            "wavevector_rad_per_m": [0.0, 0.0, 0.0],
            "operator": "full_2x2",
            "precision": "double",
            "mode": "strict",
            "frequency_target": "frequency_window",
            "frequency_window_hz": [1.0, 8.0e9],
            "minimum_positive_modes": 17,
            "requested_mode_count": 17,
        },
    }
    for device in ("cpu", "gpu"):
        definitions.append(
            {
                "case_id": f"checkpoint_step8006_window_{device}",
                "pair_id": "checkpoint_step8006_window",
                "family": "checkpoint_step_8006",
                "template_kind": "checkpoint_step_8006",
                "execution_device": device,
                "is_smoke": False,
                "analysis_group": "checkpoint_repeat",
                "input_identity": checkpoint_identity,
                "checkpoint_identity": {
                    "equilibrium_step": EQUILIBRIUM_STEP,
                    "equilibrium_artifact_file_sha256": EQUILIBRIUM_ARTIFACT_FILE_SHA256,
                    "equilibrium_artifact_content_sha256": EQUILIBRIUM_ARTIFACT_CONTENT_SHA256,
                    "input_mesh_sha256": MESH_SHA256,
                    "magnetization_f64le_sha256": MAGNETIZATION_SHA256,
                    "native_mesh_topology_sha256": TOPOLOGY_SHA256,
                    "node_count": 33408,
                    "equilibrium_tree_sha256": checkpoint["equilibrium_tree"][
                        "tree_sha256"
                    ],
                    "reference_mesh_mass_metric": checkpoint_identity[
                        "reference_mesh_mass_metric"
                    ],
                },
                "frequency_window_hz": [1.0, 8.0e9],
                "minimum_positive_mode_count": 17,
                "requested_mode_count": 17,
            }
        )
    return definitions


def _study_id(case_id: str) -> str:
    return "fem_open_airbox_k0_" + re.sub(r"[^a-zA-Z0-9_]+", "_", case_id)


def stage_case(
    definition: dict[str, Any],
    *,
    template_text: str,
    run_root: Path,
    run_root_repo_relative: Path,
    run_root_container: PurePosixPath,
    checkpoint_container_root: PurePosixPath,
) -> dict[str, Any]:
    case_id = definition["case_id"]
    script_path = run_root / f"{case_id}.py"
    descriptor_path = script_path.with_suffix(".case.json")
    output_path = run_root / f"{case_id}.zarr"
    output_container_path = run_root_container / f"{case_id}.zarr"
    if output_path.exists():
        fail(f"refusing to overwrite staged or produced output: {output_path}")

    input_identity = definition["input_identity"]
    case = {
        "schema": CASE_SCHEMA,
        "case_id": case_id,
        "pair_id": definition["pair_id"],
        "template_kind": definition["template_kind"],
        "study_id": _study_id(case_id),
        "execution_device": definition["execution_device"],
        "input_identity": input_identity,
        "input_identity_sha256": canonical_sha256(input_identity),
        "output_directory_name": output_path.name,
    }
    if definition["family"] == "kittel_sphere":
        case["model"] = {
            "radius_m": 20e-9,
            "magnetic_hmax_m": definition["magnetic_hmax_nm"] * 1e-9,
            "air_hmax_m": 25e-9,
            "box_factor": definition["box_factor"],
            "bias_t": 0.1,
            "gyromagnetic_ratio_m_per_a_s": GYROMAGNETIC_RATIO_M_PER_A_S,
            "saturation_magnetisation_A_per_m": 800e3,
            "exchange_stiffness_J_per_m": 13e-12,
        }
    else:
        case["checkpoint_identity"] = definition["checkpoint_identity"]
        case["mesh_container_path"] = str(
            checkpoint_container_root / MESH_NAME
        )
        case["equilibrium_container_path"] = str(
            checkpoint_container_root / EQUILIBRIUM_NAME
        )
        case["equilibrium_artifact_container_path"] = str(
            checkpoint_container_root / EQUILIBRIUM_ARTIFACT_NAME
        )
        case["frequency_window_hz"] = definition["frequency_window_hz"]
        case["minimum_positive_mode_count"] = definition[
            "minimum_positive_mode_count"
        ]
        case["requested_mode_count"] = definition["requested_mode_count"]

    script_path.write_text(template_text, encoding="utf-8")
    script_hash = sha256_file(script_path)
    case["script_sha256"] = script_hash
    descriptor_path.write_bytes(canonical_json(case) + b"\n")
    return {
        "case_id": case_id,
        "pair_id": definition["pair_id"],
        "family": definition["family"],
        "analysis_group": definition["analysis_group"],
        "execution_device": definition["execution_device"],
        "is_smoke": definition["is_smoke"],
        "magnetic_hmax_nm": definition.get("magnetic_hmax_nm"),
        "box_factor": definition.get("box_factor"),
        "input_identity": input_identity,
        "input_identity_sha256": canonical_sha256(input_identity),
        "script_path": (run_root_repo_relative / script_path.name).as_posix(),
        "script_path_in_campaign": (Path("runs") / script_path.name).as_posix(),
        "script_container_path": str(run_root_container / script_path.name),
        "script_sha256": script_hash,
        "descriptor_path": (run_root_repo_relative / descriptor_path.name).as_posix(),
        "descriptor_path_in_campaign": (Path("runs") / descriptor_path.name).as_posix(),
        "descriptor_sha256": sha256_file(descriptor_path),
        "output_path": (Path("runs") / output_path.name).as_posix(),
        "output_container_path": str(output_container_path),
        "minimum_positive_mode_count": definition.get(
            "minimum_positive_mode_count"
        ),
        "requested_mode_count": definition.get("requested_mode_count", 1),
        "frequency_window_hz": definition.get("frequency_window_hz"),
    }


def write_json_atomic(path: Path, value: object) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(json.dumps(value, indent=2, allow_nan=False).encode("utf-8") + b"\n")
    os.replace(temporary, path)


def managed_run_commands(
    *,
    source_root: Path,
    runs: list[dict[str, Any]],
    campaign_root: Path,
    port: int,
) -> str:
    lines = [
        "set -euo pipefail",
        "set -o noclobber",
        f"cd {shlex.quote(str(source_root))}",
        "# Start the staged cases only after the selected managed DEV group is ready.",
        "# Each solve uses the published CLI in its existing backend container.",
        "# This script does not build, start, or create another container.",
        f"# The selected DEV frontend port is {port}; the FEM CLI runs in backend.",
        'project="${1:?Usage: bash run-managed-dev.sh COMPOSE_PROJECT [CASE_ID]}"',
        'case_filter="${2:-}"',
        'case "$project" in fullmag-master|fullmag-worktree-*) ;; *) echo "Expected a Fullmag DEV Compose project" >&2; exit 2 ;; esac',
        'backend=$(docker ps --no-trunc --filter "label=com.docker.compose.project=$project" '
        '--filter label=com.docker.compose.service=backend --format "{{.ID}}")',
        'if [[ ! "$backend" =~ ^[0-9a-f]{64}$ ]]; then echo "Expected one running backend for $project" >&2; exit 2; fi',
        f'case "$case_filter" in ""|{"|".join(shlex.quote(run["case_id"]) for run in runs)}) ;; '
        '*) echo "Unknown case ID: $case_filter" >&2; exit 2 ;; esac',
        "mkdir -p " + shlex.quote(str(campaign_root / "run-logs")),
        "",
        "# Each Kittel GPU case imports the matching CPU case's published inputs.",
    ]
    for run in runs:
        case_id = str(run["case_id"])
        device = str(run["execution_device"])
        cli_command = " ".join(
            (
                "docker exec -w /opt/fullmag/source",
                "-e FULLMAG_API_PORT=0",
                "-e FULLMAG_FEM_EXECUTION=" + shlex.quote(device),
                "-e FULLMAG_DISABLE_PREVIEW_3D=1",
                "-e FULLMAG_DISABLE_CHARTS=1",
                "-e FULLMAG_FEM_MODAL_CUDA_TRACE",
                '"$backend" /opt/fullmag/package/bin/fullmag-bin',
                shlex.quote(run["script_container_path"]),
                "--backend fem --headless --json",
                "--output-dir " + shlex.quote(run["output_container_path"]),
                "--workspace-root "
                + shlex.quote(
                    "/opt/fullmag/script-output/.fullmag-tmp/"
                    + campaign_root.name
                    + "/workspace-history/"
                    + case_id
                ),
            )
        )
        log_path = campaign_root / "run-logs" / f"{case_id}.log"
        lines.append(f'if [[ -z "$case_filter" || "$case_filter" == {shlex.quote(case_id)} ]]; then')
        lines.append(f"    {{ time -p {cli_command}; }} > {shlex.quote(str(log_path))} 2>&1")
        lines.append("fi")
    return "\n".join(lines) + "\n"


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    repo_root = args.repo_root.resolve()
    if not (repo_root / ".git").exists() and not (repo_root / ".git").is_file():
        fail(f"repo root is not a Git checkout: {repo_root}")
    script_output_arg = args.script_output_root
    if not script_output_arg.is_absolute():
        script_output_arg = repo_root / script_output_arg
    script_output_root = within(script_output_arg, repo_root, "script-output root")
    if not script_output_root.is_dir():
        fail(f"script-output root must already exist: {script_output_root}")
    checkpoint_source = args.checkpoint_source.resolve()
    checkpoint = validate_checkpoint_source(checkpoint_source)

    campaign_root = script_output_root / ".fullmag-tmp" / args.campaign_id
    if campaign_root.exists():
        fail(f"campaign already exists; refusing overwrite: {campaign_root}")
    campaign_root.mkdir(parents=True, exist_ok=False)
    write_json_atomic(
        campaign_root / "staging-state.json",
        {"schema": SCHEMA, "state": "staging", "campaign_id": args.campaign_id},
    )

    inputs_root = campaign_root / "inputs" / "checkpoint_step_8006"
    inputs_root.mkdir(parents=True, exist_ok=False)
    staged_mesh = inputs_root / MESH_NAME
    staged_equilibrium = inputs_root / EQUILIBRIUM_NAME
    staged_artifact = inputs_root / EQUILIBRIUM_ARTIFACT_NAME
    shutil.copy2(checkpoint["mesh_path"], staged_mesh)
    shutil.copytree(checkpoint["equilibrium_path"], staged_equilibrium)
    shutil.copy2(checkpoint["equilibrium_artifact_path"], staged_artifact)
    if sha256_file(staged_artifact) != EQUILIBRIUM_ARTIFACT_FILE_SHA256:
        fail("certified checkpoint artifact changed during staging")
    if sha256_file(staged_mesh) != MESH_SHA256:
        fail("staged input mesh changed during copy")
    if tree_identity(staged_equilibrium)["tree_sha256"] != checkpoint[
        "equilibrium_tree"
    ]["tree_sha256"]:
        fail("staged equilibrium tree changed during copy")
    reference_weights_path = (
        campaign_root / "inputs" / "reference_cpu_node_mass_weights.v1.json"
    )
    reference_weights_document = {
        key: value
        for key, value in checkpoint["reference_mesh_mass_metric"].items()
        if key != "node_mass_weights"
    }
    # Keep a compact, durable reference metric in the campaign. The original
    # CPU archive remains separately pinned below for its selected mode fields.
    write_json_atomic(
        reference_weights_path,
        {
            **reference_weights_document,
            "node_mass_weights": checkpoint["reference_mesh_mass_metric"][
                "node_mass_weights"
            ],
        },
    )

    definitions = build_run_definitions(checkpoint)
    # The four-nanometre pair is reused by both convergence sequences.
    # CPU runs first because the published mesh and m0 are the GPU inputs.
    geometry_order = {
        (4.0, 8.0): 0,
        (3.0, 8.0): 1,
        (2.5, 8.0): 2,
        (4.0, 6.0): 3,
        (4.0, 10.0): 4,
    }

    def run_order_key(row: dict[str, Any]) -> tuple[int, int, int]:
        lane = 0 if row["execution_device"] == "cpu" else 1
        if row["family"] == "kittel_sphere":
            key = (row["magnetic_hmax_nm"], row["box_factor"])
            return (0, geometry_order[key], lane)
        return (1, 0, lane)

    definitions.sort(key=run_order_key)

    runs_root = campaign_root / "runs"
    runs_root.mkdir()
    runs_root_repo_relative = runs_root.relative_to(repo_root)
    campaign_repo_relative = campaign_root.relative_to(repo_root)
    campaign_under_mount = campaign_root.relative_to(script_output_root)
    run_root_container = CONTAINER_OUTPUT_ROOT / PurePosixPath(
        campaign_under_mount.as_posix()
    ) / "runs"
    checkpoint_container_root = (
        CONTAINER_OUTPUT_ROOT
        / PurePosixPath(campaign_under_mount.as_posix())
        / "inputs"
        / "checkpoint_step_8006"
    )

    kittel_template = (repo_root / KITTEL_TEMPLATE).read_text(encoding="utf-8")
    checkpoint_template = (repo_root / CHECKPOINT_TEMPLATE).read_text(encoding="utf-8")
    runs = []
    for definition in definitions:
        template = (
            checkpoint_template
            if definition["family"] == "checkpoint_step_8006"
            else kittel_template
        )
        runs.append(
            stage_case(
                definition,
                template_text=template,
                run_root=runs_root,
                run_root_repo_relative=runs_root_repo_relative,
                run_root_container=run_root_container,
                checkpoint_container_root=checkpoint_container_root,
            )
        )

    reference_verification = checkpoint["verification"]
    reference = {
        "root": str(checkpoint_source),
        "zarr_path": str(checkpoint["reference_cpu_zarr_path"]),
        "verification_path": str(checkpoint["reference_verification_path"]),
        "verification_sha256": sha256_file(checkpoint["reference_verification_path"]),
        "script_path": str(checkpoint["reference_script_path"]),
        "script_sha256": reference_verification["source_script_sha256"],
        "input_mesh_sha256": MESH_SHA256,
        "magnetization_f64le_sha256": MAGNETIZATION_SHA256,
        "native_mesh_topology_sha256": TOPOLOGY_SHA256,
        "mesh_mass_metric": {
            key: value
            for key, value in checkpoint["reference_mesh_mass_metric"].items()
            if key != "node_mass_weights"
        }
        | {"campaign_artifact_path": "inputs/reference_cpu_node_mass_weights.v1.json"},
        "spectrum_completeness": "selected_only",
        "certified_positive_frequencies": reference_verification[
            "certified_positive_frequencies"
        ],
        "saved_complex_profiles_verified": reference_verification[
            "complex_profiles_verified"
        ],
        "first_ten_frequencies_hz": reference_verification[
            "first_ten_frequencies_hz"
        ],
    }

    try:
        head = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        fail(f"cannot capture selected source HEAD: {error}")

    manifest = {
        "schema": SCHEMA,
        "campaign_id": args.campaign_id,
        "prepared_only": True,
        "launched": False,
        "source": {
            "repo_root": str(repo_root),
            "head_commit": head,
            "script_output_root_relative": script_output_root.relative_to(
                repo_root
            ).as_posix(),
            "container_output_root": str(CONTAINER_OUTPUT_ROOT),
            "campaign_root_relative": campaign_repo_relative.as_posix(),
        },
        "execution": {
            "route": "published_fullmag_bin_cli_in_existing_docker_dev_backend",
            "backend_service": "backend",
            "container_source_root": "/opt/fullmag/source",
            "container_output_root": str(CONTAINER_OUTPUT_ROOT),
            "selected_dev_frontend_port": args.port,
            "build_or_container_creation": False,
        },
        "inputs": {
            "checkpoint_source_root": str(checkpoint_source),
            "step_8006": {
                "mesh_filename": MESH_NAME,
                "equilibrium_filename": EQUILIBRIUM_NAME,
                "equilibrium_artifact_filename": EQUILIBRIUM_ARTIFACT_NAME,
                "equilibrium_artifact_path": staged_artifact.relative_to(campaign_root).as_posix(),
                "equilibrium_artifact_file_sha256": EQUILIBRIUM_ARTIFACT_FILE_SHA256,
                "equilibrium_artifact_content_sha256": EQUILIBRIUM_ARTIFACT_CONTENT_SHA256,
                "input_mesh_sha256": MESH_SHA256,
                "equilibrium_tree": checkpoint["equilibrium_tree"],
                "magnetization_f64le_sha256": MAGNETIZATION_SHA256,
                "native_mesh_topology_sha256": TOPOLOGY_SHA256,
                "sequence_step": EQUILIBRIUM_STEP,
                "node_count": 33408,
                "reference_node_mass_weights_sha256": checkpoint[
                    "reference_mesh_mass_metric"
                ]["node_mass_weights_sha256"],
            },
            "historical_cpu_reference": reference,
        },
        "expectations": {
            "kittel": {
                "expected_frequency_hz": _kittel_input_identity(4.0, 8.0)[
                    "analytic_reference"
                ]["expected_frequency_hz"],
                "gyromagnetic_ratio_m_per_a_s": GYROMAGNETIC_RATIO_M_PER_A_S,
                "mu0_T_m_per_A": MU0_T_M_PER_A,
                "gamma_hz_per_t": GYROMAGNETIC_RATIO_M_PER_A_S
                / (2.0 * math.pi * MU0_T_M_PER_A),
                "frequency_conversion": "gamma0 / (2*pi*mu0) in Hz/T",
                "mesh_refinement_h_nm": [4.0, 3.0, 2.5],
                "mesh_refinement_box_factor": 8.0,
                "airbox_refinement_box_factors": [6.0, 8.0, 10.0],
                "airbox_refinement_h_nm": 4.0,
            },
            "checkpoint_window": {
                "frequency_window_hz": [1.0, 8.0e9],
                "minimum_positive_mode_count": 17,
                "requested_mode_count": 17,
                "required_window_certificate": True,
                "independent_archive_positive_mode_count": 17,
                "independent_archive_count_scope": [1.0, 8.0e9],
            },
            "residual_gate": "native full descriptor per saved mode",
            "phase_invariant_overlap": {
                "basis": "complex q coefficients",
                "formula": "mass-weighted complex q inner product using one positive FE node mass weight for each of the two block q components",
                "checkpoint_reference": "historical CPU eigen_summary node_mass_weights, pinned by canonical SHA-256",
                "same_topology_required": True,
            },
        },
        "runs": runs,
        "run_order": [row["script_path"] for row in runs],
    }
    write_json_atomic(campaign_root / "run-matrix.v1.json", manifest)
    command_text = managed_run_commands(
        source_root=repo_root,
        runs=runs,
        campaign_root=campaign_root,
        port=args.port,
    )
    (campaign_root / "run-managed-dev.sh").write_text(command_text, encoding="utf-8")
    write_json_atomic(
        campaign_root / "staging-state.json",
        {
            "schema": SCHEMA,
            "state": "prepared",
            "campaign_id": args.campaign_id,
            "run_count": len(runs),
            "first_run": runs[0]["script_path"],
        },
    )
    smoke = next(row for row in runs if row["is_smoke"])
    return {
        "schema": SCHEMA,
        "campaign_id": args.campaign_id,
        "state": "prepared",
        "campaign_root": str(campaign_root),
        "run_count": len(runs),
        "first_smoke_script": smoke["script_path"],
        "first_smoke_device": smoke["execution_device"],
        "first_smoke_mesh_hmax_nm": smoke["magnetic_hmax_nm"],
        "first_smoke_box_factor": smoke["box_factor"],
        "reference_cpu_scope": "selected_only",
        "checkpoint_window_hz": [1.0, 8.0e9],
        "minimum_positive_modes": 17,
        "launched": False,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--script-output-root", type=Path, required=True)
    parser.add_argument("--checkpoint-source", type=Path, required=True)
    parser.add_argument("--campaign-id", required=True)
    parser.add_argument("--port", type=int, default=3395)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", args.campaign_id):
        parser.error("campaign-id must use 1-80 safe ASCII letters, digits, dot, dash, or underscore")
    if not 1 <= args.port <= 65535:
        parser.error("port must be in [1, 65535]")
    try:
        result = prepare(args)
    except (PreparationError, OSError, json.JSONDecodeError) as error:
        parser.exit(2, f"campaign staging failed: {error}\n")
    print(json.dumps(result, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
