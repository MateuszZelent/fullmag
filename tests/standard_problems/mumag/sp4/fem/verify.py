"""Fail-closed validator for strict FEM CPU/GPU µMAG Standard Problem 4."""

from __future__ import annotations

import argparse
import csv
from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path
import sys
from typing import Any

import numpy as np
from scipy.interpolate import LinearNDInterpolator

from ..common.contract import CONTRACT
from ..common.metrics import (
    find_first_zero_crossing,
    interpolate_crossing_field,
    parity_metrics,
    reference_envelope_metrics,
    vector_field_metrics,
)
from ..common.references import (
    Trajectory,
    VectorField,
    load_reference_manifest,
    parse_albuquerque_trace,
    parse_oommf_odt,
    parse_ovf2_rectangular,
)
from ..common.reporting import write_trajectory_plot, write_vector_map_plot


@dataclass(frozen=True)
class Failure:
    category: str
    gate: str
    run: str
    detail: str


class ValidationFailure(ValueError):
    pass


def _json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValidationFailure(f"missing artifact {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValidationFailure(f"invalid JSON artifact {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValidationFailure(f"artifact {path} is not a JSON object")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_run(path: Path) -> tuple[Trajectory, dict[str, Any], list[dict[str, float]]]:
    required = {"time", "mx", "my", "mz", "E_total", "max_torque_T"}
    try:
        stream = (path / "scalars.csv").open(newline="", encoding="utf-8")
    except FileNotFoundError as exc:
        raise ValidationFailure(f"missing artifact {path / 'scalars.csv'}") from exc
    with stream:
        reader = csv.DictReader(stream)
        missing = required - set(reader.fieldnames or ())
        if missing:
            raise ValidationFailure(f"{path}: missing scalar columns {sorted(missing)}")
        rows = [{key: float(value) for key, value in row.items()} for row in reader]
    data = np.asarray([[row[key] for key in ("time", "mx", "my", "mz")] for row in rows])
    if len(data) < 2 or not np.all(np.isfinite(data)):
        raise ValidationFailure(f"{path}: incomplete or non-finite scalar trace")
    if np.any(np.diff(data[:, 0]) <= 0):
        raise ValidationFailure(f"{path}: scalar time is not strictly increasing")
    if not all(np.isfinite(list(row.values())).all() for row in rows):
        raise ValidationFailure(f"{path}: non-finite scalar diagnostics")
    return Trajectory(data[:, 0], data[:, 1:], str(path)), _json(path / "metadata.json"), rows


def load_scalar_rows(path: Path) -> list[dict[str, float]]:
    try:
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            rows = [{key: float(value) for key, value in row.items()} for row in reader]
    except (FileNotFoundError, TypeError, ValueError) as exc:
        raise ValidationFailure(f"invalid scalar artifact {path}") from exc
    if not rows or not all(np.isfinite(list(row.values())).all() for row in rows):
        raise ValidationFailure(f"{path}: empty or non-finite scalar diagnostics")
    return rows


def provenance_errors(metadata: dict[str, Any], device: str) -> list[str]:
    requested = metadata.get("requested_execution", {})
    provenance = metadata.get("execution_provenance", {})
    demag = metadata.get("demag_runtime", {})
    expected = "fem_cpu_native" if device == "cpu" else "fem_native_gpu"
    errors: list[str] = []
    exact = {
        "backend": "fem", "device": device, "precision": "double",
        "mode": "strict", "fallback_policy": "forbidden",
    }
    if requested != exact:
        errors.append("requested execution is not exact strict FEM double")
    if provenance.get("execution_engine") != expected:
        errors.append(f"resolved engine is not {expected}")
    if provenance.get("lossy_fallback_used") is not False:
        errors.append("fallback was used or not proven absent")
    if provenance.get("precision") != "double":
        errors.append("resolved precision is not double")
    if device == "gpu":
        if provenance.get("fem_demag_operator_mode") != "device_hypre_poisson":
            errors.append("GPU demag is not device_hypre_poisson")
        if provenance.get("hypre_execution_policy") != "device":
            errors.append("GPU Hypre execution policy is not device")
        if provenance.get("uses_gpu_poisson") is not True:
            errors.append("GPU Poisson execution is not proven")
    if demag.get("actual_iterations") is None or demag.get("final_residual_norm") is None:
        errors.append("demag convergence diagnostics missing")
    return errors


def load_artifact_field(path: Path) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    metadata = _json(path / "metadata.json")
    field = _json(path / "m_final.json")
    try:
        plan = metadata["execution_plan"]["backend_plan"]
        nodes = np.asarray(plan["mesh"]["nodes"], dtype=float)
        segments = [item for item in plan["object_segments"] if item.get("object_id") != "__air__"]
        values = np.asarray(field["values"], dtype=float)
    except (KeyError, TypeError, ValueError) as exc:
        raise ValidationFailure(f"{path}: malformed FEM field/mesh artifact") from exc
    indexes: list[int] = []
    for segment in segments:
        indexes.extend(range(int(segment["node_start"]), int(segment["node_start"]) + int(segment["node_count"])))
    if not indexes or nodes.shape[1:] != (3,) or values.shape[1:] != (3,):
        raise ValidationFailure(f"{path}: invalid magnetic field dimensions")
    nodes, values = nodes[indexes], values[indexes]
    if not np.all(np.isfinite(nodes)) or not np.all(np.isfinite(values)):
        raise ValidationFailure(f"{path}: non-finite magnetic field")
    defect = float(np.max(np.abs(np.linalg.norm(values, axis=1) - 1.0)))
    return nodes, values, {"norm_defect": defect, "metadata": metadata, "field": field}


def project_midplane(nodes: np.ndarray, values: np.ndarray, reference: VectorField) -> np.ndarray:
    x, y, z = reference.coordinates_m
    target_x = x - 0.5 * (x[0] + x[-1])
    target_y = y - 0.5 * (y[0] + y[-1])
    target_z = float(z[len(z) // 2] - 0.5 * (z[0] + z[-1]))
    xx, yy = np.meshgrid(target_x, target_y, indexing="ij")
    query = np.column_stack((xx.ravel(), yy.ravel(), np.full(xx.size, target_z)))
    projected = np.asarray(LinearNDInterpolator(nodes, values, fill_value=np.nan)(query))
    if projected.shape != (xx.size, 3) or not np.all(np.isfinite(projected)):
        raise ValidationFailure("FEM midplane projection contains holes or non-finite values")
    norms = np.linalg.norm(projected, axis=1, keepdims=True)
    if np.any(norms == 0):
        raise ValidationFailure("FEM midplane projection contains zero vectors")
    return (projected / norms).reshape(len(x), len(y), 3)


def crossing_field_metrics(before: Path, after: Path, trace: Trajectory, reference: VectorField, plot_path: Path | None = None) -> dict[str, Any]:
    before_nodes, before_values, before_info = load_artifact_field(before)
    after_nodes, after_values, after_info = load_artifact_field(after)
    before_fingerprint = before_info["metadata"].get("mesh", {}).get("topology_fingerprint")
    after_fingerprint = after_info["metadata"].get("mesh", {}).get("topology_fingerprint")
    if not before_fingerprint or before_fingerprint != after_fingerprint:
        raise ValidationFailure("replay fields do not use the same mesh topology")
    if not np.array_equal(before_nodes, after_nodes):
        raise ValidationFailure("replay field node coordinates differ")
    before_time = float(before_info["field"].get("time"))
    after_time = float(after_info["field"].get("time"))
    before_mx = float(np.interp(before_time, trace.time_s, trace.m[:, 0]))
    after_mx = float(np.interp(after_time, trace.time_s, trace.m[:, 0]))
    crossing = interpolate_crossing_field(before_values, after_values, before_mx, after_mx)
    projected = project_midplane(before_nodes, crossing, reference)
    reference_midplane = reference.values[:, :, reference.values.shape[2] // 2, :]
    result = vector_field_metrics(projected, reference_midplane)
    if plot_path is not None:
        write_vector_map_plot(plot_path, projected, reference_midplane, "Magnetization at first mx=0 crossing")
    result.update({
        "before_time_s": before_time,
        "after_time_s": after_time,
        "before_norm_defect": before_info["norm_defect"],
        "after_norm_defect": after_info["norm_defect"],
    })
    return result


def equilibrium_metrics(rows: list[dict[str, float]], window_s: float = 50e-12) -> dict[str, Any]:
    stop = rows[-1]["time"]
    window = [row for row in rows if row["time"] >= stop - window_s]
    if len(window) < 2 or window[0]["time"] > stop - window_s + CONTRACT.sample_period_s:
        raise ValidationFailure("trajectory lacks a complete 50 ps equilibrium window")
    drift = [max(row[key] for row in window) - min(row[key] for row in window) for key in ("mx", "my", "mz")]
    return {"maximum_torque_T": max(row["max_torque_T"] for row in window), "component_drift": drift}


def relaxed_state_metrics(path: Path, reference: VectorField, plot_path: Path | None = None) -> dict[str, Any]:
    nodes, values, info = load_artifact_field(path)
    metadata = info["metadata"]
    qualification = metadata.get("fem_gpu_relaxation_qualification")
    if not isinstance(qualification, dict):
        qualification = metadata.get("fem_cpu_relaxation_qualification")
    if not isinstance(qualification, dict):
        raise ValidationFailure("relaxation qualification metadata missing")
    rows = load_scalar_rows(path / "scalars.csv")
    energies = np.asarray([row["E_total"] for row in rows], dtype=float)
    tail = energies[-min(10, len(energies)):]
    increases = np.diff(tail)
    energy_scale = max(float(np.max(np.abs(tail))), 1e-30)
    if np.any(increases > 1e-10 * energy_scale):
        raise ValidationFailure("relaxation energy is not monotonic in accepted tail")
    projected = project_midplane(nodes, values, reference)
    reference_midplane = reference.values[:, :, reference.values.shape[2] // 2, :]
    spatial = vector_field_metrics(projected, reference_midplane)
    if plot_path is not None:
        write_vector_map_plot(plot_path, projected, reference_midplane, "Relaxed S-state")
    mesh = metadata.get("mesh", {})
    plan = metadata.get("execution_plan", {}).get("backend_plan", {})
    object_bounds = plan.get("domain_frame", {})
    thickness = None
    try:
        maximum = object_bounds["object_bounds_max"]
        minimum = object_bounds["object_bounds_min"]
        thickness = float(maximum[2]) - float(minimum[2])
    except (KeyError, TypeError, ValueError):
        pass
    return {
        "converged": qualification.get("converged"),
        "final_torque_T": qualification.get("final_torque_t"),
        "qualification_norm_defect": qualification.get("norm_defect"),
        "field_norm_defect": info["norm_defect"],
        "spatial": spatial,
        "topology_fingerprint": mesh.get("topology_fingerprint"),
        "thickness_m": thickness,
        "energy_samples": len(energies),
        "final_energy_J": float(energies[-1]),
    }


def _status(failures: list[Failure]) -> str:
    if not failures:
        return "passed"
    categories = {failure.category for failure in failures}
    for category in ("execution_failure", "artifact_failure", "convergence_failure", "physics_failure"):
        if category in categories:
            return category
    return "physics_failure"


def validate(root: Path, qualifying: bool) -> dict[str, Any]:
    reference_root = Path(__file__).parents[1] / "references"
    manifest = load_reference_manifest(reference_root / "manifest.json")
    nist = reference_root / "nist"
    references = {
        "case-a": [parse_oommf_odt(nist / "oommf/stdprob4a.odt"), parse_albuquerque_trace(nist / "albuquerque/FIELD_1_SM_DT25.TXT"), parse_albuquerque_trace(nist / "albuquerque/FIELD_1_LM_DT25.TXT")],
        "case-b": [parse_oommf_odt(nist / "oommf/stdprob4b.odt"), parse_albuquerque_trace(nist / "albuquerque/FIELD_2_SM_DT25.TXT"), parse_albuquerque_trace(nist / "albuquerque/FIELD_2_LM_DT25.TXT")],
    }
    zero_maps = {
        "case-a": parse_ovf2_rectangular(nist / "oommf/stdprob4a-138ps.omf"),
        "case-b": parse_ovf2_rectangular(nist / "oommf/stdprob4b-137ps.omf"),
    }
    initial_map = parse_ovf2_rectangular(nist / "oommf/stdprob4-start.omf")
    failures: list[Failure] = []
    metrics: dict[str, Any] = {"reference_manifest_files": len(manifest.files)}
    loaded: dict[tuple[str, str, str, str], Trajectory] = {}
    loaded_metadata: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    if qualifying:
        meshes = ("coarse", "medium", "fine")
    else:
        meshes = tuple(sorted({path.name for device in ("cpu", "gpu") for path in (root / "runs" / device).glob("*")}))

    for device in ("cpu", "gpu"):
        for mesh in meshes:
            airboxes = ("baseline", "expanded") if mesh == "medium" and qualifying else ("baseline",)
            for airbox in airboxes:
                for case in ("case-a", "case-b"):
                    run_id = f"{device}/{mesh}/{airbox}/{case}"
                    path = root / "runs" / device / mesh / airbox / case / "artifacts"
                    try:
                        trace, metadata, rows = load_run(path)
                        loaded[(device, mesh, airbox, case)] = trace
                        loaded_metadata[(device, mesh, airbox, case)] = metadata
                        for detail in provenance_errors(metadata, device):
                            failures.append(Failure("execution_failure", "provenance", run_id, detail))
                        state_hash_path = path.parent / "source_state.sha256"
                        if qualifying and not state_hash_path.is_file():
                            failures.append(Failure("artifact_failure", "initial_state_hash", run_id, "missing source_state.sha256"))
                        if qualifying and trace.time_s[-1] < CONTRACT.minimum_duration_s:
                            failures.append(Failure("artifact_failure", "time_coverage", run_id, "trajectory shorter than 1 ns"))
                        if qualifying:
                            grid = trace.time_s[trace.time_s <= CONTRACT.minimum_duration_s]
                            envelope = reference_envelope_metrics(trace, references[case], grid_s=grid)
                            crossing = find_first_zero_crossing(trace)
                            equilibrium = equilibrium_metrics(rows)
                            figure_id = run_id.replace("/", "-")
                            write_trajectory_plot(root / "plots" / f"{figure_id}-trajectory.png", trace, references[case], run_id)
                            spatial = crossing_field_metrics(
                                path.parent / "replay-before", path.parent / "replay-after", trace,
                                zero_maps[case], root / "plots" / f"{figure_id}-zero-map.png",
                            )
                            metrics[run_id] = {"crossing_s": crossing, "reference": envelope, "equilibrium": equilibrium, "spatial": spatial}
                            if max(envelope["normalized_rms"]) > 1 or max(envelope["normalized_p99"]) > 3 or max(envelope["endpoint_error"]) > 0.05:
                                failures.append(Failure("physics_failure", "nist_trajectory", run_id, "trajectory threshold exceeded"))
                            if spatial["correlation"] < 0.85 or max(spatial["component_rmse"]) > 0.20:
                                failures.append(Failure("physics_failure", "zero_crossing_map", run_id, "spatial threshold exceeded"))
                            if max(spatial["before_norm_defect"], spatial["after_norm_defect"]) > 1e-8:
                                failures.append(Failure("physics_failure", "unit_norm", run_id, "field norm defect exceeds 1e-8"))
                            if equilibrium["maximum_torque_T"] > 1e-5 or max(equilibrium["component_drift"]) > 1e-4:
                                failures.append(Failure("physics_failure", "equilibrium", run_id, "5 ns/50 ps equilibrium gate failed"))
                        else:
                            metrics[run_id] = {"samples": len(trace.time_s), "final_time_s": float(trace.time_s[-1])}
                    except Exception as exc:
                        failures.append(Failure("artifact_failure", "run_bundle", run_id, str(exc)))

    if qualifying:
        state_hashes: dict[tuple[str, str], str] = {}
        state_fingerprints: dict[tuple[str, str], str] = {}
        for mesh in meshes:
            for airbox in (("baseline", "expanded") if mesh == "medium" else ("baseline",)):
                state = root / "states" / mesh / airbox / "initial_state.json"
                try:
                    state_hashes[(mesh, airbox)] = _sha256(state)
                    recorded = (state.parent / "initial_state.sha256").read_text().split()[0]
                    if recorded != state_hashes[(mesh, airbox)]:
                        raise ValidationFailure("relaxed-state checksum mismatch")
                    state_metric = relaxed_state_metrics(
                        state.parent / "artifacts", initial_map,
                        root / "plots" / f"state-{mesh}-{airbox}.png",
                    )
                    metrics[f"state/{mesh}/{airbox}"] = state_metric
                    state_fingerprints[(mesh, airbox)] = str(state_metric["topology_fingerprint"])
                    if state_metric["converged"] is not True:
                        failures.append(Failure("physics_failure", "relaxation", f"{mesh}/{airbox}", "relaxation did not converge"))
                    if state_metric["final_torque_T"] is None or float(state_metric["final_torque_T"]) > 1e-5:
                        failures.append(Failure("physics_failure", "relaxation", f"{mesh}/{airbox}", "relaxed torque exceeds 1e-5 T"))
                    qualification_defect = state_metric["qualification_norm_defect"]
                    if qualification_defect is None or max(float(qualification_defect), float(state_metric["field_norm_defect"])) > 1e-8:
                        failures.append(Failure("physics_failure", "relaxation", f"{mesh}/{airbox}", "relaxed norm defect exceeds 1e-8"))
                    if state_metric["spatial"]["correlation"] < 0.90 or max(state_metric["spatial"]["component_rmse"]) > 0.15:
                        failures.append(Failure("physics_failure", "initial_s_state", f"{mesh}/{airbox}", "relaxed S-state differs from NIST OOMMF"))
                    if state_metric["thickness_m"] is None or not np.isclose(state_metric["thickness_m"], 3e-9, rtol=0, atol=1e-12):
                        failures.append(Failure("artifact_failure", "mesh_thickness", f"{mesh}/{airbox}", "mesh does not prove the 3 nm film thickness"))
                except Exception as exc:
                    failures.append(Failure("artifact_failure", "relaxed_state", f"{mesh}/{airbox}", str(exc)))
        for device in ("cpu", "gpu"):
            for mesh in meshes:
                for airbox in (("baseline", "expanded") if mesh == "medium" else ("baseline",)):
                    for case in ("case-a", "case-b"):
                        source = root / "runs" / device / mesh / airbox / case / "source_state.sha256"
                        try:
                            if source.read_text().strip() != state_hashes[(mesh, airbox)]:
                                raise ValidationFailure("dynamic run did not use the canonical S-state")
                            fingerprint = loaded_metadata[(device, mesh, airbox, case)].get("mesh", {}).get("topology_fingerprint")
                            if fingerprint != state_fingerprints[(mesh, airbox)]:
                                raise ValidationFailure("dynamic run mesh differs from relaxed-state mesh")
                        except Exception as exc:
                            failures.append(Failure("artifact_failure", "shared_initial_state", f"{device}/{mesh}/{airbox}/{case}", str(exc)))

        for case in ("case-a", "case-b"):
            for mesh in meshes:
                run_id = f"parity/{mesh}/{case}"
                try:
                    value = parity_metrics(loaded[("cpu", mesh, "baseline", case)], loaded[("gpu", mesh, "baseline", case)])
                    metrics[run_id] = value
                    if max(value["trajectory_rmse"]) > 0.02 or value["crossing_delta_s"] > 10e-12 or max(value["endpoint_delta"]) > 0.02:
                        failures.append(Failure("physics_failure", "cpu_gpu_parity", run_id, "CPU/GPU parity threshold exceeded"))
                except Exception as exc:
                    failures.append(Failure("artifact_failure", "cpu_gpu_parity", run_id, str(exc)))
        for device in ("cpu", "gpu"):
            for case in ("case-a", "case-b"):
                run_id = f"convergence/{device}/{case}"
                try:
                    value = parity_metrics(loaded[(device, "medium", "baseline", case)], loaded[(device, "fine", "baseline", case)])
                    metrics[run_id] = value
                    if max(value["trajectory_rmse"]) > 0.025 or value["crossing_delta_s"] > 20e-12 or max(value["endpoint_delta"]) > 0.025:
                        failures.append(Failure("convergence_failure", "mesh", run_id, "mesh convergence threshold exceeded"))
                    airbox = parity_metrics(loaded[(device, "medium", "baseline", case)], loaded[(device, "medium", "expanded", case)])
                    metrics[f"airbox/{device}/{case}"] = airbox
                    if max(airbox["trajectory_rmse"]) >= 0.02 or airbox["crossing_delta_s"] >= 20e-12 or max(airbox["endpoint_delta"]) >= 0.02:
                        failures.append(Failure("convergence_failure", "airbox", run_id, "airbox convergence threshold exceeded"))
                except Exception as exc:
                    failures.append(Failure("artifact_failure", "convergence", run_id, str(exc)))

    status = _status(failures)
    report = {
        "schema": "fullmag.mumag.sp4.validation.v1",
        "status": status,
        "qualifying": qualifying,
        "failures": [asdict(failure) for failure in failures],
        "metrics": metrics,
    }
    root.mkdir(parents=True, exist_ok=True)
    (root / "validation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    (root / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    lines = ["# Fullmag FEM µMAG SP4 validation", "", f"Status: **{status}**", ""]
    lines.extend(f"- [{failure.category}] {failure.run} / {failure.gate}: {failure.detail}" for failure in failures)
    (root / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--qualifying", action="store_true")
    mode.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    report = validate(args.root, args.qualifying)
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
