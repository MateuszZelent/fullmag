#!/usr/bin/env python3
"""Verify staged FEM open-airbox k=0 CPU/GPU convergence artifacts.

The report separates artifact availability, execution selection, evidence
completeness, and the measured numerical assessments. It never upgrades a
selected spectrum to a complete frequency window.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import struct
from pathlib import Path, PurePosixPath
from typing import Any


MATRIX_SCHEMA = "fullmag.fem.open_airbox_k0_convergence.v1"
CASE_SCHEMA = "fullmag.fem.open_airbox_k0.case.v1"
MESH_SHA256 = "d181307812e2eea1781680136727d63f1923743345188aa9901672efd5295dfa"
MAGNETIZATION_SHA256 = "231c0626f51a370dca3e975a335bc5107460ed6d8bf7593fa11a0caeb82bb638"
TOPOLOGY_SHA256 = "sha256:c0524978b1a1a84b63a7959b1b08e69d43c94a2a1be5c6036c1f2596629d7de0"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class VerificationError(ValueError):
    pass


def fail(message: str) -> None:
    raise VerificationError(message)


def load_json(path: Path, description: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"missing {description}: {path}")
    except json.JSONDecodeError as error:
        fail(f"invalid JSON in {description} {path}: {error}")
    if not isinstance(value, dict):
        fail(f"{description} must be a JSON object: {path}")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tree_sha256(root: Path) -> dict[str, Any]:
    if not root.is_dir():
        fail(f"required input tree is missing: {root}")
    digest = hashlib.sha256()
    file_count = 0
    total_bytes = 0
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        if path.is_symlink():
            fail(f"input tree contains a symlink: {path}")
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        file_digest = sha256_file(path)
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_digest.encode("ascii"))
        digest.update(b"\0")
        file_count += 1
        total_bytes += path.stat().st_size
    return {
        "tree_sha256": digest.hexdigest(),
        "file_count": file_count,
        "total_bytes": total_bytes,
    }


def resolve_campaign_entry(
    campaign_root: Path,
    relative_path: object,
    description: str,
    *,
    expected_kind: str,
) -> Path:
    if not isinstance(relative_path, str) or not relative_path:
        fail(f"{description} path is missing")
    relative = PurePosixPath(relative_path)
    if relative.is_absolute() or ".." in relative.parts:
        fail(f"{description} path is not campaign-relative")
    resolved_root = campaign_root.resolve()
    candidate = resolved_root.joinpath(*relative.parts)
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(resolved_root)
    except (OSError, ValueError):
        fail(f"{description} is missing or escapes the campaign")
    if candidate.is_symlink():
        fail(f"{description} must not be a symlink")
    if expected_kind == "file" and not resolved.is_file():
        fail(f"{description} is not a regular file")
    if expected_kind == "directory" and not resolved.is_dir():
        fail(f"{description} is not a directory")
    return resolved


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def finite_number(value: object, name: str) -> float:
    if isinstance(value, bool):
        fail(f"{name} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError):
        fail(f"{name} must be a finite number")
    if not math.isfinite(number):
        fail(f"{name} must be a finite number")
    return number


def relative_delta(lhs: float, rhs: float) -> float:
    return abs(lhs - rhs) / max(abs(lhs), abs(rhs), 1e-300)


def parse_generation(root: Path) -> tuple[dict[str, Any], Path]:
    generation_file = root / "artifacts" / "frequency_domain" / "generation.v2.json"
    generation = load_json(generation_file, "active frequency-domain generation")
    generation_id = generation.get("generation_id")
    if not isinstance(generation_id, str) or not generation_id.startswith("sha256:"):
        fail(f"{generation_file}: invalid generation_id")
    digest = generation_id.removeprefix("sha256:")
    if not SHA256_RE.fullmatch(digest):
        fail(f"{generation_file}: generation_id is not a SHA-256 identity")
    generation_root = (
        root
        / "artifacts"
        / "frequency_domain"
        / "generations"
        / digest
    )
    if not generation_root.is_dir():
        fail(f"active generation directory is missing: {generation_root}")
    return generation, generation_root


def resolve_cli_artifact_root(output_root: Path) -> Path:
    """Resolve the CLI output directory containing a frequency-domain generation.

    The CLI may place the generation directly in its output directory or in a
    single ``artifacts``/``results`` child. Accept only these one-level layouts and reject ambiguous
    trees so a stale nested generation cannot be selected silently.
    """
    output_root = output_root.resolve()
    if not output_root.is_dir():
        fail(f"run output directory is missing: {output_root}")
    candidates = [
        output_root,
        output_root / "artifacts",
        output_root / "results",
        output_root / "result",
    ]
    valid = [
        candidate
        for candidate in candidates
        if (candidate / "artifacts" / "frequency_domain" / "generation.v2.json").is_file()
    ]
    if len(valid) == 1:
        return valid[0]
    if len(valid) > 1:
        fail(
            "CLI output contains multiple frequency-domain generations at supported roots: "
            + ", ".join(str(path) for path in valid)
        )
    expected = ", ".join(str(path) for path in candidates)
    fail(
        "CLI output has no frequency-domain generation at the direct or supported nested root; "
        f"checked {expected}"
    )


def load_generation_json(
    generation_root: Path, members: dict[str, Any], member: str, description: str
) -> tuple[dict[str, Any], str]:
    path = resolve_campaign_entry(
        generation_root, member, description, expected_kind="file"
    )
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    index = members.get(member)
    if (
        not isinstance(index, dict)
        or index.get("sha256") != "sha256:" + digest
        or index.get("byte_length") != len(data)
    ):
        fail(f"published {description} differs from its generation member: {member}")
    try:
        value = json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        fail(f"invalid JSON in {description} {path}: {error}")
    if not isinstance(value, dict):
        fail(f"{description} must be a JSON object: {path}")
    return value, digest


def load_modes(
    generation_root: Path, members: dict[str, Any]
) -> list[dict[str, Any]]:
    mode_root = generation_root / "eigen" / "modes" / "sample_0000"
    if not mode_root.is_dir():
        fail(f"saved eigenmode directory is missing: {mode_root}")
    indexed: list[tuple[int, dict[str, Any], Path]] = []
    for path in sorted(mode_root.glob("mode_*.json")):
        match = re.fullmatch(r"mode_(\d{4,})\.json", path.name)
        if not match:
            continue
        raw_index = int(match.group(1))
        mode, digest = load_generation_json(
            generation_root, members, path.relative_to(generation_root).as_posix(),
            f"mode {raw_index}",
        )
        if mode.get("raw_mode_index") != raw_index:
            fail(f"{path}: raw_mode_index does not match its filename")
        mode["_artifact_path"] = str(path)
        mode["_artifact_sha256"] = digest
        indexed.append((raw_index, mode, path))
    indexed.sort(key=lambda row: row[0])
    if not indexed:
        fail(f"no saved mode artifacts in {mode_root}")
    if [row[0] for row in indexed] != list(range(len(indexed))):
        fail(f"saved raw mode indices are not contiguous from zero in {mode_root}")
    return [row[1] for row in indexed]


def load_mesh_mass_metric(
    generation_root: Path, modes: list[dict[str, Any]], members: dict[str, Any]
) -> dict[str, Any]:
    member = "eigen/metadata/eigen_summary.json"
    summary_path = generation_root / member
    try:
        summary, summary_sha256 = load_generation_json(
            generation_root, members, member, "eigen summary"
        )
        diagnostics = summary.get("solver_diagnostics")
        if not isinstance(diagnostics, dict):
            fail("eigen summary has no solver diagnostics for its mesh mass metric")
        raw_weights = summary.get("node_mass_weights")
        if not isinstance(raw_weights, list) or not raw_weights:
            fail("eigen summary has no node_mass_weights vector")
        weights = [
            finite_number(value, f"node_mass_weights[{index}]")
            for index, value in enumerate(raw_weights)
        ]
        if any(weight <= 0.0 for weight in weights):
            fail("eigen summary node_mass_weights must be strictly positive")
        topology = diagnostics.get("source_mesh_topology_sha256")
        if not isinstance(topology, str) or not topology:
            topology = next(
                (
                    mode.get("source_mesh_topology_sha256")
                    for mode in modes
                    if isinstance(mode.get("source_mesh_topology_sha256"), str)
                ),
                None,
            )
        if not isinstance(topology, str) or not topology:
            fail("eigen summary and modes do not identify a mesh topology")
        q_dof_count = diagnostics.get("q_dof_count")
        if isinstance(q_dof_count, bool) or not isinstance(q_dof_count, int):
            q_dof_count = next(
                (
                    mode.get("q_dof_count")
                    for mode in modes
                    if isinstance(mode.get("q_dof_count"), int)
                    and not isinstance(mode.get("q_dof_count"), bool)
                ),
                None,
            )
        if q_dof_count is not None and q_dof_count != 2 * len(weights):
            fail(
                "eigen summary node_mass_weights do not match the two-block q dimension"
            )
        return {
            "status": "available",
            "summary_path": str(summary_path),
            "summary_sha256": summary_sha256,
            "mesh_topology_sha256": topology,
            "active_magnetic_node_count": len(weights),
            "q_dof_count": q_dof_count,
            "node_mass_weights_sha256": canonical_sha256(weights),
            "_weights": weights,
            "errors": [],
        }
    except (VerificationError, OSError) as error:
        return {
            "status": "unavailable",
            "summary_path": str(summary_path),
            "summary_sha256": None,
            "mesh_topology_sha256": None,
            "active_magnetic_node_count": None,
            "q_dof_count": None,
            "node_mass_weights_sha256": None,
            "_weights": None,
            "errors": [str(error)],
        }


def load_run_artifacts(root: Path) -> dict[str, Any]:
    root = resolve_cli_artifact_root(root)
    generation, generation_root = parse_generation(root)
    content = generation.get("content")
    members = content.get("members") if isinstance(content, dict) else None
    if not isinstance(members, dict):
        fail("active frequency-domain generation lacks an artifact member index")
    solver_member = "eigen/diagnostics/solver.v1.json"
    solver_path = generation_root / solver_member
    solver, solver_sha256 = load_generation_json(
        generation_root, members, solver_member, "solver diagnostics"
    )
    modes = load_modes(generation_root, members)
    mesh_metric = load_mesh_mass_metric(generation_root, modes, members)
    return {
        "root": str(root.resolve()),
        "generation_id": generation["generation_id"],
        "generation_path": str(generation_root),
        "generation_members": members,
        "solver_path": str(solver_path),
        "solver_sha256": solver_sha256,
        "solver": solver,
        "modes": modes,
        "mode_count_saved": len(modes),
        "mesh_metric": mesh_metric,
    }


def mode_residual_evidence(modes: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    evidence = []
    errors = []
    for mode in modes:
        index = mode.get("raw_mode_index")
        prefix = f"mode {index}"
        row: dict[str, Any] = {
            "raw_mode_index": index,
            "artifact_path": mode.get("_artifact_path"),
            "artifact_sha256": mode.get("_artifact_sha256"),
            "frequency_hz": mode.get("frequency_real_hz", mode.get("frequency_hz")),
            "residual_relative_l2": mode.get("residual_relative_l2"),
            "block_residuals": mode.get("block_residuals"),
            "candidate_identity": mode.get("candidate_identity"),
            "source_mesh_identity": mode.get("source_mesh_identity"),
            "source_mesh_topology_sha256": mode.get("source_mesh_topology_sha256"),
            "equilibrium_artifact_sha256": mode.get("equilibrium_artifact_sha256"),
            "equilibrium_content_sha256": mode.get("equilibrium_content_sha256"),
            "spectrum_completeness": mode.get("spectrum_completeness"),
            "q_dof_count": mode.get("q_dof_count"),
            "q_vector_available": (
                isinstance(mode.get("q_real"), list)
                and isinstance(mode.get("q_imag"), list)
            ),
        }
        try:
            frequency = finite_number(row["frequency_hz"], f"{prefix}.frequency_hz")
            if frequency <= 0.0:
                errors.append(f"{prefix}.frequency_hz must be positive")
        except VerificationError as error:
            errors.append(str(error))

        try:
            residual = finite_number(
                row["residual_relative_l2"], f"{prefix}.residual_relative_l2"
            )
            if residual < 0.0:
                errors.append(f"{prefix}.residual_relative_l2 must be non-negative")
        except VerificationError as error:
            errors.append(str(error))

        block = row["block_residuals"]
        if not isinstance(block, dict):
            errors.append(f"{prefix}.block_residuals is missing")
        else:
            if block.get("certified") is not True:
                errors.append(f"{prefix}.block_residuals.certified is not true")
            if block.get("full_descriptor_certified") is not True:
                errors.append(
                    f"{prefix}.block_residuals.full_descriptor_certified is not true"
                )
            if block.get("scope") != "native_descriptor":
                errors.append(
                    f"{prefix}.block_residuals.scope is not native_descriptor"
                )
            try:
                eps_full = finite_number(
                    block.get("eps_full"), f"{prefix}.block_residuals.eps_full"
                )
                tolerance = finite_number(
                    block.get("certification_tolerance"),
                    f"{prefix}.block_residuals.certification_tolerance",
                )
                if eps_full < 0.0 or tolerance <= 0.0:
                    errors.append(f"{prefix} has invalid full residual or tolerance")
                elif eps_full > tolerance:
                    errors.append(
                        f"{prefix}.eps_full {eps_full:g} exceeds its certified "
                        f"tolerance {tolerance:g}"
                    )
                if isinstance(row["residual_relative_l2"], (int, float)):
                    if relative_delta(float(row["residual_relative_l2"]), eps_full) > 1e-6:
                        errors.append(
                            f"{prefix}.residual_relative_l2 differs from eps_full"
                        )
            except VerificationError as error:
                errors.append(str(error))
            for key in ("eps_q", "eps_phi", "eps_gauge", "eps_full"):
                if block.get(key) is not None:
                    try:
                        value = finite_number(block[key], f"{prefix}.block_residuals.{key}")
                        if value < 0.0:
                            errors.append(
                                f"{prefix}.block_residuals.{key} must be non-negative"
                            )
                    except VerificationError as error:
                        errors.append(str(error))
        if mode.get("solve_succeeded") is not True:
            errors.append(f"{prefix}.solve_succeeded is not true")
        evidence.append(row)
    return evidence, errors


def device_selection_proof(solver: dict[str, Any], modes: list[dict[str, Any]], expected: str) -> dict[str, Any]:
    errors: list[str] = []
    resolution = solver.get("fem_eigen_execution_resolution")
    if not isinstance(resolution, dict):
        errors.append("fem_eigen_execution_resolution proof is missing")
        resolution = {}
    requested = resolution.get("requested_device")
    resolved = resolution.get("resolved_device")
    fallback = resolution.get("fallback_used", solver.get("fallback_used"))
    if requested != expected:
        errors.append(f"requested_device is {requested!r}, expected {expected!r}")
    if resolved != expected:
        errors.append(f"resolved_device is {resolved!r}, expected {expected!r}")
    if fallback is not False:
        errors.append(f"fallback_used is {fallback!r}, expected false")

    expected_lane = "production_cpu" if expected == "cpu" else "production_gpu"
    if solver.get("execution_lane") != expected_lane:
        errors.append(
            f"execution_lane is {solver.get('execution_lane')!r}, expected {expected_lane!r}"
        )
    if solver.get("demag_kind") != "open_airbox_k0":
        errors.append(
            f"demag_kind is {solver.get('demag_kind')!r}, expected 'open_airbox_k0'"
        )

    adapter = solver.get("solver_adapter")
    model = solver.get("solver_model")
    engine_id = solver.get("engine_id")
    accepted_names = [
        value
        for value in (adapter, model, engine_id)
        if isinstance(value, str)
    ]
    if expected == "cpu":
        if not any("k0_poisson_airbox_cpu_" in value for value in accepted_names):
            errors.append("CPU K0 solver adapter/model identity is missing")
        if solver.get("cpu_fallback") != "disabled":
            errors.append("CPU diagnostic does not prove fallback is disabled")
    else:
        cudss = adapter == "k0_poisson_airbox_gpu_augmented_cudss"
        if not cudss and adapter != "k0_poisson_airbox_gpu_petsc_slepc":
            errors.append("GPU solver_adapter is not a production K0 adapter")
        required_true = (
            "production_implication",
            "production_shared_domain",
            "gpu_device_resident_modal_eigensolver",
            "device_residency_verified",
            "scalable_selected_spectrum",
        )
        for key in required_true:
            if solver.get(key) is not True:
                errors.append(f"GPU {key} is not true")
        if solver.get("validation_only") is not False:
            errors.append("GPU diagnostic does not prove validation_only=false")
        if solver.get("fallback_used") is not False:
            errors.append("GPU diagnostic does not prove fallback_used=false")
        if solver.get("cpu_fallback") != "disabled":
            errors.append("GPU diagnostic does not prove CPU fallback is disabled")
        kind = "augmented_robin_cudss_cuda" if cudss else "matrix_free_schur_cuda"
        if solver.get("eigensolver_operator_kind") != kind:
            errors.append(f"GPU operator proof does not match {kind}")
        if cudss:
            attestation = solver.get("gpu_execution_attestation")
            attestation = attestation if isinstance(attestation, dict) else {}
            bindings = attestation.get("bindings")
            trace = attestation.get("native_trace_window")
            scope = attestation.get("native_scope")
            if (
                attestation.get("measurement_state") != "measured"
                or attestation.get("operator_kind") != kind
                or not isinstance(bindings, dict)
                or not isinstance(trace, dict)
                or not isinstance(scope, dict)
                or trace.get("status") != "complete"
                or scope.get("status") != "complete"
                or scope.get("resources_released") is not True
                or not isinstance(trace.get("native_trace_sha256"), str)
                or bindings.get("native_trace_sha256") != "sha256:" + trace["native_trace_sha256"]
            ):
                errors.append("GPU cuDSS execution, lifetime or trace evidence is incomplete")
            else:
                for field in (
                    "h2d_count", "h2d_bytes", "d2h_count", "d2h_bytes",
                    "allocation_count", "release_count", "host_sync_count",
                ):
                    if type(trace.get(field)) is not int or trace[field] != 0:
                        errors.append(f"GPU measured cuDSS iteration has nonzero or missing {field}")

    candidate_devices = []
    for mode in modes:
        identity = mode.get("candidate_identity")
        candidate_device = identity.get("device") if isinstance(identity, dict) else None
        candidate_devices.append(candidate_device)
        if candidate_device != expected:
            errors.append(
                f"mode {mode.get('raw_mode_index')} candidate device is "
                f"{candidate_device!r}, expected {expected!r}"
            )
    return {
        "status": "proven" if not errors else "unproven",
        "expected_device": expected,
        "requested_device": requested,
        "resolved_device": resolved,
        "execution_lane": solver.get("execution_lane"),
        "solver_adapter": adapter,
        "solver_model": model,
        "engine_id": engine_id,
        "matrix_free_operator_kind": solver.get("eigensolver_operator_kind"),
        "scalable_selected_spectrum": solver.get("scalable_selected_spectrum"),
        "candidate_mode_devices": candidate_devices,
        "proof_errors": errors,
    }


def _decode_certificate(value: object) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return None
        return decoded if isinstance(decoded, dict) else None
    return None


def _decode_json_list(value: object) -> list[Any] | None:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return None
        return decoded if isinstance(decoded, list) else None
    return None


def augmented_window_completeness(
    solver: dict[str, Any],
    certificate: dict[str, Any] | None,
    expected_window: list[float],
    expected_mode_count: int,
    saved_modes: list[dict[str, Any]],
) -> dict[str, Any]:
    errors: list[str] = []
    root = certificate or {}
    expected_low, expected_high = map(float, expected_window)
    if (
        root.get("schema_version") != "poisson_airbox_augmented_inertia_window_certificate.v1"
        or root.get("status") != "certified"
        or root.get("window_complete") is not True
        or solver.get("window_complete") is not True
        or solver.get("target_kind") != "frequency_window"
    ):
        errors.append("the native augmented Robin window certificate is missing or incomplete")

    def count(value: object) -> int | None:
        return value if type(value) is int and value >= 0 else None

    def interval(value: object, name: str) -> float | None:
        try:
            return finite_number(value, name)
        except VerificationError as error:
            errors.append(str(error))
            return None

    low = interval(root.get("requested_min_hz"), "certificate lower frequency")
    high = interval(root.get("requested_max_hz"), "certificate upper frequency")
    if (low, high) != (expected_low, expected_high) or solver.get("requested_window_hz") != expected_window:
        errors.append("the native inertia certificate does not bind the requested window")
    origin = count(root.get("negative_at_origin"))
    at_low = count(root.get("negative_at_lower"))
    at_high = count(root.get("negative_at_upper"))
    certified = count(root.get("certified_count"))
    if (
        origin is None or at_low is None or at_high is None
        or not origin <= at_low <= at_high
        or certified != expected_mode_count
        or at_high - at_low != certified
    ):
        errors.append("the guarded endpoint inertia does not prove the required positive mode count")
    if (
        count(solver.get("requested_mode_count")) != expected_mode_count
        or count(solver.get("accepted_mode_count")) != expected_mode_count
        or len(saved_modes) != expected_mode_count
    ):
        errors.append("the saved mode count does not match the independent count")

    saved_frequencies = []
    for mode in saved_modes:
        frequency = interval(mode.get("frequency_real_hz", mode.get("frequency_hz")), "saved mode frequency")
        if frequency is not None and frequency > 0.0 and expected_low <= frequency <= expected_high:
            saved_frequencies.append(frequency)
    if len(saved_frequencies) != expected_mode_count:
        errors.append("the saved positive spectrum does not match the certified window count")

    partition = root.get("partition")
    previous_end, previous_inertia = low, at_low
    covered = 0
    if not isinstance(partition, list) or not partition:
        errors.append("the inertia certificate has no covering partition")
        partition = []
    for index, leaf in enumerate(partition):
        if not isinstance(leaf, dict):
            errors.append(f"certified interval {index} is invalid")
            continue
        begin = interval(leaf.get("lower_hz"), f"certified interval {index} lower frequency")
        end = interval(leaf.get("upper_hz"), f"certified interval {index} upper frequency")
        below = count(leaf.get("negative_at_lower"))
        above = count(leaf.get("negative_at_upper"))
        accepted = count(leaf.get("accepted_count"))
        if (
            begin is None or end is None or not expected_low <= begin < end <= expected_high
            or begin != previous_end or below != previous_inertia
            or below is None or above is None or accepted is None
            or above - below != accepted
        ):
            errors.append(f"certified interval {index} breaks the inertia partition")
        else:
            covered += accepted
            if sum(begin < frequency < end for frequency in saved_frequencies) != accepted:
                errors.append(f"saved frequencies do not match the count in certified interval {index}")
        previous_end, previous_inertia = end, above
    if previous_end != high or previous_inertia != at_high or covered != expected_mode_count:
        errors.append("certified intervals do not exhaust the requested window")

    return {
        "status": "certified" if not errors else "unproven",
        "window_complete": solver.get("window_complete"),
        "certificate_available": certificate is not None,
        "expected_window_hz": expected_window,
        "expected_mode_count": expected_mode_count,
        "certified_count": certified,
        "saved_positive_modes_in_window": len(saved_frequencies),
        "raw_certificate": certificate,
        "raw_certificate_sha256": canonical_sha256(root),
        "proof_errors": errors,
    }


def window_completeness(
    solver: dict[str, Any],
    expected_window: list[float],
    *,
    expected_mode_count: int,
    saved_modes: list[dict[str, Any]],
) -> dict[str, Any]:
    raw_certificate = solver.get("window_certificate")
    certificate = _decode_certificate(raw_certificate)
    if solver.get("solver_adapter") == "k0_poisson_airbox_gpu_augmented_cudss":
        return augmented_window_completeness(
            solver, certificate, expected_window, expected_mode_count, saved_modes
        )
    raw_subwindows_payload = solver.get(
        "executed_subwindows", solver.get("subwindows")
    )
    raw_subwindows = _decode_json_list(raw_subwindows_payload)
    errors: list[str] = []
    if certificate is None:
        return {
            "status": "unproven",
            "window_complete": solver.get("window_complete"),
            "certificate_available": False,
            "bounds_match": False,
            "raw_certificate": raw_certificate,
            "raw_certificate_payload": raw_certificate,
            "raw_subwindows": raw_subwindows_payload,
            "raw_subwindows_payload": raw_subwindows_payload,
            "proof_errors": ["native raw window_certificate is missing or invalid"],
        }

    expected_min, expected_max = map(float, expected_window)
    if solver.get("target_kind") != "frequency_window":
        errors.append("solver.target_kind is not frequency_window")
    if solver.get("window_complete") is not True:
        errors.append("solver.window_complete is not true")
    top_bounds = solver.get("requested_window_hz")
    top_bounds_match = (
        isinstance(top_bounds, list)
        and len(top_bounds) == 2
        and all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in top_bounds)
        and relative_delta(float(top_bounds[0]), expected_min) <= 1e-12
        and relative_delta(float(top_bounds[1]), expected_max) <= 1e-12
    )
    if not top_bounds_match:
        errors.append("solver.requested_window_hz does not exactly bind the requested interval")

    certificate_bounds = (
        certificate.get("requested_min_hz"),
        certificate.get("requested_max_hz"),
    )
    certificate_bounds_match = all(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and relative_delta(float(value), expected) <= 1e-12
        for value, expected in zip(
            certificate_bounds, (expected_min, expected_max), strict=True
        )
    )
    if not certificate_bounds_match:
        errors.append("raw window certificate bounds do not match the requested interval")
    if certificate.get("schema_version") != "poisson_airbox_frequency_window_certificate.v2":
        errors.append("raw window certificate schema is not the K0 v2 certificate")
    if certificate.get("status") != "certified":
        errors.append("raw window certificate status is not certified")
    if certificate.get("window_complete") is not True:
        errors.append("raw window certificate does not assert complete coverage")
    if certificate.get("spectrum_scope") not in {
        "complete_window",
        "frequency_window",
        "all_positive_modes_in_window",
    }:
        errors.append("raw window certificate does not declare a complete-window scope")

    count_certificate = certificate.get("count_certificate")
    certified_count = None
    if not isinstance(count_certificate, dict):
        errors.append("raw window certificate has no count_certificate object")
    else:
        if count_certificate.get("status") != "certified":
            errors.append("independent count_certificate.status is not certified")
        method = count_certificate.get("method")
        if not isinstance(method, str) or not method.strip():
            errors.append("independent count certificate method is missing")
        count = count_certificate.get("count")
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            errors.append("independent count certificate count is invalid")
        else:
            certified_count = count
            if count != expected_mode_count:
                errors.append(
                    f"independent count certificate reports {count}, expected {expected_mode_count}"
                )

    if solver.get("requested_mode_count") != expected_mode_count:
        errors.append("solver.requested_mode_count differs from the required independent count")
    if certificate.get("requested_mode_count") != expected_mode_count:
        errors.append("raw certificate requested_mode_count differs from the required count")
    if certificate.get("accepted_mode_count") != expected_mode_count:
        errors.append("raw certificate accepted_mode_count differs from the required count")
    if solver.get("accepted_mode_count") != expected_mode_count:
        errors.append("solver accepted_mode_count differs from the required count")
    if certificate.get("discovered_mode_count") != expected_mode_count:
        errors.append("raw certificate discovered_mode_count differs from the required count")
    if certified_count is not None and len(saved_modes) != certified_count:
        errors.append(
            f"saved mode count {len(saved_modes)} differs from certified count {certified_count}"
        )

    search_stability = certificate.get("search_stability")
    if not isinstance(search_stability, dict):
        errors.append("raw window certificate has no search_stability object")
    else:
        if search_stability.get("status") != "stable":
            errors.append("raw window search stability is not stable")
        if search_stability.get("requested_cluster_limit_covered") is not True:
            errors.append("raw window search does not prove requested cluster coverage")

    coverage = certificate.get("coverage_margins_hz")
    if not isinstance(coverage, dict):
        errors.append("raw window certificate lacks coverage margins")
    else:
        for edge in ("lower", "upper"):
            try:
                margin = finite_number(coverage.get(edge), f"coverage_margins_hz.{edge}")
                if margin <= 0.0:
                    errors.append(f"raw window {edge} coverage margin is not positive")
            except VerificationError as error:
                errors.append(str(error))

    cluster_frequencies = certificate.get("accepted_cluster_frequencies_hz")
    cluster_ranks = certificate.get("cluster_ranks")
    if not isinstance(cluster_frequencies, list) or not isinstance(cluster_ranks, list):
        errors.append("raw window certificate lacks accepted cluster frequencies or ranks")
    else:
        if len(cluster_frequencies) != len(cluster_ranks) or not cluster_ranks:
            errors.append("raw window accepted cluster frequencies and ranks are inconsistent")
        else:
            rank_total = 0
            for index, rank in enumerate(cluster_ranks):
                if isinstance(rank, bool) or not isinstance(rank, int) or rank <= 0:
                    errors.append(f"raw window cluster rank {index} is invalid")
                else:
                    rank_total += rank
            if rank_total != expected_mode_count:
                errors.append("raw window cluster ranks do not sum to the independent count")
            for index, value in enumerate(cluster_frequencies):
                try:
                    frequency = finite_number(value, f"accepted_cluster_frequencies_hz[{index}]")
                except VerificationError as error:
                    errors.append(str(error))
                    continue
                if not expected_min <= frequency <= expected_max:
                    errors.append("raw window accepted cluster frequency is outside the interval")

    schedule_summary: dict[str, Any] = {}
    for name in ("base_schedule", "refinement_schedule"):
        schedule = certificate.get(name)
        if not isinstance(schedule, dict):
            errors.append(f"raw window certificate lacks {name}")
            schedule_summary[name] = None
            continue
        planned = schedule.get("planned_subwindow_count")
        completed = schedule.get("completed_subwindow_count")
        failed_count = schedule.get("failed_subwindow_count")
        if schedule.get("state") != "completed":
            errors.append(f"{name}.state is not completed")
        if isinstance(planned, bool) or not isinstance(planned, int) or planned <= 0:
            errors.append(f"{name}.planned_subwindow_count is invalid")
            planned = None
        if isinstance(completed, bool) or not isinstance(completed, int):
            errors.append(f"{name}.completed_subwindow_count is invalid")
            completed = None
        if isinstance(failed_count, bool) or not isinstance(failed_count, int):
            errors.append(f"{name}.failed_subwindow_count is invalid")
            failed_count = None
        if planned is not None and completed != planned:
            errors.append(f"{name} completed count differs from planned count")
        if failed_count != 0:
            errors.append(f"{name} reports failed subwindows")
        if schedule.get("cancelled") is not False:
            errors.append(f"{name} does not prove it was not cancelled")
        schedule_summary[name] = {
            "state": schedule.get("state"),
            "planned_subwindow_count": planned,
            "completed_subwindow_count": completed,
            "failed_subwindow_count": failed_count,
            "cancelled": schedule.get("cancelled"),
        }

    if certificate.get("base_schedule_summary_ref") != "executed_subwindows_json#pass=base":
        errors.append("base schedule does not bind to raw executed subwindows")
    if certificate.get("refinement_schedule_summary_ref") != "executed_subwindows_json#pass=refinement":
        errors.append("refinement schedule does not bind to raw executed subwindows")

    expected_subwindow_total = sum(
        row["planned_subwindow_count"] or 0 for row in schedule_summary.values() if row
    )
    if raw_subwindows is None:
        errors.append("raw executed subwindows are missing")
        parsed_subwindows: list[Any] = []
    else:
        parsed_subwindows = raw_subwindows
    if len(parsed_subwindows) != expected_subwindow_total:
        errors.append("raw executed subwindow count differs from both schedules")
    for pass_name, schedule_name in (
        ("base", "base_schedule"),
        ("refinement", "refinement_schedule"),
    ):
        schedule = schedule_summary.get(schedule_name)
        if not schedule or schedule["planned_subwindow_count"] is None:
            continue
        entries = [
            row
            for row in parsed_subwindows
            if isinstance(row, dict) and row.get("pass") == pass_name
        ]
        indexes = [row.get("subwindow_index") for row in entries]
        if sorted(indexes) != list(range(schedule["planned_subwindow_count"])):
            errors.append(f"raw {pass_name} subwindow indexes are incomplete")
        for row in entries:
            if row.get("status") != "ok":
                errors.append(f"raw {pass_name} subwindow {row.get('subwindow_index')} did not succeed")
            accepted = row.get("accepted_frequencies_hz")
            if not isinstance(accepted, list):
                errors.append(f"raw {pass_name} subwindow has no accepted frequency list")
                continue
            for value in accepted:
                try:
                    frequency = finite_number(value, "accepted subwindow frequency")
                except VerificationError as error:
                    errors.append(str(error))
                    continue
                if frequency < expected_min or frequency > expected_max:
                    errors.append("raw executed subwindow includes a frequency outside the requested interval")

    saved_in_window = 0
    for mode in saved_modes:
        try:
            frequency = finite_number(
                mode.get("frequency_real_hz", mode.get("frequency_hz")),
                "saved window mode frequency",
            )
        except VerificationError as error:
            errors.append(str(error))
            continue
        if frequency <= 0.0 or not expected_min <= frequency <= expected_max:
            errors.append("saved spectrum contains a mode outside the positive requested window")
        else:
            saved_in_window += 1
    if saved_in_window != expected_mode_count:
        errors.append("saved positive in-window mode count differs from the independent count")

    return {
        "status": "certified" if not errors else "unproven",
        "window_complete": solver.get("window_complete"),
        "certificate_available": True,
        "certificate_schema": certificate.get("schema_version"),
        "certificate_status": certificate.get("status"),
        "expected_window_hz": expected_window,
        "expected_mode_count": expected_mode_count,
        "top_level_bounds_match": bool(top_bounds_match),
        "raw_certificate_bounds_match": bool(certificate_bounds_match),
        "certified_count": certified_count,
        "saved_positive_modes_in_window": saved_in_window,
        "schedule_summary": schedule_summary,
        "raw_certificate_sha256": canonical_sha256(certificate),
        "raw_certificate_payload": raw_certificate,
        "raw_certificate_payload_sha256": (
            hashlib.sha256(raw_certificate.encode("utf-8")).hexdigest()
            if isinstance(raw_certificate, str)
            else canonical_sha256(raw_certificate)
        ),
        "raw_certificate": certificate,
        "raw_subwindows": parsed_subwindows,
        "raw_subwindows_payload": raw_subwindows_payload,
        "raw_subwindows_payload_sha256": (
            hashlib.sha256(raw_subwindows_payload.encode("utf-8")).hexdigest()
            if isinstance(raw_subwindows_payload, str)
            else canonical_sha256(raw_subwindows_payload)
            if raw_subwindows_payload is not None
            else None
        ),
        "proof_errors": errors,
    }


def checkpoint_magnetization_sha256(vectors: Any, node_count: Any) -> str:
    if not isinstance(vectors, list) or len(vectors) != node_count or not vectors:
        fail("checkpoint magnetization does not have the pinned node count")
    digest = hashlib.sha256()
    for vector in vectors:
        if not isinstance(vector, list) or len(vector) != 3:
            fail("checkpoint magnetization contains an invalid vector")
        digest.update(struct.pack("<3d", *(
            finite_number(value, "checkpoint magnetization component") for value in vector
        )))
    return digest.hexdigest()


def verify_published_modal_equilibrium(artifacts: dict[str, Any]) -> dict[str, Any]:
    generation = Path(artifacts["generation_path"])
    members = artifacts["generation_members"]
    candidates = [
        f"eigen/metadata/equilibrium_artifact.{version}.json"
        for version in ("v7", "v8")
        if f"eigen/metadata/equilibrium_artifact.{version}.json" in members
    ]
    if len(candidates) != 1:
        fail("modal generation must declare exactly one equilibrium artifact")
    member, = candidates
    equilibrium, digest = load_generation_json(
        generation, members, member, "modal equilibrium"
    )
    content_digest = equilibrium.get("content_sha256")
    if (
        not isinstance(content_digest, str)
        or not content_digest.startswith("sha256:")
        or not SHA256_RE.fullmatch(content_digest[7:])
        or equilibrium.get("accepted_for_linearization") is not True
        or artifacts["solver"].get("equilibrium_artifact_sha256") != content_digest
    ):
        fail("solver does not bind the published certified equilibrium")
    node_counts: set[int] = set()
    for mode in artifacts["modes"]:
        mesh = mode.get("source_mesh_identity")
        node_count = mesh.get("node_count") if isinstance(mesh, dict) else None
        if (
            type(node_count) is not int
            or node_count <= 0
            or mode.get("equilibrium_artifact_sha256") != content_digest
        ):
            fail("saved modes do not bind one certified equilibrium and node indexing")
        node_counts.add(node_count)
    if len(node_counts) != 1:
        fail("saved modes have no common positive node count")
    node_count, = node_counts
    return {
        "artifact_file_sha256": digest,
        "artifact_content_sha256": content_digest,
        "magnetization_f64le_sha256": checkpoint_magnetization_sha256(
            equilibrium.get("m0"), node_count
        ),
        "node_count": node_count,
    }


def zero_step_gpu_relaxation_evidence(
    stage: Path, expected: dict[str, Any], artifacts: dict[str, Any]
) -> tuple[Path, dict[str, Any], list[Any], Path, dict[str, Any]]:
    metadata_path = stage / "metadata.json"
    metadata = load_json(metadata_path, "native GPU relaxation metadata")
    provenance = metadata.get("execution_provenance", {})
    minimizer = provenance.get("fem_gpu_minimizer_execution_receipt", {})
    accounting = minimizer.get("accounting", {})
    if (
        provenance.get("execution_engine") != "fem_native_gpu"
        or provenance.get("precision") != "double"
        or minimizer.get("schema_version") != "fullmag.fem.gpu.minimizer-execution-receipt.v1"
        or accounting.get("executed") != "cuda_fem_initial_equilibrium"
        or accounting.get("accepted_step_count") != 0
        or accounting.get("fallback_count") != 0
        or accounting.get("accounting_valid") is not True
    ):
        fail("checkpoint is missing the strict native GPU step-zero relaxation receipt")

    generation = Path(artifacts["generation_path"])
    members = artifacts["generation_members"]
    identity, _ = load_generation_json(
        generation, members, "eigen/metadata/sample_0000/linearization_identity.v2.json",
        "native relaxation handoff identity",
    )
    solver = artifacts["solver"]
    if (
        identity.get("schema_version") != "linearization_identity.v2"
        or identity.get("handoff_schema_version") != "AcceptedFemRelaxStageHandoff.v3"
        or identity.get("content_sha256") != solver.get("linearization_identity_sha256")
        or identity.get("handoff_content_sha256") != solver.get("relax_to_eigen_handoff_sha256")
        or identity.get("source_stage_kind") != "flat_relax"
        or identity.get("source_mesh_topology_sha256") != expected.get("native_mesh_topology_sha256")
        or identity.get("node_count") != expected.get("node_count")
    ):
        fail("native GPU relaxation handoff does not bind the published mode and mesh")
    member = "eigen/metadata/sample_0000/recomputed_fem_linearization_certificate.v1.json"
    certificate, digest = load_generation_json(generation, members, member, "native initial-equilibrium certificate")
    certificate_path = stage / "equilibrium/recomputed_fem_linearization_certificate.v1.json"
    if (
        identity.get("recomputed_certificate_path") != member
        or identity.get("recomputed_certificate_bytes_sha256") != "sha256:" + digest
        or identity.get("recomputed_certificate_content_sha256") != certificate.get("content_sha256")
        or sha256_file(certificate_path) != digest
    ):
        fail("native GPU relaxation certificate differs from the sealed modal handoff")
    state = load_json(stage / "m_final.json", "native GPU final magnetization")
    if state.get("step") != 0:
        fail("native GPU final magnetization was not observed at step zero")
    return metadata_path, metadata.get("completion"), state.get("values"), certificate_path, certificate


def verify_zero_step_checkpoint_observation(
    root: Path, expected: dict[str, Any], *, gpu_artifacts: dict[str, Any] | None = None
) -> dict[str, Any]:
    stage = root / "stages/stage_00_flat_relax"
    samples = stage / "fields/m.zarr/samples.csv"
    with samples.open(encoding="utf-8", newline="") as stream:
        rows = csv.DictReader(stream)
        first = next(rows, None)
        if first is None or first.get("step") != "0" or next(rows, None) is not None:
            fail("native checkpoint equilibrium must be certified at step zero")
    if gpu_artifacts is not None:
        receipt_path, completion, equilibrium, certificate_path, certificate = (
            zero_step_gpu_relaxation_evidence(stage, expected, gpu_artifacts)
        )
    else:
        receipt_paths = list(
            root.glob("artifacts/antenna/accepted_equilibria/*/relax_receipt.v3.json")
        )
        if len(receipt_paths) != 1:
            fail("checkpoint must publish exactly one native relaxation receipt")
        receipt_path = receipt_paths[0]
        receipt = load_json(receipt_path, "native initial-equilibrium receipt")
        if (
            receipt.get("schema_version") != "AcceptedFemRelaxStageHandoff.v3"
            or receipt.get("source_stage_kind") != "flat_relax"
            or receipt.get("source_mesh_topology_sha256")
            != expected.get("native_mesh_topology_sha256")
        ):
            fail("native initial-equilibrium receipt identifies a different stage or mesh")
        certificate_path = receipt_path.with_name("recomputed_certificate.v1.json")
        certificate = load_json(certificate_path, "native initial-equilibrium certificate")
        completion = receipt.get("completion")
        equilibrium = receipt.get("equilibrium_magnetization")
    if (
        certificate.get("status") != "matched"
        or certificate.get("mesh_topology_sha256") != expected.get("native_mesh_topology_sha256")
        or certificate.get("recompute_provider") != "native_fem_final_state_refresh.v1"
    ):
        fail("initial-equilibrium fields lack a matching native re-evaluation")
    if (
        not isinstance(completion, dict)
        or completion.get("status") != "completed"
        or completion.get("converged") is not True
        or completion.get("reason") != "torque"
        or completion.get("metric") != "max_torque_apm"
    ):
        fail("native initial equilibrium did not complete by torque")
    torque = finite_number(completion.get("metric_value"), "initial torque")
    threshold = finite_number(completion.get("threshold"), "initial torque threshold")
    allowed = 1.0e-6 / (4.0e-7 * math.pi)
    if not (0.0 <= torque <= threshold <= allowed and threshold > 0.0):
        fail("native initial equilibrium does not satisfy the pinned torque threshold")
    magnetization = checkpoint_magnetization_sha256(
        equilibrium, expected.get("node_count")
    )
    if magnetization != expected.get("magnetization_f64le_sha256"):
        fail("native recertification changed the pinned checkpoint magnetization")
    return {
        "accepted_steps": 0,
        "magnetization_f64le_sha256": magnetization,
        "mesh_topology_sha256": certificate["mesh_topology_sha256"],
        "torque_A_per_m": torque,
        "threshold_A_per_m": threshold,
        "receipt_file_sha256": sha256_file(receipt_path),
        "certificate_file_sha256": sha256_file(certificate_path),
    }


def verify_one_run(campaign_root: Path, run: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "case_id": run["case_id"],
        "pair_id": run["pair_id"],
        "family": run["family"],
        "analysis_group": run["analysis_group"],
        "execution_device_expected": run["execution_device"],
        "input_identity_sha256": run["input_identity_sha256"],
        "magnetic_hmax_nm": run.get("magnetic_hmax_nm"),
        "box_factor": run.get("box_factor"),
        "availability": "unavailable",
        "selected": "unproven",
        "complete": "incomplete",
        "errors": [],
    }
    run_root = campaign_root / run["output_path"]
    result["output_path"] = str(run_root)
    if not run_root.is_dir():
        result["errors"] = [f"run Zarr directory is missing: {run_root}"]
        return result
    result["availability"] = "available"

    try:
        artifacts = load_run_artifacts(run_root)
    except VerificationError as error:
        result["errors"] = [str(error)]
        return result

    solver = artifacts["solver"]
    result["artifact_root"] = artifacts["root"]
    mode_evidence, residual_errors = mode_residual_evidence(artifacts["modes"])
    selection = device_selection_proof(
        solver, artifacts["modes"], run["execution_device"]
    )
    result["selected"] = selection["status"]
    result["selection_proof"] = selection
    result["solver_diagnostics"] = solver
    result["solver_diagnostics_sha256"] = artifacts["solver_sha256"]
    result["generation_id"] = artifacts["generation_id"]
    result["saved_mode_count"] = artifacts["mode_count_saved"]
    result["mesh_mass_metric"] = artifacts["mesh_metric"]
    result["modes"] = mode_evidence
    errors = list(residual_errors)
    if solver.get("complete") is not True:
        errors.append("solver diagnostics complete is not true")
    if solver.get("full_residual_certified") is not True:
        errors.append("solver diagnostics full_residual_certified is not true")
    if solver.get("fallback_used") is not False:
        errors.append("solver diagnostics fallback_used is not false")
    errors.extend(selection["proof_errors"])

    window_result = None
    if run["family"] == "checkpoint_step_8006":
        window_result = window_completeness(
            solver,
            run["frequency_window_hz"],
            expected_mode_count=int(run["minimum_positive_mode_count"]),
            saved_modes=artifacts["modes"],
        )
        result["window_completeness"] = window_result
        errors.extend(window_result["proof_errors"])
        mode_frequencies = [
            finite_number(mode["frequency_hz"], "mode.frequency_hz")
            for mode in mode_evidence
        ]
        lower, upper = run["frequency_window_hz"]
        in_window = [
            value for value in mode_frequencies if lower <= value <= upper
        ]
        result["positive_modes_in_window"] = len(in_window)
        result["minimum_positive_mode_count"] = run[
            "minimum_positive_mode_count"
        ]
        if len(in_window) < run["minimum_positive_mode_count"]:
            errors.append(
                f"only {len(in_window)} saved positive modes in the requested "
                f"window; at least {run['minimum_positive_mode_count']} required"
            )
        expected_identity = run["input_identity"]
        checkpoint_identity = run.get("checkpoint_identity")
        if not isinstance(checkpoint_identity, dict):
            checkpoint_identity = expected_identity
        expected_mass_metric = checkpoint_identity.get(
            "reference_mesh_mass_metric"
        )
        if not isinstance(expected_mass_metric, dict):
            errors.append(
                "checkpoint run matrix lacks the pinned archive mesh mass metric"
            )
            expected_mass_metric = {}
        actual_mass_metric = artifacts["mesh_metric"]
        if actual_mass_metric["status"] == "available":
            for metric_key in (
                "node_mass_weights_sha256",
                "active_magnetic_node_count",
                "q_dof_count",
            ):
                if metric_key not in expected_mass_metric:
                    errors.append(
                        f"pinned archive mesh mass metric lacks {metric_key}"
                    )
                elif actual_mass_metric.get(metric_key) != expected_mass_metric[
                    metric_key
                ]:
                    errors.append(
                        f"run mesh mass metric {metric_key} differs from the pinned archive reference"
                    )
            expected_topology = expected_identity.get(
                "native_mesh_topology_sha256"
            )
            if actual_mass_metric.get("mesh_topology_sha256") != expected_topology:
                errors.append("run node mass weights identify a different mesh topology")
        result["archive_mesh_mass_metric_expected"] = expected_mass_metric
        expected_equilibrium_artifact = checkpoint_identity.get(
            "equilibrium_artifact_content_sha256"
        )
        if expected_identity.get("equilibrium_source") == "zero_step_native_recertification":
            try:
                proof = verify_zero_step_checkpoint_observation(
                    Path(artifacts["root"]), checkpoint_identity,
                    gpu_artifacts=artifacts if run["execution_device"] == "gpu" else None,
                )
                modal_equilibrium = verify_published_modal_equilibrium(artifacts)
                if modal_equilibrium["magnetization_f64le_sha256"] != proof["magnetization_f64le_sha256"]:
                    fail("published mode equilibrium changed the checkpoint magnetization")
                expected_equilibrium_artifact = modal_equilibrium["artifact_content_sha256"]
                proof["modal_equilibrium_file_sha256"] = modal_equilibrium["artifact_file_sha256"]
                result["checkpoint_zero_step_observation"] = proof
            except (OSError, VerificationError) as error:
                errors.append(str(error))
        mode_equilibrium_artifacts = {
            mode.get("equilibrium_artifact_sha256")
            for mode in artifacts["modes"]
        }
        if (
            not isinstance(expected_equilibrium_artifact, str)
            or not expected_equilibrium_artifact.startswith("sha256:")
        ):
            errors.append(
                "checkpoint run matrix lacks the pinned equilibrium artifact content hash"
            )
        if mode_equilibrium_artifacts != {expected_equilibrium_artifact}:
            errors.append(
                "saved modes do not all bind to the verified step-8006 equilibrium artifact"
            )
        solver_equilibrium_artifact = solver.get("equilibrium_artifact_sha256")
        if (
            solver_equilibrium_artifact != expected_equilibrium_artifact
        ):
            errors.append(
                "solver diagnostics bind to a different step-8006 equilibrium artifact"
            )
        result["checkpoint_equilibrium_artifact_proof"] = {
            "expected_content_sha256": expected_equilibrium_artifact,
            "mode_artifact_sha256_values": sorted(
                value for value in mode_equilibrium_artifacts if isinstance(value, str)
            ),
            "mode_artifact_hashes_match": (
                mode_equilibrium_artifacts == {expected_equilibrium_artifact}
            ),
            "solver_artifact_sha256": solver_equilibrium_artifact,
        }
        actual_topologies = {
            mode.get("source_mesh_topology_sha256")
            or (
                mode.get("source_mesh_identity", {}).get("topology_fingerprint")
                if isinstance(mode.get("source_mesh_identity"), dict)
                else None
            )
            for mode in artifacts["modes"]
        }
        if actual_topologies != {expected_identity["native_mesh_topology_sha256"]}:
            errors.append("saved modes do not prove the expected input mesh topology")

    else:
        try:
            equilibrium = verify_published_modal_equilibrium(artifacts)
            result["modal_equilibrium"] = equilibrium
            if run["execution_device"] == "gpu":
                result["kittel_zero_step_observation"] = verify_zero_step_checkpoint_observation(
                    Path(artifacts["root"]),
                    {
                        "node_count": equilibrium["node_count"],
                        "native_mesh_topology_sha256": solver.get("source_mesh_topology_sha256"),
                        "magnetization_f64le_sha256": equilibrium["magnetization_f64le_sha256"],
                    },
                    gpu_artifacts=artifacts,
                )
        except (OSError, VerificationError) as error:
            errors.append(str(error))
        result["kittel_expected_frequency_hz"] = (
            run["input_identity"]["analytic_reference"]["gamma_hz_per_t"]
            * run["input_identity"]["analytic_reference"]["bias_T"]
        )
        frequencies = [
            finite_number(mode["frequency_hz"], "mode.frequency_hz")
            for mode in mode_evidence
        ]
        if not frequencies:
            errors.append("Kittel case has no saved positive frequency")
        else:
            result["frequency_hz"] = frequencies[0]
            result["relative_kittel_error"] = relative_delta(
                frequencies[0], result["kittel_expected_frequency_hz"]
            )

    result["complete"] = "complete" if not errors else "incomplete"
    result["errors"] = errors
    result["_artifacts"] = artifacts
    return result


def complex_q_vector(mode: dict[str, Any]) -> tuple[list[float], list[float]]:
    real = mode.get("q_real")
    imag = mode.get("q_imag")
    if not isinstance(real, list) or not isinstance(imag, list) or len(real) != len(imag):
        fail(f"mode {mode.get('raw_mode_index')} lacks compatible complex q coefficients")
    if not real:
        fail(f"mode {mode.get('raw_mode_index')} has an empty q vector")
    real_values = [finite_number(value, "q_real") for value in real]
    imag_values = [finite_number(value, "q_imag") for value in imag]
    return real_values, imag_values


def phase_invariant_overlap(
    left: dict[str, Any],
    right: dict[str, Any],
    node_mass_weights: list[float],
) -> float:
    left_real, left_imag = complex_q_vector(left)
    right_real, right_imag = complex_q_vector(right)
    if len(left_real) != len(right_real):
        fail("phase-invariant q overlap requires equal q-vector dimensions")
    node_count = len(node_mass_weights)
    if node_count == 0 or len(left_real) != 2 * node_count:
        fail("mass-weighted q overlap requires two component blocks per weighted node")
    if any(not math.isfinite(weight) or weight <= 0.0 for weight in node_mass_weights):
        fail("mass-weighted q overlap requires positive finite node weights")
    inner_real_terms = []
    inner_imag_terms = []
    left_norm_terms = []
    right_norm_terms = []
    # Native modal q is block ordered: all first tangent components followed
    # by all second tangent components. Each active magnetic node's FE mass
    # weight therefore multiplies entries i and i + node_count.
    for block in (0, node_count):
        for node, weight in enumerate(node_mass_weights):
            index = block + node
            lr, li = left_real[index], left_imag[index]
            rr, ri = right_real[index], right_imag[index]
            inner_real_terms.append(weight * (lr * rr + li * ri))
            inner_imag_terms.append(weight * (lr * ri - li * rr))
            left_norm_terms.append(weight * (lr * lr + li * li))
            right_norm_terms.append(weight * (rr * rr + ri * ri))
    inner_real = math.fsum(inner_real_terms)
    inner_imag = math.fsum(inner_imag_terms)
    left_norm2 = math.fsum(left_norm_terms)
    right_norm2 = math.fsum(right_norm_terms)
    denominator = math.sqrt(left_norm2 * right_norm2)
    if not math.isfinite(denominator) or denominator <= 0.0:
        fail("phase-invariant q overlap has a zero or non-finite norm")
    overlap = math.hypot(inner_real, inner_imag) / denominator
    if overlap < -1e-12 or overlap > 1.0 + 1e-10:
        fail(f"phase-invariant q overlap is outside [0, 1]: {overlap}")
    return min(1.0, max(0.0, overlap))


def modal_subspace_metrics(
    cpu_modes: list[dict[str, Any]],
    gpu_modes: list[dict[str, Any]],
    node_mass_weights: list[float],
) -> dict[str, float]:
    import numpy as np

    if not cpu_modes or len(cpu_modes) != len(gpu_modes):
        fail("modal subspace comparison requires equally sized, nonempty clusters")
    weights = np.asarray(node_mass_weights, dtype=float)
    if not np.isfinite(weights).all() or (weights <= 0.0).any():
        fail("modal subspace requires finite and strictly positive FE weights")
    scale = np.sqrt(np.tile(weights, 2))

    def basis(modes: list[dict[str, Any]]) -> Any:
        columns = []
        for mode in modes:
            real, imag = complex_q_vector(mode)
            if len(real) != scale.size:
                fail("modal subspace coefficient dimension differs from the reference mass metric")
            column = scale * (np.asarray(real) + 1j * np.asarray(imag))
            norm = np.linalg.norm(column)
            if not math.isfinite(norm) or norm <= 0.0:
                fail("modal subspace contains a non-finite or zero-norm mode")
            columns.append(column / norm)
        vectors, triangular = np.linalg.qr(np.column_stack(columns), mode="reduced")
        if vectors.shape[1] != len(modes) or (np.abs(np.diag(triangular)) < 1e-12).any():
            fail("modal cluster does not have the reported independent dimension")
        return vectors

    cpu = basis(cpu_modes)
    gpu = basis(gpu_modes)
    cross = gpu.conj().T @ cpu
    left, singular_values, right = np.linalg.svd(cross, full_matrices=False)
    # Evaluate the projected residual directly to avoid cancellation in
    # sqrt(1 - sigma**2) for near-identical subspaces.
    sine = max(
        np.linalg.norm(cpu - gpu @ cross, ord=2),
        np.linalg.norm(gpu - cpu @ cross.conj().T, ord=2),
    )
    aligned = gpu @ (left @ right)
    return {
        "minimum_principal_overlap": float(np.clip(singular_values[-1], 0.0, 1.0)),
        "maximum_principal_angle_sine": float(np.clip(sine, 0.0, 1.0)),
        "aligned_relative_q_delta": float(np.linalg.norm(cpu - aligned) / math.sqrt(len(cpu_modes))),
    }


def maximum_overlap_assignment(weights: list[list[float]]) -> list[tuple[int, int]]:
    if not weights or not weights[0]:
        return []
    rows = len(weights)
    columns = len(weights[0])
    if any(len(row) != columns for row in weights):
        fail("overlap matrix rows have inconsistent lengths")
    transposed = rows > columns
    matrix = [list(row) for row in weights]
    if transposed:
        matrix = [list(row) for row in zip(*matrix, strict=True)]
    row_count = len(matrix)
    column_count = len(matrix[0])
    # Rectangular Hungarian algorithm for minimum cost; negative overlap
    # maximizes the phase-invariant modal match.
    u = [0.0] * (row_count + 1)
    v = [0.0] * (column_count + 1)
    p = [0] * (column_count + 1)
    way = [0] * (column_count + 1)
    for i in range(1, row_count + 1):
        p[0] = i
        j0 = 0
        minv = [math.inf] * (column_count + 1)
        used = [False] * (column_count + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = math.inf
            j1 = 0
            for j in range(1, column_count + 1):
                if used[j]:
                    continue
                current = -matrix[i0 - 1][j - 1] - u[i0] - v[j]
                if current < minv[j]:
                    minv[j] = current
                    way[j] = j0
                if minv[j] < delta:
                    delta = minv[j]
                    j1 = j
            for j in range(column_count + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break
    pairs = []
    for j in range(1, column_count + 1):
        if p[j] == 0:
            continue
        pair = (p[j] - 1, j - 1)
        pairs.append((pair[1], pair[0]) if transposed else pair)
    return sorted(pairs)


def mode_pair_comparison(
    left: dict[str, Any],
    right: dict[str, Any],
    *,
    minimum_overlap: float,
    maximum_relative_frequency_delta: float,
    expected_mode_count: int | None = None,
    mode_limit: int | None = None,
    frequency_window_hz: list[float] | None = None,
    reference_node_mass_weights: list[float] | None = None,
    reference_mesh_topology_sha256: str | None = None,
    reference_node_mass_weights_sha256: str | None = None,
    require_canonical_mesh_identity: bool = False,
) -> dict[str, Any]:
    left_artifacts = left.get("_artifacts")
    right_artifacts = right.get("_artifacts")
    if not isinstance(left_artifacts, dict) or not isinstance(right_artifacts, dict):
        return {
            "complete": False,
            "status": "unavailable",
            "errors": ["one or both run artifacts are unavailable"],
        }
    left_modes = left_artifacts["modes"]
    right_modes = right_artifacts["modes"]
    errors: list[str] = []
    assessment_errors: list[str] = []

    def topology(modes: list[dict[str, Any]]) -> str | None:
        for mode in modes:
            value = mode.get("source_mesh_topology_sha256")
            if value:
                return value
            identity = mode.get("source_mesh_identity")
            if isinstance(identity, dict) and identity.get("topology_fingerprint"):
                return identity["topology_fingerprint"]
        return None

    left_topology = topology(left_modes)
    right_topology = topology(right_modes)
    if not left_topology or left_topology != right_topology:
        errors.append("CPU/GPU saved modes do not prove the same mesh topology")

    def canonical_mesh_identity(
        modes: list[dict[str, Any]], label: str
    ) -> tuple[str | None, dict[str, Any] | None]:
        identities = [mode.get("source_mesh_identity") for mode in modes]
        if not identities or any(not isinstance(value, dict) for value in identities):
            errors.append(f"{label} saved modes lack canonical source_mesh_identity")
            return None, None
        typed_identities = [value for value in identities if isinstance(value, dict)]
        identity_hashes = {canonical_sha256(value) for value in typed_identities}
        if len(identity_hashes) != 1:
            errors.append(f"{label} saved modes disagree on canonical mesh identity")
            return None, None
        return next(iter(identity_hashes)), typed_identities[0]

    left_mesh_identity_sha256, left_mesh_identity = canonical_mesh_identity(
        left_modes, "CPU"
    )
    right_mesh_identity_sha256, right_mesh_identity = canonical_mesh_identity(
        right_modes, "GPU"
    )
    if require_canonical_mesh_identity and (
        left_mesh_identity_sha256 is None
        or right_mesh_identity_sha256 is None
        or left_mesh_identity_sha256 != right_mesh_identity_sha256
    ):
        errors.append(
            "CPU/GPU Kittel profiles do not prove canonical cached mesh identity equality"
        )

    left_metric = left_artifacts.get("mesh_metric", {})
    right_metric = right_artifacts.get("mesh_metric", {})
    external_reference_weights = reference_node_mass_weights is not None
    if reference_node_mass_weights is None:
        candidate = left_metric.get("_weights") if isinstance(left_metric, dict) else None
        if isinstance(candidate, list):
            reference_node_mass_weights = candidate
            reference_weight_source = left_metric.get("summary_path")
        else:
            errors.append("CPU/reference archive node mass weights are unavailable")
            reference_node_mass_weights = []
            reference_weight_source = None
    else:
        reference_weight_source = "pinned historical CPU archive metric"
    if not reference_node_mass_weights:
        errors.append("no positive FE node mass weights are available for modal overlap")
    actual_reference_weights_sha256 = (
        canonical_sha256(reference_node_mass_weights)
        if reference_node_mass_weights
        else None
    )
    if (
        reference_node_mass_weights_sha256 is not None
        and actual_reference_weights_sha256
        != reference_node_mass_weights_sha256
    ):
        errors.append("reference node mass weights differ from the pinned archive hash")
    if (
        reference_mesh_topology_sha256 is not None
        and reference_mesh_topology_sha256 != left_topology
    ):
        errors.append("reference node mass weights are bound to a different mesh topology")

    def weights_agree(candidate: object) -> bool:
        if not isinstance(candidate, list) or len(candidate) != len(reference_node_mass_weights):
            return False
        for expected, observed in zip(reference_node_mass_weights, candidate, strict=True):
            try:
                expected_value = finite_number(expected, "reference node mass weight")
                observed_value = finite_number(observed, "published node mass weight")
            except VerificationError:
                return False
            if expected_value <= 0.0 or observed_value <= 0.0:
                return False
            if abs(expected_value - observed_value) > max(
                abs(expected_value), abs(observed_value), 1e-300
            ) * 1e-12:
                return False
        return True

    for label, metric in (("CPU", left_metric), ("GPU", right_metric)):
        if not isinstance(metric, dict) or metric.get("status") != "available":
            continue
        if metric.get("mesh_topology_sha256") != left_topology:
            errors.append(f"{label} node mass weights identify a different mesh topology")
        if metric.get("active_magnetic_node_count") != len(reference_node_mass_weights):
            errors.append(f"{label} node mass weight count differs from the reference")
        if not weights_agree(metric.get("_weights")):
            errors.append(f"{label} published node mass weights differ from the overlap reference")
    if (
        not external_reference_weights
        and isinstance(left_metric, dict)
        and left_metric.get("status") != "available"
        and not errors
    ):
        errors.append("CPU mesh mass metric is unavailable")

    for label, modes in (("CPU", left_modes), ("GPU", right_modes)):
        for mode in modes:
            mode_topology = mode.get("source_mesh_topology_sha256")
            if mode_topology != left_topology:
                errors.append(f"{label} mode {mode.get('raw_mode_index')} has a different topology")
            try:
                real, _ = complex_q_vector(mode)
                if len(real) != 2 * len(reference_node_mass_weights):
                    errors.append(
                        f"{label} mode {mode.get('raw_mode_index')} q dimension differs from the reference mass metric"
                    )
            except VerificationError as error:
                errors.append(str(error))

    def in_scope(mode: dict[str, Any]) -> bool:
        if frequency_window_hz is None:
            return True
        frequency = mode.get("frequency_real_hz", mode.get("frequency_hz"))
        try:
            value = finite_number(frequency, "mode frequency")
        except VerificationError:
            return False
        return frequency_window_hz[0] <= value <= frequency_window_hz[1]

    left_modes = [mode for mode in left_modes if in_scope(mode)]
    right_modes = [mode for mode in right_modes if in_scope(mode)]
    if mode_limit is not None:
        left_modes = left_modes[:mode_limit]
        right_modes = right_modes[:mode_limit]
    if not left_modes or not right_modes:
        return {
            "complete": False,
            "status": "unavailable",
            "errors": errors + ["no common saved modes are available"],
        }

    try:
        weights = [
            [
                phase_invariant_overlap(cpu, gpu, reference_node_mass_weights)
                for gpu in right_modes
            ]
            for cpu in left_modes
        ]
    except VerificationError as error:
        return {
            "complete": False,
            "status": "unavailable",
            "errors": errors + [str(error)],
        }
    assignment = maximum_overlap_assignment(weights)
    mode_rows = []
    for left_index, right_index in assignment:
        cpu = left_modes[left_index]
        gpu = right_modes[right_index]
        cpu_frequency = finite_number(
            cpu.get("frequency_real_hz", cpu.get("frequency_hz")),
            "CPU mode frequency",
        )
        gpu_frequency = finite_number(
            gpu.get("frequency_real_hz", gpu.get("frequency_hz")),
            "GPU mode frequency",
        )
        overlap = weights[left_index][right_index]
        frequency_delta = relative_delta(cpu_frequency, gpu_frequency)
        mode_rows.append(
            {
                "cpu_raw_mode_index": cpu.get("raw_mode_index"),
                "gpu_raw_mode_index": gpu.get("raw_mode_index"),
                "cpu_frequency_hz": cpu_frequency,
                "gpu_frequency_hz": gpu_frequency,
                "relative_frequency_delta": frequency_delta,
                "phase_invariant_q_overlap": overlap,
                "overlap_within_budget": overlap >= minimum_overlap,
                "frequency_within_budget": (
                    frequency_delta <= maximum_relative_frequency_delta
                ),
            }
        )

    if expected_mode_count is not None and (
        len(left_modes) < expected_mode_count or len(right_modes) < expected_mode_count
    ):
        errors.append(
            f"fewer than {expected_mode_count} modes available for the required comparison"
        )
    if len(assignment) != min(len(left_modes), len(right_modes)):
        errors.append("maximum-overlap assignment did not cover all common modes")
    if len(left_modes) != len(right_modes):
        assessment_errors.append(
            f"saved CPU/GPU mode counts differ: {len(left_modes)} vs {len(right_modes)}"
        )
    clusters: list[list[int]] = []
    for index in sorted(range(len(mode_rows)), key=lambda i: mode_rows[i]["cpu_frequency_hz"]):
        frequency = mode_rows[index]["cpu_frequency_hz"]
        if clusters:
            first = mode_rows[clusters[-1][0]]["cpu_frequency_hz"]
            if frequency - first <= max(1.0, 1e-8 * abs(first)):
                clusters[-1].append(index)
                continue
        clusters.append([index])

    cluster_rows = []
    for cluster in clusters:
        cpu_frequencies = sorted(mode_rows[i]["cpu_frequency_hz"] for i in cluster)
        gpu_frequencies = sorted(mode_rows[i]["gpu_frequency_hz"] for i in cluster)
        try:
            profile = modal_subspace_metrics(
                [left_modes[assignment[i][0]] for i in cluster],
                [right_modes[assignment[i][1]] for i in cluster],
                reference_node_mass_weights,
            )
        except (VerificationError, ImportError, ArithmeticError, ValueError) as error:
            errors.append(f"could not compare modal cluster near {cpu_frequencies[0]} Hz: {error}")
            continue
        frequency_delta = max(
            relative_delta(cpu_frequency, gpu_frequency)
            for cpu_frequency, gpu_frequency in zip(cpu_frequencies, gpu_frequencies, strict=True)
        )
        within_budgets = (
            frequency_delta <= maximum_relative_frequency_delta
            and profile["minimum_principal_overlap"] >= minimum_overlap
            and profile["maximum_principal_angle_sine"] <= 1e-8
            and profile["aligned_relative_q_delta"] <= 1e-7
        )
        cluster_rows.append({
            "cpu_frequencies_hz": cpu_frequencies,
            "gpu_frequencies_hz": gpu_frequencies,
            "maximum_relative_frequency_delta": frequency_delta,
            "within_budgets": within_budgets,
            **profile,
        })
        if not within_budgets:
            assessment_errors.append(f"modal cluster near {cpu_frequencies[0]} Hz exceeds parity budgets")

    complete = not errors
    return {
        "complete": complete,
        "status": "complete" if complete else "incomplete",
        "parity_assessment": (
            "within_budgets" if complete and not assessment_errors
            else "outside_budgets" if complete
            else "not_assessed"
        ),
        "topology_sha256": left_topology,
        "cpu_canonical_mesh_identity_sha256": left_mesh_identity_sha256,
        "gpu_canonical_mesh_identity_sha256": right_mesh_identity_sha256,
        "canonical_mesh_identity_equal": (
            left_mesh_identity_sha256 is not None
            and left_mesh_identity_sha256 == right_mesh_identity_sha256
        ),
        "overlap_definition": (
            "absolute normalized complex product over native block-ordered q coefficients, weighted by the diagonal of the consistent P1 mass matrix in both tangent blocks"
        ),
        "overlap_node_mass_weights_sha256": canonical_sha256(
            reference_node_mass_weights
        ),
        "overlap_node_count": len(reference_node_mass_weights),
        "reference_node_mass_weights_sha256_expected": reference_node_mass_weights_sha256,
        "reference_mesh_topology_sha256_expected": reference_mesh_topology_sha256,
        "overlap_weight_reference": reference_weight_source,
        "frequency_window_hz": frequency_window_hz,
        "minimum_mode_count": expected_mode_count,
        "mode_limit": mode_limit,
        "minimum_overlap_budget": minimum_overlap,
        "maximum_relative_frequency_delta_budget": maximum_relative_frequency_delta,
        "cpu_mode_count_compared": len(left_modes),
        "gpu_mode_count_compared": len(right_modes),
        "mode_matches": mode_rows,
        "cluster_matches": cluster_rows,
        "maximum_principal_angle_sine_budget": 1e-8,
        "maximum_aligned_relative_q_delta_budget": 1e-7,
        "assessment_errors": assessment_errors,
        "errors": errors,
    }


def verify_historical_cpu_reference(
    manifest: dict[str, Any], override_root: Path | None
) -> dict[str, Any]:
    reference = manifest["inputs"]["historical_cpu_reference"]
    root = override_root.resolve() if override_root else Path(reference["zarr_path"])
    verification_path = (
        override_root.parent / "verification.json"
        if override_root
        else Path(reference["verification_path"])
    )
    result = {
        "root": str(root),
        "availability": "unavailable",
        "selected": "unproven",
        "complete": "incomplete",
        "spectrum_scope": "selected_only",
        "errors": [],
    }
    try:
        errors: list[str] = []
        verification = load_json(verification_path, "historical CPU verification")
        if sha256_file(verification_path) != reference["verification_sha256"] and not override_root:
            fail("historical CPU verification hash differs from the staged matrix")
        if verification.get("equilibrium_step") != 8006:
            fail("historical CPU verification is not step 8006")
        if verification.get("device") != "cpu":
            fail("historical CPU verification does not prove CPU")
        if verification.get("spectrum_completeness") != "selected_only":
            fail("historical CPU verification scope is not selected_only")
        if verification.get("input_mesh_sha256") != reference.get(
            "input_mesh_sha256"
        ):
            fail("historical CPU verification binds a different input mesh")
        if verification.get("equilibrium_sha256") != reference.get(
            "magnetization_f64le_sha256"
        ):
            fail("historical CPU verification binds a different equilibrium field")
        if verification.get("native_mesh_topology_sha256") != reference.get(
            "native_mesh_topology_sha256"
        ):
            fail("historical CPU verification binds a different mesh topology")
        if verification.get("certification", {}).get(
            "full_residual_certified"
        ) is not True:
            fail("historical CPU verification lacks full residual certification")
        reference_script = Path(reference["script_path"])
        if override_root is not None and not reference_script.is_file():
            reference_script = override_root.resolve().parent / reference_script.name
            if sha256_file(verification_path) != reference["verification_sha256"]:
                fail("relocated historical CPU verification hash differs from the staged matrix")
        if not reference_script.is_file() or sha256_file(reference_script) != reference.get(
            "script_sha256"
        ):
            fail("historical CPU reference script is missing or its hash differs")
        artifacts = load_run_artifacts(root)
        result["availability"] = "available"
        result["solver_diagnostics_sha256"] = artifacts["solver_sha256"]
        result["saved_mode_count"] = artifacts["mode_count_saved"]
        result["certified_positive_frequencies"] = verification.get(
            "certified_positive_frequencies"
        )
        result["verification"] = verification
        archived_metric = artifacts["mesh_metric"]
        expected_metric = reference.get("mesh_mass_metric", {})
        result["mesh_mass_metric"] = {
            key: value
            for key, value in archived_metric.items()
            if not key.startswith("_")
        }
        if archived_metric.get("status") != "available":
            errors.extend(archived_metric.get("errors", []))
        else:
            if artifacts.get("generation_id") != expected_metric.get("generation_id"):
                errors.append(
                    "historical CPU archive generation identity differs from the run matrix"
                )
            for key in (
                "summary_sha256",
                "node_mass_weights_sha256",
                "active_magnetic_node_count",
                "q_dof_count",
                "mesh_topology_sha256",
            ):
                if archived_metric.get(key) != expected_metric.get(key):
                    errors.append(
                        f"historical CPU archive mesh mass metric {key} differs from the run matrix"
                    )
        residuals, residual_errors = mode_residual_evidence(artifacts["modes"])
        result["modes"] = residuals
        selection = device_selection_proof(artifacts["solver"], artifacts["modes"], "cpu")
        result["selection_proof"] = selection
        result["selected"] = selection["status"]
        errors.extend(residual_errors)
        errors.extend(selection["proof_errors"])
        if len(artifacts["modes"]) < 10:
            errors.append("historical CPU reference has fewer than ten saved modes")
        if artifacts["solver"].get("demag_kind") != "open_airbox_k0":
            errors.append("historical CPU reference is not open_airbox_k0")
        if artifacts["solver"].get("full_residual_certified") is not True:
            errors.append("historical CPU full residual certificate is absent")
        result["complete"] = (
            "complete_for_selected_scope" if not errors else "incomplete"
        )
        result["errors"] = errors
        result["_artifacts"] = artifacts
    except (VerificationError, OSError) as error:
        result["errors"] = [str(error)]
    return result


def compare_pairs(
    manifest: dict[str, Any],
    run_results: list[dict[str, Any]],
    baseline: dict[str, Any],
    *,
    minimum_overlap: float,
    maximum_relative_frequency_delta: float,
) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    by_case = {row["case_id"]: row for row in run_results}
    for run in manifest["runs"]:
        grouped.setdefault(run["pair_id"], []).append(by_case[run["case_id"]])
    comparisons: list[dict[str, Any]] = []
    for pair_id, rows in grouped.items():
        cpu = next((row for row in rows if row["execution_device_expected"] == "cpu"), None)
        gpu = next((row for row in rows if row["execution_device_expected"] == "gpu"), None)
        family = rows[0]["family"]
        result = {
            "pair_id": pair_id,
            "family": family,
            "complete": False,
            "status": "incomplete",
            "cpu_case_id": cpu["case_id"] if cpu else None,
            "gpu_case_id": gpu["case_id"] if gpu else None,
        }
        if not cpu or not gpu:
            result["errors"] = ["CPU/GPU pair is missing a lane"]
            comparisons.append(result)
            continue
        if cpu["input_identity_sha256"] != gpu["input_identity_sha256"]:
            result["errors"] = ["CPU and GPU input identity hashes differ"]
            comparisons.append(result)
            continue
        if not isinstance(cpu.get("_artifacts"), dict) or not isinstance(
            gpu.get("_artifacts"), dict
        ):
            result["errors"] = ["CPU or GPU mode artifacts are unavailable"]
            comparisons.append(result)
            continue
        if family == "kittel_sphere":
            cpu_m0 = cpu.get("modal_equilibrium", {}).get("magnetization_f64le_sha256")
            gpu_m0 = gpu.get("modal_equilibrium", {}).get("magnetization_f64le_sha256")
            if not isinstance(cpu_m0, str) or not SHA256_RE.fullmatch(cpu_m0) or not gpu_m0:
                result["errors"] = ["one or both Kittel equilibria are unverified"]
                comparisons.append(result)
                continue
            if cpu_m0 != gpu_m0:
                result["errors"] = ["CPU and GPU Kittel equilibria differ"]
                comparisons.append(result)
                continue
            result["common_equilibrium_magnetization_f64le_sha256"] = cpu_m0
        expected_mode_count = (
            int(manifest["expectations"]["checkpoint_window"]["minimum_positive_mode_count"])
            if family == "checkpoint_step_8006"
            else 1
        )
        reference_weights = None
        reference_topology = None
        reference_weights_sha256 = None
        if family == "checkpoint_step_8006":
            baseline_artifacts = baseline.get("_artifacts")
            baseline_metric = (
                baseline_artifacts.get("mesh_metric")
                if isinstance(baseline_artifacts, dict)
                else None
            )
            if not isinstance(baseline_metric, dict) or not isinstance(
                baseline_metric.get("_weights"), list
            ):
                result["errors"] = [
                    "historical CPU archive FE node mass weights are unavailable"
                ]
                comparisons.append(result)
                continue
            reference_weights = baseline_metric["_weights"]
            reference_topology = baseline_metric.get("mesh_topology_sha256")
            reference_weights_sha256 = baseline_metric.get(
                "node_mass_weights_sha256"
            )
        comparison = mode_pair_comparison(
            cpu,
            gpu,
            minimum_overlap=minimum_overlap,
            maximum_relative_frequency_delta=maximum_relative_frequency_delta,
            expected_mode_count=expected_mode_count,
            frequency_window_hz=(
                manifest["expectations"]["checkpoint_window"]["frequency_window_hz"]
                if family == "checkpoint_step_8006"
                else None
            ),
            reference_node_mass_weights=reference_weights,
            reference_mesh_topology_sha256=reference_topology,
            reference_node_mass_weights_sha256=reference_weights_sha256,
            require_canonical_mesh_identity=family == "kittel_sphere",
        )
        result["cpu_run_completeness"] = cpu["complete"]
        result["gpu_run_completeness"] = gpu["complete"]
        result.update(comparison)
        selected_artifact_comparison_complete = comparison.get("complete") is True
        both_runs_complete = (
            cpu.get("complete") == "complete"
            and gpu.get("complete") == "complete"
        )
        result["selected_mode_artifact_comparison_complete"] = (
            selected_artifact_comparison_complete
        )
        if not both_runs_complete:
            result.setdefault("errors", []).append(
                "CPU/GPU run evidence is incomplete for the requested scientific scope"
            )
        result["complete"] = selected_artifact_comparison_complete and both_runs_complete
        result["status"] = "complete" if result["complete"] else "incomplete"
        if family == "checkpoint_step_8006":
            baseline_artifacts = baseline.get("_artifacts")
            if not isinstance(baseline_artifacts, dict):
                result["complete"] = False
                result["status"] = "incomplete"
                result.setdefault("errors", []).append(
                    "historical selected CPU reference artifacts are unavailable"
                )
            else:
                baseline_result = {
                    "_artifacts": baseline_artifacts,
                }
                baseline_cpu_comparison = mode_pair_comparison(
                    baseline_result,
                    cpu,
                    minimum_overlap=minimum_overlap,
                    maximum_relative_frequency_delta=maximum_relative_frequency_delta,
                    expected_mode_count=10,
                    mode_limit=10,
                    frequency_window_hz=manifest["expectations"][
                        "checkpoint_window"
                    ]["frequency_window_hz"],
                    reference_node_mass_weights=baseline_metric["_weights"],
                    reference_mesh_topology_sha256=baseline_metric.get(
                        "mesh_topology_sha256"
                    ),
                    reference_node_mass_weights_sha256=baseline_metric.get(
                        "node_mass_weights_sha256"
                    ),
                )
                result["historical_cpu_selected_reference_comparison"] = (
                    baseline_cpu_comparison
                )
                result["historical_cpu_reference_scope"] = "selected_only_top_10"
        comparisons.append(result)
    return comparisons


def convergence_sequence(
    rows: list[dict[str, Any]],
    *,
    axis_name: str,
    expected_values: list[float],
    expected_frequency_hz: float,
) -> dict[str, Any]:
    present = {}
    for row in rows:
        axis_value = row.get(axis_name)
        frequency = row.get("frequency_hz")
        availability = row.get(
            "availability",
            "available" if row.get("complete") == "complete" else "unavailable",
        )
        if (
            availability == "available"
            and isinstance(axis_value, (int, float))
            and isinstance(frequency, (int, float))
            and math.isfinite(float(frequency))
        ):
            present[float(axis_value)] = row
    ordered = list(expected_values)
    entries = []
    missing = []
    for value in ordered:
        row = present.get(float(value))
        if row is None:
            missing.append(value)
            entries.append(
                {
                    axis_name: value,
                    "availability": "unavailable",
                    "frequency_hz": None,
                    "relative_kittel_error": None,
                    "run_completeness": "unavailable",
                    "selection": "unproven",
                }
            )
        else:
            frequency = float(row["frequency_hz"])
            entries.append(
                {
                    axis_name: value,
                    "availability": "available",
                    "frequency_hz": frequency,
                    "relative_kittel_error": relative_delta(
                        frequency, expected_frequency_hz
                    ),
                    "run_completeness": row.get("complete", "unknown"),
                    "selection": row.get("selected", "unknown"),
                }
            )
    errors = [entry["relative_kittel_error"] for entry in entries]
    observed_decrease = (
        not missing
        and len(errors) >= 3
        and all(errors[index + 1] <= errors[index] for index in range(len(errors) - 1))
        and any(errors[index + 1] < errors[index] for index in range(len(errors) - 1))
    )
    all_evidence_complete = all(
        entry["run_completeness"] == "complete"
        and entry["selection"] in {"proven", "unknown"}
        for entry in entries
    )
    adjacent = []
    for left, right in zip(entries, entries[1:]):
        if left["frequency_hz"] is not None and right["frequency_hz"] is not None:
            adjacent.append(
                {
                    "coarser_value": left[axis_name],
                    "finer_value": right[axis_name],
                    "relative_frequency_delta": relative_delta(
                        left["frequency_hz"], right["frequency_hz"]
                    ),
                }
            )
    return {
        "axis": axis_name,
        "expected_values_coarse_to_fine": ordered,
        "entries": entries,
        "adjacent_relative_frequency_deltas": adjacent,
        "availability": "complete" if not missing else "partial",
        "convergence_assessment": (
            "observed_decrease_to_kittel_reference"
            if observed_decrease and all_evidence_complete
            else "observed_decrease_with_incomplete_run_evidence"
            if observed_decrease
            else "not_monotonic_or_incomplete"
        ),
        "missing_axis_values": missing,
    }


def convergence_assessments(
    manifest: dict[str, Any], run_results: list[dict[str, Any]]
) -> dict[str, Any]:
    kittel_runs = [
        row for row in run_results if row["family"] == "kittel_sphere"
    ]
    expected_frequency = float(
        manifest["expectations"]["kittel"]["expected_frequency_hz"]
    )
    results = {}
    for device in ("cpu", "gpu"):
        device_rows = [
            row for row in kittel_runs
            if row["execution_device_expected"] == device
        ]
        mesh_rows = [
            row for row in device_rows
            if row.get("box_factor") == 8.0
        ]
        airbox_rows = [
            row for row in device_rows
            if row.get("magnetic_hmax_nm") == 4.0
        ]
        results[device] = {
            "mesh_refinement": convergence_sequence(
                mesh_rows,
                axis_name="magnetic_hmax_nm",
                expected_values=manifest["expectations"]["kittel"][
                    "mesh_refinement_h_nm"
                ],
                expected_frequency_hz=expected_frequency,
            ),
            "airbox_refinement": convergence_sequence(
                airbox_rows,
                axis_name="box_factor",
                expected_values=manifest["expectations"]["kittel"][
                    "airbox_refinement_box_factors"
                ],
                expected_frequency_hz=expected_frequency,
            ),
        }
    return results


def strip_internal(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: strip_internal(item)
            for key, item in value.items()
            if not key.startswith("_")
        }
    if isinstance(value, list):
        return [strip_internal(item) for item in value]
    return value


def verify_staged_equilibrium_artifact(
    campaign_root: Path, expected: dict[str, Any]
) -> dict[str, Any]:
    errors: list[str] = []
    relative = expected.get("equilibrium_artifact_path")
    try:
        resolved_path = resolve_campaign_entry(
            campaign_root,
            relative,
            "step-8006 equilibrium artifact",
            expected_kind="file",
        )
    except VerificationError as error:
        return {
            "status": "invalid",
            "path": str(campaign_root / str(relative)),
            "errors": [str(error)],
        }
    actual_file_sha256 = sha256_file(resolved_path)
    expected_file_sha256 = expected.get("equilibrium_artifact_file_sha256")
    if actual_file_sha256 != expected_file_sha256:
        errors.append("staged equilibrium artifact file SHA-256 differs from the run matrix")
    try:
        artifact = load_json(resolved_path, "staged step-8006 equilibrium artifact")
    except VerificationError as error:
        return {
            "status": "invalid",
            "path": str(resolved_path),
            "file_sha256": actual_file_sha256,
            "errors": errors + [str(error)],
        }
    content_sha256 = artifact.get("content_sha256")
    if content_sha256 != expected.get("equilibrium_artifact_content_sha256"):
        errors.append("staged equilibrium artifact content identity differs from the run matrix")
    if artifact.get("schema_version") != "equilibrium_artifact.v7":
        errors.append("staged equilibrium artifact schema is not v7")
    if artifact.get("accepted_for_linearization") is not True:
        errors.append("staged equilibrium artifact is not accepted for linearization")
    expected_id = (
        "equilibrium_artifact.v7:"
        + str(content_sha256).removeprefix("sha256:")
        if isinstance(content_sha256, str)
        else None
    )
    if artifact.get("equilibrium_id") != expected_id:
        errors.append("staged equilibrium artifact id does not bind its content hash")

    completion_sha256 = artifact.get("completion_sha256")
    certificate = artifact.get("acceptance_certificate")
    if not isinstance(certificate, dict):
        errors.append("staged equilibrium artifact acceptance certificate is missing")
        certificate = {}
    if not isinstance(completion_sha256, str) or not SHA256_RE.fullmatch(
        completion_sha256.removeprefix("sha256:")
    ):
        errors.append("staged equilibrium artifact completion hash is invalid")
    if certificate.get("completion_sha256") != completion_sha256:
        errors.append("equilibrium artifact and acceptance certificate completion hashes differ")
    if certificate.get("status") != "completed" or certificate.get("converged") is not True:
        errors.append("staged equilibrium acceptance certificate is not converged")
    if certificate.get("criterion") != "torque" or certificate.get("unit") != "A/m":
        errors.append("staged equilibrium acceptance certificate is not a torque certificate")
    try:
        metric_value = finite_number(
            certificate.get("metric_value"), "equilibrium acceptance metric_value"
        )
        threshold = finite_number(
            certificate.get("threshold"), "equilibrium acceptance threshold"
        )
        if threshold <= 0.0 or metric_value < 0.0 or metric_value > threshold:
            errors.append("staged equilibrium torque does not satisfy its acceptance threshold")
    except VerificationError as error:
        metric_value = None
        threshold = None
        errors.append(str(error))

    raw_m0 = artifact.get("m0")
    node_count = expected.get("node_count")
    m0_sha256 = None
    if (
        isinstance(node_count, bool)
        or not isinstance(node_count, int)
        or not isinstance(raw_m0, list)
        or len(raw_m0) != node_count
    ):
        errors.append("staged equilibrium m0 shape differs from the exact checkpoint node count")
    else:
        flattened: list[float] = []
        for node_index, vector in enumerate(raw_m0):
            if not isinstance(vector, list) or len(vector) != 3:
                errors.append(f"staged equilibrium m0[{node_index}] is not a 3-vector")
                flattened = []
                break
            try:
                flattened.extend(
                    finite_number(value, f"staged equilibrium m0[{node_index}]")
                    for value in vector
                )
            except VerificationError as error:
                errors.append(str(error))
                flattened = []
                break
        if flattened:
            try:
                payload = struct.pack("<" + "d" * len(flattened), *flattened)
                m0_sha256 = hashlib.sha256(payload).hexdigest()
            except (OverflowError, struct.error) as error:
                errors.append(f"cannot encode staged equilibrium m0 as little-endian f64: {error}")
    if m0_sha256 != expected.get("magnetization_f64le_sha256"):
        errors.append("staged equilibrium artifact m0 bytes differ from the checkpoint field hash")

    return {
        "status": "verified" if not errors else "invalid",
        "path": str(resolved_path),
        "file_sha256": actual_file_sha256,
        "expected_file_sha256": expected_file_sha256,
        "content_sha256": content_sha256,
        "expected_content_sha256": expected.get("equilibrium_artifact_content_sha256"),
        "completion_sha256": completion_sha256,
        "m0_scalar_count": len(raw_m0) * 3 if isinstance(raw_m0, list) else None,
        "m0_f64le_sha256": m0_sha256,
        "acceptance_certificate": certificate,
        "torque_metric_value_A_per_m": metric_value,
        "torque_threshold_A_per_m": threshold,
        "errors": errors,
    }


def verify_staged_inputs(
    campaign_root: Path, manifest: dict[str, Any]
) -> dict[str, Any]:
    expected = manifest["inputs"]["step_8006"]
    errors = []
    mesh_relative = PurePosixPath("inputs/checkpoint_step_8006") / str(
        expected.get("mesh_filename", "")
    )
    equilibrium_relative = PurePosixPath("inputs/checkpoint_step_8006") / str(
        expected.get("equilibrium_filename", "")
    )
    try:
        mesh_path = resolve_campaign_entry(
            campaign_root,
            str(mesh_relative),
            "staged input mesh",
            expected_kind="file",
        )
    except VerificationError as error:
        mesh_path = campaign_root / str(mesh_relative)
        errors.append(str(error))
    try:
        equilibrium_path = resolve_campaign_entry(
            campaign_root,
            str(equilibrium_relative),
            "staged equilibrium tree",
            expected_kind="directory",
        )
    except VerificationError as error:
        equilibrium_path = campaign_root / str(equilibrium_relative)
        errors.append(str(error))
    if not mesh_path.is_file():
        errors.append(f"staged input mesh is missing: {mesh_path}")
    else:
        actual_mesh_sha = sha256_file(mesh_path)
        if actual_mesh_sha != expected["input_mesh_sha256"]:
            errors.append(
                f"staged input mesh SHA-256 differs: {actual_mesh_sha}"
            )
    try:
        actual_tree = tree_sha256(equilibrium_path)
    except VerificationError as error:
        actual_tree = None
        errors.append(str(error))
    if actual_tree is not None and actual_tree.get("tree_sha256") != expected[
        "equilibrium_tree"
    ]["tree_sha256"]:
        errors.append("staged equilibrium tree SHA-256 differs from the run matrix")

    attrs = None
    attrs_path = equilibrium_path / ".zattrs"
    if attrs_path.is_file():
        try:
            attrs = load_json(attrs_path, "staged equilibrium attributes")
        except VerificationError as error:
            errors.append(str(error))
    else:
        errors.append(f"staged equilibrium attributes are missing: {attrs_path}")
    if attrs is not None:
        if attrs.get("sequence_step") != expected["sequence_step"]:
            errors.append("staged equilibrium sequence step differs")
        if attrs.get("input_mesh_sha256") != expected["input_mesh_sha256"]:
            errors.append("staged equilibrium names a different input mesh")
        if attrs.get("magnetization_f64le_sha256") != expected[
            "magnetization_f64le_sha256"
        ]:
            errors.append("staged equilibrium magnetization identity differs")
        if attrs.get("equilibrium_certified") is not True:
            errors.append("staged equilibrium is not certified")
        if attrs.get("completion", {}).get("converged") is not True:
            errors.append("staged equilibrium is not converged")
        if attrs.get("linearization_certificate", {}).get(
            "mesh_topology_sha256"
        ) != expected["native_mesh_topology_sha256"]:
            errors.append("staged equilibrium mesh topology differs")
    equilibrium_artifact = verify_staged_equilibrium_artifact(
        campaign_root, expected
    )
    errors.extend(equilibrium_artifact["errors"])
    reference = manifest["inputs"]["historical_cpu_reference"]
    reference_metric = reference.get("mesh_mass_metric", {})
    metric_relative_path = reference_metric.get("campaign_artifact_path")
    reference_metric_doc = None
    if not isinstance(metric_relative_path, str):
        errors.append("historical CPU mesh mass metric has no staged artifact path")
    else:
        try:
            metric_path = resolve_campaign_entry(
                campaign_root,
                metric_relative_path,
                "staged historical CPU mesh mass metric",
                expected_kind="file",
            )
            reference_metric_doc = load_json(
                metric_path, "staged historical CPU mesh mass weights"
            )
        except VerificationError as error:
            errors.append(str(error))
    if reference_metric_doc is not None:
        raw_weights = reference_metric_doc.get("node_mass_weights")
        if not isinstance(raw_weights, list) or not raw_weights:
            errors.append("staged historical CPU mass weights are empty or missing")
        else:
            try:
                weights = [
                    finite_number(value, f"staged node_mass_weights[{index}]")
                    for index, value in enumerate(raw_weights)
                ]
                if any(value <= 0.0 for value in weights):
                    errors.append("staged historical CPU mass weights are not positive")
                if canonical_sha256(weights) != reference_metric.get(
                    "node_mass_weights_sha256"
                ):
                    errors.append("staged historical CPU mass weight hash differs")
                if len(weights) != reference_metric.get("active_magnetic_node_count"):
                    errors.append("staged historical CPU mass weight count differs")
                if 2 * len(weights) != reference_metric.get("q_dof_count"):
                    errors.append("staged historical CPU mass weights do not match q dimension")
            except VerificationError as error:
                errors.append(str(error))
        for key in (
            "generation_id",
            "summary_sha256",
            "input_mesh_sha256",
            "mesh_topology_sha256",
            "active_magnetic_node_count",
            "q_dof_count",
            "node_mass_weights_sha256",
        ):
            if reference_metric_doc.get(key) != reference_metric.get(key):
                errors.append(f"staged historical CPU mass metric {key} differs")
        if reference_metric_doc.get("source_zarr_path") != reference.get("zarr_path"):
            errors.append("staged historical CPU mass metric names a different source archive")
        if reference_metric_doc.get("schema") != (
            "fullmag.fem.open_airbox_k0.mesh_mass_weights.v1"
        ):
            errors.append("staged historical CPU mass metric schema differs")
    return {
        "status": "verified" if not errors else "invalid",
        "mesh_path": str(mesh_path),
        "mesh_sha256": (
            sha256_file(mesh_path) if mesh_path.is_file() else None
        ),
        "equilibrium_path": str(equilibrium_path),
        "equilibrium_tree": actual_tree,
        "equilibrium_artifact": equilibrium_artifact,
        "historical_cpu_mesh_mass_metric": {
            "status": "verified" if reference_metric_doc is not None else "unavailable",
            "node_mass_weights_sha256": reference_metric.get(
                "node_mass_weights_sha256"
            ),
            "active_magnetic_node_count": reference_metric.get(
                "active_magnetic_node_count"
            ),
            "q_dof_count": reference_metric.get("q_dof_count"),
            "mesh_topology_sha256": reference_metric.get("mesh_topology_sha256"),
        },
        "errors": errors,
    }


def expected_container_campaign_root(manifest: dict[str, Any]) -> PurePosixPath:
    source = manifest.get("source")
    if not isinstance(source, dict):
        fail("run matrix source identity is missing")
    container_output_root = PurePosixPath(
        str(source.get("container_output_root", ""))
    )
    output_root_relative = PurePosixPath(
        str(source.get("script_output_root_relative", ""))
    )
    campaign_root_relative = PurePosixPath(
        str(source.get("campaign_root_relative", ""))
    )
    for label, path in (
        ("container_output_root", container_output_root),
        ("script_output_root_relative", output_root_relative),
        ("campaign_root_relative", campaign_root_relative),
    ):
        if ".." in path.parts or (label == "container_output_root") != path.is_absolute():
            fail(f"run matrix {label} is not a safe canonical path")
    try:
        campaign_under_mount = campaign_root_relative.relative_to(
            output_root_relative
        )
    except ValueError:
        fail("campaign root is outside the declared script-output mount")
    return container_output_root / campaign_under_mount


def checkpoint_descriptor_matches_run(case: dict[str, Any], run: dict[str, Any]) -> bool:
    descriptor_identity = case.get("checkpoint_identity")
    if not isinstance(descriptor_identity, dict) or not descriptor_identity:
        return False
    run_identity = run.get("checkpoint_identity")
    if not isinstance(run_identity, dict):
        run_identity = run.get("input_identity")
    if not isinstance(run_identity, dict):
        return False
    required_fields = {
        "equilibrium_artifact_content_sha256",
        "equilibrium_artifact_file_sha256",
        "equilibrium_step",
        "equilibrium_tree_sha256",
        "input_mesh_sha256",
        "magnetization_f64le_sha256",
        "native_mesh_topology_sha256",
        "node_count",
        "reference_mesh_mass_metric",
    }
    if not required_fields.issubset(descriptor_identity):
        return False
    if any(run_identity.get(key) != value for key, value in descriptor_identity.items()):
        return False
    return True


def verify_campaign(
    campaign_root: Path,
    *,
    reference_cpu_root: Path | None = None,
    minimum_overlap: float = 0.90,
    maximum_relative_frequency_delta: float = 1e-3,
) -> dict[str, Any]:
    campaign_root = campaign_root.resolve()
    manifest = load_json(campaign_root / "run-matrix.v1.json", "run matrix")
    if manifest.get("schema") != MATRIX_SCHEMA:
        fail("run matrix schema is unsupported")
    runs = manifest.get("runs")
    if not isinstance(runs, list) or not runs:
        fail("run matrix contains no cases")

    descriptor_errors = []
    try:
        container_campaign_root = expected_container_campaign_root(manifest)
    except VerificationError as error:
        container_campaign_root = None
        descriptor_errors.append(str(error))
    step_inputs = manifest.get("inputs", {}).get("step_8006", {})
    window_expectation = manifest.get("expectations", {}).get(
        "checkpoint_window", {}
    )
    expected_window = window_expectation.get("frequency_window_hz")
    independent_count = window_expectation.get(
        "independent_archive_positive_mode_count"
    )
    required_count = window_expectation.get("minimum_positive_mode_count")
    if (
        isinstance(independent_count, bool)
        or not isinstance(independent_count, int)
        or isinstance(required_count, bool)
        or not isinstance(required_count, int)
        or independent_count != required_count
    ):
        descriptor_errors.append(
            "checkpoint request count does not equal the pinned independent archive count"
        )
    if expected_window != window_expectation.get("independent_archive_count_scope"):
        descriptor_errors.append(
            "checkpoint request interval differs from the independent archive count scope"
        )
    if expected_window != [1.0, 8.0e9]:
        descriptor_errors.append(
            "checkpoint frequency window differs from the fixed qualified interval"
        )
    for run in runs:
        if not isinstance(run, dict):
            fail("run matrix case entry is not an object")
        descriptor = campaign_root / run["descriptor_path_in_campaign"]
        script = campaign_root / run["script_path_in_campaign"]
        try:
            case = load_json(descriptor, f"case descriptor {run['case_id']}")
            if case.get("schema") != CASE_SCHEMA:
                descriptor_errors.append(f"{run['case_id']}: unsupported case descriptor")
            if canonical_sha256(case.get("input_identity")) != case.get(
                "input_identity_sha256"
            ):
                descriptor_errors.append(
                    f"{run['case_id']}: case input identity hash differs"
                )
            if case.get("case_id") != run.get("case_id"):
                descriptor_errors.append(f"{run['case_id']}: descriptor case_id differs")
            if case.get("execution_device") != run.get("execution_device"):
                descriptor_errors.append(
                    f"{run['case_id']}: descriptor execution device differs"
                )
            if case.get("input_identity_sha256") != run.get(
                "input_identity_sha256"
            ) or case.get("input_identity") != run.get("input_identity"):
                descriptor_errors.append(
                    f"{run['case_id']}: descriptor input identity differs from the run matrix"
                )
            if case.get("output_directory_name") != Path(
                run.get("output_path", "")
            ).name:
                descriptor_errors.append(
                    f"{run['case_id']}: descriptor output name differs from the run matrix"
                )
            if container_campaign_root is not None:
                try:
                    relative_script = PurePosixPath(
                        run.get("script_path_in_campaign", "")
                    )
                    relative_output = PurePosixPath(run.get("output_path", ""))
                    if relative_script.is_absolute() or ".." in relative_script.parts:
                        raise VerificationError(
                            "script path is not a safe campaign-relative path"
                        )
                    if relative_output.is_absolute() or ".." in relative_output.parts:
                        raise VerificationError(
                            "output path is not a safe campaign-relative path"
                        )
                    expected_script_path = container_campaign_root / relative_script
                    expected_output_path = container_campaign_root / relative_output
                    if run.get("script_container_path") != str(expected_script_path):
                        descriptor_errors.append(
                            f"{run['case_id']}: staged script path is not bound to script-output"
                        )
                    if run.get("output_container_path") != str(expected_output_path):
                        descriptor_errors.append(
                            f"{run['case_id']}: output path is not bound to script-output"
                        )
                    if run.get("family") == "checkpoint_step_8006":
                        checkpoint_root = (
                            container_campaign_root
                            / "inputs"
                            / "checkpoint_step_8006"
                        )
                        relative_artifact = PurePosixPath(
                            step_inputs.get("equilibrium_artifact_path", "")
                        )
                        if relative_artifact.is_absolute() or ".." in relative_artifact.parts:
                            raise VerificationError(
                                "equilibrium artifact path is not campaign-relative"
                            )
                        expected_artifact_path = (
                            container_campaign_root / relative_artifact
                        )
                        if case.get("equilibrium_artifact_container_path") != str(
                            expected_artifact_path
                        ):
                            descriptor_errors.append(
                                f"{run['case_id']}: equilibrium artifact path is not bound to script-output"
                            )
                        if case.get("mesh_container_path") != str(
                            checkpoint_root / step_inputs.get("mesh_filename", "")
                        ):
                            descriptor_errors.append(
                                f"{run['case_id']}: checkpoint mesh path is not bound to script-output"
                            )
                        if case.get("equilibrium_container_path") != str(
                            checkpoint_root / step_inputs.get("equilibrium_filename", "")
                        ):
                            descriptor_errors.append(
                                f"{run['case_id']}: checkpoint equilibrium path is not bound to script-output"
                            )
                except (TypeError, ValueError) as error:
                    descriptor_errors.append(
                        f"{run['case_id']}: invalid container path identity: {error}"
                    )
            if run.get("family") == "checkpoint_step_8006":
                if not checkpoint_descriptor_matches_run(case, run):
                    descriptor_errors.append(
                        f"{run['case_id']}: checkpoint identity does not match the pinned run inputs"
                    )
                if run.get("frequency_window_hz") != expected_window:
                    descriptor_errors.append(
                        f"{run['case_id']}: run frequency window differs from the pinned independent archive scope"
                    )
                if run.get("minimum_positive_mode_count") != required_count:
                    descriptor_errors.append(
                        f"{run['case_id']}: minimum mode count differs from the pinned independent archive count"
                    )
                if run.get("requested_mode_count") != required_count:
                    descriptor_errors.append(
                        f"{run['case_id']}: requested mode count differs from the pinned independent archive count"
                    )
                input_identity = run.get("input_identity")
                input_physics = (
                    input_identity.get("physics", {})
                    if isinstance(input_identity, dict)
                    else {}
                )
                if not isinstance(input_physics, dict):
                    input_physics = {}
                if input_physics.get("frequency_window_hz") != expected_window:
                    descriptor_errors.append(
                        f"{run['case_id']}: pinned input physics frequency window differs from the independent archive scope"
                    )
                if input_physics.get("minimum_positive_modes") != required_count:
                    descriptor_errors.append(
                        f"{run['case_id']}: pinned input physics minimum mode count differs from the independent archive count"
                    )
                if input_physics.get("requested_mode_count") != required_count:
                    descriptor_errors.append(
                        f"{run['case_id']}: pinned input physics requested mode count differs from the independent archive count"
                    )
                if case.get("frequency_window_hz") != run.get("frequency_window_hz"):
                    descriptor_errors.append(
                        f"{run['case_id']}: descriptor frequency window differs from the run matrix"
                    )
                if case.get("requested_mode_count") != run.get("requested_mode_count"):
                    descriptor_errors.append(
                        f"{run['case_id']}: descriptor requested mode count differs from the run matrix"
                    )
            if sha256_file(script) != case.get("script_sha256"):
                descriptor_errors.append(f"{run['case_id']}: staged script hash differs")
            if sha256_file(descriptor) != run.get("descriptor_sha256"):
                descriptor_errors.append(
                    f"{run['case_id']}: case descriptor file hash differs"
                )
        except (VerificationError, OSError) as error:
            descriptor_errors.append(f"{run['case_id']}: {error}")

    try:
        staging_state = load_json(
            campaign_root / "staging-state.json", "campaign staging state"
        )
    except VerificationError as error:
        staging_state = {"state": "unavailable"}
        descriptor_errors.append(str(error))
    if staging_state.get("state") != "prepared":
        descriptor_errors.append("campaign staging state is not prepared")
    staged_inputs = verify_staged_inputs(campaign_root, manifest)
    descriptor_errors.extend(staged_inputs["errors"])

    run_results = []
    for run in runs:
        try:
            run_results.append(verify_one_run(campaign_root, run))
        except (VerificationError, OSError, KeyError, TypeError) as error:
            output_path = campaign_root / str(run.get("output_path", ""))
            run_results.append(
                {
                    "case_id": run.get("case_id"),
                    "pair_id": run.get("pair_id"),
                    "family": run.get("family"),
                    "analysis_group": run.get("analysis_group"),
                    "execution_device_expected": run.get("execution_device"),
                    "input_identity_sha256": run.get("input_identity_sha256"),
                    "output_path": str(output_path),
                    "availability": (
                        "available" if output_path.is_dir() else "unavailable"
                    ),
                    "selected": "unproven",
                    "complete": "incomplete",
                    "errors": [str(error)],
                }
            )
    baseline = verify_historical_cpu_reference(manifest, reference_cpu_root)
    pair_results = compare_pairs(
        manifest,
        run_results,
        baseline,
        minimum_overlap=minimum_overlap,
        maximum_relative_frequency_delta=maximum_relative_frequency_delta,
    )
    convergence = convergence_assessments(manifest, run_results)

    all_available = all(row["availability"] == "available" for row in run_results)
    all_selected = all(row["selected"] == "proven" for row in run_results)
    all_complete = all(row["complete"] == "complete" for row in run_results)
    all_pairs_comparable = all(row.get("complete") is True for row in pair_results)
    descriptors_complete = not descriptor_errors
    campaign_complete = (
        descriptors_complete
        and all_available
        and all_selected
        and all_complete
        and all_pairs_comparable
        and baseline.get("availability") == "available"
        and baseline.get("selected") == "proven"
        and baseline.get("complete") == "complete_for_selected_scope"
    )
    return {
        "schema": "fullmag.fem.open_airbox_k0_convergence_report.v1",
        "campaign_id": manifest.get("campaign_id"),
        "campaign_root": str(campaign_root),
        "availability": "available" if all_available else "partial",
        "selection": "proven" if all_selected else "partial_or_unproven",
        "completeness": "complete" if campaign_complete else "incomplete",
        "scientific_qualification": "NOT VERIFIED",
        "statement": (
            "This report verifies artifact and execution evidence. It does not "
            "claim solver qualification or a physical convergence result."
        ),
        "descriptor_errors": descriptor_errors,
        "staged_inputs": strip_internal(staged_inputs),
        "historical_cpu_reference": strip_internal(baseline),
        "runs": strip_internal(run_results),
        "cpu_gpu_comparisons": strip_internal(pair_results),
        "kittel_convergence_assessments": convergence,
        "thresholds": {
            "minimum_phase_invariant_q_overlap": minimum_overlap,
            "maximum_relative_frequency_delta": maximum_relative_frequency_delta,
            "residual_gate": "each saved mode's certified native full descriptor residual",
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign-root", type=Path, required=True)
    parser.add_argument("--reference-cpu-root", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--minimum-overlap", type=float, default=0.90)
    parser.add_argument(
        "--maximum-relative-frequency-delta", type=float, default=1e-8
    )
    parser.add_argument(
        "--allow-incomplete",
        action="store_true",
        help="write and return an incomplete evidence report without calling it complete",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not 0.0 <= args.minimum_overlap <= 1.0:
        parser.error("minimum-overlap must be in [0, 1]")
    if not math.isfinite(args.maximum_relative_frequency_delta) or (
        args.maximum_relative_frequency_delta <= 0.0
    ):
        parser.error("maximum-relative-frequency-delta must be positive and finite")
    try:
        report = verify_campaign(
            args.campaign_root,
            reference_cpu_root=args.reference_cpu_root,
            minimum_overlap=args.minimum_overlap,
            maximum_relative_frequency_delta=args.maximum_relative_frequency_delta,
        )
    except (VerificationError, OSError, KeyError, TypeError) as error:
        parser.exit(2, f"verification failed: {error}\n")
    output = args.output or args.campaign_root / "verification.v1.json"
    output.write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "campaign_id": report["campaign_id"],
        "availability": report["availability"],
        "selection": report["selection"],
        "completeness": report["completeness"],
        "report": str(output),
    }, indent=2))
    if report["completeness"] != "complete" and not args.allow_incomplete:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
